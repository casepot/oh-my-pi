import { describe, expect, it } from "bun:test";
import {
	escapeXmlText,
	GoalRuntime,
	type GoalRuntimeHost,
	goalTokenDelta,
	renderGoalPrompt,
	renderGoalStateSnapshot,
	renderTrustedObjective,
} from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type {
	Goal,
	GoalModeState,
	GoalParentFrame,
	GoalRuntimeEvent,
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
	const persists: Array<{ mode: "goal" | "goal_paused" | "none"; state?: GoalModeState }> = [];
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
		persist: (mode, persistedState) => {
			persists.push({ mode, state: cloneState(persistedState) });
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
		hiddenMessages,
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
		await harness.runtime.flushUsage("suppressed");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(2_000);
		expect(harness.persists).toHaveLength(1);

		harness.advance(400);
		await harness.runtime.flushUsage("suppressed");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(2_000);
		expect(harness.persists).toHaveLength(1);

		harness.advance(700);
		await harness.runtime.flushUsage("suppressed");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(3);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(3_000);
		expect(harness.persists).toHaveLength(2);
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
		const rubricState = await harness.runtime.setGoalRubric(state.goal.id, "4 = excellent <evidence> & coherent");
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
	});

	it("renders compact goal snapshots without duplicating objective or nested checkpoint bodies", async () => {
		const harness = createHarness();
		const objective = "Ship compact goal context";
		await harness.runtime.createGoal({
			objective,
			parentFrame: createParentFrame({ desiredFuture: objective }),
		});
		await harness.runtime.startTarget({
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
		expect(snapshot).toContain('"desiredFuture": "same_as_objective"');
		expect(snapshot).not.toContain('"objective"');
		expect(snapshot).not.toContain("targetSnapshot");
		expect(snapshot).not.toContain(objective);
		expect(snapshot.length).toBeLessThan(6_000);
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

		await harness.runtime.recordExternalUsage(createUsage({ input: 2, output: 1, cacheWrite: 1 }), 1_000);

		expect(harness.getState()?.stateVersion).toBe(before);
		expect(harness.getState()?.goal.tokensUsed).toBe(4);
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(1);
	});

	it("starts a target and commits an accepted checkpoint without completing the parent goal", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		const targeted = await harness.runtime.startTarget({
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
		await harness.runtime.startTarget({
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
		await harness.runtime.startTarget({
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
		await harness.runtime.startTarget({
			title: "Prove source-link smoke",
			desiredFutureClaim: "Source-link install exercises smoke path.",
			closureStandard: "Smoke output is observed.",
			gateRefs: ["install-smoke"],
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
			},
			notPropagated: ["Tarball path is verified"],
			remainingParentWork: ["Tarball install evidence"],
			nextTarget: {
				title: "Prove tarball smoke",
				desiredFutureClaim: "Tarball installs exercise smoke path.",
				closureStandard: "Tarball smoke output is observed.",
				forbiddenClaims: ["Release is ready"],
			},
		});

		expect(resolved.runMode).toBe("working-target");
		expect(resolved.goal.pendingCheckpointId).toBeUndefined();
		expect(resolved.parentFrameVersion).toBe(committed.parentFrameVersion + 1);
		expect(resolved.goal.parentFrame?.acceptedClaims[0]?.id).toBe("source-link-smoke");
		expect(resolved.goal.parentFrame?.gates[0]?.status).toBe("passed");
		expect(resolved.goal.currentTarget?.title).toBe("Prove tarball smoke");
		expect(resolved.goal.currentTarget?.parentFrameVersion).toBe(resolved.parentFrameVersion);
	});

	it("resolving a checkpoint to user input keeps continuation suppressed", async () => {
		const harness = createHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		await harness.runtime.startTarget({
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

		const resolved = await harness.runtime.recordCheckpointResolution({
			checkpointId: committed.goal.pendingCheckpointId ?? "",
			decision: "needs_user_input",
			parentReading: "Operator must choose next gate.",
			notPropagated: ["Next target selected"],
			remainingParentWork: ["Choose next gate"],
			broaderChecksOrInputs: ["Ask operator which install surface to verify next."],
		});

		expect(resolved.runMode).toBe("awaiting-user-input");
		expect(resolved.goal.pendingCheckpointId).toBe(committed.goal.pendingCheckpointId);
	});

	it("blocks parent completion across pending checkpoints and verifier repair", async () => {
		const harness = createHarness();
		const created = await harness.runtime.createGoal({ objective: "Improve release reliability" });
		await harness.runtime.startTarget({
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
		await harness.runtime.startTarget({
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

		await harness.runtime.startTarget({
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

		await harness.runtime.startTarget({
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
					blockers: [],
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
			'Call `goal({op:"complete"})` now',
		);
		expect(renderGoalPrompt("continuation", repairState.goal, repairState)).toContain("Do not retry");
		expect(systemPromptTemplate).toContain("Goal mode exception");
		expect(systemPromptTemplate).toContain("It is not parent completion");
	});
});
