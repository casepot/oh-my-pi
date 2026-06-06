import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { applyToolProxy } from "../../extensibility/tool-proxy";
import type { Theme } from "../../modes/theme/theme";
import { RPC_LIMITS, RpcProtocolError, rpcErrorInfo } from "./rpc-protocol";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelAck,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
} from "./rpc-types";

type RpcHostToolOutput = (frame: RpcHostToolCallRequest | RpcHostToolCancelRequest) => void;

type PendingHostToolCall = {
	definition: RpcHostToolDefinition;
	resolve: (result: AgentToolResult<unknown>) => void;
	reject: (error: Error) => void;
	onUpdate?: AgentToolUpdateCallback<unknown>;
	timeout?: NodeJS.Timeout;
	settled: boolean;
};

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
	if (!value || typeof value !== "object") return false;
	const content = (value as { content?: unknown }).content;
	return Array.isArray(content);
}

function jsonSize(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function isRpcHostToolResult(value: unknown): value is RpcHostToolResult {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; result?: unknown };
	return frame.type === "host_tool_result" && typeof frame.id === "string" && isAgentToolResult(frame.result);
}

export function isRpcHostToolUpdate(value: unknown): value is RpcHostToolUpdate {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; partialResult?: unknown };
	return frame.type === "host_tool_update" && typeof frame.id === "string" && isAgentToolResult(frame.partialResult);
}

class RpcHostToolAdapter<TParams extends TSchema = TSchema, TTheme extends Theme = Theme>
	implements AgentTool<TParams, unknown, TTheme>
{
	declare name: string;
	declare label: string;
	declare description: string;
	declare parameters: TParams;
	readonly strict = true;
	concurrency: "shared" | "exclusive" = "shared";
	#bridge: RpcHostToolBridge;
	#definition: RpcHostToolDefinition;

	constructor(definition: RpcHostToolDefinition, bridge: RpcHostToolBridge) {
		this.#definition = definition;
		this.#bridge = bridge;
		applyToolProxy(definition, this);
	}

	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		return this.#bridge.requestExecution(
			this.#definition,
			toolCallId,
			params as Record<string, unknown>,
			signal,
			onUpdate,
		);
	}
}

export class RpcHostToolBridge {
	#output: RpcHostToolOutput;
	#definitions = new Map<string, RpcHostToolDefinition>();
	#pendingCalls = new Map<string, PendingHostToolCall>();
	#pendingCancels = new Map<string, string>();

	constructor(output: RpcHostToolOutput) {
		this.#output = output;
	}

	getToolNames(): string[] {
		return Array.from(this.#definitions.keys());
	}

	getDefinitions(): RpcHostToolDefinition[] {
		return Array.from(this.#definitions.values());
	}

	setTools(tools: RpcHostToolDefinition[]): AgentTool[] {
		this.#definitions = new Map(tools.map(tool => [tool.name, tool]));
		return this.#toAgentTools();
	}

	addTools(tools: RpcHostToolDefinition[]): AgentTool[] {
		for (const tool of tools) {
			this.#definitions.set(tool.name, tool);
		}
		return this.#toAgentTools();
	}

	removeTools(toolNames: string[]): AgentTool[] {
		for (const name of toolNames) {
			this.#definitions.delete(name);
		}
		return this.#toAgentTools();
	}

	handleResult(frame: RpcHostToolResult): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		if (jsonSize(frame.result) > this.#maxResultBytes(pending.definition)) {
			this.#rejectPending(
				frame.id,
				new RpcProtocolError(
					"host_tool_too_large",
					`Host tool result exceeded size limit for ${pending.definition.name}`,
					{
						toolName: pending.definition.name,
						limitBytes: this.#maxResultBytes(pending.definition),
					},
				),
			);
			return true;
		}
		this.#pendingCalls.delete(frame.id);
		if (pending.timeout) clearTimeout(pending.timeout);
		pending.settled = true;
		if (frame.isError) {
			const text = (frame.result.content as unknown[])
				.filter(
					(item): item is { type: "text"; text: string } =>
						typeof item === "object" &&
						item !== null &&
						"type" in item &&
						"text" in item &&
						item.type === "text" &&
						typeof item.text === "string",
				)
				.map(item => item.text)
				.join("\n")
				.trim();
			const info = frame.errorInfo ?? rpcErrorInfo("host_tool_failed", text || "Host tool execution failed");
			pending.reject(new RpcProtocolError(info.code, info.message, info.details, info.retryable));
			return true;
		}
		pending.resolve(frame.result);
		return true;
	}

	handleUpdate(frame: RpcHostToolUpdate): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		if (jsonSize(frame.partialResult) > this.#maxUpdateBytes(pending.definition)) {
			this.#rejectPending(
				frame.id,
				new RpcProtocolError(
					"host_tool_too_large",
					`Host tool update exceeded size limit for ${pending.definition.name}`,
					{
						toolName: pending.definition.name,
						limitBytes: this.#maxUpdateBytes(pending.definition),
					},
				),
			);
			return true;
		}
		pending.onUpdate?.(frame.partialResult);
		return true;
	}

	handleCancelAck(frame: RpcHostToolCancelAck): boolean {
		return this.#pendingCancels.delete(frame.id);
	}

	requestExecution(
		definition: RpcHostToolDefinition,
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		if (signal?.aborted) {
			return Promise.reject(
				new RpcProtocolError("operation_cancelled", `Host tool "${definition.name}" was aborted`),
			);
		}

		const id = Snowflake.next() as string;
		const timeoutMs = definition.defaultTimeoutMs ?? RPC_LIMITS.defaultHostToolTimeoutMs;
		const callFrame: RpcHostToolCallRequest = {
			type: "host_tool_call",
			id,
			toolCallId,
			toolName: definition.name,
			arguments: args,
			metadata: {
				sideEffectClass: definition.sideEffectClass,
				trustClass: definition.trustClass,
				display: definition.display,
				inputSizeHintBytes: definition.inputSizeHintBytes,
				outputSizeHintBytes: definition.outputSizeHintBytes,
			},
			deadlineMs: timeoutMs ?? undefined,
			maxResultBytes: this.#maxResultBytes(definition),
			maxUpdateBytes: this.#maxUpdateBytes(definition),
		};
		if (jsonSize(callFrame) > RPC_LIMITS.maxOutboundFrameBytes - 16_384) {
			return Promise.reject(
				new RpcProtocolError(
					"host_tool_too_large",
					`Host tool request exceeded size limit for ${definition.name}`,
					{
						toolName: definition.name,
						limitBytes: RPC_LIMITS.maxOutboundFrameBytes,
					},
				),
			);
		}
		const { promise, resolve, reject } = Promise.withResolvers<AgentToolResult<unknown>>();
		const pending: PendingHostToolCall = {
			definition,
			resolve,
			reject,
			onUpdate,
			settled: false,
		};
		if (timeoutMs && timeoutMs > 0) {
			pending.timeout = setTimeout(() => {
				this.#rejectPending(
					id,
					new RpcProtocolError("host_tool_timeout", `Host tool "${definition.name}" timed out`, {
						toolName: definition.name,
						timeoutMs,
					}),
				);
			}, timeoutMs);
			pending.timeout.unref();
		}

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			this.#pendingCalls.delete(id);
			if (pending.timeout) clearTimeout(pending.timeout);
		};

		const onAbort = () => {
			if (pending.settled) return;
			pending.settled = true;
			const info = rpcErrorInfo("operation_cancelled", `Host tool "${definition.name}" was aborted`);
			const cancelId = Snowflake.next() as string;
			this.#pendingCancels.set(cancelId, id);
			this.#output({
				type: "host_tool_cancel",
				id: cancelId,
				targetId: id,
				expectsAck: true,
				errorInfo: info,
			});
			cleanup();
			reject(new RpcProtocolError(info.code, info.message, info.details, info.retryable));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingCalls.set(id, pending);

		this.#output(callFrame);

		return promise.finally(cleanup);
	}

	rejectAllPending(message: string): void {
		const pendingIds = Array.from(this.#pendingCalls.keys());
		for (const id of pendingIds) {
			this.#rejectPending(id, new RpcProtocolError("peer_closed", message, undefined, true));
		}
		this.#pendingCancels.clear();
	}

	#toAgentTools(): AgentTool[] {
		return Array.from(this.#definitions.values()).map(tool => new RpcHostToolAdapter(tool, this));
	}

	#rejectPending(id: string, error: Error): void {
		const pending = this.#pendingCalls.get(id);
		if (!pending || pending.settled) return;
		pending.settled = true;
		this.#pendingCalls.delete(id);
		if (pending.timeout) clearTimeout(pending.timeout);
		pending.reject(error);
	}

	#maxResultBytes(definition: RpcHostToolDefinition): number {
		return definition.maxResultBytes ?? RPC_LIMITS.maxHostToolResultBytes;
	}

	#maxUpdateBytes(definition: RpcHostToolDefinition): number {
		return definition.maxUpdateBytes ?? RPC_LIMITS.maxHostToolUpdateBytes;
	}
}
