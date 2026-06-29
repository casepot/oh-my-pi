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

function validScenarioMatrixTargetPlanInput(): GoalTargetPlanGraphInput {
	const input = validLightTargetPlanInput();
	input.scenarioMatrix = {
		id: "matrix-auth",
		primarySignalGroupId: "auth-visible",
		rowsInScope: [
			{
				id: "row-happy-path",
				branch: "happy path",
				signalIds: ["signal-auth"],
				concernIds: ["concern-auth"],
				acceptance: "Happy path auth result is visible.",
				expectedOutcome: "Auth result is rendered.",
				staleIf: [],
			},
		],
		rowsLeftOpen: [],
		splittingSafety: { safe: true, rationale: "No independent auth branch is left open." },
	};
	input.targetCard = {
		...input.targetCard!,
		acceptanceRows: { closed: ["row-happy-path happy path signal-auth"], open: [] },
		verificationScenarios: ["row-happy-path happy path signal-auth"],
	};
	return input;
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

	it("enforces acknowledged parallel workstream target-unit rule", () => {
		const input = validLightTargetPlanInput();
		input.scopeCalibration.targetUnitRuleIds = ["parallel-workstreams-required"];
		input.targetCard = {
			...input.targetCard!,
			workstreams: [
				{
					id: "docs",
					label: "Docs",
					kind: "docs-changelog",
					files: ["CHANGELOG.md"],
					contractInputs: [],
					contractOutputs: [],
				},
			],
		};

		const diagnostics = collectTargetPlanGraphDiagnostics(input, { mode: "submit" });

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				code: "target_unit.violation",
				path: "/target_card/workstreams",
				message: "target unit rule requires at least two non-doc workstreams",
			}),
		);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				code: "target_unit.violation",
				path: "/target_card/shared_contract",
				message: "target unit rule requires target_card.shared_contract",
			}),
		);
	});

	it("delegates gate-prerequisite target-unit rules to reviewers", () => {
		const customRule = customGateRule();
		const diagnostics = collectTargetPlanGraphDiagnostics(validLightTargetPlanInput(), {
			mode: "submit",
			goal: goalWithTargetUnitRules([customRule]),
		});

		const diagnostic = diagnostics.find(item => item.code === "target_unit.reviewer_required");

		expect(diagnostic).toMatchObject({
			severity: "info",
			blocksSubmission: false,
			path: "/target_plan_reviews",
			message: "target unit rule is checked by target-plan review evidence",
		});
		expect(diagnostic?.guidance).toContain(customRule.statement);
		expect(diagnostic?.guidance).toContain("No payload edit is required");
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
			severity: "info",
			blocksSubmission: false,
			path: "/target_plan_reviews",
			message: "target unit rule is checked by target-plan review evidence",
		});
		expect(diagnostic?.guidance).toContain(customRule.statement);
		expect(diagnostic?.guidance).toContain("No payload edit is required");
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

	it("blocks scenario branch consistency drift deterministically", () => {
		const cases: Array<{
			name: string;
			code: string;
			mutate: (input: GoalTargetPlanGraphInput) => void;
		}> = [
			{
				name: "missing branch evidence",
				code: "matrix.branch_missing_evidence",
				mutate: input => {
					input.branchEvidence = [];
				},
			},
			{
				name: "duplicate branch",
				code: "matrix.duplicate_branch",
				mutate: input => {
					input.scenarioMatrix!.rowsLeftOpen = [
						{
							id: "row-open",
							branch: "happy path",
							reason: "different-primary-signal",
							followUpHint: "Plan separately.",
						},
					];
				},
			},
			{
				name: "required branch left open",
				code: "branch.required_left_open",
				mutate: input => {
					input.scenarioMatrix!.rowsInScope = [];
					input.scenarioMatrix!.rowsLeftOpen = [
						{
							id: "row-open",
							branch: "happy path",
							reason: "different-primary-signal",
							followUpHint: "Plan separately.",
						},
					];
				},
			},
			{
				name: "branch signal mismatch",
				code: "branch.signal_mismatch",
				mutate: input => {
					input.verificationSignals = [
						...input.verificationSignals,
						{ ...input.verificationSignals[0]!, id: "signal-support", role: "supporting" },
					];
					input.branchEvidence[0]!.plannedSignalIds = ["signal-support"];
				},
			},
			{
				name: "card scenario missing branch",
				code: "card.scenario_missing_branch",
				mutate: input => {
					input.targetCard!.verificationScenarios = ["unrelated scenario"];
				},
			},
			{
				name: "card acceptance missing row",
				code: "card.acceptance_missing_closed_row",
				mutate: input => {
					input.targetCard!.acceptanceRows = { closed: ["unrelated row"], open: [] };
				},
			},
		];

		for (const item of cases) {
			const input = validScenarioMatrixTargetPlanInput();
			item.mutate(input);

			const diagnostic = collectTargetPlanGraphDiagnostics(input, { mode: "submit" }).find(
				entry => entry.code === item.code,
			);

			expect(diagnostic, item.name).toMatchObject({ severity: "error", blocksSubmission: true });
		}

		const deterministic = validScenarioMatrixTargetPlanInput();
		const baseRow = deterministic.scenarioMatrix!.rowsInScope[0]!;
		deterministic.branchEvidence = [];
		deterministic.scenarioMatrix!.rowsInScope = [
			{ ...baseRow, id: "row-z", branch: "z branch" },
			{ ...baseRow, id: "row-a", branch: "a branch" },
		];
		deterministic.targetCard!.verificationScenarios = ["row-z z branch signal-auth", "row-a a branch signal-auth"];
		deterministic.targetCard!.acceptanceRows = {
			closed: ["row-z z branch signal-auth", "row-a a branch signal-auth"],
			open: [],
		};

		const missingBranchDiagnostics = collectTargetPlanGraphDiagnostics(deterministic, { mode: "submit" }).filter(
			diagnostic => diagnostic.code === "matrix.branch_missing_evidence",
		);

		expect(missingBranchDiagnostics.map(diagnostic => diagnostic.offender?.id)).toEqual(["row-a", "row-z"]);

		const disambiguated = validScenarioMatrixTargetPlanInput();
		disambiguated.scenarioMatrix!.rowsLeftOpen = [
			{
				id: "row-open",
				branch: "happy path",
				reason: "different-primary-signal",
				followUpHint: "Plan separately.",
			},
		];
		disambiguated.branchEvidence = [
			{
				branch: "focused happy path",
				rowIds: ["row-happy-path"],
				required: true,
				plannedSignalIds: ["signal-auth"],
				rationale: "Required in-scope row.",
			},
			{
				branch: "deferred happy path",
				rowIds: ["row-open"],
				required: false,
				plannedSignalIds: [],
				rationale: "Deferred left-open row.",
			},
		];
		const disambiguatedCodes = collectTargetPlanGraphDiagnostics(disambiguated, { mode: "submit" }).map(
			diagnostic => diagnostic.code,
		);
		expect(disambiguatedCodes).not.toContain("matrix.duplicate_branch");
		expect(disambiguatedCodes).not.toContain("matrix.branch_missing_evidence");

		const unknownRow = validScenarioMatrixTargetPlanInput();
		unknownRow.branchEvidence[0]!.rowIds = ["missing-row"];
		const unknownRowDiagnostic = collectTargetPlanGraphDiagnostics(unknownRow, { mode: "submit" }).find(
			diagnostic => diagnostic.code === "branch.unknown_row_id",
		);
		expect(unknownRowDiagnostic).toMatchObject({
			path: "/branch_evidence/0/row_ids/0",
			offender: { id: "missing-row" },
		});

		const contradictoryBranch = validScenarioMatrixTargetPlanInput();
		contradictoryBranch.branchEvidence[0] = {
			...contradictoryBranch.branchEvidence[0]!,
			branch: "admin path",
			rowIds: ["row-happy-path"],
		};
		const contradictoryBranchDiagnostic = collectTargetPlanGraphDiagnostics(contradictoryBranch, {
			mode: "submit",
		}).find(diagnostic => diagnostic.code === "branch.row_id_branch_mismatch");
		expect(contradictoryBranchDiagnostic).toMatchObject({
			path: "/branch_evidence/0/row_ids/0",
			offender: { id: "row-happy-path", value: "happy path" },
		});

		const rowLinkedMismatch = validScenarioMatrixTargetPlanInput();
		rowLinkedMismatch.verificationSignals = [
			...rowLinkedMismatch.verificationSignals,
			{ ...rowLinkedMismatch.verificationSignals[0]!, id: "signal-support", role: "supporting" },
		];
		rowLinkedMismatch.branchEvidence[0] = {
			...rowLinkedMismatch.branchEvidence[0]!,
			rowIds: ["row-happy-path"],
			plannedSignalIds: ["signal-support"],
		};
		const rowLinkedMismatchDiagnostic = collectTargetPlanGraphDiagnostics(rowLinkedMismatch, { mode: "submit" }).find(
			diagnostic => diagnostic.code === "branch.signal_mismatch",
		);
		expect(rowLinkedMismatchDiagnostic).toMatchObject({
			path: "/branch_evidence/0/planned_signal_ids/0",
			message: "required branch happy path plans signal signal-support but row row-happy-path omits it",
		});
	});
});
