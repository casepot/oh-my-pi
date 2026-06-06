import { Snowflake } from "@oh-my-pi/pi-utils";
import { errorInfoFromUnknown, rpcErrorInfo } from "./rpc-protocol";
import type { RpcErrorInfo, RpcOperationAck, RpcOperationSnapshot, RpcOperationStatus } from "./rpc-types";

export interface RpcOperationContext {
	operationId: string;
	command: string;
	requestId?: string;
	turnId?: string;
	signal: AbortSignal;
}

export interface RpcOperationOptions<T> {
	command: string;
	requestId?: string;
	turnId?: string;
	queued?: boolean;
	timeoutMs?: number | null;
	cancel?: () => void | Promise<void>;
	run: (context: RpcOperationContext) => Promise<T> | T;
}

type OperationRecord<T = unknown> = RpcOperationSnapshot & {
	controller: AbortController;
	cancel?: () => void | Promise<void>;
	timeout?: NodeJS.Timeout;
	settled: boolean;
	run: (context: RpcOperationContext) => Promise<T> | T;
};

type OperationWriter = (frame: object) => void;
type StateNotifier = (changed: string[]) => void;

export class RpcOperationManager {
	#operations = new Map<string, OperationRecord>();
	#write: OperationWriter;
	#notifyStateChanged: StateNotifier;

	constructor(write: OperationWriter, notifyStateChanged: StateNotifier) {
		this.#write = write;
		this.#notifyStateChanged = notifyStateChanged;
	}

	start<T>(options: RpcOperationOptions<T>): RpcOperationAck {
		const operationId = `op_${Snowflake.next()}`;
		const startedAt = new Date().toISOString();
		const controller = new AbortController();
		const record: OperationRecord<T> = {
			operationId,
			command: options.command,
			requestId: options.requestId,
			turnId: options.turnId,
			status: "running",
			startedAt,
			controller,
			cancel: options.cancel,
			settled: false,
			run: options.run,
		};
		this.#operations.set(operationId, record);
		this.#notifyStateChanged(["activeOperations"]);
		this.#write({
			type: "operation_start",
			operationId,
			command: record.command,
			requestId: record.requestId,
			turnId: record.turnId,
			startedAt,
		});
		if (options.timeoutMs && options.timeoutMs > 0) {
			record.timeout = setTimeout(() => {
				this.fail(
					operationId,
					rpcErrorInfo("operation_timeout", `Operation ${operationId} timed out`, undefined, true),
				);
				controller.abort(record.errorInfo);
			}, options.timeoutMs);
			record.timeout.unref();
		}
		const runTimer = setTimeout(() => {
			void this.#run(record);
		}, 0);
		runTimer.unref();
		return { ack: "accepted", operationId, turnId: options.turnId, queued: options.queued === true };
	}

	cancel(operationId: string): RpcErrorInfo | undefined {
		const record = this.#operations.get(operationId);
		if (record?.status !== "running") {
			return rpcErrorInfo("operation_not_found", `Operation not found: ${operationId}`);
		}
		record.cancelRequestedAt = new Date().toISOString();
		try {
			const result = record.cancel?.();
			if (result && typeof result === "object" && "then" in result) {
				void result.catch(error => {
					this.fail(operationId, errorInfoFromUnknown(error));
				});
			}
		} catch (error) {
			this.fail(operationId, errorInfoFromUnknown(error));
			return undefined;
		}
		record.controller.abort(rpcErrorInfo("operation_cancelled", `Operation cancelled: ${operationId}`));
		this.fail(operationId, rpcErrorInfo("operation_cancelled", `Operation cancelled: ${operationId}`), "cancelled");
		return undefined;
	}

	cancelByCommand(commands: readonly string[]): string[] {
		const commandSet = new Set(commands);
		const cancelled: string[] = [];
		for (const record of Array.from(this.#operations.values())) {
			if (!commandSet.has(record.command)) continue;
			if (this.cancel(record.operationId) === undefined) cancelled.push(record.operationId);
		}
		return cancelled;
	}

	failPeerClosed(): void {
		for (const operationId of Array.from(this.#operations.keys())) {
			this.fail(operationId, rpcErrorInfo("peer_closed", "RPC peer closed stdin", undefined, true), "peer_closed");
		}
	}

	failAll(
		errorInfo: RpcErrorInfo,
		status: Extract<RpcOperationStatus, "failed" | "cancelled" | "rejected" | "peer_closed">,
	): void {
		for (const operationId of Array.from(this.#operations.keys())) {
			this.fail(operationId, errorInfo, status);
		}
	}

	getActiveOperations(): RpcOperationSnapshot[] {
		return Array.from(this.#operations.values()).map(record => ({
			operationId: record.operationId,
			command: record.command,
			requestId: record.requestId,
			turnId: record.turnId,
			status: record.status,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			cancelRequestedAt: record.cancelRequestedAt,
			errorInfo: record.errorInfo,
		}));
	}

	#complete(operationId: string, data: unknown): void {
		const record = this.#operations.get(operationId);
		if (!record || record.settled) return;
		record.settled = true;
		record.status = "completed";
		record.endedAt = new Date().toISOString();
		if (record.timeout) clearTimeout(record.timeout);
		this.#write({
			type: "operation_end",
			operationId,
			command: record.command,
			status: "completed",
			requestId: record.requestId,
			turnId: record.turnId,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			data,
		});
		this.#operations.delete(operationId);
		this.#notifyStateChanged(["activeOperations"]);
	}

	fail(
		operationId: string,
		errorInfo: RpcErrorInfo,
		status: Extract<RpcOperationStatus, "failed" | "cancelled" | "rejected" | "peer_closed"> = "failed",
	): void {
		const record = this.#operations.get(operationId);
		if (!record || record.settled) return;
		record.settled = true;
		record.status = status;
		record.errorInfo = errorInfo;
		record.endedAt = new Date().toISOString();
		if (record.timeout) clearTimeout(record.timeout);
		this.#write({
			type: "operation_error",
			operationId,
			command: record.command,
			status,
			requestId: record.requestId,
			turnId: record.turnId,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			error: errorInfo.message,
			errorInfo,
		});
		this.#operations.delete(operationId);
		this.#notifyStateChanged(["activeOperations"]);
	}

	async #run(record: OperationRecord): Promise<void> {
		if (record.settled || record.controller.signal.aborted) return;
		try {
			const data = await record.run({
				operationId: record.operationId,
				command: record.command,
				requestId: record.requestId,
				turnId: record.turnId,
				signal: record.controller.signal,
			});
			this.#complete(record.operationId, data);
		} catch (error) {
			const info = errorInfoFromUnknown(error);
			const status = info.code === "operation_cancelled" ? "cancelled" : "failed";
			this.fail(record.operationId, info, status);
		}
	}
}
