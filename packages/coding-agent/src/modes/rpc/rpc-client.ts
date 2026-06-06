/**
 * RPC Client for programmatic access to the coding agent.
 */

import { isPromise } from "node:util/types";
import type { AgentEvent, AgentMessage, AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { isRecord, ptree, readJsonl } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";
import type { BashResult } from "../../exec/bash-executor";
import type { SessionStats } from "../../session/agent-session";
import { RPC_LIMITS } from "./rpc-protocol";
import type {
	JsonValue,
	RpcCommand,
	RpcErrorInfo,
	RpcExtensionErrorFrame,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHandoffResult,
	RpcHostToolCallRequest,
	RpcHostToolCancelAck,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelAck,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcHostUriSchemeDefinition,
	RpcLargeContentRef,
	RpcObservableSessionView,
	RpcOperationAck,
	RpcOperationEndFrame,
	RpcOperationErrorFrame,
	RpcProtocolErrorFrame,
	RpcProtocolInfo,
	RpcResponse,
	RpcSessionEntryView,
	RpcSessionState,
	RpcSessionTreeNodeView,
} from "./rpc-types";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcMessagesResponse {
	messages: AgentMessage[];
	total?: number;
	truncated?: boolean;
	messagesRef?: RpcLargeContentRef;
}

export interface RpcClientOptions {
	cliPath?: string;
	cwd?: string;
	env?: Record<string, string>;
	provider?: string;
	model?: string;
	sessionDir?: string;
	args?: string[];
	customTools?: RpcClientCustomTool[];
	hostUris?: RpcClientHostUri[];
	onFrame?: RpcRawFrameListener;
	onProtocolError?: RpcProtocolErrorListener;
	onUnknownFrame?: RpcUnknownFrameListener;
	onSessionEvent?: RpcSessionEventListener;
	onExtensionError?: RpcExtensionErrorListener;
}

export type ModelInfo = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning" | "thinking">;
export type RpcEventListener = (event: AgentEvent) => void;
export type RpcRawFrameListener = (frame: unknown) => void;
export type RpcUnknownFrameListener = (frame: unknown) => void;
export type RpcProtocolErrorListener = (frame: RpcProtocolErrorFrame) => void;
export type RpcSessionEventListener = (frame: unknown) => void;
export type RpcExtensionErrorListener = (frame: RpcExtensionErrorFrame) => void;

export interface RpcClientToolContext<TDetails = unknown> {
	toolCallId: string;
	signal: AbortSignal;
	sendUpdate(partialResult: RpcClientToolResult<TDetails>): void;
}

export type RpcClientToolResult<TDetails = unknown> = AgentToolResult<TDetails> | string;

export interface RpcClientCustomTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
> extends Omit<RpcHostToolDefinition, "parameters"> {
	parameters: Record<string, unknown>;
	execute(
		params: TParams,
		context: RpcClientToolContext<TDetails>,
	): Promise<RpcClientToolResult<TDetails>> | RpcClientToolResult<TDetails>;
}

export function defineRpcClientTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
>(tool: RpcClientCustomTool<TParams, TDetails>): RpcClientCustomTool<TParams, TDetails> {
	return tool;
}

export interface RpcClientHostUriContext {
	id: string;
	operation: "read" | "write";
	url: string;
	signal: AbortSignal;
	range?: RpcHostUriRequest["range"];
}

export interface RpcClientHostUri extends RpcHostUriSchemeDefinition {
	read?(url: string, context: RpcClientHostUriContext): Promise<RpcHostUriResult | string> | RpcHostUriResult | string;
	write?(
		url: string,
		content: string,
		context: RpcClientHostUriContext,
	): Promise<undefined | RpcHostUriResult> | undefined | RpcHostUriResult;
}

const agentEventTypes: Record<AgentEvent["type"], true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
};

const sessionEventTypes: Record<string, true> = {
	state_changed: true,
	observable_session_update: true,
	task_progress: true,
	task_result: true,
	subagent_lifecycle: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	retry_fallback_applied: true,
	retry_fallback_succeeded: true,
	ttsr_triggered: true,
	todo_reminder: true,
	todo_auto_clear: true,
	irc_message: true,
	notice: true,
	thinking_level_changed: true,
	goal_updated: true,
};

function jsonByteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function hostUriResultPayloadBytes(frame: RpcHostUriResult): number {
	let bytes = typeof frame.content === "string" ? Buffer.byteLength(frame.content, "utf8") : 0;
	if (typeof frame.bytesBase64 === "string") bytes += Buffer.byteLength(frame.bytesBase64, "base64");
	return bytes;
}

function isRpcResponse(value: unknown): value is RpcResponse {
	if (!isRecord(value)) return false;
	if (value.type !== "response") return false;
	if (typeof value.command !== "string") return false;
	if (typeof value.success !== "boolean") return false;
	if (value.id !== undefined && typeof value.id !== "string") return false;
	if (value.success === false) return typeof value.error === "string";
	return true;
}

function isAgentEvent(value: unknown): value is AgentEvent {
	if (!isRecord(value)) return false;
	const type = value.type;
	return typeof type === "string" && agentEventTypes[type as AgentEvent["type"]] === true;
}

function isRpcHostToolCallRequest(value: unknown): value is RpcHostToolCallRequest {
	if (!isRecord(value)) return false;
	return (
		value.type === "host_tool_call" &&
		typeof value.id === "string" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		isRecord(value.arguments)
	);
}

function isRpcHostToolCancelRequest(value: unknown): value is RpcHostToolCancelRequest {
	if (!isRecord(value)) return false;
	return value.type === "host_tool_cancel" && typeof value.id === "string" && typeof value.targetId === "string";
}

function isRpcHostUriRequest(value: unknown): value is RpcHostUriRequest {
	if (!isRecord(value)) return false;
	return (
		value.type === "host_uri_request" &&
		typeof value.id === "string" &&
		typeof value.operation === "string" &&
		typeof value.url === "string"
	);
}

function isRpcHostUriCancelRequest(value: unknown): value is RpcHostUriCancelRequest {
	if (!isRecord(value)) return false;
	return value.type === "host_uri_cancel" && typeof value.id === "string" && typeof value.targetId === "string";
}

function isRpcExtensionUiRequest(value: unknown): value is RpcExtensionUIRequest {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_request" && typeof value.id === "string" && typeof value.method === "string";
}

function isProtocolErrorFrame(value: unknown): value is RpcProtocolErrorFrame {
	if (!isRecord(value)) return false;
	return value.type === "protocol_error" && typeof value.error === "string";
}

function isExtensionErrorFrame(value: unknown): value is RpcExtensionErrorFrame {
	if (!isRecord(value)) return false;
	return value.type === "extension_error" && typeof value.error === "string";
}

function isOperationStartFrame(value: unknown): value is { type: "operation_start"; operationId: string } {
	if (!isRecord(value)) return false;
	return value.type === "operation_start" && typeof value.operationId === "string";
}

function isOperationTerminalFrame(value: unknown): value is RpcOperationEndFrame | RpcOperationErrorFrame {
	if (!isRecord(value)) return false;
	return (value.type === "operation_end" || value.type === "operation_error") && typeof value.operationId === "string";
}

function isSessionFrame(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const type = value.type;
	return typeof type === "string" && sessionEventTypes[type] === true;
}

function normalizeToolResult<TDetails>(result: RpcClientToolResult<TDetails>): AgentToolResult<TDetails> {
	if (typeof result === "string") return { content: [{ type: "text", text: result }] };
	return result;
}

function normalizeHostUriReadResult(id: string, result: RpcHostUriResult | string): RpcHostUriResult {
	if (typeof result === "string") return { type: "host_uri_result", id, content: result, contentType: "text/plain" };
	return { ...result, type: "host_uri_result", id };
}

export class RpcClient {
	#options: RpcClientOptions;
	#process: ptree.ChildProcess | null = null;
	#eventListeners: RpcEventListener[] = [];
	#frameListeners: RpcRawFrameListener[] = [];
	#unknownFrameListeners: RpcUnknownFrameListener[] = [];
	#protocolErrorListeners: RpcProtocolErrorListener[] = [];
	#sessionEventListeners: RpcSessionEventListener[] = [];
	#extensionErrorListeners: RpcExtensionErrorListener[] = [];
	#pendingRequests = new Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }>();
	#customTools: RpcClientCustomTool[] = [];
	#hostUris: RpcClientHostUri[] = [];
	#pendingHostToolCalls = new Map<string, { controller: AbortController }>();
	#pendingHostUriRequests = new Map<string, { controller: AbortController }>();
	#operations = new Map<string, RpcOperationEndFrame | RpcOperationErrorFrame | { status: "running" }>();
	#operationWaiters = new Map<
		string,
		Array<{ resolve: (frame: RpcOperationEndFrame | RpcOperationErrorFrame) => void; reject: (error: Error) => void }>
	>();
	#idleWaiters: Array<{ resolve: () => void; reject: (error: Error) => void; timeoutId: NodeJS.Timeout }> = [];
	#requestId = 0;
	#extensionUiListeners = new Set<(req: RpcExtensionUIRequest) => void>();
	#abortController = new AbortController();
	#readyInfo: RpcProtocolInfo | null = null;
	#closed = false;

	constructor(options: RpcClientOptions = {}) {
		this.#options = options;
		this.#customTools = [...(options.customTools ?? [])];
		this.#hostUris = [...(options.hostUris ?? [])];
		if (options.onFrame) this.#frameListeners.push(options.onFrame);
		if (options.onProtocolError) this.#protocolErrorListeners.push(options.onProtocolError);
		if (options.onUnknownFrame) this.#unknownFrameListeners.push(options.onUnknownFrame);
		if (options.onSessionEvent) this.#sessionEventListeners.push(options.onSessionEvent);
		if (options.onExtensionError) this.#extensionErrorListeners.push(options.onExtensionError);
	}

	async start(): Promise<void> {
		if (this.#process) throw new Error("Client already started");
		this.#closed = false;
		this.#abortController = new AbortController();
		const cliPath = this.#options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];
		if (this.#options.provider) args.push("--provider", this.#options.provider);
		if (this.#options.model) args.push("--model", this.#options.model);
		if (this.#options.sessionDir) args.push("--session-dir", this.#options.sessionDir);
		if (this.#options.args) args.push(...this.#options.args);
		this.#process = ptree.spawn(["bun", cliPath, ...args], {
			cwd: this.#options.cwd,
			env: { ...Bun.env, ...this.#options.env },
			stdin: "pipe",
		});

		const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
		let readySettled = false;
		const settleReady = (err?: Error) => {
			if (readySettled) return;
			readySettled = true;
			if (err) readyReject(err);
			else readyResolve();
		};

		const lines = readJsonl(this.#process.stdout, this.#abortController.signal);
		void (async () => {
			for await (const line of lines) {
				if (!readySettled && isRecord(line) && line.type === "ready") settleReady();
				this.#handleLine(line);
			}
			const error = new Error(`Agent process stdout closed. Stderr: ${this.#process?.peekStderr() ?? ""}`);
			if (!readySettled) settleReady(error);
			this.#close(error, false);
		})().catch((err: Error) => {
			if (!readySettled) settleReady(err);
			this.#close(err, false);
		});

		void this.#process.exited.then((exitCode: number) => {
			const err = new Error(
				`Agent process exited with code ${exitCode}. Stderr: ${this.#process?.peekStderr() ?? ""}`,
			);
			if (!readySettled) settleReady(err);
			this.#close(err, false);
		});

		const readyTimeout = this.#startTimeout(30000, () => {
			settleReady(
				new Error(`Timeout waiting for agent to become ready. Stderr: ${this.#process?.peekStderr() ?? ""}`),
			);
		});
		try {
			await readyPromise;
			if (this.#customTools.length > 0) await this.setCustomTools(this.#customTools);
			if (this.#hostUris.length > 0) await this.setHostUris(this.#hostUris);
		} finally {
			clearTimeout(readyTimeout);
		}
	}

	stop(): void {
		this.#close(new Error("RPC client stopped"), true);
	}

	[Symbol.dispose](): void {
		this.stop();
	}

	get readyInfo(): RpcProtocolInfo | null {
		return this.#readyInfo;
	}

	onEvent(listener: RpcEventListener): () => void {
		this.#eventListeners.push(listener);
		return () => this.#removeListener(this.#eventListeners, listener);
	}

	onFrame(listener: RpcRawFrameListener): () => void {
		this.#frameListeners.push(listener);
		return () => this.#removeListener(this.#frameListeners, listener);
	}

	onUnknownFrame(listener: RpcUnknownFrameListener): () => void {
		this.#unknownFrameListeners.push(listener);
		return () => this.#removeListener(this.#unknownFrameListeners, listener);
	}

	onProtocolError(listener: RpcProtocolErrorListener): () => void {
		this.#protocolErrorListeners.push(listener);
		return () => this.#removeListener(this.#protocolErrorListeners, listener);
	}

	onSessionEvent(listener: RpcSessionEventListener): () => void {
		this.#sessionEventListeners.push(listener);
		return () => this.#removeListener(this.#sessionEventListeners, listener);
	}

	onExtensionError(listener: RpcExtensionErrorListener): () => void {
		this.#extensionErrorListeners.push(listener);
		return () => this.#removeListener(this.#extensionErrorListeners, listener);
	}

	onExtensionUiRequest(listener: (req: RpcExtensionUIRequest) => void): () => void {
		this.#extensionUiListeners.add(listener);
		return () => this.#extensionUiListeners.delete(listener);
	}

	getStderr(): string {
		return this.#process?.peekStderr() ?? "";
	}

	async ping(payload?: JsonValue): Promise<{ pong: true; payload?: JsonValue }> {
		const response = await this.#send({ type: "ping", payload });
		return this.#getData(response);
	}

	async getProtocolInfo(): Promise<RpcProtocolInfo> {
		const response = await this.#send({ type: "get_protocol_info" });
		return this.#getData(response);
	}

	async shutdown(reason?: string): Promise<{ reason: string }> {
		const response = await this.#send({ type: "shutdown", reason });
		return this.#getData(response);
	}

	async shutdownAfter(command: RpcCommandBody): Promise<RpcResponse> {
		return this.#send({ type: "shutdown_after", command: command as RpcCommand });
	}

	async prompt(message: string, images?: ImageContent[]): Promise<RpcOperationAck> {
		const response = await this.#send({ type: "prompt", message, images });
		return this.#getOperationAck(response, "prompt");
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "steer", message, images });
	}

	async followUp(message: string, images?: ImageContent[]): Promise<RpcOperationAck> {
		const response = await this.#send({ type: "follow_up", message, images });
		return this.#getOperationAck(response, "follow_up");
	}

	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	async abortAndPrompt(message: string, images?: ImageContent[]): Promise<RpcOperationAck> {
		const response = await this.#send({ type: "abort_and_prompt", message, images });
		return this.#getOperationAck(response, "abort_and_prompt");
	}

	async cancelOperation(operationId: string): Promise<void> {
		await this.#send({ type: "cancel_operation", operationId });
	}

	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "new_session", parentSession });
		return this.#getData(response);
	}

	async getState(): Promise<RpcSessionState> {
		const response = await this.#send({ type: "get_state" });
		return this.#getData(response);
	}

	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.#send({ type: "set_model", provider, modelId });
		return this.#getData(response);
	}

	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel | undefined;
		isScoped: boolean;
	} | null> {
		const response = await this.#send({ type: "cycle_model" });
		return this.#getData(response);
	}

	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.#send({ type: "get_available_models" });
		return this.#getData<{ models: ModelInfo[] }>(response).models;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.#send({ type: "set_thinking_level", level });
	}

	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.#send({ type: "cycle_thinking_level" });
		return this.#getData(response);
	}

	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_steering_mode", mode });
	}

	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_follow_up_mode", mode });
	}

	async setInterruptMode(mode: "immediate" | "wait"): Promise<void> {
		await this.#send({ type: "set_interrupt_mode", mode });
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this.#sendOperation<CompactionResult>({ type: "compact", customInstructions }, 600_000);
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_compaction", enabled });
	}

	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_retry", enabled });
	}

	async abortRetry(): Promise<void> {
		await this.#send({ type: "abort_retry" });
	}

	async bash(command: string): Promise<BashResult> {
		return this.#sendOperation<BashResult>({ type: "bash", command });
	}

	async abortBash(): Promise<void> {
		await this.#send({ type: "abort_bash" });
	}

	async getSessionStats(): Promise<SessionStats> {
		const response = await this.#send({ type: "get_session_stats" });
		return this.#getData(response);
	}

	async handoff(customInstructions?: string): Promise<RpcHandoffResult | null> {
		return this.#sendOperation<RpcHandoffResult | null>({ type: "handoff", customInstructions }, 600_000);
	}

	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.#send({ type: "export_html", outputPath });
		return this.#getData(response);
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "switch_session", sessionPath });
		return this.#getData(response);
	}

	async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.#send({ type: "branch", entryId });
		return this.#getData(response);
	}

	async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.#send({ type: "get_branch_messages" });
		return this.#getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	async getLastAssistantText(): Promise<string | null> {
		const response = await this.#send({ type: "get_last_assistant_text" });
		return this.#getData<{ text: string | null }>(response).text;
	}

	async getMessagesResponse(): Promise<RpcMessagesResponse> {
		const response = await this.#send({ type: "get_messages" });
		return this.#getData(response);
	}

	async getMessages(): Promise<AgentMessage[]> {
		const data = await this.getMessagesResponse();
		return data.messages;
	}

	async getSessionEntries(options?: {
		offset?: number;
		limit?: number;
		entryTypes?: string[];
		includeContent?: boolean;
	}): Promise<{
		entries: RpcSessionEntryView[];
		total: number;
		offset: number;
		limit: number;
		nextOffset?: number;
		currentLeafId: string | null;
	}> {
		const response = await this.#send({
			type: "get_session_entries",
			offset: options?.offset,
			limit: options?.limit,
			entryTypes: options?.entryTypes,
			includeContent: options?.includeContent,
		});
		return this.#getData(response);
	}

	async getSessionTree(includeEntries = false): Promise<{
		root: RpcSessionTreeNodeView[];
		currentLeafId: string | null;
	}> {
		const response = await this.#send({ type: "get_session_tree", includeEntries });
		return this.#getData(response);
	}

	async getObservableSessions(): Promise<RpcObservableSessionView[]> {
		const response = await this.#send({ type: "get_observable_sessions" });
		return this.#getData<{ sessions: RpcObservableSessionView[] }>(response).sessions;
	}

	async getLoginProviders(): Promise<Array<{ id: string; name: string; available: boolean; authenticated: boolean }>> {
		const response = await this.#send({ type: "get_login_providers" });
		return this.#getData<{
			providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }>;
		}>(response).providers;
	}

	async login(
		providerId: string,
		options?: { onOpenUrl?: (url: string, instructions?: string) => void },
	): Promise<{ providerId: string }> {
		const listener = options?.onOpenUrl
			? (req: RpcExtensionUIRequest) => {
					if (req.method === "open_url") options.onOpenUrl?.(req.url, req.instructions);
				}
			: undefined;
		if (listener) this.#extensionUiListeners.add(listener);
		try {
			return await this.#sendOperation<{ providerId: string }>({ type: "login", providerId }, 600_000);
		} finally {
			if (listener) this.#extensionUiListeners.delete(listener);
		}
	}

	async setCustomTools(tools: RpcClientCustomTool[]): Promise<string[]> {
		this.#customTools = [...tools];
		if (!this.#process) return this.#customTools.map(tool => tool.name);
		const definitions = this.#customTools.map(tool => this.#toolDefinition(tool));
		const response = await this.#send({ type: "set_host_tools", tools: definitions });
		return this.#getData<{ toolNames: string[] }>(response).toolNames;
	}

	async addCustomTools(tools: RpcClientCustomTool[]): Promise<string[]> {
		const byName = new Map(this.#customTools.map(tool => [tool.name, tool]));
		for (const tool of tools) byName.set(tool.name, tool);
		this.#customTools = Array.from(byName.values());
		const response = await this.#send({
			type: "add_host_tools",
			tools: tools.map(tool => this.#toolDefinition(tool)),
		});
		return this.#getData<{ toolNames: string[] }>(response).toolNames;
	}

	async removeCustomTools(toolNames: string[]): Promise<string[]> {
		const remove = new Set(toolNames);
		this.#customTools = this.#customTools.filter(tool => !remove.has(tool.name));
		const response = await this.#send({ type: "remove_host_tools", toolNames });
		return this.#getData<{ toolNames: string[] }>(response).toolNames;
	}

	async setHostUris(hostUris: RpcClientHostUri[]): Promise<string[]> {
		this.#hostUris = [...hostUris];
		if (!this.#process) return this.#hostUris.map(uri => uri.scheme);
		const response = await this.#send({
			type: "set_host_uri_schemes",
			schemes: this.#hostUris.map(uri => this.#hostUriDefinition(uri)),
		});
		return this.#getData<{ schemes: string[] }>(response).schemes;
	}

	async addHostUris(hostUris: RpcClientHostUri[]): Promise<string[]> {
		const byScheme = new Map(this.#hostUris.map(uri => [uri.scheme.toLowerCase(), uri]));
		for (const uri of hostUris) byScheme.set(uri.scheme.toLowerCase(), uri);
		this.#hostUris = Array.from(byScheme.values());
		const response = await this.#send({
			type: "add_host_uri_schemes",
			schemes: hostUris.map(uri => this.#hostUriDefinition(uri)),
		});
		return this.#getData<{ schemes: string[] }>(response).schemes;
	}

	async removeHostUris(schemes: string[]): Promise<string[]> {
		const remove = new Set(schemes.map(scheme => scheme.toLowerCase()));
		this.#hostUris = this.#hostUris.filter(uri => !remove.has(uri.scheme.toLowerCase()));
		const response = await this.#send({ type: "remove_host_uri_schemes", schemes });
		return this.#getData<{ schemes: string[] }>(response).schemes;
	}

	respondExtensionUi(response: RpcExtensionUIResponse): void {
		this.#writeFrame(response);
	}

	cancelExtensionUi(id: string, timedOut = false): void {
		this.respondExtensionUi({ type: "extension_ui_response", id, cancelled: true, timedOut });
	}

	waitForOperation(operationId: string, timeout = 60000): Promise<RpcOperationEndFrame | RpcOperationErrorFrame> {
		const existing = this.#operations.get(operationId);
		if (existing && existing.status !== "running") return Promise.resolve(existing);
		const { promise, resolve, reject } = Promise.withResolvers<RpcOperationEndFrame | RpcOperationErrorFrame>();
		const timeoutId = this.#startTimeout(timeout, () => {
			this.#removeOperationWaiter(operationId, waiter);
			reject(
				new Error(`Timeout waiting for operation ${operationId}. Stderr: ${this.#process?.peekStderr() ?? ""}`),
			);
		});
		const waiter = {
			resolve: (frame: RpcOperationEndFrame | RpcOperationErrorFrame) => {
				clearTimeout(timeoutId);
				resolve(frame);
			},
			reject: (error: Error) => {
				clearTimeout(timeoutId);
				reject(error);
			},
		};
		const waiters = this.#operationWaiters.get(operationId) ?? [];
		waiters.push(waiter);
		this.#operationWaiters.set(operationId, waiters);
		return promise;
	}

	waitForIdle(timeout = 60000): Promise<void> {
		if (this.#activeOperationCount() === 0) return Promise.resolve();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timeoutId = this.#startTimeout(timeout, () => {
			this.#idleWaiters = this.#idleWaiters.filter(waiter => waiter.resolve !== resolve);
			reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		this.#idleWaiters.push({ resolve, reject, timeoutId });
		return promise;
	}

	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();
		const events: AgentEvent[] = [];
		const unsubscribe = this.onEvent(event => {
			events.push(event);
			if (event.type === "agent_end") {
				unsubscribe();
				clearTimeout(timeoutId);
				resolve(events);
			}
		});
		const timeoutId = this.#startTimeout(timeout, () => {
			unsubscribe();
			reject(new Error(`Timeout collecting events. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	#startTimeout(timeoutMs: number, onTimeout: () => void): NodeJS.Timeout {
		const timer = setTimeout(onTimeout, timeoutMs);
		timer.unref();
		return timer;
	}

	#handleLine(data: unknown): void {
		for (const listener of this.#frameListeners) listener(data);
		if (isRecord(data) && data.type === "ready") {
			this.#readyInfo = data as unknown as RpcProtocolInfo;
			return;
		}
		if (isRpcResponse(data)) {
			this.#handleResponse(data);
			return;
		}
		if (isOperationStartFrame(data)) {
			this.#markOperationRunning(data.operationId);
			return;
		}
		if (isOperationTerminalFrame(data)) {
			this.#handleOperationTerminal(data);
			return;
		}
		if (isProtocolErrorFrame(data)) {
			for (const listener of this.#protocolErrorListeners) listener(data);
			return;
		}
		if (isExtensionErrorFrame(data)) {
			for (const listener of this.#extensionErrorListeners) listener(data);
			return;
		}
		if (isSessionFrame(data)) {
			for (const listener of this.#sessionEventListeners) listener(data);
			return;
		}
		if (isRpcHostToolCallRequest(data)) {
			void this.#handleHostToolCall(data);
			return;
		}
		if (isRpcHostToolCancelRequest(data)) {
			const pending = this.#pendingHostToolCalls.get(data.targetId);
			pending?.controller.abort();
			this.#writeFrame({
				type: "host_tool_cancel_ack",
				id: data.id,
				targetId: data.targetId,
				accepted: !!pending,
			});
			return;
		}
		if (isRpcHostUriRequest(data)) {
			void this.#handleHostUriRequest(data);
			return;
		}
		if (isRpcHostUriCancelRequest(data)) {
			const pending = this.#pendingHostUriRequests.get(data.targetId);
			pending?.controller.abort();
			this.#writeFrame({
				type: "host_uri_cancel_ack",
				id: data.id,
				targetId: data.targetId,
				accepted: !!pending,
			});
			return;
		}
		if (isRpcExtensionUiRequest(data)) {
			for (const listener of this.#extensionUiListeners) listener(data);
			return;
		}
		if (isAgentEvent(data)) {
			for (const listener of this.#eventListeners) listener(data);
			if (data.type === "agent_end") this.#resolveIdleIfReady();
			return;
		}
		for (const listener of this.#unknownFrameListeners) listener(data);
	}

	#handleResponse(data: RpcResponse): void {
		const id = data.id;
		if (!id) return;
		const pending = this.#pendingRequests.get(id);
		if (!pending) return;
		this.#pendingRequests.delete(id);
		pending.resolve(data);
	}

	#send(command: RpcCommandBody, timeoutMs = 30_000): Promise<RpcResponse> {
		if (!this.#process?.stdin || this.#closed) throw new Error("Client not started");
		const id = `req_${++this.#requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;
		if (jsonByteLength(fullCommand) > RPC_LIMITS.maxOutboundFrameBytes) {
			return Promise.reject(
				this.#errorFromInfo({
					code: "invalid_frame",
					message: `RPC command ${command.type} exceeded outbound frame size limit`,
				}),
			);
		}
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		let settled = false;
		const timeoutId = this.#startTimeout(timeoutMs, () => {
			if (settled) return;
			settled = true;
			this.#pendingRequests.delete(id);
			reject(
				new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.#process?.peekStderr() ?? ""}`),
			);
		});
		this.#pendingRequests.set(id, {
			resolve: response => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				resolve(response);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				reject(error);
			},
		});
		this.#writeFrame(fullCommand, err => {
			this.#pendingRequests.delete(id);
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			reject(err);
		});
		return promise;
	}

	async #sendOperation<T>(command: RpcCommandBody, timeoutMs = 60_000): Promise<T> {
		const response = await this.#send(command, timeoutMs);
		const ack = this.#getOperationAck(response, command.type);
		const terminal = await this.waitForOperation(ack.operationId, timeoutMs);
		if (terminal.type === "operation_error") {
			throw this.#errorFromInfo(terminal.errorInfo);
		}
		return terminal.data as T;
	}

	#writeHostToolResult(
		request: RpcHostToolCallRequest,
		result: AgentToolResult<unknown>,
		isError = false,
		errorInfo?: RpcErrorInfo,
	): void {
		const frame: RpcHostToolResult = {
			type: "host_tool_result",
			id: request.id,
			result,
			isError: isError || undefined,
			errorInfo,
		};
		const limitBytes = typeof request.maxResultBytes === "number" ? request.maxResultBytes : Number.MAX_SAFE_INTEGER;
		if (jsonByteLength(result) <= limitBytes) {
			this.#writeFrame(frame);
			return;
		}
		const info: RpcErrorInfo = {
			code: "host_tool_too_large",
			message: `Host tool response exceeded size limit for ${request.toolName}`,
			details: { toolName: request.toolName, limitBytes },
			retryable: false,
		};
		this.#writeFrame({
			type: "host_tool_result",
			id: request.id,
			result: { content: [{ type: "text", text: info.message }], details: {} },
			isError: true,
			errorInfo: info,
		});
	}

	#writeHostToolUpdate(request: RpcHostToolCallRequest, partialResult: AgentToolResult<unknown>): boolean {
		const frame: RpcHostToolUpdate = { type: "host_tool_update", id: request.id, partialResult };
		const limitBytes = typeof request.maxUpdateBytes === "number" ? request.maxUpdateBytes : Number.MAX_SAFE_INTEGER;
		if (jsonByteLength(partialResult) <= limitBytes) {
			this.#writeFrame(frame);
			return true;
		}
		const info: RpcErrorInfo = {
			code: "host_tool_too_large",
			message: `Host tool update exceeded size limit for ${request.toolName}`,
			details: { toolName: request.toolName, limitBytes },
			retryable: false,
		};
		this.#writeHostToolResult(request, { content: [{ type: "text", text: info.message }], details: {} }, true, info);
		return false;
	}

	#writeHostUriResult(request: RpcHostUriRequest, frame: RpcHostUriResult): void {
		const limitBytes =
			typeof request.maxContentBytes === "number" ? request.maxContentBytes : Number.MAX_SAFE_INTEGER;
		if (hostUriResultPayloadBytes(frame) <= limitBytes) {
			this.#writeFrame(frame);
			return;
		}
		const info: RpcErrorInfo = {
			code: "host_uri_too_large",
			message: `Host URI ${request.operation} result exceeded size limit`,
			details: { url: request.url, limitBytes },
			retryable: false,
		};
		this.#writeFrame({
			type: "host_uri_result",
			id: request.id,
			isError: true,
			error: info.message,
			errorInfo: info,
		});
	}

	async #handleHostToolCall(request: RpcHostToolCallRequest): Promise<void> {
		const tool = this.#customTools.find(candidate => candidate.name === request.toolName);
		if (!tool) {
			this.#writeHostToolResult(
				request,
				{
					content: [{ type: "text", text: `Host tool "${request.toolName}" is not registered` }],
					details: {},
				},
				true,
			);
			return;
		}
		const controller = new AbortController();
		this.#pendingHostToolCalls.set(request.id, { controller });
		const timeoutId = request.deadlineMs
			? this.#startTimeout(request.deadlineMs, () => {
					controller.abort();
				})
			: undefined;
		const sendUpdate = (partialResult: RpcClientToolResult<unknown>): void => {
			if (controller.signal.aborted) return;
			const accepted = this.#writeHostToolUpdate(request, normalizeToolResult(partialResult));
			if (!accepted) controller.abort();
		};
		try {
			const result = await tool.execute(request.arguments, {
				toolCallId: request.toolCallId,
				signal: controller.signal,
				sendUpdate,
			});
			if (controller.signal.aborted) return;
			this.#writeHostToolResult(request, normalizeToolResult(result));
		} catch (error) {
			if (controller.signal.aborted) return;
			this.#writeHostToolResult(
				request,
				{
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
				},
				true,
			);
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
			this.#pendingHostToolCalls.delete(request.id);
		}
	}

	async #handleHostUriRequest(request: RpcHostUriRequest): Promise<void> {
		let hostUri: RpcClientHostUri | undefined;
		try {
			hostUri = this.#hostUris.find(
				uri => uri.scheme.toLowerCase() === new URL(request.url).protocol.replace(/:$/, "").toLowerCase(),
			);
		} catch (error) {
			this.#writeHostUriResult(request, {
				type: "host_uri_result",
				id: request.id,
				isError: true,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		if (!hostUri) {
			this.#writeHostUriResult(request, {
				type: "host_uri_result",
				id: request.id,
				isError: true,
				error: `Host URI scheme is not registered: ${request.url}`,
			});
			return;
		}
		const controller = new AbortController();
		this.#pendingHostUriRequests.set(request.id, { controller });
		const timeoutId = request.deadlineMs
			? this.#startTimeout(request.deadlineMs, () => {
					controller.abort();
				})
			: undefined;
		try {
			if (request.operation === "read") {
				if (!hostUri.read) throw new Error(`Host URI scheme is not readable: ${hostUri.scheme}`);
				const result = await hostUri.read(request.url, {
					id: request.id,
					operation: "read",
					url: request.url,
					signal: controller.signal,
					range: request.range,
				});
				if (!controller.signal.aborted) {
					this.#writeHostUriResult(request, normalizeHostUriReadResult(request.id, result));
				}
			} else {
				if (!hostUri.write) throw new Error(`Host URI scheme is not writable: ${hostUri.scheme}`);
				const result = await hostUri.write(request.url, request.content ?? "", {
					id: request.id,
					operation: "write",
					url: request.url,
					signal: controller.signal,
					range: request.range,
				});
				if (!controller.signal.aborted) {
					const frame = result
						? normalizeHostUriReadResult(request.id, result)
						: ({ type: "host_uri_result", id: request.id } satisfies RpcHostUriResult);
					this.#writeHostUriResult(request, frame);
				}
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				this.#writeHostUriResult(request, {
					type: "host_uri_result",
					id: request.id,
					isError: true,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
			this.#pendingHostUriRequests.delete(request.id);
		}
	}
	#writeFrame(
		frame:
			| RpcCommand
			| RpcExtensionUIResponse
			| RpcHostToolResult
			| RpcHostToolUpdate
			| RpcHostToolCancelAck
			| RpcHostUriResult
			| RpcHostUriCancelAck,
		onError?: (error: Error) => void,
	): void {
		if (!this.#process?.stdin) throw new Error("Client not started");
		const line = JSON.stringify(frame);
		if (Buffer.byteLength(line, "utf8") > RPC_LIMITS.maxOutboundFrameBytes) {
			const err = this.#errorFromInfo({
				code: "invalid_frame",
				message: "RPC outbound frame exceeded size limit",
			});
			if (onError) {
				onError(err);
				return;
			}
			throw err;
		}
		const stdin = this.#process.stdin as FileSink;
		stdin.write(`${line}\n`);
		const flushResult = stdin.flush();
		if (isPromise(flushResult)) flushResult.catch((err: Error) => onError?.(err));
	}

	#getOperationAck(response: RpcResponse, command: string): RpcOperationAck {
		const ack = this.#getData<RpcOperationAck>(response);
		if (!ack?.operationId) throw new Error(`RPC command ${command} did not return an operationId`);
		this.#markOperationRunning(ack.operationId);
		return ack;
	}

	#markOperationRunning(operationId: string): void {
		const existing = this.#operations.get(operationId);
		if (existing && existing.status !== "running") return;
		this.#operations.set(operationId, { status: "running" });
	}

	#getData<T>(response: RpcResponse): T {
		if (!response.success)
			throw this.#errorFromInfo(response.errorInfo ?? { code: "internal_error", message: response.error });
		return (response as Extract<RpcResponse, { success: true; data?: unknown }>).data as T;
	}

	#errorFromInfo(info: { message: string; code?: string }): Error {
		const err = new Error(info.message);
		Object.defineProperty(err, "code", { value: info.code, enumerable: true });
		return err;
	}

	#handleOperationTerminal(frame: RpcOperationEndFrame | RpcOperationErrorFrame): void {
		this.#operations.set(frame.operationId, frame);
		const waiters = this.#operationWaiters.get(frame.operationId) ?? [];
		this.#operationWaiters.delete(frame.operationId);
		for (const waiter of waiters) waiter.resolve(frame);
		this.#resolveIdleIfReady();
	}

	#activeOperationCount(): number {
		let count = 0;
		for (const operation of this.#operations.values()) {
			if (operation.status === "running") count++;
		}
		return count;
	}

	#resolveIdleIfReady(): void {
		if (this.#activeOperationCount() > 0) return;
		const waiters = this.#idleWaiters.splice(0);
		for (const waiter of waiters) {
			clearTimeout(waiter.timeoutId);
			waiter.resolve();
		}
	}

	#removeOperationWaiter(
		operationId: string,
		target: { resolve: (frame: RpcOperationEndFrame | RpcOperationErrorFrame) => void },
	): void {
		const waiters = this.#operationWaiters.get(operationId);
		if (!waiters) return;
		const next = waiters.filter(waiter => waiter.resolve !== target.resolve);
		if (next.length === 0) this.#operationWaiters.delete(operationId);
		else this.#operationWaiters.set(operationId, next);
	}

	#close(error: Error, kill: boolean): void {
		if (this.#closed && !this.#process) return;
		this.#closed = true;
		const proc = this.#process;
		this.#process = null;
		if (kill) proc?.kill();
		this.#abortController.abort();
		for (const pending of this.#pendingRequests.values()) pending.reject(error);
		this.#pendingRequests.clear();
		for (const waiters of this.#operationWaiters.values()) {
			for (const waiter of waiters) waiter.reject(error);
		}
		this.#operationWaiters.clear();
		for (const waiter of this.#idleWaiters.splice(0)) {
			clearTimeout(waiter.timeoutId);
			waiter.reject(error);
		}
		for (const pendingCall of this.#pendingHostToolCalls.values()) pendingCall.controller.abort();
		this.#pendingHostToolCalls.clear();
		for (const pendingUri of this.#pendingHostUriRequests.values()) pendingUri.controller.abort();
		this.#pendingHostUriRequests.clear();
	}

	#removeListener<T>(listeners: T[], listener: T): void {
		const index = listeners.indexOf(listener);
		if (index !== -1) listeners.splice(index, 1);
	}

	#toolDefinition(tool: RpcClientCustomTool): RpcHostToolDefinition {
		return {
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			hidden: tool.hidden,
			sideEffectClass: tool.sideEffectClass,
			trustClass: tool.trustClass,
			display: tool.display,
			inputSizeHintBytes: tool.inputSizeHintBytes,
			outputSizeHintBytes: tool.outputSizeHintBytes,
			defaultTimeoutMs: tool.defaultTimeoutMs,
			maxResultBytes: tool.maxResultBytes,
			maxUpdateBytes: tool.maxUpdateBytes,
		};
	}

	#hostUriDefinition(hostUri: RpcClientHostUri): RpcHostUriSchemeDefinition {
		return {
			scheme: hostUri.scheme,
			description: hostUri.description,
			writable: hostUri.writable ?? !!hostUri.write,
			immutable: hostUri.immutable,
			trustClass: hostUri.trustClass,
			defaultTimeoutMs: hostUri.defaultTimeoutMs,
			maxContentBytes: hostUri.maxContentBytes,
			contentTypes: hostUri.contentTypes,
			binary: hostUri.binary,
			range: hostUri.range,
		};
	}
}
