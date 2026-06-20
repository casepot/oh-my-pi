import { describe, expect, it } from "bun:test";
import {
	buildGoalContextSurface,
	escapeXmlText,
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

function acceptedTargetPlanReview(lens: GoalTargetPlanReview["lens"]): GoalTargetPlanReview {
	return {
		id: `review-${lens}`,
		lens,
		status: "accepted",
		feedback: `${lens} accepted the target plan.`,
		apertureClassification: lens === "aperture" ? "right-sized" : undefined,
		revisionDecision: "keep",
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
	};
}

function rejectedTargetPlanReview(lens: GoalTargetPlanReview["lens"]): GoalTargetPlanReview {
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
	};
}

function buildTargetPlanApprovalInput(state: GoalModeState): GoalTargetPlanApprovalInput {
	const target = state.goal.currentTarget;
	const plan = state.goal.currentTargetPlan;
	if (!target || !plan) throw new Error("expected current target plan");
	return {
		targetId: target.id,
		targetPlanId: plan.id,
		planFilePath: plan.planFilePath,
		revision: plan.revision,
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
			{ branch: "happy path", required: true, plannedSignalIds: ["signal-primary"], rationale: "Primary signal." },
		],
		excludedWorkReview: [
			{ item: "Parent completion", classification: "parent-non-claim", rationale: "Checkpoint is bounded." },
		],
		workflowReviewRounds: [
			{ lens: "adversarial", verdict: "accepted", summary: "No blockers.", blockers: [], revised: false },
		],
		dryRun: { status: "passed", checks: [{ id: "dry-run", passed: true, rationale: "Plan steps are executable." }] },
		reviews: [acceptedTargetPlanReview("aperture"), acceptedTargetPlanReview("execution-readiness")],
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

describe("goal runtime", () => {
	it("counts cache writes but ignores cache reads in token deltas", () => {
		expect(
			goalTokenDelta(
				createUsage({ input: 13, output: 6, cacheRead: 999, cacheWrite: 8 }),
				createUsage({ input: 10, output: 4, cacheRead: 1, cacheWrite: 5 }),
			),
		).toBe(8);
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
		await startApprovedTarget(harness, {
			title: "Prove source-link smoke",
			desiredFutureClaim: "Source-link install exercises smoke path.",
			closureStandard: "Smoke output is observed.",
			parentDeliverableIds: ["D1"],
		});
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
		expect(renderGoalPrompt("continuation", planning.goal, planning)).toContain(
			"Draft/revise the current target plan",
		);
		expect(renderGoalPrompt("continuation", planning.goal, planning)).toContain("submit_target_plan");
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
		expect(approved.goal.currentTarget?.verificationSignals?.[0]?.id).toBe("signal-primary");
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
			decision: "needs_user_input",
			parentReading: "Operator must choose next gate.",
			notPropagated: ["Next target selected"],
			remainingParentWork: ["Choose next gate"],
			broaderChecksOrInputs: ["Ask operator which install surface to verify next."],
		});

		expect(resolved.runMode).toBe("awaiting-user-input");
		expect(resolved.goal.pendingCheckpointId).toBeUndefined();
		await expect(
			harness.runtime.recordCheckpointResolution({
				checkpointId,
				decision: "needs_user_input",
				parentReading: "Duplicate resolution should fail.",
				notPropagated: [],
				remainingParentWork: ["Duplicate resolution should fail."],
			}),
		).rejects.toThrow("cannot resolve checkpoint because no checkpoint is pending");
		await expect(harness.runtime.completeGoalFromTool()).rejects.toThrow(
			"cannot complete parent goal while awaiting user input or external authority",
		);
		const next = await startApprovedTarget(harness, {
			title: "Choose next gate",
			desiredFutureClaim: "Next release gate has selected evidence.",
			closureStandard: "Current selected-gate evidence exists.",
		});
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
		await harness.runtime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Closed locally.",
			evidenceChecked: candidate.evidence,
			blockers: [],
			reviewedAt: 20,
		});
		await expect(harness.runtime.completeGoalFromTool()).rejects.toThrow("checkpoint is pending resolution");
		const parentCandidate = await harness.runtime.recordCheckpointResolution({
			checkpointId: candidate.id,
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
				decision: "parent_completion_candidate",
				parentReading: "Only one blocker was repaired.",
				notPropagated: ["Parent goal is complete"],
				remainingParentWork: ["Repair tarball blocker"],
			}),
		).rejects.toThrow("verifier blockers have fresh repair evidence");
		const nextRepair = await harness.runtime.recordCheckpointResolution({
			checkpointId: repairCandidate.id,
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
		await harness.runtime.commitCheckpoint(candidate, {
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
		expect(systemPromptTemplate).toContain("Goal mode exception");
		expect(systemPromptTemplate).toContain("It is not parent completion");
	});
});
