#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type ResolvedThinkingLevel, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { padding, visibleWidth } from "@oh-my-pi/pi-tui";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { generateJsonReport, generateReport } from "./report";
import {
	buildBenchmarkResult,
	type ProgressEvent,
	percentile,
	type RustBenchmarkConfig,
	type RustBenchmarkResult,
	runBenchmark,
} from "./runner";
import { loadTasksFromDir, type RustTask, validateFixturesFromDir } from "./tasks";
import { verifyRustTask } from "./verify";

const COLOR_ENABLED = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
} as const;

const RUNS_DIR = path.resolve(import.meta.dir, "..", "..", "..", "runs");
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";

fs.mkdirSync(RUNS_DIR, { recursive: true });

function paint(code: string, text: string): string {
	return COLOR_ENABLED ? `${code}${text}${ANSI.reset}` : text;
}

function rateColor(percent: number): string {
	if (percent >= 80) return ANSI.green;
	if (percent >= 50) return ANSI.yellow;
	return ANSI.red;
}

function isEnoent(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function stringOption(value: string | boolean | undefined, fallback?: string): string | undefined {
	return typeof value === "string" ? value : fallback;
}

function booleanOption(value: string | boolean | undefined): boolean {
	return value === true;
}

function parseThinkingLevel(value: string | undefined): ResolvedThinkingLevel | undefined {
	const validLevels: readonly string[] = [ThinkingLevel.Off, ...THINKING_EFFORTS];
	if (!value || !validLevels.includes(value)) return undefined;
	return value as ResolvedThinkingLevel;
}

function parseIntegerOption(name: string, value: string | undefined, minimum: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	if (Number.isNaN(parsed) || parsed < minimum) {
		throw new Error(`Invalid ${name} value: ${value}. Must be >= ${minimum}.`);
	}
	return parsed;
}

function parseEditFuzzy(value: string | undefined): boolean | "auto" | undefined {
	if (value === undefined) return undefined;
	if (value === "auto") return "auto";
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	throw new Error(`Invalid edit-fuzzy: ${value}. Must be true, false, 1, 0, or auto.`);
}

function parseEditFuzzyThreshold(value: string | undefined): number | "auto" | undefined {
	if (value === undefined) return undefined;
	if (value === "auto") return "auto";
	const parsed = Number.parseFloat(value);
	if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
		throw new Error(`Invalid edit-fuzzy-threshold: ${value}. Must be 0-1 or auto.`);
	}
	return parsed;
}

function generateReportFilename(config: RustBenchmarkConfig, format: "markdown" | "json"): string {
	const modelName = config.model
		.split("/")
		.pop()!
		.replace(/[^a-zA-Z0-9-]/g, "_");
	const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "").replace(/Z$/, "Z");
	const ext = format === "json" ? "json" : "md";
	return path.join(RUNS_DIR, `rust_${modelName}_${timestamp}.${ext}`);
}

async function resolveConversationDumpDir(outputPath: string): Promise<string> {
	const parsed = path.parse(outputPath);
	const preferredPath = path.join(parsed.dir, `${parsed.name}.dump`);
	try {
		await fs.promises.stat(preferredPath);
	} catch (error) {
		if (isEnoent(error)) return preferredPath;
		throw error;
	}
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(parsed.dir, `${parsed.name}.${timestamp}.dump`);
}

async function conversationDumpStatus(dumpDir: string): Promise<string> {
	try {
		const stat = await fs.promises.stat(dumpDir);
		if (stat.isDirectory()) return `Conversation dumps written to: ${dumpDir}`;
		return `Conversation dump path is not a directory: ${dumpDir}`;
	} catch (error) {
		if (isEnoent(error)) return `No conversation dumps written: ${dumpDir}`;
		throw error;
	}
}

function printUsage(tasks?: readonly RustTask[]): void {
	const taskList = tasks
		? tasks.map(task => `  ${task.id.padEnd(36)} ${task.files.join(", ")}`).join("\n")
		: "  (use --list to see available tasks)";
	console.log(`
Rust Maintainer Benchmark - Evaluate Rust maintenance behavior

Usage:
  bun run bench:rust [options]

Options:
  --model <id>                  default ${DEFAULT_MODEL}
  --provider <id>               default inferred from model prefix, else anthropic
  --thinking <level>            off, minimal, low, medium, high, xhigh; default low
  --runs <n>                    default 1
  --timeout <ms>                agent run timeout; default 180000
  --connection-timeout <ms>     default 30000
  --verification-timeout <ms>   per Cargo/rustfmt command timeout; default 60000
  --max-turns <n>               default 40
  --task-concurrency <n>        default 8
  --tasks <ids>                 comma-separated task ids
  --max-tasks <n>               default 0, where 0 means all
  --fixtures <path>             default packages/rust-maintainer-benchmark/fixtures
  --edit-variant <v>
  --edit-fuzzy <true|false|1|0|auto>
  --edit-fuzzy-threshold <0..1|auto>
  --require-edit-tool-call
  --require-read-tool-call
  --output <file>               default runs/rust_<model>_<timestamp>.md or .json
  --format <markdown|json>      default markdown
  --check-fixtures
  --list
  --help

Available Tasks:
${taskList}
`);
}

async function resolveExtractedDir(tempDir: string): Promise<string> {
	const entries = await fs.promises.readdir(tempDir, { withFileTypes: true });
	const dirs = entries.filter(entry => entry.isDirectory());
	const files = entries.filter(entry => entry.isFile());
	if (dirs.length === 1 && files.length === 0) return path.join(tempDir, dirs[0]!.name);
	return tempDir;
}

async function extractTarGz(archivePath: string): Promise<{ dir: string; cleanupDir: string }> {
	const tempDirObj = await TempDir.create("@rust-maintainer-benchmark-fixtures-");
	const tempDir = tempDirObj.path();
	try {
		const bytes = await Bun.file(archivePath).arrayBuffer();
		const archive = new Bun.Archive(bytes);
		const files = await archive.files();
		for (const [filePath, file] of files) await Bun.write(path.join(tempDir, filePath), file);
	} catch (error) {
		await tempDirObj.remove();
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to extract archive: ${message}`, { cause: error });
	}
	return { dir: await resolveExtractedDir(tempDir), cleanupDir: tempDir };
}

async function resolveFixtureRoot(fixturesArg?: string): Promise<{ dir: string; cleanup?: () => Promise<void> }> {
	const fixturesPath = fixturesArg ?? path.join(import.meta.dir, "../fixtures");
	if (fixturesPath.endsWith(".tar.gz") || fixturesPath.endsWith(".tgz")) {
		const extracted = await extractTarGz(fixturesPath);
		return {
			dir: extracted.dir,
			cleanup: () => fs.promises.rm(extracted.cleanupDir, { recursive: true, force: true }),
		};
	}
	return { dir: fixturesPath };
}

async function resolveFixtures(fixturesArg?: string): Promise<{ tasks: RustTask[]; cleanup?: () => Promise<void> }> {
	const resolved = await resolveFixtureRoot(fixturesArg);
	return { tasks: await loadTasksFromDir(resolved.dir), cleanup: resolved.cleanup };
}

async function checkFixtures(fixturesArg: string | undefined, verificationTimeout: number): Promise<void> {
	const resolved = await resolveFixtureRoot(fixturesArg);
	const issues = await validateFixturesFromDir(resolved.dir);
	try {
		if (issues.length === 0) {
			let tasks: RustTask[] = [];
			try {
				tasks = await loadTasksFromDir(resolved.dir);
			} catch (error) {
				issues.push({ taskId: "(fixtures)", message: error instanceof Error ? error.message : String(error) });
			}
			for (const task of tasks) {
				const verification = await verifyRustTask(task, {
					actualDir: task.expectedDir,
					timeoutMs: verificationTimeout,
				});
				if (!verification.success) {
					issues.push({ taskId: task.id, message: verification.error ?? "expected fixture verification failed" });
				}
			}
		}
		if (issues.length === 0) {
			console.log("Fixtures OK");
			return;
		}
		console.error("Fixture validation failed:");
		for (const issue of issues) console.error(`  - ${issue.taskId}: ${issue.message}`);
		process.exit(1);
	} finally {
		await resolved.cleanup?.();
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			provider: { type: "string" },
			model: { type: "string", default: DEFAULT_MODEL },
			thinking: { type: "string", default: "low" },
			runs: { type: "string", default: "1" },
			timeout: { type: "string", default: "180000" },
			"connection-timeout": { type: "string", default: "30000" },
			"verification-timeout": { type: "string", default: "60000" },
			"max-turns": { type: "string", default: "40" },
			"task-concurrency": { type: "string", default: "8" },
			tasks: { type: "string" },
			"max-tasks": { type: "string", default: "0" },
			fixtures: { type: "string" },
			"edit-variant": { type: "string" },
			"edit-fuzzy": { type: "string" },
			"edit-fuzzy-threshold": { type: "string" },
			"require-edit-tool-call": { type: "boolean", default: false },
			"require-read-tool-call": { type: "boolean", default: false },
			output: { type: "string" },
			format: { type: "string", default: "markdown" },
			"check-fixtures": { type: "boolean", default: false },
			list: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});

	if (booleanOption(values.help)) {
		printUsage();
		process.exit(0);
	}

	const model = stringOption(values.model, DEFAULT_MODEL)!;
	const slashIndex = model.indexOf("/");
	const provider = stringOption(values.provider) ?? (slashIndex !== -1 ? model.slice(0, slashIndex) : "anthropic");
	const thinkingRaw = stringOption(values.thinking, "low")!;
	const thinkingLevel = parseThinkingLevel(thinkingRaw);
	if (!thinkingLevel)
		throw new Error(
			`Invalid thinking level: ${thinkingRaw}. Valid levels: ${[ThinkingLevel.Off, ...THINKING_EFFORTS].join(", ")}`,
		);

	const runsPerTask = parseIntegerOption("runs", stringOption(values.runs), 1);
	const timeout = parseIntegerOption("timeout", stringOption(values.timeout), 1000);
	const connectionTimeout = parseIntegerOption("connection-timeout", stringOption(values["connection-timeout"]), 1);
	const verificationTimeout = parseIntegerOption(
		"verification-timeout",
		stringOption(values["verification-timeout"]),
		1,
	);
	const maxTurns = parseIntegerOption("max-turns", stringOption(values["max-turns"]), 1);
	const taskConcurrency = parseIntegerOption("task-concurrency", stringOption(values["task-concurrency"]), 1);
	const maxTasks = parseIntegerOption("max-tasks", stringOption(values["max-tasks"]), 0);
	const fixturesArg = stringOption(values.fixtures);

	if (booleanOption(values["check-fixtures"])) {
		await checkFixtures(fixturesArg, verificationTimeout);
		process.exit(0);
	}

	const { tasks: allTasks, cleanup } = await resolveFixtures(fixturesArg);
	if (booleanOption(values.list)) {
		console.log("Available Tasks:\n");
		for (const task of allTasks) {
			console.log(`  ${task.id}`);
			console.log(`    Files: ${task.files.join(", ")}`);
			console.log("");
		}
		await cleanup?.();
		process.exit(0);
	}

	let tasksToRun = allTasks;
	const taskFilter = stringOption(values.tasks);
	if (taskFilter) {
		const taskIds = taskFilter
			.split(",")
			.map(id => id.trim())
			.filter(Boolean);
		tasksToRun = [];
		for (const id of taskIds) {
			const task = allTasks.find(candidate => candidate.id === id);
			if (!task)
				throw new Error(
					`Unknown task ID: ${id}. Available tasks: ${allTasks.map(candidate => candidate.id).join(", ")}`,
				);
			tasksToRun.push(task);
		}
	}
	if (maxTasks > 0 && tasksToRun.length > maxTasks && !taskFilter) {
		const sorted = tasksToRun.slice().sort((left, right) => left.id.localeCompare(right.id));
		const step = sorted.length / maxTasks;
		tasksToRun = Array.from({ length: maxTasks }, (_, index) => sorted[Math.floor(index * step)]!);
	}

	const formatRaw = stringOption(values.format, "markdown")!;
	if (formatRaw !== "markdown" && formatRaw !== "json")
		throw new Error(`Invalid format: ${formatRaw}. Must be markdown or json.`);
	const formatType: "markdown" | "json" = formatRaw;
	const editVariantRaw = stringOption(values["edit-variant"]);
	const config: RustBenchmarkConfig = {
		provider,
		model,
		thinkingLevel,
		runsPerTask,
		timeout,
		connectionTimeout,
		verificationTimeout,
		maxTurns,
		taskConcurrency,
		requireEditToolCall: booleanOption(values["require-edit-tool-call"]),
		requireReadToolCall: booleanOption(values["require-read-tool-call"]),
		editVariant: editVariantRaw === "" ? undefined : editVariantRaw,
		editFuzzy: parseEditFuzzy(stringOption(values["edit-fuzzy"])),
		editFuzzyThreshold: parseEditFuzzyThreshold(stringOption(values["edit-fuzzy-threshold"])),
	};
	const outputPath = stringOption(values.output) ?? generateReportFilename(config, formatType);
	config.conversationDumpDir = await resolveConversationDumpDir(outputPath);

	console.log("Rust Maintainer Benchmark");
	console.log("=========================");
	console.log(`Provider: ${config.provider}`);
	console.log(`Model: ${config.model}`);
	console.log(`Thinking: ${config.thinkingLevel}`);
	console.log(`Runs per task: ${config.runsPerTask}`);
	console.log(`Timeout: ${config.timeout}ms`);
	console.log(`Verification timeout: ${config.verificationTimeout}ms`);
	console.log(`Task concurrency: ${config.taskConcurrency}`);
	if (config.requireEditToolCall) console.log("Require edit tool call: yes");
	if (config.requireReadToolCall) console.log("Require read tool call: yes");
	if (config.editVariant) console.log(`Edit variant: ${config.editVariant}`);
	if (config.editFuzzy !== undefined) console.log(`Edit fuzzy: ${config.editFuzzy}`);
	if (config.editFuzzyThreshold !== undefined) console.log(`Edit fuzzy threshold: ${config.editFuzzyThreshold}`);
	console.log(`Tasks: ${tasksToRun.length}`);
	console.log(`Conversation dumps: ${config.conversationDumpDir}`);
	console.log("");

	const progress = new LiveProgress(tasksToRun.length * config.runsPerTask, config.runsPerTask);
	let latestResult = buildBenchmarkResult({
		tasks: tasksToRun,
		config,
		resultsByTask: new Map(),
		startTime: new Date().toISOString(),
	});
	let progressFinished = false;
	let reportWritePromise: Promise<void> | undefined;
	const finishProgress = () => {
		if (progressFinished) return;
		progress.finish();
		progressFinished = true;
	};
	const writeReport = async (result: RustBenchmarkResult, interrupted: boolean) => {
		if (reportWritePromise) return reportWritePromise;
		reportWritePromise = (async () => {
			if (interrupted) {
				console.log("");
				console.log("Benchmark interrupted; writing partial report...");
			}
			const report = formatType === "json" ? generateJsonReport(result) : generateReport(result);
			await Bun.write(outputPath, report);
			console.log(`Report written to: ${outputPath}`);
			if (config.conversationDumpDir) console.log(await conversationDumpStatus(config.conversationDumpDir));
		})();
		return reportWritePromise;
	};
	const unregisterReportCleanup = postmortem.register("rust-maintainer-benchmark-report", async reason => {
		if (reason === postmortem.Reason.EXIT) return;
		finishProgress();
		await writeReport(latestResult, true);
		await cleanup?.();
	});

	const result = await runBenchmark(
		tasksToRun,
		config,
		event => progress.handleEvent(event),
		snapshot => {
			latestResult = snapshot;
		},
	);
	latestResult = result;
	finishProgress();

	console.log("");
	console.log("Benchmark complete!");
	console.log(
		`  Task success rate (best of ${config.runsPerTask}): ${(result.summary.taskSuccessRate * 100).toFixed(1)}% (${result.summary.successfulTasks}/${result.summary.totalTasks})`,
	);
	console.log(
		`  Total best-run tokens: ${result.summary.totalTokens.input} in / ${result.summary.totalTokens.output} out`,
	);
	console.log(
		`  Tokens/task (best): mean=${result.summary.avgTokensPerTask.total} median=${result.summary.medianTokensPerTask.total} p1=${result.summary.p1TokensPerTask.total} p99=${result.summary.p99TokensPerTask.total} reasoning=${result.summary.avgTokensPerTask.reasoning}`,
	);
	if (result.summary.timeoutRuns > 0) console.log(`  Timeout runs: ${result.summary.timeoutRuns}`);
	if (result.summary.ghostRuns > 0) console.log(`  Ghost runs (0 tokens, 0 tool calls): ${result.summary.ghostRuns}`);
	console.log("");

	await writeReport(result, false);
	unregisterReportCleanup();
	await cleanup?.();
	await postmortem.quit(0);
}

class LiveProgress {
	readonly #totalRuns: number;
	readonly #runsPerTask: number;
	readonly #isTty: boolean;
	#started = 0;
	#completed = 0;
	#success = 0;
	#totalTokens = 0;
	#totalDuration = 0;
	#totalReads = 0;
	#totalEdits = 0;
	#totalWrites = 0;
	#totalBash = 0;
	#tokens: number[] = [];
	#oneShotSuccessTokens: number[] = [];
	#lastLineLength = 0;

	constructor(totalRuns: number, runsPerTask: number) {
		this.#totalRuns = totalRuns;
		this.#runsPerTask = runsPerTask;
		this.#isTty = Boolean(process.stdout.isTTY);
	}

	handleEvent(event: ProgressEvent): void {
		if (event.status === "started") {
			this.#started++;
			if (!this.#isTty) console.log(`  [${event.taskId}] Run ${event.runIndex + 1}/${this.#runsPerTask} started...`);
			this.#renderLine();
			return;
		}

		this.#completed++;
		if (event.result) {
			if (event.result.success) this.#success++;
			if (event.result.success && event.runIndex === 0) this.#oneShotSuccessTokens.push(event.result.tokens.total);
			this.#totalTokens += event.result.tokens.total;
			this.#tokens.push(event.result.tokens.total);
			this.#totalDuration += event.result.duration;
			this.#totalReads += event.result.toolCalls.read;
			this.#totalEdits += event.result.toolCalls.edit;
			this.#totalWrites += event.result.toolCalls.write;
			this.#totalBash += event.result.toolCalls.bash;
		}

		const result = event.result;
		if (result && !result.success && result.error) {
			this.#flushLine();
			console.log(
				`  ${paint(ANSI.red, `[${event.taskId}] Run ${event.runIndex + 1}/${this.#runsPerTask} failed:`)} ${result.error}`,
			);
			if (result.diff) {
				const changeLines = result.diff
					.split("\n")
					.filter(line => /^[-+@]/.test(line) && !/^(---|\+\+\+)/.test(line));
				for (const line of changeLines.slice(0, 40)) console.log(`    ${line}`);
				if (changeLines.length > 40)
					console.log(paint(ANSI.dim, `    ... (${changeLines.length - 40} more change lines)`));
			}
		}

		if (!this.#isTty) {
			const status = event.result?.success ? "completed" : "failed";
			console.log(`  [${event.taskId}] Run ${event.runIndex + 1}/${this.#runsPerTask} ${status}`);
		}
		this.#renderLine();
	}

	finish(): void {
		this.#flushLine();
		this.#printSummary();
	}

	#printSummary(): void {
		const denominator = this.#completed || 1;
		const successRate = (this.#success / denominator) * 100;
		console.log("");
		console.log(paint(ANSI.bold, "Runtime Stats:"));
		console.log(`  Completed:       ${this.#completed}/${this.#totalRuns}`);
		console.log(
			`  Successes:       ${paint(rateColor(successRate), `${successRate.toFixed(1)}% (${this.#success}/${this.#completed})`)}`,
		);
		console.log(
			`  Tool calls:      read=${this.#totalReads} edit=${this.#totalEdits} write=${this.#totalWrites} bash=${this.#totalBash}`,
		);
		console.log(`  Avg duration:    ${Math.round(this.#totalDuration / denominator)}ms`);
		console.log(`  Tokens/task:     ${this.#formatTokens(this.#tokens)}`);
		console.log(`  One-shot tokens: ${this.#formatTokens(this.#oneShotSuccessTokens)}`);
	}

	#formatTokens(samples: readonly number[]): string {
		if (samples.length === 0) return "mean=0 median=0 p1=0 p99=0";
		const sorted = [...samples].sort((left, right) => left - right);
		const mean = Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length);
		return `mean=${mean} median=${Math.round(percentile(sorted, 50))} p1=${Math.round(percentile(sorted, 1))} p99=${Math.round(percentile(sorted, 99))}`;
	}

	#renderLine(): void {
		if (!this.#isTty) return;
		const successRate = this.#completed > 0 ? (this.#success / this.#completed) * 100 : 0;
		const avgTokens = this.#completed > 0 ? Math.round(this.#totalTokens / this.#completed) : 0;
		const avgDuration = this.#completed > 0 ? Math.round(this.#totalDuration / this.#completed) : 0;
		const inFlight = this.#started - this.#completed;
		const bar = this.#renderBar(this.#completed, this.#totalRuns, 20);
		const line = `  ${bar} ${paint(ANSI.bold, `${this.#completed}/${this.#totalRuns}`)} ok=${paint(rateColor(successRate), `${successRate.toFixed(0)}%`)} tok=${paint(ANSI.dim, String(avgTokens))} dur=${paint(ANSI.dim, `${avgDuration}ms`)} r/e/w/b=${this.#totalReads}/${this.#totalEdits}/${this.#totalWrites}/${this.#totalBash} fly=${paint(ANSI.cyan, String(inFlight))}`;
		this.#writeLine(line);
	}

	#renderBar(done: number, total: number, width: number): string {
		const ratio = total === 0 ? 0 : done / total;
		const filled = Math.round(ratio * width);
		const empty = Math.max(0, width - filled);
		return `[${paint(ANSI.green, "#".repeat(filled))}${paint(ANSI.dim, "-".repeat(empty))}]`;
	}

	#writeLine(line: string): void {
		const lineWidth = visibleWidth(line);
		const pad = this.#lastLineLength > lineWidth ? padding(this.#lastLineLength - lineWidth) : "";
		process.stdout.write(`\r${line}${pad}`);
		this.#lastLineLength = lineWidth;
	}

	#flushLine(): void {
		if (!this.#isTty) return;
		if (this.#lastLineLength > 0) {
			process.stdout.write(`\r${padding(this.#lastLineLength)}\r`);
			this.#lastLineLength = 0;
		}
	}
}

main().catch(async error => {
	console.error("Benchmark failed:", error);
	await postmortem.quit(1);
});
