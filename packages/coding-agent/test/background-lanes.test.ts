import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type BackgroundLaneChildLauncher,
	type BackgroundLaneHost,
	BackgroundLaneManager,
	type LaneChildLaunchInput,
	type LaneChildMessageInput,
	type LaneChildOperationResult,
} from "@oh-my-pi/pi-coding-agent/background-lanes";
import type { BackgroundLane, BackgroundLaneSpawnRequest } from "@oh-my-pi/pi-coding-agent/background-lanes/state";
import { GoalRuntime, type GoalRuntimeHost } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type {
	Goal,
	GoalCheckpointPacket,
	GoalModeState,
	GoalParentStateDelta,
	GoalRuntimeEvent,
	GoalTarget,
} from "@oh-my-pi/pi-coding-agent/goals/state";
import { cloneGoalModeState, parseGoalModeState, serializeGoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	BACKGROUND_LANE_CLOSED_MESSAGE_TYPE,
	BACKGROUND_LANE_CREATED_MESSAGE_TYPE,
	BACKGROUND_LANE_REPORT_MESSAGE_TYPE,
	BACKGROUND_LANE_UPDATED_MESSAGE_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { type ModeChangeEntry, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getWorktreeDir, hashPath, isEnoent } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

function cloneState(state: GoalModeState | undefined): GoalModeState | undefined {
	return state ? cloneGoalModeState(state) : undefined;
}

function createTarget(): GoalTarget {
	return {
		id: "target-1",
		sequence: 1,
		status: "closed",
		title: "Close bounded target",
		desiredFutureClaim: "Target claim is bounded.",
		closureStandard: "Evidence exists.",
		baselineRefs: [],
		gateRefs: [],
		evidenceExpectation: [],
		nonGoals: [],
		forbiddenClaims: [],
		staleIf: [],
		createdAt: 1,
		closedAt: 2,
		createdBy: "initial",
	};
}

function createCheckpoint(): GoalCheckpointPacket {
	const target = createTarget();
	return {
		id: "goal-1-checkpoint-1",
		sequence: 1,
		goalId: "goal-1",
		targetId: target.id,
		targetSnapshot: target,
		parentFrameVersion: 0,
		baselineRefs: [],
		gateRefs: [],
		workEpoch: 0,
		status: "closed_with_evidence",
		summary: "Target closed with evidence.",
		localClaims: ["Bounded claim"],
		evidence: [{ claim: "Bounded claim", evidence: "Observed evidence", current: true }],
		checksRun: [],
		artifactsTouched: [],
		notClaimed: ["Parent complete"],
		remainingQuestions: ["Which background checks remain?"],
		risksOrCaveats: [],
		staleIf: [],
		suggestedControllerQuestions: [],
		createdAt: 2,
		review: {
			status: "accepted",
			feedback: "Accepted.",
			evidenceChecked: [{ claim: "Bounded claim", evidence: "Observed evidence", current: true }],
			blockers: [],
			reviewedAt: 3,
		},
	};
}

function createGoal(overrides: Partial<Goal> = {}): Goal {
	const checkpoint = createCheckpoint();
	return {
		id: "goal-1",
		objective: "Ship safely",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		workEpoch: 0,
		totalVerificationAttempts: 0,
		verificationAttempts: [],
		targets: [checkpoint.targetSnapshot],
		checkpoints: [checkpoint],
		checkpointResolutions: [],
		...overrides,
	};
}

function createState(goal: Goal = createGoal()): GoalModeState {
	return {
		enabled: true,
		mode: "active",
		runMode: "working-target",
		stateVersion: 1,
		parentFrameVersion: goal.parentFrame ? 1 : 0,
		goal,
	};
}

function createSpawnRequest(sourceRef: string, checkpointId = "goal-1-checkpoint-1"): BackgroundLaneSpawnRequest {
	return {
		from: { checkpointId, sourceRef },
		contract: {
			question: "Does the background finding refute the checkpoint?",
			blocksIf: "The checkpoint claim is false or stale.",
			requiredBeforeParent: true,
		},
		assignment: "Inspect the branch independently and report only through lane_report.",
	};
}

function emptyParentDelta(backgroundLanesToSpawn?: BackgroundLaneSpawnRequest[]): GoalParentStateDelta {
	return {
		admittedClaims: [],
		candidateClaimsAdded: [],
		rejectedClaims: [],
		boundariesAdded: [],
		residualsAddedOrUpdated: [],
		gateDeltas: [],
		frontierDeltas: [],
		staleRefs: [],
		externalRecordRefs: [],
		backgroundLanesToSpawn,
	};
}

class RecordingChildLauncher implements BackgroundLaneChildLauncher {
	launches: LaneChildLaunchInput[] = [];
	messages: LaneChildMessageInput[] = [];
	failLaunch: Error | undefined;
	operationSequence = 0;

	async launch(input: LaneChildLaunchInput): Promise<LaneChildOperationResult> {
		this.launches.push(input);
		if (this.failLaunch) throw this.failLaunch;
		this.operationSequence += 1;
		const operationId = `child-op-${this.operationSequence}`;
		await input.onAgentStatus("running", operationId);
		return {
			sessionRef: `child-session-${this.operationSequence}`,
			sessionFile: path.join(input.lane.branch.worktreePath ?? input.lane.id, ".omp-lane-session.jsonl"),
			operationId,
		};
	}

	async sendMessage(input: LaneChildMessageInput): Promise<LaneChildOperationResult> {
		this.messages.push(input);
		this.operationSequence += 1;
		const operationId = `child-op-${this.operationSequence}`;
		await input.onAgentStatus("running", operationId);
		return {
			sessionRef: input.lane.agent.sessionRef ?? `child-session-${this.operationSequence}`,
			sessionFile:
				input.lane.agent.sessionFile ??
				path.join(input.lane.branch.worktreePath ?? input.lane.id, ".omp-lane-session.jsonl"),
			operationId,
		};
	}
}

async function removeTestWorktrees(repoRoot: string): Promise<void> {
	const worktreeBase = path.dirname(getWorktreeDir("background-lane-test-placeholder"));
	try {
		await fs.stat(worktreeBase);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	const repoHash = hashPath(repoRoot);
	for (const dirent of await fs.readdir(worktreeBase, { withFileTypes: true })) {
		if (!dirent.name.startsWith("lane-lane_") || !dirent.name.includes(`-${repoHash}`)) continue;
		await fs.rm(path.join(worktreeBase, dirent.name), { recursive: true, force: true });
	}
}

async function createGitRepo(): Promise<{
	root: string;
	sessions: string;
	sourceCommit: string;
	cleanup: () => Promise<void>;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bg-lanes-repo-"));
	const sessions = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bg-lanes-sessions-"));
	await $`git init -q`.cwd(root).quiet();
	await $`git config user.email tests@example.com`.cwd(root).quiet();
	await $`git config user.name "OMP Tests"`.cwd(root).quiet();
	await Bun.write(path.join(root, "README.md"), "base\n");
	await $`git add README.md`.cwd(root).quiet();
	await $`git commit -q -m initial`.cwd(root).quiet();
	const sourceCommit = (await $`git rev-parse HEAD`.cwd(root).quiet().text()).trim();
	return {
		root,
		sessions,
		sourceCommit,
		cleanup: async () => {
			await removeTestWorktrees(root);
			await fs.rm(root, { recursive: true, force: true });
			await fs.rm(sessions, { recursive: true, force: true });
		},
	};
}

function customTypeFor(kind: "created" | "updated" | "report" | "closed"): string {
	switch (kind) {
		case "created":
			return BACKGROUND_LANE_CREATED_MESSAGE_TYPE;
		case "updated":
			return BACKGROUND_LANE_UPDATED_MESSAGE_TYPE;
		case "report":
			return BACKGROUND_LANE_REPORT_MESSAGE_TYPE;
		case "closed":
			return BACKGROUND_LANE_CLOSED_MESSAGE_TYPE;
	}
}

function latestGoalModeState(manager: SessionManager): GoalModeState | undefined {
	const modeEntry = manager
		.getEntries()
		.filter((entry): entry is ModeChangeEntry => entry.type === "mode_change" && entry.mode === "goal")
		.at(-1);
	return modeEntry ? parseGoalModeState(modeEntry.data, true) : undefined;
}

function createHarness(
	repoRoot: string,
	sessionDir: string,
	launcher: RecordingChildLauncher = new RecordingChildLauncher(),
	initialState: GoalModeState = createState(),
) {
	let state = cloneGoalModeState(initialState);
	const events: GoalRuntimeEvent[] = [];
	const laneUpdates: BackgroundLane[] = [];
	const sessionManager = SessionManager.create(repoRoot, sessionDir);
	const runtimeHost: GoalRuntimeHost = {
		getState: () => cloneState(state),
		setState: next => {
			state = cloneState(next) ?? state;
		},
		getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		emit: event => {
			events.push(event);
		},
		persist: (mode, persistedState) => {
			if (mode === "none") {
				sessionManager.appendModeChange("none");
			} else if (persistedState) {
				sessionManager.appendModeChange(mode, { ...serializeGoalModeState(persistedState) });
			}
		},
		sendHiddenMessage: async () => {},
		now: () => 10,
	};
	const runtime = new GoalRuntime(runtimeHost);
	const host: BackgroundLaneHost = {
		cwd: repoRoot,
		getGoalModeState: () => cloneState(state),
		getGoalRuntime: () => runtime,
		getParentSessionRef: () => sessionManager.getSessionId(),
		getSessionDir: () => sessionManager.getSessionDir(),
		ensureDurableSession: () => sessionManager.ensureOnDisk(),
		flushDurableSession: () => sessionManager.flush(),
		saveArtifact: (content, toolType) => sessionManager.saveArtifact(content, toolType),
		appendLaneAuditMessage: input => {
			return sessionManager.appendCustomMessageEntry(
				customTypeFor(input.kind),
				input.content,
				true,
				input.details,
				"agent",
			);
		},
		emitBackgroundLaneUpdate: lane => {
			laneUpdates.push(lane);
		},
	};
	return {
		manager: new BackgroundLaneManager(host, launcher),
		runtime,
		launcher,
		sessionManager,
		events,
		laneUpdates,
		getState: () => cloneGoalModeState(state),
		setState: (next: GoalModeState) => {
			state = cloneGoalModeState(next);
		},
	};
}

describe("background lanes", () => {
	it("persists the lane ledger before child side effects and survives recovery", async () => {
		const repo = await createGitRepo();
		try {
			const launcher = new RecordingChildLauncher();
			launcher.failLaunch = new Error("child rpc unavailable");
			const harness = createHarness(repo.root, repo.sessions, launcher, {
				...createState(createGoal({ pendingCheckpointId: "goal-1-checkpoint-1" })),
				runMode: "awaiting-checkpoint-resolution",
			});
			await expect(harness.manager.spawn(createSpawnRequest("HEAD"))).rejects.toThrow(/checkpoint resolution/);
			expect(harness.getState().goal.backgroundLanes ?? []).toHaveLength(0);

			await harness.runtime.recordCheckpointResolution({
				checkpointId: "goal-1-checkpoint-1",
				decision: "next_target",
				parentReading: "The checkpoint is accepted and a lane should run as a side effect.",
				parentDelta: emptyParentDelta([createSpawnRequest("HEAD")]),
				notPropagated: ["Lane output is not parent truth."],
				remainingParentWork: ["Disposition required lanes."],
				nextTarget: {
					title: "Continue spine",
					desiredFutureClaim: "Main spine can continue.",
					closureStandard: "A bounded next target exists.",
				},
			});
			expect(harness.getState().parentFrameVersion).toBe(0);
			expect(harness.getState().goal.parentFrame).toBeUndefined();

			const result = await harness.manager.spawn(createSpawnRequest("HEAD"));
			expect(result.spawnFailed).toBe(true);
			expect(result.lane.status).toBe("spawn_failed");
			expect(result.lane.retryable).toBe(true);
			expect(result.lane.spawnFailure).toMatchObject({ stage: "session", retryable: true });
			expect(result.lane.origin.checkpointId).toBe("goal-1-checkpoint-1");
			expect(result.lane.origin.sourceCommit).toBe(repo.sourceCommit);
			expect(result.lane.branch.name).toBe(`omp/lane/${result.lane.id}`);
			expect(harness.getState().goal.checkpointResolutions).toHaveLength(1);
			expect(harness.getState().goal.checkpoints?.[0]?.review?.status).toBe("accepted");

			await harness.sessionManager.flush();
			const sessionFile = harness.sessionManager.getSessionFile();
			expect(sessionFile).toBeString();
			const reopened = await SessionManager.open(sessionFile ?? "", repo.sessions);
			const restored = latestGoalModeState(reopened);
			expect(restored?.goal.checkpointResolutions).toHaveLength(1);
			const restoredLane = restored?.goal.backgroundLanes?.[0];
			expect(restoredLane).toMatchObject({
				id: result.lane.id,
				status: "spawn_failed",
				retryable: true,
				origin: { checkpointId: "goal-1-checkpoint-1", sourceCommit: repo.sourceCommit },
				agent: { status: "failed" },
			});
		} finally {
			await repo.cleanup();
		}
	});

	it("creates persistent worktree branches and snapshots lane diffs without accepting output", async () => {
		const repo = await createGitRepo();
		try {
			const harness = createHarness(repo.root, repo.sessions);
			const result = await harness.manager.spawn(createSpawnRequest("HEAD"));
			const lane = result.lane;
			expect(result.spawnFailed).toBe(false);
			expect(lane.status).toBe("open");
			expect(lane.branch.name).toBe(`omp/lane/${lane.id}`);
			expect(lane.branch.worktreePath).toBeString();
			expect((await fs.stat(lane.branch.worktreePath ?? "")).isDirectory()).toBe(true);
			expect(harness.launcher.launches).toHaveLength(1);
			expect(harness.launcher.launches[0]?.lane.branch.worktreePath).toBe(lane.branch.worktreePath);
			expect(harness.launcher.launches[0]?.parentSessionRef).toBe(harness.sessionManager.getSessionId());
			expect(harness.launcher.launches[0]?.handoff).toContain(`You are working in background lane ${lane.id}.`);
			expect(harness.launcher.launches[0]?.handoff).toContain("You may not claim parent completion");

			await harness.manager.updateAgentStatus(lane.id, "idle", result.operationId);
			const idleLane = harness.getState().goal.backgroundLanes?.[0];
			expect(idleLane?.status).toBe("open");
			expect(idleLane?.agent.status).toBe("idle");
			expect((await fs.stat(lane.branch.worktreePath ?? "")).isDirectory()).toBe(true);

			await Bun.write(path.join(lane.branch.worktreePath ?? "", "README.md"), "base\nlane change\n");
			const snapshot = await harness.manager.snapshot(lane.id);
			expect(snapshot.headSourceRef).toBe(repo.sourceCommit);
			expect(snapshot.changedFiles).toEqual(["README.md"]);
			expect(snapshot.patchRef).toStartWith("artifact://");
			expect(snapshot.lane.latestPatchRef).toBe(snapshot.patchRef);
			expect(snapshot.lane.status).toBe("open");
			expect(snapshot.blocksIfFired).toBe(false);
		} finally {
			await repo.cleanup();
		}
	});

	it("rejects invalid source refs, dirty source worktrees, and unaccepted checkpoints", async () => {
		const invalidRefRepo = await createGitRepo();
		try {
			const harness = createHarness(invalidRefRepo.root, invalidRefRepo.sessions);
			await expect(harness.manager.spawn(createSpawnRequest("missing-ref"))).rejects.toThrow(
				/source_ref is not a materialized commit/,
			);
			await expect(
				harness.manager.spawn(createSpawnRequest(`${invalidRefRepo.sourceCommit}^{tree}`)),
			).rejects.toThrow(/source_ref is not a materialized commit/);
			expect(harness.getState().goal.backgroundLanes ?? []).toHaveLength(0);
		} finally {
			await invalidRefRepo.cleanup();
		}

		const dirtyRepo = await createGitRepo();
		try {
			const harness = createHarness(dirtyRepo.root, dirtyRepo.sessions);
			await Bun.write(path.join(dirtyRepo.root, "dirty.txt"), "dirty\n");
			await expect(harness.manager.spawn(createSpawnRequest("HEAD"))).rejects.toThrow(/clean working tree/);
			expect(harness.getState().goal.backgroundLanes ?? []).toHaveLength(0);
		} finally {
			await dirtyRepo.cleanup();
		}

		const checkpointRepo = await createGitRepo();
		try {
			const rejected = createCheckpoint();
			rejected.id = "rejected-checkpoint";
			rejected.review = {
				status: "rejected",
				feedback: "Rejected.",
				evidenceChecked: [],
				blockers: [
					{
						id: "gap-1",
						severity: "blocking",
						problem: "Missing evidence.",
						requiredEvidenceOrFix: "Add evidence.",
					},
				],
				reviewedAt: 4,
			};
			const harness = createHarness(
				checkpointRepo.root,
				checkpointRepo.sessions,
				new RecordingChildLauncher(),
				createState(createGoal({ checkpoints: [rejected], targets: [rejected.targetSnapshot] })),
			);
			await expect(harness.manager.spawn(createSpawnRequest("HEAD", "rejected-checkpoint"))).rejects.toThrow(
				/checkpoint_id is not an accepted checkpoint/,
			);
			await expect(harness.manager.spawn(createSpawnRequest("HEAD", "missing-checkpoint"))).rejects.toThrow(
				/checkpoint_id is not an accepted checkpoint/,
			);
			expect(harness.getState().goal.backgroundLanes ?? []).toHaveLength(0);
		} finally {
			await checkpointRepo.cleanup();
		}
	});

	it("routes durable follow-up messages through the lane session", async () => {
		const repo = await createGitRepo();
		try {
			const harness = createHarness(repo.root, repo.sessions);
			const spawn = await harness.manager.spawn(createSpawnRequest("HEAD"));
			await harness.runtime.recordBackgroundLaneAgent(spawn.lane.id, { status: "stopped" });
			const result = await harness.manager.message({
				laneId: spawn.lane.id,
				message: "Please inspect the new edge case.",
			});
			expect(result.operationId).toBe("child-op-2");
			expect(result.lane.agent.sessionRef).toBe(spawn.lane.agent.sessionRef);
			expect(result.lane.agent.sessionFile).toBe(spawn.lane.agent.sessionFile);
			expect(result.lane.agent.status).toBe("running");
			expect(harness.launcher.messages).toHaveLength(1);
			expect(harness.launcher.messages[0]?.lane.branch.worktreePath).toBe(spawn.lane.branch.worktreePath);
			expect(harness.launcher.messages[0]?.lane.agent.sessionFile).toBe(spawn.lane.agent.sessionFile);

			await harness.sessionManager.flush();
			const reopened = await SessionManager.open(harness.sessionManager.getSessionFile() ?? "", repo.sessions);
			const messageEntry = reopened
				.getEntries()
				.find(
					entry => entry.type === "custom_message" && entry.customType === BACKGROUND_LANE_UPDATED_MESSAGE_TYPE,
				);
			expect(messageEntry).toBeDefined();
		} finally {
			await repo.cleanup();
		}
	});

	it("persists structured lane reports and interrupts only from blocks_if_fired", async () => {
		const repo = await createGitRepo();
		try {
			const harness = createHarness(repo.root, repo.sessions);
			const spawn = await harness.manager.spawn(createSpawnRequest("HEAD"));
			const laneId = spawn.lane.id;

			await expect(
				harness.manager.report({ laneId: "missing-lane", summary: "No lane.", blocksIfFired: false }),
			).rejects.toThrow(/unknown background lane/);

			const nonBlocking = await harness.manager.report({
				laneId,
				summary: "No blocker found.",
				blocksIfFired: false,
				changedFiles: ["README.md"],
				evidenceRefs: ["artifact://evidence-1"],
				nonClaims: ["This does not complete the parent."],
				staleIf: ["Source changes."],
			});
			expect(nonBlocking.artifactRef).toStartWith("artifact://");
			expect(nonBlocking.sessionMessageRef).toBeString();
			expect(harness.getState().runMode).toBe("working-target");
			expect(harness.getState().goal.backgroundLanes?.[0]).toMatchObject({
				status: "open",
				latestReportRef: nonBlocking.artifactRef,
				changedFiles: ["README.md"],
				evidenceRefs: ["artifact://evidence-1"],
			});

			harness.sessionManager.appendCustomMessageEntry(
				"task-result",
				"Child prose says blocks_if fired, but it is not a lane_report.",
				true,
				{ laneId },
				"agent",
			);
			expect(harness.getState().runMode).toBe("working-target");
			expect(harness.getState().goal.backgroundLanes?.[0]?.blocksIfFired).toBe(false);

			const blocking = await harness.manager.report({
				laneId,
				summary: "The checkpoint claim is stale.",
				blocksIfFired: true,
				evidenceRefs: ["artifact://evidence-2"],
				nonClaims: ["This is candidate evidence only."],
			});
			expect(blocking.sessionMessageRef).toBeString();
			expect(harness.getState().runMode).toBe("awaiting-background-lane-intake");
			expect(harness.getState().goal.backgroundLanes?.[0]).toMatchObject({
				status: "blocked",
				blocksIfFired: true,
				latestReportRef: blocking.artifactRef,
			});
			await expect(
				harness.runtime.startTarget({
					title: "Ordinary continuation",
					desiredFutureClaim: "Continuation proceeds.",
					closureStandard: "No blocker exists.",
				}),
			).rejects.toThrow(/background lane intake/);

			await harness.sessionManager.flush();
			const reopened = await SessionManager.open(harness.sessionManager.getSessionFile() ?? "", repo.sessions);
			const restored = latestGoalModeState(reopened);
			expect(restored?.runMode).toBe("awaiting-background-lane-intake");
			expect(restored?.goal.backgroundLanes?.[0]?.reports).toHaveLength(2);
			const reportMessages = reopened
				.getEntries()
				.filter(
					entry => entry.type === "custom_message" && entry.customType === BACKGROUND_LANE_REPORT_MESSAGE_TYPE,
				);
			expect(reportMessages).toHaveLength(2);
		} finally {
			await repo.cleanup();
		}
	});

	it("guards parent completion until required lanes are explicitly dispositioned", async () => {
		const repo = await createGitRepo();
		try {
			const harness = createHarness(repo.root, repo.sessions);
			const spawn = await harness.manager.spawn(createSpawnRequest("HEAD"));
			await expect(harness.runtime.completeGoalFromTool()).rejects.toThrow(/required background lanes/);
			await expect(
				harness.manager.close({ laneId: spawn.lane.id, outcome: "merged", reason: "Merged elsewhere." }),
			).rejects.toThrow(/merged_source_ref or operator_statement/);

			const closed = await harness.manager.close({
				laneId: spawn.lane.id,
				outcome: "deferred",
				reason: "Operator accepted deferral outside the lane primitive.",
			});
			expect(closed.lane).toMatchObject({
				status: "closed",
				outcome: "deferred",
				closeDisposition: { reason: "Operator accepted deferral outside the lane primitive." },
			});
			expect(harness.getState().goal.status).toBe("active");
			const completed = await harness.runtime.completeGoalFromTool();
			expect(completed.status).toBe("complete");

			await harness.sessionManager.flush();
			const reopened = await SessionManager.open(harness.sessionManager.getSessionFile() ?? "", repo.sessions);
			const restoredLane = latestGoalModeState(reopened)?.goal.backgroundLanes?.[0];
			expect(restoredLane?.closeDisposition?.outcome).toBe("deferred");
			expect(restoredLane?.closeDisposition?.reason).toBe("Operator accepted deferral outside the lane primitive.");
			const closeMessage = reopened
				.getEntries()
				.find(entry => entry.type === "custom_message" && entry.customType === BACKGROUND_LANE_CLOSED_MESSAGE_TYPE);
			expect(closeMessage).toBeDefined();
		} finally {
			await repo.cleanup();
		}
	});

	it("keeps task fan-in separate from durable lane obligations", async () => {
		const repo = await createGitRepo();
		try {
			const harness = createHarness(repo.root, repo.sessions);
			harness.sessionManager.appendCustomMessageEntry(
				"task-result",
				"A task returned a patch and says the parent is done.",
				true,
				{ taskId: "task-1", outcome: "applied" },
				"agent",
			);
			expect(harness.getState().goal.backgroundLanes ?? []).toHaveLength(0);

			const spawn = await harness.manager.spawn(createSpawnRequest("HEAD"));
			harness.sessionManager.appendCustomMessageEntry(
				"task-result",
				"A task claims it closed the background lane.",
				true,
				{ taskId: "task-2", laneId: spawn.lane.id, outcome: "closed" },
				"agent",
			);
			expect(harness.getState().goal.backgroundLanes?.[0]?.status).toBe("open");
			await expect(harness.runtime.completeGoalFromTool()).rejects.toThrow(/required background lanes/);
		} finally {
			await repo.cleanup();
		}
	});
});
