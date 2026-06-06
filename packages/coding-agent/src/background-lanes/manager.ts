import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreeDir, hashPath, isEnoent, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { GoalRuntime } from "../goals/runtime";
import type { GoalModeState } from "../goals/state";
import { defineRpcClientTool, RpcClient, type RpcClientCustomTool } from "../modes/rpc/rpc-client";
import laneHandoffTemplate from "../prompts/background-lanes/lane-handoff.md" with { type: "text" };
import { resolveOmpCommand } from "../task/omp-command";
import { ToolError } from "../tools/tool-errors";
import * as git from "../utils/git";
import {
	type BackgroundLane,
	type BackgroundLaneAgentStatus,
	type BackgroundLaneCloseOutcome,
	type BackgroundLaneContract,
	type BackgroundLaneListItem,
	type BackgroundLanePatchSnapshot,
	type BackgroundLaneReport,
	type BackgroundLaneSpawnFailureStage,
	type BackgroundLaneSpawnRequest,
	backgroundLaneListItem,
	cloneBackgroundLane,
} from "./state";

export interface BackgroundLaneSpawnInput extends BackgroundLaneSpawnRequest {}

export interface BackgroundLaneMessageInput {
	laneId: string;
	message: string;
}

export interface BackgroundLaneCloseInput {
	laneId: string;
	outcome: BackgroundLaneCloseOutcome;
	reason: string;
	mergedSourceRef?: string;
	operatorStatement?: string;
}

export interface LaneReportInput {
	laneId: string;
	summary: string;
	blocksIfFired: boolean;
	changedFiles?: string[];
	evidenceRefs?: string[];
	nonClaims?: string[];
	staleIf?: string[];
}

export interface BackgroundLaneSpawnResult {
	lane: BackgroundLane;
	operationId?: string;
	spawnFailed: boolean;
}

export interface BackgroundLaneMessageResult {
	lane: BackgroundLane;
	operationId: string;
}

export interface BackgroundLaneSnapshotResult {
	lane: BackgroundLane;
	agentStatus: BackgroundLaneAgentStatus;
	branch?: string;
	worktreePath?: string;
	headSourceRef: string | null;
	changedFiles: string[];
	patchRef?: string;
	latestReportRef?: string;
	blocksIfFired: boolean;
}

export interface BackgroundLaneCloseResult {
	lane: BackgroundLane;
}

export interface BackgroundLaneHost {
	cwd: string;
	getGoalModeState(): GoalModeState | undefined;
	getGoalRuntime(): GoalRuntime | undefined;
	getParentSessionRef(): string | undefined;
	getSessionDir(): string | undefined;
	ensureDurableSession(): Promise<void>;
	flushDurableSession(): Promise<void>;
	saveArtifact(content: string, toolType: string): Promise<string | undefined>;
	appendLaneAuditMessage(input: {
		kind: "created" | "updated" | "report" | "closed";
		lane: BackgroundLane;
		content: string;
		details: unknown;
	}): string | undefined;
	emitBackgroundLaneUpdate(lane: BackgroundLane): void | Promise<void>;
}

export interface LaneChildLaunchInput {
	lane: BackgroundLane;
	handoff: string;
	parentSessionRef?: string;
	sessionDir?: string;
	signal?: AbortSignal;
	onReport(input: LaneReportInput): Promise<BackgroundLaneReport>;
	onAgentStatus(status: BackgroundLaneAgentStatus, operationId?: string): Promise<void>;
}

export interface LaneChildMessageInput {
	lane: BackgroundLane;
	message: string;
	parentSessionRef?: string;
	sessionDir?: string;
	signal?: AbortSignal;
	onReport(input: LaneReportInput): Promise<BackgroundLaneReport>;
	onAgentStatus(status: BackgroundLaneAgentStatus, operationId?: string): Promise<void>;
}

export interface LaneChildOperationResult {
	sessionRef: string;
	sessionFile?: string;
	operationId: string;
}

export interface BackgroundLaneChildLauncher {
	launch(input: LaneChildLaunchInput): Promise<LaneChildOperationResult>;
	sendMessage(input: LaneChildMessageInput): Promise<LaneChildOperationResult>;
}

const WORKTREE_PATH_MAX_SUFFIX = 100;

function trimmed(value: string, field: string): string {
	const clean = value.trim();
	if (!clean) throw new ToolError(`${field} must not be empty`);
	return clean;
}

function toArtifactRef(id: string | undefined): string | undefined {
	return id ? `artifact://${id}` : undefined;
}

function splitGitLines(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function renderLaneHandoff(lane: BackgroundLane): string {
	return prompt.render(laneHandoffTemplate, {
		laneId: lane.id,
		checkpointId: lane.origin.checkpointId ?? "none",
		sourceRef: lane.origin.sourceRef,
		sourceCommit: lane.origin.sourceCommit,
		question: lane.contract.question,
		blocksIf: lane.contract.blocksIf,
		requiredBeforeParent: String(lane.contract.requiredBeforeParent),
		assignment: lane.assignment,
	});
}

function branchRef(branchName: string): string {
	return `refs/heads/${branchName}`;
}

async function resolveAvailableWorktreePath(
	basePath: string,
	existingWorktrees: git.GitWorktreeEntry[],
): Promise<string> {
	const registered = new Set(existingWorktrees.map(entry => path.resolve(entry.path)));
	for (let attempt = 0; attempt < WORKTREE_PATH_MAX_SUFFIX; attempt += 1) {
		const candidate = attempt === 0 ? basePath : `${basePath}-${attempt + 1}`;
		const normalized = path.resolve(candidate);
		if (registered.has(normalized)) continue;
		try {
			await fs.stat(normalized);
		} catch (error) {
			if (isEnoent(error)) return candidate;
			throw error;
		}
	}
	throw new ToolError(`could not find an unused background-lane worktree path under ${basePath}`);
}

function normalizeReportParams(params: Record<string, unknown>): LaneReportInput {
	const laneId = typeof params.lane_id === "string" ? params.lane_id : undefined;
	const summary = typeof params.summary === "string" ? params.summary : undefined;
	if (!laneId?.trim()) throw new ToolError("lane_report.lane_id must be a non-empty string");
	if (!summary?.trim()) throw new ToolError("lane_report.summary must be a non-empty string");
	const array = (key: string): string[] =>
		Array.isArray(params[key]) ? params[key].filter((entry): entry is string => typeof entry === "string") : [];
	return {
		laneId: laneId.trim(),
		summary: summary.trim(),
		blocksIfFired: params.blocks_if_fired === true,
		changedFiles: array("changed_files"),
		evidenceRefs: array("evidence_refs"),
		nonClaims: array("non_claims"),
		staleIf: array("stale_if"),
	};
}

function createLaneReportTool(
	onReport: (input: LaneReportInput) => Promise<BackgroundLaneReport>,
): RpcClientCustomTool<Record<string, unknown>, { laneId: string; reportId?: string; blocksIfFired?: boolean }> {
	return defineRpcClientTool({
		name: "lane_report",
		label: "Lane report",
		description:
			"Report structured background-lane findings. Parent blocker state is updated only from this tool, never from prose.",
		hidden: false,
		sideEffectClass: "write",
		trustClass: "host",
		parameters: {
			type: "object",
			required: ["lane_id", "summary", "blocks_if_fired"],
			properties: {
				lane_id: { type: "string" },
				summary: { type: "string" },
				blocks_if_fired: { type: "boolean" },
				changed_files: { type: "array", items: { type: "string" } },
				evidence_refs: { type: "array", items: { type: "string" } },
				non_claims: { type: "array", items: { type: "string" } },
				stale_if: { type: "array", items: { type: "string" } },
			},
			additionalProperties: false,
		},
		async execute(params) {
			const report = await onReport(normalizeReportParams(params));
			return {
				content: [
					{
						type: "text",
						text: report.blocksIfFired
							? "Lane report recorded. The lane blocker fired and parent continuation is interrupted."
							: "Lane report recorded.",
					},
				],
				details: { laneId: report.laneId, reportId: report.id, blocksIfFired: report.blocksIfFired },
			};
		},
	});
}

export class RpcBackgroundLaneChildLauncher implements BackgroundLaneChildLauncher {
	#clients = new Map<string, RpcClient>();
	#operationIds = new Map<string, string>();

	async launch(input: LaneChildLaunchInput): Promise<LaneChildOperationResult> {
		const client = await this.#clientForLane(input.lane, input, false);
		if (!input.lane.agent.sessionFile) {
			await client.newSession(input.parentSessionRef);
		}
		const latestState = await client.getState();
		const ack = await client.followUp(input.handoff);
		void this.#trackOperation(input, ack.operationId);
		return {
			sessionRef: latestState.sessionId,
			sessionFile: latestState.sessionFile,
			operationId: ack.operationId,
		};
	}

	async sendMessage(input: LaneChildMessageInput): Promise<LaneChildOperationResult> {
		const client = await this.#clientForLane(input.lane, input, true);
		const state = await client.getState();
		const ack = await client.followUp(input.message);
		void this.#trackOperation(input, ack.operationId);
		return { sessionRef: state.sessionId, sessionFile: state.sessionFile, operationId: ack.operationId };
	}

	async #clientForLane(
		lane: BackgroundLane,
		input: LaneChildLaunchInput | LaneChildMessageInput,
		allowResume: boolean,
	): Promise<RpcClient> {
		const existing = this.#clients.get(lane.id);
		if (existing) return existing;
		if (!lane.branch.worktreePath) throw new ToolError(`background lane ${lane.id} has no worktree path`);
		const command = resolveOmpCommand();
		const args = [...command.args];
		if (input.sessionDir) args.push("--session-dir", input.sessionDir);
		if (allowResume && lane.agent.sessionFile) args.push("--session", lane.agent.sessionFile);
		args.push("--no-title");
		const client = new RpcClient({
			command: { cmd: command.cmd, args, shell: command.shell },
			cwd: lane.branch.worktreePath,
			customTools: [createLaneReportTool(input.onReport)],
			onFrame: frame => {
				if (typeof frame !== "object" || frame === null) return;
				const candidate = frame as { type?: unknown; operationId?: unknown };
				if (candidate.operationId !== this.#operationIds.get(lane.id)) return;
				if (candidate.type === "operation_end") void input.onAgentStatus("idle", candidate.operationId as string);
				else if (candidate.type === "operation_error")
					void input.onAgentStatus("failed", candidate.operationId as string);
			},
		});
		await client.start();
		this.#clients.set(lane.id, client);
		await input.onAgentStatus("running");
		return client;
	}

	async #trackOperation(input: LaneChildLaunchInput | LaneChildMessageInput, operationId: string): Promise<void> {
		this.#operationIds.set(input.lane.id, operationId);
		await input.onAgentStatus("running", operationId);
	}
}

export class BackgroundLaneManager {
	readonly #host: BackgroundLaneHost;
	readonly #launcher: BackgroundLaneChildLauncher;

	constructor(host: BackgroundLaneHost, launcher: BackgroundLaneChildLauncher = new RpcBackgroundLaneChildLauncher()) {
		this.#host = host;
		this.#launcher = launcher;
	}

	list(): BackgroundLaneListItem[] {
		return (this.#host.getGoalModeState()?.goal.backgroundLanes ?? []).map(backgroundLaneListItem);
	}

	async spawn(input: BackgroundLaneSpawnInput, signal?: AbortSignal): Promise<BackgroundLaneSpawnResult> {
		const state = this.#host.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") {
			throw new ToolError("background_lane.spawn requires an active goal");
		}
		if (!input.from.checkpointId) {
			throw new ToolError("background_lane.spawn requires checkpoint_id when goal mode is active");
		}
		if (state.goal.pendingCheckpointId || state.runMode === "awaiting-checkpoint-resolution") {
			throw new ToolError(
				"background_lane.spawn requires checkpoint resolution to be recorded before spawning lanes",
			);
		}
		if (state.runMode === "awaiting-parent-completion") {
			throw new ToolError("background_lane.spawn is not allowed while parent completion verification is pending");
		}
		if (state.runMode === "awaiting-background-lane-intake") {
			throw new ToolError("background_lane.spawn is not allowed while a background lane blocker requires intake");
		}
		if (input.from.checkpointId) {
			const checkpoint = state.goal.checkpoints?.find(candidate => candidate.id === input.from.checkpointId);
			if (checkpoint?.review?.status !== "accepted") {
				throw new ToolError(`checkpoint_id is not an accepted checkpoint: ${input.from.checkpointId}`);
			}
		}
		const sourceRef = trimmed(input.from.sourceRef, "source_ref");
		const contract: BackgroundLaneContract = {
			question: trimmed(input.contract.question, "question"),
			blocksIf: trimmed(input.contract.blocksIf, "blocks_if"),
			requiredBeforeParent: input.contract.requiredBeforeParent === true,
		};
		const assignment = trimmed(input.assignment, "assignment");
		const repoRoot = await this.#requireCleanRepo(signal);
		const sourceCommit = await this.#resolveSourceCommit(repoRoot, sourceRef, signal);
		const now = Date.now();
		const lane: BackgroundLane = {
			id: `lane_${Snowflake.next()}`,
			goalId: state.goal.id,
			origin: { checkpointId: input.from.checkpointId, sourceRef, sourceCommit },
			branch: {},
			agent: { status: "starting" },
			contract,
			assignment,
			status: "open",
			outcome: null,
			blocksIfFired: false,
			changedFiles: [],
			evidenceRefs: [],
			nonClaims: [
				"Lane output is candidate evidence only.",
				"Branch, patch, check, RPC ACK, child prose, and lane close do not complete the parent goal.",
			],
			staleIf: [],
			reports: [],
			createdAt: now,
			updatedAt: now,
		};
		const assignmentId = await this.#host.saveArtifact(assignment, "background-lane-assignment");
		if (assignmentId) lane.assignmentRef = toArtifactRef(assignmentId);
		await this.#host.ensureDurableSession();
		let persisted = await this.#runtime().recordBackgroundLaneCreated(lane);
		await this.#host.flushDurableSession();
		let currentLane = this.#findLaneInState(persisted, lane.id);
		this.#appendAudit("created", currentLane);
		await this.#host.emitBackgroundLaneUpdate(currentLane);

		const branchName = `omp/lane/${lane.id}`;
		try {
			const branch = await this.#createWorktree(repoRoot, currentLane, branchName, signal);
			persisted = await this.#runtime().recordBackgroundLaneBranch(currentLane.id, branch);
			currentLane = this.#findLaneInState(persisted, lane.id);
			this.#appendAudit("updated", currentLane);
			await this.#host.emitBackgroundLaneUpdate(currentLane);
		} catch (error) {
			const failed = await this.#markSpawnFailed(currentLane.id, "worktree", error, { branchName });
			return { lane: failed, spawnFailed: true };
		}

		try {
			const result = await this.#launcher.launch({
				lane: currentLane,
				handoff: renderLaneHandoff(currentLane),
				parentSessionRef: this.#host.getParentSessionRef(),
				sessionDir: this.#host.getSessionDir(),
				signal,
				onReport: report => this.report(report),
				onAgentStatus: (status, operationId) => this.updateAgentStatus(currentLane.id, status, operationId),
			});
			persisted = await this.#runtime().recordBackgroundLaneAgent(currentLane.id, {
				sessionRef: result.sessionRef,
				sessionFile: result.sessionFile,
				status: "running",
				lastOperationId: result.operationId,
			});
			currentLane = this.#findLaneInState(persisted, lane.id);
			this.#appendAudit("updated", currentLane);
			await this.#host.emitBackgroundLaneUpdate(currentLane);
			return { lane: currentLane, operationId: result.operationId, spawnFailed: false };
		} catch (error) {
			const failed = await this.#markSpawnFailed(currentLane.id, "session", error);
			return { lane: failed, spawnFailed: true };
		}
	}

	async message(input: BackgroundLaneMessageInput, signal?: AbortSignal): Promise<BackgroundLaneMessageResult> {
		const lane = this.#requireLane(input.laneId);
		if (lane.status === "closed") throw new ToolError(`background lane ${lane.id} is closed`);
		const message = trimmed(input.message, "message");
		const messageId = await this.#host.saveArtifact(message, "background-lane-message");
		const result = await this.#launcher.sendMessage({
			lane,
			message,
			parentSessionRef: this.#host.getParentSessionRef(),
			sessionDir: this.#host.getSessionDir(),
			signal,
			onReport: report => this.report(report),
			onAgentStatus: (status, operationId) => this.updateAgentStatus(lane.id, status, operationId),
		});
		const state = await this.#runtime().recordBackgroundLaneAgent(lane.id, {
			sessionRef: result.sessionRef,
			sessionFile: result.sessionFile,
			status: "running",
			lastOperationId: result.operationId,
		});
		const updated = this.#findLaneInState(state, lane.id);
		this.#appendAudit("updated", updated, messageId ? `Message artifact: ${toArtifactRef(messageId)}` : undefined);
		await this.#host.emitBackgroundLaneUpdate(updated);
		return { lane: updated, operationId: result.operationId };
	}

	async snapshot(laneId: string, signal?: AbortSignal): Promise<BackgroundLaneSnapshotResult> {
		const lane = this.#requireLane(laneId);
		let headSourceRef: string | null = null;
		let changedFiles: string[] = [];
		let patchRef: string | undefined;
		if (lane.branch.worktreePath) {
			headSourceRef = await git.ref.resolve(lane.branch.worktreePath, "HEAD", signal);
			changedFiles = splitGitLines(
				await git.diff(lane.branch.worktreePath, { base: lane.origin.sourceCommit, nameOnly: true, signal }),
			);
			const patch = await git.diff(lane.branch.worktreePath, {
				base: lane.origin.sourceCommit,
				binary: true,
				signal,
			});
			if (patch.trim()) {
				const artifactId = await this.#host.saveArtifact(patch, "background-lane-patch");
				patchRef = toArtifactRef(artifactId);
			}
		}
		const snapshot: BackgroundLanePatchSnapshot = {
			laneId: lane.id,
			headSourceRef,
			changedFiles,
			patchRef,
			capturedAt: Date.now(),
		};
		const state = await this.#runtime().recordBackgroundLaneSnapshot(lane.id, snapshot);
		const updated = this.#findLaneInState(state, lane.id);
		this.#appendAudit("updated", updated);
		await this.#host.emitBackgroundLaneUpdate(updated);
		return {
			lane: updated,
			agentStatus: updated.agent.status,
			branch: updated.branch.name,
			worktreePath: updated.branch.worktreePath,
			headSourceRef,
			changedFiles,
			patchRef,
			latestReportRef: updated.latestReportRef,
			blocksIfFired: updated.blocksIfFired,
		};
	}

	async close(input: BackgroundLaneCloseInput): Promise<BackgroundLaneCloseResult> {
		const lane = this.#requireLane(input.laneId);
		if (input.outcome === "merged" && !input.mergedSourceRef?.trim() && !input.operatorStatement?.trim()) {
			throw new ToolError("background_lane.close outcome=merged requires merged_source_ref or operator_statement");
		}
		if (input.mergedSourceRef?.trim()) {
			await this.#resolveSourceCommit(this.#host.cwd, input.mergedSourceRef.trim(), undefined);
		}
		const state = await this.#runtime().recordBackgroundLaneClosed(lane.id, {
			outcome: input.outcome,
			reason: trimmed(input.reason, "reason"),
			mergedSourceRef: input.mergedSourceRef?.trim() || undefined,
			operatorStatement: input.operatorStatement?.trim() || undefined,
			closedAt: Date.now(),
		});
		const updated = this.#findLaneInState(state, lane.id);
		this.#appendAudit("closed", updated);
		await this.#host.emitBackgroundLaneUpdate(updated);
		return { lane: updated };
	}

	async report(input: LaneReportInput): Promise<BackgroundLaneReport> {
		const lane = this.#requireLane(input.laneId);
		if (lane.status === "closed") throw new ToolError(`background lane ${lane.id} is closed`);
		const report: BackgroundLaneReport = {
			id: `${lane.id}-report-${lane.reports.length + 1}`,
			laneId: lane.id,
			summary: trimmed(input.summary, "summary"),
			blocksIfFired: input.blocksIfFired === true,
			changedFiles: [...(input.changedFiles ?? [])],
			evidenceRefs: [...(input.evidenceRefs ?? [])],
			nonClaims: [...(input.nonClaims ?? [])],
			staleIf: [...(input.staleIf ?? [])],
			createdAt: Date.now(),
		};
		const artifactId = await this.#host.saveArtifact(JSON.stringify(report, null, 2), "background-lane-report");
		report.artifactRef = toArtifactRef(artifactId);
		const state = await this.#runtime().recordBackgroundLaneReport(lane.id, report);
		const updated = this.#findLaneInState(state, lane.id);
		const messageRef = this.#appendAudit("report", updated, report.summary);
		if (messageRef) {
			report.sessionMessageRef = messageRef;
			const stateWithRef = await this.#runtime().recordBackgroundLaneReportSessionRef(
				lane.id,
				report.id,
				messageRef,
			);
			const withRef = this.#findLaneInState(stateWithRef, lane.id);
			await this.#host.emitBackgroundLaneUpdate(withRef);
		} else {
			await this.#host.emitBackgroundLaneUpdate(updated);
		}
		return report;
	}

	async updateAgentStatus(laneId: string, status: BackgroundLaneAgentStatus, operationId?: string): Promise<void> {
		const state = await this.#runtime().recordBackgroundLaneAgent(laneId, { status, lastOperationId: operationId });
		const lane = this.#findLaneInState(state, laneId);
		await this.#host.emitBackgroundLaneUpdate(lane);
	}

	async #requireCleanRepo(signal?: AbortSignal): Promise<string> {
		const root = await git.repo.root(this.#host.cwd, signal);
		if (!root) throw new ToolError("background lanes require a git repository");
		const dirty = await git.status(root, { untrackedFiles: "all", signal });
		if (dirty.trim()) throw new ToolError("background_lane.spawn requires a clean working tree in v1");
		return root;
	}

	async #resolveSourceCommit(cwd: string, sourceRef: string, signal?: AbortSignal): Promise<string> {
		const commit = await git.ref.resolve(cwd, `${sourceRef}^{commit}`, signal);
		if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) {
			throw new ToolError(`source_ref is not a materialized commit: ${sourceRef}`);
		}
		return commit;
	}

	async #createWorktree(
		repoRoot: string,
		lane: BackgroundLane,
		branchName: string,
		signal?: AbortSignal,
	): Promise<{ name: string; worktreePath: string }> {
		const primaryRoot = (await git.repo.primaryRoot(repoRoot, signal)) ?? repoRoot;
		return await git.withRepoLock(
			repoRoot,
			async () => {
				const existingWorktrees = await git.worktree.list(repoRoot, signal);
				const existingBranchWorktree = existingWorktrees.find(entry => entry.branch === branchRef(branchName));
				if (existingBranchWorktree) {
					throw new ToolError(`background lane branch already has a worktree: ${branchName}`);
				}
				if (await git.ref.exists(repoRoot, branchRef(branchName), signal)) {
					throw new ToolError(`background lane branch already exists: ${branchName}`);
				}
				const basePath = getWorktreeDir(`lane-${lane.id}-${hashPath(primaryRoot)}`);
				const worktreePath = await resolveAvailableWorktreePath(basePath, existingWorktrees);
				await fs.mkdir(path.dirname(worktreePath), { recursive: true });
				await git.branch.create(repoRoot, branchName, lane.origin.sourceCommit, signal);
				await git.worktree.add(repoRoot, worktreePath, branchName, { signal });
				return { name: branchName, worktreePath: await fs.realpath(worktreePath) };
			},
			signal,
		);
	}

	async #markSpawnFailed(
		laneId: string,
		stage: BackgroundLaneSpawnFailureStage,
		error: unknown,
		partial?: { branchName?: string },
	): Promise<BackgroundLane> {
		const state = await this.#runtime().recordBackgroundLaneSpawnFailed(laneId, {
			stage,
			message: errorMessage(error),
			retryable: true,
			failedAt: Date.now(),
			branchName: partial?.branchName,
		});
		const lane = this.#findLaneInState(state, laneId);
		this.#appendAudit("updated", lane, `Spawn failed (${stage}): ${lane.spawnFailure?.message ?? "unknown failure"}`);
		await this.#host.emitBackgroundLaneUpdate(lane);
		return lane;
	}

	#runtime(): GoalRuntime {
		const runtime = this.#host.getGoalRuntime();
		if (!runtime) throw new ToolError("Goal mode is not active.");
		return runtime;
	}

	#requireLane(laneId: string): BackgroundLane {
		const id = trimmed(laneId, "lane_id");
		const lane = this.#host.getGoalModeState()?.goal.backgroundLanes?.find(candidate => candidate.id === id);
		if (!lane) throw new ToolError(`unknown background lane: ${id}`);
		return cloneBackgroundLane(lane);
	}

	#findLaneInState(state: GoalModeState, laneId: string): BackgroundLane {
		const lane = state.goal.backgroundLanes?.find(candidate => candidate.id === laneId);
		if (!lane) throw new ToolError(`background lane missing after update: ${laneId}`);
		return cloneBackgroundLane(lane);
	}

	#appendAudit(
		kind: "created" | "updated" | "report" | "closed",
		lane: BackgroundLane,
		note?: string,
	): string | undefined {
		const sections = [
			`## Background lane ${kind}`,
			`Lane: ${lane.id}`,
			`Question: ${lane.contract.question}`,
			`Status: ${lane.status}`,
			`Required before parent: ${lane.contract.requiredBeforeParent}`,
			`Blocks if fired: ${lane.blocksIfFired}`,
		];
		if (lane.branch.name) sections.push(`Branch: ${lane.branch.name}`);
		if (lane.branch.worktreePath) sections.push(`Worktree: ${lane.branch.worktreePath}`);
		if (lane.latestReportRef) sections.push(`Latest report: ${lane.latestReportRef}`);
		if (lane.latestPatchRef) sections.push(`Latest patch: ${lane.latestPatchRef}`);
		if (lane.closeDisposition) {
			sections.push(`Outcome: ${lane.closeDisposition.outcome}`);
			sections.push(`Reason: ${lane.closeDisposition.reason}`);
		}
		if (note) sections.push(`Note: ${note}`);
		return this.#host.appendLaneAuditMessage({
			kind,
			lane,
			content: sections.join("\n"),
			details: {
				laneId: lane.id,
				reportId: kind === "report" ? lane.reports.at(-1)?.id : undefined,
				status: lane.status,
				kind,
				blocksIfFired: lane.blocksIfFired,
			},
		});
	}
}
