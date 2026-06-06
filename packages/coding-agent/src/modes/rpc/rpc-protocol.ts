import { getOAuthProviders } from "@oh-my-pi/pi-ai/utils/oauth";
import { VERSION } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { RpcHostToolBridge } from "./host-tools";
import type { RpcHostUriBridge } from "./host-uris";
import {
	type JsonObject,
	RPC_PROTOCOL_NAME,
	RPC_PROTOCOL_VERSION,
	RPC_SCHEMA_VERSION,
	type RpcCapabilities,
	type RpcErrorCode,
	type RpcErrorInfo,
	type RpcFrameMetadata,
	type RpcLimits,
	type RpcMode,
	type RpcProtocolInfo,
	type RpcResetProfile,
	type RpcSecurityProfile,
} from "./rpc-types";

export const RESERVED_HOST_URI_SCHEMES = Object.freeze([
	"omp",
	"agent",
	"artifact",
	"memory",
	"local",
	"vault",
	"skill",
	"rule",
	"mcp",
	"issue",
	"pr",
] as const);

const RPC_MAX_FRAME_BYTES = 1_048_576;
const RPC_MAX_INLINE_PAYLOAD_BYTES = RPC_MAX_FRAME_BYTES - 16_384;

export const RPC_LIMITS: RpcLimits = Object.freeze({
	maxFrameBytes: RPC_MAX_FRAME_BYTES,
	maxPartialLineBytes: RPC_MAX_FRAME_BYTES,
	maxOutboundFrameBytes: RPC_MAX_FRAME_BYTES,
	maxHostToolResultBytes: RPC_MAX_INLINE_PAYLOAD_BYTES,
	maxHostToolUpdateBytes: 262_144,
	maxHostUriContentBytes: RPC_MAX_INLINE_PAYLOAD_BYTES,
	maxSessionEntryContentBytes: 262_144,
	maxUiPayloadBytes: 262_144,
	defaultOperationTimeoutMs: null,
	defaultHostToolTimeoutMs: null,
	defaultHostUriTimeoutMs: null,
	defaultExtensionUiTimeoutMs: 30_000,
});

const RPC_COMMANDS = Object.freeze([
	"get_protocol_info",
	"get_state",
	"ping",
	"cancel_operation",
	"shutdown",
	"shutdown_after",
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"abort_and_prompt",
	"new_session",
	"set_todos",
	"set_host_tools",
	"add_host_tools",
	"remove_host_tools",
	"set_host_uri_schemes",
	"add_host_uri_schemes",
	"remove_host_uri_schemes",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_interrupt_mode",
	"compact",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"switch_session",
	"branch",
	"get_branch_messages",
	"get_last_assistant_text",
	"set_session_name",
	"handoff",
	"get_messages",
	"get_session_entries",
	"get_session_tree",
	"get_observable_sessions",
	"get_login_providers",
	"login",
] as const);

const RPC_EVENTS = Object.freeze([
	"protocol_error",
	"transport_warning",
	"operation_start",
	"operation_end",
	"operation_error",
	"state_changed",
	"task_progress",
	"task_result",
	"subagent_lifecycle",
	"observable_session_update",
	"extension_ui_request",
	"extension_error",
	"host_tool_call",
	"host_tool_cancel",
	"host_uri_request",
	"host_uri_cancel",
	"pong",
	"shutdown",
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"goal_updated",
] as const);

export const RPC_CAPABILITIES: RpcCapabilities = Object.freeze({
	commands: [...RPC_COMMANDS],
	events: [...RPC_EVENTS],
	frameMetadata: true,
	operationEvents: true,
	typedErrors: true,
	stateChanges: true,
	sessionGraph: true,
	taskEvents: true,
	observableSessions: true,
	extensionUi: true,
	hostTools: true,
	hostUris: true,
	chunkedPayloads: false,
	oneShot: true,
	heartbeat: true,
});

export const RPC_RESET_PROFILE: RpcResetProfile = {
	name: "rpc-defaults",
	ambientUserConfigApplied: true,
	settingOverrides: [
		{ path: "todo.enabled", source: "rpc-default", valueKind: "boolean" },
		{ path: "task.maxConcurrency", source: "rpc-default", valueKind: "number" },
	],
};

export class RpcProtocolError extends Error {
	readonly errorInfo: RpcErrorInfo;

	constructor(code: RpcErrorCode, message: string, details?: JsonObject, retryable = false) {
		super(message);
		this.name = "RpcProtocolError";
		this.errorInfo = { code, message, details, retryable };
	}
}

export function rpcErrorInfo(
	code: RpcErrorCode,
	message: string,
	details?: JsonObject,
	retryable = false,
): RpcErrorInfo {
	return { code, message, details, retryable };
}

export function errorInfoFromUnknown(error: unknown, fallbackCode: RpcErrorCode = "internal_error"): RpcErrorInfo {
	if (error instanceof RpcProtocolError) return error.errorInfo;
	if (error && typeof error === "object" && "errorInfo" in error) {
		const info = (error as { errorInfo?: unknown }).errorInfo;
		if (isRpcErrorInfo(info)) return info;
	}
	const message = error instanceof Error ? error.message : String(error);
	return rpcErrorInfo(fallbackCode, message || "Internal RPC error", undefined, false);
}

export function isRpcErrorInfo(value: unknown): value is RpcErrorInfo {
	if (!value || typeof value !== "object") return false;
	const info = value as { code?: unknown; message?: unknown; retryable?: unknown };
	return typeof info.code === "string" && typeof info.message === "string";
}

export function isReservedHostUriScheme(scheme: string): boolean {
	return RESERVED_HOST_URI_SCHEMES.includes(scheme.toLowerCase() as (typeof RESERVED_HOST_URI_SCHEMES)[number]);
}

export function buildRpcSecurityProfile(
	session: AgentSession,
	hostToolBridge?: RpcHostToolBridge,
	hostUriBridge?: RpcHostUriBridge,
): RpcSecurityProfile {
	const cwd = session.sessionManager.getCwd?.() ?? null;
	return {
		enabledCommandCategories: [
			"protocol",
			"prompting",
			"state",
			"model",
			"thinking",
			"queue",
			"compaction",
			"retry",
			"bash",
			"session",
			"messages",
			"login",
		],
		disabledTools: [],
		hostToolPermissionMode: hostToolBridge ? "host-owned" : "disabled",
		hostUriAllowedSchemes: hostUriBridge?.getSchemes() ?? [],
		hostUriReservedSchemes: [...RESERVED_HOST_URI_SCHEMES],
		bash: {
			enabled: true,
			cwd,
			rootPolicy: cwd ? "session-cwd" : "unknown",
		},
		sessionMutation: true,
		loginProviders: getOAuthProviders()
			.filter(provider => provider.available)
			.map(provider => provider.id),
		extensionsEnabled: true,
		redactionPolicy: "host-owned local stdio; paths are not redacted in protocol frames",
	};
}

export function buildRpcProtocolInfo(
	mode: RpcMode,
	session: AgentSession,
	hostToolBridge?: RpcHostToolBridge,
	hostUriBridge?: RpcHostUriBridge,
): RpcProtocolInfo {
	return {
		protocol: {
			name: RPC_PROTOCOL_NAME,
			version: RPC_PROTOCOL_VERSION,
			schemaVersion: RPC_SCHEMA_VERSION,
		},
		server: {
			packageName: "@oh-my-pi/pi-coding-agent",
			packageVersion: VERSION,
			pid: process.pid,
		},
		mode,
		capabilities: RPC_CAPABILITIES,
		limits: RPC_LIMITS,
		resetProfile: RPC_RESET_PROFILE,
		security: buildRpcSecurityProfile(session, hostToolBridge, hostUriBridge),
	};
}

export class RpcFrameWriter {
	#seq = 0;
	#pending: Promise<void> = Promise.resolve();
	#getSessionId: () => string | null;

	constructor(getSessionId: () => string | null) {
		this.#getSessionId = getSessionId;
	}

	get lastSeq(): number {
		return this.#seq;
	}

	write<T extends object>(frame: T): Promise<T & RpcFrameMetadata> {
		const enriched = {
			...frame,
			seq: ++this.#seq,
			timestamp: new Date().toISOString(),
			sessionId: this.#getSessionId(),
		} as T & RpcFrameMetadata;
		this.#pending = this.#pending.then(() => this.#writeSerialized(enriched));
		return this.#pending.then(() => enriched);
	}

	async drain(): Promise<void> {
		await this.#pending;
	}

	#writeSerialized(frame: object): Promise<void> {
		let line = `${JSON.stringify(frame)}\n`;
		if (Buffer.byteLength(line, "utf8") > RPC_LIMITS.maxOutboundFrameBytes) {
			const original = frame as {
				type?: unknown;
				seq?: unknown;
				timestamp?: unknown;
				sessionId?: unknown;
				id?: unknown;
				command?: unknown;
				requestId?: unknown;
				turnId?: unknown;
				operationId?: unknown;
				startedAt?: unknown;
				endedAt?: unknown;
			};
			const errorInfo = rpcErrorInfo(
				"invalid_frame",
				"RPC frame exceeded outbound size limit",
				{
					frameType: typeof original.type === "string" ? original.type : "unknown",
					limitBytes: RPC_LIMITS.maxOutboundFrameBytes,
				},
				false,
			);
			if (original.type === "response" && typeof original.id === "string") {
				line = `${JSON.stringify({
					id: original.id,
					type: "response",
					command: typeof original.command === "string" ? original.command : "unknown",
					success: false,
					error: errorInfo.message,
					errorInfo,
					seq: original.seq,
					timestamp: original.timestamp,
					sessionId: original.sessionId,
				})}\n`;
			} else if (
				(original.type === "operation_end" || original.type === "operation_error") &&
				typeof original.operationId === "string"
			) {
				line = `${JSON.stringify({
					type: "operation_error",
					seq: original.seq,
					timestamp: original.timestamp,
					sessionId: original.sessionId,
					operationId: original.operationId,
					command: typeof original.command === "string" ? original.command : "unknown",
					status: "failed",
					requestId: typeof original.requestId === "string" ? original.requestId : undefined,
					turnId: typeof original.turnId === "string" ? original.turnId : undefined,
					startedAt: typeof original.startedAt === "string" ? original.startedAt : original.timestamp,
					endedAt: typeof original.endedAt === "string" ? original.endedAt : original.timestamp,
					error: errorInfo.message,
					errorInfo,
				})}\n`;
			} else {
				line = `${JSON.stringify({
					type: "protocol_error",
					seq: original.seq,
					timestamp: original.timestamp,
					sessionId: original.sessionId,
					requestId:
						typeof original.requestId === "string"
							? original.requestId
							: typeof original.id === "string"
								? original.id
								: undefined,
					operationId: typeof original.operationId === "string" ? original.operationId : undefined,
					error: errorInfo.message,
					errorInfo,
				})}\n`;
			}
		}

		const { promise, resolve } = Promise.withResolvers<void>();
		const accepted = process.stdout.write(line);
		if (accepted) {
			resolve();
		} else {
			process.stdout.once("drain", resolve);
		}
		return promise;
	}
}
