import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { replaceTabs, Text } from "@oh-my-pi/pi-tui";
import { formatNumber, isEnoent, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { z } from "zod/v4";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { resolveLocalUrlToPath } from "../../internal-urls";
import type { Theme, ThemeColor } from "../../modes/theme/theme";
import targetPlanSchemaReference from "../../prompts/goals/goal-target-plan-schema-reference.md" with { type: "text" };
import goalDescription from "../../prompts/tools/goal.md" with { type: "text" };
import { formatDuration } from "../../slash-commands/helpers/format";
import type { ToolSession } from "../../tools";
import { normalizeLocalScheme, resolveToCwd } from "../../tools/path-utils";
import { formatErrorDetail, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { ToolError } from "../../tools/tool-errors";
import { renderStatusLine, truncateToWidth } from "../../tui";
import {
	completionBudgetReport,
	currentTargetPlanSubmitIdentity,
	type GoalCheckpointInput,
	type GoalCheckpointResolutionInput,
	type GoalRecoverBlockedStateInput,
	type GoalStartTargetInput,
	type GoalSubmitTargetPlanInput,
	type GoalTargetPlanFailureInput,
	remainingTokens,
	targetPlanPayloadFilePath,
} from "../runtime";
import type {
	Goal,
	GoalBoundaryKind,
	GoalCheckpointPacket,
	GoalCheckpointResolution,
	GoalCheckpointReview,
	GoalCompletionVerificationDetails,
	GoalGateStatus,
	GoalModeState,
	GoalParentFrame,
	GoalParentStateDelta,
	GoalRefKind,
	GoalResidualClassification,
	GoalStatus,
	GoalTargetPlanApprovedDetails,
	GoalTargetPlanLintDiagnostic,
	GoalTargetPlanLintResult,
	GoalTargetPlanRecord,
	GoalTargetPlanRepairPatch,
	GoalTargetPlanReview,
	GoalToolDetails,
	GoalToolGoalSummary,
	GoalToolStateSummary,
} from "../state";
import { normalizeParentFrame } from "../state";
import { buildGoalToolDetails, type GoalToolDetailSource } from "../tool-details";

const deliverableStatusSchema = z.enum(["pending", "partial", "satisfied", "blocked", "stale"]);

const refKindSchema = z.enum(["doc", "issue", "artifact", "test", "commit", "external-record", "other"]);
const refSchema = z
	.object({
		id: z.string(),
		kind: refKindSchema,
		label: z.string().optional(),
		uri: z.string().optional(),
	})
	.strict();
const deliverableDeltaSchema = z
	.object({
		id: z.string(),
		summary: z.string().optional(),
		status: deliverableStatusSchema.optional(),
		evidence_refs: z.array(refSchema).optional(),
		blocked_by: z.array(z.string()).optional(),
		next_relevant_target: z.string().optional(),
	})
	.strict();

const claimSchema = z
	.object({
		id: z.string(),
		claim: z.string(),
		status: z.enum(["accepted", "candidate", "rejected", "stale"]),
		scope: z.string().optional(),
		evidence_refs: z.array(refSchema).optional(),
		non_implications: z.array(z.string()).optional(),
		accepted_by: z.string().optional(),
		accepted_at: z.number().optional(),
	})
	.strict();

const boundarySchema = z
	.object({
		id: z.string(),
		kind: z.enum([
			"non-claim",
			"forbidden-inference",
			"unsupported",
			"local-only",
			"mock-only",
			"unavailable",
			"stale-path",
		]),
		statement: z.string(),
		refs: z.array(refSchema).optional(),
	})
	.strict();

const residualSchema = z
	.object({
		id: z.string(),
		statement: z.string(),
		classification: z.enum([
			"current-parent-blocker",
			"accepted-risk",
			"future-frontier",
			"decision-needed",
			"architecture-debt",
			"anti-laundering-non-claim",
			"local-shortcut",
			"capability-gap",
			"rejected-or-stale-path",
			"unspecified",
		]),
		why_it_matters: z.string().optional(),
		required_evidence: z.array(z.string()).optional(),
		target_horizon: z.string().optional(),
		authority_required: z.string().optional(),
		non_implications: z.array(z.string()).optional(),
		refs: z.array(refSchema).optional(),
	})
	.strict();

const gateSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		status: z.enum(["unknown", "passed", "failed", "stale", "not-applicable"]),
		required_evidence: z.array(z.string()),
		evidence_refs: z.array(refSchema).optional(),
		non_claims: z.array(z.string()).optional(),
		stale_if: z.array(z.string()).optional(),
	})
	.strict();

const frontierSchema = z
	.object({
		id: z.string(),
		statement: z.string(),
		evidence_required: z.array(z.string()).optional(),
		activation_trigger: z.string().optional(),
		refs: z.array(refSchema).optional(),
	})
	.strict();

const parentFrameSchema = z
	.object({
		kind: z.enum(["plain", "claim-gated"]).optional(),
		desired_future: z.string().optional(),
		current_truth: z.string().optional(),
		baseline_refs: z.array(refSchema).optional(),
		accepted_claims: z.array(claimSchema).optional(),
		candidate_claims: z.array(claimSchema).optional(),
		rejected_or_stale_claims: z.array(claimSchema).optional(),
		boundaries: z.array(boundarySchema).optional(),
		residuals: z.array(residualSchema).optional(),
		gates: z.array(gateSchema).optional(),
		frontier: z.array(frontierSchema).optional(),
		stale_if: z.array(z.string()).optional(),
		authority: z
			.object({
				parent_state_authority: z.string().optional(),
				risk_acceptance_authority: z.string().optional(),
				external_record_authority: z.string().optional(),
				worker_may_only_propose: z.boolean().optional(),
			})
			.strict()
			.optional(),
		external_refs: z.array(refSchema).optional(),
		last_parent_delta_id: z.string().optional(),
	})
	.strict();

const evidenceSchema = z
	.object({
		claim: z.string(),
		evidence: z.string(),
		current: z.boolean(),
	})
	.strict();

const VERIFICATION_LAYER_VALUES = ["unit", "integration", "e2e", "manual", "product", "release-gate"] as const;
const SIGNAL_ROLE_VALUES = ["primary", "supporting", "guardrail"] as const;
const SIGNAL_CONFIDENCE_VALUES = ["low", "medium", "high"] as const;
const BLAST_RADIUS_VALUES = ["local", "module", "workflow", "multi-subsystem", "external-or-irreversible"] as const;
const CONCERN_KIND_VALUES = [
	"behavior",
	"contract",
	"state-persistence",
	"error-handling",
	"security",
	"performance",
	"migration",
	"ux-manual",
	"docs-or-operator",
] as const;
const EXCLUDED_WORK_CLASSIFICATION_VALUES = [
	"valid-boundary",
	"parent-non-claim",
	"essential-related-work",
	"stale-or-unsupported",
] as const;
const TARGET_PLAN_DEPTH_VALUES = ["light", "standard", "trust-heavy"] as const;
const WORKSTREAM_KIND_VALUES = ["main", "backend-rust", "app-ui", "e2e-harness", "docs-changelog", "other"] as const;
const DEFERRED_RELATED_WORK_REASON_VALUES = [
	"different-primary-signal",
	"different-authority",
	"different-blast-radius",
	"blocked-external",
	"non-goal",
] as const;
const SCENARIO_MATRIX_OPEN_ROW_REASON_VALUES = [...DEFERRED_RELATED_WORK_REASON_VALUES, "unsafe-to-bundle"] as const;

const verificationLayerSchema = z.enum(VERIFICATION_LAYER_VALUES);
const signalRoleSchema = z.enum(SIGNAL_ROLE_VALUES);
const signalConfidenceSchema = z.enum(SIGNAL_CONFIDENCE_VALUES);
const blastRadiusSchema = z.enum(BLAST_RADIUS_VALUES);
const concernKindSchema = z.enum(CONCERN_KIND_VALUES);
const excludedWorkClassificationSchema = z.enum(EXCLUDED_WORK_CLASSIFICATION_VALUES);
const targetPlanDepthSchema = z.enum(TARGET_PLAN_DEPTH_VALUES);
const workstreamKindSchema = z.enum(WORKSTREAM_KIND_VALUES);
type VerificationLayerValue = (typeof VERIFICATION_LAYER_VALUES)[number];
type ConcernKindValue = (typeof CONCERN_KIND_VALUES)[number];

const CONCERN_KIND_LAYER_ALIASES: Record<ConcernKindValue, VerificationLayerValue> = {
	behavior: "integration",
	contract: "integration",
	"state-persistence": "integration",
	"error-handling": "unit",
	security: "integration",
	performance: "integration",
	migration: "integration",
	"ux-manual": "manual",
	"docs-or-operator": "manual",
};

const verificationApertureSchema = z
	.object({
		product_intention: z.string(),
		primary_signal_id: z.string(),
		blast_radius: blastRadiusSchema,
		confidence_target: signalConfidenceSchema,
		blast_radius_scope: z.string().optional(),
		confidence_rationale: z.string().optional(),
		layer_rationale: z.string(),
		residual_uncertainty: z.array(z.string()),
		omitted_layers: z.array(
			z
				.object({
					layer: verificationLayerSchema,
					reason: z.string(),
				})
				.strict(),
		),
	})
	.strict();

const verificationSignalSchema = z
	.object({
		id: z.string(),
		role: signalRoleSchema,
		layer: verificationLayerSchema,
		concern_ids: z.array(z.string()),
		claim: z.string(),
		observation: z.string(),
		method: z.string(),
		expected_outcome: z.string(),
		required: z.boolean(),
		confidence_if_satisfied: signalConfidenceSchema,
		confidence_rationale: z.string().optional(),
		stale_if: z.array(z.string()),
	})
	.strict();

const concernCheckSchema = z
	.object({
		id: z.string(),
		kind: concernKindSchema,
		why_independent: z.string(),
		lens: z.string().optional(),
		covered_by_signal_ids: z.array(z.string()),
	})
	.strict();

const scopeCalibrationSchema = z
	.object({
		right_sizing_basis: z.enum([
			"product-signal",
			"minimum-domain-unit",
			"verifier-repair",
			"external-authority-slice",
		]),
		right_sizing_rationale: z.string().optional(),
		why_not_smaller: z.array(z.string()),
		why_not_larger: z.array(z.string()),
		included_related_work: z.array(
			z
				.object({
					item: z.string(),
					reason: z.string(),
					signal_ids: z.array(z.string()),
				})
				.strict(),
		),
		deferred_related_work: z.array(
			z
				.object({
					item: z.string(),
					reason: z.enum(DEFERRED_RELATED_WORK_REASON_VALUES),
					follow_up_hint: z.string().optional(),
					rationale: z.string().optional(),
				})
				.strict(),
		),
		target_unit_rule_ids: z.array(z.string()).optional(),
		target_unit_exemptions: z.array(z.object({ rule_id: z.string(), rationale: z.string() }).strict()).optional(),
	})
	.strict();

const branchEvidenceSchema = z
	.object({
		branch: z.string(),
		required: z.boolean(),
		planned_signal_ids: z.array(z.string()),
		row_ids: z.array(z.string()).optional(),
		rationale: z.string(),
	})
	.strict();

const excludedWorkReviewSchema = z
	.object({
		item: z.string(),
		classification: excludedWorkClassificationSchema,
		rationale: z.string(),
	})
	.strict();

const scenarioMatrixRowSchema = z
	.object({
		id: z.string(),
		branch: z.string(),
		signal_ids: z.array(z.string()),
		concern_ids: z.array(z.string()),
		acceptance: z.string(),
		expected_outcome: z.string(),
		stale_if: z.array(z.string()),
	})
	.strict();

const scenarioMatrixOpenRowSchema = z
	.object({
		id: z.string(),
		branch: z.string(),
		reason: z.enum(SCENARIO_MATRIX_OPEN_ROW_REASON_VALUES),
		rationale: z.string().optional(),
		follow_up_hint: z.string(),
	})
	.strict();

const scenarioMatrixSchema = z
	.object({
		id: z.string(),
		primary_signal_group_id: z.string(),
		rows_in_scope: z.array(scenarioMatrixRowSchema),
		rows_left_open: z.array(scenarioMatrixOpenRowSchema),
		splitting_safety: z.object({ safe: z.boolean(), rationale: z.string() }).strict(),
		next_larger_target: z
			.object({
				title: z.string(),
				primary_signal_group_id: z.string(),
				rows: z.array(z.string()),
				unblocks_matrix_id: z.string().optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

const targetWorkstreamSchema = z
	.object({
		id: z.string(),
		label: z.string(),
		kind: workstreamKindSchema,
		role: z.string().optional(),
		files: z.array(z.string()),
		contract_inputs: z.array(z.string()),
		contract_outputs: z.array(z.string()),
	})
	.strict();

const targetCardSchema = z
	.object({
		capability_claim: z.string(),
		trust_privacy_claim: z.string().optional(),
		confidence_earned: z.string().optional(),
		known_limits: z.array(z.string()),
		authority_boundary: z.string().optional(),
		policy_deletion_implications: z.string().optional(),
		user_visible_surface: z.string(),
		acceptance_rows: z.object({ closed: z.array(z.string()), open: z.array(z.string()) }).strict(),
		workstreams: z.array(targetWorkstreamSchema).optional(),
		shared_contract: z.string().optional(),
		review_lenses: z.array(z.string()).optional(),
		verification_scenarios: z.array(z.string()),
		checkpoint_evidence: z.array(z.string()),
		rollback_cutover: z.string().optional(),
	})
	.strict();

const workflowReviewRoundSchema = z
	.object({
		lens: z.string(),
		verdict: z.enum(["accepted", "revision-required"]),
		summary: z.string(),
		blockers: z.array(z.string()),
		revised: z.boolean(),
	})
	.strict();

const targetPlanDryRunSchema = z
	.object({
		status: z.enum(["passed", "failed"]),
		checks: z.array(
			z
				.object({
					id: z.string(),
					passed: z.boolean(),
					rationale: z.string(),
				})
				.strict(),
		),
	})
	.strict();

const targetFields = {
	title: z.string(),
	desired_future_claim: z.string(),
	closure_standard: z.string(),
	expected_parent_contribution: z.string().optional(),
	baseline_refs: z.array(refSchema).optional(),
	gate_refs: z.array(z.string()).optional(),
	evidence_expectation: z.array(z.string()).optional(),
	non_goals: z.array(z.string()).optional(),
	forbidden_claims: z.array(z.string()).optional(),
	stale_if: z.array(z.string()).optional(),
	linked_verifier_blocker_ids: z.array(z.string()).optional(),
	parent_deliverable_ids: z.array(z.string()).optional(),
};
const targetSchema = z.object(targetFields).strict();
const resolveTargetSchema = z.object(targetFields);
const emptyTargetSchema = z.record(z.string(), z.never());
const maybeTargetSchema = z.union([resolveTargetSchema, emptyTargetSchema]);
type TargetParams = z.infer<typeof targetSchema>;
type MaybeTargetParams = z.infer<typeof maybeTargetSchema>;

function hasNonWhitespace(value: string | undefined): boolean {
	if (!value) return false;
	for (let index = 0; index < value.length; index++) {
		const char = value.charCodeAt(index);
		if (char !== 9 && char !== 10 && char !== 11 && char !== 12 && char !== 13 && char !== 32) return true;
	}
	return false;
}

function hasArrayEntries(value: readonly unknown[] | undefined): boolean {
	return value !== undefined && value.length > 0;
}

function isTargetParams(value: MaybeTargetParams): value is TargetParams {
	return "title" in value && "desired_future_claim" in value && "closure_standard" in value;
}

function isEffectivelyEmptyTarget(value: MaybeTargetParams): boolean {
	if (!isTargetParams(value)) return true;
	return (
		!hasNonWhitespace(value.title) &&
		!hasNonWhitespace(value.desired_future_claim) &&
		!hasNonWhitespace(value.closure_standard) &&
		!hasNonWhitespace(value.expected_parent_contribution) &&
		!hasArrayEntries(value.baseline_refs) &&
		!hasArrayEntries(value.gate_refs) &&
		!hasArrayEntries(value.evidence_expectation) &&
		!hasArrayEntries(value.non_goals) &&
		!hasArrayEntries(value.forbidden_claims) &&
		!hasArrayEntries(value.stale_if) &&
		!hasArrayEntries(value.linked_verifier_blocker_ids) &&
		!hasArrayEntries(value.parent_deliverable_ids)
	);
}

const gateDeltaSchema = z
	.object({
		gate_id: z.string(),
		status: z.enum(["unknown", "passed", "failed", "stale", "not-applicable"]),
		evidence_refs: z.array(refSchema).optional(),
		rationale: z.string().optional(),
	})
	.strict();

const parentDeltaSchema = z
	.object({
		admitted_claims: z.array(claimSchema).optional(),
		candidate_claims_added: z.array(claimSchema).optional(),
		rejected_claims: z.array(claimSchema).optional(),
		boundaries_added: z.array(boundarySchema).optional(),
		residuals_added_or_updated: z.array(residualSchema).optional(),
		gate_deltas: z.array(gateDeltaSchema).optional(),
		frontier_deltas: z.array(frontierSchema).optional(),
		stale_refs: z.array(refSchema).optional(),
		external_record_refs: z.array(refSchema).optional(),
		authority_decision_refs: z.array(refSchema).optional(),
		deliverable_deltas: z.array(deliverableDeltaSchema).optional(),
	})
	.strict();

const createSchema = z
	.object({
		op: z.literal("create"),
		objective: z.string().describe("parent goal objective"),
		token_budget: z.number().int().describe("token budget").optional(),
		parent_frame: parentFrameSchema.optional(),
	})
	.strict();
const getSchema = z.object({ op: z.literal("get") }).strict();
const resumeSchema = z.object({ op: z.literal("resume") }).strict();
const dropSchema = z.object({ op: z.literal("drop") }).strict();
const completeSchema = z.object({ op: z.literal("complete") }).strict();
const startTargetSchema = targetSchema.extend({ op: z.literal("start_target") }).strict();
const checkpointSchema = z
	.object({
		op: z.literal("checkpoint"),
		status: z.literal("closed_with_evidence"),
		summary: z.string(),
		local_claims: z.array(z.string()).min(1),
		evidence: z.array(evidenceSchema).min(1),
		not_claimed: z.array(z.string()).min(1),
		remaining_questions: z.array(z.string()).min(1),
		checks_run: z.array(z.string()).optional(),
		artifacts_touched: z.array(z.string()).optional(),
		risks_or_caveats: z.array(z.string()).optional(),
		stale_if: z.array(z.string()).optional(),
		suggested_controller_questions: z.array(z.string()).optional(),
		retrospective_target: targetSchema.optional(),
	})
	.strict();
const resolveCheckpointSchema = z
	.object({
		op: z.literal("resolve_checkpoint"),
		checkpoint_id: z.string(),
		decision: z.enum([
			"next_target",
			"parent_completion_candidate",
			"needs_user_input",
			"needs_broader_checks",
			"pause_for_external_control",
			"drop_or_replace_recommended",
		]),
		parent_reading: z.string(),
		parent_delta: parentDeltaSchema.optional(),
		not_propagated: z.array(z.string()),
		remaining_parent_work: z.array(z.string()),
		broader_checks_or_inputs: z.array(z.string()).optional(),
		lessons_for_future: z.array(z.string()).optional(),
		next_target: maybeTargetSchema.optional(),
	})
	.strict()
	.refine(
		value =>
			value.decision !== "next_target" || (value.next_target !== undefined && isTargetParams(value.next_target)),
		{
			message: "next_target is required when decision is next_target",
			path: ["next_target"],
		},
	)
	.refine(
		value =>
			value.decision === "next_target" ||
			value.next_target === undefined ||
			isEffectivelyEmptyTarget(value.next_target),
		{
			message: "next_target is only allowed when decision is next_target",
			path: ["next_target"],
		},
	);

const targetPlanPayloadShape = {
	target_id: z.string(),
	target_plan_id: z.string(),
	plan_file_path: z.string(),
	revision: z.number().int().min(1),
	primary_signal_group_id: z.string().optional(),
	plan_depth: targetPlanDepthSchema.optional(),
	scenario_matrix: scenarioMatrixSchema.nullable().optional(),
	target_card: targetCardSchema.optional(),
	verification_aperture: verificationApertureSchema,
	verification_signals: z.array(verificationSignalSchema).min(1),
	concern_checks: z.array(concernCheckSchema).min(1),
	scope_calibration: scopeCalibrationSchema,
	branch_evidence: z.array(branchEvidenceSchema).min(1),
	excluded_work_review: z.array(excludedWorkReviewSchema),
	workflow_review_rounds: z.array(workflowReviewRoundSchema).min(1),
	dry_run: targetPlanDryRunSchema,
};
const targetPlanPayloadSchema = z.object(targetPlanPayloadShape).strict();
const TARGET_PLAN_PAYLOAD_FIELD_ALIASES: Record<string, string> = {
	targetId: "target_id",
	targetPlanId: "target_plan_id",
	planFilePath: "plan_file_path",
	primarySignalId: "primary_signal_id",
	verificationAperture: "verification_aperture",
	verificationSignals: "verification_signals",
	concernChecks: "concern_checks",
	scopeCalibration: "scope_calibration",
	branchEvidence: "branch_evidence",
	excludedWorkReview: "excluded_work_review",
	scenarioMatrix: "scenario_matrix",
	targetCard: "target_card",
	primarySignalGroupId: "primary_signal_group_id",
	planDepth: "plan_depth",
	concernIds: "concern_ids",
	expectedOutcome: "expected_outcome",
	confidenceIfSatisfied: "confidence_if_satisfied",
	staleIf: "stale_if",
	coveredBySignalIds: "covered_by_signal_ids",
	plannedSignalIds: "planned_signal_ids",
	rowsInScope: "rows_in_scope",
	rowsLeftOpen: "rows_left_open",
	acceptanceRows: "acceptance_rows",
	knownLimits: "known_limits",
	verificationScenarios: "verification_scenarios",
	checkpointEvidence: "checkpoint_evidence",
	workflowReviewRounds: "workflow_review_rounds",
	dryRun: "dry_run",
	productIntention: "product_intention",
	confidenceTarget: "confidence_target",
	blastRadiusScope: "blast_radius_scope",
	confidenceRationale: "confidence_rationale",
	layerRationale: "layer_rationale",
	residualUncertainty: "residual_uncertainty",
	omittedLayers: "omitted_layers",
	whyIndependent: "why_independent",
	rightSizingBasis: "right_sizing_basis",
	rightSizingRationale: "right_sizing_rationale",
	whyNotSmaller: "why_not_smaller",
	whyNotLarger: "why_not_larger",
	includedRelatedWork: "included_related_work",
	deferredRelatedWork: "deferred_related_work",
	signalIds: "signal_ids",
	rowIds: "row_ids",
	followUpHint: "follow_up_hint",
	targetUnitRuleIds: "target_unit_rule_ids",
	targetUnitExemptions: "target_unit_exemptions",
	ruleId: "rule_id",
	splittingSafety: "splitting_safety",
	nextLargerTarget: "next_larger_target",
	unblocksMatrixId: "unblocks_matrix_id",
	capabilityClaim: "capability_claim",
	trustPrivacyClaim: "trust_privacy_claim",
	confidenceEarned: "confidence_earned",
	authorityBoundary: "authority_boundary",
	policyDeletionImplications: "policy_deletion_implications",
	userVisibleSurface: "user_visible_surface",
	sharedContract: "shared_contract",
	reviewLenses: "review_lenses",
	rollbackCutover: "rollback_cutover",
	contractInputs: "contract_inputs",
	contractOutputs: "contract_outputs",
};
const submitTargetPlanInlineSchema = z
	.object({
		op: z.literal("submit_target_plan"),
		...targetPlanPayloadShape,
	})
	.strict();
const submitTargetPlanSchema = z
	.object({ op: z.literal("submit_target_plan"), payload_file_path: z.string().min(1) })
	.strict();
const lintTargetPlanSchema = z
	.object({ op: z.literal("lint_target_plan"), payload_file_path: z.string().min(1) })
	.strict();
const targetPlanSchemaReferenceSchema = z.object({ op: z.literal("target_plan_schema") }).strict();

const failTargetPlanSchema = z
	.object({
		op: z.literal("fail_target_plan"),
		target_id: z.string(),
		target_plan_id: z.string(),
		revision: z.number().int().min(1),
		reason: z.enum([
			"needs-user-input",
			"task-unavailable",
			"external-authority",
			"unable-to-find-right-sized-target",
		]),
		message: z.string(),
		blockers: z.array(z.string()),
		suggested_questions: z.array(z.string()),
	})
	.strict();

const recoveryReasonSchema = z.enum(["user-input", "broader-checks", "external-authority", "state-refresh"]);

const recoverBlockedStateSchema = z
	.object({
		op: z.literal("recover_blocked_state"),
		kind: z.enum(["target-plan", "checkpoint-external-pause"]),
		action: z.enum(["restart_target_planning", "start_next_target", "enter_parent_completion"]),
		blocked_state_id: z.string(),
		target_id: z.string().optional(),
		target_plan_id: z.string().optional(),
		revision: z.number().int().min(1).optional(),
		source_status: z.enum(["failed", "stale"]).optional(),
		checkpoint_id: z.string().optional(),
		checkpoint_resolution_id: z.string().optional(),
		reason: recoveryReasonSchema,
		guidance: z.string().min(1),
		parent_delta: parentDeltaSchema.optional(),
		next_target: maybeTargetSchema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.kind === "target-plan") {
			if (value.action !== "restart_target_planning") {
				context.addIssue({
					code: "custom",
					path: ["action"],
					message: "target-plan recovery requires action restart_target_planning",
				});
			}
			for (const field of ["target_id", "target_plan_id", "revision", "source_status"] as const) {
				if (value[field] === undefined) {
					context.addIssue({
						code: "custom",
						path: [field],
						message: `${field} is required for target-plan recovery`,
					});
				}
			}
			return;
		}
		if (value.action === "restart_target_planning") {
			context.addIssue({
				code: "custom",
				path: ["action"],
				message: "checkpoint-external-pause recovery cannot restart target planning",
			});
		}
		for (const field of ["checkpoint_id", "checkpoint_resolution_id"] as const) {
			if (value[field] === undefined) {
				context.addIssue({
					code: "custom",
					path: [field],
					message: `${field} is required for checkpoint-external-pause recovery`,
				});
			}
		}
		if (value.action === "start_next_target") {
			if (value.next_target === undefined || !isTargetParams(value.next_target)) {
				context.addIssue({
					code: "custom",
					path: ["next_target"],
					message: "next_target is required when action is start_next_target",
				});
			}
			return;
		}
		if (value.next_target !== undefined) {
			context.addIssue({
				code: "custom",
				path: ["next_target"],
				message: "next_target is not allowed when action is enter_parent_completion",
			});
		}
	});

const goalDiscriminatedSchema = z.discriminatedUnion("op", [
	createSchema,
	getSchema,
	resumeSchema,
	dropSchema,
	completeSchema,
	startTargetSchema,
	checkpointSchema,
	resolveCheckpointSchema,
	submitTargetPlanSchema,
	lintTargetPlanSchema,
	targetPlanSchemaReferenceSchema,
	failTargetPlanSchema,
	recoverBlockedStateSchema,
]);

const goalSchema = goalDiscriminatedSchema;
const goalOperationSchema = z.looseObject({ op: z.string() });

export type GoalToolInput = z.infer<typeof goalSchema>;

interface GoalSessionSupport {
	createGoalWithRubric?(
		input: { objective: string; tokenBudget?: number; parentFrame?: GoalParentFrame },
		signal?: AbortSignal,
	): Promise<GoalModeState>;
	requestGoalCompletion?(signal?: AbortSignal): Promise<GoalToolResponse>;
	requestGoalCheckpoint?(input: GoalCheckpointInput, signal?: AbortSignal): Promise<GoalToolResponse>;
	requestGoalCheckpointResolution?(
		input: GoalCheckpointResolutionInput,
		signal?: AbortSignal,
	): Promise<GoalToolResponse>;
	requestGoalTargetPlanApproval?(input: GoalSubmitTargetPlanInput, signal?: AbortSignal): Promise<GoalToolResponse>;
	requestGoalTargetPlanFailure?(input: GoalTargetPlanFailureInput, signal?: AbortSignal): Promise<GoalToolResponse>;
}

export interface GoalToolResponse extends GoalToolDetailSource {
	goal: Goal | null;
	state?: GoalModeState | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
	completionVerification?: GoalCompletionVerificationDetails;
	checkpoint?: GoalCheckpointPacket;
	checkpointReview?: GoalCheckpointReview;
	checkpointResolution?: GoalCheckpointResolution;
	targetPlan?: GoalTargetPlanRecord;
	targetPlanReviews?: GoalTargetPlanReview[];
	targetPlanApproval?: GoalTargetPlanApprovedDetails;
}

export function buildGoalToolResponse(
	goal: Goal | null | undefined,
	options?: {
		state?: GoalModeState | null;
		includeCompletionReport?: boolean;
		completionVerification?: GoalCompletionVerificationDetails;
		checkpoint?: GoalCheckpointPacket;
		checkpointReview?: GoalCheckpointReview;
		checkpointResolution?: GoalCheckpointResolution;
		targetPlan?: GoalTargetPlanRecord;
		targetPlanReviews?: GoalTargetPlanReview[];
		targetPlanApproval?: GoalTargetPlanApprovedDetails;
		targetPlanLint?: GoalTargetPlanLintResult;
	},
): GoalToolResponse {
	const resolvedGoal = goal ?? null;
	const completionVerification = normalizeCompletionVerification(resolvedGoal, options?.completionVerification);
	const completionBudget =
		completionVerification?.status === "rejected"
			? null
			: options?.includeCompletionReport && resolvedGoal?.status === "complete"
				? completionBudgetReport(resolvedGoal)
				: null;
	return {
		goal: resolvedGoal,
		state: options?.state,
		remainingTokens: remainingTokens(resolvedGoal),
		completionBudgetReport: completionBudget,
		completionVerification,
		checkpoint: options?.checkpoint,
		checkpointReview: options?.checkpointReview,
		checkpointResolution: options?.checkpointResolution,
		targetPlan: options?.targetPlan,
		targetPlanReviews: options?.targetPlanReviews,
		targetPlanApproval: options?.targetPlanApproval,
		targetPlanLint: options?.targetPlanLint,
	};
}

function normalizeCompletionVerification(
	goal: Goal | null,
	completionVerification: GoalCompletionVerificationDetails | undefined,
): GoalCompletionVerificationDetails | undefined {
	if (!completionVerification) return undefined;
	const { continuationMessage: _continuationMessage, ...visibleVerification } = completionVerification;
	if (
		visibleVerification.status === "rejected" &&
		!visibleVerification.compactorMemo &&
		goal?.lastVerificationCompactorMemo
	) {
		return { ...visibleVerification, compactorMemo: goal.lastVerificationCompactorMemo };
	}
	return visibleVerification;
}

function validateCreateParams(params: z.infer<typeof createSchema>): {
	objective: string;
	tokenBudget?: number;
	parentFrame?: GoalParentFrame;
} {
	const objective = params.objective?.trim();
	if (!objective) throw new ToolError("objective is required when op=create");
	const tokenBudget = params.token_budget;
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new ToolError("token_budget must be a positive integer when provided");
	}
	return { objective, tokenBudget, parentFrame: normalizeParentFrame(params.parent_frame, objective) };
}

function mapTargetInput(params: z.infer<typeof targetSchema>): GoalStartTargetInput {
	return {
		title: params.title,
		desiredFutureClaim: params.desired_future_claim,
		closureStandard: params.closure_standard,
		expectedParentContribution: params.expected_parent_contribution,
		baselineRefs: params.baseline_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		gateRefs: params.gate_refs,
		evidenceExpectation: params.evidence_expectation,
		nonGoals: params.non_goals,
		forbiddenClaims: params.forbidden_claims,
		staleIf: params.stale_if,
		linkedVerifierBlockerIds: params.linked_verifier_blocker_ids,
		parentDeliverableIds: params.parent_deliverable_ids,
	};
}

function mapCheckpointInput(params: z.infer<typeof checkpointSchema>): GoalCheckpointInput {
	return {
		status: params.status,
		summary: params.summary,
		localClaims: params.local_claims,
		evidence: params.evidence.map(item => ({ ...item })),
		notClaimed: params.not_claimed,
		remainingQuestions: params.remaining_questions,
		checksRun: params.checks_run,
		artifactsTouched: params.artifacts_touched,
		risksOrCaveats: params.risks_or_caveats,
		staleIf: params.stale_if,
		suggestedControllerQuestions: params.suggested_controller_questions,
		retrospectiveTarget: params.retrospective_target ? mapTargetInput(params.retrospective_target) : undefined,
	};
}

function mapParentDelta(input: z.infer<typeof parentDeltaSchema> | undefined): GoalParentStateDelta | undefined {
	if (!input) return undefined;
	return {
		admittedClaims: (input.admitted_claims ?? []).map(claim => ({
			id: claim.id,
			claim: claim.claim,
			status: claim.status,
			scope: claim.scope,
			evidenceRefs: claim.evidence_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
			nonImplications: claim.non_implications,
			acceptedBy: claim.accepted_by,
			acceptedAt: claim.accepted_at,
		})),
		candidateClaimsAdded: (input.candidate_claims_added ?? []).map(claim => ({
			id: claim.id,
			claim: claim.claim,
			status: claim.status,
			scope: claim.scope,
			evidenceRefs: claim.evidence_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
			nonImplications: claim.non_implications,
		})),
		rejectedClaims: (input.rejected_claims ?? []).map(claim => ({
			id: claim.id,
			claim: claim.claim,
			status: claim.status,
			scope: claim.scope,
			evidenceRefs: claim.evidence_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
			nonImplications: claim.non_implications,
		})),
		boundariesAdded: (input.boundaries_added ?? []).map(boundary => ({
			id: boundary.id,
			kind: boundary.kind as GoalBoundaryKind,
			statement: boundary.statement,
			refs: boundary.refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		})),
		residualsAddedOrUpdated: (input.residuals_added_or_updated ?? []).map(residual => ({
			id: residual.id,
			statement: residual.statement,
			classification: residual.classification as GoalResidualClassification,
			whyItMatters: residual.why_it_matters,
			requiredEvidence: residual.required_evidence,
			targetHorizon: residual.target_horizon,
			authorityRequired: residual.authority_required,
			nonImplications: residual.non_implications,
			refs: residual.refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		})),
		gateDeltas: (input.gate_deltas ?? []).map(gate => ({
			gateId: gate.gate_id,
			status: gate.status as GoalGateStatus,
			evidenceRefs: gate.evidence_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
			rationale: gate.rationale,
		})),
		frontierDeltas: (input.frontier_deltas ?? []).map(item => ({
			id: item.id,
			statement: item.statement,
			evidenceRequired: item.evidence_required,
			activationTrigger: item.activation_trigger,
			refs: item.refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		})),
		staleRefs: (input.stale_refs ?? []).map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		externalRecordRefs: (input.external_record_refs ?? []).map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		authorityDecisionRefs: input.authority_decision_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		deliverableDeltas: input.deliverable_deltas?.map(item => ({
			id: item.id,
			summary: item.summary,
			status: item.status,
			evidenceRefs: item.evidence_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
			blockedBy: item.blocked_by,
			nextRelevantTarget: item.next_relevant_target,
		})),
	};
}

function mapResolutionInput(params: z.infer<typeof resolveCheckpointSchema>): GoalCheckpointResolutionInput {
	return {
		checkpointId: params.checkpoint_id,
		decision: params.decision,
		parentReading: params.parent_reading,
		parentDelta: mapParentDelta(params.parent_delta),
		notPropagated: params.not_propagated,
		remainingParentWork: params.remaining_parent_work,
		broaderChecksOrInputs: params.broader_checks_or_inputs,
		lessonsForFuture: params.lessons_for_future,
		nextTarget:
			params.decision === "next_target" && params.next_target && isTargetParams(params.next_target)
				? mapTargetInput(params.next_target)
				: undefined,
	};
}

type TargetPlanPayloadParams = z.infer<typeof targetPlanPayloadSchema>;

function mapScenarioMatrix(params: z.infer<typeof scenarioMatrixSchema>): GoalSubmitTargetPlanInput["scenarioMatrix"] {
	return {
		id: params.id,
		primarySignalGroupId: params.primary_signal_group_id,
		rowsInScope: params.rows_in_scope.map(row => ({
			id: row.id,
			branch: row.branch,
			signalIds: row.signal_ids,
			concernIds: row.concern_ids,
			acceptance: row.acceptance,
			expectedOutcome: row.expected_outcome,
			staleIf: row.stale_if,
		})),
		rowsLeftOpen: params.rows_left_open.map(row => ({
			id: row.id,
			branch: row.branch,
			reason: row.reason,
			rationale: row.rationale,
			followUpHint: row.follow_up_hint,
		})),
		splittingSafety: {
			safe: params.splitting_safety.safe,
			rationale: params.splitting_safety.rationale,
		},
		nextLargerTarget: params.next_larger_target
			? {
					title: params.next_larger_target.title,
					primarySignalGroupId: params.next_larger_target.primary_signal_group_id,
					rows: params.next_larger_target.rows,
					unblocksMatrixId: params.next_larger_target.unblocks_matrix_id,
				}
			: undefined,
	};
}

function mapTargetCard(params: z.infer<typeof targetCardSchema>): GoalSubmitTargetPlanInput["targetCard"] {
	return {
		capabilityClaim: params.capability_claim,
		trustPrivacyClaim: params.trust_privacy_claim,
		confidenceEarned: params.confidence_earned,
		knownLimits: params.known_limits,
		authorityBoundary: params.authority_boundary,
		policyDeletionImplications: params.policy_deletion_implications,
		userVisibleSurface: params.user_visible_surface,
		acceptanceRows: {
			closed: params.acceptance_rows.closed,
			open: params.acceptance_rows.open,
		},
		workstreams: params.workstreams?.map(workstream => ({
			id: workstream.id,
			label: workstream.label,
			kind: workstream.kind,
			role: workstream.role,
			files: workstream.files,
			contractInputs: workstream.contract_inputs,
			contractOutputs: workstream.contract_outputs,
		})),
		sharedContract: params.shared_contract,
		reviewLenses: params.review_lenses,
		verificationScenarios: params.verification_scenarios,
		checkpointEvidence: params.checkpoint_evidence,
		rollbackCutover: params.rollback_cutover,
	};
}

function mapSubmitTargetPlanInput(
	params: TargetPlanPayloadParams & { op?: "submit_target_plan" },
): GoalSubmitTargetPlanInput {
	return {
		targetId: params.target_id,
		targetPlanId: params.target_plan_id,
		planFilePath: params.plan_file_path,
		revision: params.revision,
		primarySignalGroupId: params.primary_signal_group_id,
		planDepth: params.plan_depth,
		scenarioMatrix: params.scenario_matrix ? mapScenarioMatrix(params.scenario_matrix) : undefined,
		targetCard: params.target_card ? mapTargetCard(params.target_card) : undefined,
		verificationAperture: {
			productIntention: params.verification_aperture.product_intention,
			primarySignalId: params.verification_aperture.primary_signal_id,
			blastRadius: params.verification_aperture.blast_radius,
			blastRadiusScope: params.verification_aperture.blast_radius_scope,
			confidenceTarget: params.verification_aperture.confidence_target,
			confidenceRationale: params.verification_aperture.confidence_rationale,
			layerRationale: params.verification_aperture.layer_rationale,
			residualUncertainty: params.verification_aperture.residual_uncertainty,
			omittedLayers: params.verification_aperture.omitted_layers.map(layer => ({ ...layer })),
		},
		verificationSignals: params.verification_signals.map(signal => ({
			id: signal.id,
			role: signal.role,
			layer: signal.layer,
			concernIds: signal.concern_ids,
			claim: signal.claim,
			observation: signal.observation,
			method: signal.method,
			expectedOutcome: signal.expected_outcome,
			required: signal.required,
			confidenceIfSatisfied: signal.confidence_if_satisfied,
			confidenceRationale: signal.confidence_rationale,
			staleIf: signal.stale_if,
		})),
		concernChecks: params.concern_checks.map(check => ({
			id: check.id,
			kind: check.kind,
			whyIndependent: check.why_independent,
			lens: check.lens,
			coveredBySignalIds: check.covered_by_signal_ids,
		})),
		scopeCalibration: {
			rightSizingBasis: params.scope_calibration.right_sizing_basis,
			rightSizingRationale: params.scope_calibration.right_sizing_rationale,
			whyNotSmaller: params.scope_calibration.why_not_smaller,
			whyNotLarger: params.scope_calibration.why_not_larger,
			includedRelatedWork: params.scope_calibration.included_related_work.map(item => ({
				item: item.item,
				reason: item.reason,
				signalIds: item.signal_ids,
			})),
			deferredRelatedWork: params.scope_calibration.deferred_related_work.map(item => ({
				item: item.item,
				reason: item.reason,
				rationale: item.rationale,
				followUpHint: item.follow_up_hint,
			})),
			targetUnitRuleIds: params.scope_calibration.target_unit_rule_ids,
			targetUnitExemptions: params.scope_calibration.target_unit_exemptions?.map(exemption => ({
				ruleId: exemption.rule_id,
				rationale: exemption.rationale,
			})),
		},
		branchEvidence: params.branch_evidence.map(branch => ({
			branch: branch.branch,
			required: branch.required,
			plannedSignalIds: branch.planned_signal_ids,
			rowIds: branch.row_ids,
			rationale: branch.rationale,
		})),
		excludedWorkReview: params.excluded_work_review.map(item => ({
			item: item.item,
			classification: item.classification,
			rationale: item.rationale,
		})),
		workflowReviewRounds: params.workflow_review_rounds.map(round => ({ ...round })),
		dryRun: {
			status: params.dry_run.status,
			checks: params.dry_run.checks.map(check => ({ ...check })),
		},
	};
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getRecordValue(value: unknown, key: string): unknown {
	return isRecordValue(value) ? value[key] : undefined;
}

function getValueAtIssuePath(value: unknown, path: readonly PropertyKey[]): unknown {
	let current = value;
	for (const segment of path) {
		if (typeof segment === "number") {
			current = Array.isArray(current) ? current[segment] : undefined;
		} else {
			current = getRecordValue(current, String(segment));
		}
		if (current === undefined) return undefined;
	}
	return current;
}

function formatDiagnosticValue(value: unknown): string {
	if (typeof value === "string") return `"${value}"`;
	if (value === undefined) return "missing";
	return JSON.stringify(value) ?? String(value);
}

function requiredVerificationSignalIds(params: unknown): string[] {
	const signals = getRecordValue(params, "verification_signals");
	if (!Array.isArray(signals)) return [];
	const ids: string[] = [];
	for (const signal of signals) {
		if (getRecordValue(signal, "required") !== true) continue;
		const id = getRecordValue(signal, "id");
		if (typeof id === "string" && id.length > 0) ids.push(id);
	}
	return ids;
}
function normalizeVerificationLayerAlias(value: unknown): VerificationLayerValue | undefined {
	return typeof value === "string" && value in CONCERN_KIND_LAYER_ALIASES
		? CONCERN_KIND_LAYER_ALIASES[value as ConcernKindValue]
		: undefined;
}

function isTargetPlanPayloadOperation(op: unknown): op is "submit_target_plan" | "lint_target_plan" {
	return op === "submit_target_plan" || op === "lint_target_plan";
}

function normalizeTargetPlanLayerAliases(params: unknown): unknown {
	if (!params || typeof params !== "object" || Array.isArray(params)) return params;
	const op = getRecordValue(params, "op");
	if (op !== undefined && !isTargetPlanPayloadOperation(op)) return params;
	const signals = getRecordValue(params, "verification_signals");
	if (!Array.isArray(signals)) return params;
	let normalizedSignals: unknown[] | undefined;
	for (let index = 0; index < signals.length; index += 1) {
		const signal = signals[index];
		const normalizedLayer = normalizeVerificationLayerAlias(getRecordValue(signal, "layer"));
		if (!normalizedLayer || !signal || typeof signal !== "object" || Array.isArray(signal)) continue;
		normalizedSignals ??= signals.slice();
		normalizedSignals[index] = { ...signal, layer: normalizedLayer };
	}
	return normalizedSignals ? { ...params, verification_signals: normalizedSignals } : params;
}

function layerAliasHint(value: unknown): string {
	if (typeof value === "string" && value in CONCERN_KIND_LAYER_ALIASES) {
		const normalized = CONCERN_KIND_LAYER_ALIASES[value as ConcernKindValue];
		return ` ${formatDiagnosticValue(value)} is a concern_checks[].kind value, not a verification layer; use a verification layer such as ${formatDiagnosticValue(normalized)}.`;
	}
	return "";
}

function jsonPointerPath(path: readonly PropertyKey[]): string {
	if (path.length === 0) return "";
	return `/${path.map(segment => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function targetPlanPayloadFieldAlias(alias: string): string | undefined {
	return TARGET_PLAN_PAYLOAD_FIELD_ALIASES[alias];
}

function unrecognizedAliasEntries(
	issue: z.ZodError["issues"][number],
): Array<{ alias: string; canonical: string; aliasPath: PropertyKey[]; canonicalPath: PropertyKey[] }> | undefined {
	if (issue.code !== "unrecognized_keys") return undefined;
	const entries = issue.keys.flatMap(alias => {
		const canonical = targetPlanPayloadFieldAlias(alias);
		return canonical
			? [{ alias, canonical, aliasPath: [...issue.path, alias], canonicalPath: [...issue.path, canonical] }]
			: [];
	});
	return entries.length > 0 ? entries : undefined;
}

function firstUnrecognizedAlias(
	issue: z.ZodError["issues"][number],
): { alias: string; canonical: string; aliasPath: PropertyKey[]; canonicalPath: PropertyKey[] } | undefined {
	return unrecognizedAliasEntries(issue)?.[0];
}

function collectAliasCanonicalDiagnosticPaths(error: z.ZodError): Set<string> {
	const paths = new Set<string>();
	for (const issue of error.issues) {
		const entries = unrecognizedAliasEntries(issue);
		if (!entries) continue;
		for (const entry of entries) paths.add(jsonPointerPath(entry.canonicalPath));
	}
	return paths;
}

function isMissingCanonicalForAlias(issue: z.ZodError["issues"][number], aliasCanonicalPaths: Set<string>): boolean {
	return (
		issue.code === "invalid_type" &&
		"input" in issue &&
		issue.input === undefined &&
		aliasCanonicalPaths.has(jsonPointerPath(issue.path))
	);
}

function targetPlanAliasRepairPatches(
	params: unknown,
	parentPath: readonly PropertyKey[],
	alias: string,
	canonical: string,
): GoalTargetPlanRepairPatch[] | undefined {
	const parent = getValueAtIssuePath(params, parentPath);
	if (!isRecordValue(parent) || Object.hasOwn(parent, canonical)) return undefined;
	return [
		{
			description: `Rename ${alias} to ${canonical}.`,
			operations: [
				{ op: "add", path: jsonPointerPath([...parentPath, canonical]), value: parent[alias] },
				{ op: "remove", path: jsonPointerPath([...parentPath, alias]) },
			],
		},
	];
}

function unrecognizedKeyDiagnostics(
	issue: z.ZodError["issues"][number],
	params: unknown,
): GoalTargetPlanLintDiagnostic[] {
	if (issue.code !== "unrecognized_keys") {
		return [
			{
				severity: "error",
				code: schemaDiagnosticCode(issue),
				path: jsonPointerPath(issue.path),
				message: issue.message,
				guidance: schemaDiagnosticGuidance(issue, params),
				blocksSubmission: true,
				offender: {
					kind: "schema",
					value: schemaIssueOffenderValue(issue, params),
				},
			},
		];
	}
	const diagnostics: GoalTargetPlanLintDiagnostic[] = [];
	for (const alias of issue.keys) {
		const canonical = targetPlanPayloadFieldAlias(alias);
		const parentPath = issue.path;
		if (!canonical) {
			diagnostics.push({
				severity: "error",
				code: schemaDiagnosticCode(issue),
				path: jsonPointerPath([...parentPath, alias]),
				message: `Unrecognized key ${alias}.`,
				guidance: schemaDiagnosticGuidance(issue, params),
				blocksSubmission: true,
				offender: { kind: "schema", value: getValueAtIssuePath(params, [...parentPath, alias]) },
			});
			continue;
		}
		diagnostics.push({
			severity: "error",
			code: schemaDiagnosticCode(issue),
			path: jsonPointerPath([...parentPath, canonical]),
			message: `Unrecognized key ${alias}.`,
			guidance: `Use snake_case key ${canonical}, not ${alias}.`,
			blocksSubmission: true,
			offender: { kind: "schema", value: getValueAtIssuePath(params, [...parentPath, alias]) },
			repairPatches: targetPlanAliasRepairPatches(params, parentPath, alias, canonical),
		});
	}
	return diagnostics;
}

function assertCanonicalTargetPlanPayloadPath(payload: unknown, payloadFilePath: string, session: ToolSession): void {
	const planFilePath = getRecordValue(payload, "plan_file_path");
	if (typeof planFilePath !== "string" || !planFilePath.trim()) return;
	const expectedPayloadFilePath = targetPlanPayloadFilePath(planFilePath);
	const resolvedActual = resolveTargetPlanPayloadPath(payloadFilePath, session);
	const resolvedExpected = resolveTargetPlanPayloadPath(expectedPayloadFilePath, session);
	if (resolvedActual !== resolvedExpected) {
		throw new ToolError(`payload_file_path must equal current target plan sidecar (${expectedPayloadFilePath})`);
	}
}

function resolveTargetPlanPayloadPath(filePath: string, session: ToolSession): string {
	const normalized = normalizeLocalScheme(filePath);
	if (normalized.startsWith("local:")) {
		if (!session.localProtocolOptions) throw new ToolError("payload_file_path local:// resolution is unavailable");
		return resolveLocalUrlToPath(normalized, session.localProtocolOptions);
	}
	return resolveToCwd(normalized, session.cwd);
}

async function targetPlanPayloadFromParams(
	params: z.infer<typeof submitTargetPlanSchema> | z.infer<typeof lintTargetPlanSchema>,
	session: ToolSession,
): Promise<unknown> {
	const payloadFilePath = params.payload_file_path;
	const resolved = resolveTargetPlanPayloadPath(payloadFilePath, session);
	const filePayload = targetPlanPayloadFromRaw(normalizeTargetPlanLayerAliases(await Bun.file(resolved).json()));
	assertCanonicalTargetPlanPayloadPath(filePayload, payloadFilePath, session);
	return filePayload;
}

function targetPlanPayloadFromRaw(params: unknown): unknown {
	if (!params || typeof params !== "object" || Array.isArray(params)) return params;
	const { op: _op, payload_file_path: _payloadFilePath, ...payload } = params as Record<string, unknown>;
	return payload;
}
function schemaDiagnosticCode(issue: z.ZodError["issues"][number]): string {
	if (issue.code === "unrecognized_keys") return "schema.unrecognized_key";
	if (issue.code === "invalid_value") return "schema.invalid_enum";
	if (issue.code === "invalid_type" && "input" in issue && issue.input === undefined) return "schema.missing_required";
	if (issue.code === "custom") return "schema.refinement";
	return `schema.${issue.code}`;
}

function schemaDiagnosticGuidance(issue: z.ZodError["issues"][number], params?: unknown): string {
	const alias = firstUnrecognizedAlias(issue);
	if (alias) return `Use snake_case key ${alias.canonical}, not ${alias.alias}.`;
	const path = issue.path.map(segment => String(segment)).join("/");
	if (path.endsWith("/layer") || /^verification_aperture\/omitted_layers\/\d+\/layer$/.test(path)) {
		const submitted = getValueAtIssuePath(params, issue.path);
		const hint = layerAliasHint(submitted);
		return `Allowed layer values: ${VERIFICATION_LAYER_VALUES.join(", ")}.${hint}`;
	}
	if (/^target_card\/workstreams\/\d+\/role$/.test(path)) {
		return "Workstream role must be a string. Keep kind as the enum and put the specific domain role in role.";
	}
	if (/^verification_signals\/\d+\/role$/.test(path)) return `Allowed role values: ${SIGNAL_ROLE_VALUES.join(", ")}.`;
	if (path.endsWith("/confidence_target") || path.endsWith("/confidence_if_satisfied")) {
		return `Allowed confidence values: ${SIGNAL_CONFIDENCE_VALUES.join(", ")}. Put specific confidence scope in confidence_rationale.`;
	}
	if (path.endsWith("/blast_radius")) {
		return `Allowed blast radius values: ${BLAST_RADIUS_VALUES.join(", ")}. Put the concrete affected surface in blast_radius_scope.`;
	}
	if (path.endsWith("/kind")) {
		return `Allowed concern/workstream kind values: ${CONCERN_KIND_VALUES.join(", ")}; workstream kinds: ${WORKSTREAM_KIND_VALUES.join(", ")}. Put specific domain meaning in concern_checks[].lens or target_card.workstreams[].role.`;
	}
	if (path.endsWith("/right_sizing_basis")) {
		return "Allowed right_sizing_basis values: product-signal, minimum-domain-unit, verifier-repair, external-authority-slice. Put the specific sizing argument in right_sizing_rationale.";
	}
	if (path.endsWith("/reason") && (path.includes("rows_left_open") || path.includes("deferred_related_work"))) {
		return "Use the enum reason here and preserve the specific boundary in the sibling rationale field.";
	}
	if (path.endsWith("/plan_depth")) return `Allowed plan_depth values: ${TARGET_PLAN_DEPTH_VALUES.join(", ")}.`;
	if (path === "verification_aperture/primary_signal_id") {
		const requiredIds = requiredVerificationSignalIds(params);
		return requiredIds.length > 0
			? `Use one required verification_signals[].id: ${requiredIds.join(", ")}.`
			: "Use a required verification_signals[].id.";
	}
	return 'Fix the payload shape, then rerun goal({op:"lint_target_plan", payload_file_path:"..."}).';
}

function schemaIssueOffenderValue(issue: z.ZodError["issues"][number], params: unknown): unknown {
	if (issue.path.length > 0) return getValueAtIssuePath(params, issue.path);
	if (issue.code === "unrecognized_keys") return { keys: issue.keys };
	return undefined;
}

function schemaIssuesToDiagnostics(error: z.ZodError, params: unknown): GoalTargetPlanLintDiagnostic[] {
	const aliasCanonicalPaths = collectAliasCanonicalDiagnosticPaths(error);
	const diagnostics: GoalTargetPlanLintDiagnostic[] = [];
	const seen = new Set<string>();
	for (const issue of error.issues) {
		if (isMissingCanonicalForAlias(issue, aliasCanonicalPaths)) continue;
		for (const diagnostic of unrecognizedKeyDiagnostics(issue, params)) {
			const key = `${diagnostic.code}\0${diagnostic.path}\0${diagnostic.message}\0${diagnostic.guidance}`;
			if (seen.has(key)) continue;
			seen.add(key);
			diagnostics.push(diagnostic);
		}
	}
	return diagnostics;
}

function payloadFileReadDiagnostic(error: unknown): GoalTargetPlanLintDiagnostic {
	const missing = isEnoent(error);
	const toolMessage = error instanceof ToolError ? error.message : undefined;
	return {
		severity: "error",
		code: missing ? "payload_file.missing" : toolMessage ? "payload_file.invalid_path" : "payload_file.invalid_json",
		path: "/payload_file_path",
		message: missing
			? "target plan payload file is missing"
			: (toolMessage ?? "target plan payload file must contain valid JSON"),
		guidance: toolMessage
			? "Use the payload_file_path from the current target-plan submit identity."
			: missing
				? "Create the structured target-plan payload JSON sidecar, then rerun lint_target_plan with payload_file_path."
				: "Fix the payload JSON syntax in place, then rerun lint_target_plan with payload_file_path.",
		blocksSubmission: true,
		offender: { kind: "schema", value: error instanceof Error ? error.message : String(error) },
	};
}

type TargetPlanMarkdownAgreementMode = "lint" | "submit";

function targetPlanMarkdownSeverity(mode: TargetPlanMarkdownAgreementMode): GoalTargetPlanLintDiagnostic["severity"] {
	return mode === "submit" ? "error" : "warning";
}

function targetPlanMarkdownDiagnostic(input: {
	mode: TargetPlanMarkdownAgreementMode;
	code: string;
	path: Array<string | number>;
	message: string;
	guidance: string;
	offender?: GoalTargetPlanLintDiagnostic["offender"];
}): GoalTargetPlanLintDiagnostic {
	const severity = targetPlanMarkdownSeverity(input.mode);
	return {
		severity,
		code: input.code,
		path: jsonPointerPath(input.path),
		message: input.message,
		guidance: input.guidance,
		blocksSubmission: severity === "error",
		offender: input.offender,
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasMarkdownHeading(markdown: string, heading: string): boolean {
	return new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m").test(markdown);
}

function markdownMentionsAny(markdown: string, values: readonly string[]): boolean {
	return values.some(value => value.length > 0 && markdown.includes(value));
}

function collectTargetPlanMarkdownAgreementDiagnostics(
	input: GoalSubmitTargetPlanInput,
	markdown: string,
	mode: TargetPlanMarkdownAgreementMode,
): GoalTargetPlanLintDiagnostic[] {
	const diagnostics: GoalTargetPlanLintDiagnostic[] = [];
	for (const heading of ["Target Claim", "Implementation", "Verification"]) {
		if (hasMarkdownHeading(markdown, heading)) continue;
		diagnostics.push(
			targetPlanMarkdownDiagnostic({
				mode,
				code: "plan_markdown.heading_missing",
				path: ["plan_file_path"],
				message: `target plan Markdown must include heading ## ${heading}`,
				guidance: "Patch the plan Markdown in place and add the required executor-facing section.",
				offender: { kind: "schema", id: "plan_file_path", value: input.planFilePath },
			}),
		);
	}
	const rows = [...(input.scenarioMatrix?.rowsInScope ?? [])].sort((left, right) => {
		const branchOrder = left.branch.localeCompare(right.branch);
		return branchOrder === 0 ? left.id.localeCompare(right.id) : branchOrder;
	});
	const rowIdsLinkedByPayload = new Set(input.branchEvidence.flatMap(branch => branch.rowIds ?? []));
	for (const row of rows) {
		if (markdownMentionsAny(markdown, [row.branch, row.id])) continue;
		const linkedByRowId = rowIdsLinkedByPayload.has(row.id);
		diagnostics.push(
			targetPlanMarkdownDiagnostic({
				mode: linkedByRowId ? "lint" : mode,
				code: "plan_markdown.branch_missing",
				path: ["plan_file_path"],
				message: linkedByRowId
					? `target plan Markdown should mention in-scope branch ${row.branch} or row ${row.id}`
					: `target plan Markdown must mention in-scope branch ${row.branch} or row ${row.id}`,
				guidance: linkedByRowId
					? "Payload row_ids preserve graph linkage; patch Markdown only if executor-facing branch prose is missing."
					: "Patch Markdown with executor-facing branch prose or add branch_evidence.row_ids when the payload intentionally preserves graph linkage.",
				offender: { kind: "matrix_row", id: row.id },
			}),
		);
	}
	const workstreams = input.targetCard?.workstreams ?? [];
	for (const workstream of workstreams) {
		for (const file of workstream.files) {
			if (markdown.includes(file)) continue;
			diagnostics.push(
				targetPlanMarkdownDiagnostic({
					mode,
					code: "plan_markdown.workstream_file_missing",
					path: ["plan_file_path"],
					message: `target plan Markdown must mention workstream file ${file}`,
					guidance: "Patch Implementation to list this workstream file path.",
					offender: { kind: "target_card", id: workstream.id, value: file },
				}),
			);
		}
	}
	for (const signal of input.verificationSignals.filter(signal => signal.required)) {
		if (markdownMentionsAny(markdown, [signal.id, signal.method])) continue;
		diagnostics.push(
			targetPlanMarkdownDiagnostic({
				mode,
				code: "plan_markdown.verification_signal_missing",
				path: ["plan_file_path"],
				message: `target plan Markdown must mention required verification signal ${signal.id} or method`,
				guidance: "Patch Verification to name this signal id or its exact verification method.",
				offender: { kind: "signal", id: signal.id },
			}),
		);
	}
	return diagnostics;
}

function targetPlanMarkdownReadDiagnostic(
	input: GoalSubmitTargetPlanInput,
	error: unknown,
	mode: TargetPlanMarkdownAgreementMode,
): GoalTargetPlanLintDiagnostic {
	const missing = isEnoent(error);
	const toolMessage = error instanceof ToolError ? error.message : undefined;
	return targetPlanMarkdownDiagnostic({
		mode,
		code: missing ? "plan_markdown.missing" : toolMessage ? "plan_markdown.invalid_path" : "plan_markdown.unreadable",
		path: ["plan_file_path"],
		message: missing ? "target plan Markdown file is missing" : (toolMessage ?? "target plan Markdown is unreadable"),
		guidance: missing
			? "Create the executor-facing Markdown plan at plan_file_path."
			: "Fix plan_file_path or make the Markdown plan readable.",
		offender: {
			kind: "schema",
			id: "plan_file_path",
			value: { planFilePath: input.planFilePath, error: error instanceof Error ? error.message : String(error) },
		},
	});
}

async function targetPlanMarkdownAgreementDiagnostics(
	input: GoalSubmitTargetPlanInput,
	session: ToolSession,
	mode: TargetPlanMarkdownAgreementMode,
): Promise<GoalTargetPlanLintDiagnostic[]> {
	try {
		const markdown = await Bun.file(resolveTargetPlanPayloadPath(input.planFilePath, session)).text();
		return collectTargetPlanMarkdownAgreementDiagnostics(input, markdown, mode);
	} catch (error) {
		return [targetPlanMarkdownReadDiagnostic(input, error, mode)];
	}
}

async function parseTargetPlanPayloadForLint(
	params: z.infer<typeof lintTargetPlanSchema>,
	session: ToolSession,
): Promise<{
	input?: GoalSubmitTargetPlanInput;
	diagnostics: GoalTargetPlanLintDiagnostic[];
}> {
	let payload: unknown;
	try {
		payload = await targetPlanPayloadFromParams(params, session);
	} catch (error) {
		return { diagnostics: [payloadFileReadDiagnostic(error)] };
	}
	const parsed = targetPlanPayloadSchema.safeParse(payload);
	if (parsed.success) {
		const input = mapSubmitTargetPlanInput(parsed.data);
		return { input, diagnostics: await targetPlanMarkdownAgreementDiagnostics(input, session, "lint") };
	}
	return { diagnostics: schemaIssuesToDiagnostics(parsed.error, payload) };
}

async function parseSubmitTargetPlanToolInput(
	params: z.infer<typeof submitTargetPlanSchema>,
	session: ToolSession,
): Promise<{ input: GoalSubmitTargetPlanInput; diagnostics: GoalTargetPlanLintDiagnostic[] }> {
	let payload: unknown;
	try {
		payload = await targetPlanPayloadFromParams(params, session);
	} catch (error) {
		throw new ToolError(payloadFileReadDiagnostic(error).message);
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new ToolError("target plan payload file must contain a JSON object");
	}
	const inlinePayload = { ...(payload as Record<string, unknown>), op: "submit_target_plan" as const };
	const parsed = submitTargetPlanInlineSchema.safeParse(inlinePayload);
	if (parsed.success) {
		const input = mapSubmitTargetPlanInput(parsed.data);
		return { input, diagnostics: await targetPlanMarkdownAgreementDiagnostics(input, session, "submit") };
	}
	throw new ToolError(formatSubmitTargetPlanSchemaError(parsed.error, inlinePayload));
}

function firstBlockingLintDiagnostic(lint: GoalTargetPlanLintResult): GoalTargetPlanLintDiagnostic | undefined {
	return lint.diagnostics.find(diagnostic => diagnostic.blocksSubmission || diagnostic.severity === "error");
}

function formatSubmitTargetPlanSchemaError(error: z.ZodError, params?: unknown): string {
	const issue = error.issues[0];
	if (!issue) {
		return 'submit_target_plan arguments are invalid. Call goal({op:"get"}) and reuse the target-plan submit identity.';
	}
	const alias = firstUnrecognizedAlias(issue);
	if (alias) {
		const aliasPath = alias.canonicalPath.map(segment => String(segment)).join("/") || "(root)";
		return `submit_target_plan invalid at ${aliasPath}: Use snake_case key ${alias.canonical}, not ${alias.alias}. Call goal({op:"get"}) and reuse the target-plan submit identity.`;
	}
	const path = issue.path.map(segment => String(segment)).join("/") || "(root)";
	if (path.endsWith("/layer") || /^verification_aperture\/omitted_layers\/\d+\/layer$/.test(path)) {
		const submitted = getValueAtIssuePath(params, issue.path);
		const hint = layerAliasHint(submitted);
		return `submit_target_plan invalid at ${path}: allowed values are ${VERIFICATION_LAYER_VALUES.join(", ")}.${hint} Call goal({op:"get"}) and reuse the current target_id, target_plan_id, plan_file_path, and revision.`;
	}
	if (/^target_card\/workstreams\/\d+\/role$/.test(path)) {
		return `submit_target_plan invalid at ${path}: workstream role must be a string; keep kind as the enum and put the specific domain role in role. Call goal({op:"get"}) and reuse the target-plan submit identity.`;
	}
	if (/^verification_signals\/\d+\/role$/.test(path)) {
		return `submit_target_plan invalid at ${path}: allowed values are ${SIGNAL_ROLE_VALUES.join(", ")}. Call goal({op:"get"}) and reuse the current target_id, target_plan_id, plan_file_path, and revision.`;
	}
	if (path.endsWith("/confidence_target") || path.endsWith("/confidence_if_satisfied")) {
		return `submit_target_plan invalid at ${path}: allowed values are ${SIGNAL_CONFIDENCE_VALUES.join(", ")}; put specific confidence scope in confidence_rationale. Call goal({op:"get"}) and reuse the current target_id, target_plan_id, plan_file_path, and revision.`;
	}
	if (path.endsWith("/blast_radius")) {
		return `submit_target_plan invalid at ${path}: allowed values are ${BLAST_RADIUS_VALUES.join(", ")}; put the concrete affected surface in blast_radius_scope. Call goal({op:"get"}) and reuse the current target_id, target_plan_id, plan_file_path, and revision.`;
	}
	if (path.endsWith("/kind")) {
		return `submit_target_plan invalid at ${path}: allowed values are ${CONCERN_KIND_VALUES.join(", ")}; put specific domain meaning in concern_checks[].lens or target_card.workstreams[].role. Call goal({op:"get"}) and reuse the current target_id, target_plan_id, plan_file_path, and revision.`;
	}
	if (path.endsWith("/right_sizing_basis")) {
		return 'submit_target_plan invalid at scope_calibration/right_sizing_basis: allowed values are product-signal, minimum-domain-unit, verifier-repair, external-authority-slice; put the specific sizing argument in right_sizing_rationale. Call goal({op:"get"}) and reuse the target-plan submit identity.';
	}
	if (path.endsWith("/reason") && (path.includes("rows_left_open") || path.includes("deferred_related_work"))) {
		return `submit_target_plan invalid at ${path}: use the enum reason here and preserve the specific boundary in the sibling rationale field. Call goal({op:"get"}) and reuse the target-plan submit identity.`;
	}
	if (path === "verification_aperture/primary_signal_id") {
		const submitted = getValueAtIssuePath(params, issue.path);
		const requiredIds = requiredVerificationSignalIds(params);
		const idHint = requiredIds.length > 0 ? ` Required signal ids: ${requiredIds.join(", ")}.` : "";
		return `submit_target_plan invalid at ${path}: primary_signal_id must exactly match one required verification_signals[].id. Received ${formatDiagnosticValue(submitted)}.${idHint} Call goal({op:"get"}) and reuse the target-plan submit identity.`;
	}
	return `submit_target_plan invalid at ${path}: ${issue.message}. Call goal({op:"get"}) and reuse the target-plan submit identity.`;
}

function mapFailTargetPlanInput(params: z.infer<typeof failTargetPlanSchema>): GoalTargetPlanFailureInput {
	return {
		targetId: params.target_id,
		targetPlanId: params.target_plan_id,
		revision: params.revision,
		reason: params.reason,
		message: params.message,
		blockers: params.blockers,
		suggestedQuestions: params.suggested_questions,
	};
}
function requireRecoverField<T>(value: T | undefined, field: string): T {
	if (value !== undefined) return value;
	throw new ToolError(`${field} is required for recover_blocked_state`);
}

function mapRecoverBlockedStateInput(params: z.infer<typeof recoverBlockedStateSchema>): GoalRecoverBlockedStateInput {
	if (params.kind === "target-plan") {
		return {
			kind: "target-plan",
			action: "restart_target_planning",
			blockedStateId: params.blocked_state_id,
			targetId: requireRecoverField(params.target_id, "target_id"),
			targetPlanId: requireRecoverField(params.target_plan_id, "target_plan_id"),
			revision: requireRecoverField(params.revision, "revision"),
			sourceStatus: requireRecoverField(params.source_status, "source_status"),
			reason: params.reason,
			guidance: params.guidance,
		};
	}
	if (params.action === "start_next_target") {
		const nextTarget = requireRecoverField(params.next_target, "next_target");
		if (!isTargetParams(nextTarget)) {
			throw new ToolError("next_target is required for checkpoint-external-pause recovery");
		}
		return {
			kind: "checkpoint-external-pause",
			action: "start_next_target",
			blockedStateId: params.blocked_state_id,
			checkpointId: requireRecoverField(params.checkpoint_id, "checkpoint_id"),
			checkpointResolutionId: requireRecoverField(params.checkpoint_resolution_id, "checkpoint_resolution_id"),
			reason: params.reason,
			guidance: params.guidance,
			parentDelta: mapParentDelta(params.parent_delta),
			nextTarget: mapTargetInput(nextTarget),
		};
	}
	return {
		kind: "checkpoint-external-pause",
		action: "enter_parent_completion",
		blockedStateId: params.blocked_state_id,
		checkpointId: requireRecoverField(params.checkpoint_id, "checkpoint_id"),
		checkpointResolutionId: requireRecoverField(params.checkpoint_resolution_id, "checkpoint_resolution_id"),
		reason: params.reason,
		guidance: params.guidance,
		parentDelta: mapParentDelta(params.parent_delta),
	};
}

export class GoalTool implements AgentTool<typeof goalSchema, GoalToolDetails> {
	readonly concurrency = "exclusive";
	readonly name = "goal";
	readonly label = "Goal";
	readonly description = prompt.render(goalDescription);
	readonly parameters = goalSchema;
	readonly strict = true;
	readonly lenientArgValidation = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		args: GoalToolInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const runtime = this.#session.getGoalRuntime?.();
		if (!runtime) throw new ToolError("Goal mode is not active.");

		const operation = goalOperationSchema.safeParse(args);
		if (operation.success && operation.data.op === "target_plan_schema") {
			targetPlanSchemaReferenceSchema.parse(args);
			const state = this.#session.getGoalModeState?.() ?? null;
			if (state?.runMode !== "planning-target") {
				throw new ToolError("target_plan_schema is only available while run mode is planning-target.");
			}
			const response = buildGoalToolResponse(state.goal, {
				state,
				targetPlan: state.goal.currentTargetPlan,
			});
			return {
				content: [{ type: "text", text: targetPlanSchemaReference }],
				details: buildGoalToolDetails("target_plan_schema", response),
			};
		}
		if (operation.success && operation.data.op === "lint_target_plan") {
			const lintParams = lintTargetPlanSchema.parse(args);
			const parsed = await parseTargetPlanPayloadForLint(lintParams, this.#session);
			const state = this.#session.getGoalModeState?.() ?? null;
			const lint = runtime.lintCurrentTargetPlanSubmission(parsed.input, parsed.diagnostics, "submit");
			const response = buildGoalToolResponse(state?.goal ?? null, {
				state,
				targetPlan: state?.goal.currentTargetPlan,
				targetPlanLint: lint,
			});
			return {
				content: [{ type: "text", text: renderGoalToolText(response, "lint_target_plan") }],
				details: buildGoalToolDetails("lint_target_plan", response),
			};
		}
		const params =
			operation.success && operation.data.op === "submit_target_plan"
				? (args as GoalToolInput)
				: goalSchema.parse(args);
		await runtime.flushUsage("suppressed");

		const goalSession: ToolSession & GoalSessionSupport = this.#session;
		let response: GoalToolResponse;
		if (params.op === "create") {
			const createInput = validateCreateParams(createSchema.parse(params));
			const created = goalSession.createGoalWithRubric
				? await goalSession.createGoalWithRubric(createInput, signal)
				: await runtime.createGoal(createInput);
			response = buildGoalToolResponse(created.goal, { state: created });
		} else if (params.op === "get") {
			const state = this.#session.getGoalModeState?.();
			response = buildGoalToolResponse(state?.goal ?? null, { state: state ?? null });
		} else if (params.op === "resume") {
			const resumed = await runtime.resumeGoal();
			response = buildGoalToolResponse(resumed.goal, { state: resumed });
		} else if (params.op === "drop") {
			const dropped = await runtime.dropGoal();
			response = buildGoalToolResponse(dropped ?? null, { state: null });
		} else if (params.op === "start_target") {
			const state = await runtime.startTarget(mapTargetInput(startTargetSchema.parse(params)));
			response = buildGoalToolResponse(state.goal, { state });
		} else if (params.op === "checkpoint") {
			const input = mapCheckpointInput(checkpointSchema.parse(params));
			if (!goalSession.requestGoalCheckpoint) {
				throw new ToolError("checkpoint requires an AgentSession checkpoint review handler");
			}
			response = await goalSession.requestGoalCheckpoint(input, signal);
		} else if (params.op === "resolve_checkpoint") {
			const input = mapResolutionInput(resolveCheckpointSchema.parse(params));
			response = goalSession.requestGoalCheckpointResolution
				? await goalSession.requestGoalCheckpointResolution(input, signal)
				: (() => {
						throw new ToolError("resolve_checkpoint requires an AgentSession checkpoint resolution handler");
					})();
		} else if (params.op === "submit_target_plan") {
			if (!goalSession.requestGoalTargetPlanApproval) {
				throw new ToolError("submit_target_plan requires an AgentSession target-plan review handler");
			}
			const parsed = await parseSubmitTargetPlanToolInput(submitTargetPlanSchema.parse(params), this.#session);
			const lint = runtime.lintCurrentTargetPlanSubmission(parsed.input, parsed.diagnostics, "submit");
			const blockingDiagnostic = firstBlockingLintDiagnostic(lint);
			if (blockingDiagnostic) throw new ToolError(blockingDiagnostic.message);
			response = await goalSession.requestGoalTargetPlanApproval(parsed.input, signal);
		} else if (params.op === "lint_target_plan") {
			throw new ToolError("lint_target_plan must be handled before goal state mutation.");
		} else if (params.op === "fail_target_plan") {
			if (!goalSession.requestGoalTargetPlanFailure) {
				throw new ToolError("fail_target_plan requires an AgentSession target-plan failure handler");
			}
			response = await goalSession.requestGoalTargetPlanFailure(
				mapFailTargetPlanInput(failTargetPlanSchema.parse(params)),
				signal,
			);
		} else if (params.op === "recover_blocked_state") {
			const state = await runtime.recoverBlockedState(
				mapRecoverBlockedStateInput(recoverBlockedStateSchema.parse(params)),
			);
			response = buildGoalToolResponse(state.goal, { state, targetPlan: state.goal.currentTargetPlan });
		} else {
			response = goalSession.requestGoalCompletion
				? await goalSession.requestGoalCompletion(signal)
				: buildGoalToolResponse(await runtime.completeGoalFromTool(), { includeCompletionReport: true });
		}
		const completionVerification = normalizeCompletionVerification(response.goal, response.completionVerification);
		if (completionVerification !== response.completionVerification)
			response = { ...response, completionVerification };
		return {
			content: [{ type: "text", text: renderGoalToolText(response, params.op) }],
			details: buildGoalToolDetails(params.op, response),
		};
	}
}

function visibleGoalObjective(goal: Goal, op: GoalToolInput["op"]): string {
	if (op === "create" || op === "get") return goal.objective;
	const firstLine = goal.objective
		.split("\n")
		.find(line => line.trim().length > 0)
		?.trim();
	const title = firstLine || goal.objective.trim();
	return title.length <= TRUNCATE_LENGTHS.TITLE ? title : `${title.slice(0, TRUNCATE_LENGTHS.TITLE - 1)}…`;
}

function shouldRenderPendingCheckpoint(
	goal: GoalToolGoalSummary,
	state: GoalToolStateSummary | null | undefined,
): boolean {
	if (!goal.pendingCheckpointId || goal.status === "paused") return false;
	if (state?.runMode === "awaiting-checkpoint-resolution") return true;
	return goal.pendingCheckpointRequiresResolution;
}

function lintCountsText(lint: GoalTargetPlanLintResult): string {
	return `${lint.summary.errorCount} error, ${lint.summary.warningCount} warning, ${lint.summary.infoCount} info`;
}

function renderLintDiagnosticText(diagnostic: GoalTargetPlanLintDiagnostic): string {
	const path = diagnostic.path || "/";
	let text = `- ${diagnostic.severity} ${diagnostic.code} ${path}: ${diagnostic.message}`;
	if (diagnostic.guidance) text += `\n  guidance: ${diagnostic.guidance}`;
	if (diagnostic.offender?.id) text += `\n  offender: ${diagnostic.offender.kind}:${diagnostic.offender.id}`;
	return text;
}

function renderTargetPlanLintText(lint: GoalTargetPlanLintResult): string {
	let text = `\n\nTarget plan lint: ${lint.ok ? "ok" : "blocked"} (${lintCountsText(lint)})`;
	if (lint.targetId) text += `\n  target_id: ${lint.targetId}`;
	if (lint.targetPlanId) text += `\n  target_plan_id: ${lint.targetPlanId}`;
	if (lint.planFilePath) text += `\n  plan_file_path: ${lint.planFilePath}`;
	if (lint.revision !== undefined) text += `\n  revision: ${lint.revision}`;
	if (lint.planDepth) text += `\n  plan_depth: ${lint.planDepth}`;
	if (lint.primarySignalGroupId) text += `\n  primary_signal_group_id: ${lint.primarySignalGroupId}`;
	text += `\n  stateVersion: ${lint.stateVersion}`;
	if (lint.legacy)
		text += "\n  legacy: matrix/card fields absent; accepted only when depth is light and graph risk is low.";
	if (lint.diagnostics.length === 0) return text;
	text += "\nDiagnostics:";
	for (const diagnostic of lint.diagnostics) {
		text += `\n${renderLintDiagnosticText(diagnostic)}`;
	}
	return text;
}

function renderTargetPlanEnumReminder(): string {
	return [
		"Allowed target-plan enum values:",
		`  plan_depth: ${TARGET_PLAN_DEPTH_VALUES.join(", ")}`,
		`  verification layer: ${VERIFICATION_LAYER_VALUES.join(", ")}`,
		`  signal role: ${SIGNAL_ROLE_VALUES.join(", ")}`,
		`  confidence: ${SIGNAL_CONFIDENCE_VALUES.join(", ")}`,
		`  blast_radius: ${BLAST_RADIUS_VALUES.join(", ")}`,
		`  concern kind: ${CONCERN_KIND_VALUES.join(", ")}`,
		`  rows_left_open.reason: ${SCENARIO_MATRIX_OPEN_ROW_REASON_VALUES.join(", ")}`,
		`  excluded_work_review.classification: ${EXCLUDED_WORK_CLASSIFICATION_VALUES.join(", ")}`,
		`  workstream kind: ${WORKSTREAM_KIND_VALUES.join(", ")}`,
		"  workflow_review_rounds[].verdict: accepted, revision-required",
		"  dry_run.status: passed, failed",
	].join("\n");
}

function renderGoalToolText(response: GoalToolResponse, op: GoalToolInput["op"]): string {
	const goal = response.goal;
	if (!goal) return "No active goal.";
	let text = `Goal: ${visibleGoalObjective(goal, op)}\nStatus: ${goal.status}`;
	const runMode = response.state?.runMode;
	if (runMode) text += `\nRun mode: ${runMode}`;
	text += `\nTokens: ${goal.tokensUsed} used`;
	if (goal.tokenBudget !== undefined) text += ` / ${goal.tokenBudget} budget`;
	if (response.remainingTokens !== null) text += `\nRemaining tokens: ${response.remainingTokens}`;
	if (goal.parentFrame)
		text += `\nParent frame: ${goal.parentFrame.kind} (version ${response.state?.parentFrameVersion ?? 0})`;
	if (goal.deliverableMap?.length) {
		const counts = goal.deliverableMap.reduce<Record<string, number>>((acc, item) => {
			acc[item.status] = (acc[item.status] ?? 0) + 1;
			return acc;
		}, {});
		text += `\nDeliverables: ${goal.deliverableMap.length}`;
		const summary = ["satisfied", "partial", "blocked", "stale", "pending"]
			.filter(status => counts[status])
			.map(status => `${status}:${counts[status]}`)
			.join(", ");
		if (summary) text += ` (${summary})`;
		const relevant = goal.currentTarget?.parentDeliverableIds?.length
			? goal.currentTarget.parentDeliverableIds
			: goal.deliverableMap.slice(0, 5).map(item => item.id);
		if (relevant.length) text += `\nRelevant deliverables: ${relevant.join(", ")}`;
	}
	if (goal.currentTarget) text += `\nCurrent target: ${goal.currentTarget.title} (${goal.currentTarget.status})`;
	if (goal.currentTargetPlan) {
		text += `\nTarget plan: ${goal.currentTargetPlan.status} ${goal.currentTargetPlan.planFilePath}`;
		const identity =
			response.state?.runMode === "planning-target" ? currentTargetPlanSubmitIdentity(response.state) : undefined;
		if (identity) {
			text += `\nTarget-plan submit identity:`;
			text += `\n  target_id: ${identity.targetId}`;
			text += `\n  target_plan_id: ${identity.targetPlanId}`;
			text += `\n  plan_file_path: ${identity.planFilePath}`;
			text += `\n  payload_file_path: ${identity.payloadFilePath}`;
			text += `\n  revision: ${identity.revision}`;
			text += `\nNext action: create missing plan files if needed; otherwise edit payload_file_path in place and patch plan_file_path only when the payload fix changes executor-visible semantics. Lint with goal({op:"lint_target_plan", payload_file_path:"${identity.payloadFilePath}"}). Submit with goal({op:"submit_target_plan", payload_file_path:"${identity.payloadFilePath}"}).`;
			text += `\n${renderTargetPlanEnumReminder()}`;
		}
	}
	if (op === "lint_target_plan" && response.targetPlanLint) {
		text += renderTargetPlanLintText(response.targetPlanLint);
	}
	const block = goal.currentBlockedState;
	if (block?.status === "open" && response.state?.runMode === "awaiting-user-input") {
		const action = block.allowedActions[0];
		let skeleton =
			action === undefined
				? "no recovery action is available"
				: `goal({op:"recover_blocked_state", blocked_state_id:"${block.id}", kind:"${block.kind}", action:"${action}", ...})`;
		if (block.kind === "target-plan") {
			skeleton = `goal({op:"recover_blocked_state", kind:"target-plan", action:"restart_target_planning", blocked_state_id:"${block.id}", target_id:"${block.source.targetId}", target_plan_id:"${block.source.targetPlanId}", revision:${block.source.revision}, source_status:"${block.source.status}", reason:"user-input", guidance:"<decision or authority>"})`;
		} else if (block.kind === "checkpoint-external-pause" && action) {
			skeleton = `goal({op:"recover_blocked_state", kind:"checkpoint-external-pause", action:"${action}", blocked_state_id:"${block.id}", checkpoint_id:"${block.source.checkpointId}", checkpoint_resolution_id:"${block.source.checkpointResolutionId}", reason:"user-input", guidance:"<decision or authority>", ...})`;
		}
		text += `\n\nBlocked state requires input: ${block.kind}. If current input resolves it, call ${skeleton}. Do not call resume or start_target directly while blocked_state is open.`;
	}
	if (
		goal.status !== "paused" &&
		goal.pendingCheckpointId &&
		(response.state?.runMode === "awaiting-checkpoint-resolution" ||
			!goal.checkpointResolutions?.some(resolution => resolution.checkpointId === goal.pendingCheckpointId))
	) {
		text += `\nPending checkpoint: ${goal.pendingCheckpointId}`;
		text += `\nNext action: inspect checkpoint guidance, then call goal({op:"resolve_checkpoint", checkpoint_id:"${goal.pendingCheckpointId}"}) before ordinary tools.`;
	}
	if (goal.verificationRepair) text += `\nVerifier repair: ${goal.verificationRepair.verificationAttemptId}`;
	if (op === "checkpoint" && response.checkpoint) {
		if (response.checkpointReview?.status === "rejected") {
			text += `\n\nCheckpoint rejected. Target remains active; no checkpoint is pending resolution. Continue repairing the current target closure evidence.\n\nReviewer feedback:\n${response.checkpointReview.feedback}`;
		} else {
			const checkpointId = response.checkpoint.id;
			text += `\n\nTarget checkpoint recorded: ${checkpointId}. Parent goal remains active. Ordinary tools are blocked until checkpoint guidance is inspected and goal({op:"resolve_checkpoint", checkpoint_id:"${checkpointId}"}) records the controller decision.`;
		}
	}
	if (op === "resolve_checkpoint" && response.checkpointResolution) {
		text += `\n\nCheckpoint resolution recorded: ${response.checkpointResolution.decision}.`;
		if (response.checkpointResolution.nextTarget) {
			text += `\nNext target: ${response.checkpointResolution.nextTarget.title}`;
		} else if (response.checkpointResolution.decision === "parent_completion_candidate") {
			text += `\nNext action: call goal({op:"complete"}) for parent completion verification.`;
		}
	}
	if (op === "submit_target_plan" && response.targetPlan) {
		if (response.targetPlan.status === "approved") {
			text += "\n\nTarget plan approved. Goal mode remains active; execution may begin for the current target.";
		} else if (response.targetPlan.status === "failed" || response.state?.runMode === "awaiting-user-input") {
			text +=
				"\n\nTarget plan failed. Goal mode is awaiting user/external input; when input resolves the blockers, call recover_blocked_state for the current blocked_state.";
		} else {
			text += "\n\nTarget plan rejected. Run mode remains planning-target; revise the plan using reviewer feedback.";
			const feedback = response.targetPlanReviews
				?.map(review => `${review.lens}: ${review.feedback}`)
				.filter(item => item.trim().length > 0)
				.join("\n");
			if (feedback) text += `\n\nReviewer feedback:\n${feedback}`;
		}
	}
	if (op === "recover_blocked_state" && response.state?.runMode === "planning-target") {
		text +=
			"\n\nBlocked state recovered. Goal mode is planning-target. Create missing plan/payload files, then lint and submit with payload_file_path.";
	} else if (op === "recover_blocked_state" && response.state?.runMode === "awaiting-parent-completion") {
		text +=
			'\n\nBlocked state recovered. Next action: call goal({op:"complete"}) for parent completion verification.';
	}
	if (op === "drop") {
		text += "\n\nGoal dropped. Formal goal mode is off; no checkpoint or parent completion was recorded.";
	}
	if (response.completionVerification?.status === "rejected") {
		const totalAttemptText =
			response.completionVerification.totalAttempts === undefined
				? ""
				: `, total ${response.completionVerification.totalAttempts}`;
		text += `\n\nCompletion verification rejected (attempt ${response.completionVerification.attempt}/${response.completionVerification.maxAttempts}${totalAttemptText}):\n${response.completionVerification.feedback}`;
		if (response.completionVerification.compactorMemo)
			text += `\n\nCompactor memo:\n${response.completionVerification.compactorMemo}`;
	} else if (response.completionBudgetReport) {
		text += `\n\n${response.completionBudgetReport}`;
	}
	return text;
}

function describeOp(op: string | undefined): string {
	switch (op) {
		case "create":
			return "set";
		case "complete":
			return "verify completion";
		case "get":
			return "check";
		case "resume":
			return "resume";
		case "drop":
			return "drop";
		case "start_target":
			return "start target";
		case "checkpoint":
			return "checkpoint target";
		case "resolve_checkpoint":
			return "resolve checkpoint";
		case "submit_target_plan":
			return "submit target plan";
		case "lint_target_plan":
			return "lint target plan";
		case "target_plan_schema":
			return "target plan schema";
		case "fail_target_plan":
			return "fail target plan";
		case "recover_blocked_state":
			return "recover blocked state";
		default:
			return op ?? "?";
	}
}

function goalBadgeColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "complete":
			return "success";
		case "budget-limited":
			return "warning";
		case "paused":
		case "dropped":
			return "muted";
		default:
			return "accent";
	}
}

function humanPreview(text: string): string {
	return truncateToWidth(replaceTabs(sanitizeText(text).trim()), TRUNCATE_LENGTHS.LONG);
}

interface GoalRenderArgs {
	op?: GoalToolInput["op"];
	objective?: string;
	token_budget?: number;
	title?: string;
	checkpoint_id?: string;
	decision?: string;
}

export const goalToolRenderer = {
	renderCall(args: GoalRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const description = describeOp(args.op);
		const meta: string[] = [];
		const trimmedObjective = args.objective?.trim();
		if (args.op === "create" && trimmedObjective) {
			const objective = truncateToWidth(trimmedObjective, TRUNCATE_LENGTHS.TITLE);
			meta.push(uiTheme.italic(uiTheme.fg("muted", `"${objective}"`)));
		}
		if (args.op === "start_target" && args.title)
			meta.push(uiTheme.italic(uiTheme.fg("muted", `"${humanPreview(args.title)}"`)));
		if (args.op === "resolve_checkpoint" && args.decision) meta.push(args.decision);
		if (args.op === "create" && args.token_budget !== undefined)
			meta.push(`budget ${formatNumber(args.token_budget)}`);
		const text = renderStatusLine({ icon: "pending", title: "Goal", description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GoalToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: GoalRenderArgs,
	): Component {
		const fallbackText = result.content?.find(c => c.type === "text")?.text ?? "";
		const details = result.details;
		const op = details?.op ?? args?.op;
		const description = describeOp(op);

		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Goal", description }, uiTheme);
			const body = formatErrorDetail(fallbackText || "Goal tool failed", uiTheme);
			return new Text([header, body].join("\n"), 0, 0);
		}

		const goal = details?.goal ?? null;
		if (!goal) {
			const header = renderStatusLine({ icon: "warning", title: "Goal", description }, uiTheme);
			const body = uiTheme.fg("muted", "No active goal.");
			return new Text([header, body].join("\n"), 0, 0);
		}

		const verification = details?.completionVerification;
		const verificationRejected = verification?.status === "rejected";
		const checkpointRejected = details?.checkpointReview?.status === "rejected";
		const targetPlan = details?.targetPlan;
		const lint = details?.targetPlanLint;
		const targetPlanBadge =
			op === "lint_target_plan" && lint
				? ({
						label: lint.ok
							? lint.summary.warningCount > 0
								? "target plan lint warnings"
								: "target plan lint ok"
							: "target plan lint blocked",
						color: lint.ok ? (lint.summary.warningCount > 0 ? "warning" : "success") : "error",
					} as const)
				: op === "recover_blocked_state" && targetPlan?.status === "drafting"
					? ({ label: "blocked state recovered", color: "success" } as const)
					: op === "submit_target_plan" && targetPlan?.status === "revision-required"
						? ({ label: "target plan rejected", color: "warning" } as const)
						: targetPlan?.status === "failed"
							? ({ label: "target plan failed", color: "error" } as const)
							: targetPlan?.status === "approved"
								? ({ label: "target plan approved", color: "success" } as const)
								: undefined;
		const lines: string[] = [];
		lines.push(
			renderStatusLine(
				{
					icon:
						targetPlanBadge?.color === "error"
							? "error"
							: verificationRejected || checkpointRejected || targetPlanBadge?.color === "warning"
								? "warning"
								: "success",
					title: "Goal",
					description,
					badge: {
						label: targetPlanBadge?.label
							? targetPlanBadge.label
							: verificationRejected
								? "verification rejected"
								: checkpointRejected
									? "checkpoint rejected"
									: goal.status,
						color: targetPlanBadge?.color
							? targetPlanBadge.color
							: verificationRejected || checkpointRejected
								? "warning"
								: goalBadgeColor(goal.status),
					},
					meta: verificationRejected
						? [
								verification.totalAttempts === undefined
									? `attempt ${verification.attempt}/${verification.maxAttempts}`
									: `attempt ${verification.attempt}/${verification.maxAttempts}, total ${verification.totalAttempts}`,
							]
						: details?.state?.runMode
							? [details.state.runMode]
							: undefined,
				},
				uiTheme,
			),
		);

		const objectiveText = humanPreview(goal.objective);
		lines.push(`  ${uiTheme.italic(uiTheme.fg("muted", `"${objectiveText}"`))}`);
		if (goal.currentTarget)
			lines.push(`  ${uiTheme.fg("muted", `target: ${humanPreview(goal.currentTarget.title)}`)}`);
		if (targetPlan) {
			lines.push(`  ${uiTheme.fg("muted", `target plan: ${targetPlan.status} r${targetPlan.revision}`)}`);
			lines.push(`  ${uiTheme.fg("muted", `target_id: ${targetPlan.targetId}`)}`);
			lines.push(`  ${uiTheme.fg("muted", `target_plan_id: ${targetPlan.id}`)}`);
			lines.push(`  ${uiTheme.fg("muted", `plan_file_path: ${targetPlan.planFilePath}`)}`);
			for (const review of targetPlan.reviews.filter(review => review.status !== "accepted").slice(0, 2)) {
				lines.push(`  ${uiTheme.fg("warning", humanPreview(`${review.lens}: ${review.feedback}`))}`);
			}
			if (targetPlan.status === "approved") {
				lines.push(`  ${uiTheme.fg("success", "execution unlocked for current target")}`);
			}
		}
		if (lint) {
			lines.push(
				`  ${uiTheme.fg(lint.ok ? "muted" : "warning", `lint: ${lint.ok ? "ok" : "blocked"} (${lintCountsText(lint)})`)}`,
			);
			if (lint.targetId) lines.push(`  ${uiTheme.fg("muted", `target_id: ${lint.targetId}`)}`);
			if (lint.targetPlanId) lines.push(`  ${uiTheme.fg("muted", `target_plan_id: ${lint.targetPlanId}`)}`);
			if (lint.revision !== undefined) lines.push(`  ${uiTheme.fg("muted", `revision: ${lint.revision}`)}`);
			for (const diagnostic of lint.diagnostics.slice(0, 3)) {
				const color: ThemeColor = diagnostic.severity === "error" ? "warning" : "muted";
				lines.push(
					`  ${uiTheme.fg(color, humanPreview(`${diagnostic.severity} ${diagnostic.code} ${diagnostic.path || "/"}: ${diagnostic.message}`))}`,
				);
			}
		}
		if (shouldRenderPendingCheckpoint(goal, details?.state)) {
			lines.push(`  ${uiTheme.fg("warning", `checkpoint pending: resolve ${goal.pendingCheckpointId}`)}`);
			lines.push(`  ${uiTheme.fg("muted", "ordinary tools blocked until resolve_checkpoint")}`);
		}

		const used = formatNumber(goal.tokensUsed);
		const tokensLine =
			goal.tokenBudget !== undefined
				? `${used} / ${formatNumber(goal.tokenBudget)} tokens (${formatNumber(Math.max(0, goal.tokenBudget - goal.tokensUsed))} left)`
				: `${used} tokens`;
		lines.push(`  ${uiTheme.fg("dim", tokensLine)}`);

		if (goal.timeUsedSeconds > 0)
			lines.push(`  ${uiTheme.fg("dim", `${formatDuration(goal.timeUsedSeconds * 1000)} elapsed`)}`);
		if (details?.checkpoint && !checkpointRejected) {
			lines.push(`  ${uiTheme.fg("muted", "Target closed; parent goal still active")}`);
			lines.push(
				`  ${uiTheme.fg("muted", "BOUNDARY: ordinary tools blocked until resolve_checkpoint records controller decision")}`,
			);
			lines.push(
				`  ${uiTheme.fg("muted", `goal({op:"resolve_checkpoint", checkpoint_id:"${details.checkpoint.id}"})`)}`,
			);
		}
		if (details?.checkpointResolution)
			lines.push(`  ${uiTheme.fg("muted", `checkpoint resolution: ${details.checkpointResolution.decision}`)}`);
		if (verificationRejected) {
			lines.push(`  ${uiTheme.fg("warning", humanPreview(verification.feedback))}`);
			if (verification.compactorMemo)
				lines.push(`  ${uiTheme.fg("muted", humanPreview(verification.compactorMemo))}`);
		}
		if (checkpointRejected && details?.checkpointReview)
			lines.push(`  ${uiTheme.fg("warning", humanPreview(details.checkpointReview.feedback))}`);

		const report = details?.completionBudgetReport;
		if (report) {
			lines.push("");
			lines.push(uiTheme.italic(uiTheme.fg("muted", report)));
		}

		return new Text(lines.join("\n"), 0, 0);
	},

	mergeCallAndResult: true,
};
