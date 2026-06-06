/**
 * RPC mode: orchestration-grade local stdio NDJSON protocol.
 */
import { getOAuthProviders } from "@oh-my-pi/pi-ai/utils/oauth";
import { $env, Snowflake } from "@oh-my-pi/pi-utils";
import type {
	BackgroundLaneCloseInput,
	BackgroundLaneMessageInput,
	BackgroundLaneSpawnInput,
} from "../../background-lanes";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { SessionObserverRegistry } from "../../modes/session-observer-registry";
import { type Theme, theme } from "../../modes/theme/theme";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { SessionEntry, SessionTreeNode } from "../../session/session-manager";
import {
	type AgentProgress,
	type SingleResult,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type TaskToolDetails,
} from "../../task";
import type { TodoPhase } from "../../tools/todo-write";
import type { EventBus } from "../../utils/event-bus";
import { initializeExtensions } from "../runtime-init";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import { type RpcOperationContext, RpcOperationManager } from "./operation-manager";
import { readBoundedRpcInput, validateRpcInputFrame } from "./rpc-input";
import {
	buildRpcProtocolInfo,
	errorInfoFromUnknown,
	RPC_LIMITS,
	RpcFrameWriter,
	RpcProtocolError,
	rpcErrorInfo,
} from "./rpc-protocol";
import type {
	JsonObject,
	RpcBackgroundLaneCommand,
	RpcBackgroundLaneUpdateSummary,
	RpcCommand,
	RpcErrorInfo,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelAck,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostUriCancelAck,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcMode,
	RpcObservableSessionView,
	RpcOperationAck,
	RpcResponse,
	RpcSessionEntryView,
	RpcSessionState,
	RpcSessionTreeNodeView,
	RpcTaskAgentProgress,
	RpcTaskResult,
} from "./rpc-types";

export type * from "./rpc-types";

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

export interface RpcModeOptions {
	mode?: RpcMode;
	oneShotCommand?: string;
	eventBus?: EventBus;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type RpcExtensionUIRequestBody = DistributiveOmit<RpcExtensionUIRequest, "type" | "id">;

const STATE_EVENT_TYPES: Record<string, string[]> = {
	message_end: ["messages", "sessionGraph"],
	tool_execution_end: ["messages", "tools"],
	thinking_level_changed: ["thinkingLevel"],
	auto_compaction_start: ["isCompacting"],
	auto_compaction_end: ["isCompacting", "sessionGraph"],
	todo_reminder: ["todoPhases"],
	todo_auto_clear: ["todoPhases"],
	background_lane_update: ["goal", "backgroundLanes"],
	goal_updated: ["goal"],
	session_tree: ["sessionGraph", "messages"],
};

function optionalPositiveInteger(value: unknown, field: string, owner: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	throw new RpcProtocolError("invalid_arguments", `${owner} ${field} must be a positive safe integer`, { field });
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new RpcProtocolError("invalid_arguments", `Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new RpcProtocolError("invalid_arguments", `Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new RpcProtocolError("invalid_arguments", `Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
			sideEffectClass: tool.sideEffectClass ?? "unknown",
			trustClass: tool.trustClass ?? "host",
			display: tool.display,
			inputSizeHintBytes: optionalPositiveInteger(
				tool.inputSizeHintBytes,
				"inputSizeHintBytes",
				`Host tool "${name}"`,
			),
			outputSizeHintBytes: optionalPositiveInteger(
				tool.outputSizeHintBytes,
				"outputSizeHintBytes",
				`Host tool "${name}"`,
			),
			defaultTimeoutMs: optionalPositiveInteger(tool.defaultTimeoutMs, "defaultTimeoutMs", `Host tool "${name}"`),
			maxResultBytes: optionalPositiveInteger(tool.maxResultBytes, "maxResultBytes", `Host tool "${name}"`),
			maxUpdateBytes: optionalPositiveInteger(tool.maxUpdateBytes, "maxUpdateBytes", `Host tool "${name}"`),
		};
	});
}

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function previewText(text: string, max = 1000): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function textFromEntry(entry: SessionEntry): string | undefined {
	if (entry.type === "message") {
		const message = entry.message;
		if (!("content" in message)) return undefined;
		const content = message.content;
		if (typeof content === "string") return content;
		return content
			.filter(
				(part): part is { type: "text"; text: string } =>
					part.type === "text" && typeof (part as { text?: unknown }).text === "string",
			)
			.map(part => part.text)
			.join("\n");
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary;
	if (entry.type === "custom_message") {
		return typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
	}
	return undefined;
}

function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as { results?: unknown; progress?: unknown };
	return Array.isArray(details.results) || Array.isArray(details.progress);
}

function taskOutputRef(id: string, output: string): RpcTaskResult["outputRef"] {
	if (!output) return undefined;
	return {
		kind: "artifact",
		uri: `agent://${id}`,
		bytes: Buffer.byteLength(output, "utf8"),
		preview: previewText(output),
	};
}

function taskProgressToRpcAgent(
	progress: AgentProgress,
	parentId: string | null,
	description: string | undefined,
): RpcTaskAgentProgress {
	return {
		id: progress.id,
		parentId,
		index: progress.index,
		agentType: progress.agent,
		description: progress.description ?? description ?? progress.task,
		status: progress.status,
		currentTool: progress.currentTool,
		preview: previewText(progress.recentOutput.at(-1) ?? progress.lastIntent ?? ""),
		tokens: progress.tokens,
		contextTokens: progress.contextTokens,
		contextWindow: progress.contextWindow,
	};
}

function nestedTaskId(parentId: string, childId: string): string {
	return childId.startsWith(`${parentId}.`) ? childId : `${parentId}.${childId}`;
}

function collectNestedProgress(details: TaskToolDetails | undefined, parentId: string): RpcTaskAgentProgress[] {
	if (!details?.progress) return [];
	const agents: RpcTaskAgentProgress[] = [];
	for (const progress of details.progress) {
		const id = nestedTaskId(parentId, progress.id);
		const nested: AgentProgress = { ...progress, id };
		agents.push(taskProgressToRpcAgent(nested, parentId, progress.description ?? progress.task));
		agents.push(...collectNestedProgress(progress.inflightTaskDetails, id));
	}
	return agents;
}

function taskResultToRpcResult(result: SingleResult, parentId: string | null = null, idPrefix = ""): RpcTaskResult[] {
	const id = idPrefix ? nestedTaskId(idPrefix, result.id) : result.id;
	const output = result.output || result.error || result.task || "";
	const rows: RpcTaskResult[] = [
		{
			id,
			parentId,
			index: result.index,
			agentType: result.agent,
			status: result.aborted ? "aborted" : result.exitCode === 0 ? "completed" : "failed",
			summary: previewText(output),
			truncated: result.truncated || output.length > 1000,
			outputRef: taskOutputRef(id, result.output),
		},
	];
	const nestedDetails = result.extractedToolData?.task;
	if (Array.isArray(nestedDetails)) {
		for (const details of nestedDetails) {
			if (!isTaskToolDetails(details) || !Array.isArray(details.results)) continue;
			for (const child of details.results as SingleResult[]) {
				rows.push(...taskResultToRpcResult(child, id, id));
			}
		}
	}

	return rows;
}
function backgroundLaneSummary(
	lane: Extract<AgentSessionEvent, { type: "background_lane_update" }>["lane"],
): RpcBackgroundLaneUpdateSummary {
	return {
		id: lane.id,
		question: lane.contract.question,
		status: lane.status,
		agentStatus: lane.agent.status,
		outcome: lane.outcome ?? null,
		requiredBeforeParent: lane.contract.requiredBeforeParent,
		blocksIfFired: lane.blocksIfFired,
		latestReportRef: lane.latestReportRef,
		latestPatchRef: lane.latestPatchRef,
		branch: lane.branch.name,
		worktreePath: lane.branch.worktreePath,
	};
}

function backgroundLaneSpawnInput(
	command: Extract<RpcBackgroundLaneCommand, { op: "spawn" }>,
): BackgroundLaneSpawnInput {
	return {
		from: {
			checkpointId: command.from.checkpoint_id,
			sourceRef: command.from.source_ref,
		},
		contract: {
			question: command.contract.question,
			blocksIf: command.contract.blocks_if,
			requiredBeforeParent: command.contract.required_before_parent,
		},
		assignment: command.assignment,
		agent: command.agent,
	};
}

function backgroundLaneMessageInput(
	command: Extract<RpcBackgroundLaneCommand, { op: "message" }>,
): BackgroundLaneMessageInput {
	return {
		laneId: command.lane_id,
		message: command.message,
	};
}

function backgroundLaneCloseInput(
	command: Extract<RpcBackgroundLaneCommand, { op: "close" }>,
): BackgroundLaneCloseInput {
	return {
		laneId: command.lane_id,
		outcome: command.outcome,
		reason: command.reason,
		mergedSourceRef: command.merged_source_ref,
		operatorStatement: command.operator_statement,
	};
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;
	let timeoutId: NodeJS.Timeout | undefined;

	const cleanup = () => {
		if (timeoutId) clearTimeout(timeoutId);
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const cancelHostRequest = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			expectsResponse: false,
			targetId: id,
		} satisfies RpcExtensionUIRequest);
	};
	const onAbort = () => {
		cancelHostRequest();
		finish(undefined);
	};
	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });

	const timeoutMs = dialogOptions?.timeout ?? RPC_LIMITS.defaultExtensionUiTimeoutMs;
	timeoutId = setTimeout(() => {
		dialogOptions?.onTimeout?.();
		cancelHostRequest();
		finish(undefined);
	}, timeoutMs);
	timeoutId.unref();
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		expectsResponse: true,
		responseSchema: { kind: "string", nullable: true },
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
		timeout: timeoutMs,
	} satisfies RpcExtensionUIRequest);
	return promise;
}

export async function runRpcMode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	options: RpcModeOptions = {},
): Promise<void> {
	process.env.PI_NOTIFICATIONS = "off";

	const mode = options.mode ?? (setToolUIContext ? "rpc-ui" : "rpc");
	const writer = new RpcFrameWriter(() => session.sessionId ?? null);
	const output: RpcOutput = obj => {
		void writer.write(obj);
	};
	const emitRpcTitles = shouldEmitRpcTitles();
	const pendingExtensionRequests = new Map<string, PendingExtensionRequest>();
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const observerRegistry = new SessionObserverRegistry();
	let stateSeq = 0;
	let operationManager: RpcOperationManager;
	let shutdownRequested = false;
	let shutdownReason = "shutdown_requested";

	const protocolInfo = () => buildRpcProtocolInfo(mode, session, hostToolBridge, hostUriBridge);

	const success = (id: string | undefined, command: string, data?: unknown): RpcResponse => {
		if (data === undefined) return { id, type: "response", command, success: true };
		return { id, type: "response", command, success: true, data };
	};

	const error = (id: string | undefined, command: string, info: RpcErrorInfo): RpcResponse => ({
		id,
		type: "response",
		command,
		success: false,
		error: info.message,
		errorInfo: info,
	});

	const buildState = (): RpcSessionState => ({
		stateSeq,
		protocol: protocolInfo().protocol,
		capabilities: protocolInfo().capabilities,
		limits: protocolInfo().limits,
		resetProfile: protocolInfo().resetProfile,
		security: protocolInfo().security,
		activeOperations: operationManager?.getActiveOperations() ?? [],
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		interruptMode: session.interruptMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		autoRetryEnabled: session.autoRetryEnabled,
		messageCount: session.messages.length,
		queuedMessageCount: session.queuedMessageCount,
		todoPhases: session.getTodoPhases(),
		systemPrompt: session.systemPrompt,
		dumpTools: session.agent.state.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
		contextUsage: session.getContextUsage(),
		hostTools: hostToolBridge.getDefinitions(),
		hostUriSchemes: hostUriBridge.getDefinitions(),
		backgroundLanes: session.backgroundLaneList(),
	});

	const emitStateChanged = (changed: string[]) => {
		stateSeq += 1;
		output({ type: "state_changed", stateSeq, changed, state: buildState() });
	};

	operationManager = new RpcOperationManager(output, emitStateChanged);

	class RpcExtensionUIContext implements ExtensionUIContext {
		#pendingRequests: Map<string, PendingExtensionRequest>;
		#output: RpcOutput;

		constructor(pendingRequests: Map<string, PendingExtensionRequest>, rpcOutput: RpcOutput) {
			this.#pendingRequests = pendingRequests;
			this.#output = rpcOutput;
		}

		#createDialogPromise<T>(
			opts: ExtensionUIDialogOptions | undefined,
			defaultValue: T,
			request: RpcExtensionUIRequestBody,
			parseResponse: (response: RpcExtensionUIResponse) => T,
		): Promise<T> {
			if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

			const id = Snowflake.next() as string;
			const { promise, resolve, reject } = Promise.withResolvers<T>();
			let timeoutId: NodeJS.Timeout | undefined;
			let settled = false;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.#pendingRequests.delete(id);
			};
			const finish = (value: T) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			};
			const cancelHostRequest = () => {
				this.#output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "cancel",
					expectsResponse: false,
					targetId: id,
				} satisfies RpcExtensionUIRequest);
			};
			const onAbort = () => {
				cancelHostRequest();
				finish(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			const timeoutMs = opts?.timeout ?? RPC_LIMITS.defaultExtensionUiTimeoutMs;
			timeoutId = setTimeout(() => {
				opts?.onTimeout?.();
				cancelHostRequest();
				finish(defaultValue);
			}, timeoutMs);
			timeoutId.unref();

			this.#pendingRequests.set(id, {
				resolve: response => finish(parseResponse(response)),
				reject,
			});
			this.#output({ type: "extension_ui_request", id, ...request, timeout: timeoutMs } as RpcExtensionUIRequest);
			return promise;
		}

		select(
			title: string,
			items: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{
					method: "select",
					expectsResponse: true,
					responseSchema: { kind: "string", nullable: true },
					title,
					options: items.map(getExtensionUISelectOptionLabel),
					timeout: dialogOptions?.timeout,
				},
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return this.#createDialogPromise(
				dialogOptions,
				false,
				{
					method: "confirm",
					expectsResponse: true,
					responseSchema: { kind: "boolean" },
					title,
					message,
					timeout: dialogOptions?.timeout,
				},
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut) dialogOptions?.onTimeout?.();
						return false;
					}
					if ("confirmed" in response) return response.confirmed;
					return false;
				},
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{
					method: "input",
					expectsResponse: true,
					responseSchema: { kind: "string", nullable: true },
					title,
					placeholder,
					timeout: dialogOptions?.timeout,
				},
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		onTerminalInput(): () => void {
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			this.#output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				expectsResponse: false,
				message,
				notifyType: type,
			} satisfies RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			this.#output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				expectsResponse: false,
				statusKey: key,
				statusText: text,
			} satisfies RpcExtensionUIRequest);
		}

		setWorkingMessage(): void {}

		setWidget(key: string, content: unknown, opts?: ExtensionWidgetOptions): void {
			if (content === undefined || Array.isArray(content)) {
				this.#output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					expectsResponse: false,
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: opts?.placement,
				} satisfies RpcExtensionUIRequest);
			}
		}

		setFooter(): void {}
		setHeader(): void {}

		setTitle(title: string): void {
			if (!emitRpcTitles) return;
			this.#output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				expectsResponse: false,
				title,
			} satisfies RpcExtensionUIRequest);
		}

		async custom(): Promise<never> {
			return undefined as never;
		}

		pasteToEditor(text: string): void {
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			this.#output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				expectsResponse: false,
				text,
			} satisfies RpcExtensionUIRequest);
		}

		getEditorText(): string {
			return "";
		}

		editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return requestRpcEditor(this.#pendingRequests, this.#output, title, prefill, dialogOptions, editorOptions);
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return Promise.resolve([]);
		}

		getTheme(): Promise<Theme | undefined> {
			return Promise.resolve(undefined);
		}

		setTheme(): Promise<{ success: boolean; error?: string }> {
			return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
		}

		getToolsExpanded(): boolean {
			return false;
		}

		setToolsExpanded(): void {}
		setEditorComponent(): void {}
	}

	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
	setToolUIContext?.(rpcUiContext, true);

	const observerToViews = (): RpcObservableSessionView[] =>
		observerRegistry.getSessions().map(item => ({
			id: item.id,
			sessionFile: item.sessionFile,
			label: item.label,
			status: item.status,
			agentType: item.agent,
			summary: item.progress?.lastIntent ?? item.description,
			updatedAt: new Date(item.lastUpdate).toISOString(),
		}));

	await writer.write({ type: "ready", ...protocolInfo() });

	const taskRunIds = new Map<string, string>();
	const taskRunIdsBySubagentId = new Map<string, string>();
	const parentTaskRunIdsBySubagentId = new Map<string, string>();
	const taskRunIdFor = (task: string, fallback: string): string => {
		const key = task.trim() || fallback;
		const existing = taskRunIds.get(key);
		if (existing) return existing;
		const id = `task_${Snowflake.next()}`;
		taskRunIds.set(key, id);
		return id;
	};

	if (!options.oneShotCommand && options.eventBus) {
		observerRegistry.subscribeToEventBus(options.eventBus);
		options.eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
			const payload = data as SubagentProgressPayload;
			const progress = payload.progress;
			const taskRunId = payload.taskRunId ?? taskRunIdFor(payload.task, progress.id);
			taskRunIdsBySubagentId.set(progress.id, taskRunId);
			if (payload.parentTaskRunId) parentTaskRunIdsBySubagentId.set(progress.id, payload.parentTaskRunId);
			const agent = taskProgressToRpcAgent(progress, null, payload.task);
			const agents = [agent, ...collectNestedProgress(progress.inflightTaskDetails, progress.id)];
			output({
				type: "task_progress",
				schemaVersion: 1,
				toolCallId: payload.toolCallId,
				taskRunId,
				parentTaskRunId: payload.parentTaskRunId,
				subagentId: progress.id,
				agents,
			});
		});
		options.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
			const payload = data as SubagentLifecyclePayload;
			const taskRunId =
				payload.taskRunId ?? taskRunIdsBySubagentId.get(payload.id) ?? taskRunIdFor(payload.id, payload.id);
			taskRunIdsBySubagentId.set(payload.id, taskRunId);
			if (payload.parentTaskRunId) parentTaskRunIdsBySubagentId.set(payload.id, payload.parentTaskRunId);
			output({
				type: "subagent_lifecycle",
				schemaVersion: 1,
				toolCallId: payload.toolCallId,
				taskRunId,
				parentTaskRunId: payload.parentTaskRunId,
				subagentId: payload.id,
				parentSubagentId: payload.id.includes(".") ? payload.id.slice(0, payload.id.lastIndexOf(".")) : null,
				status: payload.status,
				agentType: payload.agent,
				description: payload.description,
				sessionFile: payload.sessionFile,
				index: payload.index,
			});
		});
		observerRegistry.onChange(() => {
			output({ type: "observable_session_update", schemaVersion: 1, sessions: observerToViews() });
		});
	}

	if (!options.oneShotCommand) {
		observerRegistry.setMainSession(session.sessionFile);
		await initializeExtensions(session, {
			reportSendError: (action, err) => {
				output(error(undefined, action, errorInfoFromUnknown(err)));
			},
			reportRuntimeError: err => {
				output({
					type: "extension_error",
					extensionPath: err.extensionPath,
					event: err.event,
					error: err.error,
					errorInfo: rpcErrorInfo("internal_error", err.error),
				});
			},
			onShutdown: () => {
				shutdownRequested = true;
				shutdownReason = "extension_shutdown";
			},
			uiContext: rpcUiContext,
		});
	}

	const emitTaskResultIfPresent = (event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>) => {
		if (event.toolName !== "task") return;
		const details =
			event.result && typeof event.result === "object" ? (event.result as { details?: unknown }).details : undefined;
		if (!isTaskToolDetails(details) || !Array.isArray(details.results)) return;
		for (const result of details.results as SingleResult[]) {
			const taskRunId = taskRunIdsBySubagentId.get(result.id) ?? taskRunIdFor(result.task, result.id);
			const parentTaskRunId = parentTaskRunIdsBySubagentId.get(result.id);
			output({
				type: "task_result",
				schemaVersion: 1,
				toolCallId: event.toolCallId,
				taskRunId,
				parentTaskRunId,
				subagentId: result.id,
				results: taskResultToRpcResult(result),
			});
		}
	};

	session.subscribe(event => {
		if (event.type === "background_lane_update") {
			output({
				type: "background_lane_update",
				schemaVersion: 1,
				laneId: event.lane.id,
				status: event.lane.status,
				blocksIfFired: event.lane.blocksIfFired,
				summary: backgroundLaneSummary(event.lane),
			});
		} else {
			output(event);
		}
		if (event.type === "tool_execution_end") emitTaskResultIfPresent(event);
		const changed = STATE_EVENT_TYPES[event.type];
		if (changed) emitStateChanged(changed);
	});

	const responseFits = (response: RpcResponse): boolean =>
		Buffer.byteLength(JSON.stringify(response), "utf8") <= RPC_LIMITS.maxOutboundFrameBytes - 16_384;

	const dataFits = (requestId: string | undefined, command: string, data: JsonObject): boolean =>
		responseFits(success(requestId, command, data));

	const messagesResponseData = async (): Promise<JsonObject> => {
		const messages = session.messages;
		const inlineData = { messages };
		if (dataFits(undefined, "get_messages", inlineData as unknown as JsonObject)) {
			return inlineData as unknown as JsonObject;
		}
		const serialized = JSON.stringify(messages);
		const artifactId = await session.sessionManager.saveArtifact(serialized, "rpc-messages");
		const refData: JsonObject = {
			messages: [],
			total: messages.length,
			truncated: true,
		};
		if (artifactId) {
			refData.messagesRef = {
				kind: "artifact",
				uri: `artifact://${artifactId}`,
				bytes: Buffer.byteLength(serialized, "utf8"),
				preview: `Current branch messages (${messages.length})`,
			};
		}
		return refData;
	};

	const boundedPage = <T>(
		requestId: string | undefined,
		command: string,
		items: T[],
		build: (items: T[]) => JsonObject,
	): T[] => {
		let page = items;
		while (page.length > 0 && !dataFits(requestId, command, build(page))) {
			page = page.slice(0, Math.max(0, page.length - 1));
		}
		return page;
	};

	const responseTooLarge = (requestId: string | undefined, command: string): RpcResponse =>
		error(
			requestId,
			command,
			rpcErrorInfo("invalid_frame", `${command} response exceeded outbound frame limit`, {
				limitBytes: RPC_LIMITS.maxOutboundFrameBytes,
			}),
		);

	const serializeEntry = async (entry: SessionEntry, includeContent = true): Promise<RpcSessionEntryView> => {
		const text = textFromEntry(entry);
		const label = session.sessionManager.getLabel(entry.id);
		if (!includeContent) {
			return {
				id: entry.id,
				parentId: entry.parentId,
				type: entry.type,
				label,
				timestamp: entry.timestamp,
				preview: text ? previewText(text) : undefined,
			};
		}
		const serialized = JSON.stringify(entry);
		if (Buffer.byteLength(serialized, "utf8") <= RPC_LIMITS.maxSessionEntryContentBytes) {
			return {
				id: entry.id,
				parentId: entry.parentId,
				type: entry.type,
				label,
				timestamp: entry.timestamp,
				preview: text ? previewText(text) : undefined,
				entry,
			};
		}
		const artifactId = await session.sessionManager.saveArtifact(serialized, "rpc-session-entry");
		return {
			id: entry.id,
			parentId: entry.parentId,
			type: entry.type,
			label,
			timestamp: entry.timestamp,
			preview: text ? previewText(text) : undefined,
			contentRef: artifactId
				? {
						kind: "artifact",
						uri: `artifact://${artifactId}`,
						bytes: Buffer.byteLength(serialized, "utf8"),
						preview: previewText(text ?? serialized),
					}
				: undefined,
		};
	};

	const serializeTree = async (nodes: SessionTreeNode[], includeEntries: boolean): Promise<RpcSessionTreeNodeView[]> =>
		Promise.all(
			nodes.map(async node => ({
				id: node.entry.id,
				parentId: node.entry.parentId,
				type: node.entry.type,
				label: node.label,
				timestamp: node.entry.timestamp,
				entry: includeEntries ? await serializeEntry(node.entry) : undefined,
				children: await serializeTree(node.children, includeEntries),
			})),
		);

	const startOperation = <T>(
		command: string,
		requestId: string | undefined,
		run: (context: RpcOperationContext) => Promise<T> | T,
		cancel?: () => void | Promise<void>,
	): RpcOperationAck =>
		operationManager.start({
			command,
			requestId,
			cancel,
			run,
		});

	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;
		switch (command.type) {
			case "get_protocol_info":
				return success(id, "get_protocol_info", protocolInfo());
			case "get_state":
				return success(id, "get_state", buildState());
			case "ping":
				output({ type: "pong", payload: command.payload });
				return success(id, "ping", { pong: true, payload: command.payload });
			case "cancel_operation": {
				const info = operationManager.cancel(command.operationId);
				return info
					? error(id, "cancel_operation", info)
					: success(id, "cancel_operation", { operationId: command.operationId });
			}
			case "shutdown":
				shutdownRequested = true;
				shutdownReason = command.reason ?? "client_requested";
				return success(id, "shutdown", { reason: shutdownReason });
			case "shutdown_after": {
				const nested = validateRpcInputFrame(command.command);
				if (!nested.ok || nested.frame.type === "shutdown_after") {
					return error(
						id,
						"shutdown_after",
						nested.ok
							? rpcErrorInfo("invalid_arguments", "Nested shutdown_after is not supported")
							: nested.errorInfo,
					);
				}
				const response = await handleCommand({ ...nested.frame, id: command.command.id ?? id } as RpcCommand);
				shutdownRequested = true;
				shutdownReason = "one_shot_complete";
				return response;
			}
			case "prompt":
				return success(
					id,
					"prompt",
					startOperation(
						"prompt",
						id,
						() =>
							session.prompt(command.message, {
								images: command.images,
								streamingBehavior: command.streamingBehavior,
							}),
						() => session.abort(),
					),
				);
			case "steer":
				await session.steer(command.message, command.images);
				return success(id, "steer");
			case "follow_up":
				return success(
					id,
					"follow_up",
					startOperation(
						"follow_up",
						id,
						() => session.followUp(command.message, command.images),
						() => session.abort(),
					),
				);
			case "abort":
				operationManager.cancelByCommand([
					"prompt",
					"follow_up",
					"abort_and_prompt",
					"background_lane.spawn",
					"background_lane.message",
					"compact",
					"handoff",
					"login",
				]);
				void session.abort().catch(err =>
					output({
						type: "protocol_error",
						error: errorInfoFromUnknown(err).message,
						errorInfo: errorInfoFromUnknown(err),
					}),
				);
				emitStateChanged(["activeOperations", "isStreaming"]);
				return success(id, "abort");
			case "abort_and_prompt":
				return success(
					id,
					"abort_and_prompt",
					startOperation(
						"abort_and_prompt",
						id,
						async () => {
							await session.abort();
							await session.prompt(command.message, { images: command.images });
						},
						() => session.abort(),
					),
				);
			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const cancelled = !(await session.newSession(options));
				observerRegistry.setMainSession(session.sessionFile);
				emitStateChanged(["session", "messages", "sessionGraph", "todoPhases"]);
				return success(id, "new_session", { cancelled });
			}
			case "background_lane": {
				switch (command.op) {
					case "spawn":
						return success(
							id,
							"background_lane",
							startOperation("background_lane.spawn", id, context =>
								session.backgroundLaneSpawn(backgroundLaneSpawnInput(command), context.signal),
							),
						);
					case "list":
						return success(id, "background_lane", { lanes: session.backgroundLaneList() });
					case "message":
						return success(
							id,
							"background_lane",
							startOperation("background_lane.message", id, context =>
								session.backgroundLaneMessage(backgroundLaneMessageInput(command), context.signal),
							),
						);
					case "snapshot":
						return success(id, "background_lane", await session.backgroundLaneSnapshot(command.lane_id));
					case "close":
						return success(
							id,
							"background_lane",
							await session.backgroundLaneClose(backgroundLaneCloseInput(command)),
						);
				}
				return error(id, "background_lane", rpcErrorInfo("invalid_arguments", "Unsupported background_lane op"));
			}
			case "set_todos":
				session.setTodoPhases(command.phases as TodoPhase[]);
				emitStateChanged(["todoPhases"]);
				return success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				await session.refreshRpcHostTools(hostToolBridge.setTools(tools));
				emitStateChanged(["hostTools", "tools"]);
				return success(id, "set_host_tools", { toolNames: hostToolBridge.getToolNames() });
			}
			case "add_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				await session.refreshRpcHostTools(hostToolBridge.addTools(tools));
				emitStateChanged(["hostTools", "tools"]);
				return success(id, "add_host_tools", { toolNames: hostToolBridge.getToolNames() });
			}
			case "remove_host_tools":
				await session.refreshRpcHostTools(hostToolBridge.removeTools(command.toolNames));
				emitStateChanged(["hostTools", "tools"]);
				return success(id, "remove_host_tools", { toolNames: hostToolBridge.getToolNames() });
			case "set_host_uri_schemes": {
				const schemes = hostUriBridge.setSchemes(command.schemes);
				emitStateChanged(["hostUriSchemes", "security"]);
				return success(id, "set_host_uri_schemes", { schemes });
			}
			case "add_host_uri_schemes": {
				const schemes = hostUriBridge.addSchemes(command.schemes);
				emitStateChanged(["hostUriSchemes", "security"]);
				return success(id, "add_host_uri_schemes", { schemes });
			}
			case "remove_host_uri_schemes": {
				const schemes = hostUriBridge.removeSchemes(command.schemes);
				emitStateChanged(["hostUriSchemes", "security"]);
				return success(id, "remove_host_uri_schemes", { schemes });
			}
			case "set_model": {
				const models = session.getAvailableModels();
				const model = models.find(item => item.provider === command.provider && item.id === command.modelId);
				if (!model) {
					return error(
						id,
						"set_model",
						rpcErrorInfo("model_not_found", `Model not found: ${command.provider}/${command.modelId}`, {
							provider: command.provider,
							modelId: command.modelId,
						}),
					);
				}
				await session.setModel(model);
				emitStateChanged(["model"]);
				return success(id, "set_model", model);
			}
			case "cycle_model": {
				const result = await session.cycleModel();
				emitStateChanged(["model", "thinkingLevel"]);
				return success(id, "cycle_model", result ?? null);
			}
			case "get_available_models":
				return success(id, "get_available_models", { models: session.getAvailableModels() });
			case "set_thinking_level":
				session.setThinkingLevel(command.level);
				emitStateChanged(["thinkingLevel"]);
				return success(id, "set_thinking_level");
			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				emitStateChanged(["thinkingLevel"]);
				return success(id, "cycle_thinking_level", level ? { level } : null);
			}
			case "set_steering_mode":
				session.setSteeringMode(command.mode);
				emitStateChanged(["steeringMode"]);
				return success(id, "set_steering_mode");
			case "set_follow_up_mode":
				session.setFollowUpMode(command.mode);
				emitStateChanged(["followUpMode"]);
				return success(id, "set_follow_up_mode");
			case "set_interrupt_mode":
				session.setInterruptMode(command.mode);
				emitStateChanged(["interruptMode"]);
				return success(id, "set_interrupt_mode");
			case "compact":
				return success(
					id,
					"compact",
					startOperation(
						"compact",
						id,
						() => session.compact(command.customInstructions),
						() => session.abort(),
					),
				);
			case "set_auto_compaction":
				session.setAutoCompactionEnabled(command.enabled);
				emitStateChanged(["autoCompactionEnabled"]);
				return success(id, "set_auto_compaction");
			case "set_auto_retry":
				session.setAutoRetryEnabled(command.enabled);
				emitStateChanged(["autoRetryEnabled"]);
				return success(id, "set_auto_retry");
			case "abort_retry":
				session.abortRetry();
				return success(id, "abort_retry");
			case "bash":
				return success(
					id,
					"bash",
					startOperation(
						"bash",
						id,
						() => session.executeBash(command.command),
						() => session.abortBash(),
					),
				);
			case "abort_bash":
				operationManager.cancelByCommand(["bash"]);
				session.abortBash();
				return success(id, "abort_bash");
			case "get_session_stats":
				return success(id, "get_session_stats", session.getSessionStats());
			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}
			case "switch_session": {
				const cancelled = !(await session.switchSession(command.sessionPath));
				observerRegistry.setMainSession(session.sessionFile);
				emitStateChanged(["session", "messages", "sessionGraph", "todoPhases", "model", "thinkingLevel"]);
				return success(id, "switch_session", { cancelled });
			}
			case "branch": {
				const result = await session.branch(command.entryId);
				emitStateChanged(["session", "messages", "sessionGraph", "todoPhases"]);
				return success(id, "branch", { text: result.selectedText, cancelled: result.cancelled });
			}
			case "get_branch_messages":
				return success(id, "get_branch_messages", { messages: session.getUserMessagesForBranching() });
			case "get_last_assistant_text":
				return success(id, "get_last_assistant_text", { text: session.getLastAssistantText() });
			case "set_session_name": {
				const name = command.name.trim();
				if (!name)
					return error(id, "set_session_name", rpcErrorInfo("invalid_arguments", "Session name cannot be empty"));
				const applied = await session.setSessionName(name, "user");
				if (!applied)
					return error(id, "set_session_name", rpcErrorInfo("invalid_arguments", "Session name cannot be empty"));
				emitStateChanged(["sessionName"]);
				return success(id, "set_session_name");
			}
			case "handoff":
				return success(
					id,
					"handoff",
					startOperation(
						"handoff",
						id,
						async () => {
							const result = await session.handoff(command.customInstructions);
							return result ? { savedPath: result.savedPath } : null;
						},
						() => session.abort(),
					),
				);
			case "get_messages":
				return success(id, "get_messages", await messagesResponseData());
			case "get_session_entries": {
				let entries = session.sessionManager.getEntries();
				if (command.entryTypes && command.entryTypes.length > 0) {
					const allowed = new Set(command.entryTypes);
					entries = entries.filter(entry => allowed.has(entry.type));
				}
				const offset = Math.max(0, command.offset ?? 0);
				const limit = Math.max(1, Math.min(200, command.limit ?? 100));
				const includeContent = command.includeContent !== false;
				const requestedPage = entries.slice(offset, offset + limit);
				const serializedPage = await Promise.all(requestedPage.map(entry => serializeEntry(entry, includeContent)));
				const build = (page: RpcSessionEntryView[]): JsonObject => {
					const data: JsonObject = {
						entries: page as unknown as JsonObject[],
						total: entries.length,
						offset,
						limit: page.length,
						currentLeafId: session.sessionManager.getLeafId(),
					};
					if (offset + page.length < entries.length) data.nextOffset = offset + page.length;
					return data;
				};
				const page = boundedPage(id, "get_session_entries", serializedPage, build);
				if (serializedPage.length > 0 && page.length === 0) return responseTooLarge(id, "get_session_entries");
				return success(id, "get_session_entries", build(page));
			}
			case "get_session_tree": {
				const data: JsonObject = {
					root: (await serializeTree(
						session.sessionManager.getTree(),
						command.includeEntries === true,
					)) as unknown as JsonObject[],
					currentLeafId: session.sessionManager.getLeafId(),
				};
				return dataFits(id, "get_session_tree", data)
					? success(id, "get_session_tree", data)
					: responseTooLarge(id, "get_session_tree");
			}
			case "get_observable_sessions":
				return success(id, "get_observable_sessions", { sessions: observerToViews() });
			case "get_login_providers": {
				const providers = getOAuthProviders().map(provider => ({
					id: provider.id,
					name: provider.name,
					available: provider.available,
					authenticated: session.modelRegistry.authStorage.hasAuth(provider.id),
				}));
				return success(id, "get_login_providers", { providers });
			}
			case "login":
				return success(
					id,
					"login",
					startOperation("login", id, async context => {
						const cancellationError = new RpcProtocolError(
							"operation_cancelled",
							`Operation cancelled: ${context.operationId}`,
						);
						const waitForCancellation = (): Promise<string> => {
							const pending = Promise.withResolvers<string>();
							const rejectCancelled = () => pending.reject(cancellationError);
							if (context.signal.aborted) {
								rejectCancelled();
								return pending.promise;
							}
							context.signal.addEventListener("abort", rejectCancelled, { once: true });
							return pending.promise.finally(() => context.signal.removeEventListener("abort", rejectCancelled));
						};
						if (context.signal.aborted) throw cancellationError;
						const knownProvider = getOAuthProviders().find(provider => provider.id === command.providerId);
						if (!knownProvider) {
							throw new RpcProtocolError("invalid_arguments", `Unknown OAuth provider: ${command.providerId}`, {
								providerId: command.providerId,
							});
						}
						const uiCtx = new RpcExtensionUIContext(pendingExtensionRequests, output);
						let authEmitted = false;
						await session.modelRegistry.authStorage.login(command.providerId, {
							signal: context.signal,
							onAuth: info => {
								if (context.signal.aborted) return;
								authEmitted = true;
								output({
									type: "extension_ui_request",
									id: Snowflake.next() as string,
									method: "open_url",
									expectsResponse: false,
									url: info.url,
									instructions: info.instructions,
								} satisfies RpcExtensionUIRequest);
							},
							onProgress: message => {
								if (!context.signal.aborted) uiCtx.notify(message, "info");
							},
							onPrompt: () => {
								if (context.signal.aborted) throw cancellationError;
								if (!authEmitted) {
									return Promise.reject(
										new RpcProtocolError(
											"unsupported_capability",
											`Provider '${command.providerId}' requires interactive prompts which are not supported in RPC mode. Use the terminal UI to log in.`,
										),
									);
								}
								return waitForCancellation();
							},
						});
						if (context.signal.aborted) throw cancellationError;
						await session.modelRegistry.refresh();
						if (context.signal.aborted) throw cancellationError;
						return { providerId: command.providerId };
					}),
				);
		}
	};

	const emitProtocolError = (requestId: string | undefined, command: string | undefined, info: RpcErrorInfo) => {
		if (requestId) {
			output(error(requestId, command ?? "unknown", info));
			return;
		}
		output({ type: "protocol_error", error: info.message, errorInfo: info });
	};

	const emitUnmatchedInboundFrame = (frame: { id?: unknown; type?: unknown }, message: string) => {
		const info = rpcErrorInfo("invalid_frame", message);
		output({
			type: "protocol_error",
			requestId: typeof frame.id === "string" ? frame.id : undefined,
			error: info.message,
			errorInfo: info,
		});
	};

	const dispatchFrame = async (frame: RpcCommand | RpcExtensionUIResponse | object): Promise<void> => {
		const frameType = (frame as { type?: unknown }).type;
		if (frameType === "extension_ui_response") {
			const response = frame as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pending.resolve(response);
			} else {
				emitUnmatchedInboundFrame(response, "Unmatched extension UI response");
			}
			return;
		}
		if (frameType === "host_tool_result") {
			if (isRpcHostToolResult(frame)) {
				if (!hostToolBridge.handleResult(frame)) emitUnmatchedInboundFrame(frame, "Unmatched host tool result");
			} else {
				emitUnmatchedInboundFrame(frame as { id?: unknown; type?: unknown }, "Invalid host tool result frame");
			}
			return;
		}
		if (frameType === "host_tool_update") {
			if (isRpcHostToolUpdate(frame)) {
				if (!hostToolBridge.handleUpdate(frame)) emitUnmatchedInboundFrame(frame, "Unmatched host tool update");
			} else {
				emitUnmatchedInboundFrame(frame as { id?: unknown; type?: unknown }, "Invalid host tool update frame");
			}
			return;
		}
		if (frameType === "host_uri_result") {
			if (isRpcHostUriResult(frame)) {
				if (!hostUriBridge.handleResult(frame)) emitUnmatchedInboundFrame(frame, "Unmatched host URI result");
			} else {
				emitUnmatchedInboundFrame(frame as { id?: unknown; type?: unknown }, "Invalid host URI result frame");
			}
			return;
		}
		if (frameType === "host_tool_cancel_ack") {
			const handled = hostToolBridge.handleCancelAck(frame as RpcHostToolCancelAck);
			if (!handled) {
				emitUnmatchedInboundFrame(
					frame as { id?: unknown; type?: unknown },
					"Unmatched host tool cancel acknowledgement",
				);
			}
			return;
		}
		if (frameType === "host_uri_cancel_ack") {
			const handled = hostUriBridge.handleCancelAck(frame as RpcHostUriCancelAck);
			if (!handled) {
				emitUnmatchedInboundFrame(
					frame as { id?: unknown; type?: unknown },
					"Unmatched host URI cancel acknowledgement",
				);
			}
			return;
		}

		const command = frame as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
			} else {
				output(
					error(command.id, command.type, rpcErrorInfo("unknown_command", `Unknown command: ${command.type}`)),
				);
			}
		} catch (err) {
			output(error(command.id, command.type, errorInfoFromUnknown(err)));
		}
	};

	const performShutdown = async (
		reason: string,
		status: "graceful" | "peer_closed" | "one_shot_complete",
	): Promise<never> => {
		if (status === "peer_closed") {
			operationManager.failPeerClosed();
		} else {
			operationManager.failAll(
				rpcErrorInfo("operation_cancelled", `RPC shutdown (${reason}) cancelled active operation`),
				"cancelled",
			);
		}
		for (const pending of pendingExtensionRequests.values()) {
			pending.reject(new RpcProtocolError("peer_closed", "RPC peer closed stdin", undefined, true));
		}
		pendingExtensionRequests.clear();
		hostToolBridge.rejectAllPending("RPC client disconnected before host tool execution completed");
		hostUriBridge.clear("RPC client disconnected before host URI request completed");
		observerRegistry.dispose();
		if (session.extensionRunner?.hasHandlers("session_shutdown")) {
			await session.extensionRunner.emit({ type: "session_shutdown" });
		}
		output({ type: "shutdown", reason, status });
		await writer.drain();
		process.exit(0);
	};

	if (options.oneShotCommand) {
		const parsed = parseOneShotCommand(options.oneShotCommand);
		const validation = validateRpcInputFrame(parsed);
		if (validation.ok) {
			await dispatchFrame({ ...validation.frame, id: parsed.id ?? "req" });
		} else {
			emitProtocolError(validation.requestId ?? "req", validation.command, validation.errorInfo);
		}
		await performShutdown("one_shot_complete", "one_shot_complete");
	}

	for await (const parsed of readBoundedRpcInput(Bun.stdin.stream())) {
		if (!parsed.ok) {
			emitProtocolError(parsed.requestId, parsed.command, parsed.errorInfo);
			continue;
		}
		void dispatchFrame(parsed.frame).then(async () => {
			if (shutdownRequested) await performShutdown(shutdownReason, "graceful");
		});
	}

	await performShutdown("stdin_closed", "peer_closed");
}

function parseOneShotCommand(raw: string): RpcCommand {
	const trimmed = raw.trim();
	if (trimmed.startsWith("{")) {
		const parsed = JSON.parse(trimmed) as JsonObject;
		return { ...parsed, id: typeof parsed.id === "string" ? parsed.id : "req" } as unknown as RpcCommand;
	}
	return { id: "req", type: trimmed } as RpcCommand;
}
