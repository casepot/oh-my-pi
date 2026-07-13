#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcSessionEntryView, RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import {
	assertConditionContext,
	auditSharedCalls,
	CONDITIONS,
	type Condition,
	equalTodoState,
	eventCompacted,
	findFirstAssistantPromptUsage,
	findPreKeepBoundary,
	findSealLeaves,
	findShakeSealLeaf,
	providerFailureMessage,
	seededConditionOrder,
	toolCalls,
} from "./helpers";
import continuationPrompt from "./prompts/continuation.md" with { type: "text" };
import shakePrompt from "./prompts/derive-shake.md" with { type: "text" };
import summaryPrompt from "./prompts/derive-summary.md" with { type: "text" };
import resumeSharedPrompt from "./prompts/resume-shared-verification.md" with { type: "text" };
import sharedPrompt from "./prompts/shared-phase.md" with { type: "text" };

const ROOT = path.resolve(import.meta.dir, "../../..");
const DEFAULT_SOURCE = "/Users/case/projects/bloomberg-cli";
const SCHEMA_VERSION = 2;
const DEFAULT_OVERLAY = path.join(import.meta.dir, "experiment-overlay.yml");

interface CliOptions {
	mode: "all" | "prepare" | "derive" | "continue";
	source: string;
	artifactDir: string;
	workspace: string;
	model: string;
	provider: string;
	modelId: string;
	thinking?: string;
	configs: string[];
	uvEnvironment: string;
	replicates: number;
	seed: number;
	timeoutMs: number;
	maxNewRuns?: number;
	resumeSharedSession?: string;
}

interface TreeEntry {
	path: string;
	kind: "file" | "symlink";
	bytes: number;
	hash: string;
	target?: string;
}

interface ContextReference {
	leafId: string;
	sessionFile: string;
}

interface ProtocolState {
	schemaVersion: number;
	createdAt: string;
	updatedAt: string;
	stage: "empty" | "prepared" | "shared" | "derived" | "continued";
	source: string;
	workspace: string;
	artifactDir: string;
	harnessRevision: string;
	model: { provider: string; id: string; thinking?: string; configs: string[] };
	uvEnvironment: string;
	configHashes: Record<string, string>;
	seed: number;
	replicates: number;
	prompts: Record<string, string>;
	shared?: {
		sessionFile: string;
		s1LeafId: string;
		preKeepEntryId: string;
		keepEntryId: string;
		todoState: unknown;
	};
	contexts?: Record<Condition, ContextReference>;
	runs?: Array<{ id: string; condition: Condition; replicate: number; status: "complete" }>;
	operationalAssumptions: string[];
}

interface Recorder {
	events: AgentEvent[];
	sessionEvents: unknown[];
	frames: unknown[];
}

interface ClientHandle {
	client: RpcClient;
	recorder: Recorder;
}

function usage(): never {
	throw new Error(
		[
			"Usage: bun scripts/experiments/checkpoint-seal-bloomberg/orchestrate.ts [mode] --model provider/id [options]",
			"Modes: --prepare-only | --derive-only | --continue (default: all)",
			"Options: --source PATH --artifact-dir PATH --workspace PATH --thinking LEVEL",
			"         --config OVERLAY_FILE (repeatable) --uv-environment PATH --replicates N --max-new-runs N --seed N --timeout-ms N",
		].join("\n"),
	);
}

function valueAfter(args: string[], index: number): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) usage();
	return value;
}

export function parseCli(args: string[], environment: Record<string, string | undefined> = Bun.env): CliOptions {
	let mode: CliOptions["mode"] = "all";
	let source = environment.BLOOMBERG_EXPERIMENT_SOURCE ?? DEFAULT_SOURCE;
	let artifactDir = environment.BLOOMBERG_EXPERIMENT_DIR ?? path.join(ROOT, "experiment", "checkpoint-seal-bloomberg");
	let workspace = environment.BLOOMBERG_EXPERIMENT_WORKSPACE ?? "";
	let model = environment.BLOOMBERG_EXPERIMENT_MODEL ?? "";
	let thinking = environment.BLOOMBERG_EXPERIMENT_THINKING;
	let replicates = Number(environment.BLOOMBERG_EXPERIMENT_REPLICATES ?? "1");
	let maxNewRuns =
		environment.BLOOMBERG_EXPERIMENT_MAX_NEW_RUNS === undefined
			? undefined
			: Number(environment.BLOOMBERG_EXPERIMENT_MAX_NEW_RUNS);
	let seed = Number(environment.BLOOMBERG_EXPERIMENT_SEED ?? "20260711");
	let timeoutMs = Number(environment.BLOOMBERG_EXPERIMENT_TIMEOUT_MS ?? "7200000");
	let uvEnvironment =
		environment.BLOOMBERG_EXPERIMENT_UV_ENVIRONMENT ??
		path.join(os.homedir(), ".cache", "omp", "checkpoint-seal-bloomberg-uv");
	let resumeSharedSession = environment.BLOOMBERG_EXPERIMENT_RESUME_SHARED_SESSION;
	const configs = [DEFAULT_OVERLAY, ...(environment.BLOOMBERG_EXPERIMENT_CONFIG ?? "").split("\n").filter(Boolean)];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		switch (argument) {
			case "--prepare-only":
			case "--derive-only":
			case "--continue": {
				const nextMode =
					argument === "--prepare-only" ? "prepare" : argument === "--derive-only" ? "derive" : "continue";
				if (mode !== "all") throw new Error("restart modes are mutually exclusive");
				mode = nextMode;
				break;
			}
			case "--source":
				source = valueAfter(args, index++);
				break;
			case "--artifact-dir":
				artifactDir = valueAfter(args, index++);
				break;
			case "--workspace":
				workspace = valueAfter(args, index++);
				break;
			case "--model":
				model = valueAfter(args, index++);
				break;
			case "--thinking":
				thinking = valueAfter(args, index++);
				break;
			case "--config":
				configs.push(valueAfter(args, index++));
				break;
			case "--uv-environment":
				uvEnvironment = valueAfter(args, index++);
				break;
			case "--resume-shared-session":
				resumeSharedSession = valueAfter(args, index++);
				break;
			case "--replicates":
				replicates = Number(valueAfter(args, index++));
				break;
			case "--max-new-runs":
				maxNewRuns = Number(valueAfter(args, index++));
				break;
			case "--seed":
				seed = Number(valueAfter(args, index++));
				break;
			case "--timeout-ms":
				timeoutMs = Number(valueAfter(args, index++));
				break;
			case "--help":
				return usage();
			default:
				throw new Error(`unknown argument: ${argument}`);
		}
	}
	if (!model.includes("/")) throw new Error("--model provider/id is required (or BLOOMBERG_EXPERIMENT_MODEL)");
	const separator = model.indexOf("/");
	const provider = model.slice(0, separator);
	const modelId = model.slice(separator + 1);
	if (!provider || !modelId) throw new Error("model must be provider/id");
	if (!Number.isSafeInteger(replicates) || replicates < 1) throw new Error("replicates must be a positive integer");
	if (!Number.isSafeInteger(seed)) throw new Error("seed must be a safe integer");
	if (maxNewRuns !== undefined && (!Number.isSafeInteger(maxNewRuns) || maxNewRuns < 1)) {
		throw new Error("max-new-runs must be a positive integer");
	}
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000) throw new Error("timeout-ms must be at least 60000");
	artifactDir = path.resolve(artifactDir);
	source = path.resolve(source);
	workspace = path.resolve(workspace || path.join(artifactDir, "workspace"));
	configs.splice(0, configs.length, ...configs.map(config => path.resolve(config)));
	uvEnvironment = path.resolve(uvEnvironment);
	if (resumeSharedSession) resumeSharedSession = path.resolve(resumeSharedSession);
	if (workspace === source || workspace.startsWith(`${source}${path.sep}`)) {
		throw new Error("disposable workspace must not equal or be nested under the original repository");
	}
	if (artifactDir === source || artifactDir.startsWith(`${source}${path.sep}`)) {
		throw new Error("artifact directory must not be inside the original repository");
	}
	if (
		uvEnvironment === source ||
		uvEnvironment.startsWith(`${source}${path.sep}`) ||
		uvEnvironment === workspace ||
		uvEnvironment.startsWith(`${workspace}${path.sep}`) ||
		uvEnvironment === artifactDir ||
		uvEnvironment.startsWith(`${artifactDir}${path.sep}`)
	) {
		throw new Error("UV environment must be external to source, workspace, and artifact directories");
	}
	return {
		mode,
		source,
		artifactDir,
		workspace,
		model,
		provider,
		modelId,
		thinking,
		configs,
		uvEnvironment,
		replicates,
		maxNewRuns,
		seed,
		timeoutMs,
		resumeSharedSession,
	};
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`);
}
async function writeCompressedJson(file: string, value: unknown): Promise<void> {
	await Bun.write(`${file}.gz`, Bun.gzipSync(JSON.stringify(value)));
}

async function readJson(file: string): Promise<unknown> {
	return Bun.file(file).json();
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isProtocolState(value: unknown): value is ProtocolState {
	if (!isRecord(value)) return false;
	const stages: Record<string, true> = { empty: true, prepared: true, shared: true, derived: true, continued: true };
	if (
		value.schemaVersion !== SCHEMA_VERSION ||
		typeof value.stage !== "string" ||
		stages[value.stage] !== true ||
		typeof value.createdAt !== "string" ||
		typeof value.updatedAt !== "string" ||
		typeof value.source !== "string" ||
		typeof value.workspace !== "string" ||
		typeof value.artifactDir !== "string" ||
		typeof value.harnessRevision !== "string" ||
		typeof value.uvEnvironment !== "string" ||
		typeof value.seed !== "number" ||
		typeof value.replicates !== "number" ||
		!isRecord(value.model) ||
		typeof value.model.provider !== "string" ||
		typeof value.model.id !== "string" ||
		(value.model.thinking !== undefined && typeof value.model.thinking !== "string") ||
		!stringArray(value.model.configs) ||
		!isRecord(value.configHashes) ||
		!Object.values(value.configHashes).every(item => typeof item === "string") ||
		!isRecord(value.prompts) ||
		!Object.values(value.prompts).every(item => typeof item === "string") ||
		!stringArray(value.operationalAssumptions)
	) {
		return false;
	}
	if (value.shared !== undefined) {
		if (
			!isRecord(value.shared) ||
			typeof value.shared.sessionFile !== "string" ||
			typeof value.shared.s1LeafId !== "string" ||
			typeof value.shared.preKeepEntryId !== "string" ||
			typeof value.shared.keepEntryId !== "string"
		) {
			return false;
		}
	}
	if (value.contexts !== undefined) {
		if (!isRecord(value.contexts)) return false;
		for (const condition of CONDITIONS) {
			const context = value.contexts[condition];
			if (!isRecord(context) || typeof context.leafId !== "string" || typeof context.sessionFile !== "string") {
				return false;
			}
		}
	}
	if (
		value.runs !== undefined &&
		(!Array.isArray(value.runs) ||
			!value.runs.every(
				run =>
					isRecord(run) &&
					typeof run.id === "string" &&
					typeof run.condition === "string" &&
					typeof run.replicate === "number" &&
					run.status === "complete",
			))
	) {
		return false;
	}
	return true;
}

function parseProtocol(value: unknown): ProtocolState {
	if (!isProtocolState(value)) throw new Error("invalid or unsupported protocol.json");
	return value;
}

async function loadProtocol(options: CliOptions): Promise<ProtocolState> {
	try {
		return parseProtocol(await readJson(path.join(options.artifactDir, "protocol.json")));
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return {
			schemaVersion: SCHEMA_VERSION,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			stage: "empty",
			source: options.source,
			workspace: options.workspace,
			artifactDir: options.artifactDir,
			harnessRevision: Bun.env.GIT_COMMIT ?? "source-checkout-unpinned",
			model: {
				provider: options.provider,
				id: options.modelId,
				thinking: options.thinking,
				configs: options.configs,
			},
			uvEnvironment: options.uvEnvironment,
			configHashes: {},
			seed: options.seed,
			replicates: options.replicates,
			prompts: {},
			operationalAssumptions: [
				"The source OMP checkout and its installed dependencies remain unchanged during a run.",
				"Authentication is resolved from the operator's existing OMP agent directory; --session-dir isolates only experiment sessions.",
				"Provider/model availability and deterministic effort settings are operator-verified before provider calls.",
				"UV_PROJECT_ENVIRONMENT points to one external shared environment for every shared and continuation process.",
				"The Bloomberg source repository is quiescent while the disposable S0 copy is captured.",
				"Summary sealing appends checkpoint-seal-report immediately before checkpoint-seal-manifest.",
			],
		};
	}
}

async function saveProtocol(protocol: ProtocolState): Promise<void> {
	protocol.updatedAt = new Date().toISOString();
	await writeJson(path.join(protocol.artifactDir, "protocol.json"), protocol);
}

const EXCLUDED_COPY_NAMES: Record<string, true> = {
	".venv": true,
	".cache": true,
	".pytest_cache": true,
	".ruff_cache": true,
	".mypy_cache": true,
	".pyright": true,
	".ty_cache": true,
	__pycache__: true,
	"fsmonitor--daemon.ipc": true,
};

function copyFilter(includeGit: boolean): (source: string, destination: string) => boolean {
	return source => {
		const name = path.basename(source);
		return EXCLUDED_COPY_NAMES[name] !== true && (includeGit || name !== ".git");
	};
}

async function replaceCopy(source: string, destination: string, includeGit = true): Promise<void> {
	await fs.rm(destination, { recursive: true, force: true });
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.cp(source, destination, {
		recursive: true,
		force: false,
		errorOnExist: true,
		preserveTimestamps: true,
		filter: copyFilter(includeGit),
	});
}
async function linkRuntimeEnvironment(options: CliOptions): Promise<void> {
	const environmentPath = path.join(options.workspace, ".venv");
	await fs.rm(environmentPath, { recursive: true, force: true });
	await fs.mkdir(environmentPath, { recursive: true });
	await fs.mkdir(path.dirname(options.uvEnvironment), { recursive: true });
	for (const name of ["bin", "lib", "pyvenv.cfg"] as const) {
		await fs.symlink(path.join(options.uvEnvironment, name), path.join(environmentPath, name));
	}
}

async function hashFile(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

async function treeManifest(root: string): Promise<TreeEntry[]> {
	const result: TreeEntry[] = [];
	async function walk(directory: string): Promise<void> {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (entry.name === ".git" || EXCLUDED_COPY_NAMES[entry.name] === true) continue;
			const absolute = path.join(directory, entry.name);
			const relative = path.relative(root, absolute).split(path.sep).join("/");
			if (entry.isDirectory()) {
				await walk(absolute);
			} else if (entry.isSymbolicLink()) {
				const target = await fs.readlink(absolute);
				result.push({
					path: relative,
					kind: "symlink",
					bytes: Buffer.byteLength(target),
					hash: Bun.hash(target).toString(16),
					target,
				});
			} else if (entry.isFile()) {
				const stat = await fs.stat(absolute);
				result.push({ path: relative, kind: "file", bytes: stat.size, hash: await hashFile(absolute) });
			}
		}
	}
	await walk(root);
	return result;
}

async function hashText(text: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(text);
	return hasher.digest("hex");
}

async function configHashes(configs: readonly string[]): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	for (const config of configs) hashes[config] = await hashFile(config);
	return hashes;
}

async function promptHashes(): Promise<Record<string, string>> {
	return {
		shared: await hashText(sharedPrompt),
		continuation: await hashText(continuationPrompt),
		shake: await hashText(shakePrompt),
		summary: await hashText(summaryPrompt),
	};
}

async function allEntries(client: RpcClient): Promise<RpcSessionEntryView[]> {
	const entries: RpcSessionEntryView[] = [];
	let offset = 0;
	for (;;) {
		const page = await client.getSessionEntries({ offset, limit: 500, includeContent: true });
		entries.push(...page.entries);
		if (page.nextOffset === undefined) return entries;
		offset = page.nextOffset;
	}
}
async function anchorSessionBranch(
	sessionFile: string,
	entryId: string,
	label: string,
	completeSummary = false,
): Promise<string> {
	const manager = await SessionManager.open(sessionFile, path.dirname(sessionFile), undefined, {
		suppressBreadcrumb: true,
	});
	try {
		manager.branch(entryId);
		if (completeSummary) {
			manager.appendCustomMessageEntry(
				"checkpoint-seal",
				"",
				false,
				{ disposition: "seal", strategy: "summary", experimentDerived: true },
				"agent",
				false,
			);
		} else {
			manager.appendCustomEntry("checkpoint_experiment_branch", { label });
		}
		const leafId = manager.getLeafId();
		if (!leafId) throw new Error(`failed to anchor experiment branch ${label}`);
		return leafId;
	} finally {
		await manager.close();
	}
}

function clientArgs(options: CliOptions): string[] {
	const args = ["--no-title"];
	if (options.thinking) args.push("--thinking", options.thinking);
	for (const config of options.configs) args.push("--config", config);
	return args;
}

async function startClient(options: CliOptions, sessionDir: string): Promise<ClientHandle> {
	await fs.mkdir(sessionDir, { recursive: true });
	const recorder: Recorder = { events: [], sessionEvents: [], frames: [] };
	const client = new RpcClient({
		cliPath: path.join(ROOT, "packages/coding-agent/src/cli.ts"),
		cwd: options.workspace,
		provider: options.provider,
		model: options.modelId,
		sessionDir,
		args: clientArgs(options),
		env: { UV_PROJECT_ENVIRONMENT: options.uvEnvironment },
		onFrame: frame => recorder.frames.push(frame),
		onSessionEvent: event => recorder.sessionEvents.push(event),
	});
	client.onEvent(event => recorder.events.push(event));
	await client.start();
	await client.setAutoCompaction(false);
	await client.setAutoRetry(false);
	const state = await client.getState();
	if (state.model?.provider !== options.provider || state.model.id !== options.modelId) {
		client.stop();
		throw new Error(`model pin failed: expected ${options.model}, got ${state.model?.provider}/${state.model?.id}`);
	}
	if (options.thinking && state.thinkingLevel !== options.thinking) {
		client.stop();
		throw new Error(`thinking pin failed: expected ${options.thinking}, got ${state.thinkingLevel}`);
	}
	return { client, recorder };
}
async function promptAndWait(client: RpcClient, message: string, timeoutMs: number): Promise<AgentEvent[]> {
	return client.promptAndWait(message, undefined, timeoutMs);
}

function assertNoCompaction(recorder: Recorder): void {
	if (recorder.sessionEvents.some(eventCompacted)) throw new Error("unexpected compaction invalidated experiment arm");
}

function assertNoProviderFailure(recorder: Recorder): void {
	for (let index = recorder.events.length - 1; index >= 0; index--) {
		const message = providerFailureMessage(recorder.events[index]);
		if (message) throw new Error(`provider failure invalidated experiment arm: ${message}`);
	}
}

async function assertIdle(client: RpcClient): Promise<RpcSessionState> {
	await client.waitForIdle(60_000);
	const state = await client.getState();
	if (state.isStreaming || state.isCompacting || state.activeOperations.length > 0 || state.queuedMessageCount > 0) {
		throw new Error("session boundary contains pending operations");
	}
	const subagents = await client.getSubagents();
	if (subagents.some(agent => agent.status === "running"))
		throw new Error("session boundary contains a running subagent");
	return state;
}

function assertWorkspace(state: RpcSessionState, options: CliOptions): void {
	const sessionCwd = state.security.bash.cwd;
	if (!sessionCwd || path.resolve(sessionCwd) !== options.workspace) {
		throw new Error(`session cwd pin failed: expected ${options.workspace}, got ${sessionCwd ?? "none"}`);
	}
}

async function persistRecorder(directory: string, handle: ClientHandle): Promise<void> {
	await writeCompressedJson(path.join(directory, "tool-events.json"), handle.recorder.events);
	await writeCompressedJson(path.join(directory, "session-events.json"), handle.recorder.sessionEvents);
	await writeCompressedJson(path.join(directory, "rpc-frames.json"), handle.recorder.frames);
	await writeJson(path.join(directory, "transcript.json"), await handle.client.getMessages());
	await writeJson(path.join(directory, "session-entries.json"), await allEntries(handle.client));
	await writeJson(path.join(directory, "state.json"), await handle.client.getState());
}

function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function persistFailure(directory: string, handle: ClientHandle, error: unknown): Promise<void> {
	let captureError: string | undefined;
	try {
		await persistRecorder(directory, handle);
	} catch (capture) {
		captureError = errorText(capture);
	}
	await writeJson(path.join(directory, "failure.json"), {
		failedAt: new Date().toISOString(),
		error: errorText(error),
		...(captureError ? { captureError } : {}),
	});
}

async function stopClient(handle: ClientHandle): Promise<void> {
	try {
		await handle.client.shutdown("experiment phase complete");
	} catch {
		handle.client.stop();
	}
}

async function prepare(options: CliOptions, protocol: ProtocolState): Promise<void> {
	if (protocol.stage !== "empty") return;
	const sourceStat = await fs.stat(options.source);
	if (!sourceStat.isDirectory()) throw new Error(`source is not a directory: ${options.source}`);
	await fs.mkdir(options.artifactDir, { recursive: true });
	await replaceCopy(options.source, options.workspace, true);
	await linkRuntimeEnvironment(options);
	await replaceCopy(options.workspace, path.join(options.artifactDir, "seed", "s0", "workspace"), true);
	const manifest = await treeManifest(options.workspace);
	await writeJson(path.join(options.artifactDir, "seed", "s0", "manifest.json"), manifest);
	protocol.prompts = await promptHashes();
	protocol.configHashes = await configHashes(options.configs);
	protocol.stage = "prepared";
	await writeJson(path.join(options.artifactDir, "SCHEMA.json"), {
		schemaVersion: SCHEMA_VERSION,
		layout: {
			"protocol.json": "restart state, pins, context leaves, run index, assumptions",
			"seed/s0/workspace": "full disposable seed including repository metadata",
			"seed/s1/workspace": "verified shared-phase filesystem",
			"seed/boundary-audit.json": "tool order, verification, state, and entry boundary",
			"contexts/raw": "untreated shared transcript and session capture",
			"contexts/derivation/shake-sessions": "isolated scoped-Shake session",
			"contexts/derivation/summary-sessions": "isolated semantic-seal session",
			"contexts/shake": "scoped-Shake transcript and entry capture",
			"contexts/semantic-report.json": "exact report custom-message content",
			"contexts/manifest.json": "runtime-generated manifest content",
			"runs/<anonymous-id>":
				"private condition, treatment prompt usage, transcript, entries, events, final workspace, S1 diff, verification",
		},
	});
	await saveProtocol(protocol);
}

async function runShared(options: CliOptions, protocol: ProtocolState): Promise<void> {
	if (protocol.stage !== "prepared") return;
	const directory = path.join(options.artifactDir, "contexts", "raw");
	const resuming = options.resumeSharedSession !== undefined;
	if (!resuming) {
		await replaceCopy(path.join(options.artifactDir, "seed", "s0", "workspace"), options.workspace, true);
	}
	await linkRuntimeEnvironment(options);
	if (options.resumeSharedSession) {
		const persistedEntries = await readJson(path.join(directory, "session-entries.json"));
		if (!Array.isArray(persistedEntries)) throw new Error("shared recovery session entries are invalid");
		const existingBoundary = findPreKeepBoundary(persistedEntries as RpcSessionEntryView[]);
		await anchorSessionBranch(options.resumeSharedSession, existingBoundary.preKeep, "shared-verification-recovery");
	}
	const handle = await startClient(options, path.join(directory, resuming ? "resume-sessions" : "sessions"));
	try {
		if (options.resumeSharedSession) {
			const previousEvents = await readJson(path.join(directory, "tool-events.json"));
			if (!Array.isArray(previousEvents)) throw new Error("shared recovery tool events are invalid");
			handle.recorder.events.unshift(...(previousEvents as AgentEvent[]));
			await handle.client.switchSession(options.resumeSharedSession);
			await promptAndWait(handle.client, resumeSharedPrompt, options.timeoutMs);
		} else {
			await promptAndWait(handle.client, sharedPrompt, options.timeoutMs);
		}
		assertNoProviderFailure(handle.recorder);
		assertNoCompaction(handle.recorder);
		const state = await assertIdle(handle.client);
		assertWorkspace(state, options);
		const calls = toolCalls(handle.recorder.events);
		const audit = auditSharedCalls(calls);
		const entries = await allEntries(handle.client);
		if (entries.some(entry => entry.type === "compaction"))
			throw new Error("shared session contains unexpected compaction entry");
		const boundary = findPreKeepBoundary(entries);
		const tree = await handle.client.getSessionTree();
		if (!tree.currentLeafId) throw new Error("shared session has no raw leaf");
		const stats = await handle.client.getSessionStats();
		if (!stats.sessionFile) throw new Error("shared session file missing");
		await persistRecorder(directory, handle);
		await replaceCopy(options.workspace, path.join(options.artifactDir, "seed", "s1", "workspace"), true);
		await writeJson(
			path.join(options.artifactDir, "seed", "s1", "manifest.json"),
			await treeManifest(options.workspace),
		);
		await writeJson(path.join(options.artifactDir, "seed", "boundary-audit.json"), {
			audit,
			state,
			boundary,
			rawLeafId: tree.currentLeafId,
			sessionFile: stats.sessionFile,
		});
		protocol.shared = {
			sessionFile: stats.sessionFile,
			s1LeafId: tree.currentLeafId,
			preKeepEntryId: boundary.preKeep,
			keepEntryId: boundary.keepEntry,
			todoState: state.todoPhases,
		};
		protocol.stage = "shared";
		await saveProtocol(protocol);
	} catch (error) {
		await persistFailure(directory, handle, error);
		throw error;
	} finally {
		await stopClient(handle);
	}
}

async function derive(options: CliOptions, protocol: ProtocolState): Promise<void> {
	if (protocol.stage !== "shared") return;
	if (!protocol.shared) throw new Error("shared metadata missing");
	await replaceCopy(path.join(options.artifactDir, "seed", "s1", "workspace"), options.workspace, true);
	await linkRuntimeEnvironment(options);
	const directory = path.join(options.artifactDir, "contexts", "derivation");
	const shakeSessionFile = await copySessionForRun(
		protocol.shared.sessionFile,
		path.join(directory, "shake-sessions"),
	);
	const summarySessionFile = await copySessionForRun(
		protocol.shared.sessionFile,
		path.join(directory, "summary-sessions"),
	);
	if (shakeSessionFile === summarySessionFile)
		throw new Error("derivation treatments must use isolated session files");
	let activeHandle: ClientHandle | undefined;
	const combined: Recorder = { events: [], sessionEvents: [], frames: [] };
	try {
		await anchorSessionBranch(shakeSessionFile, protocol.shared.preKeepEntryId, "derive-shake");
		activeHandle = await startClient(options, path.join(directory, "shake-bootstrap"));
		await activeHandle.client.switchSession(shakeSessionFile);
		assertWorkspace(await assertIdle(activeHandle.client), options);
		assertConditionContext("raw", await allEntries(activeHandle.client));
		const shakeStart = activeHandle.recorder.events.length;
		await promptAndWait(activeHandle.client, shakePrompt, options.timeoutMs);
		assertNoProviderFailure(activeHandle.recorder);
		assertNoCompaction(activeHandle.recorder);
		const shakeCalls = toolCalls(activeHandle.recorder.events.slice(shakeStart));
		if (!shakeCalls.some(call => call.name === "seal" && call.isError === false)) {
			throw new Error("Shake derivation did not execute a successful seal");
		}
		const shakeTree = await activeHandle.client.getSessionTree();
		if (!shakeTree.currentLeafId) throw new Error("Shake derivation has no leaf");
		const shakeEntries = await allEntries(activeHandle.client);
		assertConditionContext("shake", shakeEntries);
		const shakeLeaf = findShakeSealLeaf(shakeEntries);
		const shakeState = await assertIdle(activeHandle.client);
		if (!equalTodoState(protocol.shared.todoState, shakeState.todoPhases))
			throw new Error("Shake todo state differs from S1");
		await writeJson(
			path.join(options.artifactDir, "contexts", "shake", "transcript.json"),
			await activeHandle.client.getMessages(),
		);
		await writeJson(path.join(options.artifactDir, "contexts", "shake", "session-entries.json"), shakeEntries);
		combined.events.push(...activeHandle.recorder.events);
		combined.sessionEvents.push(...activeHandle.recorder.sessionEvents);
		combined.frames.push(...activeHandle.recorder.frames);
		await stopClient(activeHandle);
		activeHandle = undefined;

		await anchorSessionBranch(summarySessionFile, protocol.shared.preKeepEntryId, "derive-summary");
		activeHandle = await startClient(options, path.join(directory, "summary-bootstrap"));
		await activeHandle.client.switchSession(summarySessionFile);
		assertWorkspace(await assertIdle(activeHandle.client), options);
		assertConditionContext("raw", await allEntries(activeHandle.client));
		const summaryStart = activeHandle.recorder.events.length;
		await promptAndWait(activeHandle.client, summaryPrompt, options.timeoutMs);
		assertNoProviderFailure(activeHandle.recorder);
		assertNoCompaction(activeHandle.recorder);
		const summaryCalls = toolCalls(activeHandle.recorder.events.slice(summaryStart));
		if (!summaryCalls.some(call => call.name === "seal" && call.isError === false)) {
			throw new Error("summary derivation did not execute a successful seal");
		}
		const summaryTree = await activeHandle.client.getSessionTree();
		const summaryEntries = await allEntries(activeHandle.client);
		assertConditionContext("report+manifest", summaryEntries);
		const seal = findSealLeaves(summaryEntries, summaryTree.currentLeafId);
		await assertIdle(activeHandle.client);
		if (!equalTodoState(protocol.shared.todoState, seal.todoState))
			throw new Error("summary seal todo snapshot differs from S1");
		await writeJson(path.join(options.artifactDir, "contexts", "semantic-report.json"), seal.report);
		await writeJson(path.join(options.artifactDir, "contexts", "manifest.json"), seal.manifest);
		activeHandle.recorder.events.unshift(...combined.events);
		activeHandle.recorder.sessionEvents.unshift(...combined.sessionEvents);
		activeHandle.recorder.frames.unshift(...combined.frames);
		await persistRecorder(directory, activeHandle);
		protocol.contexts = {
			raw: { leafId: protocol.shared.s1LeafId, sessionFile: protocol.shared.sessionFile },
			shake: { leafId: shakeLeaf, sessionFile: shakeSessionFile },
			"report-only": { leafId: seal.reportOnly, sessionFile: summarySessionFile },
			"report+manifest": { leafId: seal.reportManifest, sessionFile: summarySessionFile },
		};
		protocol.stage = "derived";
		await saveProtocol(protocol);
	} catch (error) {
		if (activeHandle) await persistFailure(directory, activeHandle, error);
		throw error;
	} finally {
		if (activeHandle) await stopClient(activeHandle);
	}
}

async function buildDiff(beforeRoot: string, afterRoot: string): Promise<string> {
	const before = new Map((await treeManifest(beforeRoot)).map(entry => [entry.path, entry]));
	const after = new Map((await treeManifest(afterRoot)).map(entry => [entry.path, entry]));
	const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
	const output: string[] = [];
	for (const relative of paths) {
		const left = before.get(relative);
		const right = after.get(relative);
		if (left?.hash === right?.hash && left?.kind === right?.kind) continue;
		output.push(`diff --experiment a/${relative} b/${relative}`);
		if (left?.kind === "file" && right?.kind === "file" && left.bytes <= 1_000_000 && right.bytes <= 1_000_000) {
			const [leftText, rightText] = await Promise.all([
				Bun.file(path.join(beforeRoot, relative)).text(),
				Bun.file(path.join(afterRoot, relative)).text(),
			]);
			if (!leftText.includes("\0") && !rightText.includes("\0")) {
				output.push(`--- a/${relative}`, `+++ b/${relative}`);
				for (const line of leftText.split("\n")) output.push(`-${line}`);
				for (const line of rightText.split("\n")) output.push(`+${line}`);
				continue;
			}
		}
		output.push(`Binary or structural change: ${left?.hash ?? "/dev/null"} -> ${right?.hash ?? "/dev/null"}`);
	}
	return `${output.join("\n")}\n`;
}

async function copySessionForRun(sourceFile: string, runSessionDir: string): Promise<string> {
	await fs.mkdir(runSessionDir, { recursive: true });
	const destination = path.join(runSessionDir, path.basename(sourceFile));
	await fs.copyFile(sourceFile, destination);
	const sourceArtifacts = sourceFile.endsWith(".jsonl") ? sourceFile.slice(0, -6) : `${sourceFile}.artifacts`;
	try {
		await fs.cp(
			sourceArtifacts,
			destination.endsWith(".jsonl") ? destination.slice(0, -6) : `${destination}.artifacts`,
			{
				recursive: true,
				preserveTimestamps: true,
				filter: copyFilter(false),
			},
		);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return destination;
}

async function runEvaluator(options: CliOptions, workspace: string, output: string): Promise<void> {
	const evaluatorPython = path.join(options.uvEnvironment, "bin", "python");
	const process = Bun.spawn(
		[
			"python3",
			path.join(import.meta.dir, "score.py"),
			"--workspace",
			workspace,
			"--output",
			output,
			"--python",
			evaluatorPython,
		],
		{
			cwd: ROOT,
			env: { ...Bun.env, UV_PROJECT_ENVIRONMENT: options.uvEnvironment },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	await Bun.write(`${output}.stdout.txt`, stdout);
	await Bun.write(`${output}.stderr.txt`, stderr);
	await writeJson(`${output}.exit.json`, { exitCode });
	if (!(await Bun.file(output).exists())) {
		throw new Error(`external evaluator produced no report (exit ${exitCode}); see ${output}.stderr.txt`);
	}
}

async function continueRuns(options: CliOptions, protocol: ProtocolState): Promise<void> {
	if (protocol.stage !== "derived") return;
	if (!protocol.shared || !protocol.contexts) throw new Error("derived context metadata missing");
	const completed = new Set((protocol.runs ?? []).map(run => `${run.replicate}:${run.condition}`));
	const order = seededConditionOrder(protocol.seed, protocol.replicates);
	const occurrence: Record<Condition, number> = { raw: 0, shake: 0, "report-only": 0, "report+manifest": 0 };
	let newRuns = 0;
	for (const condition of order) {
		const replicate = ++occurrence[condition];
		if (completed.has(`${replicate}:${condition}`)) continue;
		const anonymousId = `${String(protocol.runs?.length ?? 0).padStart(3, "0")}-${crypto.randomUUID()}`;
		const directory = path.join(options.artifactDir, "runs", anonymousId);
		await replaceCopy(path.join(options.artifactDir, "seed", "s1", "workspace"), options.workspace, true);
		await linkRuntimeEnvironment(options);
		const context = protocol.contexts[condition];
		const sessionFile = await copySessionForRun(context.sessionFile, path.join(directory, "sessions"));
		const continuationBoundaryId = await anchorSessionBranch(
			sessionFile,
			context.leafId,
			`continue-${condition}-${replicate}`,
			condition === "report-only",
		);
		const handle = await startClient(options, path.join(directory, "bootstrap-session"));
		try {
			await handle.client.switchSession(sessionFile);
			assertConditionContext(condition, await allEntries(handle.client));
			const initialState = await assertIdle(handle.client);
			assertWorkspace(initialState, options);
			if (!equalTodoState(protocol.shared.todoState, initialState.todoPhases)) {
				throw new Error(`${condition} todo state differs from S1 before continuation`);
			}
			await writeJson(path.join(directory, "private-condition.json"), {
				condition,
				replicate,
				leafId: context.leafId,
			});
			await writeJson(path.join(directory, "initial-state.json"), initialState);
			await promptAndWait(handle.client, continuationPrompt, options.timeoutMs);
			assertNoProviderFailure(handle.recorder);
			assertNoCompaction(handle.recorder);
			await assertIdle(handle.client);
			const finalTree = await handle.client.getSessionTree();
			if (!finalTree.currentLeafId) throw new Error(`${condition} continuation has no leaf`);
			const finalEntries = await allEntries(handle.client);
			assertConditionContext(condition, finalEntries);
			await writeJson(
				path.join(directory, "treatment-context.json"),
				findFirstAssistantPromptUsage(finalEntries, finalTree.currentLeafId, continuationBoundaryId),
			);
			await persistRecorder(directory, handle);
			await replaceCopy(options.workspace, path.join(directory, "final-workspace"), false);
			await writeJson(path.join(directory, "final-manifest.json"), await treeManifest(options.workspace));
			await Bun.write(
				path.join(directory, "final.patch"),
				await buildDiff(path.join(options.artifactDir, "seed", "s1", "workspace"), options.workspace),
			);
			await runEvaluator(options, options.workspace, path.join(directory, "verification.json"));
			protocol.runs = [...(protocol.runs ?? []), { id: anonymousId, condition, replicate, status: "complete" }];
			await saveProtocol(protocol);
			newRuns++;
			if (options.maxNewRuns !== undefined && newRuns >= options.maxNewRuns) return;
		} catch (error) {
			await persistFailure(directory, handle, error);
			throw error;
		} finally {
			await stopClient(handle);
		}
	}
	protocol.stage = "continued";
	await saveProtocol(protocol);
}

async function validatePins(options: CliOptions, protocol: ProtocolState): Promise<void> {
	if (
		protocol.source !== options.source ||
		protocol.workspace !== options.workspace ||
		protocol.artifactDir !== options.artifactDir
	) {
		throw new Error("restart path arguments differ from frozen protocol");
	}
	if (protocol.uvEnvironment !== options.uvEnvironment) {
		throw new Error("restart UV environment differs from frozen protocol");
	}
	if (
		protocol.model.provider !== options.provider ||
		protocol.model.id !== options.modelId ||
		protocol.model.thinking !== options.thinking ||
		JSON.stringify(protocol.model.configs) !== JSON.stringify(options.configs)
	) {
		throw new Error("restart model/thinking/config differs from frozen protocol");
	}
	if (protocol.seed !== options.seed || protocol.replicates !== options.replicates) {
		throw new Error("restart seed/replicate count differs from frozen protocol");
	}
	const currentConfigHashes = await configHashes(options.configs);
	if (protocol.stage !== "empty" && JSON.stringify(currentConfigHashes) !== JSON.stringify(protocol.configHashes)) {
		throw new Error("config overlay bytes differ from frozen protocol");
	}
	const hashes = await promptHashes();
	if (protocol.stage !== "empty" && JSON.stringify(hashes) !== JSON.stringify(protocol.prompts)) {
		throw new Error("static prompt bytes differ from frozen protocol");
	}
}

export async function main(args = Bun.argv.slice(2)): Promise<void> {
	const options = parseCli(args);
	const protocol = await loadProtocol(options);
	await validatePins(options, protocol);
	if (options.mode === "prepare") {
		await prepare(options, protocol);
		return;
	}
	if (options.mode === "derive") {
		if (protocol.stage !== "shared" && protocol.stage !== "derived")
			throw new Error("--derive-only requires completed shared stage");
		await derive(options, protocol);
		return;
	}
	if (options.mode === "continue") {
		if (protocol.stage !== "derived" && protocol.stage !== "continued")
			throw new Error("--continue requires completed derivation");
		await continueRuns(options, protocol);
		return;
	}
	await prepare(options, protocol);
	await runShared(options, protocol);
	await derive(options, protocol);
	await continueRuns(options, protocol);
}

if (import.meta.main) {
	await main();
}
