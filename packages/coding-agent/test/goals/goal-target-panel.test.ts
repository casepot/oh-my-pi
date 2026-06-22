import { beforeAll, describe, expect, it } from "bun:test";
import type { Goal, GoalModeState, GoalTarget, GoalTargetPlanRecord } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	buildGoalTargetPanelDetails,
	GoalTargetPanelComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/goal-target-panel";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

function target(): GoalTarget {
	return {
		id: "target-1",
		sequence: 1,
		status: "active",
		title: "Close visible auth outcome",
		desiredFutureClaim: "Auth outcome is visible.",
		closureStandard: "Focused auth evidence exists.",
		baselineRefs: [],
		gateRefs: [],
		evidenceExpectation: [],
		nonGoals: [],
		forbiddenClaims: [],
		staleIf: [],
		createdAt: 1,
		createdBy: "operator",
		planId: "target-plan-1",
	};
}

function targetPlan(): GoalTargetPlanRecord {
	return {
		id: "target-plan-1",
		goalId: "goal-1",
		targetId: "target-1",
		targetSequence: 1,
		planFilePath: "local://goal-goal-1-target-1-plan.md",
		status: "drafting",
		revision: 2,
		stateVersionAtStart: 4,
		parentFrameVersionAtStart: 1,
		createdAt: 1,
		updatedAt: 2,
		planDepth: "standard",
		primarySignalGroupId: "auth-visible",
		scenarioMatrix: {
			id: "matrix-auth",
			primarySignalGroupId: "auth-visible",
			rowsInScope: [
				{
					id: "row-happy",
					branch: "happy path",
					signalIds: ["signal-auth"],
					concernIds: ["concern-auth"],
					acceptance: "Auth outcome is rendered.",
					expectedOutcome: "Rendered auth output exists.",
					staleIf: [],
				},
			],
			rowsLeftOpen: [
				{ id: "row-retry", branch: "retry", reason: "different-primary-signal", followUpHint: "Retry target." },
			],
			splittingSafety: { safe: true, rationale: "Retry has a separate primary signal." },
		},
		targetCard: {
			capabilityClaim: "Auth outcome is visible.",
			knownLimits: ["Retry behavior remains separate."],
			userVisibleSurface: "Auth screen",
			acceptanceRows: { closed: ["row-happy"], open: ["row-retry"] },
			workstreams: [
				{
					id: "impl",
					label: "Implementation",
					kind: "main",
					files: ["src/auth.ts"],
					contractInputs: [],
					contractOutputs: [],
				},
				{
					id: "tests",
					label: "Tests",
					kind: "other",
					files: ["test/auth.test.ts"],
					contractInputs: [],
					contractOutputs: [],
				},
			],
			verificationScenarios: ["row-happy auth-visible"],
			checkpointEvidence: ["Focused auth check passes."],
		},
		reviews: [],
	};
}

function state(): GoalModeState {
	const currentTarget = target();
	const currentTargetPlan = targetPlan();
	const goal: Goal = {
		id: "goal-1",
		objective: "Improve auth flow",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 2,
		currentTarget,
		currentTargetPlan,
		targets: [currentTarget],
		targetPlans: [currentTargetPlan],
		pendingCheckpointId: "checkpoint-1",
	};
	return {
		enabled: true,
		mode: "active",
		runMode: "planning-target",
		stateVersion: 5,
		parentFrameVersion: 1,
		goal,
	};
}

describe("goal target panel", () => {
	it("builds compact active target details from goal state", () => {
		const details = buildGoalTargetPanelDetails(state());

		expect(details).toMatchObject({
			runMode: "planning-target",
			stateVersion: 5,
			parentFrameVersion: 1,
			targetId: "target-1",
			targetPlanId: "target-plan-1",
			targetPlanRevision: 2,
			planDepth: "standard",
			primarySignalGroupId: "auth-visible",
			matrixRowCounts: { inScope: 1, leftOpen: 1 },
			implementationFanoutRequired: true,
			pendingCheckpointId: "checkpoint-1",
		});
		expect(details?.allowedNextActs).toEqual([
			'Call goal({op:"lint_target_plan", payload_file_path:...}) before submit_target_plan',
			'Call goal({op:"submit_target_plan", payload_file_path:...}) or goal({op:"fail_target_plan", ...})',
			"Edit target plan/payload sidecar in place",
		]);
	});

	it("renders active target identity and clears when hidden", () => {
		const component = new GoalTargetPanelComponent();
		const details = buildGoalTargetPanelDetails(state());
		if (!details) throw new Error("expected target panel details");

		component.setDetails(details);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain("Goal target · planning-target · Close visible auth outcome (active)");
		expect(rendered).toContain(
			"plan drafting r2 · target-plan-1 · depth standard · signal auth-visible · matrix 1/1 · fanout recommended",
		);
		expect(rendered).toContain(
			"next: lint_target_plan → submit_target_plan/fail_target_plan → edit target plan/payload",
		);
		const renderedLines = rendered.split("\n");
		expect(renderedLines.every(line => line.trim().length > 0)).toBe(true);
		expect(renderedLines.length).toBeLessThanOrEqual(4);

		component.setDetails(undefined);
		expect(component.render(120)).toEqual([]);
	});

	it("hides details outside active enabled goals", () => {
		expect(buildGoalTargetPanelDetails({ ...state(), enabled: false })).toBeUndefined();
		expect(
			buildGoalTargetPanelDetails({
				...state(),
				goal: { ...state().goal, status: "paused" },
			}),
		).toBeUndefined();
	});
});
