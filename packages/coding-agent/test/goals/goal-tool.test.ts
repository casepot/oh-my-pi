import { describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import {
	completionBudgetReport,
	GoalRuntime,
	type GoalSubmitTargetPlanInput,
	type GoalTargetPlanApprovalInput,
	type GoalTargetPlanFailureInput,
	type GoalUsagePersistenceEvent,
} from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type {
	Goal,
	GoalModeState,
	GoalTargetPlanRecord,
	GoalTargetPlanReview,
	GoalTokenUsage,
} from "@oh-my-pi/pi-coding-agent/goals/state";
import { cloneGoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	buildGoalToolResponse,
	GoalTool,
	type GoalToolInput,
	goalToolRenderer,
} from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

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
		objective: "Ship it",
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

function cloneState(state: GoalModeState | undefined): GoalModeState | undefined {
	return state ? cloneGoalModeState(state) : undefined;
}

function createToolSession(overrides: Partial<ToolSession>): ToolSession {
	return overrides as ToolSession;
}

function createRuntimeHarness(initialState?: TestGoalModeStateInput) {
	let state = initialState ? cloneState(createGoalModeState(initialState)) : undefined;
	let currentUsage = createUsage();
	const usagePersists: GoalUsagePersistenceEvent[] = [];
	const runtime = new GoalRuntime({
		getState: () => cloneState(state),
		setState: next => {
			state = cloneState(next);
		},
		getCurrentUsage: () => currentUsage,
		emit: async () => {},
		persist: (_mode, _state) => {},
		persistUsage: event => {
			usagePersists.push({ ...event });
		},
		sendHiddenMessage: async _message => {},
		now: () => 0,
	});
	return {
		runtime,
		getState: () => cloneState(state),
		setUsage: (usage: GoalTokenUsage) => {
			currentUsage = usage;
		},
		usagePersists,
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

async function approveCurrentTargetPlan(harness: {
	runtime: GoalRuntime;
	getState: () => GoalModeState | undefined;
}): Promise<void> {
	const state = harness.getState();
	if (!state) throw new Error("expected goal state");
	await harness.runtime.approveCurrentTargetPlan(buildTargetPlanApprovalInput(state));
}

function buildSubmitTargetPlanParams(source: {
	targetId: string;
	targetPlanId: string;
	planFilePath: string;
	revision: number;
}): Extract<GoalToolInput, { op: "submit_target_plan" }> {
	return {
		op: "submit_target_plan",
		target_id: source.targetId,
		target_plan_id: source.targetPlanId,
		plan_file_path: source.planFilePath,
		revision: source.revision,
		verification_aperture: {
			product_intention: "Prove the target behavior with direct evidence.",
			primary_signal_id: "signal-primary",
			blast_radius: "local",
			confidence_target: "high",
			layer_rationale: "The target is local and directly observable.",
			residual_uncertainty: ["Parent completion remains outside this target."],
			omitted_layers: [{ layer: "e2e", reason: "Parent-level e2e belongs to a later target." }],
		},
		verification_signals: [
			{
				id: "signal-primary",
				role: "primary",
				layer: "integration",
				concern_ids: ["concern-behavior"],
				claim: "Target behavior is verified.",
				observation: "Focused evidence is observed.",
				method: "Run the focused check.",
				expected_outcome: "The focused check passes.",
				required: true,
				confidence_if_satisfied: "high",
				stale_if: ["Relevant code changes."],
			},
		],
		concern_checks: [
			{
				id: "concern-behavior",
				kind: "behavior",
				why_independent: "Behavior can fail independently of parent completion.",
				covered_by_signal_ids: ["signal-primary"],
			},
		],
		scope_calibration: {
			right_sizing_basis: "product-signal",
			why_not_smaller: ["Smaller work would not produce an observable signal."],
			why_not_larger: ["Larger work would claim parent-level completion."],
			included_related_work: [
				{ item: "Focused target work", reason: "Needed for primary signal.", signal_ids: ["signal-primary"] },
			],
			deferred_related_work: [
				{
					item: "Parent completion verification",
					reason: "different-primary-signal",
					follow_up_hint: "Checkpoint first.",
				},
			],
		},
		branch_evidence: [
			{ branch: "happy path", required: true, planned_signal_ids: ["signal-primary"], rationale: "Primary signal." },
		],
		excluded_work_review: [
			{ item: "Parent completion", classification: "parent-non-claim", rationale: "Checkpoint is bounded." },
		],
		workflow_review_rounds: [
			{ lens: "adversarial", verdict: "accepted", summary: "No blockers.", blockers: [], revised: false },
		],
		dry_run: { status: "passed", checks: [{ id: "dry-run", passed: true, rationale: "Plan steps are executable." }] },
	};
}

describe("GoalTool", () => {
	it("routes create/get/complete operations and returns completion budget details", async () => {
		const createGoalState = createGoalModeState({
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Create route", tokenBudget: 10 }),
		});
		const getGoalState = createGoalModeState({
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Get route", tokensUsed: 4, tokenBudget: 10 }),
		});
		const completedGoal = createGoal({
			objective: "Complete route",
			status: "complete",
			tokensUsed: 7,
			timeUsedSeconds: 3,
			tokenBudget: 10,
		});
		const runtime = {
			createGoal: vi.fn(async () => createGoalState),
			completeGoalFromTool: vi.fn(async () => completedGoal),
			flushUsage: vi.fn(async () => {}),
		};
		const getGoalModeState = vi.fn(() => getGoalState);
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => runtime as unknown as GoalRuntime,
				getGoalModeState,
			}),
		);
		expect(tool.concurrency).toBe("exclusive");

		const created = await tool.execute("call-create", {
			op: "create",
			objective: "  Create route  ",
			token_budget: 10,
		});
		expect(runtime.createGoal).toHaveBeenCalledWith({ objective: "Create route", tokenBudget: 10 });
		expect(created.details).toMatchObject({
			op: "create",
			goal: {
				id: createGoalState.goal.id,
				objective: createGoalState.goal.objective,
				status: createGoalState.goal.status,
				tokensUsed: createGoalState.goal.tokensUsed,
				tokenBudget: createGoalState.goal.tokenBudget,
			},
			remainingTokens: 10,
			completionBudgetReport: null,
		});

		const fetched = await tool.execute("call-get", { op: "get" });
		expect(getGoalModeState).toHaveBeenCalledTimes(1);
		expect(fetched.details).toMatchObject({
			op: "get",
			goal: {
				id: getGoalState.goal.id,
				objective: getGoalState.goal.objective,
				status: getGoalState.goal.status,
				tokensUsed: getGoalState.goal.tokensUsed,
				tokenBudget: getGoalState.goal.tokenBudget,
			},
			remainingTokens: 6,
			completionBudgetReport: null,
		});
		expect(runtime.completeGoalFromTool).not.toHaveBeenCalled();

		const completed = await tool.execute("call-complete", { op: "complete" });
		expect(runtime.completeGoalFromTool).toHaveBeenCalledTimes(1);
		expect(completed.details).toMatchObject({
			op: "complete",
			goal: {
				id: completedGoal.id,
				objective: completedGoal.objective,
				status: completedGoal.status,
				tokensUsed: completedGoal.tokensUsed,
				tokenBudget: completedGoal.tokenBudget,
			},
			remainingTokens: 3,
			completionBudgetReport: completionBudgetReport(completedGoal),
		});
		expect(completed.content[0]).toEqual({
			type: "text",
			text: "Goal: Complete route\nStatus: complete\nTokens: 7 used / 10 budget\nRemaining tokens: 3\n\nGoal achieved. Report final budget usage to the user: tokens used: 7 of 10; time used: 3 seconds.",
		});
	});

	it("flushes usage before rendering get results", async () => {
		const harness = createRuntimeHarness();
		harness.runtime.onTurnStart("turn-1", createUsage());
		await harness.runtime.createGoal({ objective: "Account live usage", tokenBudget: 100 });
		harness.setUsage(createUsage({ input: 12, output: 3 }));
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("get-live-usage", { op: "get" });

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Tokens: 15 used / 100 budget");
		expect(result.details?.goal?.tokensUsed).toBe(15);
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("expected dark theme");
		const rendered = Bun.stripANSI(
			goalToolRenderer
				.renderResult(result, { expanded: false, isPartial: false }, uiTheme, { op: "get" })
				.render(120)
				.join("\n"),
		);
		expect(rendered).toContain("15 / 100 tokens (85 left)");
		expect(harness.usagePersists).toHaveLength(1);
		expect(harness.usagePersists[0]).toMatchObject({ tokenDelta: 15, tokensUsed: 15 });

		await harness.runtime.onGoalToolCompleted();
		expect(harness.usagePersists).toHaveLength(1);
	});

	it("surfaces verifier rejection without completing the goal", async () => {
		const activeGoal = createGoal({
			objective: "Needs proof",
			tokenBudget: 10,
			lastVerificationCompactorMemo: "Gather the missing evidence before retrying.",
		});
		const feedback = "Missing integration evidence.";
		const compactorMemo = activeGoal.lastVerificationCompactorMemo ?? "";
		const hiddenContinuation = [
			"Continue work on the active goal.",
			"<goal_continuation_compaction>",
			"Hidden prepared continuation prompt.",
			"</goal_continuation_compaction>",
		].join("\n");
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () =>
					({
						createGoal: vi.fn(),
						completeGoalFromTool: vi.fn(),
						flushUsage: vi.fn(async () => {}),
					}) as unknown as GoalRuntime,
				getGoalModeState: () =>
					createGoalModeState({
						enabled: true,
						mode: "active",
						goal: activeGoal,
					}),
				requestGoalCompletion: vi.fn(async () => ({
					goal: activeGoal,
					remainingTokens: 10,
					completionBudgetReport: null,
					completionVerification: {
						status: "rejected" as const,
						attempt: 1,
						maxAttempts: 3,
						feedback,
						continuationMessage: hiddenContinuation,
					},
				})),
			}),
		);

		const result = await tool.execute("call-complete", { op: "complete" });

		expect(result.details?.completionBudgetReport).toBeNull();
		expect(result.details?.completionVerification).toMatchObject({
			status: "rejected",
			attempt: 1,
			maxAttempts: 3,
			feedback,
			compactorMemo,
		});
		expect(result.details?.completionVerification?.continuationMessage).toBeUndefined();
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("expected text result");
		expect(content.text).toContain("Completion verification rejected");
		expect(content.text).toContain(feedback);
		expect(content.text).toContain("Compactor memo");
		expect(content.text).toContain(compactorMemo);
		expect(content.text).not.toContain("<goal_continuation_compaction>");
		expect(content.text).not.toContain("Continue work on the active goal.");
		expect(content.text).not.toContain("Hidden prepared continuation prompt.");

		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("expected dark theme");
		const renderOptions = { expanded: false, isPartial: false };
		const pendingRendered = Bun.stripANSI(
			goalToolRenderer.renderCall({ op: "complete" }, renderOptions, uiTheme).render(120).join("\n"),
		);
		expect(pendingRendered).toContain("verify completion");
		const rendered = Bun.stripANSI(
			goalToolRenderer.renderResult(result, renderOptions, uiTheme, { op: "complete" }).render(120).join("\n"),
		);
		expect(rendered).toContain("verification rejected");
		expect(rendered).toContain("attempt 1/3");
		expect(rendered).toContain(feedback);
		expect(rendered).toContain(compactorMemo);
		const wireSchema = toolWireSchema(tool);
		expect(wireSchema.type).toBe("object");
		expect(Array.isArray(wireSchema.oneOf)).toBe(true);
		expect(JSON.stringify(wireSchema.oneOf)).toContain('"const":"complete"');

		expect(rendered).not.toContain("<goal_continuation_compaction>");
		expect(rendered).not.toContain("Continue work on the active goal.");
		expect(rendered).not.toContain("Hidden prepared continuation prompt.");
	});

	it("renders only unresolved pending checkpoints in non-checkpoint run modes", async () => {
		const unresolvedState = createGoalModeState({
			runMode: "awaiting-user-input",
			goal: createGoal({ pendingCheckpointId: "checkpoint-1" }),
		});
		const resolvedState = createGoalModeState({
			runMode: "awaiting-user-input",
			goal: createGoal({
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
			}),
		});
		const pausedState = createGoalModeState({
			enabled: false,
			runMode: "awaiting-checkpoint-resolution",
			goal: createGoal({ status: "paused", pendingCheckpointId: "checkpoint-1" }),
		});
		let currentState = unresolvedState;
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => createRuntimeHarness().runtime,
				getGoalModeState: () => cloneState(currentState),
			}),
		);
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("expected dark theme");
		const renderOptions = { expanded: false, isPartial: false };

		const unresolved = await tool.execute("get-unresolved", { op: "get" });
		const unresolvedContent = unresolved.content[0];
		if (unresolvedContent?.type !== "text") throw new Error("expected text result");
		expect(unresolvedContent.text).toContain("Pending checkpoint: checkpoint-1");
		const unresolvedRendered = Bun.stripANSI(
			goalToolRenderer.renderResult(unresolved, renderOptions, uiTheme, { op: "get" }).render(120).join("\n"),
		);
		expect(unresolvedRendered).toContain("checkpoint pending: resolve checkpoint-1");
		expect(unresolvedRendered).toContain("ordinary tools blocked until resolve_checkpoint");

		currentState = resolvedState;
		const resolved = await tool.execute("get-resolved", { op: "get" });
		const resolvedContent = resolved.content[0];
		if (resolvedContent?.type !== "text") throw new Error("expected text result");
		expect(resolvedContent.text).not.toContain("Pending checkpoint");
		const resolvedRendered = Bun.stripANSI(
			goalToolRenderer.renderResult(resolved, renderOptions, uiTheme, { op: "get" }).render(120).join("\n"),
		);
		expect(resolvedRendered).not.toContain("checkpoint pending");
		expect(resolvedRendered).not.toContain("ordinary tools blocked until resolve_checkpoint");

		currentState = pausedState;
		const paused = await tool.execute("get-paused", { op: "get" });
		const pausedContent = paused.content[0];
		if (pausedContent?.type !== "text") throw new Error("expected text result");
		expect(pausedContent.text).not.toContain("Pending checkpoint");
		const pausedRendered = Bun.stripANSI(
			goalToolRenderer.renderResult(paused, renderOptions, uiTheme, { op: "get" }).render(120).join("\n"),
		);
		expect(pausedRendered).not.toContain("checkpoint pending");
		expect(pausedRendered).not.toContain("ordinary tools blocked until resolve_checkpoint");
	});

	it("uses op-specific schemas for target, checkpoint, and resolution operations", () => {
		const tool = new GoalTool(createToolSession({ getGoalRuntime: () => createRuntimeHarness().runtime }));
		expect(tool.description).toContain("parent goal");
		expect(tool.description).toContain("current target");
		expect(tool.description).toContain("checkpoint");
		expect(tool.description).toContain("resolve_checkpoint");
		expect(tool.description).toContain("Invalid uses");
		expect(tool.lenientArgValidation).toBe(true);

		expect(
			tool.parameters.safeParse({
				op: "start_target",
				title: "Prove smoke",
				desired_future_claim: "Smoke path is exercised.",
				closure_standard: "Current smoke output exists.",
			}).success,
		).toBe(true);
		const validTargetPlanSubmission = buildSubmitTargetPlanParams({
			targetId: "target-1",
			targetPlanId: "target-plan-1",
			planFilePath: "local://goal-goal-1-target-1-plan.md",
			revision: 1,
		});
		expect(tool.parameters.safeParse(validTargetPlanSubmission).success).toBe(true);
		expect(
			tool.parameters.safeParse({
				...validTargetPlanSubmission,
				verification_signals: validTargetPlanSubmission.verification_signals.map(signal => ({
					...signal,
					required: false,
				})),
			}).success,
		).toBe(false);
		expect(
			tool.parameters.safeParse({
				...validTargetPlanSubmission,
				dry_run: { status: "failed", checks: [{ id: "dry-run", passed: false, rationale: "Plan is incomplete." }] },
			}).success,
		).toBe(false);
		expect(
			tool.parameters.safeParse({
				op: "fail_target_plan",
				target_id: "target-1",
				target_plan_id: "target-plan-1",
				revision: 1,
				reason: "needs-user-input",
				message: "Cannot choose the right target without operator input.",
				blockers: ["Missing operator choice."],
				suggested_questions: ["Which gate should be targeted first?"],
			}).success,
		).toBe(true);
		const recoverTargetPlanPayload = {
			op: "recover_blocked_state",
			kind: "target-plan",
			action: "restart_target_planning",
			blocked_state_id: "goal-1-blocked-1",
			target_id: "target-1",
			target_plan_id: "target-1-plan",
			revision: 3,
			source_status: "failed",
			reason: "user-input",
			guidance: "Use the user's quest decision.",
		};
		expect(tool.parameters.safeParse(recoverTargetPlanPayload).success).toBe(true);
		expect(tool.parameters.safeParse({ ...recoverTargetPlanPayload, extra: "not allowed" }).success).toBe(false);
		expect(
			tool.parameters.safeParse({
				op: "recover_blocked_state",
				kind: "checkpoint-external-pause",
				action: "start_next_target",
				blocked_state_id: "goal-1-blocked-2",
				checkpoint_id: "goal-1-checkpoint-1",
				checkpoint_resolution_id: "goal-1-checkpoint-resolution-1",
				reason: "user-input",
				guidance: "Start the next target.",
			}).success,
		).toBe(false);
		expect(
			tool.parameters.safeParse({
				op: "recover_blocked_state",
				kind: "checkpoint-external-pause",
				action: "start_next_target",
				blocked_state_id: "goal-1-blocked-2",
				checkpoint_id: "goal-1-checkpoint-1",
				checkpoint_resolution_id: "goal-1-checkpoint-resolution-1",
				reason: "user-input",
				guidance: "Start the next target.",
				next_target: {
					title: "Prove smoke",
					desired_future_claim: "Smoke path is exercised.",
					closure_standard: "Current smoke output exists.",
				},
			}).success,
		).toBe(true);
		expect(
			tool.parameters.safeParse({
				op: "recover_blocked_state",
				kind: "checkpoint-external-pause",
				action: "enter_parent_completion",
				blocked_state_id: "goal-1-blocked-2",
				checkpoint_id: "goal-1-checkpoint-1",
				checkpoint_resolution_id: "goal-1-checkpoint-resolution-1",
				reason: "user-input",
				guidance: "Enter parent completion.",
				next_target: {},
			}).success,
		).toBe(false);
		expect(
			tool.parameters.safeParse({
				op: "start_target",
				title: "Prove smoke",
				desired_future_claim: "Smoke path is exercised.",
				closure_standard: "Current smoke output exists.",
				summary: "not allowed on start_target",
			}).success,
		).toBe(false);
		expect(
			tool.parameters.safeParse({
				op: "resolve_checkpoint",
				checkpoint_id: "checkpoint-1",
				decision: "next_target",
				parent_reading: "Need another target.",
				not_propagated: [],
				remaining_parent_work: [],
			}).success,
		).toBe(false);
		expect(
			tool.parameters.safeParse({
				op: "resolve_checkpoint",
				checkpoint_id: "checkpoint-1",
				decision: "parent_completion_candidate",
				parent_reading: "Ready for verifier.",
				not_propagated: [],
				remaining_parent_work: [],
				next_target: {
					title: "Not allowed here",
					desired_future_claim: "Should be rejected.",
					closure_standard: "Only next_target decisions install targets.",
				},
			}).success,
		).toBe(false);
		const emptyNextTargetParentCandidate = {
			op: "resolve_checkpoint",
			checkpoint_id: "checkpoint-1",
			decision: "parent_completion_candidate",
			parent_reading: "Ready for verifier.",
			not_propagated: [],
			remaining_parent_work: [],
			next_target: {
				title: "",
				desired_future_claim: "",
				closure_standard: "",
				baseline_refs: [],
				gate_refs: [],
				evidence_expectation: [],
				non_goals: [],
				forbidden_claims: [],
				stale_if: [],
				linked_verifier_blocker_ids: [],
			},
		};
		expect(tool.parameters.safeParse(emptyNextTargetParentCandidate).success).toBe(true);
		expect(
			tool.parameters.safeParse({
				...emptyNextTargetParentCandidate,
				next_target: {},
			}).success,
		).toBe(true);
		const pollutedParentCandidate = {
			...emptyNextTargetParentCandidate,
			objective: "",
			status: "",
			summary: "",
		};
		const validatedPollutedParentCandidate = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-polluted-parent-candidate",
			name: "goal",
			arguments: pollutedParentCandidate,
		}) as { op: string };
		expect(validatedPollutedParentCandidate.op).toBe("resolve_checkpoint");
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-non-empty-parent-candidate",
				name: "goal",
				arguments: {
					op: "resolve_checkpoint",
					checkpoint_id: "checkpoint-1",
					decision: "parent_completion_candidate",
					parent_reading: "Ready for verifier.",
					not_propagated: [],
					remaining_parent_work: [],
					next_target: { objective: "Do more work" },
				},
			}),
		).toThrow("next_target");
		expect(
			tool.parameters.safeParse({
				op: "checkpoint",
				status: "closed_with_evidence",
				summary: "Empty evidence cannot close a target.",
				local_claims: [],
				evidence: [],
				not_claimed: [],
				remaining_questions: [],
			}).success,
		).toBe(false);
		expect(
			tool.parameters.safeParse({
				op: "complete",
				checkpoint_id: "checkpoint-1",
			}).success,
		).toBe(false);
	});

	it("renders copyable target-plan submit identity while planning", async () => {
		const harness = createRuntimeHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		await harness.runtime.startTarget({
			title: "Prove smoke",
			desiredFutureClaim: "Smoke path is exercised.",
			closureStandard: "Current smoke output exists.",
		});
		const state = harness.getState();
		const target = state?.goal.currentTarget;
		const plan = state?.goal.currentTargetPlan;
		if (!target || !plan) throw new Error("expected current target plan");
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("get-planning", { op: "get" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain(`target_id: ${target.id}`);
		expect(text).toContain(`target_plan_id: ${plan.id}`);
		expect(text).toContain(`plan_file_path: ${plan.planFilePath}`);
		expect(text).toContain(`revision: ${plan.revision}`);
		expect(text).toContain('"op": "submit_target_plan"');
		expect(text).toContain('"verification_aperture"');
		expect(text).toContain("unit, integration, e2e, manual, product, release-gate");
		expect(text).toContain('"primary_signal_id": "<copy exact id of one required verification_signals[] entry>"');
		expect(text).toContain("never ux-manual/docs-or-operator");
		expect(text).toContain("concern taxonomy, not verification layer");
	});

	it("renders and executes failed target-plan recovery", async () => {
		const harness = createRuntimeHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		const planning = await harness.runtime.startTarget({
			title: "Prove smoke",
			desiredFutureClaim: "Smoke path is exercised.",
			closureStandard: "Current smoke output exists.",
		});
		const target = planning.goal.currentTarget;
		const plan = planning.goal.currentTargetPlan;
		if (!target || !plan) throw new Error("expected current target plan");
		const failed = await harness.runtime.failCurrentTargetPlan({
			targetId: target.id,
			targetPlanId: plan.id,
			revision: plan.revision,
			reason: "needs-user-input",
			message: "Operator must choose the quest branch.",
			blockers: ["Missing quest branch decision."],
			suggestedQuestions: ["Which quest branch should be planned?"],
		});
		const failedPlan = failed.goal.currentTargetPlan;
		if (!failedPlan) throw new Error("expected failed target plan");
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const getResult = await tool.execute("get-failed-plan", { op: "get" });
		const getText = getResult.content[0]?.type === "text" ? getResult.content[0].text : "";
		const block = failed.goal.currentBlockedState;
		if (block?.kind !== "target-plan") throw new Error("expected target-plan blocked state");
		expect(getText).toContain("recover_blocked_state");
		expect(getText).toContain(block.id);
		expect(getText).toContain("Do not call resume or start_target directly");

		const recovered = await tool.execute("recover-blocked-state", {
			op: "recover_blocked_state",
			kind: "target-plan",
			action: "restart_target_planning",
			blocked_state_id: block.id,
			target_id: target.id,
			target_plan_id: failedPlan.id,
			revision: failedPlan.revision,
			source_status: "failed",
			reason: "user-input",
			guidance: "Use the user's quest decision.",
		});
		const recoveredText = recovered.content[0]?.type === "text" ? recovered.content[0].text : "";
		expect(recovered.details?.state?.runMode).toBe("planning-target");
		expect(recovered.details?.targetPlan?.status).toBe("drafting");
		expect(recovered.details?.targetPlan?.revision).toBe(1);
		expect(recovered.details?.recovery?.blockedStateId).toBe(block.id);
		expect(recoveredText).toContain("Blocked state recovered");
		expect(recoveredText).toContain('"op": "submit_target_plan"');
	});

	it("routes target-plan submit and failure operations to session handlers", async () => {
		let submittedInput: GoalSubmitTargetPlanInput | undefined;
		let failedInput: GoalTargetPlanFailureInput | undefined;
		const harness = createRuntimeHarness();
		const goal = createGoal();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
				requestGoalTargetPlanApproval: async input => {
					submittedInput = input;
					return buildGoalToolResponse(goal, {
						targetPlanApproval: {
							goalId: goal.id,
							targetId: input.targetId,
							targetPlanId: input.targetPlanId,
							planFilePath: input.planFilePath,
							title: "goal-goal-1-target-1",
						},
					});
				},
				requestGoalTargetPlanFailure: async input => {
					failedInput = input;
					return buildGoalToolResponse(goal);
				},
			}),
		);

		const submitted = await tool.execute(
			"submit-plan",
			buildSubmitTargetPlanParams({
				targetId: "target-1",
				targetPlanId: "target-plan-1",
				planFilePath: "local://goal-goal-1-target-1-plan.md",
				revision: 1,
			}),
		);
		expect(submittedInput?.targetId).toBe("target-1");
		expect(submittedInput?.verificationAperture.primarySignalId).toBe("signal-primary");
		expect(submittedInput?.verificationSignals[0]?.confidenceIfSatisfied).toBe("high");
		expect(submitted.details?.targetPlanApproval?.targetPlanId).toBe("target-plan-1");

		await tool.execute("fail-plan", {
			op: "fail_target_plan",
			target_id: "target-1",
			target_plan_id: "target-plan-1",
			revision: 1,
			reason: "needs-user-input",
			message: "Cannot choose the right target without operator input.",
			blockers: ["Missing operator choice."],
			suggested_questions: ["Which gate should be targeted first?"],
		});
		expect(failedInput?.targetPlanId).toBe("target-plan-1");
		expect(failedInput?.reason).toBe("needs-user-input");
	});

	it("rejects invalid target-plan graphs before requesting review", async () => {
		const base = {
			targetId: "target-1",
			targetPlanId: "target-plan-1",
			planFilePath: "local://goal-goal-1-target-1-plan.md",
			revision: 1,
		};
		const cases: Array<{
			name: string;
			message: string;
			mutate: (params: Extract<GoalToolInput, { op: "submit_target_plan" }>) => void;
		}> = [
			{
				name: "unknown concern",
				message: "verification signal references unknown concern missing-concern",
				mutate: params => {
					params.verification_signals[0]!.concern_ids = ["missing-concern"];
				},
			},
			{
				name: "unknown covered signal",
				message: "concern check references unknown signal missing-signal",
				mutate: params => {
					params.concern_checks[0]!.covered_by_signal_ids = ["missing-signal"];
				},
			},
			{
				name: "unknown branch signal",
				message: "branch evidence references unknown signal missing-branch-signal",
				mutate: params => {
					params.branch_evidence[0]!.planned_signal_ids = ["missing-branch-signal"];
				},
			},
			{
				name: "duplicate signal ids",
				message: "target plan verification signal ids must be unique",
				mutate: params => {
					params.verification_signals = [
						params.verification_signals[0]!,
						{ ...params.verification_signals[0]!, role: "supporting" },
					];
				},
			},
			{
				name: "duplicate concern ids",
				message: "target plan concern check ids must be unique",
				mutate: params => {
					params.concern_checks = [
						params.concern_checks[0]!,
						{ ...params.concern_checks[0]!, covered_by_signal_ids: ["signal-primary"] },
					];
				},
			},
			{
				name: "failed dry run",
				message: "target plan dry_run must pass before submission",
				mutate: params => {
					params.dry_run = {
						status: "failed",
						checks: [{ id: "dry-run", passed: false, rationale: "Plan step failed." }],
					};
				},
			},
		];

		for (const item of cases) {
			const requestGoalTargetPlanApproval = vi.fn(async () => buildGoalToolResponse(createGoal()));
			const tool = new GoalTool(
				createToolSession({
					getGoalRuntime: () => createRuntimeHarness().runtime,
					requestGoalTargetPlanApproval,
				}),
			);
			const params = buildSubmitTargetPlanParams(base);
			item.mutate(params);

			await expect(tool.execute(`submit-${item.name}`, params)).rejects.toThrow(item.message);
			expect(requestGoalTargetPlanApproval).not.toHaveBeenCalled();
		}
	});

	it("returns concise recovery text for invalid target-plan schema enums", async () => {
		const requestGoalTargetPlanApproval = vi.fn(async () => buildGoalToolResponse(createGoal()));
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => createRuntimeHarness().runtime,
				requestGoalTargetPlanApproval,
			}),
		);
		const base = {
			targetId: "target-1",
			targetPlanId: "target-plan-1",
			planFilePath: "local://goal-goal-1-target-1-plan.md",
			revision: 1,
		};
		const layerParams = buildSubmitTargetPlanParams(base);
		layerParams.verification_signals = [
			...layerParams.verification_signals,
			{ ...layerParams.verification_signals[0]!, id: "signal-supporting-1", role: "supporting" },
			{ ...layerParams.verification_signals[0]!, id: "signal-supporting-2", role: "supporting" },
			{ ...layerParams.verification_signals[0]!, id: "signal-supporting-3", role: "supporting" },
		];
		(layerParams.verification_signals[3] as { layer: string }).layer = "browser";
		await expect(tool.execute("invalid-signal-layer", layerParams)).rejects.toThrow(
			'submit_target_plan invalid at verification_signals/3/layer: allowed values are unit, integration, e2e, manual, product, release-gate. Call goal({op:"get"}) and reuse the current target_id, target_plan_id, plan_file_path, and revision.',
		);

		const aliasLayerParams = buildSubmitTargetPlanParams(base);
		(aliasLayerParams.verification_signals[0] as { layer: string }).layer = "docs-or-operator";
		await expect(tool.execute("invalid-signal-layer-alias", aliasLayerParams)).rejects.toThrow(
			'"docs-or-operator" is a concern_checks[].kind value, not a verification layer',
		);

		const omittedParams = buildSubmitTargetPlanParams(base);
		(omittedParams.verification_aperture.omitted_layers[0] as { layer: string }).layer = "browser";
		await expect(tool.execute("invalid-omitted-layer", omittedParams)).rejects.toThrow(
			'submit_target_plan invalid at verification_aperture/omitted_layers/0/layer: allowed values are unit, integration, e2e, manual, product, release-gate. Call goal({op:"get"}) and reuse the current target_id, target_plan_id, plan_file_path, and revision.',
		);

		const primaryParams = buildSubmitTargetPlanParams(base);
		primaryParams.verification_aperture.primary_signal_id = "truthful-default-surfaces";
		await expect(tool.execute("invalid-primary-signal-id", primaryParams)).rejects.toThrow(
			'primary_signal_id must exactly match one required verification_signals[].id. Received "truthful-default-surfaces". Required signal ids: signal-primary.',
		);
		expect(requestGoalTargetPlanApproval).not.toHaveBeenCalled();
	});

	it("lets submit target-plan validation errors reach compact goal diagnostics", async () => {
		const requestGoalTargetPlanApproval = vi.fn(async () => buildGoalToolResponse(createGoal()));
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => createRuntimeHarness().runtime,
				requestGoalTargetPlanApproval,
			}),
		);
		const params = buildSubmitTargetPlanParams({
			targetId: "target-1",
			targetPlanId: "target-plan-1",
			planFilePath: "local://goal-goal-1-target-1-plan.md",
			revision: 1,
		});
		(params.verification_signals[0] as { layer: string }).layer = "ux-manual";

		let effectiveArgs: Record<string, unknown>;
		try {
			effectiveArgs = validateToolArguments(tool, {
				type: "toolCall",
				id: "call-invalid-layer",
				name: "goal",
				arguments: params,
			}) as Record<string, unknown>;
		} catch (error) {
			expect(String(error)).toContain('Validation failed for tool "goal"');
			if (!tool.lenientArgValidation) throw error;
			effectiveArgs = params;
		}

		await expect(tool.execute("call-invalid-layer", effectiveArgs as GoalToolInput)).rejects.toThrow(
			'"ux-manual" is a concern_checks[].kind value, not a verification layer',
		);
		expect(requestGoalTargetPlanApproval).not.toHaveBeenCalled();
	});

	it("returns concise recovery text for invalid target-plan non-enum fields", async () => {
		const requestGoalTargetPlanApproval = vi.fn(async () => buildGoalToolResponse(createGoal()));
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => createRuntimeHarness().runtime,
				requestGoalTargetPlanApproval,
			}),
		);
		const params = buildSubmitTargetPlanParams({
			targetId: "target-1",
			targetPlanId: "target-plan-1",
			planFilePath: "local://goal-goal-1-target-1-plan.md",
			revision: 1,
		});
		(params as { revision: number }).revision = 0;

		await expect(tool.execute("invalid-revision", params)).rejects.toThrow("submit_target_plan invalid at revision:");
		await expect(tool.execute("invalid-revision-repeat", params)).rejects.toThrow('Call goal({op:"get"})');
		expect(requestGoalTargetPlanApproval).not.toHaveBeenCalled();
	});

	it("renders failed target-plan submissions as awaiting user input", async () => {
		const failedPlan: GoalTargetPlanRecord = {
			id: "target-plan-1",
			goalId: "goal-1",
			targetId: "target-1",
			targetSequence: 1,
			planFilePath: "local://goal-goal-1-target-1-plan.md",
			status: "failed",
			revision: 3,
			stateVersionAtStart: 1,
			parentFrameVersionAtStart: 0,
			createdAt: 1,
			updatedAt: 2,
			failedAt: 2,
			reviews: [],
		};
		const failedGoal = createGoal({ currentTargetPlan: failedPlan });
		const failedState = createGoalModeState({ goal: failedGoal, runMode: "awaiting-user-input" });
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => createRuntimeHarness().runtime,
				getGoalModeState: () => failedState,
				requestGoalTargetPlanApproval: async () =>
					buildGoalToolResponse(failedGoal, {
						state: failedState,
						targetPlan: failedPlan,
						targetPlanReviews: [],
					}),
			}),
		);

		const result = await tool.execute(
			"failed-submit",
			buildSubmitTargetPlanParams({
				targetId: "target-1",
				targetPlanId: "target-plan-1",
				planFilePath: "local://goal-goal-1-target-1-plan.md",
				revision: 3,
			}),
		);

		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("Target plan failed");
		expect(text).toContain("awaiting user/external input");
		expect(text).not.toContain("Run mode remains planning-target");
	});

	it("renders rejected target-plan results with actionable identity", async () => {
		const review: GoalTargetPlanReview = {
			id: "review-aperture",
			lens: "aperture",
			status: "rejected",
			feedback: "Plan bundles unrelated release-gate work.",
			apertureClassification: "too-broad",
			revisionDecision: "split-required",
			findings: [
				{
					id: "finding-1",
					severity: "blocking",
					problem: "Release gate proof belongs in a separate target.",
					requiredRevision: "Split release-gate proof out.",
				},
			],
			reviewedAt: 2,
		};
		const rejectedPlan: GoalTargetPlanRecord = {
			id: "target-plan-1",
			goalId: "goal-1",
			targetId: "target-1",
			targetSequence: 1,
			planFilePath: "local://goal-goal-1-target-1-plan.md",
			status: "revision-required",
			revision: 2,
			stateVersionAtStart: 1,
			parentFrameVersionAtStart: 0,
			createdAt: 1,
			updatedAt: 2,
			verificationAperture: {
				productIntention: "Exercise the smoke path.",
				primarySignalId: "signal-primary",
				blastRadius: "local",
				confidenceTarget: "high",
				layerRationale: "Unit proof is sufficient for this target.",
				residualUncertainty: ["Release gate remains separate."],
				omittedLayers: [],
			},
			verificationSignals: [
				{
					id: "signal-primary",
					role: "primary",
					layer: "unit",
					concernIds: ["concern-behavior"],
					claim: "Smoke path is exercised.",
					observation: "Focused unit assertion.",
					method: "Run focused test.",
					expectedOutcome: "The smoke assertion passes.",
					required: true,
					confidenceIfSatisfied: "high",
					staleIf: [],
				},
			],
			concernChecks: [
				{
					id: "concern-behavior",
					kind: "behavior",
					whyIndependent: "Behavior can regress independently.",
					coveredBySignalIds: ["signal-primary"],
				},
			],
			reviews: [review],
		};
		const goal = createGoal({
			currentTarget: {
				id: "target-1",
				sequence: 1,
				status: "active",
				title: "Prove smoke path",
				desiredFutureClaim: "Smoke path is exercised.",
				closureStandard: "Focused unit evidence exists.",
				baselineRefs: [],
				gateRefs: [],
				evidenceExpectation: [],
				nonGoals: [],
				forbiddenClaims: [],
				staleIf: [],
				createdAt: 1,
				createdBy: "operator",
				planId: "target-plan-1",
			},
			currentTargetPlan: rejectedPlan,
		});
		const state = createGoalModeState({ goal, runMode: "planning-target" });
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => createRuntimeHarness().runtime,
				getGoalModeState: () => state,
				requestGoalTargetPlanApproval: async () =>
					buildGoalToolResponse(goal, { state, targetPlan: rejectedPlan, targetPlanReviews: [review] }),
			}),
		);

		const result = await tool.execute(
			"submit-rejected",
			buildSubmitTargetPlanParams({
				targetId: "target-1",
				targetPlanId: "target-plan-1",
				planFilePath: "local://goal-goal-1-target-1-plan.md",
				revision: 2,
			}),
		);
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("expected dark theme");
		const rendered = Bun.stripANSI(
			goalToolRenderer
				.renderResult(result, { expanded: false, isPartial: false }, uiTheme, { op: "submit_target_plan" })
				.render(140)
				.join("\n"),
		);
		expect(rendered).toContain("target plan rejected");
		expect(rendered).toContain("target_id: target-1");
		expect(rendered).toContain("target_plan_id: target-plan-1");
		expect(rendered).toContain("plan_file_path: local://goal-goal-1-target-1-plan.md");
		expect(rendered).toContain("target plan: revision-required r2");
		expect(rendered).toContain("aperture: Plan bundles unrelated release-gate work.");
		const detailsJson = JSON.stringify(result.details);
		expect(detailsJson).toContain("targetPlan");
		expect(detailsJson).toContain("targetPlanId");
		expect(detailsJson).toContain("planFilePath");
		expect(detailsJson).toContain("aperture");
		expect(detailsJson).toContain("rejected");
		expect(detailsJson).toContain("blockingFindingCount");
		expect(detailsJson).not.toContain("verificationSignals");
		expect(detailsJson).not.toContain("verificationAperture");
		expect(detailsJson).not.toContain("concernChecks");
		expect(detailsJson).not.toContain("Goal target plan");
	});

	it("renders approved target-plan results as execution unlocked", async () => {
		const approvedPlan: GoalTargetPlanRecord = {
			id: "target-plan-approved",
			goalId: "goal-1",
			targetId: "target-approved",
			targetSequence: 1,
			planFilePath: "local://goal-goal-1-target-approved-plan.md",
			status: "approved",
			revision: 1,
			stateVersionAtStart: 1,
			parentFrameVersionAtStart: 0,
			createdAt: 1,
			updatedAt: 2,
			approvedAt: 2,
			reviews: [acceptedTargetPlanReview("aperture"), acceptedTargetPlanReview("execution-readiness")],
		};
		const goal = createGoal({
			currentTarget: {
				id: "target-approved",
				sequence: 1,
				status: "active",
				title: "Execute approved plan",
				desiredFutureClaim: "Approved work can start.",
				closureStandard: "Execution is unlocked.",
				baselineRefs: [],
				gateRefs: [],
				evidenceExpectation: [],
				nonGoals: [],
				forbiddenClaims: [],
				staleIf: [],
				createdAt: 1,
				createdBy: "operator",
				planId: "target-plan-approved",
			},
			currentTargetPlan: approvedPlan,
		});
		const state = createGoalModeState({ goal, runMode: "working-target" });
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => createRuntimeHarness().runtime,
				getGoalModeState: () => state,
				requestGoalTargetPlanApproval: async () =>
					buildGoalToolResponse(goal, {
						state,
						targetPlan: approvedPlan,
						targetPlanReviews: approvedPlan.reviews,
					}),
			}),
		);

		const result = await tool.execute(
			"submit-approved",
			buildSubmitTargetPlanParams({
				targetId: "target-approved",
				targetPlanId: "target-plan-approved",
				planFilePath: "local://goal-goal-1-target-approved-plan.md",
				revision: 1,
			}),
		);
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("expected dark theme");
		const rendered = Bun.stripANSI(
			goalToolRenderer
				.renderResult(result, { expanded: false, isPartial: false }, uiTheme, { op: "submit_target_plan" })
				.render(140)
				.join("\n"),
		);
		expect(rendered).toContain("target plan approved");
		expect(rendered).toContain("execution unlocked for current target");
	});

	it("rejects checkpoint when the session review handler is unavailable", async () => {
		const harness = createRuntimeHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);
		await tool.execute("target", {
			op: "start_target",
			title: "Prove smoke",
			desired_future_claim: "Smoke path is exercised.",
			closure_standard: "Current smoke output exists.",
		});
		await approveCurrentTargetPlan(harness);

		await expect(
			tool.execute("checkpoint-without-reviewer", {
				op: "checkpoint",
				status: "closed_with_evidence",
				summary: "Smoke passed.",
				local_claims: ["Smoke path is exercised"],
				evidence: [{ claim: "Smoke path is exercised", evidence: "Observed smoke output", current: true }],
				not_claimed: ["Parent goal is complete"],
				remaining_questions: ["Which target is next?"],
			}),
		).rejects.toThrow("checkpoint review handler");
	});

	it("records target checkpoints and exposes parent-active checkpoint state through get", async () => {
		const harness = createRuntimeHarness();
		await harness.runtime.createGoal({ objective: "Improve release reliability" });
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
				requestGoalCheckpoint: async input => {
					const candidate = harness.runtime.buildCheckpointCandidate(input);
					const review = {
						status: "accepted" as const,
						feedback: "Checkpoint is locally closed and bounded.",
						evidenceChecked: candidate.evidence,
						blockers: [],
						reviewedAt: 10,
					};
					const state = await harness.runtime.commitCheckpoint(candidate, review);
					return buildGoalToolResponse(state.goal, {
						state,
						checkpoint: state.goal.checkpoints?.at(-1),
						checkpointReview: review,
					});
				},
				requestGoalCheckpointResolution: async input => {
					const state = await harness.runtime.recordCheckpointResolution(input);
					return buildGoalToolResponse(state.goal, {
						state,
						checkpointResolution: state.goal.checkpointResolutions?.at(-1),
					});
				},
			}),
		);

		await tool.execute("target", {
			op: "start_target",
			title: "Prove source-link smoke",
			desired_future_claim: "Source-link install exercises smoke path.",
			closure_standard: "Current smoke output exists.",
		});
		await approveCurrentTargetPlan(harness);
		const checkpoint = await tool.execute("checkpoint", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Source-link smoke passed.",
			local_claims: ["Source-link install exercises smoke path"],
			evidence: [
				{
					claim: "Source-link install exercises smoke path",
					evidence: "Observed smoke output",
					current: true,
				},
			],
			not_claimed: ["Release is ready"],
			remaining_questions: ["Which surface is next?"],
		});

		expect(checkpoint.details?.state?.runMode).toBe("awaiting-checkpoint-resolution");
		expect(checkpoint.details?.checkpoint?.notClaimed).toContain("Parent goal complete");
		const checkpointText = checkpoint.content[0]?.type === "text" ? checkpoint.content[0].text : "";
		expect(checkpointText).toContain("Parent goal remains active");
		expect(checkpointText).toContain("Ordinary tools are blocked");
		expect(checkpointText).toContain("resolve_checkpoint");
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("expected dark theme");
		const checkpointRendered = Bun.stripANSI(
			goalToolRenderer
				.renderResult(checkpoint, { expanded: false, isPartial: false }, uiTheme, { op: "checkpoint" })
				.render(140)
				.join("\n"),
		);
		expect(checkpointRendered).toContain("BOUNDARY");
		expect(checkpointRendered).toContain(
			`goal({op:"resolve_checkpoint", checkpoint_id:"${checkpoint.details?.checkpoint?.id}"})`,
		);

		const getCheckpoint = await tool.execute("get-checkpoint", { op: "get" });
		const stateAfterCheckpoint = harness.getState();
		expect(stateAfterCheckpoint?.goal.pendingCheckpointId).toBe(checkpoint.details?.checkpoint?.id);
		expect(stateAfterCheckpoint?.goal.checkpoints?.[0]?.targetSnapshot.status).toBe("closed");
		const getText = getCheckpoint.content[0]?.type === "text" ? getCheckpoint.content[0].text : "";
		expect(getText).toContain(`Pending checkpoint: ${checkpoint.details?.checkpoint?.id}`);
		expect(getText).toContain("Next action: inspect checkpoint guidance");

		const resolved = await tool.execute("resolve", {
			op: "resolve_checkpoint",
			checkpoint_id: checkpoint.details?.checkpoint?.id ?? "",
			decision: "next_target",
			parent_reading: "Source-link smoke is local evidence; tarball evidence remains open.",
			parent_delta: {
				admitted_claims: [
					{
						id: "source-link-smoke",
						claim: "Source-link smoke passed locally.",
						status: "accepted",
					},
				],
				residuals_added_or_updated: [
					{
						id: "tarball-smoke",
						statement: "Tarball smoke remains unproven.",
						classification: "current-parent-blocker",
					},
				],
			},
			not_propagated: ["Tarball path is verified"],
			remaining_parent_work: ["Tarball evidence"],
			next_target: {
				title: "Prove tarball smoke",
				desired_future_claim: "Tarball install exercises smoke path.",
				closure_standard: "Current tarball smoke output exists.",
			},
		});

		expect(resolved.details?.checkpointResolution?.decision).toBe("next_target");
		expect(resolved.details?.state?.runMode).toBe("planning-target");
		const stateAfterResolution = harness.getState();
		expect(stateAfterResolution?.goal.pendingCheckpointId).toBeUndefined();
		expect(stateAfterResolution?.goal.parentFrame?.acceptedClaims[0]?.id).toBe("source-link-smoke");
	});

	it("returns compact goal tool details without full checkpoint state", async () => {
		const harness = createRuntimeHarness();
		await harness.runtime.createGoal({
			objective: "Compact persisted goal details",
			tokenBudget: 50,
			parentFrame: {
				kind: "claim-gated",
				desiredFuture: "Parent objective proven",
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
			},
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
				requestGoalCheckpoint: async input => {
					const candidate = harness.runtime.buildCheckpointCandidate(input);
					const review = {
						status: "accepted" as const,
						feedback: "Checkpoint is locally closed and bounded.",
						evidenceChecked: candidate.evidence,
						blockers: [],
						reviewedAt: 10,
					};
					const state = await harness.runtime.commitCheckpoint(candidate, review);
					return buildGoalToolResponse(state.goal, {
						state,
						checkpoint: state.goal.checkpoints?.at(-1),
						checkpointReview: review,
					});
				},
				requestGoalCheckpointResolution: async input => {
					const state = await harness.runtime.recordCheckpointResolution(input);
					return buildGoalToolResponse(state.goal, {
						state,
						checkpointResolution: state.goal.checkpointResolutions?.at(-1),
					});
				},
			}),
		);

		await tool.execute("target", {
			op: "start_target",
			title: "Close compact target",
			desired_future_claim: "Compact target has direct evidence.",
			closure_standard: "Checkpoint is accepted.",
		});
		await approveCurrentTargetPlan(harness);
		const checkpoint = await tool.execute("checkpoint", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Compact target closed.",
			local_claims: ["Compact target has direct evidence"],
			evidence: [{ claim: "Compact target has direct evidence", evidence: "Observed checkpoint", current: true }],
			not_claimed: ["Parent objective proven"],
			remaining_questions: ["Which compact path is next?"],
		});
		const checkpointId = checkpoint.details?.checkpoint?.id;
		if (!checkpointId) throw new Error("expected checkpoint id");

		const resolved = await tool.execute("resolve", {
			op: "resolve_checkpoint",
			checkpoint_id: checkpointId ?? "",
			decision: "next_target",
			parent_reading: "Checkpoint narrows the parent but leaves another target.",
			not_propagated: ["Parent objective proven"],
			remaining_parent_work: ["Audit compact resume"],
			next_target: {
				title: "Audit compact resume",
				desired_future_claim: "Resume surfaces compact details.",
				closure_standard: "Details omit full goal state.",
			},
		});
		const fullState = harness.getState();
		expect(fullState?.goal.parentFrame).toBeDefined();
		expect(fullState?.goal.checkpoints?.[0]?.targetSnapshot).toBeDefined();
		expect(fullState?.goal.checkpointResolutions?.length).toBe(1);

		const detailsJson = JSON.stringify(resolved.details);
		expect(detailsJson).not.toContain("targetSnapshot");
		expect(detailsJson).not.toContain('"parentFrame":');
		expect(detailsJson).not.toContain("checkpoints");
		expect(detailsJson).not.toContain("checkpointResolutions");
		expect(detailsJson).not.toContain('"state":{"goal"');
		expect(detailsJson).toContain(checkpointId);
		expect(detailsJson).toContain("next_target");
		expect(detailsJson).toContain("planning-target");
		expect(detailsJson).toContain("Compact persisted goal details");
		expect(detailsJson).toContain('"tokensUsed":0');
		expect(detailsJson).toContain('"tokenBudget":50');
		expect(detailsJson).toContain("Audit compact resume");
	});

	it("rejects create when a goal already exists", async () => {
		const harness = createRuntimeHarness({
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Existing" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(
			tool.execute("call-create", { op: "create", objective: "New goal", token_budget: 10 }),
		).rejects.toThrow("cannot create a new goal because this session already has a goal");
	});

	it("rejects complete when no goal is active", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(tool.execute("call-complete", { op: "complete" })).rejects.toThrow(
			"cannot complete goal because no goal is active",
		);
	});

	it("rejects op=create when the objective is missing or only whitespace", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(tool.execute("call-empty", { op: "create", objective: "   \t\n" })).rejects.toThrow(
			"objective is required when op=create",
		);
		expect(harness.getState()).toBeUndefined();
	});

	it("rejects op=create when the token_budget is zero or negative", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(tool.execute("call-zero", { op: "create", objective: "Ship it", token_budget: 0 })).rejects.toThrow(
			"token_budget must be a positive integer when provided",
		);
		await expect(tool.execute("call-neg", { op: "create", objective: "Ship it", token_budget: -5 })).rejects.toThrow(
			"token_budget must be a positive integer when provided",
		);
		expect(harness.getState()).toBeUndefined();
	});

	it("flips state to exiting and clears enabled when op=complete succeeds (fix #1)", async () => {
		const harness = createRuntimeHarness();
		await harness.runtime.createGoal({ objective: "Ship the release", tokenBudget: 100 });
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-complete", { op: "complete" });

		expect(result.details).toMatchObject({ op: "complete" });
		const after = harness.getState();
		expect(after?.enabled).toBe(false);
		expect(after?.mode).toBe("exiting");
		expect(after?.reason).toBe("completed");
		expect(after?.goal.status).toBe("complete");
		expect(after?.runMode).toBe("completed");
	});

	it("completes a paused goal (enabled=false) — was broken before fix", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "active",
			goal: createGoal({ objective: "Paused work", status: "paused" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-complete", { op: "complete" });
		expect(result.details?.goal?.status).toBe("complete");
		expect(harness.getState()?.goal.status).toBe("complete");
	});

	it("allows create after previous goal is complete", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "exiting",
			reason: "completed",
			goal: createGoal({ status: "complete" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-create", {
			op: "create",
			objective: "Next goal",
		});
		expect(result.details?.goal?.objective).toBe("Next goal");
		expect(result.details?.goal?.status).toBe("active");
	});

	it("op=get returns a paused goal even when enabled=false", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "active",
			goal: createGoal({ status: "paused" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-get", { op: "get" });
		expect(result.details?.goal?.status).toBe("paused");
		expect(result.details?.goal?.objective).toBe("Ship it");
	});

	it("op=resume re-activates a paused goal", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "active",
			goal: createGoal({ status: "paused" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-resume", { op: "resume" });
		expect(result.details?.op).toBe("resume");
		expect(result.details?.goal?.status).toBe("active");
		expect(harness.getState()?.enabled).toBe(true);
	});

	it("op=drop clears goal state", async () => {
		const harness = createRuntimeHarness({
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Drop me" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-drop", { op: "drop" });
		expect(result.details?.op).toBe("drop");
		expect(result.details?.goal?.status).toBe("dropped");
		expect(JSON.stringify(result.content)).toContain("Formal goal mode is off");
		expect(JSON.stringify(result.content)).toContain("no checkpoint or parent completion was recorded");
		expect(harness.getState()).toBeUndefined();
	});
});
