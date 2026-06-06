import { describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { completionBudgetReport, GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { Goal, GoalModeState, GoalTokenUsage } from "@oh-my-pi/pi-coding-agent/goals/state";
import { cloneGoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { buildGoalToolResponse, GoalTool, goalToolRenderer } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
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
	const runtime = new GoalRuntime({
		getState: () => cloneState(state),
		setState: next => {
			state = cloneState(next);
		},
		getCurrentUsage: () => createUsage(),
		emit: async () => {},
		persist: (_mode, _state) => {},
		sendHiddenMessage: async _message => {},
		now: () => 0,
	});
	return {
		runtime,
		getState: () => cloneState(state),
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
			goal: createGoalState.goal,
			remainingTokens: 10,
			completionBudgetReport: null,
		});

		const fetched = await tool.execute("call-get", { op: "get" });
		expect(getGoalModeState).toHaveBeenCalledTimes(1);
		expect(fetched.details).toMatchObject({
			op: "get",
			goal: getGoalState.goal,
			remainingTokens: 6,
			completionBudgetReport: null,
		});
		expect(runtime.completeGoalFromTool).not.toHaveBeenCalled();

		const completed = await tool.execute("call-complete", { op: "complete" });
		expect(runtime.completeGoalFromTool).toHaveBeenCalledTimes(1);
		expect(completed.details).toMatchObject({
			op: "complete",
			goal: completedGoal,
			remainingTokens: 3,
			completionBudgetReport: completionBudgetReport(completedGoal),
		});
		expect(completed.content[0]).toEqual({
			type: "text",
			text: "Goal: Complete route\nStatus: complete\nTokens: 7 used / 10 budget\nRemaining tokens: 3\n\nGoal achieved. Report final budget usage to the user: tokens used: 7 of 10; time used: 3 seconds.",
		});
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

	it("uses op-specific schemas for target, checkpoint, and resolution operations", () => {
		const tool = new GoalTool(createToolSession({ getGoalRuntime: () => createRuntimeHarness().runtime }));
		expect(tool.description).toContain("parent goal");
		expect(tool.description).toContain("current target");
		expect(tool.description).toContain("checkpoint");
		expect(tool.description).toContain("resolve_checkpoint");
		expect(tool.description).toContain("Invalid uses");

		expect(
			tool.parameters.safeParse({
				op: "start_target",
				title: "Prove smoke",
				desired_future_claim: "Smoke path is exercised.",
				closure_standard: "Current smoke output exists.",
			}).success,
		).toBe(true);
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

		const getCheckpoint = await tool.execute("get-checkpoint", { op: "get" });
		expect(getCheckpoint.details?.state?.goal.pendingCheckpointId).toBe(checkpoint.details?.checkpoint?.id);
		expect(getCheckpoint.details?.state?.goal.checkpoints?.[0]?.targetSnapshot.status).toBe("closed");

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
		expect(resolved.details?.state?.runMode).toBe("working-target");
		expect(resolved.details?.state?.goal.pendingCheckpointId).toBeUndefined();
		expect(resolved.details?.state?.goal.parentFrame?.acceptedClaims[0]?.id).toBe("source-link-smoke");
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
		expect(harness.getState()).toBeUndefined();
	});
});
