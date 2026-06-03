/**
 * End-to-end exercise of the Python eval workflow helpers: parallel, pipeline,
 * and log/phase status events.
 *
 * Gated by `PI_PYTHON_INTEGRATION=1` so CI without a real Python interpreter
 * (or sandboxes where subprocess spawning is restricted) does not fail.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { disposeAllKernelSessions, executePythonWithKernel } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { TempDir } from "@oh-my-pi/pi-utils";

const SHOULD_RUN = Bun.env.PI_PYTHON_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)("python eval workflow helpers", () => {
	afterEach(async () => {
		await disposeAllKernelSessions();
	});

	it("parallel preserves input order", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-parallel-order-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "print(parallel([lambda: 1, lambda: 2, lambda: 3]))");
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("[1, 2, 3]");
		} finally {
			await kernel.shutdown();
		}
	});

	it("parallel runs thunks concurrently", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-parallel-concurrent-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const code = [
				"import time",
				"start = time.monotonic()",
				"parallel([lambda: time.sleep(0.2) for _ in range(4)], concurrency=4)",
				"print('ELAPSED', time.monotonic() - start)",
			].join("\n");
			const result = await executePythonWithKernel(kernel, code);
			expect(result.exitCode).toBe(0);
			const match = result.output.match(/ELAPSED\s+([0-9.]+)/);
			expect(match).not.toBeNull();
			const elapsed = Number(match?.[1]);
			// Four 0.2s sleeps with concurrency 4 must overlap: serial would be
			// ~0.8s. Generous bound keeps the assertion robust under load.
			expect(elapsed).toBeLessThan(0.6);
		} finally {
			await kernel.shutdown();
		}
	});

	it("pipeline transforms items stage by stage", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-pipeline-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(
				kernel,
				"print(pipeline([1, 2, 3], lambda x: x + 1, lambda x: x * 10))",
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("[20, 30, 40]");
		} finally {
			await kernel.shutdown();
		}
	});

	it("parallel propagates a thunk exception", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-parallel-error-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const code = ["def boom():", "    raise ValueError('kaboom')", "parallel([lambda: 1, boom, lambda: 3])"].join(
				"\n",
			);
			const result = await executePythonWithKernel(kernel, code);
			expect(result.exitCode).not.toBe(0);
			expect(result.output).toContain("ValueError");
			expect(result.output).toContain("kaboom");
		} finally {
			await kernel.shutdown();
		}
	});

	it("read accepts positional offsets and local line selectors", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-read-");
		await Bun.write(`${tempDir.path()}/lines.txt`, "a\nb\nc\nd\n");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const code = ["import json", "print(json.dumps([read('lines.txt', 2, 2), read('lines.txt:3-4')]))"].join("\n");
			const result = await executePythonWithKernel(kernel, code, { cwd: tempDir.path() });
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output.trim())).toEqual(["b\nc\n", "c\nd\n"]);
		} finally {
			await kernel.shutdown();
		}
	});

	it("parallel_settled retains successful siblings when one thunk fails", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-parallel-settled-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const code = [
				"import json",
				"def boom():",
				"    raise ValueError('kaboom')",
				"print(json.dumps(parallel_settled([lambda: 'a', boom, lambda: 'c'])))",
			].join("\n");
			const result = await executePythonWithKernel(kernel, code);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output.trim())).toEqual([
				{ status: "fulfilled", value: "a" },
				{ status: "rejected", reason: "kaboom", error_type: "ValueError" },
				{ status: "fulfilled", value: "c" },
			]);
		} finally {
			await kernel.shutdown();
		}
	});

	it("timeout failures include structured cause and preserve partial output", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-timeout-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(
				kernel,
				"import time\nprint('before', flush=True)\ntime.sleep(5)",
				{
					timeoutMs: 200,
					sessionId: "py-timeout-test",
				},
			);
			expect(result.cancelled).toBe(true);
			expect(result.output).toContain("before");
			expect(result.output).not.toContain("[kernel] Python kernel shutdown");
			expect(result.failure?.cause).toBe("timeout");
			expect(result.failure?.sessionId).toBe("py-timeout-test");
			expect(result.failure?.runId).toMatch(/^py-/);
		} finally {
			await kernel.shutdown();
		}
	});

	it("log and phase emit status events", async () => {
		using tempDir = TempDir.createSync("@eval-workflow-status-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "log('hello'); phase('Scan')");
			expect(result.exitCode).toBe(0);
			const statuses = result.displayOutputs.filter(
				(o): o is Extract<typeof o, { type: "status" }> => o.type === "status",
			);
			const logEvent = statuses.find(s => s.event.op === "log");
			expect(logEvent).toBeDefined();
			expect(logEvent?.event.message).toBe("hello");
			const phaseEvent = statuses.find(s => s.event.op === "phase");
			expect(phaseEvent).toBeDefined();
			expect(phaseEvent?.event.title).toBe("Scan");
		} finally {
			await kernel.shutdown();
		}
	});
});
