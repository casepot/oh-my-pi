import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { RPC_LIMITS, rpcErrorInfo } from "./rpc-protocol";
import type {
	RpcCommand,
	RpcErrorInfo,
	RpcExtensionUIResponse,
	RpcHostToolCancelAck,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelAck,
	RpcHostUriResult,
} from "./rpc-types";

type RpcInboundFrame =
	| RpcCommand
	| RpcExtensionUIResponse
	| RpcHostToolCancelAck
	| RpcHostToolResult
	| RpcHostToolUpdate
	| RpcHostUriCancelAck
	| RpcHostUriResult;

export type RpcParsedInput =
	| { ok: true; frame: RpcInboundFrame; requestId?: string }
	| { ok: false; requestId?: string; command?: string; errorInfo: RpcErrorInfo };

const KNOWN_COMMANDS: Record<string, true> = {
	get_protocol_info: true,
	get_state: true,
	ping: true,
	cancel_operation: true,
	shutdown: true,
	shutdown_after: true,
	prompt: true,
	steer: true,
	follow_up: true,
	abort: true,
	abort_and_prompt: true,
	new_session: true,
	set_todos: true,
	set_host_tools: true,
	add_host_tools: true,
	remove_host_tools: true,
	set_host_uri_schemes: true,
	add_host_uri_schemes: true,
	remove_host_uri_schemes: true,
	set_model: true,
	cycle_model: true,
	get_available_models: true,
	set_thinking_level: true,
	cycle_thinking_level: true,
	set_steering_mode: true,
	set_follow_up_mode: true,
	set_interrupt_mode: true,
	compact: true,
	set_auto_compaction: true,
	set_auto_retry: true,
	abort_retry: true,
	bash: true,
	abort_bash: true,
	get_session_stats: true,
	export_html: true,
	switch_session: true,
	branch: true,
	get_branch_messages: true,
	get_last_assistant_text: true,
	set_session_name: true,
	handoff: true,
	get_messages: true,
	get_session_entries: true,
	get_session_tree: true,
	get_observable_sessions: true,
	get_login_providers: true,
	login: true,
};

const HOST_OR_UI_FRAMES: Record<string, true> = {
	extension_ui_response: true,
	host_tool_result: true,
	host_tool_update: true,
	host_uri_result: true,
	host_tool_cancel_ack: true,
	host_uri_cancel_ack: true,
};

const STREAMING_BEHAVIORS = new Set(["steer", "followUp"]);
const THINKING_LEVELS = new Set<string>([
	ThinkingLevel.Inherit,
	ThinkingLevel.Off,
	ThinkingLevel.Minimal,
	ThinkingLevel.Low,
	ThinkingLevel.Medium,
	ThinkingLevel.High,
	ThinkingLevel.XHigh,
]);
const SERIAL_QUEUE_MODES = new Set(["all", "one-at-a-time"]);
const INTERRUPT_MODES = new Set(["immediate", "wait"]);

function enumProp(frame: Record<string, unknown>, key: string, type: string, allowed: Set<string>): string | undefined {
	const value = frame[key];
	if (value === undefined) return `${type}.${key} is required`;
	if (typeof value !== "string") return `${type}.${key} must be a string`;
	return allowed.has(value) ? undefined : `${type}.${key} has unsupported value: ${value}`;
}

function optionalEnumProp(
	frame: Record<string, unknown>,
	key: string,
	type: string,
	allowed: Set<string>,
): string | undefined {
	const value = frame[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") return `${type}.${key} must be a string`;
	return allowed.has(value) ? undefined : `${type}.${key} has unsupported value: ${value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function requestIdOf(value: Record<string, unknown>): string | undefined {
	return typeof value.id === "string" ? value.id : undefined;
}

function stringProp(frame: Record<string, unknown>, key: string, type: string): string | undefined {
	return typeof frame[key] === "string" ? undefined : `${type}.${key} must be a string`;
}

function booleanProp(frame: Record<string, unknown>, key: string, type: string): string | undefined {
	return typeof frame[key] === "boolean" ? undefined : `${type}.${key} must be a boolean`;
}

function arrayProp(frame: Record<string, unknown>, key: string, type: string): string | undefined {
	return Array.isArray(frame[key]) ? undefined : `${type}.${key} must be an array`;
}
function optionalStringProp(frame: Record<string, unknown>, key: string, type: string): string | undefined {
	const value = frame[key];
	return value === undefined || typeof value === "string" ? undefined : `${type}.${key} must be a string`;
}

function optionalBooleanProp(frame: Record<string, unknown>, key: string, type: string): string | undefined {
	const value = frame[key];
	return value === undefined || typeof value === "boolean" ? undefined : `${type}.${key} must be a boolean`;
}

function objectProp(frame: Record<string, unknown>, key: string, type: string): string | undefined {
	return isRecord(frame[key]) ? undefined : `${type}.${key} must be an object`;
}

function optionalObjectProp(frame: Record<string, unknown>, key: string, type: string): string | undefined {
	const value = frame[key];
	return value === undefined || isRecord(value) ? undefined : `${type}.${key} must be an object`;
}

function integerProp(frame: Record<string, unknown>, key: string, type: string): string | undefined {
	const value = frame[key];
	return Number.isSafeInteger(value) ? undefined : `${type}.${key} must be an integer`;
}

function validateHostOrUiFrameShape(frame: Record<string, unknown>): RpcErrorInfo | undefined {
	const type = frame.type as string;
	const idError = stringProp(frame, "id", type);
	if (idError) return rpcErrorInfo("invalid_frame", idError);
	switch (type) {
		case "extension_ui_response": {
			if (frame.value !== undefined)
				return stringProp(frame, "value", type)
					? rpcErrorInfo("invalid_frame", stringProp(frame, "value", type)!)
					: undefined;
			if (frame.confirmed !== undefined)
				return booleanProp(frame, "confirmed", type)
					? rpcErrorInfo("invalid_frame", booleanProp(frame, "confirmed", type)!)
					: undefined;
			if (frame.cancelled !== undefined) {
				const cancelledError = booleanProp(frame, "cancelled", type);
				if (cancelledError) return rpcErrorInfo("invalid_frame", cancelledError);
				const timedOutError = optionalBooleanProp(frame, "timedOut", type);
				return timedOutError ? rpcErrorInfo("invalid_frame", timedOutError) : undefined;
			}
			return rpcErrorInfo("invalid_frame", "extension_ui_response must include value, confirmed, or cancelled");
		}
		case "host_tool_result": {
			const resultError = objectProp(frame, "result", type);
			if (resultError) return rpcErrorInfo("invalid_frame", resultError);
			const isErrorError = optionalBooleanProp(frame, "isError", type);
			if (isErrorError) return rpcErrorInfo("invalid_frame", isErrorError);
			const errorInfoError = optionalObjectProp(frame, "errorInfo", type);
			return errorInfoError ? rpcErrorInfo("invalid_frame", errorInfoError) : undefined;
		}
		case "host_tool_update": {
			const partialError = objectProp(frame, "partialResult", type);
			return partialError ? rpcErrorInfo("invalid_frame", partialError) : undefined;
		}
		case "host_tool_cancel_ack":
		case "host_uri_cancel_ack": {
			const targetError = stringProp(frame, "targetId", type);
			if (targetError) return rpcErrorInfo("invalid_frame", targetError);
			const acceptedError = booleanProp(frame, "accepted", type);
			if (acceptedError) return rpcErrorInfo("invalid_frame", acceptedError);
			const errorInfoError = optionalObjectProp(frame, "errorInfo", type);
			return errorInfoError ? rpcErrorInfo("invalid_frame", errorInfoError) : undefined;
		}
		case "host_uri_result": {
			const contentError = optionalStringProp(frame, "content", type);
			if (contentError) return rpcErrorInfo("invalid_frame", contentError);
			const bytesError = optionalStringProp(frame, "bytesBase64", type);
			if (bytesError) return rpcErrorInfo("invalid_frame", bytesError);
			if (frame.contentLength !== undefined) {
				const lengthError = integerProp(frame, "contentLength", type);
				if (lengthError) return rpcErrorInfo("invalid_frame", lengthError);
			}
			const isErrorError = optionalBooleanProp(frame, "isError", type);
			if (isErrorError) return rpcErrorInfo("invalid_frame", isErrorError);
			const errorTextError = optionalStringProp(frame, "error", type);
			if (errorTextError) return rpcErrorInfo("invalid_frame", errorTextError);
			const errorInfoError = optionalObjectProp(frame, "errorInfo", type);
			return errorInfoError ? rpcErrorInfo("invalid_frame", errorInfoError) : undefined;
		}
		default:
			return undefined;
	}
}

function validateCommandShape(frame: Record<string, unknown>): RpcErrorInfo | undefined {
	const type = frame.type as string;
	switch (type) {
		case "prompt":
		case "steer":
		case "follow_up":
		case "abort_and_prompt": {
			const messageError = stringProp(frame, "message", type);
			if (messageError) return rpcErrorInfo("invalid_arguments", messageError);
			const streamingError = optionalEnumProp(frame, "streamingBehavior", type, STREAMING_BEHAVIORS);
			return streamingError ? rpcErrorInfo("invalid_arguments", streamingError) : undefined;
		}
		case "cancel_operation":
			return stringProp(frame, "operationId", type)
				? rpcErrorInfo("invalid_arguments", stringProp(frame, "operationId", type)!)
				: undefined;
		case "set_todos":
			return arrayProp(frame, "phases", type)
				? rpcErrorInfo("invalid_arguments", arrayProp(frame, "phases", type)!)
				: undefined;
		case "set_host_tools":
		case "add_host_tools":
			return arrayProp(frame, "tools", type)
				? rpcErrorInfo("invalid_arguments", arrayProp(frame, "tools", type)!)
				: undefined;
		case "remove_host_tools":
			return arrayProp(frame, "toolNames", type)
				? rpcErrorInfo("invalid_arguments", arrayProp(frame, "toolNames", type)!)
				: undefined;
		case "set_host_uri_schemes":
		case "add_host_uri_schemes":
			return arrayProp(frame, "schemes", type)
				? rpcErrorInfo("invalid_arguments", arrayProp(frame, "schemes", type)!)
				: undefined;
		case "remove_host_uri_schemes":
			return arrayProp(frame, "schemes", type)
				? rpcErrorInfo("invalid_arguments", arrayProp(frame, "schemes", type)!)
				: undefined;
		case "set_model": {
			const providerError = stringProp(frame, "provider", type);
			if (providerError) return rpcErrorInfo("invalid_arguments", providerError);
			const modelError = stringProp(frame, "modelId", type);
			return modelError ? rpcErrorInfo("invalid_arguments", modelError) : undefined;
		}
		case "set_thinking_level": {
			const enumError = enumProp(frame, "level", type, THINKING_LEVELS);
			return enumError ? rpcErrorInfo("invalid_arguments", enumError) : undefined;
		}
		case "set_steering_mode":
		case "set_follow_up_mode": {
			const enumError = enumProp(frame, "mode", type, SERIAL_QUEUE_MODES);
			return enumError ? rpcErrorInfo("invalid_arguments", enumError) : undefined;
		}
		case "set_interrupt_mode": {
			const enumError = enumProp(frame, "mode", type, INTERRUPT_MODES);
			return enumError ? rpcErrorInfo("invalid_arguments", enumError) : undefined;
		}
		case "set_auto_compaction":
		case "set_auto_retry":
			return booleanProp(frame, "enabled", type)
				? rpcErrorInfo("invalid_arguments", booleanProp(frame, "enabled", type)!)
				: undefined;
		case "bash":
			return stringProp(frame, "command", type)
				? rpcErrorInfo("invalid_arguments", stringProp(frame, "command", type)!)
				: undefined;
		case "switch_session":
			return stringProp(frame, "sessionPath", type)
				? rpcErrorInfo("invalid_arguments", stringProp(frame, "sessionPath", type)!)
				: undefined;
		case "branch":
			return stringProp(frame, "entryId", type)
				? rpcErrorInfo("invalid_arguments", stringProp(frame, "entryId", type)!)
				: undefined;
		case "set_session_name":
			return stringProp(frame, "name", type)
				? rpcErrorInfo("invalid_arguments", stringProp(frame, "name", type)!)
				: undefined;
		case "login":
			return stringProp(frame, "providerId", type)
				? rpcErrorInfo("invalid_arguments", stringProp(frame, "providerId", type)!)
				: undefined;
		case "shutdown_after":
			return isRecord(frame.command)
				? undefined
				: rpcErrorInfo("invalid_arguments", "shutdown_after.command must be a command object");
		default:
			return undefined;
	}
}

export function validateRpcInputFrame(value: unknown): RpcParsedInput {
	if (!isRecord(value)) {
		return { ok: false, errorInfo: rpcErrorInfo("invalid_frame", "RPC frame must be a JSON object") };
	}
	const requestId = requestIdOf(value);
	if (typeof value.type !== "string") {
		return { ok: false, requestId, errorInfo: rpcErrorInfo("invalid_frame", "RPC frame type must be a string") };
	}
	if (HOST_OR_UI_FRAMES[value.type]) {
		const shapeError = validateHostOrUiFrameShape(value);
		if (shapeError) return { ok: false, requestId, command: value.type, errorInfo: shapeError };
		return { ok: true, requestId, frame: value as RpcInboundFrame };
	}
	if (!KNOWN_COMMANDS[value.type]) {
		return {
			ok: false,
			requestId,
			command: value.type,
			errorInfo: rpcErrorInfo("unknown_command", `Unknown command: ${value.type}`),
		};
	}
	const shapeError = validateCommandShape(value);
	if (shapeError) return { ok: false, requestId, command: value.type, errorInfo: shapeError };
	return { ok: true, requestId, frame: value as RpcInboundFrame };
}

export async function* readBoundedRpcInput(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<RpcParsedInput> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let partial = "";
	try {
		while (!signal?.aborted) {
			const { value, done } = await reader.read();
			if (done) break;
			partial += decoder.decode(value, { stream: true });
			let newlineIndex = partial.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = partial.slice(0, newlineIndex).replace(/\r$/, "");
				partial = partial.slice(newlineIndex + 1);
				if (line.length > 0) {
					yield parseLine(line);
				}
				newlineIndex = partial.indexOf("\n");
			}
			if (Buffer.byteLength(partial, "utf8") > RPC_LIMITS.maxPartialLineBytes) {
				yield {
					ok: false,
					errorInfo: rpcErrorInfo("invalid_frame", "RPC input line exceeded partial-line limit", {
						limitBytes: RPC_LIMITS.maxPartialLineBytes,
					}),
				};
				partial = "";
			}
		}
		const tail = partial + decoder.decode();
		if (tail.trim().length > 0) {
			yield parseLine(tail.replace(/\r$/, ""));
		}
	} finally {
		reader.releaseLock();
	}
}

function parseLine(line: string): RpcParsedInput {
	const bytes = Buffer.byteLength(line, "utf8");
	if (bytes > RPC_LIMITS.maxFrameBytes) {
		return {
			ok: false,
			errorInfo: rpcErrorInfo("invalid_frame", "RPC input frame exceeded size limit", {
				limitBytes: RPC_LIMITS.maxFrameBytes,
				actualBytes: bytes,
			}),
		};
	}
	try {
		return validateRpcInputFrame(JSON.parse(line));
	} catch (error) {
		return {
			ok: false,
			errorInfo: rpcErrorInfo("invalid_json", error instanceof Error ? error.message : "Invalid JSON"),
		};
	}
}
