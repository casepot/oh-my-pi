import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcOperationManager } from "@oh-my-pi/pi-coding-agent/modes/rpc/operation-manager";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { readBoundedRpcInput, validateRpcInputFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-input";
import { type PendingExtensionRequest, requestRpcEditor } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RPC_LIMITS } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-protocol";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { FileSink } from "bun";

interface RpcFrameRecord {
	type?: unknown;
	id?: unknown;
	seq?: unknown;
	timestamp?: unknown;
	sessionId?: unknown;
	command?: unknown;
	success?: unknown;
	data?: unknown;
	error?: unknown;
	errorInfo?: unknown;
	requestId?: unknown;
	operationId?: unknown;
	status?: unknown;
	changed?: unknown;
	state?: unknown;
	stateSeq?: unknown;
	protocol?: unknown;
	mode?: unknown;
	capabilities?: unknown;
	limits?: unknown;
	resetProfile?: unknown;
	security?: unknown;
}

type RpcTestProcess = {
	write(frame: Record<string, unknown>): Promise<void>;
	writeRaw(line: string): Promise<void>;
	next(predicate?: (frame: RpcFrameRecord) => boolean, timeoutMs?: number): Promise<RpcFrameRecord>;
	frames(): RpcFrameRecord[];
	close(): Promise<void>;
};

const launched: RpcTestProcess[] = [];

afterEach(async () => {
	await Promise.all(launched.splice(0).map(child => child.close()));
});

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frameErrorInfo(frame: RpcFrameRecord): Record<string, unknown> {
	if (!isObject(frame.errorInfo)) throw new Error("Expected frame.errorInfo to be an object");
	return frame.errorInfo;
}

function responseData(frame: RpcFrameRecord): Record<string, unknown> {
	if (!isObject(frame.data)) throw new Error("Expected response data to be an object");
	return frame.data;
}

function stdinSink(stdin: unknown): FileSink {
	if (!stdin || typeof stdin !== "object" || !("write" in stdin) || !("flush" in stdin)) {
		throw new Error("Expected piped stdin FileSink");
	}
	return stdin as FileSink;
}

async function maybeFlush(sink: FileSink): Promise<void> {
	const result = sink.flush();
	if (result && typeof result === "object" && "then" in result) await result;
}

function launchRpc(mode: "rpc" | "rpc-ui" = "rpc"): RpcTestProcess {
	const proc = Bun.spawn({
		cmd: [
			"bun",
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--mode",
			mode,
			"--no-session",
			"--no-skills",
			"--no-rules",
			"--no-title",
		],
		cwd: path.join(import.meta.dir, ".."),
		env: { ...Bun.env, PI_NO_TITLE: "1" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const sink = stdinSink(proc.stdin);
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	const parsed: RpcFrameRecord[] = [];
	let pending = "";
	let closed = false;

	const readOne = async (timeoutMs: number): Promise<RpcFrameRecord> => {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const newline = pending.indexOf("\n");
			if (newline >= 0) {
				const line = pending.slice(0, newline).trim();
				pending = pending.slice(newline + 1);
				if (!line) continue;
				const value = JSON.parse(line) as unknown;
				if (!isObject(value)) throw new Error("RPC stdout frame was not an object");
				parsed.push(value);
				return value;
			}

			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`Timed out waiting for RPC frame. Seen ${parsed.length} frames.`);
			const readResult = await Promise.race([reader.read(), Bun.sleep(remaining).then(() => "timeout" as const)]);
			if (readResult === "timeout")
				throw new Error(`Timed out waiting for RPC frame. Seen ${parsed.length} frames.`);
			if (readResult.done) throw new Error(`RPC stdout closed. Seen ${parsed.length} frames.`);
			pending += decoder.decode(readResult.value, { stream: true });
		}
	};

	const child: RpcTestProcess = {
		async write(frame: Record<string, unknown>): Promise<void> {
			sink.write(`${JSON.stringify(frame)}\n`);
			await maybeFlush(sink);
		},
		async writeRaw(line: string): Promise<void> {
			sink.write(line);
			await maybeFlush(sink);
		},
		async next(
			predicate: (frame: RpcFrameRecord) => boolean = () => true,
			timeoutMs = 5_000,
		): Promise<RpcFrameRecord> {
			const deadline = Date.now() + timeoutMs;
			while (true) {
				const existing = parsed.find(predicate);
				if (existing) return existing;
				const frame = await readOne(Math.max(1, deadline - Date.now()));
				if (predicate(frame)) return frame;
			}
		},
		frames(): RpcFrameRecord[] {
			return [...parsed];
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			try {
				proc.kill();
			} catch {}
			try {
				await proc.exited;
			} catch {}
			reader.releaseLock();
		},
	};
	launched.push(child);
	return child;
}

function expectFrameMetadata(frames: RpcFrameRecord[]): void {
	let lastSeq = 0;
	let sessionId: unknown;
	for (const frame of frames) {
		expect(typeof frame.seq).toBe("number");
		expect(frame.seq as number).toBeGreaterThan(lastSeq);
		lastSeq = frame.seq as number;
		expect(typeof frame.timestamp).toBe("string");
		expect(Number.isNaN(Date.parse(frame.timestamp as string))).toBe(false);
		if (sessionId === undefined) sessionId = frame.sessionId;
		expect(frame.sessionId).toBe(sessionId);
	}
}

describe("RPC orchestration contract", () => {
	test("ready and get_protocol_info expose matching protocol facts with deterministic metadata", async () => {
		const child = launchRpc("rpc");
		const ready = await child.next(frame => frame.type === "ready");
		expect(ready.seq).toBe(1);
		expect(ready.protocol).toEqual({ name: "omp-rpc", version: "1.1.0", schemaVersion: 1 });
		expect(ready.mode).toBe("rpc");
		expect(isObject(ready.capabilities)).toBe(true);
		const readyCapabilities = ready.capabilities as Record<string, unknown>;
		expect(Array.isArray(readyCapabilities.commands)).toBe(true);
		expect(readyCapabilities.operationEvents).toBe(true);
		expect(readyCapabilities.sessionGraph).toBe(true);
		expect(readyCapabilities.taskEvents).toBe(true);
		expect(readyCapabilities.hostTools).toBe(true);
		expect(readyCapabilities.hostUris).toBe(true);
		expect(readyCapabilities.extensionUi).toBe(true);
		expect(readyCapabilities.heartbeat).toBe(true);

		await child.write({ id: "info", type: "get_protocol_info" });
		const response = await child.next(frame => frame.type === "response" && frame.id === "info");
		expect(response.success).toBe(true);
		const info = responseData(response);
		expect(info.protocol).toEqual(ready.protocol);
		expect(info.mode).toBe("rpc");
		expect(info.capabilities).toEqual(ready.capabilities);
		expect(info.limits).toEqual(ready.limits);
		expect(info.resetProfile).toEqual(ready.resetProfile);
		expect(info.security).toEqual(ready.security);

		await child.write({ id: "shutdown", type: "shutdown", reason: "test_complete" });
		await child.next(frame => frame.type === "shutdown");
		expectFrameMetadata(child.frames());
	});

	test("one-shot probe emits ready, one response, and deterministic shutdown", async () => {
		const proc = Bun.spawn({
			cmd: [
				"bun",
				path.join(import.meta.dir, "..", "src", "cli.ts"),
				"--mode",
				"rpc",
				"--no-session",
				"--no-skills",
				"--no-rules",
				"--no-title",
				"--rpc-one-shot",
				"get_protocol_info",
			],
			cwd: path.join(import.meta.dir, ".."),
			env: { ...Bun.env, PI_NO_TITLE: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await Promise.race([
			new Response(proc.stdout).text(),
			Bun.sleep(10_000).then(() => {
				proc.kill();
				throw new Error("Timed out waiting for one-shot RPC probe");
			}),
		]);
		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);
		const frames = stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as RpcFrameRecord);
		expect(frames.map(frame => frame.type)).toEqual(["ready", "response", "shutdown"]);
		expect(frames[0]?.seq).toBe(1);
		expect(frames[1]?.id).toBe("req");
		expect(frames[1]?.success).toBe(true);
		expect(responseData(frames[1] ?? {}).protocol).toEqual(frames[0]?.protocol);
		expect(frames[2]?.status).toBe("one_shot_complete");
		expectFrameMetadata(frames);
	});

	test("gateway scanners gate terminal evidence on operation terminal frames and fail closed on malformed streams", () => {
		const scanGatewayStdout = (stdout: string): Set<string> => {
			let lastSeq = 0;
			let sawReady = false;
			const started = new Set<string>();
			const terminalOperationIds = new Set<string>();
			const ackedOperationIds = new Set<string>();
			for (const raw of stdout.split("\n").filter(line => line.length > 0)) {
				const parsed = JSON.parse(raw) as unknown;
				if (!isObject(parsed)) throw new Error("non-object frame");
				if (typeof parsed.seq !== "number" || parsed.seq <= lastSeq) throw new Error("non-monotonic seq");
				lastSeq = parsed.seq;
				if (parsed.type === "ready") {
					sawReady = true;
					continue;
				}
				if (!sawReady) throw new Error("missing ready");
				if (parsed.type === "response" && isObject(parsed.data) && typeof parsed.data.operationId === "string") {
					ackedOperationIds.add(parsed.data.operationId);
				}
				if (parsed.type === "operation_start" && typeof parsed.operationId === "string") {
					started.add(parsed.operationId);
				}
				if (
					(parsed.type === "operation_end" || parsed.type === "operation_error") &&
					typeof parsed.operationId === "string"
				) {
					if (!started.has(parsed.operationId)) throw new Error("terminal before operation_start");
					if (terminalOperationIds.has(parsed.operationId)) throw new Error("duplicate terminal operation");
					terminalOperationIds.add(parsed.operationId);
				}
			}
			for (const operationId of ackedOperationIds) {
				if (!terminalOperationIds.has(operationId)) throw new Error("ack without terminal operation");
			}
			return terminalOperationIds;
		};
		const serialize = (frames: RpcFrameRecord[]): string => frames.map(frame => JSON.stringify(frame)).join("\n");
		const completed = serialize([
			{ type: "ready", seq: 1 },
			{ type: "response", seq: 2, id: "bash", success: true, data: { ack: "accepted", operationId: "op_1" } },
			{ type: "operation_start", seq: 3, operationId: "op_1", command: "bash" },
			{ type: "operation_error", seq: 4, operationId: "op_1", command: "bash", status: "cancelled" },
		]);
		expect(scanGatewayStdout(completed).has("op_1")).toBe(true);
		expect(() => scanGatewayStdout(`${completed}\n{not-json}`)).toThrow();
		expect(() => scanGatewayStdout(serialize([{ type: "response", seq: 1 }]))).toThrow(/missing ready/);
		expect(() =>
			scanGatewayStdout(
				serialize([
					{ type: "ready", seq: 1 },
					{ type: "response", seq: 1 },
				]),
			),
		).toThrow(/non-monotonic/);
		expect(() =>
			scanGatewayStdout(
				serialize([
					{ type: "ready", seq: 1 },
					{ type: "operation_error", seq: 2, operationId: "op_1", command: "bash", status: "failed" },
				]),
			),
		).toThrow(/terminal before/);
		expect(() =>
			scanGatewayStdout(
				serialize([
					{ type: "ready", seq: 1 },
					{ type: "response", seq: 2, id: "bash", success: true, data: { ack: "accepted", operationId: "op_1" } },
					{ type: "operation_start", seq: 3, operationId: "op_1", command: "bash" },
				]),
			),
		).toThrow(/ack without terminal/);
	});

	test("invalid enum arguments return typed correlated validation errors", async () => {
		const child = launchRpc();
		await child.next(frame => frame.type === "ready");
		await child.write({ id: "thinking", type: "set_thinking_level", level: "warp" });
		const thinking = await child.next(frame => frame.type === "response" && frame.id === "thinking");
		expect(thinking.success).toBe(false);
		expect(frameErrorInfo(thinking).code).toBe("invalid_arguments");
		await child.write({ id: "queue", type: "set_follow_up_mode", mode: "sometimes" });
		const queue = await child.next(frame => frame.type === "response" && frame.id === "queue");
		expect(queue.success).toBe(false);
		expect(frameErrorInfo(queue).code).toBe("invalid_arguments");
		await child.write({ id: "shutdown", type: "shutdown" });
		await child.next(frame => frame.type === "shutdown");
	});

	test("host and UI response frames are validated and unmatched ids surface typed protocol errors", async () => {
		const child = launchRpc();
		await child.next(frame => frame.type === "ready");
		await child.write({ id: "bad-host", type: "host_tool_result" });
		const invalid = await child.next(frame => frame.type === "response" && frame.id === "bad-host");
		expect(invalid.success).toBe(false);
		expect(frameErrorInfo(invalid).code).toBe("invalid_frame");

		await child.write({ id: "missing-host", type: "host_tool_result", result: { content: [], details: {} } });
		const unmatched = await child.next(
			frame => frame.type === "protocol_error" && frame.requestId === "missing-host",
		);
		expect(frameErrorInfo(unmatched).code).toBe("invalid_frame");
		await child.write({ id: "shutdown", type: "shutdown" });
		await child.next(frame => frame.type === "shutdown");
	});

	test("extension UI requests declare timeout and cancel timed-out pending requests", async () => {
		const pending = new Map<string, PendingExtensionRequest>();
		const frames: RpcExtensionUIRequest[] = [];
		const resolved = requestRpcEditor(pending, frame => frames.push(frame as RpcExtensionUIRequest), "Edit");
		const request = frames[0];
		if (request?.method !== "editor") throw new Error("Expected editor request");
		expect(request.expectsResponse).toBe(true);
		expect(request.timeout).toBe(RPC_LIMITS.defaultExtensionUiTimeoutMs);
		pending.get(request.id)?.resolve({
			type: "extension_ui_response",
			id: request.id,
			value: "ok",
		} satisfies RpcExtensionUIResponse);
		await expect(resolved).resolves.toBe("ok");

		const timedFrames: RpcExtensionUIRequest[] = [];
		const timedOut = requestRpcEditor(
			new Map<string, PendingExtensionRequest>(),
			frame => timedFrames.push(frame as RpcExtensionUIRequest),
			"Edit",
			undefined,
			{ timeout: 5 },
		);
		const timedRequest = timedFrames[0];
		if (timedRequest?.method !== "editor") throw new Error("Expected timed editor request");
		await expect(timedOut).resolves.toBeUndefined();
		const cancel = timedFrames[1];
		expect(cancel).toMatchObject({
			method: "cancel",
			expectsResponse: false,
			targetId: timedRequest.id,
		});
	});

	test("rpc-ui ready advertises rpc-ui mode before extension frames", async () => {
		const child = launchRpc("rpc-ui");
		const ready = await child.next();
		expect(ready.type).toBe("ready");
		expect(ready.seq).toBe(1);
		expect(ready.mode).toBe("rpc-ui");
		await child.write({ id: "shutdown", type: "shutdown" });
		await child.next(frame => frame.type === "shutdown");
	});

	test("validation preserves parseable ids and emits typed uncorrelated protocol errors", async () => {
		const child = launchRpc();
		await child.next(frame => frame.type === "ready");
		await child.writeRaw("{not-json}\n");
		const invalidJson = await child.next(frame => frame.type === "protocol_error");
		expect(frameErrorInfo(invalidJson).code).toBe("invalid_json");
		await child.write({ id: "bad_args", type: "prompt", message: 42 });
		const invalidArgs = await child.next(frame => frame.type === "response" && frame.id === "bad_args");
		expect(invalidArgs.success).toBe(false);
		expect(frameErrorInfo(invalidArgs).code).toBe("invalid_arguments");

		await child.write({ id: "unknown", type: "future_command" });
		const unknown = await child.next(frame => frame.type === "response" && frame.id === "unknown");
		expect(unknown.success).toBe(false);
		expect(frameErrorInfo(unknown).code).toBe("unknown_command");

		await child.write({ id: "shutdown", type: "shutdown" });
		await child.next(frame => frame.type === "shutdown");
	});

	test("bounded input parser rejects malformed json and oversized partial lines", async () => {
		expect(validateRpcInputFrame({ id: "x", type: "future_command" }).ok).toBe(false);
		const encoder = new TextEncoder();
		const chunks = [encoder.encode("{not-json}\n"), encoder.encode("x".repeat(RPC_LIMITS.maxPartialLineBytes + 1))];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});
		const results = [];
		for await (const result of readBoundedRpcInput(stream)) results.push(result);
		expect(results[0]?.ok).toBe(false);
		if (results[0]?.ok === false) expect(results[0].errorInfo.code).toBe("invalid_json");
		expect(results[1]?.ok).toBe(false);
		if (results[1]?.ok === false) expect(results[1].errorInfo.code).toBe("invalid_frame");

		const manyFrames = Array.from({ length: 256 }, (_, index) =>
			JSON.stringify({ id: `p${index}`, type: "ping" }),
		).join("\n");
		const packed = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(`${manyFrames}\n`));
				controller.close();
			},
		});
		let accepted = 0;
		for await (const result of readBoundedRpcInput(packed)) {
			if (result.ok) accepted += 1;
		}
		expect(accepted).toBe(256);
	});

	test("long-running bash commands ACK, start, cancel, and emit one terminal operation frame", async () => {
		const child = launchRpc();
		await child.next(frame => frame.type === "ready");
		await child.write({ id: "bash", type: "bash", command: 'bun -e "await Bun.sleep(10000)"' });
		const response = await child.next(frame => frame.type === "response" && frame.id === "bash");
		const data = responseData(response);
		expect(data.ack).toBe("accepted");
		const operationId = data.operationId;
		expect(typeof operationId).toBe("string");
		await child.next(frame => frame.type === "operation_start" && frame.operationId === operationId);

		await child.write({ id: "cancel", type: "cancel_operation", operationId });
		const cancel = await child.next(frame => frame.type === "response" && frame.id === "cancel");
		expect(cancel.success).toBe(true);
		const terminal = await child.next(frame => frame.type === "operation_error" && frame.operationId === operationId);
		expect(terminal.status).toBe("cancelled");
		expect(frameErrorInfo(terminal).code).toBe("operation_cancelled");
		const terminalCount = child
			.frames()
			.filter(
				frame =>
					(frame.type === "operation_end" || frame.type === "operation_error") &&
					frame.operationId === operationId,
			).length;
		expect(terminalCount).toBe(1);
		await child.write({ id: "shutdown", type: "shutdown" });
		await child.next(frame => frame.type === "shutdown");
	});

	test("abort_bash cancels the tracked bash operation instead of only signalling the shell", async () => {
		const child = launchRpc();
		await child.next(frame => frame.type === "ready");
		await child.write({ id: "bash", type: "bash", command: 'bun -e "await Bun.sleep(10000)"' });
		const response = await child.next(frame => frame.type === "response" && frame.id === "bash");
		const operationId = responseData(response).operationId;
		expect(typeof operationId).toBe("string");
		await child.next(frame => frame.type === "operation_start" && frame.operationId === operationId);

		await child.write({ id: "abort-bash", type: "abort_bash" });
		const abortResponse = await child.next(frame => frame.type === "response" && frame.id === "abort-bash");
		expect(abortResponse.success).toBe(true);
		const terminal = await child.next(frame => frame.type === "operation_error" && frame.operationId === operationId);
		expect(terminal.status).toBe("cancelled");
		expect(frameErrorInfo(terminal).code).toBe("operation_cancelled");
		await child.write({ id: "shutdown", type: "shutdown" });
		await child.next(frame => frame.type === "shutdown");
	});

	test("fast operation failures are terminal frames after the ACK response", async () => {
		const child = launchRpc();
		await child.next(frame => frame.type === "ready");
		await child.write({ id: "login", type: "login", providerId: "__missing_provider__" });
		const response = await child.next(frame => frame.type === "response" && frame.id === "login");
		const operationId = responseData(response).operationId;
		expect(typeof operationId).toBe("string");
		const terminal = await child.next(frame => frame.type === "operation_error" && frame.operationId === operationId);
		expect(frameErrorInfo(terminal).code).toBe("invalid_arguments");
		const frames = child.frames();
		expect(frames.indexOf(response)).toBeLessThan(frames.indexOf(terminal));
		await child.write({ id: "shutdown", type: "shutdown" });
		await child.next(frame => frame.type === "shutdown");
	});

	test("operation cancellation before the run timer fires suppresses the body and emits one terminal frame", async () => {
		const frames: RpcFrameRecord[] = [];
		let bodyRan = false;
		const manager = new RpcOperationManager(
			frame => frames.push(frame as RpcFrameRecord),
			() => {},
		);
		const ack = manager.start({
			command: "login",
			requestId: "login",
			run: () => {
				bodyRan = true;
				return { ok: true };
			},
		});
		const cancelInfo = manager.cancel(ack.operationId);
		expect(cancelInfo).toBeUndefined();
		await Bun.sleep(20);
		expect(bodyRan).toBe(false);
		const terminals = frames.filter(
			frame =>
				(frame.type === "operation_end" || frame.type === "operation_error") &&
				frame.operationId === ack.operationId,
		);
		expect(terminals).toHaveLength(1);
		expect(terminals[0]?.status).toBe("cancelled");
		expect(frameErrorInfo(terminals[0] ?? {}).code).toBe("operation_cancelled");
	});

	test("shutdown emits terminal outcomes for active operations before the shutdown frame", async () => {
		const child = launchRpc();
		await child.next(frame => frame.type === "ready");
		await child.write({ id: "bash", type: "bash", command: 'bun -e "await Bun.sleep(10000)"' });
		const response = await child.next(frame => frame.type === "response" && frame.id === "bash");
		const operationId = responseData(response).operationId;
		expect(typeof operationId).toBe("string");
		await child.write({ id: "shutdown", type: "shutdown" });
		const terminal = await child.next(frame => frame.type === "operation_error" && frame.operationId === operationId);
		const shutdown = await child.next(frame => frame.type === "shutdown");
		const frames = child.frames();
		expect(frames.indexOf(terminal)).toBeLessThan(frames.indexOf(shutdown));
		expect(frameErrorInfo(terminal).code).toBe("operation_cancelled");
	});

	test("state mutations emit state_changed and get_state matches the latest state sequence", async () => {
		const child = launchRpc();
		await child.next(frame => frame.type === "ready");
		await child.write({
			id: "todos",
			type: "set_todos",
			phases: [{ id: "phase-1", name: "Work", tasks: [{ id: "task-1", content: "Map RPC", status: "pending" }] }],
		});
		const response = await child.next(frame => frame.type === "response" && frame.id === "todos");
		expect(response.success).toBe(true);
		const changed = await child.next(frame => frame.type === "state_changed");
		expect(Array.isArray(changed.changed)).toBe(true);
		expect(changed.changed as unknown[]).toContain("todoPhases");
		await child.write({ id: "state", type: "get_state" });
		const stateResponse = await child.next(frame => frame.type === "response" && frame.id === "state");
		const state = responseData(stateResponse);
		expect(state.stateSeq).toBe(changed.stateSeq);
		expect(state.activeOperations).toEqual([]);
		expect(isObject(state.security)).toBe(true);
		await child.write({ id: "shutdown", type: "shutdown" });
		await child.next(frame => frame.type === "shutdown");
	});

	test("session graph queries expose current branch data and TypeScript client helpers preserve it", async () => {
		const child = launchRpc();
		await child.next(frame => frame.type === "ready");
		await child.write({ id: "entries", type: "get_session_entries", includeContent: false });
		const entriesResponse = await child.next(frame => frame.type === "response" && frame.id === "entries");
		const entries = responseData(entriesResponse);
		expect(Array.isArray(entries.entries)).toBe(true);
		expect(typeof entries.total).toBe("number");
		expect(typeof entries.offset).toBe("number");
		expect(typeof entries.limit).toBe("number");
		expect("currentLeafId" in entries).toBe(true);

		await child.write({ id: "tree", type: "get_session_tree", includeEntries: true });
		const treeResponse = await child.next(frame => frame.type === "response" && frame.id === "tree");
		const tree = responseData(treeResponse);
		expect(Array.isArray(tree.root)).toBe(true);
		expect("currentLeafId" in tree).toBe(true);
		await child.write({ id: "shutdown", type: "shutdown" });
		await child.next(frame => frame.type === "shutdown");

		const client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, ".."),
			args: ["--no-session", "--no-skills", "--no-rules", "--no-title"],
			env: { PI_NO_TITLE: "1" },
		});
		try {
			await client.start();
			const clientEntries = await client.getSessionEntries({ includeContent: false, limit: 10 });
			expect(Array.isArray(clientEntries.entries)).toBe(true);
			expect("currentLeafId" in clientEntries).toBe(true);
			const clientTree = await client.getSessionTree(true);
			expect(Array.isArray(clientTree.root)).toBe(true);
			expect("currentLeafId" in clientTree).toBe(true);
			const sessions = await client.getObservableSessions();
			expect(Array.isArray(sessions)).toBe(true);
			const pong = await client.ping({ ok: true });
			expect(pong.pong).toBe(true);
			await client.shutdown("test_complete");
		} finally {
			client.stop();
		}
	});

	test("TypeScript RpcClient surfaces raw and unknown frames and rejects pending requests on close", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-client-"));
		const script = path.join(dir, "fake-rpc.ts");
		await Bun.write(
			script,
			[
				'console.log(JSON.stringify({ type: "ready", seq: 1, timestamp: new Date().toISOString(), sessionId: "fake", protocol: { name: "omp-rpc", version: "1.1.0", schemaVersion: 1 }, server: { packageName: "fake", packageVersion: "0.0.0", pid: process.pid }, mode: "rpc", capabilities: {}, limits: {}, resetProfile: {}, security: {} }));',
				'console.log(JSON.stringify({ type: "thinking_level_changed", seq: 2, timestamp: new Date().toISOString(), sessionId: "fake", thinkingLevel: "medium" }));',
				'console.log(JSON.stringify({ type: "future_frame", seq: 3, timestamp: new Date().toISOString(), sessionId: "fake", value: 1 }));',
				"await Bun.sleep(30000);",
			].join("\n"),
		);
		const rawFrames: unknown[] = [];
		const unknownFrames: unknown[] = [];
		const sessionFrames: unknown[] = [];
		const client = new RpcClient({
			cliPath: script,
			cwd: dir,
			onFrame: frame => rawFrames.push(frame),
			onUnknownFrame: frame => unknownFrames.push(frame),
			onSessionEvent: frame => sessionFrames.push(frame),
		});
		try {
			await client.start();
			await Bun.sleep(100);
			expect(rawFrames.length).toBeGreaterThanOrEqual(3);
			expect(sessionFrames).toHaveLength(1);
			expect(unknownFrames).toHaveLength(1);
			const pending = client.getProtocolInfo();
			client.stop();
			await expect(pending).rejects.toThrow(/stopped|closed|exited/i);
		} finally {
			client.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("TypeScript RpcClient tracks accepted operations and rejects oversized outbound commands", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-client-"));
		const script = path.join(dir, "fake-rpc-operations.ts");
		await Bun.write(
			script,
			[
				'const send = frame => process.stdout.write(JSON.stringify(frame) + "\\n");',
				"let seq = 1;",
				'const base = { timestamp: new Date().toISOString(), sessionId: "fake" };',
				'send({ type: "ready", seq: seq++, ...base, protocol: { name: "omp-rpc", version: "1.1.0", schemaVersion: 1 }, server: { packageName: "fake", packageVersion: "0.0.0", pid: process.pid }, mode: "rpc", capabilities: {}, limits: {}, resetProfile: {}, security: {} });',
				"const decoder = new TextDecoder();",
				'let buffer = "";',
				"for await (const chunk of Bun.stdin.stream()) {",
				"  buffer += decoder.decode(chunk, { stream: true });",
				"  for (;;) {",
				'    const index = buffer.indexOf("\\n");',
				"    if (index < 0) break;",
				"    const raw = buffer.slice(0, index);",
				"    buffer = buffer.slice(index + 1);",
				"    if (!raw) continue;",
				"    const frame = JSON.parse(raw);",
				'    if (frame.type === "prompt") {',
				'      send({ type: "response", id: frame.id, command: "prompt", success: true, data: { ack: "accepted", operationId: "op_prompt" }, seq: seq++, ...base });',
				'      setTimeout(() => send({ type: "operation_start", operationId: "op_prompt", command: "prompt", startedAt: new Date().toISOString(), seq: seq++, ...base }), 100);',
				'      setTimeout(() => send({ type: "operation_end", operationId: "op_prompt", command: "prompt", status: "success", data: {}, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), seq: seq++, ...base }), 200);',
				"    }",
				'    if (frame.type === "shutdown") {',
				'      send({ type: "response", id: frame.id, command: "shutdown", success: true, data: { reason: "test" }, seq: seq++, ...base });',
				"      process.exit(0);",
				"    }",
				"  }",
				"}",
			].join("\n"),
		);
		const client = new RpcClient({ cliPath: script, cwd: dir });
		try {
			await client.start();
			await expect(client.ping("x".repeat(RPC_LIMITS.maxOutboundFrameBytes))).rejects.toThrow(/size limit/);
			await client.prompt("hello");
			let idleSettled = false;
			const idle = client.waitForIdle(2_000).then(() => {
				idleSettled = true;
			});
			await Bun.sleep(50);
			expect(idleSettled).toBe(false);
			await idle;
			expect(idleSettled).toBe(true);
			await client.shutdown("test_complete");
		} finally {
			client.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("TypeScript RpcClient maps legacy failed responses without errorInfo to command errors", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-client-"));
		const script = path.join(dir, "fake-rpc-legacy-error.ts");
		await Bun.write(
			script,
			[
				'const send = frame => process.stdout.write(JSON.stringify(frame) + "\\n");',
				'send({ type: "ready", seq: 1, timestamp: new Date().toISOString(), sessionId: "fake", protocol: { name: "omp-rpc", version: "1.1.0", schemaVersion: 1 }, server: { packageName: "fake", packageVersion: "0.0.0", pid: process.pid }, mode: "rpc", capabilities: {}, limits: {}, resetProfile: {}, security: {} });',
				"const decoder = new TextDecoder();",
				'let buffer = "";',
				"for await (const chunk of Bun.stdin.stream()) {",
				"  buffer += decoder.decode(chunk, { stream: true });",
				'  const index = buffer.indexOf("\\n");',
				"  if (index < 0) continue;",
				"  const frame = JSON.parse(buffer.slice(0, index));",
				'  send({ type: "response", id: frame.id, command: frame.type, success: false, error: "legacy failure", seq: 2, timestamp: new Date().toISOString(), sessionId: "fake" });',
				"}",
			].join("\n"),
		);
		const client = new RpcClient({ cliPath: script, cwd: dir });
		try {
			await client.start();
			await expect(client.getProtocolInfo()).rejects.toThrow("legacy failure");
		} finally {
			client.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
