import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExecutorBackendExecOptions, ExecutorBackendResult } from "@oh-my-pi/pi-coding-agent/eval/backend";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import type { EvalFailureCause, EvalFailureInfo } from "@oh-my-pi/pi-coding-agent/eval/types";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import pythonBackend from "../../src/eval/py";

type EvalToolSession = NonNullable<ConstructorParameters<typeof EvalTool>[0]>;

function makeSession(): EvalToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => "eval-tool-test-session",
		allocateOutputArtifact: async () => ({ id: "eval-tool-artifact" }),
		settings: Settings.isolated(),
	} as unknown as EvalToolSession;
}

const originalPythonBackend = {
	isAvailable: pythonBackend.isAvailable,
	execute: pythonBackend.execute,
};

function restorePythonBackend(): void {
	pythonBackend.isAvailable = originalPythonBackend.isAvailable;
	pythonBackend.execute = originalPythonBackend.execute;
}

function installPythonFailureBackend(options: {
	cause: EvalFailureCause;
	cancelled: boolean;
	exitCode: number | undefined;
	title: string;
	kernelKilled: boolean;
	sideEffects: EvalFailureInfo["sideEffects"];
}): void {
	pythonBackend.isAvailable = async () => true;
	pythonBackend.execute = async (
		_code: string,
		execOptions: ExecutorBackendExecOptions,
	): Promise<ExecutorBackendResult> => {
		const streamText = `${options.title} stream`;
		execOptions.onChunk(streamText);
		const failure: EvalFailureInfo = {
			cause: options.cause,
			message: `${options.title} message`,
			runId: "py-run-structured",
			kernelId: "kernel-structured",
			sessionId: execOptions.sessionId,
			kernelSession: `${execOptions.sessionId} @ ${execOptions.cwd}`,
			artifactId: execOptions.artifactId,
			kernelKilled: options.kernelKilled,
			sideEffects: options.sideEffects,
			recovery: `${options.title} recovery`,
		};
		return {
			output: streamText,
			exitCode: options.exitCode,
			cancelled: options.cancelled,
			truncated: false,
			artifactId: execOptions.artifactId,
			totalLines: 1,
			totalBytes: Buffer.byteLength(streamText, "utf-8"),
			outputLines: 1,
			outputBytes: Buffer.byteLength(streamText, "utf-8"),
			displayOutputs: [],
			failure,
		};
	};
}

/**
 * Defends the contract that a cell which does not delegate to an `agent()`/
 * `llm()` bridge call is bounded by a *plain wall-clock* timeout — not the
 * activity watchdog, which now only extends the budget while a bridge call is in
 * flight. Regression guard for the watchdog killing ordinary compute cells and
 * surfacing a misleading "of inactivity" message.
 */
describe("EvalTool timeout semantics", () => {
	afterAll(async () => {
		await disposeAllVmContexts();
	});

	afterEach(() => {
		restorePythonBackend();
	});

	it("bounds a compute cell (no agent/llm) by a plain wall-clock timeout", async () => {
		const tool = new EvalTool(makeSession());
		// 1s budget; the cell idles for 5s and emits no status, so nothing extends
		// the budget — it must be cut off at the wall-clock limit.
		const result = await tool.execute("call-compute-timeout", {
			cells: [{ language: "js", code: "await Bun.sleep(5000); return 'never';", timeout: 1 }],
		});

		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(text).toContain("timed out after 1 seconds");
		// The new wording is a plain wall-clock timeout, not an inactivity stall.
		expect(text).not.toContain("inactivity");
		expect(text).not.toContain("never");

		const cell = result.details?.cells?.[0];
		expect(cell?.exitCode).toBeUndefined();
	});

	it("forwards structured Python executor abort failures through the backend", async () => {
		const controller = new AbortController();
		controller.abort(new Error("caller aborted eval"));
		const result = await originalPythonBackend.execute("print('unreached')", {
			cwd: process.cwd(),
			sessionId: "backend-abort",
			sessionFile: undefined,
			kernelOwnerId: undefined,
			signal: controller.signal,
			session: makeSession(),
			idleTimeoutMs: 1_000,
			reset: false,
			artifactPath: undefined,
			artifactId: "backend-artifact",
			onChunk: () => {},
		});

		expect(result.cancelled).toBe(true);
		expect(result.failure?.cause).toBe("abort");
		expect(result.failure?.sessionId).toBe("python:backend-abort");
		expect(result.failure?.artifactId).toBe("backend-artifact");
		expect(result.failure?.sideEffects).toBe("none");
	});
	it("surfaces structured reset-race failures from Python executor results", async () => {
		installPythonFailureBackend({
			cause: "reset",
			cancelled: false,
			exitCode: 1,
			title: "reset race",
			kernelKilled: false,
			sideEffects: "none",
		});
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-reset-race", {
			cells: [{ language: "py", code: "print('unreached')", title: "reset race" }],
		});

		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(text).toContain("reset race stream");
		expect(text).toContain('Python eval failure in cell 1 "reset race"');
		expect(text).toContain("cause: reset");
		expect(text).toContain("context: session=eval-tool-test-session kernelSession=eval-tool-test-session @ ");
		expect(text).toContain("run=py-run-structured kernel=kernel-structured");
		expect(text).toContain("artifact: artifact://eval-tool-artifact");
		expect(text).toContain("kernelKilled: no");
		expect(text).toContain("sideEffects: none");
		expect(text).toContain("recovery: reset race recovery");
		expect(result.details?.failure?.cause).toBe("reset");
		expect(result.details?.cells?.[0]?.title).toBe("reset race");
		expect(result.details?.cells?.[0]?.failure?.cause).toBe("reset");
	});

	it("surfaces structured shutdown cancellations with partial output", async () => {
		installPythonFailureBackend({
			cause: "shutdown",
			cancelled: true,
			exitCode: undefined,
			title: "shutdown",
			kernelKilled: true,
			sideEffects: "unknown",
		});
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-shutdown", {
			cells: [{ language: "py", code: "while True: pass", title: "shutdown cell" }],
		});

		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(text).toContain("shutdown stream");
		expect(text).toContain('Python eval failure in cell 1 "shutdown cell"');
		expect(text).toContain("cause: shutdown");
		expect(text).toContain("artifact: artifact://eval-tool-artifact");
		expect(text).toContain("kernelKilled: yes");
		expect(text).toContain("sideEffects: unknown");
		expect(text).toContain("recovery: shutdown recovery");
		expect(result.details?.isError).toBe(true);
		expect(result.details?.failure?.cause).toBe("shutdown");
		expect(result.details?.cells?.[0]?.failure?.kernelKilled).toBe(true);
	});
});
