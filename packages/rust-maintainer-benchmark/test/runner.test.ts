import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { formatSessionDumpText, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { TempDir } from "@oh-my-pi/pi-utils";
import { generateReport } from "@oh-my-pi/rust-maintainer-benchmark/report";
import {
	buildBenchmarkResult,
	type RustTaskRunResult,
	writeConversationDump,
} from "@oh-my-pi/rust-maintainer-benchmark/runner";
import type { RustTask } from "@oh-my-pi/rust-maintainer-benchmark/tasks";

const tempDirs: TempDir[] = [];

async function createTempDir(prefix: string): Promise<TempDir> {
	const dir = await TempDir.create(prefix);
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function createTask(id: string): RustTask {
	return {
		id,
		name: id,
		prompt: `Fix ${id}`,
		files: [`${id}.rs`],
		inputDir: "/tmp/input",
		expectedDir: "/tmp/expected",
		metadata: {
			category: "compiler-repair",
			difficulty: "easy",
			crateRoot: ".",
			verification: { rustfmt: true, exactMatch: "required", commands: [] },
		},
	};
}

function createRun(runIndex: number, success: boolean, overrides: Partial<RustTaskRunResult> = {}): RustTaskRunResult {
	return {
		runIndex,
		success,
		patchApplied: success,
		verificationPassed: success,
		category: "compiler-repair",
		difficulty: "easy",
		tokens: { input: 12, output: 8, reasoning: 0, total: 20 },
		duration: 100,
		changedFiles: success ? ["src/lib.rs"] : [],
		checks: [],
		toolCalls: {
			read: 1,
			edit: 1,
			write: 0,
			bash: 0,
			editSuccesses: success ? 1 : 0,
			editFailures: success ? 0 : 1,
			editWarnings: 0,
			editAutocorrects: 0,
			totalInputChars: 50,
		},
		editFailures: [],
		editWarnings: [],
		editAutocorrectCount: 0,
		...overrides,
	};
}

const CONFIG = {
	provider: "anthropic",
	model: "claude",
	runsPerTask: 2,
	timeout: 1000,
	taskConcurrency: 1,
};

describe("buildBenchmarkResult", () => {
	it("summarizes completed runs without requiring every scheduled run to finish", () => {
		const completedTask = createTask("completed");
		const pendingTask = createTask("pending");
		const result = buildBenchmarkResult({
			tasks: [completedTask, pendingTask],
			config: CONFIG,
			resultsByTask: new Map([[completedTask.id, [createRun(0, true)]]]),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		expect(result.summary.totalTasks).toBe(2);
		expect(result.summary.totalRuns).toBe(1);
		expect(result.summary.successfulRuns).toBe(1);
		expect(result.tasks.find(task => task.id === "pending")?.runs).toEqual([]);
		expect(result.startTime).toBe("2026-04-28T00:00:00.000Z");
		expect(result.endTime).toBe("2026-04-28T00:00:01.000Z");
	});

	it("can generate a report before any run completes", () => {
		const result = buildBenchmarkResult({
			tasks: [createTask("pending")],
			config: CONFIG,
			resultsByTask: new Map(),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		expect(result.summary.totalRuns).toBe(0);
		expect(generateReport(result)).toContain("| Total completed runs | 0 |");
	});

	it("picks the successful run with the lowest tokens as the task best", () => {
		const task = createTask("best");
		const losing = createRun(0, false, { tokens: { input: 5, output: 5, reasoning: 0, total: 10 } });
		const winning = createRun(1, true, { tokens: { input: 100, output: 50, reasoning: 0, total: 150 } });
		const expensive = createRun(2, true, { tokens: { input: 500, output: 250, reasoning: 0, total: 750 } });

		const result = buildBenchmarkResult({
			tasks: [task],
			config: { ...CONFIG, runsPerTask: 3 },
			resultsByTask: new Map([[task.id, [losing, winning, expensive]]]),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		expect(result.tasks[0]?.success).toBe(true);
		expect(result.tasks[0]?.bestRunIndex).toBe(1);
		expect(result.tasks[0]?.tokens.total).toBe(150);
		expect(result.summary.successfulTasks).toBe(1);
		expect(result.summary.successfulRuns).toBe(2);
		expect(result.summary.totalTokens.total).toBe(150);
		expect(result.summary.flakyTasks).toBe(1);
		expect(result.summary.consistentlyPassingTasks).toBe(0);
	});

	it("falls back to the cheapest non-ghost failure when no run succeeded", () => {
		const task = createTask("none");
		const ghostRun = createRun(0, false, {
			tokens: { input: 0, output: 0, reasoning: 0, total: 0 },
			toolCalls: {
				read: 0,
				edit: 0,
				write: 0,
				bash: 0,
				editSuccesses: 0,
				editFailures: 0,
				editWarnings: 0,
				editAutocorrects: 0,
				totalInputChars: 0,
			},
		});
		const expensiveFail = createRun(1, false, { tokens: { input: 200, output: 100, reasoning: 0, total: 300 } });
		const cheapFail = createRun(2, false, { tokens: { input: 20, output: 10, reasoning: 0, total: 30 } });

		const result = buildBenchmarkResult({
			tasks: [task],
			config: { ...CONFIG, runsPerTask: 3 },
			resultsByTask: new Map([[task.id, [ghostRun, expensiveFail, cheapFail]]]),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		expect(result.tasks[0]?.success).toBe(false);
		expect(result.tasks[0]?.bestRunIndex).toBe(2);
		expect(result.tasks[0]?.tokens.total).toBe(30);
		expect(result.summary.ghostRuns).toBe(1);
	});

	it("reports median, p1, and p99 token stats across best runs", () => {
		const totals = [110, 220, 330, 440, 550];
		const tasks = totals.map((_, index) => createTask(`t${index}`));
		const resultsByTask = new Map(
			totals.map((total, index) => [
				tasks[index]!.id,
				[
					createRun(0, true, {
						tokens: { input: (index + 1) * 100, output: (index + 1) * 10, reasoning: 0, total },
					}),
				],
			]),
		);

		const result = buildBenchmarkResult({
			tasks,
			config: { ...CONFIG, runsPerTask: 1 },
			resultsByTask,
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		expect(result.summary.avgTokensPerTask.total).toBe(330);
		expect(result.summary.medianTokensPerTask).toEqual({ input: 300, output: 30, reasoning: 0, total: 330 });
		expect(result.summary.p1TokensPerTask).toEqual({ input: 104, output: 10, reasoning: 0, total: 114 });
		expect(result.summary.p99TokensPerTask).toEqual({ input: 496, output: 50, reasoning: 0, total: 546 });
	});

	it("separates token stats for successfully one-shot tasks vs best runs", () => {
		const tasks = [createTask("t1"), createTask("t2"), createTask("t3")];
		const resultsByTask = new Map([
			["t1", [createRun(0, true, { tokens: { input: 80, output: 20, reasoning: 0, total: 100 } })]],
			[
				"t2",
				[
					createRun(0, false, { tokens: { input: 120, output: 30, reasoning: 0, total: 150 } }),
					createRun(1, true, { tokens: { input: 40, output: 10, reasoning: 0, total: 50 } }),
				],
			],
			["t3", [createRun(0, false, { tokens: { input: 160, output: 40, reasoning: 0, total: 200 } })]],
		]);

		const result = buildBenchmarkResult({
			tasks,
			config: CONFIG,
			resultsByTask,
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		expect(result.summary.totalTokens.total).toBe(350);
		expect(result.summary.avgTokensPerTask.total).toBe(Math.round(350 / 3));
		expect(result.summary.successfulOneShotTasks).toBe(1);
		expect(result.summary.totalOneShotSuccessTokens.total).toBe(100);
		expect(result.summary.avgOneShotSuccessTokensPerTask.total).toBe(100);
	});

	it("separates Cargo, exact, and allowed-file failure counters", () => {
		const task = createTask("checks");
		const result = buildBenchmarkResult({
			tasks: [task],
			config: { ...CONFIG, runsPerTask: 4 },
			resultsByTask: new Map([
				[
					task.id,
					[
						createRun(0, false, {
							exactMatched: false,
							exactMatchMode: "required",
							checks: [{ name: "exact match", kind: "exact", required: true, success: false }],
						}),
						createRun(1, true, {
							exactMatched: false,
							exactMatchMode: "preferred",
							checks: [{ name: "exact match", kind: "exact", required: false, success: false }],
						}),
						createRun(2, false, {
							checks: [{ name: "cargo fmt", kind: "cargo", required: true, success: false }],
						}),
						createRun(3, false, {
							checks: [
								{
									name: "allowed changed files",
									kind: "metadata",
									required: true,
									success: false,
								},
							],
						}),
					],
				],
			]),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		expect(result.summary.rustCheckFailures).toEqual({ "cargo fmt": 1 });
		expect(result.summary.exactMatchFailures).toBe(1);
		expect(result.summary.preferredExactMismatches).toBe(1);
		expect(result.summary.allowedChangedFileFailures).toBe(1);
		expect(result.summary.successfulRuns).toBe(1);
	});
});

describe("writeConversationDump", () => {
	it("writes benchmark conversations as session dumps and copies artifacts", async () => {
		const sourceRoot = await createTempDir("@rust-maintainer-benchmark-source-");
		const dumpRoot = await createTempDir("@rust-maintainer-benchmark-dump-");
		const sourceWorkDir = sourceRoot.join("worktree");
		const sourceSessionDir = sourceRoot.join("sessions");
		await fs.mkdir(sourceWorkDir, { recursive: true });
		await fs.mkdir(sourceSessionDir, { recursive: true });

		const sourceSession = SessionManager.create(sourceWorkDir, sourceSessionDir);
		const userMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "Fix the failing Rust benchmark." }],
			attribution: "user",
			timestamp: Date.now(),
		};
		sourceSession.appendMessage(userMessage);
		await sourceSession.ensureOnDisk();
		const artifactId = await sourceSession.saveArtifact("artifact contents", "read");
		await sourceSession.flush();
		await sourceSession.close();

		const sourceSessionFile = sourceSession.getSessionFile();
		if (!sourceSessionFile || !artifactId) throw new Error("Test fixture failed to create source session dump");
		const sourceArtifactPath = await sourceSession.getArtifactPath(artifactId);
		if (!sourceArtifactPath) throw new Error("Test fixture failed to resolve source artifact path");

		const dumpPath = await writeConversationDump({
			dumpDir: dumpRoot.absolute(),
			taskId: "task/weird",
			runIndex: 0,
			snapshot: { messages: [userMessage], sourceSessionFile },
		});

		expect(dumpPath).toBe(path.join(dumpRoot.absolute(), "task_weird", "run-1.md"));
		expect((await Bun.file(dumpPath).text()).trim()).toBe(formatSessionDumpText({ messages: [userMessage] }).trim());
		expect(await Bun.file(path.join(dumpPath.slice(0, -3), path.basename(sourceArtifactPath))).text()).toBe(
			"artifact contents",
		);
	});
});
