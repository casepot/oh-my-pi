import { describe, expect, it } from "bun:test";
import type { Goal, GoalTargetUnitRule } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	collectTargetPlanGraphDiagnostics,
	effectiveTargetUnitRules,
	type GoalTargetPlanGraphInput,
} from "@oh-my-pi/pi-coding-agent/goals/target-plan-lint";

function validLightTargetPlanInput(): GoalTargetPlanGraphInput {
	return {
		primarySignalGroupId: "auth-visible",
		planDepth: "light",
		verificationAperture: {
			productIntention: "Show the auth result.",
			primarySignalId: "signal-auth",
			blastRadius: "local",
			confidenceTarget: "high",
			layerRationale: "Local behavior is directly observable.",
			residualUncertainty: [],
			omittedLayers: [],
		},
		verificationSignals: [
			{
				id: "signal-auth",
				role: "primary",
				layer: "integration",
				concernIds: ["concern-auth"],
				claim: "Auth result is visible.",
				observation: "Focused auth check observes the result.",
				method: "Run the auth check.",
				expectedOutcome: "The auth result is rendered.",
				required: true,
				confidenceIfSatisfied: "high",
				staleIf: [],
			},
		],
		concernChecks: [
			{
				id: "concern-auth",
				kind: "behavior",
				whyIndependent: "Auth output can regress independently.",
				coveredBySignalIds: ["signal-auth"],
			},
		],
		scopeCalibration: {
			includedRelatedWork: [],
			deferredRelatedWork: [],
		},
		branchEvidence: [
			{ branch: "happy path", required: true, plannedSignalIds: ["signal-auth"], rationale: "Primary path." },
		],
		excludedWorkReview: [],
		dryRun: { status: "passed", checks: [{ passed: true }] },
		targetCard: {
			capabilityClaim: "Auth result is visible.",
			knownLimits: [],
			userVisibleSurface: "Auth screen",
			acceptanceRows: { closed: ["happy path"], open: [] },
			verificationScenarios: ["happy path signal-auth"],
			checkpointEvidence: ["Focused auth check passes."],
		},
	};
}

function customGateRule(): GoalTargetUnitRule {
	return {
		id: "release-gate-before-cutover",
		kind: "gate-prerequisite",
		statement: "Release gate evidence must exist before cutover targets.",
		source: "rubric",
		enforcement: "error",
	};
}

function goalWithTargetUnitRules(rules: GoalTargetUnitRule[]): Goal {
	return { targetUnitRules: rules } as Goal;
}

describe("target-plan lint rules", () => {
	it("keeps built-in target-unit rules when goal-specific rules exist", () => {
		const customRule = customGateRule();

		const rules = effectiveTargetUnitRules({ targetUnitRules: [customRule] });
		const ruleIds = rules.map(rule => rule.id);

		expect(ruleIds).toContain("complete-acceptance-slice");
		expect(ruleIds).toContain("scenario-matrix");
		expect(ruleIds).toContain("release-gate-before-cutover");
		expect(rules.find(rule => rule.id === customRule.id)).toEqual(customRule);
	});

	it("rejects unknown acknowledged target-unit rule ids", () => {
		const input = validLightTargetPlanInput();
		input.scopeCalibration.targetUnitRuleIds = ["missing-rule"];

		const diagnostics = collectTargetPlanGraphDiagnostics(input, { mode: "submit" });

		expect(diagnostics.some(diagnostic => diagnostic.code === "target_unit.unknown_rule")).toBe(true);
	});

	it("delegates gate-prerequisite target-unit rules to reviewers", () => {
		const customRule = customGateRule();
		const diagnostics = collectTargetPlanGraphDiagnostics(validLightTargetPlanInput(), {
			mode: "submit",
			goal: goalWithTargetUnitRules([customRule]),
		});

		const diagnostic = diagnostics.find(item => item.code === "target_unit.reviewer_required");

		expect(diagnostic).toMatchObject({
			severity: "warning",
			blocksSubmission: false,
			path: "/workflow_review_rounds",
			message: "target unit rule is enforced by target-plan reviewers",
			guidance: customRule.statement,
		});
		expect(diagnostic?.offender?.id).toBe("release-gate-before-cutover");
	});

	it("acknowledging gate-prerequisite id does not turn it into a blocking lint error", () => {
		const customRule = customGateRule();
		const input = validLightTargetPlanInput();
		input.scopeCalibration.targetUnitRuleIds = ["release-gate-before-cutover"];

		const diagnostics = collectTargetPlanGraphDiagnostics(input, {
			mode: "submit",
			goal: goalWithTargetUnitRules([customRule]),
		});

		expect(diagnostics.some(diagnostic => diagnostic.code === "target_unit.unknown_rule")).toBe(false);
		const diagnostic = diagnostics.find(item => item.code === "target_unit.reviewer_required");
		expect(diagnostic).toMatchObject({
			severity: "warning",
			blocksSubmission: false,
			path: "/workflow_review_rounds",
			message: "target unit rule is enforced by target-plan reviewers",
			guidance: customRule.statement,
		});
		expect(diagnostic?.offender?.id).toBe("release-gate-before-cutover");
	});

	it("target unit exemption suppresses gate-prerequisite reviewer warning", () => {
		const customRule = customGateRule();
		const input = validLightTargetPlanInput();
		input.scopeCalibration.targetUnitExemptions = [
			{ ruleId: "release-gate-before-cutover", rationale: "Reviewer gate is not required for this local target." },
		];

		const diagnostics = collectTargetPlanGraphDiagnostics(input, {
			mode: "submit",
			goal: goalWithTargetUnitRules([customRule]),
		});

		expect(diagnostics.some(diagnostic => diagnostic.offender?.id === "release-gate-before-cutover")).toBe(false);
	});

	it("built-in complete acceptance slice remains blocking", () => {
		const input = validLightTargetPlanInput();
		input.targetCard = {
			...input.targetCard!,
			acceptanceRows: { closed: [], open: [] },
		};

		const diagnostics = collectTargetPlanGraphDiagnostics(input, { mode: "submit" });

		const diagnostic = diagnostics.find(
			item => item.code === "target_unit.violation" && item.path === "/target_card/acceptance_rows/closed",
		);
		expect(diagnostic).toMatchObject({
			severity: "error",
			blocksSubmission: true,
			message: "target unit rule requires a complete acceptance slice",
		});
	});
});
