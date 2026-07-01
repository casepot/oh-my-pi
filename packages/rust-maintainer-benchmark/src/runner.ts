import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage, ResolvedThinkingLevel, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ToolExample } from "@oh-my-pi/pi-ai";
import { formatSessionDumpText } from "@oh-my-pi/pi-coding-agent";
import { prompt as promptUtil } from "@oh-my-pi/pi-utils";
import { discoverSharedInfra, InProcessClient, type SharedInfra } from "./in-process-client";
import benchmarkRetryPrompt from "./prompts/benchmark-retry.md" with { type: "text" };
import benchmarkSystemPrompt from "./prompts/benchmark-system.md" with { type: "text" };
import benchmarkTaskPrompt from "./prompts/benchmark-task.md" with { type: "text" };
import type { ExactMatchMode, RustTask } from "./tasks";
import type { RustCheckResult } from "./verify";
import { verifyRustTask } from "./verify";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const RUNS_DIR = path.join(REPO_ROOT, "runs");
const TMP = path.join(RUNS_DIR, `rust-bench-${Math.random().toString(36).slice(2, 10)}`);

export const BENCHMARK_TOOL_NAMES = ["read", "edit", "write", "apply_patch", "bash"] as const;

fs.mkdirSync(TMP, { recursive: true });

let tempIndex = 0;

export interface RustBenchmarkConfig {
	provider: string;
	model: string;
	thinkingLevel?: ResolvedThinkingLevel;
	runsPerTask: number;
	timeout: number;
	connectionTimeout?: number;
	maxTurns?: number;
	taskConcurrency: number;
	requireEditToolCall?: boolean;
	requireReadToolCall?: boolean;
	editVariant?: string;
	editFuzzy?: boolean | "auto";
	editFuzzyThreshold?: number | "auto";
	verificationTimeout?: number;
	conversationDumpDir?: string;
}

export interface TokenStats {
	input: number;
	output: number;
	reasoning: number;
	total: number;
}

export interface ToolCallStats {
	read: number;
	edit: number;
	write: number;
	bash: number;
	editSuccesses: number;
	editFailures: number;
	editWarnings: number;
	editAutocorrects: number;
	totalInputChars: number;
}

export interface RustEditFailure {
	toolCallId: string;
	args: unknown;
	error: string;
	rawBlock?: string;
}

export interface RustTaskRunResult {
	runIndex: number;
	success: boolean;
	patchApplied: boolean;
	verificationPassed: boolean;
	category?: string;
	difficulty?: string;
	difficultyScore?: number;
	error?: string;
	tokens: TokenStats;
	duration: number;
	agentResponse?: string;
	diff?: string;
	diffStats?: { linesChanged: number; charsChanged: number };
	exactMatched?: boolean;
	exactMatchMode?: ExactMatchMode;
	changedFiles: string[];
	checks: RustCheckResult[];
	toolCalls: ToolCallStats;
	editFailures: RustEditFailure[];
	editWarnings: string[];
	editAutocorrectCount: number;
}

export interface ProgressEvent {
	taskId: string;
	runIndex: number;
	status: "started" | "completed";
	result?: RustTaskRunResult;
}

export interface RustTaskResult {
	id: string;
	name: string;
	files: string[];
	category?: string;
	difficulty?: string;
	runs: RustTaskRunResult[];
	bestRunIndex: number;
	success: boolean;
	tokens: TokenStats;
	duration: number;
	changedFiles: string[];
	checks: RustCheckResult[];
	toolCalls: ToolCallStats;
	editSuccessRate: number;
	autocorrectFreeSuccess: boolean;
	flakeSuccessRate: number;
}

export interface TokenDistribution {
	median: TokenStats;
	p1: TokenStats;
	p99: TokenStats;
}

export interface RustBenchmarkSummary {
	totalTasks: number;
	totalRuns: number;
	successfulRuns: number;
	successfulTasks: number;
	taskSuccessRate: number;
	flakyTasks: number;
	consistentlyPassingTasks: number;
	successfulOneShotTasks: number;
	totalOneShotSuccessTokens: TokenStats;
	avgOneShotSuccessTokensPerTask: TokenStats;
	medianOneShotSuccessTokensPerTask: TokenStats;
	p1OneShotSuccessTokensPerTask: TokenStats;
	p99OneShotSuccessTokensPerTask: TokenStats;
	totalTokens: TokenStats;
	avgTokensPerTask: TokenStats;
	medianTokensPerTask: TokenStats;
	p1TokensPerTask: TokenStats;
	p99TokensPerTask: TokenStats;
	totalDuration: number;
	avgDurationPerTask: number;
	totalToolCalls: ToolCallStats;
	avgToolCallsPerTask: ToolCallStats;
	editSuccessRate: number;
	autocorrectFreeSuccessfulTasks: number;
	autocorrectFreeSuccessRate: number;
	autocorrectedBestRuns: number;
	editAutocorrectRate: number;
	timeoutRuns: number;
	ghostRuns: number;
	transportFailureRuns: number;
	rustCheckFailures: Record<string, number>;
	exactMatchFailures: number;
	preferredExactMismatches: number;
	allowedChangedFileFailures: number;
}

export interface RustBenchmarkResult {
	config: RustBenchmarkConfig;
	tasks: RustTaskResult[];
	summary: RustBenchmarkSummary;
	startTime: string;
	endTime: string;
}

export type ConversationDumpSnapshot = {
	messages: AgentMessage[];
	sourceSessionFile?: string;
	systemPrompt?: string[];
	model?: Model;
	thinkingLevel?: ThinkingLevel | undefined;
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
};

type ConversationDumpSessionState = Omit<ConversationDumpSnapshot, "messages" | "sourceSessionFile"> & {
	sessionFile?: string;
};

type BenchmarkEvent = { type: string; [key: string]: unknown };

interface BenchmarkClient {
	start(): Promise<void>;
	setThinkingLevel(level: ResolvedThinkingLevel): Promise<void>;
	onEvent(listener: (event: BenchmarkEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	getSessionStats(): Promise<SessionTokenStats>;
	getLastAssistantText(): Promise<string | null>;
	getMessages(): Promise<AgentMessage[]>;
	getState(): Promise<ConversationDumpSessionState>;
	abort?(): void;
	dispose(): Promise<void>;
}

interface PendingEditCall {
	args: unknown;
	rawBlock?: string;
}

interface TaskRunItem {
	task: RustTask;
	runIndex: number;
}

type SessionTokenStats = {
	tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number };
	assistantMessages: number;
};

class PromptTimeoutError extends Error {}

class PromptTurnLimitError extends Error {}

function subtmp(prefix: string): string {
	const dir = path.join(TMP, `${prefix}-${tempIndex++}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function sanitizeDumpPathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getConversationDumpPath(dumpDir: string, taskId: string, runIndex: number): string {
	return path.join(dumpDir, sanitizeDumpPathSegment(taskId), `run-${runIndex + 1}.md`);
}

function dumpArtifactsDir(dumpFilePath: string): string {
	if (dumpFilePath.endsWith(".md")) return dumpFilePath.slice(0, -3);
	if (dumpFilePath.endsWith(".jsonl")) return dumpFilePath.slice(0, -6);
	const ext = path.extname(dumpFilePath);
	return path.join(path.dirname(dumpFilePath), path.basename(dumpFilePath, ext));
}

function hasProperty<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
	return value !== null && typeof value === "object" && key in value;
}

function isEnoent(error: unknown): boolean {
	return hasProperty(error, "code") && error.code === "ENOENT";
}

async function copyConversationArtifacts(sourceSessionFile: string, targetDumpFile: string): Promise<void> {
	const sourceArtifactsDir = dumpArtifactsDir(sourceSessionFile);
	const targetArtifactsDir = dumpArtifactsDir(targetDumpFile);
	try {
		const stat = await fs.promises.stat(sourceArtifactsDir);
		if (!stat.isDirectory()) return;
		await fs.promises.cp(sourceArtifactsDir, targetArtifactsDir, { recursive: true });
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
}

export async function writeConversationDump(params: {
	dumpDir: string;
	taskId: string;
	runIndex: number;
	snapshot: ConversationDumpSnapshot;
}): Promise<string> {
	const dumpPath = getConversationDumpPath(params.dumpDir, params.taskId, params.runIndex);
	await fs.promises.mkdir(path.dirname(dumpPath), { recursive: true });
	const body = formatSessionDumpText({
		messages: params.snapshot.messages,
		systemPrompt: params.snapshot.systemPrompt,
		model: params.snapshot.model,
		thinkingLevel: params.snapshot.thinkingLevel,
		tools: params.snapshot.dumpTools,
	});
	await Bun.write(dumpPath, `${body}\n`);
	if (params.snapshot.sourceSessionFile) await copyConversationArtifacts(params.snapshot.sourceSessionFile, dumpPath);
	return dumpPath;
}

async function snapshotConversationDump(client: BenchmarkClient): Promise<ConversationDumpSnapshot> {
	const [messages, state] = await Promise.all([client.getMessages(), client.getState()]);
	return {
		messages,
		sourceSessionFile: state.sessionFile,
		systemPrompt: state.systemPrompt,
		model: state.model,
		thinkingLevel: state.thinkingLevel,
		dumpTools: state.dumpTools,
	};
}

export function buildInstructions(config: RustBenchmarkConfig): string {
	const instructions: string[] = [];
	if (config.requireEditToolCall)
		instructions.push("- You must use an edit tool or apply_patch for the final code change.");
	if (config.requireReadToolCall) instructions.push("- You must read the relevant file before editing.");
	return instructions.join("\n");
}

function buildBenchmarkSystemPrompt(task: RustTask, config: RustBenchmarkConfig): string {
	return promptUtil.render(benchmarkSystemPrompt, {
		multiFile: task.files.length > 1,
		instructions: buildInstructions(config),
	});
}

function buildInitialBenchmarkPrompt(task: RustTask): string {
	return promptUtil.render(benchmarkTaskPrompt, { task_prompt: task.prompt });
}

function buildRetryBenchmarkPrompt(retryContext: string): string {
	return promptUtil.render(benchmarkRetryPrompt, { retry_context: retryContext });
}

function isEditTool(toolName: unknown): boolean {
	return toolName === "edit" || toolName === "vim" || toolName === "apply_patch";
}

function isMutationTool(toolName: unknown): boolean {
	return isEditTool(toolName) || toolName === "write";
}

function emptyToolCallStats(): ToolCallStats {
	return {
		read: 0,
		edit: 0,
		write: 0,
		bash: 0,
		editSuccesses: 0,
		editFailures: 0,
		editWarnings: 0,
		editAutocorrects: 0,
		totalInputChars: 0,
	};
}

function addTokenStats(left: TokenStats, right: TokenStats): TokenStats {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		reasoning: left.reasoning + right.reasoning,
		total: left.total + right.total,
	};
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function diffTokenStats(before: SessionTokenStats, after: SessionTokenStats, systemPromptTokens: number): TokenStats {
	const calls = Math.max(0, after.assistantMessages - before.assistantMessages);
	const overhead = calls * systemPromptTokens;
	const beforePrompt = before.tokens.input + before.tokens.cacheRead + before.tokens.cacheWrite;
	const afterPrompt = after.tokens.input + after.tokens.cacheRead + after.tokens.cacheWrite;
	const input = Math.max(0, afterPrompt - beforePrompt - overhead);
	const output = Math.max(0, after.tokens.output - before.tokens.output);
	const reasoning = Math.max(0, after.tokens.reasoning - before.tokens.reasoning);
	return { input, output, reasoning, total: input + output };
}

function extractToolText(result: unknown): string | null {
	if (typeof result === "string") return result;
	if (!hasProperty(result, "content") || !Array.isArray(result.content)) return null;
	for (const entry of result.content) {
		if (!hasProperty(entry, "text")) continue;
		if (typeof entry.text === "string") return entry.text;
	}
	return null;
}

function extractHashlineWarnings(result: unknown): string[] {
	const text = extractToolText(result);
	if (!text) return [];
	const marker = "Warnings:\n";
	const markerIndex = text.indexOf(marker);
	if (markerIndex === -1) return [];
	return text
		.slice(markerIndex + marker.length)
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

function hasHashlineAutocorrectWarning(warnings: readonly string[]): boolean {
	return warnings.some(warning => warning.startsWith("Auto-corrected "));
}

function extractToolErrorMessage(result: unknown): string {
	const text = extractToolText(result);
	if (text) return text;
	try {
		return JSON.stringify(result);
	} catch {
		return "Unknown error";
	}
}

function extractAssistantToolRawBlocks(event: BenchmarkEvent): Array<{ id: string; rawBlock: string }> {
	if (!hasProperty(event, "message") || !hasProperty(event.message, "role")) return [];
	if (
		event.message.role !== "assistant" ||
		!hasProperty(event.message, "content") ||
		!Array.isArray(event.message.content)
	) {
		return [];
	}
	const rawBlocks: Array<{ id: string; rawBlock: string }> = [];
	for (const block of event.message.content) {
		if (!hasProperty(block, "type") || block.type !== "toolCall") continue;
		if (!hasProperty(block, "id") || !hasProperty(block, "rawBlock")) continue;
		if (typeof block.id !== "string" || typeof block.rawBlock !== "string") continue;
		rawBlocks.push({ id: block.id, rawBlock: block.rawBlock });
	}
	return rawBlocks;
}

function eventString(event: BenchmarkEvent, key: string): string | undefined {
	if (!hasProperty(event, key)) return undefined;
	return typeof event[key] === "string" ? event[key] : undefined;
}

function eventBoolean(event: BenchmarkEvent, key: string): boolean | undefined {
	if (!hasProperty(event, key)) return undefined;
	return typeof event[key] === "boolean" ? event[key] : undefined;
}

function eventValue(event: BenchmarkEvent, key: string): unknown {
	return hasProperty(event, key) ? event[key] : undefined;
}

function jsonLength(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

function recordToolEvents(events: readonly BenchmarkEvent[]): {
	stats: ToolCallStats;
	editFailures: RustEditFailure[];
	editWarnings: string[];
	editAutocorrectCount: number;
	mutationSucceeded: boolean;
} {
	const stats = emptyToolCallStats();
	const editFailures: RustEditFailure[] = [];
	const editWarnings: string[] = [];
	const pendingEdits = new Map<string, PendingEditCall>();
	const rawToolBlocks = new Map<string, string>();
	let editAutocorrectCount = 0;
	let mutationSucceeded = false;

	for (const event of events) {
		if (event.type === "message_end") {
			for (const raw of extractAssistantToolRawBlocks(event)) {
				rawToolBlocks.set(raw.id, raw.rawBlock);
				const pending = pendingEdits.get(raw.id);
				if (pending) pending.rawBlock = raw.rawBlock;
			}
		}
		if (event.type === "tool_execution_start") {
			const toolName = eventString(event, "toolName");
			const toolCallId = eventString(event, "toolCallId");
			const args = eventValue(event, "args");
			if (toolName === "read") stats.read++;
			else if (isEditTool(toolName)) {
				stats.edit++;
				if (toolCallId) pendingEdits.set(toolCallId, { args, rawBlock: rawToolBlocks.get(toolCallId) });
			} else if (toolName === "write") stats.write++;
			else if (toolName === "bash") stats.bash++;
			if (args !== undefined) stats.totalInputChars += jsonLength(args);
		} else if (event.type === "tool_execution_end") {
			const toolName = eventString(event, "toolName");
			const toolCallId = eventString(event, "toolCallId");
			const isError = eventBoolean(event, "isError") ?? false;
			const result = eventValue(event, "result");
			if (isMutationTool(toolName) && !isError) mutationSucceeded = true;
			if (isEditTool(toolName) && toolCallId) {
				const pending = pendingEdits.get(toolCallId) ?? {
					args: undefined,
					rawBlock: rawToolBlocks.get(toolCallId),
				};
				pendingEdits.delete(toolCallId);
				if (isError) {
					stats.editFailures++;
					editFailures.push({
						toolCallId,
						args: pending.args,
						error: extractToolErrorMessage(result),
						rawBlock: pending.rawBlock,
					});
				} else {
					stats.editSuccesses++;
					const warningMessages = extractHashlineWarnings(result);
					if (warningMessages.length > 0) {
						editWarnings.push(...warningMessages);
						stats.editWarnings += warningMessages.length;
						if (hasHashlineAutocorrectWarning(warningMessages)) {
							editAutocorrectCount++;
							stats.editAutocorrects++;
						}
					}
				}
			}
		}
	}

	return { stats, editFailures, editWarnings, editAutocorrectCount, mutationSucceeded };
}

function shuffle<T>(items: T[]): T[] {
	const copy = items.slice();
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j]!, copy[i]!];
	}
	return copy;
}

async function collectPromptEvents(
	client: BenchmarkClient,
	text: string,
	config: RustBenchmarkConfig,
): Promise<BenchmarkEvent[]> {
	const events: BenchmarkEvent[] = [];
	const settled = Promise.withResolvers<void>();
	let isSettled = false;
	let firstEventSeen = false;
	let turnCount = 0;

	const finish = (error?: Error) => {
		if (isSettled) return;
		isSettled = true;
		if (error) settled.reject(error);
		else settled.resolve();
	};

	const timeoutMs = Math.max(1, config.timeout);
	const connectionTimeoutMs = Math.max(1, config.connectionTimeout ?? 30000);
	const timeoutId = setTimeout(() => {
		client.abort?.();
		finish(new PromptTimeoutError(`Timeout after ${timeoutMs}ms`));
	}, timeoutMs);
	timeoutId.unref?.();
	const connectionTimeoutId = setTimeout(() => {
		if (firstEventSeen) return;
		client.abort?.();
		finish(new PromptTimeoutError(`Connection timeout after ${connectionTimeoutMs}ms`));
	}, connectionTimeoutMs);
	connectionTimeoutId.unref?.();

	const unsubscribe = client.onEvent(event => {
		if (!firstEventSeen) {
			firstEventSeen = true;
			clearTimeout(connectionTimeoutId);
		}
		events.push(event);
		if (event.type === "turn_start") {
			turnCount++;
			if (config.maxTurns && turnCount > config.maxTurns) {
				client.abort?.();
				finish(new PromptTurnLimitError(`Max turns exceeded: ${config.maxTurns}`));
			}
		}
	});

	const promptPromise = client.prompt(text);
	promptPromise.then(
		() => finish(),
		error => finish(error instanceof Error ? error : new Error(String(error))),
	);

	try {
		await settled.promise;
	} finally {
		clearTimeout(timeoutId);
		clearTimeout(connectionTimeoutId);
		unsubscribe();
		promptPromise.catch(() => {});
	}
	return events;
}

async function copyFixtures(task: RustTask, destDir: string): Promise<void> {
	await fs.promises.cp(task.inputDir, destDir, { recursive: true });
}

async function runSingleTask(
	task: RustTask,
	runIndex: number,
	config: RustBenchmarkConfig,
	cwd: string,
	shared?: SharedInfra,
): Promise<RustTaskRunResult> {
	const startTime = performance.now();
	let error: string | undefined;
	let verificationPassed = false;
	let agentResponse: string | undefined;
	let diff: string | undefined;
	let diffStats: { linesChanged: number; charsChanged: number } | undefined;
	let changedFiles: string[] = [];
	let checks: RustCheckResult[] = [];
	let exactMatched: boolean | undefined;
	let tokens: TokenStats = { input: 0, output: 0, reasoning: 0, total: 0 };
	let toolStats = emptyToolCallStats();
	let editFailures: RustEditFailure[] = [];
	let editWarnings: string[] = [];
	let editAutocorrectCount = 0;
	let mutationSucceeded = false;
	let conversationSnapshot: ConversationDumpSnapshot | undefined;

	const previousEnv = {
		PI_EDIT_VARIANT: process.env.PI_EDIT_VARIANT,
		PI_EDIT_FUZZY: process.env.PI_EDIT_FUZZY,
		PI_EDIT_FUZZY_THRESHOLD: process.env.PI_EDIT_FUZZY_THRESHOLD,
		PI_STRICT_EDIT_MODE: process.env.PI_STRICT_EDIT_MODE,
		PI_NO_TITLE: process.env.PI_NO_TITLE,
	};

	try {
		if (config.editVariant !== undefined) process.env.PI_EDIT_VARIANT = config.editVariant;
		if (config.editFuzzy !== undefined) {
			process.env.PI_EDIT_FUZZY = config.editFuzzy === "auto" ? "auto" : config.editFuzzy ? "1" : "0";
		}
		if (config.editFuzzyThreshold !== undefined) {
			process.env.PI_EDIT_FUZZY_THRESHOLD =
				config.editFuzzyThreshold === "auto" ? "auto" : String(config.editFuzzyThreshold);
		}
		process.env.PI_STRICT_EDIT_MODE = "1";
		process.env.PI_NO_TITLE = "1";

		const client: BenchmarkClient = new InProcessClient({
			cwd,
			model: config.model,
			appendSystemPrompt: buildBenchmarkSystemPrompt(task, config),
			tools: [...BENCHMARK_TOOL_NAMES],
			editVariant: config.editVariant,
			editFuzzy: config.editFuzzy,
			editFuzzyThreshold: config.editFuzzyThreshold,
			shared,
		});

		try {
			await client.start();
			if (config.thinkingLevel) await client.setThinkingLevel(config.thinkingLevel);
			const initialState = await client.getState();
			const systemPromptTokens = estimateTokens(initialState.systemPrompt?.join("\n\n") ?? "");
			const statsBefore = await client.getSessionStats();
			const events = await collectPromptEvents(client, buildInitialBenchmarkPrompt(task), config);
			const statsAfter = await client.getSessionStats();
			tokens = addTokenStats(tokens, diffTokenStats(statsBefore, statsAfter, systemPromptTokens));
			agentResponse = (await client.getLastAssistantText()) ?? undefined;
			const telemetry = recordToolEvents(events);
			toolStats = telemetry.stats;
			editFailures = telemetry.editFailures;
			editWarnings = telemetry.editWarnings;
			editAutocorrectCount = telemetry.editAutocorrectCount;
			mutationSucceeded = telemetry.mutationSucceeded;
			if (config.conversationDumpDir) conversationSnapshot = await snapshotConversationDump(client);
		} finally {
			await client.dispose();
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}

	try {
		const verification = await verifyRustTask(task, {
			actualDir: cwd,
			timeoutMs: config.verificationTimeout ?? 60000,
		});
		verificationPassed = verification.success;
		diff = verification.diff;
		diffStats = verification.diffStats;
		changedFiles = verification.changedFiles;
		checks = verification.checks;
		exactMatched = verification.exactMatched;
		if (!verification.success && !error) error = verification.error;
	} catch (err) {
		if (!error) error = err instanceof Error ? err.message : String(err);
	}

	const patchApplied = mutationSucceeded || changedFiles.length > 0;
	const editSucceeded = toolStats.editSuccesses > 0;
	const readSatisfied = toolStats.read > 0;
	if (verificationPassed && config.requireEditToolCall && !editSucceeded)
		error = "Required edit tool call was not observed";
	if (verificationPassed && config.requireReadToolCall && !readSatisfied)
		error = "Required read tool call was not observed";
	const success =
		verificationPassed &&
		(!config.requireEditToolCall || editSucceeded) &&
		(!config.requireReadToolCall || readSatisfied);

	if (config.conversationDumpDir && conversationSnapshot) {
		await writeConversationDump({
			dumpDir: config.conversationDumpDir,
			taskId: task.id,
			runIndex,
			snapshot: conversationSnapshot,
		});
	}

	return {
		runIndex,
		success,
		patchApplied,
		verificationPassed,
		category: task.metadata.category,
		difficulty: task.metadata.difficulty,
		difficultyScore: task.metadata.difficultyScore,
		error: success ? undefined : error,
		tokens,
		duration: performance.now() - startTime,
		agentResponse,
		diff,
		diffStats,
		changedFiles,
		checks,
		exactMatched,
		exactMatchMode: task.metadata.verification.exactMatch,
		toolCalls: toolStats,
		editFailures,
		editWarnings,
		editAutocorrectCount,
	};
}

function buildFailureResult(item: TaskRunItem, error: string): RustTaskRunResult {
	return {
		runIndex: item.runIndex,
		success: false,
		patchApplied: false,
		verificationPassed: false,
		category: item.task.metadata.category,
		difficulty: item.task.metadata.difficulty,
		difficultyScore: item.task.metadata.difficultyScore,
		error,
		tokens: { input: 0, output: 0, reasoning: 0, total: 0 },
		duration: 0,
		changedFiles: [],
		checks: [],
		exactMatchMode: item.task.metadata.verification.exactMatch,
		toolCalls: emptyToolCallStats(),
		editFailures: [],
		editWarnings: [],
		editAutocorrectCount: 0,
	};
}

async function runConcurrentBenchmarkRun(
	item: TaskRunItem,
	config: RustBenchmarkConfig,
	onProgress?: (event: ProgressEvent) => void,
	shared?: SharedInfra,
): Promise<{ task: RustTask; result: RustTaskRunResult }> {
	const workDir = subtmp(item.task.id);
	try {
		await copyFixtures(item.task, workDir);
		onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "started" });
		const result = await runSingleTask(item.task, item.runIndex, config, workDir, shared);
		onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "completed", result });
		return { task: item.task, result };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const result = buildFailureResult(item, message);
		onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "completed", result });
		return { task: item.task, result };
	}
}

function isTransportFailure(result: RustTaskRunResult): boolean {
	if (result.success) return false;
	const error = result.error ?? "";
	return error.includes("Timeout after") || error.includes("Connection timeout");
}

function isGhostRun(result: RustTaskRunResult): boolean {
	if (result.success) return false;
	const noProgress =
		result.tokens.total === 0 &&
		result.toolCalls.read === 0 &&
		result.toolCalls.edit === 0 &&
		result.toolCalls.write === 0 &&
		result.toolCalls.bash === 0;
	return noProgress || isTransportFailure(result);
}

function isBetterRun(candidate: RustTaskRunResult, incumbent: RustTaskRunResult): boolean {
	if (candidate.success !== incumbent.success) return candidate.success;
	const candidateGhost = isGhostRun(candidate);
	const incumbentGhost = isGhostRun(incumbent);
	if (candidateGhost !== incumbentGhost) return !candidateGhost;
	if (candidate.tokens.total !== incumbent.tokens.total) return candidate.tokens.total < incumbent.tokens.total;
	return candidate.runIndex < incumbent.runIndex;
}

function pickBestRunIndex(orderedRuns: RustTaskRunResult[]): number {
	if (orderedRuns.length === 0) return -1;
	let bestIndex = 0;
	for (let i = 1; i < orderedRuns.length; i++) {
		if (isBetterRun(orderedRuns[i]!, orderedRuns[bestIndex]!)) bestIndex = i;
	}
	return bestIndex;
}

function summarizeTaskRuns(task: RustTask, runs: RustTaskRunResult[]): RustTaskResult {
	const orderedRuns = runs.slice().sort((left, right) => left.runIndex - right.runIndex);
	const nonGhostRuns = orderedRuns.filter(run => !isGhostRun(run));
	const successfulNonGhostRuns = nonGhostRuns.filter(run => run.success).length;
	const bestIndex = pickBestRunIndex(orderedRuns);
	const best = bestIndex === -1 ? undefined : orderedRuns[bestIndex]!;
	const toolCalls = best ? { ...best.toolCalls } : emptyToolCallStats();
	return {
		id: task.id,
		name: task.name,
		files: task.files,
		category: task.metadata.category,
		difficulty: task.metadata.difficulty,
		runs: orderedRuns,
		bestRunIndex: best?.runIndex ?? -1,
		success: Boolean(best?.success),
		tokens: best ? { ...best.tokens } : { input: 0, output: 0, reasoning: 0, total: 0 },
		duration: best?.duration ?? 0,
		changedFiles: best?.changedFiles ?? [],
		checks: best?.checks ?? [],
		toolCalls,
		editSuccessRate: toolCalls.edit > 0 ? toolCalls.editSuccesses / toolCalls.edit : 1,
		autocorrectFreeSuccess: Boolean(best?.success) && (best?.editAutocorrectCount ?? 0) === 0,
		flakeSuccessRate: nonGhostRuns.length > 0 ? successfulNonGhostRuns / nonGhostRuns.length : 0,
	};
}

export function percentile(sortedAscending: readonly number[], p: number): number {
	const count = sortedAscending.length;
	if (count === 0) return 0;
	if (count === 1) return sortedAscending[0]!;
	const rank = (p / 100) * (count - 1);
	const low = Math.floor(rank);
	const high = Math.ceil(rank);
	const lowValue = sortedAscending[low]!;
	if (low === high) return lowValue;
	return lowValue + (sortedAscending[high]! - lowValue) * (rank - low);
}

export function summarizeTokenDistribution(runs: readonly RustTaskRunResult[]): TokenDistribution {
	const input = runs.map(run => run.tokens.input).sort((left, right) => left - right);
	const output = runs.map(run => run.tokens.output).sort((left, right) => left - right);
	const reasoning = runs.map(run => run.tokens.reasoning).sort((left, right) => left - right);
	const total = runs.map(run => run.tokens.total).sort((left, right) => left - right);
	const at = (p: number): TokenStats => ({
		input: Math.round(percentile(input, p)),
		output: Math.round(percentile(output, p)),
		reasoning: Math.round(percentile(reasoning, p)),
		total: Math.round(percentile(total, p)),
	});
	return { median: at(50), p1: at(1), p99: at(99) };
}

function sumToolCalls(runs: readonly RustTaskRunResult[]): ToolCallStats {
	return {
		read: runs.reduce((sum, run) => sum + run.toolCalls.read, 0),
		edit: runs.reduce((sum, run) => sum + run.toolCalls.edit, 0),
		write: runs.reduce((sum, run) => sum + run.toolCalls.write, 0),
		bash: runs.reduce((sum, run) => sum + run.toolCalls.bash, 0),
		editSuccesses: runs.reduce((sum, run) => sum + run.toolCalls.editSuccesses, 0),
		editFailures: runs.reduce((sum, run) => sum + run.toolCalls.editFailures, 0),
		editWarnings: runs.reduce((sum, run) => sum + run.toolCalls.editWarnings, 0),
		editAutocorrects: runs.reduce((sum, run) => sum + run.toolCalls.editAutocorrects, 0),
		totalInputChars: runs.reduce((sum, run) => sum + run.toolCalls.totalInputChars, 0),
	};
}

function averageToolCalls(total: ToolCallStats, denominator: number): ToolCallStats {
	return {
		read: total.read / denominator,
		edit: total.edit / denominator,
		write: total.write / denominator,
		bash: total.bash / denominator,
		editSuccesses: total.editSuccesses / denominator,
		editFailures: total.editFailures / denominator,
		editWarnings: total.editWarnings / denominator,
		editAutocorrects: total.editAutocorrects / denominator,
		totalInputChars: total.totalInputChars / denominator,
	};
}

function averageTokens(total: TokenStats, denominator: number): TokenStats {
	return {
		input: Math.round(total.input / denominator),
		output: Math.round(total.output / denominator),
		reasoning: Math.round(total.reasoning / denominator),
		total: Math.round(total.total / denominator),
	};
}

function countRustCheckFailures(runs: readonly RustTaskRunResult[]): Record<string, number> {
	const failures: Record<string, number> = {};
	for (const run of runs) {
		for (const check of run.checks) {
			const isCargoCheck = check.kind === "cargo" || (check.kind === undefined && check.name.startsWith("cargo "));
			if (check.success || !isCargoCheck) continue;
			failures[check.name] = (failures[check.name] ?? 0) + 1;
		}
	}
	return failures;
}

function countFailedChecks(runs: readonly RustTaskRunResult[], predicate: (check: RustCheckResult) => boolean): number {
	let failures = 0;
	for (const run of runs) {
		for (const check of run.checks) {
			if (!check.success && predicate(check)) failures++;
		}
	}
	return failures;
}

export function buildBenchmarkResult(params: {
	tasks: RustTask[];
	config: RustBenchmarkConfig;
	resultsByTask: Map<string, RustTaskRunResult[]>;
	startTime: string;
	endTime?: string;
}): RustBenchmarkResult {
	const taskResults = params.tasks.map(task => summarizeTaskRuns(task, params.resultsByTask.get(task.id) ?? []));
	const endTime = params.endTime ?? new Date().toISOString();
	const allRuns = taskResults.flatMap(task => task.runs);
	const nonGhostRuns = allRuns.filter(run => !isGhostRun(run));
	const bestRuns: RustTaskRunResult[] = [];
	for (const task of taskResults) {
		if (task.bestRunIndex < 0) continue;
		const best = task.runs.find(run => run.runIndex === task.bestRunIndex);
		if (best) bestRuns.push(best);
	}

	const tasksWithBestRun = bestRuns.length;
	const taskDenominator = tasksWithBestRun || 1;
	const totalTasks = params.tasks.length;
	const totalTaskDenominator = totalTasks || 1;
	const successfulTasks = taskResults.filter(task => task.success).length;
	const consistentlyPassingTasks = taskResults.filter(task => {
		const taskNonGhostRuns = task.runs.filter(run => !isGhostRun(run));
		return task.success && taskNonGhostRuns.every(run => run.success);
	}).length;
	const flakyTasks = taskResults.filter(task => {
		const taskNonGhostRuns = task.runs.filter(run => !isGhostRun(run));
		return task.success && taskNonGhostRuns.some(run => !run.success);
	}).length;

	const totalTokens: TokenStats = {
		input: bestRuns.reduce((sum, run) => sum + run.tokens.input, 0),
		output: bestRuns.reduce((sum, run) => sum + run.tokens.output, 0),
		reasoning: bestRuns.reduce((sum, run) => sum + run.tokens.reasoning, 0),
		total: bestRuns.reduce((sum, run) => sum + run.tokens.total, 0),
	};
	const tokenDistribution = summarizeTokenDistribution(bestRuns);
	const oneShotSuccessRuns = taskResults
		.map(task => task.runs.find(run => run.runIndex === 0))
		.filter((run): run is RustTaskRunResult => Boolean(run?.success));
	const totalOneShotSuccessTokens: TokenStats = {
		input: oneShotSuccessRuns.reduce((sum, run) => sum + run.tokens.input, 0),
		output: oneShotSuccessRuns.reduce((sum, run) => sum + run.tokens.output, 0),
		reasoning: oneShotSuccessRuns.reduce((sum, run) => sum + run.tokens.reasoning, 0),
		total: oneShotSuccessRuns.reduce((sum, run) => sum + run.tokens.total, 0),
	};
	const oneShotDistribution = summarizeTokenDistribution(oneShotSuccessRuns);
	const oneShotDenominator = oneShotSuccessRuns.length || 1;
	const totalDuration = bestRuns.reduce((sum, run) => sum + run.duration, 0);
	const totalToolCalls = sumToolCalls(bestRuns);
	const editSuccessRate = totalToolCalls.edit > 0 ? totalToolCalls.editSuccesses / totalToolCalls.edit : 1;
	const autocorrectFreeSuccessfulTasks = bestRuns.filter(run => run.success && run.editAutocorrectCount === 0).length;
	const autocorrectedBestRuns = bestRuns.filter(run => run.editAutocorrectCount > 0).length;
	const editAutocorrectRate =
		totalToolCalls.editSuccesses > 0 ? totalToolCalls.editAutocorrects / totalToolCalls.editSuccesses : 0;
	const timeoutRuns = nonGhostRuns.filter(
		run => run.error?.includes("Timeout") || run.error?.includes("timed out"),
	).length;

	return {
		config: params.config,
		tasks: taskResults,
		summary: {
			totalTasks,
			totalRuns: nonGhostRuns.length,
			successfulRuns: allRuns.filter(run => run.success).length,
			successfulTasks,
			taskSuccessRate: successfulTasks / totalTaskDenominator,
			flakyTasks,
			consistentlyPassingTasks,
			successfulOneShotTasks: oneShotSuccessRuns.length,
			totalOneShotSuccessTokens,
			avgOneShotSuccessTokensPerTask: averageTokens(totalOneShotSuccessTokens, oneShotDenominator),
			medianOneShotSuccessTokensPerTask: oneShotDistribution.median,
			p1OneShotSuccessTokensPerTask: oneShotDistribution.p1,
			p99OneShotSuccessTokensPerTask: oneShotDistribution.p99,
			totalTokens,
			avgTokensPerTask: averageTokens(totalTokens, taskDenominator),
			medianTokensPerTask: tokenDistribution.median,
			p1TokensPerTask: tokenDistribution.p1,
			p99TokensPerTask: tokenDistribution.p99,
			totalDuration,
			avgDurationPerTask: Math.round(totalDuration / taskDenominator),
			totalToolCalls,
			avgToolCallsPerTask: averageToolCalls(totalToolCalls, taskDenominator),
			editSuccessRate,
			autocorrectFreeSuccessfulTasks,
			autocorrectFreeSuccessRate: autocorrectFreeSuccessfulTasks / totalTaskDenominator,
			autocorrectedBestRuns,
			editAutocorrectRate,
			timeoutRuns,
			ghostRuns: allRuns.filter(run => isGhostRun(run)).length,
			transportFailureRuns: allRuns.filter(run => isTransportFailure(run)).length,
			rustCheckFailures: countRustCheckFailures(nonGhostRuns),
			exactMatchFailures: countFailedChecks(
				nonGhostRuns,
				check => check.name === "exact match" && check.required === true,
			),
			preferredExactMismatches: countFailedChecks(
				nonGhostRuns,
				check => check.name === "exact match" && check.required === false,
			),
			allowedChangedFileFailures: countFailedChecks(nonGhostRuns, check => check.name === "allowed changed files"),
		},
		startTime: params.startTime,
		endTime,
	};
}

export async function runBenchmark(
	tasks: RustTask[],
	config: RustBenchmarkConfig,
	onProgress?: (event: ProgressEvent) => void,
	onResultSnapshot?: (result: RustBenchmarkResult) => void,
): Promise<RustBenchmarkResult> {
	const startTime = new Date().toISOString();
	const shared = await discoverSharedInfra({
		editVariant: config.editVariant,
		editFuzzy: config.editFuzzy,
		editFuzzyThreshold: config.editFuzzyThreshold,
	});

	try {
		const runsPerTask = Math.max(1, Math.floor(config.runsPerTask));
		const taskQueue = shuffle(tasks.slice());
		const resultsByTask = new Map<string, RustTaskRunResult[]>();
		const concurrency = Math.max(1, Math.floor(config.taskConcurrency));

		const recordResult = (task: RustTask, result: RustTaskRunResult) => {
			const results = resultsByTask.get(task.id) ?? [];
			results.push(result);
			resultsByTask.set(task.id, results);
			onResultSnapshot?.(buildBenchmarkResult({ tasks, config, resultsByTask, startTime }));
		};

		const runTaskAllRuns = async (task: RustTask): Promise<void> => {
			const items: TaskRunItem[] = Array.from({ length: runsPerTask }, (_, runIndex) => ({ task, runIndex }));
			await Promise.all(
				items.map(async item => {
					const { result } = await runConcurrentBenchmarkRun(item, config, onProgress, shared);
					recordResult(task, result);
				}),
			);
		};

		const worker = async (): Promise<void> => {
			while (true) {
				const task = taskQueue.shift();
				if (!task) return;
				await runTaskAllRuns(task);
			}
		};

		const slots = Math.min(concurrency, taskQueue.length);
		const running: Promise<void>[] = [];
		for (let i = 0; i < slots; i++) running.push(worker());
		await Promise.all(running);

		return buildBenchmarkResult({ tasks, config, resultsByTask, startTime });
	} finally {
		shared.authStorage.close();
	}
}

void buildRetryBenchmarkPrompt;
