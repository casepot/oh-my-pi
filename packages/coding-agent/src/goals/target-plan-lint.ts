import type {
	Goal,
	GoalConcernCheck,
	GoalExcludedWorkClassification,
	GoalScenarioMatrix,
	GoalTargetCard,
	GoalTargetPlanBranchEvidence,
	GoalTargetPlanDepth,
	GoalTargetPlanExcludedWorkReview,
	GoalTargetPlanLintDiagnostic,
	GoalTargetUnitRule,
	GoalVerificationAperture,
	GoalVerificationSignal,
} from "./state";

export interface GoalTargetPlanGraphInput {
	primarySignalGroupId?: string;
	planDepth?: GoalTargetPlanDepth;
	scenarioMatrix?: GoalScenarioMatrix;
	targetCard?: GoalTargetCard;
	verificationAperture: GoalVerificationAperture;
	verificationSignals: GoalVerificationSignal[];
	concernChecks: GoalConcernCheck[];
	scopeCalibration: {
		includedRelatedWork: Array<{ signalIds: string[] }>;
		deferredRelatedWork: Array<{ reason: string }>;
		targetUnitRuleIds?: string[];
		targetUnitExemptions?: Array<{ ruleId: string; rationale: string }>;
	};
	branchEvidence: GoalTargetPlanBranchEvidence[];
	excludedWorkReview: GoalTargetPlanExcludedWorkReview[];
	dryRun: { status: "passed" | "failed"; checks: Array<{ passed: boolean }> };
}
export const BUILT_IN_TARGET_UNIT_RULES: GoalTargetUnitRule[] = [
	{
		id: "complete-acceptance-slice",
		kind: "complete-acceptance-slice",
		statement: "Target MUST close a complete acceptance slice, not a process phase.",
		source: "built-in",
		enforcement: "error",
	},
	{
		id: "scenario-matrix",
		kind: "scenario-matrix",
		statement: "Same-signal branch rows MUST be represented by a scenario matrix.",
		source: "built-in",
		enforcement: "error",
	},
	{
		id: "no-process-phase",
		kind: "no-process-phase",
		statement: "Targets MUST NOT be only planning, reviewing, scaffolding, or cleanup.",
		source: "built-in",
		enforcement: "warning",
	},
	{
		id: "same-primary-signal-together",
		kind: "same-primary-signal-together",
		statement: "Rows sharing a primary signal group SHOULD stay in the same target.",
		source: "built-in",
		enforcement: "error",
	},
	{
		id: "branch-unblocks-matrix",
		kind: "branch-unblocks-matrix",
		statement: "Branch targets MUST name the larger matrix they unblock.",
		source: "built-in",
		enforcement: "error",
	},
];

function jsonPointer(path: Array<string | number>): string {
	if (path.length === 0) return "";
	return `/${path.map(segment => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

export function lintDiagnostic(input: {
	severity: GoalTargetPlanLintDiagnostic["severity"];
	code: string;
	path: Array<string | number>;
	message: string;
	guidance: string;
	offender?: GoalTargetPlanLintDiagnostic["offender"];
	repairPatches?: GoalTargetPlanLintDiagnostic["repairPatches"];
}): GoalTargetPlanLintDiagnostic {
	return {
		severity: input.severity,
		code: input.code,
		path: jsonPointer(input.path),
		message: input.message,
		guidance: input.guidance,
		blocksSubmission: input.severity === "error",
		offender: input.offender,
		repairPatches: input.repairPatches,
	};
}

function resolveDiagnosticSeverity(rule: GoalTargetUnitRule): GoalTargetPlanLintDiagnostic["severity"] {
	return rule.enforcement === "error" ? "error" : "warning";
}

export function resolvePrimarySignalGroupId(planOrInput: {
	primarySignalGroupId?: string;
	verificationAperture?: GoalVerificationAperture;
}): string | undefined {
	return planOrInput.primarySignalGroupId ?? planOrInput.verificationAperture?.primarySignalId;
}

export function collectPrimarySignalGroupHistory(
	goal: Goal | undefined,
	currentTargetPlanId: string | undefined,
	primarySignalGroupId: string | undefined,
): Array<{ kind: "target-plan" | "target"; id: string; targetId?: string; legacy: boolean }> {
	if (!goal || !primarySignalGroupId) return [];
	const history: Array<{ kind: "target-plan" | "target"; id: string; targetId?: string; legacy: boolean }> = [];
	const seen = new Set<string>();
	for (const plan of goal.targetPlans ?? []) {
		if (plan.id === currentTargetPlanId) continue;
		const group = resolvePrimarySignalGroupId(plan);
		if (group !== primarySignalGroupId) continue;
		const key = `target-plan:${plan.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		history.push({ kind: "target-plan", id: plan.id, targetId: plan.targetId, legacy: !plan.primarySignalGroupId });
	}
	for (const target of goal.targets ?? []) {
		if (target.planId && target.planId === currentTargetPlanId) continue;
		const group = resolvePrimarySignalGroupId(target);
		if (group !== primarySignalGroupId) continue;
		const key = `target:${target.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		history.push({ kind: "target", id: target.id, targetId: target.id, legacy: !target.primarySignalGroupId });
	}
	return history;
}

function targetPlanDepth(input: GoalTargetPlanGraphInput): GoalTargetPlanDepth {
	return input.planDepth ?? "light";
}

function hasModernTargetPlanFields(input: GoalTargetPlanGraphInput): boolean {
	return (
		input.primarySignalGroupId !== undefined ||
		input.planDepth !== undefined ||
		input.scenarioMatrix !== undefined ||
		input.targetCard !== undefined
	);
}

function requiredSignalCount(input: GoalTargetPlanGraphInput): number {
	return input.verificationSignals.filter(signal => signal.required).length;
}

function targetCardWorkstreamsRequireSharedContract(input: GoalTargetPlanGraphInput): boolean {
	const workstreams = input.targetCard?.workstreams ?? [];
	if (workstreams.length > 1) return true;
	return input.concernChecks.some(check => check.kind === "contract" || check.kind === "migration");
}

function targetPlanNeedsTrustHeavy(input: GoalTargetPlanGraphInput): boolean {
	if (input.verificationAperture.blastRadius === "external-or-irreversible") return true;
	if (input.concernChecks.some(check => check.kind === "security")) return true;
	return input.verificationSignals.some(signal => signal.layer === "product" || signal.layer === "e2e");
}

function matrixRequiredForInput(input: GoalTargetPlanGraphInput, history: Array<{ legacy: boolean }>): boolean {
	if (targetPlanDepth(input) !== "light") return true;
	if (input.verificationAperture.blastRadius !== "local" && input.verificationAperture.blastRadius !== "module") {
		return true;
	}
	if (history.length > 0) return true;
	if (requiredSignalCount(input) !== 1) return true;
	if (input.branchEvidence.length !== 1) return true;
	return input.scopeCalibration.deferredRelatedWork.some(item => item.reason !== "different-primary-signal");
}

function collectTargetCardDiagnostics(
	input: GoalTargetPlanGraphInput,
	mode: "lint" | "submit",
): GoalTargetPlanLintDiagnostic[] {
	const diagnostics: GoalTargetPlanLintDiagnostic[] = [];
	const modernSeverity: GoalTargetPlanLintDiagnostic["severity"] =
		mode === "submit" || hasModernTargetPlanFields(input) ? "error" : "warning";
	if (!input.planDepth) {
		diagnostics.push(
			lintDiagnostic({
				severity: modernSeverity,
				code: "target_card.missing_field",
				path: ["plan_depth"],
				message: "target plan must declare plan_depth",
				guidance: "Choose light, standard, or trust-heavy according to target risk.",
				offender: { kind: "target_card", id: "plan_depth" },
			}),
		);
	}
	if (targetPlanNeedsTrustHeavy(input) && input.planDepth !== "trust-heavy") {
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "target_card.depth_too_light",
				path: ["plan_depth"],
				message: "target plan depth is too light for trust, privacy, security, or product-authority risk",
				guidance: "Use plan_depth trust-heavy and include the trust-heavy target_card fields.",
				offender: { kind: "target_card", id: input.planDepth, value: input.planDepth },
			}),
		);
	}
	const card = input.targetCard;
	if (!card) {
		diagnostics.push(
			lintDiagnostic({
				severity: modernSeverity,
				code: "target_card.missing_field",
				path: ["target_card"],
				message: "target plan must include target_card",
				guidance:
					"Add a compact target_card with capability, limits, acceptance rows, scenarios, and checkpoint evidence.",
				offender: { kind: "target_card", id: "target_card" },
			}),
		);
		return diagnostics;
	}
	const requireNonEmpty = (field: string, value: string | undefined, message: string): void => {
		if (value?.trim()) return;
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "target_card.missing_field",
				path: ["target_card", field],
				message,
				guidance: `Fill target_card.${field} for ${targetPlanDepth(input)} target planning.`,
				offender: { kind: "target_card", id: field },
			}),
		);
	};
	const requireArray = (field: string, value: string[], message: string): void => {
		if (value.length > 0) return;
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "target_card.missing_field",
				path: field.includes("/") ? ["target_card", ...field.split("/")] : ["target_card", field],
				message,
				guidance: `Add at least one concrete ${field.replaceAll("/", ".")} entry.`,
				offender: { kind: "target_card", id: field },
			}),
		);
	};
	requireNonEmpty("capability_claim", card.capabilityClaim, "target_card.capability_claim is required");
	requireNonEmpty("user_visible_surface", card.userVisibleSurface, "target_card.user_visible_surface is required");
	requireArray("acceptance_rows/closed", card.acceptanceRows.closed, "target_card.acceptance_rows.closed is required");
	requireArray("verification_scenarios", card.verificationScenarios, "target_card.verification_scenarios is required");
	requireArray("checkpoint_evidence", card.checkpointEvidence, "target_card.checkpoint_evidence is required");
	const depth = targetPlanDepth(input);
	if (depth === "standard" || depth === "trust-heavy") {
		requireNonEmpty("confidence_earned", card.confidenceEarned, "target_card.confidence_earned is required");
		if (!card.workstreams?.some(workstream => workstream.kind === "main")) {
			diagnostics.push(
				lintDiagnostic({
					severity: "error",
					code: "target_card.missing_field",
					path: ["target_card", "workstreams"],
					message: "standard target cards require a main workstream",
					guidance: "Add at least one target_card.workstreams[] entry with kind main.",
					offender: { kind: "target_card", id: "workstreams" },
				}),
			);
		}
		if (targetCardWorkstreamsRequireSharedContract(input) && !card.sharedContract?.trim()) {
			requireNonEmpty("shared_contract", card.sharedContract, "target_card.shared_contract is required");
		}
		requireArray("review_lenses", card.reviewLenses ?? [], "target_card.review_lenses is required");
		if (
			(input.concernChecks.some(check => check.kind === "migration") ||
				input.verificationAperture.blastRadius !== "local") &&
			!card.rollbackCutover?.trim()
		) {
			requireNonEmpty("rollback_cutover", card.rollbackCutover, "target_card.rollback_cutover is required");
		}
	}
	if (depth === "trust-heavy") {
		requireNonEmpty("trust_privacy_claim", card.trustPrivacyClaim, "target_card.trust_privacy_claim is required");
		requireNonEmpty("authority_boundary", card.authorityBoundary, "target_card.authority_boundary is required");
		requireNonEmpty(
			"policy_deletion_implications",
			card.policyDeletionImplications,
			"target_card.policy_deletion_implications is required",
		);
		requireNonEmpty("rollback_cutover", card.rollbackCutover, "target_card.rollback_cutover is required");
		const reviewLenses = (card.reviewLenses ?? []).map(lens => lens.toLowerCase());
		if (!reviewLenses.some(lens => lens.includes("security") || lens.includes("behavior"))) {
			diagnostics.push(
				lintDiagnostic({
					severity: "error",
					code: "target_card.missing_field",
					path: ["target_card", "review_lenses"],
					message: "trust-heavy review_lenses must include behavior or security",
					guidance: "Add a behavior/security review lens.",
					offender: { kind: "target_card", id: "review_lenses" },
				}),
			);
		}
		if (!reviewLenses.some(lens => lens.includes("maintainability") || lens.includes("tooling"))) {
			diagnostics.push(
				lintDiagnostic({
					severity: "error",
					code: "target_card.missing_field",
					path: ["target_card", "review_lenses"],
					message: "trust-heavy review_lenses must include maintainability or tooling",
					guidance: "Add a maintainability/tooling review lens.",
					offender: { kind: "target_card", id: "review_lenses" },
				}),
			);
		}
		for (const row of input.scenarioMatrix?.rowsInScope ?? []) {
			const covered = card.verificationScenarios.some(
				scenario => scenario.includes(row.id) || scenario.includes(row.branch),
			);
			if (!covered) {
				diagnostics.push(
					lintDiagnostic({
						severity: "error",
						code: "target_card.missing_field",
						path: ["target_card", "verification_scenarios"],
						message: `trust-heavy verification_scenarios must cover matrix row ${row.id}`,
						guidance: "Add a verification scenario naming this row id or branch.",
						offender: { kind: "matrix_row", id: row.id },
					}),
				);
			}
		}
	}
	return diagnostics;
}

function collectMatrixDiagnostics(
	input: GoalTargetPlanGraphInput,
	options: { mode: "lint" | "submit"; goal?: Goal; targetPlanId?: string },
): GoalTargetPlanLintDiagnostic[] {
	const diagnostics: GoalTargetPlanLintDiagnostic[] = [];
	const primarySignalGroupId = resolvePrimarySignalGroupId(input);
	const history = collectPrimarySignalGroupHistory(options.goal, options.targetPlanId, primarySignalGroupId);
	const matrix = input.scenarioMatrix;
	const matrixRequired = matrixRequiredForInput(input, history);
	const modernSeverity: GoalTargetPlanLintDiagnostic["severity"] =
		options.mode === "submit" || hasModernTargetPlanFields(input) ? "error" : "warning";
	if (!input.primarySignalGroupId) {
		diagnostics.push(
			lintDiagnostic({
				severity: modernSeverity,
				code: "primary_signal_group.required_missing",
				path: ["primary_signal_group_id"],
				message: "target plan must declare primary_signal_group_id",
				guidance:
					"Use a stable product-signal group id; legacy fallback is verification_aperture.primary_signal_id.",
				offender: { kind: "signal", id: input.verificationAperture.primarySignalId },
			}),
		);
	}
	if (history.length > 0 && !matrix) {
		diagnostics.push(
			lintDiagnostic({
				severity: history.some(item => item.legacy) && !input.primarySignalGroupId ? "warning" : "error",
				code: "history.repeated_primary_signal",
				path: ["primary_signal_group_id"],
				message: `primary signal group ${primarySignalGroupId ?? "<unknown>"} already appears in goal history`,
				guidance:
					"Represent repeated same-signal rows in scenario_matrix or choose a different primary_signal_group_id.",
				offender: { kind: "history", id: primarySignalGroupId, value: history.map(item => item.id) },
			}),
		);
	}
	if (matrixRequired && !matrix) {
		diagnostics.push(
			lintDiagnostic({
				severity: modernSeverity,
				code: "matrix.required_missing",
				path: ["scenario_matrix"],
				message: "scenario_matrix is required for this target plan",
				guidance: "Add scenario_matrix rows or make this a valid light one-row local/module plan.",
				offender: { kind: "matrix_row", id: primarySignalGroupId },
			}),
		);
		return diagnostics;
	}
	if (!matrix) return diagnostics;
	if (matrix.primarySignalGroupId !== primarySignalGroupId) {
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "matrix.primary_signal_mismatch",
				path: ["scenario_matrix", "primary_signal_group_id"],
				message: "scenario_matrix.primary_signal_group_id must match top-level primary_signal_group_id",
				guidance: "Use the same stable primary signal group id in both fields.",
				offender: { kind: "matrix_row", id: matrix.id, value: matrix.primarySignalGroupId },
			}),
		);
	}
	const signalIds = new Set(input.verificationSignals.map(signal => signal.id));
	const concernIds = new Set(input.concernChecks.map(check => check.id));
	for (const [rowIndex, row] of matrix.rowsInScope.entries()) {
		for (const [signalIndex, signalId] of row.signalIds.entries()) {
			if (signalIds.has(signalId)) continue;
			diagnostics.push(
				lintDiagnostic({
					severity: "error",
					code: "reference.unknown_signal",
					path: ["scenario_matrix", "rows_in_scope", rowIndex, "signal_ids", signalIndex],
					message: `scenario matrix row references unknown signal ${signalId}`,
					guidance: "Use an id from verification_signals[].id.",
					offender: { kind: "signal", id: signalId },
				}),
			);
		}
		for (const [concernIndex, concernId] of row.concernIds.entries()) {
			if (concernIds.has(concernId)) continue;
			diagnostics.push(
				lintDiagnostic({
					severity: "error",
					code: "reference.unknown_concern",
					path: ["scenario_matrix", "rows_in_scope", rowIndex, "concern_ids", concernIndex],
					message: `scenario matrix row references unknown concern ${concernId}`,
					guidance: "Use an id from concern_checks[].id.",
					offender: { kind: "concern", id: concernId },
				}),
			);
		}
	}
	const representedBranches = new Map<string, string[]>();
	for (const row of matrix.rowsInScope) {
		representedBranches.set(row.branch, [...(representedBranches.get(row.branch) ?? []), row.id]);
	}
	for (const row of matrix.rowsLeftOpen) {
		representedBranches.set(row.branch, [...(representedBranches.get(row.branch) ?? []), row.id]);
	}
	for (const [branchIndex, branch] of input.branchEvidence.entries()) {
		if (!branch.required) continue;
		const represented = representedBranches.get(branch.branch) ?? [];
		if (represented.length === 1) continue;
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "matrix.branch_unrepresented",
				path: ["branch_evidence", branchIndex, "branch"],
				message: `required branch ${branch.branch} must appear in exactly one matrix row`,
				guidance: "Add the branch to rows_in_scope or rows_left_open, but not both.",
				offender: { kind: "matrix_row", id: branch.branch, value: represented },
			}),
		);
	}
	for (const [rowIndex, row] of matrix.rowsLeftOpen.entries()) {
		if (row.reason === "different-primary-signal") continue;
		if (matrix.splittingSafety.safe && matrix.nextLargerTarget?.unblocksMatrixId) continue;
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "matrix.unsafe_split",
				path: ["scenario_matrix", "rows_left_open", rowIndex],
				message: `same-primary-signal row ${row.id} is left open without a safe larger matrix`,
				guidance:
					"Set splitting_safety.safe true and name next_larger_target.unblocks_matrix_id, or include the row.",
				offender: { kind: "matrix_row", id: row.id },
			}),
		);
	}
	if (history.length > 0 && matrix.rowsLeftOpen.length > 0 && !matrix.nextLargerTarget?.unblocksMatrixId) {
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "matrix.unsafe_split",
				path: ["scenario_matrix", "next_larger_target", "unblocks_matrix_id"],
				message: "repeated same-primary-signal target must name the larger matrix it unblocks",
				guidance: "Set scenario_matrix.next_larger_target.unblocks_matrix_id.",
				offender: { kind: "history", id: primarySignalGroupId },
			}),
		);
	}
	return diagnostics;
}

export function effectiveTargetUnitRules(goal: Pick<Goal, "targetUnitRules"> | undefined): GoalTargetUnitRule[] {
	const byId = new Map<string, GoalTargetUnitRule>();
	for (const rule of BUILT_IN_TARGET_UNIT_RULES) byId.set(rule.id, rule);
	for (const rule of goal?.targetUnitRules ?? []) byId.set(rule.id, rule);
	return [...byId.values()];
}

function collectTargetUnitDiagnostics(
	input: GoalTargetPlanGraphInput,
	options: { goal?: Goal; targetPlanId?: string },
): GoalTargetPlanLintDiagnostic[] {
	const rules = effectiveTargetUnitRules(options.goal);
	const diagnostics: GoalTargetPlanLintDiagnostic[] = [];
	const ruleIds = new Set(rules.map(rule => rule.id));
	input.scopeCalibration.targetUnitRuleIds?.forEach((ruleId, ruleIndex) => {
		if (ruleIds.has(ruleId)) return;
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "target_unit.unknown_rule",
				path: ["scope_calibration", "target_unit_rule_ids", ruleIndex],
				message: `target_unit_rule_ids references unknown rule ${ruleId}`,
				guidance: "Use an id from the effective target-unit rules or remove the acknowledgement.",
				offender: { kind: "target_unit_rule", id: ruleId },
			}),
		);
	});
	const primarySignalGroupId = resolvePrimarySignalGroupId(input);
	const history = collectPrimarySignalGroupHistory(options.goal, options.targetPlanId, primarySignalGroupId);
	for (const rule of rules) {
		if (input.scopeCalibration.targetUnitExemptions?.some(exemption => exemption.ruleId === rule.id)) continue;
		if (rule.kind === "complete-acceptance-slice" && !input.targetCard?.acceptanceRows.closed.length) {
			diagnostics.push(
				lintDiagnostic({
					severity: resolveDiagnosticSeverity(rule),
					code: "target_unit.violation",
					path: ["target_card", "acceptance_rows", "closed"],
					message: "target unit rule requires a complete acceptance slice",
					guidance: rule.statement,
					offender: { kind: "target_unit_rule", id: rule.id },
				}),
			);
		} else if (rule.kind === "scenario-matrix" && matrixRequiredForInput(input, history) && !input.scenarioMatrix) {
			diagnostics.push(
				lintDiagnostic({
					severity: resolveDiagnosticSeverity(rule),
					code: "target_unit.violation",
					path: ["scenario_matrix"],
					message: "target unit rule requires a scenario matrix",
					guidance: rule.statement,
					offender: { kind: "target_unit_rule", id: rule.id },
				}),
			);
		} else if (rule.kind === "same-primary-signal-together" && history.length > 0 && !input.scenarioMatrix) {
			diagnostics.push(
				lintDiagnostic({
					severity: resolveDiagnosticSeverity(rule),
					code: "target_unit.violation",
					path: ["primary_signal_group_id"],
					message: "target unit rule forbids unstructured repeated primary signal groups",
					guidance: rule.statement,
					offender: { kind: "target_unit_rule", id: rule.id, value: history.map(item => item.id) },
				}),
			);
		} else if (
			rule.kind === "branch-unblocks-matrix" &&
			input.scenarioMatrix?.rowsLeftOpen.length &&
			!input.scenarioMatrix.nextLargerTarget?.unblocksMatrixId
		) {
			diagnostics.push(
				lintDiagnostic({
					severity: resolveDiagnosticSeverity(rule),
					code: "target_unit.violation",
					path: ["scenario_matrix", "next_larger_target", "unblocks_matrix_id"],
					message: "target unit rule requires branch targets to name the larger matrix",
					guidance: rule.statement,
					offender: { kind: "target_unit_rule", id: rule.id },
				}),
			);
		} else if (rule.kind === "no-process-phase") {
			const claim = input.targetCard?.capabilityClaim.toLowerCase() ?? "";
			if (/\b(plan|review|scaffold|cleanup|changelog)\b/.test(claim)) {
				diagnostics.push(
					lintDiagnostic({
						severity: resolveDiagnosticSeverity(rule),
						code: "target_unit.violation",
						path: ["target_card", "capability_claim"],
						message: "target card may describe a process phase rather than a capability",
						guidance: rule.statement,
						offender: { kind: "target_unit_rule", id: rule.id, value: input.targetCard?.capabilityClaim },
					}),
				);
			}
		} else if (rule.kind === "gate-prerequisite") {
			diagnostics.push(
				lintDiagnostic({
					severity: "warning",
					code: "target_unit.reviewer_required",
					path: ["workflow_review_rounds"],
					message: "target unit rule is enforced by target-plan reviewers",
					guidance: rule.statement,
					offender: { kind: "target_unit_rule", id: rule.id },
				}),
			);
		}
	}
	return diagnostics;
}

export function collectTargetPlanGraphDiagnostics(
	input: GoalTargetPlanGraphInput,
	options: { mode: "lint" | "submit"; goal?: Goal; targetPlanId?: string } = { mode: "submit" },
): GoalTargetPlanLintDiagnostic[] {
	const diagnostics: GoalTargetPlanLintDiagnostic[] = [];
	const invalidExcludedClassifications: GoalExcludedWorkClassification[] = [
		"essential-related-work",
		"stale-or-unsupported",
	];
	input.excludedWorkReview.forEach((review, index) => {
		if (!invalidExcludedClassifications.includes(review.classification)) return;
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "excluded_work.unsafe",
				path: ["excluded_work_review", index, "classification"],
				message: "target plan excluded work contains essential related or stale work",
				guidance: "Include this work in the target scope or fail the target plan for operator input.",
				offender: { kind: "excluded_work", id: review.item, value: review.classification },
			}),
		);
	});
	const signalIds = new Set(input.verificationSignals.map(signal => signal.id));
	if (signalIds.size !== input.verificationSignals.length) {
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "signal.duplicate_id",
				path: ["verification_signals"],
				message: "target plan verification signal ids must be unique",
				guidance: "Give every verification_signals[] entry a unique id.",
				offender: { kind: "signal" },
			}),
		);
	}
	const requiredSignalIds = new Set(
		input.verificationSignals.filter(signal => signal.required).map(signal => signal.id),
	);
	const primarySignal = input.verificationSignals.find(
		signal => signal.id === input.verificationAperture.primarySignalId,
	);
	if (!primarySignal) {
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "reference.unknown_signal",
				path: ["verification_aperture", "primary_signal_id"],
				message: "target plan primary signal must reference a verification signal",
				guidance: "Set verification_aperture.primary_signal_id to a verification_signals[].id.",
				offender: { kind: "signal", id: input.verificationAperture.primarySignalId },
			}),
		);
	} else if (!primarySignal.required) {
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "signal.primary_not_required",
				path: ["verification_aperture", "primary_signal_id"],
				message: "target plan primary signal must be required",
				guidance: "Mark the primary verification signal required: true.",
				offender: { kind: "signal", id: primarySignal.id },
			}),
		);
	}
	if (requiredSignalIds.size === 0) {
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "signal.required_missing",
				path: ["verification_signals"],
				message: "target plan requires at least one required verification signal",
				guidance: "Mark at least one verification signal required: true.",
				offender: { kind: "signal" },
			}),
		);
	}
	const concernIds = new Set(input.concernChecks.map(check => check.id));
	if (concernIds.size !== input.concernChecks.length) {
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "concern.duplicate_id",
				path: ["concern_checks"],
				message: "target plan concern check ids must be unique",
				guidance: "Give every concern_checks[] entry a unique id.",
				offender: { kind: "concern" },
			}),
		);
	}
	input.verificationSignals.forEach((signal, signalIndex) => {
		signal.concernIds.forEach((concernId, concernIndex) => {
			if (concernIds.has(concernId)) return;
			diagnostics.push(
				lintDiagnostic({
					severity: "error",
					code: "reference.unknown_concern",
					path: ["verification_signals", signalIndex, "concern_ids", concernIndex],
					message: `verification signal references unknown concern ${concernId}`,
					guidance: "Use an id from concern_checks[].id.",
					offender: { kind: "concern", id: concernId },
				}),
			);
		});
	});
	input.concernChecks.forEach((check, checkIndex) => {
		check.coveredBySignalIds.forEach((signalId, signalIndex) => {
			if (signalIds.has(signalId)) return;
			diagnostics.push(
				lintDiagnostic({
					severity: "error",
					code: "reference.unknown_signal",
					path: ["concern_checks", checkIndex, "covered_by_signal_ids", signalIndex],
					message: `concern check references unknown signal ${signalId}`,
					guidance: "Use an id from verification_signals[].id.",
					offender: { kind: "signal", id: signalId },
				}),
			);
		});
	});
	input.scopeCalibration.includedRelatedWork.forEach((item, itemIndex) => {
		item.signalIds.forEach((signalId, signalIndex) => {
			if (signalIds.has(signalId)) return;
			diagnostics.push(
				lintDiagnostic({
					severity: "error",
					code: "reference.unknown_signal",
					path: ["scope_calibration", "included_related_work", itemIndex, "signal_ids", signalIndex],
					message: `included related work references unknown signal ${signalId}`,
					guidance: "Use an id from verification_signals[].id.",
					offender: { kind: "signal", id: signalId },
				}),
			);
		});
	});
	input.branchEvidence.forEach((branch, branchIndex) => {
		if (branch.required && branch.plannedSignalIds.length === 0) {
			diagnostics.push(
				lintDiagnostic({
					severity: "error",
					code: "reference.missing_signal",
					path: ["branch_evidence", branchIndex, "planned_signal_ids"],
					message: "required branch evidence must reference at least one verification signal",
					guidance: "Add a planned_signal_ids[] entry for each required branch.",
					offender: { kind: "signal", id: branch.branch },
				}),
			);
		}
		branch.plannedSignalIds.forEach((signalId, signalIndex) => {
			if (signalIds.has(signalId)) return;
			diagnostics.push(
				lintDiagnostic({
					severity: "error",
					code: "reference.unknown_signal",
					path: ["branch_evidence", branchIndex, "planned_signal_ids", signalIndex],
					message: `branch evidence references unknown signal ${signalId}`,
					guidance: "Use an id from verification_signals[].id.",
					offender: { kind: "signal", id: signalId },
				}),
			);
		});
	});
	if (input.dryRun.status !== "passed" || input.dryRun.checks.some(check => !check.passed)) {
		diagnostics.push(
			lintDiagnostic({
				severity: "error",
				code: "dry_run.failed",
				path: ["dry_run"],
				message: "target plan dry run must pass before approval",
				guidance: "Run the deterministic plan dry run and fix failed checks before submission.",
				offender: { kind: "schema", id: "dry_run", value: input.dryRun.status },
			}),
		);
	}
	diagnostics.push(...collectMatrixDiagnostics(input, options));
	diagnostics.push(...collectTargetCardDiagnostics(input, options.mode));
	diagnostics.push(...collectTargetUnitDiagnostics(input, options));
	return diagnostics;
}

export function validateTargetPlanSubmissionGraph(input: GoalTargetPlanGraphInput): void {
	const diagnostics = collectTargetPlanGraphDiagnostics(input, { mode: "submit" });
	const firstError = diagnostics.find(diagnostic => diagnostic.severity === "error");
	if (firstError) throw new Error(firstError.message);
}
