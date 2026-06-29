import { describe, expect, it } from "bun:test";
import {
	buildGoalContextSurface,
	buildGoalContinuationPacket,
	buildGoalTargetPlanExecutionGuardrails,
	buildGoalTargetPlanExecutionSummary,
	type GoalPersistenceReason,
	GoalRuntime,
	type GoalRuntimeHost,
	type GoalStartTargetInput,
	type GoalTargetPlanApprovalInput,
	type GoalUsagePersistenceEvent,
	goalTokenDelta,
	renderGoalPrompt,
	renderGoalPromptSurface,
	renderGoalStateSnapshot,
	renderTrustedObjective,
	targetPlanPayloadFilePath,
} from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type {
	Goal,
	GoalModeState,
	GoalParentFrame,
	GoalRuntimeEvent,
	GoalTargetPlanReview,
	GoalTokenUsage,
} from "@oh-my-pi/pi-coding-agent/goals/state";
import { cloneGoalModeState, parseGoalModeState, serializeGoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { buildGoalCompactionContext } from "../../src/goals/compaction-continuation";
import systemPromptTemplate from "../../src/prompts/system/system-prompt.md" with { type: "text" };

function createUsage(overrides: Partial<GoalTokenUsage> = {}): GoalTokenUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		...overrides,
	};
}

function createGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Ship <fast> & safely",
		status: "active",
		tokenBudget: undefined,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

type TestGoalModeStateInput = Partial<Omit<GoalModeState, "goal">> & { goal: Goal };

function createGoalModeState(input: TestGoalModeStateInput): GoalModeState {
	return {
		enabled: true,
		mode: "active",
		runMode: "working-target",
		stateVersion: 0,
		parentFrameVersion: input.goal.parentFrame ? 1 : 0,
		...input,
		goal: input.goal,
	};
}

function createParentFrame(overrides: Partial<GoalParentFrame> = {}): GoalParentFrame {
	return {
		kind: "plain",
		desiredFuture: "Desired future",
		baselineRefs: [],
		acceptedClaims: [],
		candidateClaims: [],
		rejectedOrStaleClaims: [],
		boundaries: [],
		residuals: [],
		gates: [],
		frontier: [],
		staleIf: [],
		externalRefs: [],
		...overrides,
	};
}

function cloneGoal(goal: Goal): Goal {
	return {
		...goal,
		verificationAttempts: goal.verificationAttempts?.map(attempt => ({
			...attempt,
			structuredFeedback: attempt.structuredFeedback
				? {
						...attempt.structuredFeedback,
						deliverableResults: attempt.structuredFeedback.deliverableResults.map(result => ({
							...result,
							evidence: result.evidence?.map(item => ({ ...item })),
						})),
						evidenceChecked: attempt.structuredFeedback.evidenceChecked.map(item => ({ ...item })),
						completionBlockers: attempt.structuredFeedback.completionBlockers.map(item => ({ ...item })),
					}
				: undefined,
		})),
	};
}

function cloneState(state: GoalModeState | undefined): GoalModeState | undefined {
	return state ? cloneGoalModeState(state) : undefined;
}

function cloneEvent(event: GoalRuntimeEvent): GoalRuntimeEvent {
	if (event.type === "goal_updated") {
		return {
			...event,
			goal: event.goal ? cloneGoal(event.goal) : null,
			state: cloneState(event.state),
		};
	}
	return { ...event };
}

function createHarness(initial: { state?: TestGoalModeStateInput; usage?: GoalTokenUsage; now?: number } = {}) {
	let state = initial.state ? cloneState(createGoalModeState(initial.state)) : undefined;
	let usage = createUsage(initial.usage);
	let now = initial.now ?? 0;
	const events: GoalRuntimeEvent[] = [];
	const persists: Array<{
		mode: "goal" | "goal_paused" | "none";
		state?: GoalModeState;
		reason?: GoalPersistenceReason;
	}> = [];
	const usagePersists: GoalUsagePersistenceEvent[] = [];
	const hiddenMessages: Array<{ customType: string; content: string; deliverAs?: "steer" | "followUp" | "nextTurn" }> =
		[];
	const host: GoalRuntimeHost = {
		getState: () => cloneState(state),
		setState: next => {
			state = cloneState(next);
		},
		getCurrentUsage: () => createUsage(usage),
		emit: async event => {
			events.push(cloneEvent(event));
		},
		persist: (mode, persistedState, reason) => {
			persists.push({ mode, state: cloneState(persistedState), reason });
		},
		persistUsage: event => {
			usagePersists.push({ ...event });
		},
		sendHiddenMessage: async message => {
			hiddenMessages.push({ ...message });
		},
		now: () => now,
	};
	return {
		runtime: new GoalRuntime(host),
		getState: () => cloneState(state),
		setState: (next: GoalModeState | undefined) => {
			state = cloneState(next);
		},
		setUsage: (next: Partial<GoalTokenUsage>) => {
			usage = createUsage(next);
		},
		advance: (ms: number) => {
			now += ms;
		},
		events,
		persists,
		usagePersists,
		hiddenMessages,
	};
}

function acceptedTargetPlanReview(
	lens: GoalTargetPlanReview["lens"],
	overrides: Partial<GoalTargetPlanReview> = {},
): GoalTargetPlanReview {
	return {
		id: `review-${lens}`,
		lens,
		status: "accepted",
		feedback: `${lens} accepted the target plan.`,
		apertureClassification: lens === "aperture" ? "right-sized" : undefined,
		revisionDecision: lens === "aperture" ? "keep" : undefined,
		scores:
			lens === "aperture"
				? {
						productSignal: 4,
						relatedWorkBundling: 4,
						concernCohesion: 4,
						verificationAperture: 4,
						blastRadiusCoverage: 4,
						parentUncertaintyReduction: 4,
						antiGaming: 4,
					}
				: undefined,
		findings: [],
		reviewedAt: 1,
		reviewedTargetPlanId: "target-plan-id",
		reviewedRevision: 1,
		source: {
			kind: "subagent",
			reviewerId: `${lens}-reviewer`,
			artifactUri: `agent://${lens}-reviewer`,
			validationUri: `agent://${lens}-reviewer/validation`,
		},
		revisedAfterReview: false,
		...overrides,
	};
}

function rejectedTargetPlanReview(
	lens: GoalTargetPlanReview["lens"],
	overrides: Partial<GoalTargetPlanReview> = {},
): GoalTargetPlanReview {
	return {
		...acceptedTargetPlanReview(lens),
		status: "rejected",
		feedback: `${lens} rejected the target plan.`,
		findings: [
			{
				id: "RIGHT_SIZE_BLOCKER",
				severity: "blocking",
				problem: "Target plan is not right-sized.",
				requiredRevision: "Revise the target aperture.",
			},
		],
		...overrides,
	};
}

function buildTargetPlanApprovalInput(state: GoalModeState): GoalTargetPlanApprovalInput {
	const target = state.goal.currentTarget;
	const plan = state.goal.currentTargetPlan;
	if (!target || !plan) throw new Error("expected current target plan");
	const primarySignalId = `signal-${target.id}`;
	return {
		targetId: target.id,
		targetPlanId: plan.id,
		planFilePath: plan.planFilePath,
		revision: plan.revision,
		primarySignalGroupId: primarySignalId,
		planDepth: "light",
		targetCard: {
			capabilityClaim: "Target behavior is directly verified.",
			knownLimits: ["Parent completion remains outside this target."],
			userVisibleSurface: "Target behavior",
			acceptanceRows: { closed: ["happy path"], open: [] },
			verificationScenarios: [`happy path ${primarySignalId}`],
			checkpointEvidence: ["Focused check passes."],
		},
		verificationAperture: {
			productIntention: "Prove the target behavior with direct evidence.",
			primarySignalId,
			blastRadius: "local",
			blastRadiusScope: "Single target behavior surface.",
			confidenceTarget: "high",
			confidenceRationale: "High only for the focused target behavior.",
			layerRationale: "The target is local and directly observable.",
			residualUncertainty: ["Parent completion remains outside this target."],
			omittedLayers: [{ layer: "e2e", reason: "Parent-level e2e belongs to a later target." }],
		},
		verificationSignals: [
			{
				id: primarySignalId,
				role: "primary",
				layer: "integration",
				concernIds: ["concern-behavior"],
				claim: "Target behavior is verified.",
				observation: "Focused evidence is observed.",
				method: "Run the focused check.",
				expectedOutcome: "The focused check passes.",
				required: true,
				confidenceIfSatisfied: "high",
				confidenceRationale: "Focused verification earns target confidence only.",
				staleIf: ["Relevant code changes."],
			},
		],
		concernChecks: [
			{
				id: "concern-behavior",
				kind: "behavior",
				lens: "focused behavior",
				whyIndependent: "Behavior can fail independently of parent completion.",
				coveredBySignalIds: [primarySignalId],
			},
		],
		scopeCalibration: {
			rightSizingBasis: "product-signal",
			rightSizingRationale: "One product signal closes without claiming parent completion.",
			whyNotSmaller: ["Smaller work would not produce an observable signal."],
			whyNotLarger: ["Larger work would claim parent-level completion."],
			includedRelatedWork: [
				{ item: "Focused target work", reason: "Needed for primary signal.", signalIds: [primarySignalId] },
			],
			deferredRelatedWork: [
				{
					item: "Parent completion verification",
					reason: "different-primary-signal",
					followUpHint: "Checkpoint first.",
					rationale: "Parent verification needs broader evidence.",
				},
			],
		},
		branchEvidence: [
			{ branch: "happy path", required: true, plannedSignalIds: [primarySignalId], rationale: "Primary signal." },
		],
		excludedWorkReview: [
			{ item: "Parent completion", classification: "parent-non-claim", rationale: "Checkpoint is bounded." },
		],
		targetPlanReviews: [
			acceptedTargetPlanReview("aperture", { reviewedTargetPlanId: plan.id, reviewedRevision: plan.revision }),
			acceptedTargetPlanReview("execution-readiness", {
				reviewedTargetPlanId: plan.id,
				reviewedRevision: plan.revision,
			}),
		],
		dryRun: { status: "passed", checks: [{ id: "dry-run", passed: true, rationale: "Plan steps are executable." }] },
		reviews: [
			acceptedTargetPlanReview("aperture", { reviewedTargetPlanId: plan.id, reviewedRevision: plan.revision }),
			acceptedTargetPlanReview("execution-readiness", {
				reviewedTargetPlanId: plan.id,
				reviewedRevision: plan.revision,
			}),
		],
	};
}

async function approveTargetPlan(harness: { runtime: GoalRuntime }, state: GoalModeState): Promise<GoalModeState> {
	return await harness.runtime.approveCurrentTargetPlan(buildTargetPlanApprovalInput(state));
}

async function startApprovedTarget(
	harness: { runtime: GoalRuntime },
	input: GoalStartTargetInput,
): Promise<GoalModeState> {
	const planningState = await harness.runtime.startTarget(input);
	return await approveTargetPlan(harness, planningState);
}

function buildParallelWorkstreamApprovalInput(state: GoalModeState): GoalTargetPlanApprovalInput {
	const input = buildTargetPlanApprovalInput(state);
	const targetCard = input.targetCard;
	if (!targetCard) throw new Error("expected target card");
	return {
		...input,
		targetCard: {
			...targetCard,
			sharedContract: "Backend and UI agree on the saved preference shape.",
			workstreams: [
				{
					id: "backend-api",
					label: "Backend API",
					kind: "main",
					role: "Backend contract specialist",
					files: ["src/api.ts"],
					contractInputs: ["Existing preference request"],
					contractOutputs: ["Saved preference response"],
				},
				{
					id: "ui-state",
					label: "UI state",
					kind: "app-ui",
					role: "UI state specialist",
					files: ["src/ui.ts"],
					contractInputs: ["Saved preference response"],
					contractOutputs: ["Rendered preference state"],
				},
			],
		},
		scopeCalibration: {
			...input.scopeCalibration,
			targetUnitRuleIds: ["parallel-workstreams-required"],
		},
	};
}

describe("goal runtime", () => {
	it("counts cache writes but ignores cache reads in token deltas", () => {
		expect(
			goalTokenDelta(
				createUsage({ input: 13, output: 6, cacheRead: 999, cacheWrite: 8 }),
				createUsage({ input: 10, output: 4, cacheRead: 1, cacheWrite: 5 }),
			),
		).toBe(8);
	});

	it("persists approved parallel workstream batches through summaries and compaction context", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});
		const planning = await harness.runtime.startTarget({
			title: "Save preference",
			desiredFutureClaim: "Preference changes are saved.",
			closureStandard: "Backend and UI preference paths both satisfy the focused check.",
			evidenceExpectation: ["Focused preference check passes."],
			nonGoals: ["Parent completion"],
			forbiddenClaims: ["Parent goal complete"],
			staleIf: ["Preference schema changes."],
			parallelWorkstreamRequirement: {
				required: true,
				source: "operator",
				rationale: "Backend and UI can progress independently but share a response contract.",
			},
		});

		const approved = await harness.runtime.approveCurrentTargetPlan(buildParallelWorkstreamApprovalInput(planning));
		const batch = approved.goal.currentWorkstreamBatch;
		expect(batch?.status).toBe("pending-launch");
		expect(approved.goal.currentTarget?.workstreamBatchId).toBe(batch?.id);
		expect(batch?.workstreams.map(run => run.scaffoldTaskId)).toEqual(["backend-api", "ui-state"]);
		const summary = buildGoalTargetPlanExecutionSummary(
			approved.goal.currentTargetPlan,
			approved.goal.currentTarget,
			batch,
		);
		expect(summary?.taskBatchScaffold?.batchId).toBe(batch?.id);
		expect(summary?.taskBatchScaffold?.tasks.map(task => task.id)).toEqual(["backend-api", "ui-state"]);

		const restored = parseGoalModeState(serializeGoalModeState(approved), true);
		expect(restored?.goal.currentWorkstreamBatch?.id).toBe(batch?.id);
		expect(restored?.goal.currentWorkstreamBatch?.workstreams.map(run => run.workstreamId)).toEqual([
			"backend-api",
			"ui-state",
		]);
		const surface = JSON.parse(renderGoalPromptSurface(approved, approved.goal));
		expect(surface.workstream_batch).toMatchObject({
			id: batch?.id,
			status: "pending-launch",
		});
		const compactionContext = buildGoalCompactionContext(approved);
		expect(compactionContext?.context).toContain('"workstream_batch"');
		expect(compactionContext?.context).toContain(batch?.id ?? "");
	});

	it("records workstream task lifecycle and closes the batch with the target checkpoint", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});
		const planning = await harness.runtime.startTarget({
			title: "Save preference",
			desiredFutureClaim: "Preference changes are saved.",
			closureStandard: "Backend and UI preference paths both satisfy the focused check.",
			evidenceExpectation: ["Focused preference check passes."],
			nonGoals: ["Parent completion"],
			forbiddenClaims: ["Parent goal complete"],
			staleIf: ["Preference schema changes."],
			parallelWorkstreamRequirement: {
				required: true,
				source: "operator",
				rationale: "Backend and UI can progress independently but share a response contract.",
			},
		});
		const approved = await harness.runtime.approveCurrentTargetPlan(buildParallelWorkstreamApprovalInput(planning));
		const initialBatchId = approved.goal.currentWorkstreamBatch?.id;
		const spawns = [
			{ taskId: "backend-api", agentId: "BackendAgent", jobId: "job-backend" },
			{ taskId: "ui-state", agentId: "UiAgent", jobId: "job-ui" },
		];
		const taskParams = {
			agent: "task",
			context: "Shared preference contract",
			tasks: [
				{ id: "backend-api", assignment: "Implement backend preference save." },
				{ id: "ui-state", assignment: "Implement UI preference state." },
			],
		};
		await harness.runtime.recordGoalWorkstreamTaskDispatch({
			toolCallId: "task-call-1",
			params: taskParams,
			details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			spawns,
		});
		let batch = harness.getState()?.goal.currentWorkstreamBatch;
		expect(batch?.status).toBe("running");
		expect(batch?.workstreams.map(run => `${run.workstreamId}:${run.status}:${run.agentId}:${run.jobId}`)).toEqual([
			"backend-api:running:BackendAgent:job-backend",
			"ui-state:running:UiAgent:job-ui",
		]);

		await harness.runtime.recordGoalWorkstreamTaskResult({
			toolCallId: "task-call-1",
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
				progress: [
					{
						index: 0,
						id: "BackendAgent",
						agent: "task",
						agentSource: "bundled",
						status: "completed",
						task: "backend",
						recentTools: [],
						recentOutput: [],
						toolCount: 0,
						requests: 0,
						tokens: 0,
						cost: 0,
						durationMs: 1,
					},
					{
						index: 1,
						id: "UiAgent",
						agent: "task",
						agentSource: "bundled",
						status: "completed",
						task: "ui",
						recentTools: [],
						recentOutput: [],
						toolCount: 0,
						requests: 0,
						tokens: 0,
						cost: 0,
						durationMs: 1,
					},
				],
			},
			spawns,
		});
		batch = harness.getState()?.goal.currentWorkstreamBatch;
		expect(batch?.status).toBe("ready-for-integration");
		expect(
			batch?.workstreams.map(run => `${run.workstreamId}:${run.status}:${run.historyUrl}:${run.outputUrl}`),
		).toEqual([
			"backend-api:completed:history://BackendAgent:agent://BackendAgent",
			"ui-state:completed:history://UiAgent:agent://UiAgent",
		]);

		const candidate = harness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Preference save target is closed.",
			localClaims: ["Preference changes are saved."],
			evidence: [{ claim: "Focused preference check passes.", evidence: "bun test preference", current: true }],
			notClaimed: ["Parent goal complete"],
			remainingQuestions: ["Parent completion remains open."],
		});
		const committed = await harness.runtime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Target closed.",
			evidenceChecked: [],
			blockers: [],
			reviewedAt: 10,
		});
		expect(committed.goal.currentWorkstreamBatch?.id).toBe(initialBatchId);
		expect(committed.goal.currentWorkstreamBatch?.status).toBe("closed");
		expect(committed.goal.currentWorkstreamBatch?.workstreams.map(run => run.status)).toEqual([
			"accepted",
			"accepted",
		]);
	});

	it("omits compaction goal preserve data when goal mode is disabled", () => {
		const context = buildGoalCompactionContext(
			createGoalModeState({
				enabled: false,
				goal: createGoal(),
			}),
		);

		expect(context).toBeUndefined();
	});

	it("clamps token deltas at zero across usage resets", () => {
		expect(
			goalTokenDelta(
				createUsage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 2 }),
				createUsage({ input: 100, output: 50, cacheRead: 500, cacheWrite: 20 }),
			),
		).toBe(0);
	});

	it("advances wall-clock accounting only by persisted whole seconds", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(2_500);
		harness.setUsage(createUsage({ input: 1 }));
		await harness.runtime.flushUsage("suppressed");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(2_000);
		expect(harness.persists).toHaveLength(0);
		expect(harness.usagePersists).toHaveLength(1);
		expect(harness.usagePersists[0]).toMatchObject({
			goalId: "goal-1",
			tokenDelta: 1,
			wallSeconds: 2,
			tokensUsed: 1,
			timeUsedSeconds: 2,
		});

		harness.advance(400);
		await harness.runtime.flushUsage("suppressed");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(2_000);
		expect(harness.persists).toHaveLength(0);
		expect(harness.usagePersists).toHaveLength(1);

		harness.advance(700);
		harness.setUsage(createUsage({ input: 2 }));
		await harness.runtime.flushUsage("suppressed");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(3);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(3_000);
		expect(harness.persists).toHaveLength(0);
		expect(harness.usagePersists).toHaveLength(2);
		expect(harness.usagePersists[1]).toMatchObject({
			tokenDelta: 1,
			wallSeconds: 1,
			tokensUsed: 2,
			timeUsedSeconds: 3,
		});
	});

	it("does not persist snapshots on wall-clock-only flushes", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		expect(harness.usagePersists).toHaveLength(0);
		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(2_500);
		// Flush wall-clock time without any token usage changes.
		await harness.runtime.flushUsage("suppressed");
		// The in-memory state should still be updated.
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		// But it should not write/persist to the session log.
		expect(harness.persists).toHaveLength(0);
		expect(harness.usagePersists).toHaveLength(0);
	});

	it("persists wall-clock-only usage before internal compaction or session-switch aborts", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(2_500);
		await harness.runtime.onTaskAborted({ reason: "internal" });

		expect(harness.getState()?.enabled).toBe(true);
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		expect(harness.persists).toHaveLength(1);
		expect(harness.persists[0]).toMatchObject({
			mode: "goal",
			state: { goal: { timeUsedSeconds: 2 } },
		});
	});

	it("resets wall-clock baseline when preserving an active goal after a no-goal switch", async () => {
		const goal = createGoal();
		const harness = createHarness({
			state: createGoalModeState({ goal }),
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.setState(undefined);
		harness.advance(10_000);
		harness.setState(createGoalModeState({ goal }));

		const resumed = await harness.runtime.onThreadResumed({ preserveActiveGoal: true });
		harness.advance(1_000);
		await harness.runtime.flushUsage("suppressed");

		expect(resumed?.goal.status).toBe("active");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(1);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(11_000);
	});

	it("clears stale accounting when reconciling to a no-goal session", async () => {
		const goal = createGoal();
		const harness = createHarness({
			state: createGoalModeState({ goal }),
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.setState(undefined);
		harness.runtime.clearAccounting();
		harness.advance(10_000);
		harness.setState(createGoalModeState({ goal }));

		await harness.runtime.onThreadResumed({ preserveActiveGoal: true });
		harness.advance(1_000);
		await harness.runtime.flushUsage("suppressed");

		expect(harness.getState()?.goal.timeUsedSeconds).toBe(1);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(11_000);
	});

	it("steers only once until a budget mutation resets the cycle", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ tokenBudget: 10, tokensUsed: 8 }),
			},
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.setUsage({ input: 2 });
		await harness.runtime.flushUsage("allowed");
		expect(harness.getState()?.goal.status).toBe("budget-limited");
		expect(harness.persists.at(-1)).toMatchObject({ mode: "goal", reason: "budget-limited" });
		expect(harness.usagePersists).toHaveLength(0);
		expect(harness.hiddenMessages).toHaveLength(1);
		expect(harness.hiddenMessages[0]).toMatchObject({
			customType: "goal-budget-limit",
			deliverAs: "steer",
		});

		harness.setUsage({ input: 5 });
		await harness.runtime.flushUsage("allowed");
		expect(harness.hiddenMessages).toHaveLength(1);

		await harness.runtime.onBudgetMutated(20);
		expect(harness.getState()?.enabled).toBe(true);
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.getState()?.goal.tokenBudget).toBe(20);
		expect(harness.hiddenMessages).toHaveLength(1);

		harness.setUsage({ input: 15 });
		await harness.runtime.flushUsage("allowed");
		expect(harness.getState()?.goal.status).toBe("budget-limited");
		expect(harness.persists.at(-1)).toMatchObject({ mode: "goal", reason: "budget-limited" });
		expect(harness.hiddenMessages).toHaveLength(2);
	});

	it("pauses an active goal when an interruption aborts the task", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(1_000);
		harness.setUsage({ output: 4 });
		await harness.runtime.onTaskAborted({ reason: "interrupted" });

		const state = harness.getState();
		expect(state?.enabled).toBe(false);
		expect(state?.goal.status).toBe("paused");
		expect(state?.goal.tokensUsed).toBe(4);
		expect(state?.goal.timeUsedSeconds).toBe(1);
		expect(harness.persists.at(-1)?.mode).toBe("goal_paused");
	});

	it("does not pause active goals when an internal abort stops the task", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(1_000);
		harness.setUsage({ output: 4 });
		await harness.runtime.onTaskAborted({ reason: "internal" });

		const state = harness.getState();
		expect(state?.enabled).toBe(true);
		expect(state?.goal.status).toBe("active");
		expect(state?.goal.tokensUsed).toBe(4);
		expect(state?.goal.timeUsedSeconds).toBe(1);
		expect(harness.persists.at(-1)?.mode).not.toBe("goal_paused");
	});

	it("auto-pauses active goals when a thread resumes", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		const resumed = await harness.runtime.onThreadResumed();
		expect(resumed?.enabled).toBe(false);
		expect(resumed?.goal.status).toBe("paused");
		expect(harness.getState()?.enabled).toBe(false);
		expect(harness.getState()?.goal.status).toBe("paused");
		expect(harness.persists.at(-1)?.mode).toBe("goal_paused");
	});

	it("preserves an active goal during internal session-switch reconciliation", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		const resumed = await harness.runtime.onThreadResumed({ preserveActiveGoal: true });

		expect(resumed?.enabled).toBe(true);
		expect(resumed?.goal.status).toBe("active");
		expect(harness.getState()?.enabled).toBe(true);
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.persists).toHaveLength(0);
	});

	it("escapes XML in goal helpers and rendered prompts", () => {
		const objective = "Fix <root>&keep>safe";
		const goal = createGoal({ objective });
		const prompt = renderGoalPrompt("active", goal);

		expect(renderTrustedObjective(objective)).toBe("<objective>\nFix &lt;root&gt;&amp;keep&gt;safe\n</objective>");
		expect(prompt).toContain("Fix &lt;root&gt;&amp;keep&gt;safe");
		expect(prompt).not.toContain(objective);
	});

	it("returns the input verbatim when escapeXmlText has nothing to escape", () => {
		const input = "plain text — with 'quotes' and \"double\" plus unicode ✓";
		expect(escapeXmlText(input)).toBe(input);
		// fast-path identity: the helper should not allocate a new string when nothing changed
		expect(escapeXmlText(input)).toBe(escapeXmlText(input));
	});

	it("escapeXmlText escapes only the XML-significant trio and leaves other characters untouched", () => {
		expect(escapeXmlText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
		expect(escapeXmlText("'\"`")).toBe("'\"`");
	});

	it("onBudgetMutated downward to below current usage flips active to budget-limited and steers", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ tokenBudget: 100, tokensUsed: 30, status: "active" }),
			},
		});

		const next = await harness.runtime.onBudgetMutated(20);

		expect(next?.goal.status).toBe("budget-limited");
		expect(next?.goal.tokenBudget).toBe(20);
		expect(next?.goal.tokensUsed).toBe(30);
		expect(harness.hiddenMessages).toHaveLength(1);
		expect(harness.hiddenMessages[0]?.customType).toBe("goal-budget-limit");
	});

	it("completeGoalFromTool clears enabled and flips status to complete with mode exiting (fix #1)", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ tokenBudget: 100, tokensUsed: 42, timeUsedSeconds: 7 }),
			},
		});

		const completed = await harness.runtime.completeGoalFromTool();

		expect(completed.status).toBe("complete");
		const state = harness.getState();
		expect(state?.enabled).toBe(false);
		expect(state?.mode).toBe("exiting");
		expect(state?.reason).toBe("completed");
		expect(state?.goal.status).toBe("complete");
	});

	it("dropGoal emits goal_updated with the dropped goal and clears persisted state", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ id: "g-99", objective: "Ship soon" }),
			},
		});

		const dropped = await harness.runtime.dropGoal();

		expect(dropped?.status).toBe("dropped");
		expect(dropped?.id).toBe("g-99");
		expect(harness.getState()).toBeUndefined();
		const lastEvent = harness.events.at(-1);
		if (lastEvent?.type !== "goal_updated") {
			throw new Error("expected goal_updated event after dropGoal");
		}
		expect(lastEvent.goal?.status).toBe("dropped");
		expect(lastEvent.state?.enabled).toBe(false);
		expect(harness.persists.map(entry => entry.mode)).toEqual(["goal", "none"]);
		expect(harness.persists[0]?.state?.goal.status).toBe("dropped");
		expect(harness.persists[0]?.state?.enabled).toBe(false);
		expect(harness.persists[1]?.state).toBeUndefined();
	});

	it("rejects dropGoal while active target work is pending", async () => {
		const error =
			"cannot drop goal while active goal work is pending; fail the target plan, resolve the checkpoint, or complete/repair parent verification first";
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		await harness.runtime.startTarget({
			title: "Prove installer smoke",
			desiredFutureClaim: "Installer smoke exercises worker startup.",
			closureStandard: "Focused smoke evidence exists.",
		});

		await expect(harness.runtime.dropGoal()).rejects.toThrow(error);
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.persists.map(entry => entry.mode)).toEqual(["goal", "goal"]);
	});

	it("rejects op=create on the runtime when a non-dropped goal already exists", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ objective: "Existing" }),
			},
		});

		await expect(harness.runtime.createGoal({ objective: "Second" })).rejects.toThrow(
			"cannot create a new goal because this session already has a goal",
		);
	});

	it("replaces an active goal with a fresh active goal", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ objective: "Existing", tokenBudget: 100 }),
			},
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(1_000);
		harness.setUsage({ input: 12 });

		const next = await harness.runtime.replaceGoal({ objective: "Second", tokenBudget: 25 });

		expect(next.enabled).toBe(true);
		expect(next.goal.objective).toBe("Second");
		expect(next.goal.status).toBe("active");
		expect(next.goal.tokenBudget).toBe(25);
		expect(next.goal.tokensUsed).toBe(0);
		expect(next.goal.timeUsedSeconds).toBe(0);
		expect(next.goal.id).not.toBe("goal-1");
		expect(harness.persists.at(-1)?.state?.goal.objective).toBe("Second");
	});

	it("allows creating a new goal after the previous one is complete", async () => {
		const harness = createHarness({
			state: {
				enabled: false,
				mode: "exiting",
				reason: "completed",
				goal: createGoal({ status: "complete" }),
			},
		});

		const next = await harness.runtime.createGoal({ objective: "Phase 4" });
		expect(next.goal.objective).toBe("Phase 4");
		expect(next.goal.status).toBe("active");
		expect(next.enabled).toBe(true);
	});

	it("completeGoalFromTool succeeds for a paused goal (enabled=false)", async () => {
		const harness = createHarness({
			state: {
				enabled: false,
				mode: "active",
				goal: createGoal({ status: "paused", tokensUsed: 30, timeUsedSeconds: 5 }),
			},
		});

		const completed = await harness.runtime.completeGoalFromTool();
		expect(completed.status).toBe("complete");
		const state = harness.getState();
		expect(state?.enabled).toBe(false);
		expect(state?.mode).toBe("exiting");
		expect(state?.goal.status).toBe("complete");
		expect(state?.runMode).toBe("completed");
	});

	it("keeps rubric private while rendering verifier feedback in goal prompts", async () => {
		const harness = createHarness();

		const state = await harness.runtime.createGoal({ objective: "Ship <safe> & audited" });
		const rubricState = await harness.runtime.setGoalRubric(state.goal.id, "4 = excellent <evidence> & coherent", [
			{ id: "D1", summary: "Audited safe release.", status: "pending" },
		]);
		expect(rubricState?.stateVersion).toBe(state.stateVersion + 1);
		await harness.runtime.recordFailedCompletionVerification(state.goal.id, "Missing <integration> & proof");

		const goal = harness.getState()?.goal;
		if (!goal) throw new Error("expected active goal");
		const activePrompt = renderGoalPrompt("active", goal);
		const continuationPrompt = renderGoalPrompt("continuation", goal);

		expect(goal.failedCompletionAttempts).toBe(1);
		expect(activePrompt).not.toContain("4 = excellent &lt;evidence&gt; &amp; coherent");
		expect(continuationPrompt).not.toContain("4 = excellent &lt;evidence&gt; &amp; coherent");
		expect(activePrompt).toContain("Missing &lt;integration&gt; &amp; proof");
		expect(continuationPrompt).toContain("Missing &lt;integration&gt; &amp; proof");
		expect(activePrompt).toContain("Audited safe release.");
		expect(continuationPrompt).toContain('"id": "D1"');
	});

	it("renders compact goal snapshots without duplicating objective or nested checkpoint bodies", async () => {
		const harness = createHarness();
		const objective = "Ship compact goal context";
		const initialState = await harness.runtime.createGoal({
			objective,
			parentFrame: createParentFrame({ desiredFuture: objective }),
		});
		await harness.runtime.setGoalRubric(initialState.goal.id, "Verifier-only rubric", [
			{ id: "D1", summary: "Compact deliverable.", status: "pending", nextRelevantTarget: "Close compact target" },
		]);
		await startApprovedTarget(harness, {
			title: "Close compact target",
			desiredFutureClaim: "Target claim",
			closureStandard: "Evidence and review close the target",
			evidenceExpectation: ["Focused evidence"],
			forbiddenClaims: ["Parent complete"],
			staleIf: ["API changes"],
		});
		const candidate = harness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Target closed",
			localClaims: ["Target claim"],
			evidence: [{ claim: "Target claim", evidence: "focused test", current: true }],
			checksRun: ["bun test focused"],
			artifactsTouched: ["src/example.ts"],
			notClaimed: ["Parent complete"],
			remainingQuestions: ["Next target"],
			risksOrCaveats: ["Bounded claim only"],
			staleIf: ["API changes"],
			suggestedControllerQuestions: [],
		});
		const checkpointState = await harness.runtime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Compact checkpoint review accepted.",
			evidenceChecked: candidate.evidence,
			blockers: [],
			reviewedAt: 10,
		});

		const snapshot = renderGoalStateSnapshot(checkpointState, checkpointState.goal);
		expect(snapshot).toContain("Compact deliverable.");
		expect(snapshot).not.toContain("Verifier-only rubric");
		expect(snapshot).toContain('"desiredFuture": "same_as_objective"');
		expect(snapshot).not.toContain('"objective"');
		expect(snapshot).not.toContain("targetSnapshot");
		expect(snapshot).not.toContain(objective);
		expect(snapshot.length).toBeLessThan(6_000);
	});

	it("surfaces target aperture guidance without the full rubric", () => {
		const goal = createGoal({
			objective: "Ship target-planning guidance",
			rubric: [
				"# Completion rubric",
				"D1: Full rubric deliverable detail should stay out of compact context.",
				"## Target aperture guidance",
				"- First target: make the CLI approval payload directly executable.",
				"- Same-signal work: prompt wording, submit skeleton, and target-plan review contract.",
				"## Verification",
				"FULL RUBRIC DETAIL SHOULD STAY OUT OF TARGET APERTURE GUIDANCE",
			].join("\n"),
		});
		const state = createGoalModeState({ goal, runMode: "planning-target" });

		const surface = buildGoalContextSurface(state, goal);
		expect(surface.target_aperture_guidance?.guidance).toContain("make the CLI approval payload directly executable");

		const surfaceText = renderGoalPromptSurface(state, goal);
		expect(surfaceText).toContain("Same-signal work: prompt wording");
		expect(surfaceText).not.toContain("FULL RUBRIC DETAIL SHOULD STAY OUT");
		expect(surfaceText).not.toContain("Full rubric deliverable detail should stay out");
	});

	it("surfaces failed target-plan recovery instructions in prompts", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Recover a failed target plan" });
		const planning = await harness.runtime.startTarget({
			title: "Prove failed-plan recovery",
			desiredFutureClaim: "Failed target-plan recovery is visible.",
			closureStandard: "Prompt surface names the recovery operation.",
		});
		const target = planning.goal.currentTarget;
		const plan = planning.goal.currentTargetPlan;
		if (!target || !plan) throw new Error("expected planning target");

		const failed = await harness.runtime.failCurrentTargetPlan({
			targetId: target.id,
			targetPlanId: plan.id,
			revision: plan.revision,
			reason: "needs-user-input",
			message: "Operator must choose the quest branch.",
			blockers: ["Missing quest branch decision."],
			suggestedQuestions: ["Which quest branch should be planned?"],
		});

		const block = failed.goal.currentBlockedState;
		if (block?.kind !== "target-plan") throw new Error("expected target-plan blocked state");
		const surface = renderGoalPromptSurface(failed, failed.goal);
		expect(surface).toContain('"requiredOperation": "recover_blocked_state"');
		expect(surface).toContain('"allowedActions": [');
		expect(surface).toContain(block.id);
		expect(surface).toContain(plan.id);
		expect(surface).not.toContain("reopen_" + "target_plan");
		const continuationPrompt = renderGoalPrompt("continuation", failed.goal, failed);
		expect(continuationPrompt).toContain("recover_blocked_state");
		expect(continuationPrompt).toContain("NEVER call");
		expect(continuationPrompt).toContain("resume");
		expect(continuationPrompt).toContain("start_target");
	});

	it("renders checkpoint prompt surface without full audit checkpoint packets", async () => {
		const harness = createHarness();
		const initialState = await harness.runtime.createGoal({
			objective: "Ship compact goal context",
			parentFrame: createParentFrame({ desiredFuture: "Ship compact goal context" }),
		});
		await harness.runtime.setGoalRubric(initialState.goal.id, "Verifier-only rubric", [
			{ id: "D1", summary: "Compact deliverable.", status: "pending", nextRelevantTarget: "Close compact target" },
		]);
		const workingState = await startApprovedTarget(harness, {
			title: "Close compact target",
			desiredFutureClaim: "Target claim",
			closureStandard: "Evidence and review close the target",
			evidenceExpectation: ["Focused evidence"],
			nonGoals: ["Do not claim parent completion"],
			forbiddenClaims: ["Parent complete"],
			staleIf: ["API changes"],
			parentDeliverableIds: ["D1"],
		});
		const workingSurface = renderGoalPromptSurface(workingState, workingState.goal);
		expect(workingSurface).toContain("Evidence and review close the target");
		expect(workingSurface).toContain("Focused evidence");
		expect(workingSurface).toContain("Do not claim parent completion");
		expect(workingSurface).toContain("API changes");

		const candidate = harness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Target closed with bounded truth",
			localClaims: ["Target claim"],
			evidence: [
				{
					claim: "Target claim",
					evidence: "FULL CHECKPOINT EVIDENCE DETAIL SHOULD STAY IN AUDIT STATE",
					current: true,
				},
			],
			checksRun: ["FULL CHECKS LIST SHOULD STAY IN AUDIT STATE"],
			artifactsTouched: ["src/full-audit-only.ts"],
			notClaimed: ["Parent complete"],
			remainingQuestions: ["Next target"],
			risksOrCaveats: ["Bounded claim only"],
			staleIf: ["API changes"],
		});
		const checkpointState = await harness.runtime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Compact checkpoint review accepted.",
			evidenceChecked: candidate.evidence,
			blockers: [],
			reviewedAt: 10,
		});

		const surface = renderGoalPromptSurface(checkpointState, checkpointState.goal);
		expect(surface).toContain('"requiredAction": "resolve_checkpoint"');
		expect(surface).toContain("Target closed with bounded truth");
		expect(surface).toContain("Target claim");
		expect(surface).toContain("Parent complete");
		expect(surface).toContain("Next target");
		expect(surface).not.toContain("FULL CHECKPOINT EVIDENCE DETAIL SHOULD STAY IN AUDIT STATE");
		expect(surface).not.toContain("FULL CHECKS LIST SHOULD STAY IN AUDIT STATE");
		expect(surface).not.toContain("src/full-audit-only.ts");
		expect(surface).not.toContain("targetSnapshot");
		expect(surface).not.toContain("evidenceChecked");
		expect(surface).not.toContain("Verifier-only rubric");
		expect(surface).not.toContain("[]");

		const serializedState = JSON.stringify(serializeGoalModeState(checkpointState), null, 2);
		expect(serializedState).toContain("targetSnapshot");
		expect(serializedState).toContain("FULL CHECKPOINT EVIDENCE DETAIL SHOULD STAY IN AUDIT STATE");
		expect(serializedState).toContain("evidenceChecked");

		const continuationPrompt = renderGoalPrompt("continuation", checkpointState.goal, checkpointState);
		expect(continuationPrompt).toContain("Checkpoint-resolution action");
		expect(continuationPrompt).toContain("resolve_checkpoint");
		expect(continuationPrompt).not.toContain("Working-target action");
		expect(continuationPrompt).not.toContain("FULL CHECKPOINT EVIDENCE DETAIL SHOULD STAY IN AUDIT STATE");
	});

	it("groups deliverables, compacts older parent truth, and avoids duplicate resolution targets", async () => {
		const harness = createHarness();
		const oldClaim = `Older accepted claim ${"x".repeat(140)} UNIQUE_OLD_DETAIL_SHOULD_NOT_BE_IN_PROMPT`;
		const initialState = await harness.runtime.createGoal({
			objective: "Improve release reliability",
			parentFrame: createParentFrame({
				kind: "claim-gated",
				desiredFuture: "Release truth is explicit",
				acceptedClaims: [
					{
						id: "old-claim",
						claim: oldClaim,
						status: "accepted",
						evidenceRefs: [{ id: "checkpoint:old", kind: "artifact" }],
						nonImplications: ["Old claim non-implication remains visible."],
					},
				],
				boundaries: [
					{
						id: "release-not-complete",
						kind: "forbidden-inference",
						statement: "Accepted target evidence is not parent completion.",
					},
				],
			}),
		});
		await harness.runtime.setGoalRubric(initialState.goal.id, "Verifier-only rubric", [
			{ id: "D1", summary: "Source-link smoke.", status: "pending" },
			{ id: "D2", summary: "Tarball smoke.", status: "pending" },
			{
				id: "D3",
				summary: "Already satisfied archive migration.",
				status: "satisfied",
				nextRelevantTarget: "OLD SATISFIED NEXT HINT SHOULD NOT APPEAR",
			},
			{
				id: "D4",
				summary: "Partial documentation update.",
				status: "partial",
				nextRelevantTarget: "Continue partial documentation proof.",
			},
		]);
		const working = await startApprovedTarget(harness, {
			title: "Prove source-link smoke",
			desiredFutureClaim: "Source-link install exercises smoke path.",
			closureStandard: "Smoke output is observed.",
			parentDeliverableIds: ["D1"],
		});
		const workingSurface = buildGoalContextSurface(working, working.goal);
		expect(workingSurface.target_execution_guardrails).toMatchObject({
			targetTitle: "Prove source-link smoke",
			closureStandard: "Smoke output is observed.",
			requiredSignals: [
				expect.objectContaining({
					method: "Run the focused check.",
					confidenceIfSatisfied: "high",
				}),
			],
			excludedWork: [expect.objectContaining({ item: "Parent completion" })],
		});
		expect(workingSurface).not.toHaveProperty("target_execution_summary");
		const workingSurfaceText = renderGoalPromptSurface(working, working.goal);
		expect(workingSurfaceText).toContain('"target_execution_guardrails"');
		expect(workingSurfaceText).not.toContain('"target_execution_summary"');
		expect(workingSurfaceText).not.toContain('"verificationAperture"');
		expect(workingSurfaceText).not.toContain('"scopeCalibration"');
		expect(workingSurfaceText).toContain("Run the focused check.");
		const candidate = harness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Source-link smoke passed.",
			localClaims: ["Source-link install exercises smoke path"],
			evidence: [
				{ claim: "Source-link install exercises smoke path", evidence: "Observed smoke output", current: true },
			],
			notClaimed: ["Tarball path is verified"],
			remainingQuestions: ["Check tarball path next?"],
		});
		const committed = await harness.runtime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Closed locally.",
			evidenceChecked: candidate.evidence,
			blockers: [],
			reviewedAt: 20,
		});
		const resolved = await harness.runtime.recordCheckpointResolution({
			checkpointId: committed.goal.pendingCheckpointId ?? "",
			stateVersion: committed.stateVersion,
			parentFrameVersion: committed.parentFrameVersion,
			decision: "next_target",
			parentReading: "Source-link smoke claim accepted; tarball path remains open.",
			parentDelta: {
				admittedClaims: [
					{
						id: "source-link-smoke",
						claim: "Latest accepted source-link smoke claim remains fully visible.",
						status: "accepted",
						evidenceRefs: [{ id: `checkpoint:${candidate.id}`, kind: "artifact" }],
						nonImplications: ["Tarball path is verified"],
					},
				],
				candidateClaimsAdded: [],
				rejectedClaims: [],
				boundariesAdded: [],
				residualsAddedOrUpdated: [],
				gateDeltas: [],
				frontierDeltas: [],
				staleRefs: [],
				externalRecordRefs: [],
				deliverableDeltas: [
					{
						id: "D1",
						status: "satisfied",
						evidenceRefs: [{ id: `checkpoint:${candidate.id}`, kind: "artifact" }],
					},
					{ id: "D2", status: "partial", nextRelevantTarget: "Run tarball smoke." },
				],
			},
			notPropagated: ["Tarball path is verified"],
			remainingParentWork: ["Tarball install evidence"],
			nextTarget: {
				title: "Prove tarball smoke",
				desiredFutureClaim: "Tarball installs exercise smoke path.",
				closureStandard: "Tarball smoke output is observed.",
				forbiddenClaims: ["Release is ready"],
				parentDeliverableIds: ["D2"],
			},
		});

		const surface = buildGoalContextSurface(resolved, resolved.goal);
		expect(surface.current_target).toMatchObject({
			title: "Prove tarball smoke",
			closureStandard: "Tarball smoke output is observed.",
			parentDeliverableIds: ["D2"],
		});
		const surfaceText = renderGoalPromptSurface(resolved, resolved.goal);
		expect(surfaceText).toContain("Latest accepted source-link smoke claim remains fully visible.");
		expect(surfaceText).toContain("old-claim");
		expect(surfaceText).not.toContain("UNIQUE_OLD_DETAIL_SHOULD_NOT_BE_IN_PROMPT");
		expect(surfaceText).toContain("Old claim non-implication remains visible.");
		expect(surfaceText).toContain("Accepted target evidence is not parent completion.");
		expect(surfaceText).toContain('"active_or_partial"');
		expect(surfaceText).toContain("Run tarball smoke.");
		expect(surfaceText).toContain("Continue partial documentation proof.");
		expect(surfaceText).toContain('"satisfied"');
		expect(surfaceText).not.toContain("OLD SATISFIED NEXT HINT SHOULD NOT APPEAR");
		expect(surfaceText).toContain('"nextTargetId"');
		expect(surfaceText).not.toContain('"nextTarget":');
		expect(surfaceText).not.toContain('"nextTargetTitle"');
		expect(surfaceText).not.toContain("[]");
		expect(surfaceText.length).toBeLessThan(5_000);
	});

	it("records side-agent usage against the active goal budget", async () => {
		const harness = createHarness();

		const state = await harness.runtime.createGoal({ objective: "Ship usage", tokenBudget: 10 });
		await harness.runtime.recordExternalUsage(
			createUsage({ input: 3, output: 2, cacheRead: 99, cacheWrite: 4 }),
			1_500,
		);

		const goal = harness.getState()?.goal;
		expect(goal?.id).toBe(state.goal.id);
		expect(goal?.tokensUsed).toBe(9);
		expect(goal?.timeUsedSeconds).toBe(1);
		expect(goal?.status).toBe("active");
	});

	it("keeps durable verification history when supplied attempts are stale", async () => {
		const harness = createHarness();
		const state = await harness.runtime.createGoal({ objective: "Ship concurrent completions" });

		await harness.runtime.recordFailedCompletionVerification(state.goal.id, "First rejection", {
			attempt: 1,
			maxAttempts: 3,
		});
		await harness.runtime.recordFailedCompletionVerification(state.goal.id, "Second rejection", {
			attempt: 1,
			maxAttempts: 3,
		});

		const goal = harness.getState()?.goal;
		expect(goal?.failedCompletionAttempts).toBe(2);
		expect(goal?.lastVerificationAttempt).toBe(2);
		expect(goal?.totalVerificationAttempts).toBe(2);
		expect(goal?.verificationAttempts?.map(attempt => attempt.sequence)).toEqual([1, 2]);
		expect(goal?.lastVerificationFeedback).toBe("Second rejection");
	});
	it("preserves verifier-repair attempts across ordinary non-yield work", async () => {
		const harness = createHarness();
		const state = await harness.runtime.createGoal({ objective: "Ship after feedback" });
		await harness.runtime.recordFailedCompletionVerification(state.goal.id, "Need evidence", {
			attempt: 1,
			maxAttempts: 3,
		});

		await harness.runtime.onToolCompleted("yield");
		expect(harness.getState()?.goal.failedCompletionAttempts).toBe(1);
		expect(harness.getState()?.goal.lastVerificationFeedback).toBe("Need evidence");

		await harness.runtime.onToolCompleted("read");
		expect(harness.getState()?.goal.failedCompletionAttempts).toBe(1);
		expect(harness.getState()?.goal.verificationRepair?.feedback).toBe("Need evidence");
		expect(harness.getState()?.goal.lastVerificationFeedback).toBe("Need evidence");
		expect(harness.getState()?.goal.totalVerificationAttempts).toBe(1);
		expect(harness.getState()?.goal.workEpoch).toBe(0);
	});

	it("normalizes, serializes, and restores the parent frame and run state", async () => {
		const harness = createHarness();

		const created = await harness.runtime.createGoal({
			objective: "Improve release reliability",
			parentFrame: createParentFrame({
				kind: "claim-gated",
				desiredFuture: "Release truth is explicit",
				currentTruth: "Local smoke exists; release readiness is unproven.",
				gates: [
					{
						id: "install-smoke",
						name: "Install smoke",
						status: "unknown",
						requiredEvidence: ["smoke output"],
					},
				],
				boundaries: [
					{
						id: "local-smoke-not-release",
						kind: "forbidden-inference",
						statement: "Local smoke does not imply release readiness.",
					},
				],
				residuals: [
					{
						id: "tarball-smoke",
						statement: "Tarball path needs evidence.",
						classification: "current-parent-blocker",
					},
				],
				externalRefs: [{ id: "release-record", kind: "external-record", uri: "release://current" }],
			}),
		});

		const restored = parseGoalModeState(serializeGoalModeState(created), true);

		expect(restored?.runMode).toBe("working-target");
		expect(restored?.stateVersion).toBe(1);
		expect(restored?.parentFrameVersion).toBe(1);
		expect(restored?.goal.parentFrame?.gates[0]?.id).toBe("install-smoke");
		expect(restored?.goal.parentFrame?.boundaries[0]?.statement).toContain("Local smoke");
	});

	it("migrates legacy goal mode data without run-mode version fields", () => {
		const restored = parseGoalModeState(
			{
				goal: createGoal({
					objective: "Legacy goal",
					parentFrame: createParentFrame({
						desiredFuture: "Legacy objective stays active.",
					}),
				}),
			},
			true,
		);

		expect(restored?.enabled).toBe(true);
		expect(restored?.runMode).toBe("working-target");
		expect(restored?.stateVersion).toBe(0);
		expect(restored?.parentFrameVersion).toBe(1);
		expect(restored?.goal.parentFrame?.desiredFuture).toBe("Legacy objective stays active.");
	});

	it("restores legacy matrixless target-plan records", () => {
		const legacyTarget = {
			id: "target-legacy",
			sequence: 1,
			status: "active",
			title: "Legacy target",
			desiredFutureClaim: "Legacy target behavior is proven.",
			closureStandard: "Focused evidence exists.",
			baselineRefs: [],
			gateRefs: [],
			evidenceExpectation: [],
			nonGoals: [],
			forbiddenClaims: [],
			staleIf: [],
			createdAt: 1,
			createdBy: "initial",
			planId: "target-plan-legacy",
		};
		const legacyPlan = {
			id: "target-plan-legacy",
			goalId: "goal-1",
			targetId: legacyTarget.id,
			targetSequence: legacyTarget.sequence,
			planFilePath: "local://goal-goal-1-target-legacy-plan.md",
			status: "drafting",
			revision: 1,
			stateVersionAtStart: 2,
			parentFrameVersionAtStart: 0,
			createdAt: 1,
			updatedAt: 1,
			verificationAperture: {
				productIntention: "Prove the target behavior with direct evidence.",
				primarySignalId: "signal-primary",
				blastRadius: "local",
				confidenceTarget: "high",
				layerRationale: "The target is local and directly observable.",
				residualUncertainty: ["Parent completion remains outside this target."],
				omittedLayers: [{ layer: "e2e", reason: "Parent-level e2e belongs to a later target." }],
			},
			verificationSignals: [
				{
					id: "signal-primary",
					role: "primary",
					layer: "integration",
					concernIds: ["concern-behavior"],
					claim: "Target behavior is verified.",
					observation: "Focused evidence is observed.",
					method: "Run the focused check.",
					expectedOutcome: "The focused check passes.",
					required: true,
					confidenceIfSatisfied: "high",
					staleIf: ["Relevant code changes."],
				},
			],
			concernChecks: [
				{
					id: "concern-behavior",
					kind: "behavior",
					whyIndependent: "Behavior can fail independently of parent completion.",
					coveredBySignalIds: ["signal-primary"],
				},
			],
			scopeCalibration: {
				rightSizingBasis: "product-signal",
				whyNotSmaller: ["Smaller work would not produce an observable signal."],
				whyNotLarger: ["Larger work would claim parent-level completion."],
				includedRelatedWork: [
					{ item: "Focused target work", reason: "Needed for primary signal.", signalIds: ["signal-primary"] },
				],
				deferredRelatedWork: [
					{
						item: "Parent completion verification",
						reason: "different-primary-signal",
						followUpHint: "Checkpoint first.",
					},
				],
			},
			branchEvidence: [
				{
					branch: "happy path",
					required: true,
					plannedSignalIds: ["signal-primary"],
					rationale: "Primary signal.",
				},
			],
			excludedWorkReview: [
				{ item: "Parent completion", classification: "parent-non-claim", rationale: "Checkpoint is bounded." },
			],
			reviews: [],
		};

		const restored = parseGoalModeState(
			{
				enabled: true,
				mode: "active",
				runMode: "planning-target",
				stateVersion: 3,
				parentFrameVersion: 0,
				goal: {
					...createGoal({ objective: "Legacy matrixless target plan" }),
					currentTarget: legacyTarget,
					currentTargetPlan: legacyPlan,
					targets: [legacyTarget],
					targetPlans: [legacyPlan],
				},
			},
			true,
		);
		if (!restored) throw new Error("expected restored goal mode state");

		expect(restored.runMode).toBe("planning-target");
		expect(restored.goal.currentTargetPlan?.id).toBe("target-plan-legacy");
		expect(restored.goal.currentTargetPlan?.planDepth).toBeUndefined();
		expect(restored.goal.currentTargetPlan?.primarySignalGroupId).toBeUndefined();
		expect(restored.goal.currentTargetPlan?.scenarioMatrix).toBeUndefined();
		expect(restored.goal.currentTargetPlan?.targetCard).toBeUndefined();
		const roundTrip = parseGoalModeState(serializeGoalModeState(restored), true);
		expect(roundTrip?.goal.currentTargetPlan?.scenarioMatrix).toBeUndefined();
		expect(roundTrip?.goal.currentTargetPlan?.targetCard).toBeUndefined();
	});

	it("clears legacy resolved pending checkpoint outside checkpoint-resolution mode", () => {
		const restored = parseGoalModeState(
			{
				enabled: true,
				mode: "active",
				runMode: "awaiting-user-input",
				stateVersion: 4,
				parentFrameVersion: 0,
				goal: {
					...createGoal({ objective: "Legacy paused goal" }),
					pendingCheckpointId: "checkpoint-1",
					lastCheckpointResolutionId: "resolution-1",
					checkpointResolutions: [
						{
							id: "resolution-1",
							sequence: 1,
							goalId: "goal-1",
							checkpointId: "checkpoint-1",
							decision: "pause_for_external_control",
							parentReading: "Paused for external authority.",
							notPropagated: [],
							remainingParentWork: ["Choose next target"],
							broaderChecksOrInputs: [],
							lessonsForFuture: [],
							createdAt: 1,
						},
					],
				},
			},
			true,
		);

		expect(restored?.goal.pendingCheckpointId).toBeUndefined();
		expect(restored?.goal.lastCheckpointResolutionId).toBe("resolution-1");
	});

	it("normalizes completed goals to terminal run mode", () => {
		const restored = parseGoalModeState(
			{
				enabled: false,
				mode: "active",
				runMode: "working-target",
				stateVersion: 4,
				parentFrameVersion: 0,
				goal: createGoal({ objective: "Completed legacy goal", status: "complete" }),
			},
			false,
		);

		expect(restored?.runMode).toBe("completed");
		expect(restored?.mode).toBe("exiting");
		expect(restored?.reason).toBe("completed");
		expect(restored?.enabled).toBe(false);
	});

	it("does not increment semantic state version for accounting-only side-agent usage", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Track accounting" });
		const before = harness.getState()?.stateVersion;
		const persistCount = harness.persists.length;

		await harness.runtime.recordExternalUsage(createUsage({ input: 2, output: 1, cacheWrite: 1 }), 1_000);

		expect(harness.getState()?.stateVersion).toBe(before);
		expect(harness.getState()?.goal.tokensUsed).toBe(4);
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(1);
		expect(harness.persists).toHaveLength(persistCount);
		expect(harness.usagePersists).toHaveLength(1);
		expect(harness.usagePersists[0]).toMatchObject({
			tokenDelta: 4,
			wallSeconds: 1,
			tokensUsed: 4,
			timeUsedSeconds: 1,
		});
	});

	it("persists a budget-limited snapshot for external usage budget flips", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Track accounting", tokenBudget: 3 });
		const persistCount = harness.persists.length;

		await harness.runtime.recordExternalUsage(createUsage({ input: 3 }), 1_000);

		expect(harness.getState()?.goal.status).toBe("budget-limited");
		expect(harness.persists).toHaveLength(persistCount + 1);
		expect(harness.persists.at(-1)).toMatchObject({ mode: "goal", reason: "budget-limited" });
		expect(harness.usagePersists).toHaveLength(0);
	});

	it("starts targets in planning mode and blocks execution before plan approval", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });

		const planning = await harness.runtime.startTarget({
			title: "Prove installer smoke",
			desiredFutureClaim: "Installer smoke exercises worker startup.",
			closureStandard: "Focused smoke evidence exists.",
		});

		expect(planning.runMode).toBe("planning-target");
		expect(planning.goal.currentTarget?.status).toBe("active");
		expect(planning.goal.currentTargetPlan?.status).toBe("drafting");
		expect(planning.goal.currentTargetPlan?.planFilePath).toBe(`local://goal-${planning.goal.id}-target-1-plan.md`);
		if (!planning.goal.currentTargetPlan) throw new Error("expected current target plan");
		const surface = renderGoalPromptSurface(planning, planning.goal);
		expect(surface).toContain(targetPlanPayloadFilePath(planning.goal.currentTargetPlan.planFilePath));
		const packet = buildGoalContinuationPacket(planning, "context-compaction", "Compaction", "Resume planning");
		expect(packet.currentTargetPlanPayloadFilePath).toBe(
			targetPlanPayloadFilePath(planning.goal.currentTargetPlan.planFilePath),
		);
		expect(() =>
			harness.runtime.buildCheckpointCandidate({
				status: "closed_with_evidence",
				summary: "Smoke evidence recorded.",
				localClaims: ["Smoke exercises worker startup"],
				evidence: [{ claim: "Smoke exercises worker startup", evidence: "Observed smoke output", current: true }],
				notClaimed: ["Parent goal complete"],
				remainingQuestions: [],
			}),
		).toThrow("target planning is pending");
		await expect(harness.runtime.completeGoalFromTool()).rejects.toThrow("target planning is pending");
		const prompt = renderGoalPrompt("continuation", planning.goal, planning);
		expect(prompt).toContain("targetPlanSubmitIdentity.payloadFilePath");
		expect(prompt).toContain("payload_file_path");
		expect(prompt).toContain("submit_target_plan");
	});

	it("explains how to recover before checkpointing a paused goal", () => {
		const harness = createHarness({
			state: { enabled: false, mode: "active", goal: createGoal({ status: "paused" }) },
		});

		expect(() =>
			harness.runtime.buildCheckpointCandidate({
				status: "closed_with_evidence",
				summary: "Smoke evidence recorded.",
				localClaims: ["Smoke exercises worker startup"],
				evidence: [{ claim: "Smoke exercises worker startup", evidence: "Observed smoke output", current: true }],
				notClaimed: ["Parent goal complete"],
				remainingQuestions: [],
			}),
		).toThrow('cannot checkpoint while the goal is paused; call goal({op:"resume"}) before checkpointing');
	});

	it("reports target-plan identity mismatches with expected and actual values", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		const planning = await harness.runtime.startTarget({
			title: "Prove installer smoke",
			desiredFutureClaim: "Installer smoke exercises worker startup.",
			closureStandard: "Focused smoke evidence exists.",
		});
		const approval = buildTargetPlanApprovalInput(planning);

		expect(() =>
			harness.runtime.validateCurrentTargetPlanSubmission({ ...approval, targetId: "wrong-target" }),
		).toThrow(`target_id must equal currentTarget.id (${approval.targetId}); got wrong-target`);
		expect(() =>
			harness.runtime.validateCurrentTargetPlanSubmission({ ...approval, targetPlanId: "wrong-plan" }),
		).toThrow(`target_plan_id must equal currentTargetPlan.id (${approval.targetPlanId}); got wrong-plan`);
		expect(() =>
			harness.runtime.validateCurrentTargetPlanSubmission({ ...approval, planFilePath: "local://wrong.md" }),
		).toThrow(
			`plan_file_path must equal currentTargetPlan.planFilePath (${approval.planFilePath}); got local://wrong.md`,
		);
		expect(() => harness.runtime.validateCurrentTargetPlanSubmission({ ...approval, revision: 99 })).toThrow(
			`revision must equal currentTargetPlan.revision (${approval.revision}); got 99`,
		);
	});

	it("rejects target-plan reviews whose evidence targets another plan or revision", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		const planning = await harness.runtime.startTarget({
			title: "Prove installer smoke",
			desiredFutureClaim: "Installer smoke exercises worker startup.",
			closureStandard: "Focused smoke evidence exists.",
		});
		const approval = buildTargetPlanApprovalInput(planning);
		const withReviewPatch = (
			lens: GoalTargetPlanReview["lens"],
			patch: Partial<GoalTargetPlanReview>,
		): GoalTargetPlanApprovalInput => ({
			...approval,
			reviews: approval.reviews.map(review => (review.lens === lens ? { ...review, ...patch } : review)),
		});

		await expect(
			harness.runtime.approveCurrentTargetPlan(
				withReviewPatch("execution-readiness", { reviewedTargetPlanId: "previous-plan" }),
			),
		).rejects.toThrow("target plan review target_plan_id does not match the submitted target plan");
		await expect(
			harness.runtime.approveCurrentTargetPlan(withReviewPatch("execution-readiness", { reviewedRevision: 0 })),
		).rejects.toThrow("target plan review revision does not match the submitted revision");
		await expect(
			harness.runtime.approveCurrentTargetPlan(withReviewPatch("aperture", { revisedAfterReview: true })),
		).rejects.toThrow("accepted target plan review is stale after a plan revision");
	});

	it("approves right-sized target plans and carries verification signals onto the target", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		const planning = await harness.runtime.startTarget({
			title: "Prove installer smoke",
			desiredFutureClaim: "Installer smoke exercises worker startup.",
			closureStandard: "Focused smoke evidence exists.",
		});
		const approval = buildTargetPlanApprovalInput(planning);
		await expect(
			harness.runtime.approveCurrentTargetPlan({
				...approval,
				reviews: approval.reviews.map(review =>
					review.lens === "aperture" ? { ...review, apertureClassification: "too-narrow" } : review,
				),
			}),
		).rejects.toThrow("right-sized");

		const approved = await harness.runtime.approveCurrentTargetPlan(approval);

		expect(approved.runMode).toBe("working-target");
		expect(approved.goal.currentTargetPlan?.status).toBe("approved");
		expect(approved.goal.currentTarget?.planId).toBe(approved.goal.currentTargetPlan?.id);
		expect(approved.goal.currentTarget?.verificationSignals?.[0]?.id).toBe(approval.verificationSignals[0]?.id);
		expect(approved.goal.currentTarget?.verificationSignals?.[0]?.confidenceRationale).toBe(
			"Focused verification earns target confidence only.",
		);
		const executionSummary = buildGoalTargetPlanExecutionSummary(
			approved.goal.currentTargetPlan,
			approved.goal.currentTarget,
		);
		expect(executionSummary?.payloadFilePath).toBe(
			targetPlanPayloadFilePath(approved.goal.currentTargetPlan?.planFilePath ?? "missing-plan.md"),
		);
		expect(executionSummary?.verificationAperture?.blastRadiusScope).toBe("Single target behavior surface.");
		expect(executionSummary?.verificationAperture?.confidenceRationale).toBe(
			"High only for the focused target behavior.",
		);
		expect(executionSummary?.requiredSignals[0]?.confidenceRationale).toBe(
			"Focused verification earns target confidence only.",
		);
		expect(executionSummary?.concernChecks?.[0]?.lens).toBe("focused behavior");
		expect(executionSummary?.scopeCalibration?.rightSizingRationale).toBe(
			"One product signal closes without claiming parent completion.",
		);
		expect(executionSummary?.scopeCalibration?.deferredRelatedWork[0]?.rationale).toBe(
			"Parent verification needs broader evidence.",
		);
		const executionGuardrails = buildGoalTargetPlanExecutionGuardrails(executionSummary);
		expect(executionGuardrails).toMatchObject({
			payloadFilePath: targetPlanPayloadFilePath(approved.goal.currentTargetPlan?.planFilePath ?? "missing-plan.md"),
			requiredSignals: [
				expect.objectContaining({
					method: approval.verificationSignals[0]?.method,
					confidenceIfSatisfied: approval.verificationSignals[0]?.confidenceIfSatisfied,
				}),
			],
		});
		expect(executionGuardrails).not.toHaveProperty("verificationAperture");
		expect(executionGuardrails).not.toHaveProperty("concernChecks");
		expect(executionGuardrails).not.toHaveProperty("scopeCalibration");
	});

	it("rejects target plans whose primary signal is not required", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		const planning = await harness.runtime.startTarget({
			title: "Prove installer smoke",
			desiredFutureClaim: "Installer smoke exercises worker startup.",
			closureStandard: "Focused smoke evidence exists.",
		});
		const approval = buildTargetPlanApprovalInput(planning);

		await expect(
			harness.runtime.approveCurrentTargetPlan({
				...approval,
				verificationSignals: approval.verificationSignals.map(signal => ({ ...signal, required: false })),
			}),
		).rejects.toThrow("primary signal must be required");
		await expect(
			harness.runtime.approveCurrentTargetPlan({
				...approval,
				verificationAperture: { ...approval.verificationAperture, primarySignalId: "missing-signal" },
			}),
		).rejects.toThrow("primary signal must reference");
	});

	it("blocks checkpointing after a target plan fails before approval", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		const planning = await harness.runtime.startTarget({
			title: "Prove installer smoke",
			desiredFutureClaim: "Installer smoke exercises worker startup.",
			closureStandard: "Focused smoke evidence exists.",
		});
		const target = planning.goal.currentTarget;
		const plan = planning.goal.currentTargetPlan;
		if (!target || !plan) throw new Error("expected planning target");

		const failed = await harness.runtime.failCurrentTargetPlan({
			targetId: target.id,
			targetPlanId: plan.id,
			revision: plan.revision,
			reason: "needs-user-input",
			message: "Operator must choose the right target aperture.",
			blockers: ["Missing target aperture decision."],
			suggestedQuestions: ["Which target aperture should be planned?"],
		});

		expect(failed.runMode).toBe("awaiting-user-input");
		expect(() =>
			harness.runtime.buildCheckpointCandidate({
				status: "closed_with_evidence",
				summary: "Smoke evidence recorded.",
				localClaims: ["Smoke exercises worker startup"],
				evidence: [{ claim: "Smoke exercises worker startup", evidence: "Observed smoke output", current: true }],
				notClaimed: ["Parent goal complete"],
				remainingQuestions: [],
			}),
		).toThrow("target plan is approved");
	});

	it("auto-consolidates review rejection caps without user input", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve quest reliability" });
		let state = await harness.runtime.startTarget({
			title: "Complete Warden's Spark",
			desiredFutureClaim: "Warden's Spark can be completed with the chosen equipment.",
			closureStandard: "Current evidence proves the quest completes with the chosen equipment.",
		});
		const targetId = state.goal.currentTarget?.id;
		let cappedPlanId: string | undefined;

		for (let index = 0; index < 3; index += 1) {
			const plan = state.goal.currentTargetPlan;
			if (!plan) throw new Error("expected target plan");
			cappedPlanId = plan.id;
			state = await harness.runtime.rejectCurrentTargetPlan({
				targetPlanId: plan.id,
				revision: plan.revision,
				reviews: [rejectedTargetPlanReview("execution-readiness")],
				message: "target plan reviewer rejected the submission",
				stage: "review",
			});
		}

		const recoveredTarget = state.goal.currentTarget;
		const recoveredPlan = state.goal.currentTargetPlan;
		if (!targetId || !cappedPlanId || !recoveredTarget || !recoveredPlan)
			throw new Error("expected recovered target-plan attempt");
		const cappedPlan = state.goal.targetPlans?.find(plan => plan.id === cappedPlanId);
		const recovery = state.goal.recoveryHistory?.find(record => record.result.targetPlanId === recoveredPlan.id);

		expect(state.runMode).toBe("planning-target");
		expect(state.goal.currentBlockedState).toBeUndefined();
		expect(cappedPlan?.status).toBe("failed");
		expect(cappedPlan?.revision).toBe(3);
		expect(cappedPlan?.failure?.reason).toBe("review-rejection-cap");
		expect(cappedPlan?.failure?.blockers).toContain(
			"execution-readiness:RIGHT_SIZE_BLOCKER: Revise the target aperture.",
		);
		expect(recoveredTarget.id).toBe(targetId);
		expect(recoveredTarget.status).toBe("active");
		expect(recoveredTarget.planId).toBe(recoveredPlan.id);
		expect(recoveredPlan.id).toBe(`${targetId}-plan-attempt-2`);
		expect(recoveredPlan.planFilePath.endsWith("-plan-attempt-2.md")).toBe(true);
		expect(recoveredPlan.status).toBe("drafting");
		expect(recoveredPlan.revision).toBe(1);
		expect(recoveredPlan.recoveredFrom?.blockedStateId).toBe(`${cappedPlanId}-auto-consolidation`);
		expect(recoveredPlan.recoveredFrom?.reason).toBe("state-refresh");
		expect(recoveredPlan.recoveredFrom?.guidance).toContain("execution-readiness:RIGHT_SIZE_BLOCKER");
		if (!recovery) throw new Error("expected target-plan recovery record");
		if (!("targetPlanId" in recovery.source)) throw new Error("expected target-plan recovery source");
		expect(recovery.source.targetPlanId).toBe(cappedPlanId);
		expect(recovery?.result.runMode).toBe("planning-target");
		expect(recoveredPlan.failure).toBeUndefined();
		expect(recoveredPlan.failedAt).toBeUndefined();
		expect(recoveredPlan.approvedAt).toBeUndefined();
		expect(recoveredPlan.verificationAperture).toBeUndefined();
		expect(recoveredPlan.verificationSignals).toBeUndefined();
		expect(recoveredPlan.concernChecks).toBeUndefined();
		expect(recoveredPlan.scopeCalibration).toBeUndefined();
		expect(recoveredPlan.branchEvidence).toBeUndefined();
		expect(recoveredPlan.excludedWorkReview).toBeUndefined();
		expect(recoveredPlan.reviews).toEqual([]);
	});

	it("auto-consolidates actionable aperture rejection caps", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve quest reliability" });
		let state = await harness.runtime.startTarget({
			title: "Complete Warden's Spark",
			desiredFutureClaim: "Warden's Spark can be completed with the chosen equipment.",
			closureStandard: "Current evidence proves the quest completes with the chosen equipment.",
		});

		for (let index = 0; index < 3; index += 1) {
			const plan = state.goal.currentTargetPlan;
			if (!plan) throw new Error("expected target plan");
			state = await harness.runtime.rejectCurrentTargetPlan({
				targetPlanId: plan.id,
				revision: plan.revision,
				reviews: [rejectedTargetPlanReview("aperture", { revisionDecision: "split-required" })],
				message: "target plan reviewer rejected the submission",
				stage: "review",
			});
		}

		const recoveredPlan = state.goal.currentTargetPlan;
		if (!recoveredPlan) throw new Error("expected recovered target-plan attempt");
		expect(state.runMode).toBe("planning-target");
		expect(state.goal.currentBlockedState).toBeUndefined();
		expect(recoveredPlan.status).toBe("drafting");
		expect(recoveredPlan.recoveredFrom?.guidance).toContain("aperture:RIGHT_SIZE_BLOCKER");
	});

	it("uses current review batch for cap recovery guidance", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve quest reliability" });
		let state = await harness.runtime.startTarget({
			title: "Complete Warden's Spark",
			desiredFutureClaim: "Warden's Spark can be completed with the chosen equipment.",
			closureStandard: "Current evidence proves the quest completes with the chosen equipment.",
		});

		let plan = state.goal.currentTargetPlan;
		if (!plan) throw new Error("expected target plan");
		state = await harness.runtime.rejectCurrentTargetPlan({
			targetPlanId: plan.id,
			revision: plan.revision,
			reviews: [rejectedTargetPlanReview("aperture", { revisionDecision: "needs-user-input" })],
			message: "target plan reviewer rejected the submission",
			stage: "review",
		});
		plan = state.goal.currentTargetPlan;
		if (!plan) throw new Error("expected target plan");
		state = await harness.runtime.rejectCurrentTargetPlan({
			targetPlanId: plan.id,
			revision: plan.revision,
			reviews: [rejectedTargetPlanReview("execution-readiness")],
			message: "target plan reviewer rejected the submission",
			stage: "review",
		});
		plan = state.goal.currentTargetPlan;
		if (!plan) throw new Error("expected target plan");
		const cappedPlanId = plan.id;
		state = await harness.runtime.rejectCurrentTargetPlan({
			targetPlanId: plan.id,
			revision: plan.revision,
			reviews: [rejectedTargetPlanReview("execution-readiness")],
			message: "target plan reviewer rejected the submission",
			stage: "review",
		});

		const failedPlan = state.goal.targetPlans?.find(candidate => candidate.id === cappedPlanId);
		const recoveredPlan = state.goal.currentTargetPlan;
		if (!recoveredPlan) throw new Error("expected recovered target-plan attempt");
		expect(state.runMode).toBe("planning-target");
		expect(state.goal.currentBlockedState).toBeUndefined();
		expect(failedPlan?.failure?.blockers).toEqual([
			"execution-readiness:RIGHT_SIZE_BLOCKER: Revise the target aperture.",
		]);
		expect(recoveredPlan.recoveredFrom?.guidance).toContain("execution-readiness:RIGHT_SIZE_BLOCKER");
		expect(recoveredPlan.recoveredFrom?.guidance).not.toContain("aperture:RIGHT_SIZE_BLOCKER");
	});

	it("blocks review rejection caps without concrete blockers", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve quest reliability" });
		let state = await harness.runtime.startTarget({
			title: "Complete Warden's Spark",
			desiredFutureClaim: "Warden's Spark can be completed with the chosen equipment.",
			closureStandard: "Current evidence proves the quest completes with the chosen equipment.",
		});

		for (let index = 0; index < 3; index += 1) {
			const plan = state.goal.currentTargetPlan;
			if (!plan) throw new Error("expected target plan");
			state = await harness.runtime.rejectCurrentTargetPlan({
				targetPlanId: plan.id,
				revision: plan.revision,
				reviews: [rejectedTargetPlanReview("execution-readiness", { findings: [] })],
				message: "target plan reviewer rejected the submission",
				stage: "review",
			});
		}

		const block = state.goal.currentBlockedState;
		if (block?.kind !== "target-plan") throw new Error("expected blocked target-plan state");
		expect(state.runMode).toBe("awaiting-user-input");
		expect(state.goal.currentTargetPlan?.status).toBe("failed");
		expect(block.blockers).toEqual(["target plan reviewer rejected the submission"]);
	});

	it("blocks review rejection caps when the reviewer failed", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve quest reliability" });
		let state = await harness.runtime.startTarget({
			title: "Complete Warden's Spark",
			desiredFutureClaim: "Warden's Spark can be completed with the chosen equipment.",
			closureStandard: "Current evidence proves the quest completes with the chosen equipment.",
		});

		for (let index = 0; index < 3; index += 1) {
			const plan = state.goal.currentTargetPlan;
			if (!plan) throw new Error("expected target plan");
			state = await harness.runtime.rejectCurrentTargetPlan({
				targetPlanId: plan.id,
				revision: plan.revision,
				reviews: [
					rejectedTargetPlanReview("execution-readiness", {
						status: "failed",
						feedback: "Execution reviewer failed.",
						findings: [
							{
								id: "TARGET_PLAN_REVIEWER_FAILED",
								severity: "blocking",
								problem: "Execution reviewer failed.",
								requiredRevision: "Fix or rerun the target-plan reviewer.",
							},
						],
					}),
				],
				message: "target plan reviewer rejected the submission",
				stage: "review",
			});
		}

		const block = state.goal.currentBlockedState;
		if (block?.kind !== "target-plan") throw new Error("expected blocked target-plan state");
		expect(state.runMode).toBe("awaiting-user-input");
		expect(block.blockers).toEqual([
			"execution-readiness:TARGET_PLAN_REVIEWER_FAILED: Fix or rerun the target-plan reviewer.",
		]);
	});

	it("blocks review rejection caps that need user input", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve quest reliability" });
		let state = await harness.runtime.startTarget({
			title: "Complete Warden's Spark",
			desiredFutureClaim: "Warden's Spark can be completed with the chosen equipment.",
			closureStandard: "Current evidence proves the quest completes with the chosen equipment.",
		});

		for (let index = 0; index < 3; index += 1) {
			const plan = state.goal.currentTargetPlan;
			if (!plan) throw new Error("expected target plan");
			state = await harness.runtime.rejectCurrentTargetPlan({
				targetPlanId: plan.id,
				revision: plan.revision,
				reviews: [rejectedTargetPlanReview("aperture", { revisionDecision: "needs-user-input" })],
				message: "target plan reviewer rejected the submission",
				stage: "review",
			});
		}

		const targetId = state.goal.currentTarget?.id;
		const failedPlan = state.goal.currentTargetPlan;
		const block = state.goal.currentBlockedState;
		if (!targetId || !failedPlan || !block || block.kind !== "target-plan")
			throw new Error("expected failed target-plan block");
		expect(state.runMode).toBe("awaiting-user-input");
		expect(block.source.status).toBe("failed");
		expect(failedPlan.revision).toBe(3);
		expect(failedPlan.failure?.reason).toBe("review-rejection-cap");

		const resumed = await harness.runtime.resumeGoal();
		expect(resumed.runMode).toBe("awaiting-user-input");
		expect(resumed.goal.currentBlockedState?.id).toBe(block.id);
		await expect(
			harness.runtime.startTarget({
				title: "Start a replacement target",
				desiredFutureClaim: "Replacement target is active.",
				closureStandard: "Replacement target has evidence.",
			}),
		).rejects.toThrow("cannot start target while goal is blocked");

		const recovered = await harness.runtime.recoverBlockedState({
			kind: "target-plan",
			action: "restart_target_planning",
			blockedStateId: block.id,
			stateVersion: resumed.stateVersion,
			parentFrameVersion: resumed.parentFrameVersion,
			targetId,
			targetPlanId: failedPlan.id,
			revision: failedPlan.revision,
			sourceStatus: "failed",
			reason: "user-input",
			guidance: " Complete Warden's Spark after equipping Ember Charm. ",
		});
		const recoveredTarget = recovered.goal.currentTarget;
		const recoveredPlan = recovered.goal.currentTargetPlan;
		if (!recoveredTarget || !recoveredPlan) throw new Error("expected recovered target plan");

		expect(recovered.runMode).toBe("planning-target");
		expect(recoveredTarget.id).toBe(targetId);
		expect(recoveredTarget.status).toBe("active");
		expect(recoveredTarget.planId).toBe(recoveredPlan.id);
		expect(recoveredPlan.id).toBe(`${targetId}-plan-attempt-2`);
		expect(recoveredPlan.planFilePath.endsWith("-plan-attempt-2.md")).toBe(true);
		expect(recoveredPlan.status).toBe("drafting");
		expect(recoveredPlan.revision).toBe(1);
		expect(recoveredPlan.recoveredFrom?.blockedStateId).toBe(block.id);
		expect(recoveredPlan.recoveredFrom?.reason).toBe("user-input");
		expect(recoveredPlan.recoveredFrom?.guidance).toBe("Complete Warden's Spark after equipping Ember Charm.");
		expect(recovered.goal.targetPlans?.find(plan => plan.id === failedPlan.id)?.status).toBe("failed");
		expect(recovered.goal.currentBlockedState).toBeUndefined();
		expect(recovered.goal.recoveryHistory?.some(record => record.blockedStateId === block.id)).toBe(true);

		const newSubmission = buildTargetPlanApprovalInput(recovered);
		expect(() =>
			harness.runtime.validateCurrentTargetPlanSubmission({
				...newSubmission,
				targetPlanId: failedPlan.id,
				revision: failedPlan.revision,
			}),
		).toThrow(`target_plan_id must equal currentTargetPlan.id (${recoveredPlan.id}); got ${failedPlan.id}`);
		expect(() => harness.runtime.validateCurrentTargetPlanSubmission(newSubmission)).not.toThrow();
	});

	it("recovers stale target-plan blocks with a fresh plan attempt", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Recover a stale plan" });
		const planning = await harness.runtime.startTarget({
			title: "Plan went stale",
			desiredFutureClaim: "Stale plan can restart planning.",
			closureStandard: "Fresh plan identity exists.",
		});
		const stalePlan = planning.goal.currentTargetPlan;
		if (!stalePlan) throw new Error("expected stale plan setup");
		const stale = await harness.runtime.rejectCurrentTargetPlan({
			targetPlanId: stalePlan.id,
			revision: stalePlan.revision,
			reviews: [rejectedTargetPlanReview("execution-readiness")],
			message: "target plan review result is stale because goal state changed",
			stage: "stale",
		});
		const target = stale.goal.currentTarget;
		const currentStalePlan = stale.goal.currentTargetPlan;
		const block = stale.goal.currentBlockedState;
		if (!target || !currentStalePlan || !block || block.kind !== "target-plan")
			throw new Error("expected stale target-plan block");
		expect(block.source.status).toBe("stale");

		const recovered = await harness.runtime.recoverBlockedState({
			kind: "target-plan",
			action: "restart_target_planning",
			blockedStateId: block.id,
			stateVersion: stale.stateVersion,
			parentFrameVersion: stale.parentFrameVersion,
			targetId: target.id,
			targetPlanId: currentStalePlan.id,
			revision: currentStalePlan.revision,
			sourceStatus: "stale",
			reason: "state-refresh",
			guidance: "Refresh the stale plan from current state.",
		});

		expect(recovered.runMode).toBe("planning-target");
		expect(recovered.goal.currentTarget?.id).toBe(target.id);
		expect(recovered.goal.currentTargetPlan?.id).toBe(`${target.id}-plan-attempt-2`);
		expect(recovered.goal.currentTargetPlan?.status).toBe("drafting");
		expect(recovered.goal.currentTargetPlan?.revision).toBe(1);
		expect(recovered.goal.currentTargetPlan?.recoveredFrom?.blockedStateId).toBe(block.id);
		expect(recovered.goal.targetPlans?.find(plan => plan.id === currentStalePlan.id)?.status).toBe("stale");
	});

	it("guards blocked-state target-plan recovery identity and state", async () => {
		const wrongModeHarness = createHarness();
		await wrongModeHarness.runtime.createGoal({ objective: "Reject wrong run mode" });
		const planning = await wrongModeHarness.runtime.startTarget({
			title: "Plan still drafting",
			desiredFutureClaim: "Drafting plan cannot recover.",
			closureStandard: "Drafting plan remains pending.",
		});
		const planningTarget = planning.goal.currentTarget;
		const planningPlan = planning.goal.currentTargetPlan;
		if (!planningTarget || !planningPlan) throw new Error("expected planning target");
		await expect(
			wrongModeHarness.runtime.recoverBlockedState({
				kind: "target-plan",
				action: "restart_target_planning",
				blockedStateId: "missing",
				stateVersion: planning.stateVersion,
				parentFrameVersion: planning.parentFrameVersion,
				targetId: planningTarget.id,
				targetPlanId: planningPlan.id,
				revision: planningPlan.revision,
				sourceStatus: "failed",
				reason: "user-input",
				guidance: "Operator answered.",
			}),
		).rejects.toThrow("cannot recover blocked state unless goal is awaiting user input");

		const failedHarness = createHarness();
		await failedHarness.runtime.createGoal({ objective: "Reject stale failed-plan identity" });
		const failedPlanning = await failedHarness.runtime.startTarget({
			title: "Plan failed",
			desiredFutureClaim: "Failed plan awaits user input.",
			closureStandard: "Failed plan can recover with matching identity.",
		});
		const failedTarget = failedPlanning.goal.currentTarget;
		const failedDraft = failedPlanning.goal.currentTargetPlan;
		if (!failedTarget || !failedDraft) throw new Error("expected failed target setup");
		const failed = await failedHarness.runtime.failCurrentTargetPlan({
			targetId: failedTarget.id,
			targetPlanId: failedDraft.id,
			revision: failedDraft.revision,
			reason: "needs-user-input",
			message: "Operator decision required.",
			blockers: ["Missing operator decision."],
			suggestedQuestions: ["Which branch?"],
		});
		const failedPlan = failed.goal.currentTargetPlan;
		const block = failed.goal.currentBlockedState;
		if (!failedPlan || !block || block.kind !== "target-plan") throw new Error("expected failed plan block");
		const recoveryInput = {
			kind: "target-plan" as const,
			action: "restart_target_planning" as const,
			blockedStateId: block.id,
			stateVersion: failed.stateVersion,
			parentFrameVersion: failed.parentFrameVersion,
			targetId: failedTarget.id,
			targetPlanId: failedPlan.id,
			revision: failedPlan.revision,
			sourceStatus: "failed" as const,
			reason: "user-input" as const,
			guidance: "Operator answered.",
		};
		await expect(
			failedHarness.runtime.recoverBlockedState({ ...recoveryInput, blockedStateId: "wrong-block" }),
		).rejects.toThrow(`blocked_state_id must equal currentBlockedState.id (${block.id}); got wrong-block`);
		await expect(
			failedHarness.runtime.recoverBlockedState({
				...recoveryInput,
				action: "start_next_target",
			} as unknown as Parameters<GoalRuntime["recoverBlockedState"]>[0]),
		).rejects.toThrow("blocked state does not allow restart_target_planning");
		await expect(
			failedHarness.runtime.recoverBlockedState({ ...recoveryInput, revision: failedPlan.revision + 1 }),
		).rejects.toThrow(
			`revision must equal currentTargetPlan.revision (${failedPlan.revision}); got ${failedPlan.revision + 1}`,
		);
		await expect(
			failedHarness.runtime.recoverBlockedState({ ...recoveryInput, sourceStatus: "stale" }),
		).rejects.toThrow("source_status must equal currentTargetPlan.status (failed); got stale");
		await expect(failedHarness.runtime.recoverBlockedState({ ...recoveryInput, guidance: "  " })).rejects.toThrow(
			"recover_blocked_state guidance must be non-empty",
		);

		const pendingHarness = createHarness({
			state: {
				...failed,
				goal: { ...failed.goal, pendingCheckpointId: "pending-checkpoint" },
			},
		});
		await expect(pendingHarness.runtime.recoverBlockedState(recoveryInput)).rejects.toThrow(
			"cannot recover target planning while a checkpoint is pending resolution",
		);

		const repairHarness = createHarness({
			state: {
				...failed,
				goal: {
					...failed.goal,
					verificationRepair: {
						verificationAttemptId: "verify-1",
						feedback: "Need fresh evidence.",
						blockers: [],
						evidenceToCollect: [],
						avoidRepeating: [],
						createdAt: 0,
						workEpoch: 0,
					},
				},
			},
		});
		await expect(repairHarness.runtime.recoverBlockedState(recoveryInput)).rejects.toThrow(
			"cannot recover target planning while verifier repair is pending",
		);
	});

	it("recovers checkpoint external pauses through allowed actions", async () => {
		const startHarness = createHarness();
		await startHarness.runtime.createGoal({ objective: "Continue after external checkpoint input" });
		await startApprovedTarget(startHarness, {
			title: "Prove installer smoke",
			desiredFutureClaim: "Installer smoke evidence exists.",
			closureStandard: "Current smoke evidence closes the target.",
		});
		const startCandidate = startHarness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Smoke evidence recorded.",
			localClaims: ["Smoke exercises worker startup"],
			evidence: [
				{ claim: "Smoke exercises worker startup", evidence: "Observed focused smoke output", current: true },
			],
			notClaimed: ["Release is ready"],
			remainingQuestions: ["Which installer surface is next?"],
		});
		const startCommitted = await startHarness.runtime.commitCheckpoint(startCandidate, {
			status: "accepted",
			feedback: "Target closure evidence is bounded and current.",
			evidenceChecked: startCandidate.evidence,
			blockers: [],
			reviewedAt: 10,
		});
		const paused = await startHarness.runtime.recordCheckpointResolution({
			checkpointId: startCandidate.id,
			stateVersion: startCommitted.stateVersion,
			parentFrameVersion: startCommitted.parentFrameVersion,
			decision: "needs_user_input",
			parentReading: "Need operator input before selecting next target.",
			notPropagated: [],
			remainingParentWork: ["Pick next installer surface."],
			broaderChecksOrInputs: ["Operator must choose source-link or tarball."],
			lessonsForFuture: [],
		});
		const block = paused.goal.currentBlockedState;
		if (block?.kind !== "checkpoint-external-pause") throw new Error("expected checkpoint block");
		expect(paused.runMode).toBe("awaiting-user-input");
		expect(paused.goal.pendingCheckpointId).toBeUndefined();

		const recovered = await startHarness.runtime.recoverBlockedState({
			kind: "checkpoint-external-pause",
			action: "start_next_target",
			blockedStateId: block.id,
			stateVersion: paused.stateVersion,
			parentFrameVersion: paused.parentFrameVersion,
			checkpointId: block.source.checkpointId,
			checkpointResolutionId: block.source.checkpointResolutionId,
			reason: "user-input",
			guidance: "Operator selected source-link next.",
			nextTarget: {
				title: "Prove source-link smoke",
				desiredFutureClaim: "Source-link smoke evidence exists.",
				closureStandard: "Current source-link smoke evidence closes the target.",
			},
		});
		expect(recovered.runMode).toBe("planning-target");
		expect(recovered.goal.currentTarget?.createdBy).toBe("checkpoint-resolution");
		expect(recovered.goal.currentTargetPlan?.status).toBe("drafting");
		expect(recovered.goal.currentBlockedState).toBeUndefined();

		const completionHarness = createHarness();
		await completionHarness.runtime.createGoal({ objective: "Complete after external checkpoint input" });
		await startApprovedTarget(completionHarness, {
			title: "Prove release smoke",
			desiredFutureClaim: "Release smoke evidence exists.",
			closureStandard: "Current release smoke evidence closes the target.",
		});
		const completionCandidate = completionHarness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Release evidence recorded.",
			localClaims: ["Release smoke exercises worker startup"],
			evidence: [
				{ claim: "Release smoke exercises worker startup", evidence: "Observed smoke output", current: true },
			],
			notClaimed: ["Release is verified"],
			remainingQuestions: ["Parent verifier should decide."],
		});
		const completionCommitted = await completionHarness.runtime.commitCheckpoint(completionCandidate, {
			status: "accepted",
			feedback: "Target closure evidence is bounded and current.",
			evidenceChecked: completionCandidate.evidence,
			blockers: [],
			reviewedAt: 20,
		});
		const completionPaused = await completionHarness.runtime.recordCheckpointResolution({
			checkpointId: completionCandidate.id,
			stateVersion: completionCommitted.stateVersion,
			parentFrameVersion: completionCommitted.parentFrameVersion,
			decision: "needs_user_input",
			parentReading: "Need operator input before parent completion.",
			notPropagated: [],
			remainingParentWork: ["Operator must approve parent completion attempt."],
			broaderChecksOrInputs: [],
			lessonsForFuture: [],
		});
		const completionBlock = completionPaused.goal.currentBlockedState;
		if (completionBlock?.kind !== "checkpoint-external-pause")
			throw new Error("expected completion checkpoint block");
		const parentReady = await completionHarness.runtime.recoverBlockedState({
			kind: "checkpoint-external-pause",
			action: "enter_parent_completion",
			blockedStateId: completionBlock.id,
			stateVersion: completionPaused.stateVersion,
			parentFrameVersion: completionPaused.parentFrameVersion,
			checkpointId: completionBlock.source.checkpointId,
			checkpointResolutionId: completionBlock.source.checkpointResolutionId,
			reason: "user-input",
			guidance: "Operator approved parent completion verification.",
		});
		expect(parentReady.runMode).toBe("awaiting-parent-completion");
		expect(parentReady.goal.currentBlockedState).toBeUndefined();
	});

	it("normalizes legacy awaiting-user-input states into blocked states", () => {
		const target = {
			id: "target-1",
			sequence: 1,
			status: "active" as const,
			title: "Recover target",
			desiredFutureClaim: "Target plan recovers.",
			closureStandard: "Recovered plan exists.",
			baselineRefs: [],
			gateRefs: [],
			evidenceExpectation: [],
			nonGoals: [],
			forbiddenClaims: [],
			staleIf: [],
			createdAt: 0,
			planId: "target-1-plan",
			createdBy: "initial" as const,
		};
		const failedPlan = {
			id: "target-1-plan",
			goalId: "goal-1",
			targetId: "target-1",
			targetSequence: 1,
			planFilePath: "local://target-plan.md",
			status: "failed" as const,
			revision: 1,
			stateVersionAtStart: 1,
			parentFrameVersionAtStart: 0,
			createdAt: 0,
			updatedAt: 0,
			failedAt: 0,
			failure: {
				stage: "draft" as const,
				reason: "needs-user-input" as const,
				message: "Need user input.",
				blockers: ["Need answer."],
				suggestedQuestions: ["Answer?"],
				at: 0,
			},
			reviews: [],
		};
		const failedState = parseGoalModeState({
			enabled: true,
			mode: "active",
			runMode: "awaiting-user-input",
			stateVersion: 2,
			parentFrameVersion: 0,
			goal: createGoal({
				currentTarget: target,
				targets: [target],
				currentTargetPlan: failedPlan,
				targetPlans: [failedPlan],
			}),
		});
		expect(failedState?.goal.currentBlockedState?.kind).toBe("target-plan");
		expect(failedState?.goal.currentBlockedState?.allowedActions).toEqual(["restart_target_planning"]);

		const checkpointState = parseGoalModeState({
			enabled: true,
			mode: "active",
			runMode: "awaiting-user-input",
			stateVersion: 3,
			parentFrameVersion: 0,
			goal: createGoal({
				checkpointResolutions: [
					{
						id: "resolution-1",
						sequence: 1,
						goalId: "goal-1",
						checkpointId: "checkpoint-1",
						decision: "needs_user_input",
						parentReading: "Need input.",
						notPropagated: [],
						remainingParentWork: ["Choose next target."],
						broaderChecksOrInputs: [],
						lessonsForFuture: [],
						createdAt: 0,
					},
				],
				lastCheckpointResolutionId: "resolution-1",
			}),
		});
		expect(checkpointState?.goal.currentBlockedState?.kind).toBe("checkpoint-external-pause");
		expect(checkpointState?.goal.currentBlockedState?.allowedActions).toEqual([
			"start_next_target",
			"enter_parent_completion",
		]);

		const ambiguousState = parseGoalModeState({
			enabled: true,
			mode: "active",
			runMode: "awaiting-user-input",
			stateVersion: 4,
			parentFrameVersion: 0,
			goal: createGoal(),
		});
		expect(ambiguousState?.goal.currentBlockedState?.kind).toBe("operator-input-required");
		expect(ambiguousState?.goal.currentBlockedState?.allowedActions).toEqual([]);
	});

	it("does not let stale target-plan reviews discard a newer revision", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		const planning = await harness.runtime.startTarget({
			title: "Prove installer smoke",
			desiredFutureClaim: "Installer smoke exercises worker startup.",
			closureStandard: "Focused smoke evidence exists.",
		});
		const plan = planning.goal.currentTargetPlan;
		if (!plan) throw new Error("expected target plan");

		const revised = await harness.runtime.rejectCurrentTargetPlan({
			targetPlanId: plan.id,
			revision: plan.revision,
			reviews: [rejectedTargetPlanReview("aperture")],
			message: "target plan reviewer rejected the submission",
			stage: "review",
		});
		const stale = await harness.runtime.rejectCurrentTargetPlan({
			targetPlanId: plan.id,
			revision: plan.revision,
			reviews: [rejectedTargetPlanReview("execution-readiness")],
			message: "target plan review result is stale because goal state changed",
			stage: "stale",
		});

		expect(revised.goal.currentTargetPlan?.revision).toBe(plan.revision + 1);
		expect(stale.runMode).toBe("planning-target");
		expect(stale.goal.currentTargetPlan?.status).toBe("revision-required");
		expect(stale.goal.currentTargetPlan?.revision).toBe(plan.revision + 1);
	});

	it("starts a target and commits an accepted checkpoint without completing the parent goal", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		const targeted = await startApprovedTarget(harness, {
			title: "Prove installer smoke fails on worker startup breakage",
			desiredFutureClaim: "Installer smoke exercises worker startup.",
			closureStandard: "Focused smoke evidence exists.",
			nonGoals: ["full release readiness"],
			forbiddenClaims: ["CI is green"],
			staleIf: ["installer script changes"],
		});
		const candidate = harness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Smoke evidence recorded.",
			localClaims: ["Smoke exercises worker startup"],
			evidence: [
				{
					claim: "Smoke exercises worker startup",
					evidence: "Observed focused smoke output",
					current: true,
				},
			],
			notClaimed: ["Release is ready"],
			remainingQuestions: ["Which installer surface is next?"],
		});

		const committed = await harness.runtime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Target closure evidence is bounded and current.",
			evidenceChecked: candidate.evidence,
			blockers: [],
			reviewedAt: 10,
		});

		expect(targeted.runMode).toBe("working-target");
		expect(candidate.notClaimed).toContain("Parent goal complete");
		expect(committed.goal.status).toBe("active");
		expect(committed.runMode).toBe("awaiting-checkpoint-resolution");
		expect(committed.goal.pendingCheckpointId).toBe(candidate.id);
		expect(committed.goal.currentTarget?.status).toBe("closed");
		expect(committed.goal.checkpoints?.[0]?.targetSnapshot.status).toBe("closed");
	});

	it("rejects checkpoint candidates without positive current evidence", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		await startApprovedTarget(harness, {
			title: "Prove installer smoke",
			desiredFutureClaim: "Installer smoke exercises worker startup.",
			closureStandard: "Focused smoke evidence exists.",
		});

		expect(() =>
			harness.runtime.buildCheckpointCandidate({
				status: "closed_with_evidence",
				summary: "No current evidence.",
				localClaims: ["Smoke exercises worker startup"],
				evidence: [{ claim: "Smoke exercises worker startup", evidence: "Old transcript", current: false }],
				notClaimed: ["Release is ready"],
				remainingQuestions: ["What next?"],
			}),
		).toThrow("checkpoint requires positive current evidence");
	});

	it("rejected checkpoints keep the current target active and focus repair", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		await startApprovedTarget(harness, {
			title: "Prove installer smoke",
			desiredFutureClaim: "Installer smoke exercises worker startup.",
			closureStandard: "Focused smoke evidence exists.",
		});
		const candidate = harness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Evidence is weak.",
			localClaims: ["Smoke exercises worker startup"],
			evidence: [{ claim: "Smoke exercises worker startup", evidence: "A file changed", current: true }],
			notClaimed: ["Release is ready"],
			remainingQuestions: ["What next?"],
		});

		const rejected = await harness.runtime.rejectCheckpoint(candidate, {
			status: "rejected",
			feedback: "Evidence does not satisfy the closure standard.",
			evidenceChecked: candidate.evidence,
			blockers: [
				{
					id: "smoke-output",
					severity: "blocking",
					problem: "No smoke command output.",
					requiredEvidenceOrFix: "Run the focused smoke command.",
				},
			],
			reviewedAt: 10,
		});

		expect(rejected.runMode).toBe("working-target");
		expect(rejected.goal.currentTarget?.status).toBe("active");
		expect(rejected.goal.lastCheckpointRejection?.review.blockers[0]?.id).toBe("smoke-output");
	});

	it("resolves checkpoints with explicit parent delta and next target atomically", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({
			objective: "Improve release reliability",
			parentFrame: createParentFrame({
				kind: "claim-gated",
				desiredFuture: "Release truth is explicit",
				gates: [
					{
						id: "install-smoke",
						name: "Install smoke",
						status: "unknown",
						requiredEvidence: ["smoke output"],
					},
				],
			}),
		});
		const activeState = harness.getState();
		if (!activeState) throw new Error("expected goal state");
		await harness.runtime.setGoalRubric(activeState.goal.id, "Verifier-only rubric", [
			{ id: "D1", summary: "Source-link smoke.", status: "pending" },
			{ id: "D2", summary: "Tarball smoke.", status: "pending" },
		]);
		await startApprovedTarget(harness, {
			title: "Prove source-link smoke",
			desiredFutureClaim: "Source-link install exercises smoke path.",
			closureStandard: "Smoke output is observed.",
			gateRefs: ["install-smoke"],
			parentDeliverableIds: ["D1"],
		});
		const candidate = harness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Source-link smoke passed.",
			localClaims: ["Source-link install exercises smoke path"],
			evidence: [
				{
					claim: "Source-link install exercises smoke path",
					evidence: "Observed smoke output",
					current: true,
				},
			],
			notClaimed: ["Tarball path is verified"],
			remainingQuestions: ["Check tarball path next?"],
		});
		const committed = await harness.runtime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Closed locally.",
			evidenceChecked: candidate.evidence,
			blockers: [],
			reviewedAt: 20,
		});

		const resolved = await harness.runtime.recordCheckpointResolution({
			checkpointId: committed.goal.pendingCheckpointId ?? "",
			stateVersion: committed.stateVersion,
			parentFrameVersion: committed.parentFrameVersion,
			decision: "next_target",
			parentReading: "Local smoke claim accepted; tarball path remains open.",
			parentDelta: {
				admittedClaims: [
					{
						id: "source-link-smoke",
						claim: "Source-link install exercises smoke path.",
						status: "accepted",
						evidenceRefs: [{ id: `checkpoint:${candidate.id}`, kind: "artifact" }],
						nonImplications: ["Tarball path is verified"],
					},
				],
				candidateClaimsAdded: [],
				rejectedClaims: [],
				boundariesAdded: [
					{
						id: "source-link-not-tarball",
						kind: "forbidden-inference",
						statement: "Source-link smoke does not prove tarball install.",
					},
				],
				residualsAddedOrUpdated: [
					{
						id: "tarball-smoke",
						statement: "Tarball smoke needs equivalent evidence.",
						classification: "current-parent-blocker",
					},
				],
				gateDeltas: [{ gateId: "install-smoke", status: "passed" }],
				frontierDeltas: [{ id: "tarball-frontier", statement: "Tarball smoke is next." }],
				staleRefs: [],
				externalRecordRefs: [{ id: "release-record", kind: "external-record", uri: "release://current" }],
				deliverableDeltas: [
					{
						id: "D1",
						status: "satisfied",
						evidenceRefs: [{ id: `checkpoint:${candidate.id}`, kind: "artifact" }],
						nextRelevantTarget: "Prove tarball smoke",
					},
				],
			},
			notPropagated: ["Tarball path is verified"],
			remainingParentWork: ["Tarball install evidence"],
			nextTarget: {
				title: "Prove tarball smoke",
				desiredFutureClaim: "Tarball installs exercise smoke path.",
				closureStandard: "Tarball smoke output is observed.",
				forbiddenClaims: ["Release is ready"],
				parentDeliverableIds: ["D2"],
			},
		});

		expect(resolved.runMode).toBe("planning-target");
		expect(resolved.goal.pendingCheckpointId).toBeUndefined();
		expect(resolved.parentFrameVersion).toBe(committed.parentFrameVersion + 1);
		expect(resolved.goal.parentFrame?.acceptedClaims[0]?.id).toBe("source-link-smoke");
		expect(resolved.goal.parentFrame?.gates[0]?.status).toBe("passed");
		expect(resolved.goal.deliverableMap?.find(item => item.id === "D1")?.status).toBe("satisfied");
		expect(resolved.goal.currentTarget?.parentDeliverableIds).toEqual(["D2"]);
		expect(resolved.goal.currentTarget?.title).toBe("Prove tarball smoke");
		expect(resolved.goal.currentTarget?.parentFrameVersion).toBe(resolved.parentFrameVersion);
	});

	it("updates deliverable map without bumping parent frame version when no frame fields change", async () => {
		const harness = createHarness();
		const created = await harness.runtime.createGoal({
			objective: "Improve release reliability",
			parentFrame: createParentFrame({ desiredFuture: "Release truth is explicit" }),
		});
		await harness.runtime.setGoalRubric(created.goal.id, "Verifier-only rubric", [
			{ id: "D1", summary: "Source-link smoke.", status: "pending" },
			{ id: "D2", summary: "Tarball smoke.", status: "pending" },
		]);
		await startApprovedTarget(harness, {
			title: "Prove source-link smoke",
			desiredFutureClaim: "Source-link smoke evidence exists.",
			closureStandard: "Current smoke output is observed.",
			parentDeliverableIds: ["D1"],
		});
		const candidate = harness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Source-link smoke passed.",
			localClaims: ["Source-link smoke evidence exists."],
			evidence: [{ claim: "Source-link smoke evidence exists.", evidence: "Observed smoke output", current: true }],
			notClaimed: ["Tarball smoke is proven."],
			remainingQuestions: ["Check tarball path next?"],
		});
		const committed = await harness.runtime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Closed locally.",
			evidenceChecked: candidate.evidence,
			blockers: [],
			reviewedAt: 20,
		});

		const resolved = await harness.runtime.recordCheckpointResolution({
			checkpointId: committed.goal.pendingCheckpointId ?? "",
			stateVersion: committed.stateVersion,
			parentFrameVersion: committed.parentFrameVersion,
			decision: "next_target",
			parentReading: "Only the compact deliverable status changes; parent frame claims remain unchanged.",
			parentDelta: {
				admittedClaims: [],
				candidateClaimsAdded: [],
				rejectedClaims: [],
				boundariesAdded: [],
				residualsAddedOrUpdated: [],
				gateDeltas: [],
				frontierDeltas: [],
				staleRefs: [],
				externalRecordRefs: [],
				deliverableDeltas: [
					{
						id: "D1",
						status: "partial",
						evidenceRefs: [{ id: `checkpoint:${candidate.id}`, kind: "artifact" }],
						nextRelevantTarget: "Prove tarball smoke",
					},
				],
			},
			notPropagated: ["Tarball smoke is proven."],
			remainingParentWork: ["Tarball install evidence"],
			nextTarget: {
				title: "Prove tarball smoke",
				desiredFutureClaim: "Tarball smoke evidence exists.",
				closureStandard: "Current tarball smoke output is observed.",
				parentDeliverableIds: ["D2"],
			},
		});

		expect(resolved.parentFrameVersion).toBe(committed.parentFrameVersion);
		expect(resolved.goal.parentFrame?.lastParentDeltaId).toBeUndefined();
		expect(resolved.goal.deliverableMap?.find(item => item.id === "D1")?.status).toBe("partial");
		expect(resolved.goal.deliverableMap?.find(item => item.id === "D1")?.evidenceRefs?.[0]?.id).toBe(
			`checkpoint:${candidate.id}`,
		);
		expect(resolved.goal.currentTarget?.parentDeliverableIds).toEqual(["D2"]);
		expect(resolved.goal.currentTarget?.parentFrameVersion).toBe(committed.parentFrameVersion);
	});

	it("resolving a checkpoint to user input keeps continuation suppressed", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		await startApprovedTarget(harness, {
			title: "Prove source-link smoke",
			desiredFutureClaim: "Source-link install exercises smoke path.",
			closureStandard: "Smoke output is observed.",
		});
		const candidate = harness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Source-link smoke passed.",
			localClaims: ["Source-link install exercises smoke path"],
			evidence: [
				{
					claim: "Source-link install exercises smoke path",
					evidence: "Observed smoke output",
					current: true,
				},
			],
			notClaimed: ["Release is ready"],
			remainingQuestions: ["Need operator decision."],
		});
		const committed = await harness.runtime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Closed locally.",
			evidenceChecked: candidate.evidence,
			blockers: [],
			reviewedAt: 20,
		});

		const checkpointId = committed.goal.pendingCheckpointId ?? "";
		const resolved = await harness.runtime.recordCheckpointResolution({
			checkpointId,
			stateVersion: committed.stateVersion,
			parentFrameVersion: committed.parentFrameVersion,
			decision: "needs_user_input",
			parentReading: "Operator must choose next gate.",
			notPropagated: ["Next target selected"],
			remainingParentWork: ["Choose next gate"],
			broaderChecksOrInputs: ["Ask operator which install surface to verify next."],
		});

		expect(resolved.runMode).toBe("awaiting-user-input");
		expect(resolved.goal.pendingCheckpointId).toBeUndefined();
		const block = resolved.goal.currentBlockedState;
		if (block?.kind !== "checkpoint-external-pause") {
			throw new Error("expected checkpoint external-pause blocked state");
		}
		await expect(
			harness.runtime.recordCheckpointResolution({
				checkpointId,
				stateVersion: resolved.stateVersion,
				parentFrameVersion: resolved.parentFrameVersion,
				decision: "needs_user_input",
				parentReading: "Duplicate resolution should fail.",
				notPropagated: [],
				remainingParentWork: ["Duplicate resolution should fail."],
			}),
		).rejects.toThrow("cannot resolve checkpoint because no checkpoint is pending");
		await expect(harness.runtime.completeGoalFromTool()).rejects.toThrow(
			"cannot complete parent goal while awaiting user input or external authority",
		);
		const recovered = await harness.runtime.recoverBlockedState({
			kind: "checkpoint-external-pause",
			action: "start_next_target",
			blockedStateId: block.id,
			stateVersion: resolved.stateVersion,
			parentFrameVersion: resolved.parentFrameVersion,
			checkpointId: block.source.checkpointId,
			checkpointResolutionId: block.source.checkpointResolutionId,
			reason: "user-input",
			guidance: "Operator chose the next release gate.",
			nextTarget: {
				title: "Choose next gate",
				desiredFutureClaim: "Next release gate has selected evidence.",
				closureStandard: "Current selected-gate evidence exists.",
			},
		});
		const next = await approveTargetPlan(harness, recovered);
		expect(next.runMode).toBe("working-target");
	});

	it("clears pending checkpoint for non-continuing checkpoint resolutions", async () => {
		const decisions = ["needs_broader_checks", "pause_for_external_control", "drop_or_replace_recommended"] as const;
		for (const decision of decisions) {
			const harness = createHarness();
			await harness.runtime.createGoal({ objective: `Resolve ${decision}` });
			await startApprovedTarget(harness, {
				title: `Close ${decision}`,
				desiredFutureClaim: "Checkpoint evidence is bounded.",
				closureStandard: "Current checkpoint evidence is recorded.",
			});
			const candidate = harness.runtime.buildCheckpointCandidate({
				status: "closed_with_evidence",
				summary: "Bounded evidence exists.",
				localClaims: ["Checkpoint evidence is bounded"],
				evidence: [{ claim: "Checkpoint evidence is bounded", evidence: "Observed evidence", current: true }],
				notClaimed: ["Parent goal is complete"],
				remainingQuestions: ["Which controller action follows?"],
			});
			const committed = await harness.runtime.commitCheckpoint(candidate, {
				status: "accepted",
				feedback: "Closed locally.",
				evidenceChecked: candidate.evidence,
				blockers: [],
				reviewedAt: 20,
			});
			const checkpointId = committed.goal.pendingCheckpointId ?? "";

			const resolved = await harness.runtime.recordCheckpointResolution({
				checkpointId,
				stateVersion: committed.stateVersion,
				parentFrameVersion: committed.parentFrameVersion,
				decision,
				parentReading: "Controller cannot continue automatically.",
				notPropagated: ["Parent goal complete"],
				remainingParentWork: ["Continue parent work"],
				broaderChecksOrInputs: decision === "needs_broader_checks" ? ["Run broader checks."] : [],
			});

			expect(resolved.runMode).toBe("awaiting-user-input");
			expect(resolved.goal.pendingCheckpointId).toBeUndefined();
			await expect(
				harness.runtime.recordCheckpointResolution({
					checkpointId,
					stateVersion: resolved.stateVersion,
					parentFrameVersion: resolved.parentFrameVersion,
					decision,
					parentReading: "Duplicate resolution should fail.",
					notPropagated: [],
					remainingParentWork: ["Duplicate resolution should fail."],
				}),
			).rejects.toThrow("cannot resolve checkpoint because no checkpoint is pending");
		}
	});

	it("blocks parent completion across pending checkpoints and verifier repair", async () => {
		const harness = createHarness();
		const created = await harness.runtime.createGoal({ objective: "Improve release reliability" });
		await startApprovedTarget(harness, {
			title: "Prove source-link smoke",
			desiredFutureClaim: "Source-link install exercises smoke path.",
			closureStandard: "Smoke output is observed.",
		});
		const candidate = harness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Source-link smoke passed.",
			localClaims: ["Source-link install exercises smoke path"],
			evidence: [
				{
					claim: "Source-link install exercises smoke path",
					evidence: "Observed smoke output",
					current: true,
				},
			],
			notClaimed: ["Release is ready"],
			remainingQuestions: ["Need parent resolution."],
		});
		const committed = await harness.runtime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Closed locally.",
			evidenceChecked: candidate.evidence,
			blockers: [],
			reviewedAt: 20,
		});
		await expect(harness.runtime.completeGoalFromTool()).rejects.toThrow("checkpoint is pending resolution");
		const parentCandidate = await harness.runtime.recordCheckpointResolution({
			checkpointId: candidate.id,
			stateVersion: committed.stateVersion,
			parentFrameVersion: committed.parentFrameVersion,
			decision: "parent_completion_candidate",
			parentReading: "Parent might be complete; verifier must decide.",
			notPropagated: ["Parent goal complete"],
			remainingParentWork: ["Independent verifier acceptance"],
		});
		expect(parentCandidate.runMode).toBe("awaiting-parent-completion");
		await expect(
			harness.runtime.startTarget({
				title: "Do more work before verification",
				desiredFutureClaim: "More work is done.",
				closureStandard: "More work exists.",
			}),
		).rejects.toThrow("parent_completion_candidate");
		await harness.runtime.recordFailedCompletionVerification(created.goal.id, "Missing tarball evidence", {
			structuredFeedback: {
				summary: "Missing evidence",
				score: 2,
				deliverableResults: [],
				evidenceChecked: [],
				completionBlockers: [
					{
						id: "tarball-evidence",
						severity: "blocking",
						problem: "Tarball install evidence missing.",
						requiredEvidenceOrFix: "Run tarball install smoke.",
					},
				],
				continuationFocus: {
					openGaps: ["tarball-evidence"],
					nextActions: ["Run tarball install smoke."],
					evidenceToCollect: ["tarball install smoke output"],
					avoidRepeating: ["Do not cite source-link smoke as tarball evidence."],
				},
			},
		});
		expect(harness.getState()?.runMode).toBe("awaiting-verification-repair");
		await expect(harness.runtime.completeGoalFromTool()).rejects.toThrow("verifier blockers");
		await harness.runtime.onToolCompleted("read");
		expect(harness.getState()?.goal.verificationRepair?.feedback).toBe("Missing tarball evidence");
		expect(harness.getState()?.runMode).toBe("awaiting-verification-repair");

		await expect(
			harness.runtime.startTarget({
				title: "Repair stale blocker",
				desiredFutureClaim: "Stale blocker evidence is current.",
				closureStandard: "Current evidence is recorded.",
				linkedVerifierBlockerIds: ["old-tarball-evidence"],
			}),
		).rejects.toThrow("stale verifier blocker ids");
		await startApprovedTarget(harness, {
			title: "Repair tarball evidence",
			desiredFutureClaim: "Tarball install evidence is current.",
			closureStandard: "A current tarball install smoke result is recorded.",
			linkedVerifierBlockerIds: ["tarball-evidence"],
		});
		const repairCandidate = harness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Tarball smoke evidence was collected.",
			localClaims: ["Tarball install evidence is current"],
			evidence: [
				{ claim: "Tarball install evidence is current", evidence: "Observed tarball smoke output", current: true },
			],
			notClaimed: ["Parent goal is complete"],
			remainingQuestions: ["Can parent completion be retried?"],
		});
		const repaired = await harness.runtime.commitCheckpoint(repairCandidate, {
			status: "accepted",
			feedback: "Repair target closed with evidence.",
			evidenceChecked: repairCandidate.evidence,
			blockers: [],
			reviewedAt: 20,
		});
		expect(repaired.goal.verificationRepair).toBeUndefined();
		expect(repaired.goal.failedCompletionAttempts).toBeUndefined();
		expect(repaired.runMode).toBe("awaiting-checkpoint-resolution");
	});

	it("keeps verifier repair open until every current blocker has repair evidence", async () => {
		const harness = createHarness();
		const created = await harness.runtime.createGoal({ objective: "Improve release reliability" });
		await harness.runtime.recordFailedCompletionVerification(created.goal.id, "Missing release evidence", {
			structuredFeedback: {
				summary: "Missing evidence",
				score: 2,
				deliverableResults: [],
				evidenceChecked: [],
				completionBlockers: [
					{
						id: "source-evidence",
						severity: "blocking",
						problem: "Source install evidence missing.",
						requiredEvidenceOrFix: "Run source install smoke.",
					},
					{
						id: "tarball-evidence",
						severity: "blocking",
						problem: "Tarball install evidence missing.",
						requiredEvidenceOrFix: "Run tarball install smoke.",
					},
				],
			},
		});
		const repairAttemptId = harness.getState()?.goal.verificationRepair?.verificationAttemptId;
		if (!repairAttemptId) throw new Error("expected repair attempt id");

		await startApprovedTarget(harness, {
			title: "Repair source evidence",
			desiredFutureClaim: "Source install evidence is current.",
			closureStandard: "A current source install smoke result is recorded.",
			linkedVerifierBlockerIds: ["source-evidence"],
		});
		const repairCandidate = harness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Source smoke evidence was collected.",
			localClaims: ["Source install evidence is current"],
			evidence: [
				{ claim: "Source install evidence is current", evidence: "Observed source smoke output", current: true },
			],
			notClaimed: ["Parent goal is complete"],
			remainingQuestions: ["Which verifier blocker remains?"],
		});
		const partiallyRepaired = await harness.runtime.commitCheckpoint(repairCandidate, {
			status: "accepted",
			feedback: "One repair target closed with evidence.",
			evidenceChecked: repairCandidate.evidence,
			blockers: [],
			reviewedAt: 20,
		});
		expect(partiallyRepaired.goal.failedCompletionAttempts).toBe(1);
		expect(partiallyRepaired.goal.verificationRepair?.blockers.map(blocker => blocker.id)).toEqual([
			"tarball-evidence",
		]);
		await expect(
			harness.runtime.recordCheckpointResolution({
				checkpointId: repairCandidate.id,
				stateVersion: partiallyRepaired.stateVersion,
				parentFrameVersion: partiallyRepaired.parentFrameVersion,
				decision: "parent_completion_candidate",
				parentReading: "Only one blocker was repaired.",
				notPropagated: ["Parent goal is complete"],
				remainingParentWork: ["Repair tarball blocker"],
			}),
		).rejects.toThrow("verifier blockers have fresh repair evidence");
		const nextRepair = await harness.runtime.recordCheckpointResolution({
			checkpointId: repairCandidate.id,
			stateVersion: partiallyRepaired.stateVersion,
			parentFrameVersion: partiallyRepaired.parentFrameVersion,
			decision: "next_target",
			parentReading: "Tarball blocker still needs repair.",
			notPropagated: ["Parent goal is complete"],
			remainingParentWork: ["Repair tarball blocker"],
			nextTarget: {
				title: "Repair tarball evidence",
				desiredFutureClaim: "Tarball install evidence is current.",
				closureStandard: "A current tarball install smoke result is recorded.",
				linkedVerifierBlockerIds: ["tarball-evidence"],
			},
		});
		expect(nextRepair.goal.currentTarget?.createdFromVerificationAttemptId).toBe(repairAttemptId);
	});

	it("rejects stale side-agent output when state, target, checkpoint, or parent frame changes", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({
			objective: "Improve release reliability",
			parentFrame: createParentFrame({ kind: "claim-gated", desiredFuture: "Release truth is explicit" }),
		});
		const initialExpectation = harness.runtime.captureSideAgentExpectation({ includeParentFrame: true });
		await harness.runtime.recordExternalUsage(createUsage({ input: 1 }), 1_000);
		expect(harness.runtime.canCommitSideAgentResult(initialExpectation)).toBe(true);

		await startApprovedTarget(harness, {
			title: "Prove source-link smoke",
			desiredFutureClaim: "Source-link install exercises smoke path.",
			closureStandard: "Smoke output is observed.",
		});
		expect(harness.runtime.canCommitSideAgentResult(initialExpectation)).toBe(false);
		const targetExpectation = harness.runtime.captureSideAgentExpectation({ includeParentFrame: true });
		const candidate = harness.runtime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Source-link smoke passed.",
			localClaims: ["Source-link install exercises smoke path"],
			evidence: [
				{
					claim: "Source-link install exercises smoke path",
					evidence: "Observed smoke output",
					current: true,
				},
			],
			notClaimed: ["Release is ready"],
			remainingQuestions: ["Need parent resolution."],
		});
		const committed = await harness.runtime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Closed locally.",
			evidenceChecked: candidate.evidence,
			blockers: [],
			reviewedAt: 20,
		});
		expect(harness.runtime.canCommitSideAgentResult(targetExpectation)).toBe(false);
		const checkpointExpectation = harness.runtime.captureSideAgentExpectation({ includeParentFrame: true });
		await harness.runtime.recordCheckpointResolution({
			checkpointId: candidate.id,
			stateVersion: committed.stateVersion,
			parentFrameVersion: committed.parentFrameVersion,
			decision: "parent_completion_candidate",
			parentReading: "Accept one parent delta.",
			parentDelta: {
				admittedClaims: [{ id: "source-link-smoke", claim: "Source-link smoke passed.", status: "accepted" }],
				candidateClaimsAdded: [],
				rejectedClaims: [],
				boundariesAdded: [],
				residualsAddedOrUpdated: [],
				gateDeltas: [],
				frontierDeltas: [],
				staleRefs: [],
				externalRecordRefs: [],
			},
			notPropagated: ["Release ready"],
			remainingParentWork: ["Verifier acceptance"],
		});
		expect(harness.runtime.canCommitSideAgentResult(checkpointExpectation)).toBe(false);
	});

	it("renders prompt guardrails for checkpoint, parent-completion, and verifier-repair run modes", () => {
		const goal = createGoal({ objective: "Improve release reliability", rubric: "Do the whole goal." });
		const checkpointState = createGoalModeState({
			goal: createGoal({
				...goal,
				pendingCheckpointId: "checkpoint-1",
			}),
			runMode: "awaiting-checkpoint-resolution",
		});
		const parentCompletionState = createGoalModeState({
			goal,
			runMode: "awaiting-parent-completion",
		});
		const repairState = createGoalModeState({
			goal: createGoal({
				...goal,
				verificationRepair: {
					verificationAttemptId: "attempt-1",
					feedback: "Missing current evidence.",
					blockers: [
						{
							id: "B1",
							severity: "blocking",
							problem: "Missing current evidence.",
							requiredEvidenceOrFix: "Run focused verification.",
						},
					],
					evidenceToCollect: ["current evidence"],
					avoidRepeating: ["old evidence"],
					createdAt: 0,
					workEpoch: 0,
				},
			}),
			runMode: "awaiting-verification-repair",
		});

		expect(renderGoalPrompt("active", goal, createGoalModeState({ goal }))).toContain("start_target");
		expect(renderGoalPrompt("continuation", checkpointState.goal, checkpointState)).toContain("resolve_checkpoint");
		expect(renderGoalPrompt("continuation", parentCompletionState.goal, parentCompletionState)).toContain(
			'Call `goal({op:"complete"})`; do not resume implementation.',
		);
		const repairPrompt = renderGoalPrompt("continuation", repairState.goal, repairState);
		expect(repairPrompt).toContain("Do not retry `complete` without fresh evidence");
		expect(repairPrompt).toContain("B1");
		expect(repairPrompt).toContain("Run focused verification.");
		expect(systemPromptTemplate).toContain("Goal Mode target closed?");
		expect(systemPromptTemplate).toContain("it is not parent completion");
	});
});
