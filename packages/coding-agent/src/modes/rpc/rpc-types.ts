/**
 * RPC protocol types for headless operation.
 *
 * The wire protocol is NDJSON over stdio. Types in this file intentionally
 * describe protocol-only payloads so embedders can import them without pulling
 * the runtime server/client implementation into their program.
 */
import type { AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { BackgroundLane, BackgroundLaneCloseOutcome, BackgroundLaneListItem } from "../../background-lanes/state";
import type { SessionEntry, SessionTreeNode } from "../../session/session-manager";
import type { AgentProgress } from "../../task";
import type { TodoPhase } from "../../tools/todo-write";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ============================================================================
// Protocol identity and metadata
// ============================================================================

export const RPC_PROTOCOL_NAME = "omp-rpc";
export const RPC_PROTOCOL_VERSION = "1.1.0";
export const RPC_SCHEMA_VERSION = 1;

export type RpcMode = "rpc" | "rpc-ui";

export interface RpcProtocolIdentity {
	name: typeof RPC_PROTOCOL_NAME;
	version: typeof RPC_PROTOCOL_VERSION;
	schemaVersion: typeof RPC_SCHEMA_VERSION;
}

export interface RpcServerInfo {
	packageName: "@oh-my-pi/pi-coding-agent";
	packageVersion: string;
	pid: number;
}

export interface RpcCapabilities {
	commands: string[];
	events: string[];
	frameMetadata: true;
	operationEvents: true;
	typedErrors: true;
	stateChanges: true;
	sessionGraph: true;
	taskEvents: true;
	observableSessions: true;
	extensionUi: true;
	hostTools: true;
	hostUris: true;
	chunkedPayloads: boolean;
	oneShot: true;
	heartbeat: true;
	backgroundLanes: true;
}

export interface RpcLimits {
	maxFrameBytes: number;
	maxPartialLineBytes: number;
	maxOutboundFrameBytes: number;
	maxHostToolResultBytes: number;
	maxHostToolUpdateBytes: number;
	maxHostUriContentBytes: number;
	maxSessionEntryContentBytes: number;
	maxUiPayloadBytes: number;
	defaultOperationTimeoutMs: number | null;
	defaultHostToolTimeoutMs: number | null;
	defaultHostUriTimeoutMs: number | null;
	defaultExtensionUiTimeoutMs: number;
}

export interface RpcResetProfileSettingOverride {
	path: string;
	source: string;
	valueKind: "boolean" | "number" | "string" | "array" | "object" | "null";
}

export interface RpcResetProfile {
	name: string;
	ambientUserConfigApplied: boolean;
	settingOverrides: RpcResetProfileSettingOverride[];
}

export interface RpcSecurityProfile {
	enabledCommandCategories: string[];
	disabledTools: string[];
	hostToolPermissionMode: "host-owned" | "disabled";
	hostUriAllowedSchemes: string[];
	hostUriReservedSchemes: string[];
	bash: {
		enabled: boolean;
		cwd: string | null;
		rootPolicy: "session-cwd" | "unknown";
	};
	sessionMutation: boolean;
	loginProviders: string[];
	extensionsEnabled: boolean;
	redactionPolicy: string;
}

export interface RpcProtocolInfo {
	protocol: RpcProtocolIdentity;
	server: RpcServerInfo;
	mode: RpcMode;
	capabilities: RpcCapabilities;
	limits: RpcLimits;
	resetProfile: RpcResetProfile;
	security: RpcSecurityProfile;
}

export interface RpcFrameMetadata {
	seq: number;
	timestamp: string;
	sessionId: string | null;
}

export interface RpcCorrelation {
	requestId?: string;
	operationId?: string;
	turnId?: string;
	messageId?: string;
	toolCallId?: string;
	taskRunId?: string;
	subagentId?: string;
	hostRequestId?: string;
	uiRequestId?: string;
	stateSeq?: number;
}

export type RpcErrorCode =
	| "invalid_json"
	| "invalid_frame"
	| "invalid_command"
	| "unknown_command"
	| "invalid_arguments"
	| "unsupported_capability"
	| "operation_not_found"
	| "operation_cancelled"
	| "operation_timeout"
	| "peer_closed"
	| "host_tool_not_found"
	| "host_tool_timeout"
	| "host_tool_failed"
	| "host_tool_too_large"
	| "host_uri_scheme_not_found"
	| "host_uri_denied"
	| "host_uri_too_large"
	| "extension_ui_timeout"
	| "model_not_found"
	| "session_not_found"
	| "internal_error";

export interface RpcErrorInfo {
	code: RpcErrorCode;
	message: string;
	details?: JsonObject;
	retryable: boolean;
}

export interface RpcLargeContentRef {
	kind: "artifact";
	uri: string;
	bytes: number;
	preview: string;
}

// ============================================================================
export interface RpcBackgroundLaneContract {
	question: string;
	blocks_if: string;
	required_before_parent: boolean;
}

export type RpcBackgroundLaneCommand =
	| {
			id?: string;
			type: "background_lane";
			op: "spawn";
			from: { checkpoint_id?: string; source_ref: string };
			contract: RpcBackgroundLaneContract;
			assignment: string;
			agent?: string;
	  }
	| { id?: string; type: "background_lane"; op: "list" }
	| { id?: string; type: "background_lane"; op: "message"; lane_id: string; message: string }
	| { id?: string; type: "background_lane"; op: "snapshot"; lane_id: string }
	| {
			id?: string;
			type: "background_lane";
			op: "close";
			lane_id: string;
			outcome: BackgroundLaneCloseOutcome;
			reason: string;
			merged_source_ref?: string;
			operator_statement?: string;
	  };

export interface RpcBackgroundLaneUpdateSummary {
	id: string;
	question: string;
	status: BackgroundLane["status"];
	agentStatus: BackgroundLane["agent"]["status"];
	outcome: BackgroundLane["outcome"];
	requiredBeforeParent: boolean;
	blocksIfFired: boolean;
	latestReportRef?: string;
	latestPatchRef?: string;
	branch?: string;
	worktreePath?: string;
}

export interface RpcBackgroundLaneListResult {
	lanes: BackgroundLaneListItem[];
}

// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Protocol / transport
	| { id?: string; type: "get_protocol_info" }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "ping"; payload?: JsonValue }
	| { id?: string; type: "cancel_operation"; operationId: string }
	| { id?: string; type: "shutdown"; reason?: string }
	| { id?: string; type: "shutdown_after"; command: RpcCommand }

	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State / host extension registration
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "add_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "remove_host_tools"; toolNames: string[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "add_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "remove_host_uri_schemes"; schemes: string[] }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "handoff"; customInstructions?: string }
	| { id?: string; type: "get_messages" }
	| {
			id?: string;
			type: "get_session_entries";
			offset?: number;
			limit?: number;
			entryTypes?: string[];
			includeContent?: boolean;
	  }
	| { id?: string; type: "get_session_tree"; includeEntries?: boolean }
	| { id?: string; type: "get_observable_sessions" }

	// Login
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }
	| RpcBackgroundLaneCommand;

export type RpcCommandType = RpcCommand["type"];

// ============================================================================
// RPC State / sessions / operations
// ============================================================================

export type RpcOperationStatus =
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "rejected"
	| "superseded"
	| "peer_closed";

export interface RpcOperationSnapshot {
	operationId: string;
	command: string;
	requestId?: string;
	turnId?: string;
	status: RpcOperationStatus;
	startedAt: string;
	endedAt?: string;
	cancelRequestedAt?: string;
	errorInfo?: RpcErrorInfo;
}

export interface RpcSessionState {
	stateSeq: number;
	protocol: RpcProtocolIdentity;
	capabilities: RpcCapabilities;
	limits: RpcLimits;
	resetProfile: RpcResetProfile;
	security: RpcSecurityProfile;
	activeOperations: RpcOperationSnapshot[];
	model: Model | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile: string | undefined;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	autoRetryEnabled: boolean;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	systemPrompt?: string | string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown }>;
	contextUsage?: unknown;
	hostTools: RpcHostToolDefinition[];
	hostUriSchemes: RpcHostUriSchemeDefinition[];
	backgroundLanes: BackgroundLaneListItem[];
}

export interface RpcHandoffResult {
	savedPath?: string;
}

export interface RpcOperationAck {
	ack: "accepted";
	operationId: string;
	turnId?: string;
	queued: boolean;
}

export interface RpcSessionEntryView {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
	label?: string;
	preview?: string;
	entry?: SessionEntry;
	contentRef?: RpcLargeContentRef;
}

export interface RpcSessionTreeNodeView {
	id: string;
	parentId: string | null;
	type: string;
	label?: string;
	timestamp: string;
	children: RpcSessionTreeNodeView[];
	entry?: RpcSessionEntryView;
}

export interface RpcObservableSessionView {
	id: string;
	parentId?: string;
	sessionFile?: string;
	label?: string;
	status: string;
	agentType?: string;
	summary?: string;
	startedAt?: string;
	updatedAt?: string;
}

// ============================================================================
// RPC Responses and stdout frames
// ============================================================================

export type RpcResponse =
	| (Partial<RpcFrameMetadata> & {
			id?: string;
			type: "response";
			command: string;
			success: true;
			data?: unknown;
	  })
	| (Partial<RpcFrameMetadata> & {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			errorInfo: RpcErrorInfo;
	  });

export type RpcReadyFrame = RpcFrameMetadata & { type: "ready" } & RpcProtocolInfo;

export type RpcProtocolErrorFrame = RpcFrameMetadata &
	RpcCorrelation & {
		type: "protocol_error";
		error: string;
		errorInfo: RpcErrorInfo;
	};

export type RpcTransportWarningFrame = RpcFrameMetadata &
	RpcCorrelation & {
		type: "transport_warning";
		warning: string;
		details?: JsonObject;
	};

export type RpcOperationStartFrame = RpcFrameMetadata &
	RpcCorrelation & {
		type: "operation_start";
		operationId: string;
		command: string;
		requestId?: string;
		turnId?: string;
		startedAt: string;
	};

export type RpcOperationEndFrame = RpcFrameMetadata &
	RpcCorrelation & {
		type: "operation_end";
		operationId: string;
		command: string;
		status: Exclude<RpcOperationStatus, "running" | "failed" | "rejected">;
		requestId?: string;
		turnId?: string;
		startedAt: string;
		endedAt: string;
		data?: unknown;
	};

export type RpcOperationErrorFrame = RpcFrameMetadata &
	RpcCorrelation & {
		type: "operation_error";
		operationId: string;
		command: string;
		status: "failed" | "cancelled" | "rejected" | "peer_closed";
		requestId?: string;
		turnId?: string;
		startedAt: string;
		endedAt: string;
		error: string;
		errorInfo: RpcErrorInfo;
	};

export type RpcStateChangedFrame = RpcFrameMetadata & {
	type: "state_changed";
	stateSeq: number;
	changed: string[];
	state: RpcSessionState;
};

export type RpcTaskProgressFrame = RpcFrameMetadata &
	RpcCorrelation & {
		type: "task_progress";
		schemaVersion: 1;
		taskRunId: string;
		toolCallId?: string;
		subagentId?: string;
		parentTaskRunId?: string;
		agents: RpcTaskAgentProgress[];
	};

export interface RpcTaskAgentProgress {
	id: string;
	parentId: string | null;
	index: number;
	agentType: string;
	description?: string;
	status: AgentProgress["status"];
	currentTool?: string;
	preview?: string;
	tokens: number;
	contextTokens?: number;
	contextWindow?: number;
	outputRef?: RpcLargeContentRef;
}

export type RpcTaskResultFrame = RpcFrameMetadata &
	RpcCorrelation & {
		type: "task_result";
		schemaVersion: 1;
		taskRunId: string;
		toolCallId?: string;
		subagentId?: string;
		parentTaskRunId?: string;
		results: RpcTaskResult[];
	};

export interface RpcTaskResult {
	id: string;
	parentId: string | null;
	index: number;
	agentType: string;
	status: "completed" | "failed" | "aborted";
	summary: string;
	truncated: boolean;
	outputRef?: RpcLargeContentRef;
}

export type RpcSubagentLifecycleFrame = RpcFrameMetadata &
	RpcCorrelation & {
		type: "subagent_lifecycle";
		schemaVersion: 1;
		subagentId: string;
		parentSubagentId: string | null;
		toolCallId?: string;
		taskRunId?: string;
		parentTaskRunId?: string;
		status: "started" | "completed" | "failed" | "aborted";
		agentType: string;
		description?: string;
		sessionFile?: string;
		index: number;
	};

export type RpcObservableSessionUpdateFrame = RpcFrameMetadata & {
	type: "observable_session_update";
	schemaVersion: 1;
	sessions: RpcObservableSessionView[];
};

export type RpcBackgroundLaneUpdateFrame = RpcFrameMetadata & {
	type: "background_lane_update";
	schemaVersion: 1;
	laneId: string;
	status: BackgroundLane["status"];
	blocksIfFired: boolean;
	summary: RpcBackgroundLaneUpdateSummary;
};

export type RpcHeartbeatFrame = RpcFrameMetadata & { type: "heartbeat" };
export type RpcPongFrame = RpcFrameMetadata & { type: "pong"; payload?: JsonValue };
export type RpcShutdownFrame = RpcFrameMetadata & {
	type: "shutdown";
	reason: string;
	status: "graceful" | "peer_closed" | "one_shot_complete";
};

// ============================================================================
// Extension UI Events (stdout) and responses (stdin)
// ============================================================================

export type RpcExtensionUIResponseSchema =
	| { kind: "string"; nullable?: boolean }
	| { kind: "boolean" }
	| { kind: "cancel" }
	| { kind: "none" };

export type RpcExtensionUIRequest =
	| {
			type: "extension_ui_request";
			id: string;
			method: "select";
			expectsResponse: true;
			responseSchema: RpcExtensionUIResponseSchema;
			title: string;
			options: string[];
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "confirm";
			expectsResponse: true;
			responseSchema: RpcExtensionUIResponseSchema;
			title: string;
			message: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			expectsResponse: true;
			responseSchema: RpcExtensionUIResponseSchema;
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			expectsResponse: true;
			responseSchema: RpcExtensionUIResponseSchema;
			title: string;
			prefill?: string;
			promptStyle?: boolean;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; expectsResponse: false; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			expectsResponse: false;
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			expectsResponse: false;
			statusKey: string;
			statusText?: string;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			expectsResponse: false;
			widgetKey: string;
			widgetLines?: string[];
			widgetPlacement?: "header" | "footer" | "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; expectsResponse: false; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; expectsResponse: false; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			expectsResponse: false;
			url: string;
			instructions?: string;
	  };

export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

export type RpcExtensionErrorFrame = RpcFrameMetadata & {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
	errorInfo?: RpcErrorInfo;
};

// ============================================================================
// Host Tool Frames (bidirectional)
// ============================================================================

export type RpcSideEffectClass = "none" | "read" | "write" | "network" | "process" | "unknown";
export type RpcTrustClass = "host" | "workspace" | "user-approved" | "untrusted";

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	sideEffectClass?: RpcSideEffectClass;
	trustClass?: RpcTrustClass;
	display?: { title?: string; description?: string; icon?: string };
	inputSizeHintBytes?: number;
	outputSizeHintBytes?: number;
	defaultTimeoutMs?: number | null;
	maxResultBytes?: number;
	maxUpdateBytes?: number;
}

export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
	metadata?: Pick<
		RpcHostToolDefinition,
		"sideEffectClass" | "trustClass" | "display" | "inputSizeHintBytes" | "outputSizeHintBytes"
	>;
	deadlineMs?: number;
	maxResultBytes: number;
	maxUpdateBytes: number;
}

export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
	expectsAck?: boolean;
	errorInfo?: RpcErrorInfo;
}

export interface RpcHostToolCancelAck {
	type: "host_tool_cancel_ack";
	id: string;
	targetId: string;
	accepted: boolean;
	errorInfo?: RpcErrorInfo;
}

export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
	errorInfo?: RpcErrorInfo;
	contentRef?: RpcLargeContentRef;
}

// ============================================================================
// Host URI Frames (bidirectional)
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	scheme: string;
	description?: string;
	writable?: boolean;
	immutable?: boolean;
	trustClass?: RpcTrustClass;
	defaultTimeoutMs?: number | null;
	maxContentBytes?: number;
	contentTypes?: string[];
	binary?: boolean;
	range?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

export interface RpcHostUriRange {
	start: number;
	end?: number;
	unit?: "line" | "byte";
}

export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	content?: string;
	contentLength?: number;
	contentType?: string;
	deadlineMs?: number;
	maxContentBytes: number;
	range?: RpcHostUriRange;
	acceptsBase64?: boolean;
}

export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
	expectsAck?: boolean;
	errorInfo?: RpcErrorInfo;
}

export interface RpcHostUriCancelAck {
	type: "host_uri_cancel_ack";
	id: string;
	targetId: string;
	accepted: boolean;
	errorInfo?: RpcErrorInfo;
}

export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	content?: string;
	bytesBase64?: string;
	contentType?: "text/markdown" | "application/json" | "text/plain" | string;
	contentLength?: number;
	contentRef?: RpcLargeContentRef;
	notes?: string[];
	immutable?: boolean;
	isError?: boolean;
	error?: string;
	errorInfo?: RpcErrorInfo;
}

export type RpcExtensionUIRequestFrame = RpcFrameMetadata & RpcExtensionUIRequest;
export type RpcHostToolCallRequestFrame = RpcFrameMetadata & RpcHostToolCallRequest;
export type RpcHostToolCancelRequestFrame = RpcFrameMetadata & RpcHostToolCancelRequest;
export type RpcHostUriRequestFrame = RpcFrameMetadata & RpcHostUriRequest;
export type RpcHostUriCancelRequestFrame = RpcFrameMetadata & RpcHostUriCancelRequest;

export type RpcNotificationFrame =
	| RpcReadyFrame
	| RpcProtocolErrorFrame
	| RpcTransportWarningFrame
	| RpcOperationStartFrame
	| RpcOperationEndFrame
	| RpcOperationErrorFrame
	| RpcStateChangedFrame
	| RpcTaskProgressFrame
	| RpcTaskResultFrame
	| RpcSubagentLifecycleFrame
	| RpcObservableSessionUpdateFrame
	| RpcHeartbeatFrame
	| RpcBackgroundLaneUpdateFrame
	| RpcPongFrame
	| RpcShutdownFrame
	| RpcExtensionUIRequestFrame
	| RpcExtensionErrorFrame
	| RpcHostToolCallRequestFrame
	| RpcHostToolCancelRequestFrame
	| RpcHostUriRequestFrame
	| RpcHostUriCancelRequestFrame;

export type RpcFrame = RpcResponse | RpcNotificationFrame;

export function isRpcResponseFrame(value: unknown): value is RpcResponse {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; command?: unknown; success?: unknown; error?: unknown; id?: unknown };
	if (frame.type !== "response") return false;
	if (typeof frame.command !== "string") return false;
	if (typeof frame.success !== "boolean") return false;
	if (frame.id !== undefined && typeof frame.id !== "string") return false;
	return frame.success || typeof frame.error === "string";
}

export function isRpcOperationTerminalFrame(value: unknown): value is RpcOperationEndFrame | RpcOperationErrorFrame {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; operationId?: unknown };
	return (frame.type === "operation_end" || frame.type === "operation_error") && typeof frame.operationId === "string";
}

export function flattenSessionTreeNodes(nodes: SessionTreeNode[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	const stack = [...nodes].reverse();
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		entries.push(node.entry);
		for (let index = node.children.length - 1; index >= 0; index--) {
			stack.push(node.children[index]);
		}
	}
	return entries;
}
