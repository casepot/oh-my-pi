import { escapeXmlText, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import goalBudgetLimitPrompt from "../prompts/goals/goal-budget-limit.md" with { type: "text" };
import goalContinuationPrompt from "../prompts/goals/goal-continuation.md" with { type: "text" };
import goalModeActivePrompt from "../prompts/goals/goal-mode-active.md" with { type: "text" };
import type { TaskParams, TaskToolDetails } from "../task/types";
import type {
	Goal,
	GoalBlockedState,
	GoalBudgetSteering,
	GoalCheckpointEvidenceItem,
	GoalCheckpointPacket,
	GoalCheckpointResolution,
	GoalCheckpointResolutionDecision,
	GoalCheckpointReview,
	GoalCheckpointStatus,
	GoalCompletionVerifierStructuredOutput,
	GoalConcernCheck,
	GoalContextMetric,
	GoalDeliverableDelta,
	GoalDeliverableMapItem,
	GoalGetViewName,
	GoalModeState,
	GoalParallelWorkstreamRequirement,
	GoalParentFrame,
	GoalParentStateDelta,
	GoalRecoveryLink,
	GoalRecoveryReason,
	GoalRecoveryRecord,
	GoalRef,
	GoalRunMode,
	GoalRuntimeEvent,
	GoalScenarioMatrix,
	GoalScopeCalibration,
	GoalTarget,
	GoalTargetCard,
	GoalTargetPlanBranchEvidence,
	GoalTargetPlanDepth,
	GoalTargetPlanExcludedWorkReview,
	GoalTargetPlanExecutionContract,
	GoalTargetPlanExecutionSummary,
	GoalTargetPlanFailure,
	GoalTargetPlanFailureReason,
	GoalTargetPlanLintDiagnostic,
	GoalTargetPlanLintResult,
	GoalTargetPlanRecord,
	GoalTargetPlanReview,
	GoalTargetUnitRule,
	GoalTargetWorkstream,
	GoalTaskBatchScaffold,
	GoalTokenUsage,
	GoalToolViewEnvelope,
	GoalVerificationAperture,
	GoalVerificationAttempt,
	GoalVerificationCommandRecord,
	GoalVerificationGap,
	GoalVerificationRepairState,
	GoalVerificationSignal,
	GoalVerificationStatus,
	GoalWorkstreamBatch,
} from "./state";
import {
	cloneBlockedState,
	cloneCheckpoint,
	cloneGoal,
	cloneGoalModeState,
	cloneParentFrame,
	cloneRecoveryRecord,
	cloneTarget,
	cloneTargetPlan,
	isNonContinuingCheckpointDecision,
	normalizeParentFrame,
	serializeGoalModeState,
	upsertBlockedState,
	upsertRecoveryRecord,
	upsertWorkstreamBatch,
} from "./state";
import { collectTargetPlanGraphDiagnostics, lintDiagnostic } from "./target-plan-lint";
import { implementationFanoutRequired } from "./tool-details";
import {
	classifyTargetMutation,
	classifyVerificationCommand,
	type ObservedToolResultForFreshness,
} from "./verification-freshness";

export type GoalPersistenceReason = "semantic" | "terminal" | "recovery" | "budget-limited";

export interface GoalUsagePersistenceEvent {
	goalId: string;
	stateVersion: number;
	tokenDelta: number;
	wallSeconds: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	updatedAt: number;
	budgetLimited?: boolean;
}

export interface GoalRuntimeHost {
	getState(): GoalModeState | undefined;
	setState(state: GoalModeState | undefined): void;
	getCurrentUsage(): GoalTokenUsage;
	emit(event: GoalRuntimeEvent): void | Promise<void>;
	persist(
		mode: "goal" | "goal_paused" | "none",
		state?: GoalModeState,
		reason?: GoalPersistenceReason,
	): void | Promise<void>;
	persistUsage?(event: GoalUsagePersistenceEvent): void;
	sendHiddenMessage(message: {
		customType: string;
		content: string;
		deliverAs?: "steer" | "followUp" | "nextTurn";
	}): Promise<void>;
	now?(): number;
}

const ACTIVE_GOAL_DROP_ERROR =
	"cannot drop goal while active goal work is pending; fail the target plan, resolve the checkpoint, or complete/repair parent verification first";

export interface GoalTurnSnapshot {
	turnId: string;
	baselineUsage: GoalTokenUsage;
	activeGoalId?: string;
}

export interface GoalWallClockSnapshot {
	lastAccountedAt: number;
	activeGoalId?: string;
}

interface GoalVerificationRecordInput {
	status: GoalVerificationStatus;
	attempt: number;
	maxAttempts: number;
	feedback: string;
	structuredFeedback?: GoalCompletionVerifierStructuredOutput;
	compactorMemo?: string;
	sideAgentTokensUsed?: number;
}

export interface GoalRuntimeSnapshot {
	turnSnapshot?: GoalTurnSnapshot;
	wallClock: GoalWallClockSnapshot;
	budgetReportedFor?: string;
}

export interface GoalWorkstreamTaskSpawnRecord {
	taskId?: string;
	agentId: string;
	jobId?: string;
}

export interface GoalWorkstreamTaskDispatchInput {
	toolCallId: string;
	params: TaskParams;
	details: TaskToolDetails;
	spawns: GoalWorkstreamTaskSpawnRecord[];
}

export interface GoalWorkstreamTaskResultInput {
	toolCallId: string;
	details: TaskToolDetails;
	spawns?: GoalWorkstreamTaskSpawnRecord[];
}

export type GoalPromptKind = "active" | "continuation" | "budget-limit";

export interface GoalStartTargetInput {
	title: string;
	desiredFutureClaim: string;
	closureStandard: string;
	expectedParentContribution?: string;
	baselineRefs?: GoalRef[];
	gateRefs?: string[];
	evidenceExpectation?: string[];
	nonGoals?: string[];
	forbiddenClaims?: string[];
	staleIf?: string[];
	createdBy?: GoalTarget["createdBy"];
	createdFromCheckpointId?: string;
	createdFromVerificationAttemptId?: string;
	linkedVerifierBlockerIds?: string[];
	parentDeliverableIds?: string[];
	parallelWorkstreamRequirement?: GoalParallelWorkstreamRequirement;
}

export interface GoalCheckpointInput {
	status: GoalCheckpointStatus;
	summary: string;
	localClaims: string[];
	evidence: GoalCheckpointEvidenceItem[];
	notClaimed: string[];
	remainingQuestions: string[];
	checksRun?: string[];
	artifactsTouched?: string[];
	risksOrCaveats?: string[];
	staleIf?: string[];
	suggestedControllerQuestions?: string[];
	retrospectiveTarget?: GoalStartTargetInput;
}

export function targetPlanPayloadFilePath(planFilePath: string): string {
	if (planFilePath.endsWith(".md")) return `${planFilePath.slice(0, -3)}.payload.json`;
	return `${planFilePath}.payload.json`;
}

export interface GoalSubmitTargetPlanInput {
	targetId: string;
	targetPlanId: string;
	planFilePath: string;
	revision: number;
	primarySignalGroupId?: string;
	planDepth?: GoalTargetPlanDepth;
	scenarioMatrix?: GoalScenarioMatrix;
	targetCard?: GoalTargetCard;
	verificationAperture: GoalVerificationAperture;
	verificationSignals: GoalVerificationSignal[];
	concernChecks: GoalConcernCheck[];
	scopeCalibration: GoalScopeCalibration;
	branchEvidence: GoalTargetPlanBranchEvidence[];
	excludedWorkReview: GoalTargetPlanExcludedWorkReview[];
	targetPlanReviews: GoalTargetPlanReview[];
	dryRun: GoalTargetPlanDryRun;
}
export interface GoalTargetPlanDryRun {
	status: "passed" | "failed";
	checks: Array<{ id: string; passed: boolean; rationale: string }>;
}

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
	if (value !== undefined) target[key] = value;
}

export function targetPlanPayloadFromSubmitInput(input: GoalSubmitTargetPlanInput): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		target_id: input.targetId,
		target_plan_id: input.targetPlanId,
		plan_file_path: input.planFilePath,
		revision: input.revision,
		verification_aperture: (() => {
			const aperture: Record<string, unknown> = {
				product_intention: input.verificationAperture.productIntention,
				primary_signal_id: input.verificationAperture.primarySignalId,
				blast_radius: input.verificationAperture.blastRadius,
				confidence_target: input.verificationAperture.confidenceTarget,
				layer_rationale: input.verificationAperture.layerRationale,
				residual_uncertainty: input.verificationAperture.residualUncertainty,
				omitted_layers: input.verificationAperture.omittedLayers.map(layer => ({
					layer: layer.layer,
					reason: layer.reason,
				})),
			};
			setIfDefined(aperture, "blast_radius_scope", input.verificationAperture.blastRadiusScope);
			setIfDefined(aperture, "confidence_rationale", input.verificationAperture.confidenceRationale);
			return aperture;
		})(),
		verification_signals: input.verificationSignals.map(signal => {
			const item: Record<string, unknown> = {
				id: signal.id,
				role: signal.role,
				layer: signal.layer,
				concern_ids: signal.concernIds,
				claim: signal.claim,
				observation: signal.observation,
				method: signal.method,
				expected_outcome: signal.expectedOutcome,
				required: signal.required,
				confidence_if_satisfied: signal.confidenceIfSatisfied,
				stale_if: signal.staleIf,
			};
			setIfDefined(item, "confidence_rationale", signal.confidenceRationale);
			return item;
		}),
		concern_checks: input.concernChecks.map(check => {
			const item: Record<string, unknown> = {
				id: check.id,
				kind: check.kind,
				why_independent: check.whyIndependent,
				covered_by_signal_ids: check.coveredBySignalIds,
			};
			setIfDefined(item, "lens", check.lens);
			return item;
		}),
		scope_calibration: (() => {
			const calibration: Record<string, unknown> = {
				right_sizing_basis: input.scopeCalibration.rightSizingBasis,
				why_not_smaller: input.scopeCalibration.whyNotSmaller,
				why_not_larger: input.scopeCalibration.whyNotLarger,
				included_related_work: input.scopeCalibration.includedRelatedWork.map(item => ({
					item: item.item,
					reason: item.reason,
					signal_ids: item.signalIds,
				})),
				deferred_related_work: input.scopeCalibration.deferredRelatedWork.map(item => {
					const deferred: Record<string, unknown> = { item: item.item, reason: item.reason };
					setIfDefined(deferred, "rationale", item.rationale);
					setIfDefined(deferred, "follow_up_hint", item.followUpHint);
					return deferred;
				}),
			};
			setIfDefined(calibration, "right_sizing_rationale", input.scopeCalibration.rightSizingRationale);
			setIfDefined(calibration, "target_unit_rule_ids", input.scopeCalibration.targetUnitRuleIds);
			setIfDefined(
				calibration,
				"target_unit_exemptions",
				input.scopeCalibration.targetUnitExemptions?.map(exemption => ({
					rule_id: exemption.ruleId,
					rationale: exemption.rationale,
				})),
			);
			return calibration;
		})(),
		branch_evidence: input.branchEvidence.map(branch => {
			const item: Record<string, unknown> = {
				branch: branch.branch,
				required: branch.required,
				planned_signal_ids: branch.plannedSignalIds,
				rationale: branch.rationale,
			};
			setIfDefined(item, "row_ids", branch.rowIds);
			return item;
		}),
		excluded_work_review: input.excludedWorkReview.map(item => ({
			item: item.item,
			classification: item.classification,
			rationale: item.rationale,
		})),
		target_plan_reviews: input.targetPlanReviews.map(review => {
			const item: Record<string, unknown> = {
				id: review.id,
				lens: review.lens,
				status: review.status,
				feedback: review.feedback,
				findings: review.findings.map(finding => {
					const findingItem: Record<string, unknown> = {
						id: finding.id,
						severity: finding.severity,
						problem: finding.problem,
						required_revision: finding.requiredRevision,
					};
					setIfDefined(findingItem, "supporting_evidence", finding.supportingEvidence);
					return findingItem;
				}),
				reviewed_target_plan_id: review.reviewedTargetPlanId,
				reviewed_revision: review.reviewedRevision,
				source: review.source
					? {
							kind: review.source.kind,
							reviewer_id: review.source.reviewerId,
							artifact_uri: review.source.artifactUri,
							validation_uri: review.source.validationUri,
						}
					: undefined,
				revised_after_review: review.revisedAfterReview,
			};
			setIfDefined(item, "aperture_classification", review.apertureClassification);
			setIfDefined(item, "revision_decision", review.revisionDecision);
			setIfDefined(
				item,
				"scores",
				review.scores
					? {
							product_signal: review.scores.productSignal,
							related_work_bundling: review.scores.relatedWorkBundling,
							concern_cohesion: review.scores.concernCohesion,
							verification_aperture: review.scores.verificationAperture,
							blast_radius_coverage: review.scores.blastRadiusCoverage,
							parent_uncertainty_reduction: review.scores.parentUncertaintyReduction,
							anti_gaming: review.scores.antiGaming,
						}
					: undefined,
			);
			return item;
		}),
		dry_run: {
			status: input.dryRun.status,
			checks: input.dryRun.checks.map(check => ({ id: check.id, passed: check.passed, rationale: check.rationale })),
		},
	};
	setIfDefined(payload, "primary_signal_group_id", input.primarySignalGroupId);
	setIfDefined(payload, "plan_depth", input.planDepth);
	if (input.scenarioMatrix) {
		payload.scenario_matrix = {
			id: input.scenarioMatrix.id,
			primary_signal_group_id: input.scenarioMatrix.primarySignalGroupId,
			rows_in_scope: input.scenarioMatrix.rowsInScope.map(row => ({
				id: row.id,
				branch: row.branch,
				signal_ids: row.signalIds,
				concern_ids: row.concernIds,
				acceptance: row.acceptance,
				expected_outcome: row.expectedOutcome,
				stale_if: row.staleIf,
			})),
			rows_left_open: input.scenarioMatrix.rowsLeftOpen.map(row => {
				const item: Record<string, unknown> = {
					id: row.id,
					branch: row.branch,
					reason: row.reason,
					follow_up_hint: row.followUpHint,
				};
				setIfDefined(item, "rationale", row.rationale);
				return item;
			}),
			splitting_safety: {
				safe: input.scenarioMatrix.splittingSafety.safe,
				rationale: input.scenarioMatrix.splittingSafety.rationale,
			},
			next_larger_target: input.scenarioMatrix.nextLargerTarget
				? {
						title: input.scenarioMatrix.nextLargerTarget.title,
						primary_signal_group_id: input.scenarioMatrix.nextLargerTarget.primarySignalGroupId,
						rows: input.scenarioMatrix.nextLargerTarget.rows,
						unblocks_matrix_id: input.scenarioMatrix.nextLargerTarget.unblocksMatrixId,
					}
				: undefined,
		};
	}
	if (input.targetCard) {
		const card: Record<string, unknown> = {
			capability_claim: input.targetCard.capabilityClaim,
			known_limits: input.targetCard.knownLimits,
			user_visible_surface: input.targetCard.userVisibleSurface,
			acceptance_rows: input.targetCard.acceptanceRows,
			verification_scenarios: input.targetCard.verificationScenarios,
			checkpoint_evidence: input.targetCard.checkpointEvidence,
		};
		setIfDefined(card, "trust_privacy_claim", input.targetCard.trustPrivacyClaim);
		setIfDefined(card, "confidence_earned", input.targetCard.confidenceEarned);
		setIfDefined(card, "authority_boundary", input.targetCard.authorityBoundary);
		setIfDefined(card, "policy_deletion_implications", input.targetCard.policyDeletionImplications);
		setIfDefined(
			card,
			"workstreams",
			input.targetCard.workstreams?.map(workstream => {
				const item: Record<string, unknown> = {
					id: workstream.id,
					label: workstream.label,
					kind: workstream.kind,
					files: workstream.files,
					contract_inputs: workstream.contractInputs,
					contract_outputs: workstream.contractOutputs,
				};
				setIfDefined(item, "role", workstream.role);
				return item;
			}),
		);
		setIfDefined(card, "shared_contract", input.targetCard.sharedContract);
		setIfDefined(card, "review_lenses", input.targetCard.reviewLenses);
		setIfDefined(card, "rollback_cutover", input.targetCard.rollbackCutover);
		payload.target_card = card;
	}
	return payload;
}

export interface GoalTargetPlanExpectation extends GoalSideAgentExpectation {
	targetPlanId: string;
	targetSequence: number;
}

export interface GoalTargetPlanApprovalInput extends GoalSubmitTargetPlanInput {
	reviews: GoalTargetPlanReview[];
	planHash?: string;
	planBytes?: number;
	payloadFilePath?: string;
	payloadHash?: string;
	payloadBytes?: number;
}

export interface GoalTargetPlanSubmitIdentity {
	targetId: string;
	targetPlanId: string;
	planFilePath: string;
	payloadFilePath: string;
	revision: number;
}

export function currentTargetPlanSubmitIdentity(
	state: GoalModeState | undefined,
): GoalTargetPlanSubmitIdentity | undefined {
	const target = state?.goal.currentTarget;
	const plan = state?.goal.currentTargetPlan;
	if (!target || !plan || plan.targetId !== target.id) return undefined;
	return {
		targetId: target.id,
		targetPlanId: plan.id,
		planFilePath: plan.planFilePath,
		payloadFilePath: targetPlanPayloadFilePath(plan.planFilePath),
		revision: plan.revision,
	};
}

export interface GoalTargetPlanRejectionInput {
	targetPlanId: string;
	revision?: number;
	reviews: GoalTargetPlanReview[];
	message: string;
	stage: "draft" | "review" | "approval" | "stale";
}

export interface GoalTargetPlanFailureInput {
	targetId: string;
	targetPlanId: string;
	revision: number;
	reason: GoalTargetPlanFailureReason;
	message: string;
	blockers: string[];
	suggestedQuestions: string[];
}

export type GoalRecoverBlockedStateInput =
	| {
			kind: "target-plan";
			action: "restart_target_planning";
			blockedStateId: string;
			stateVersion: number;
			parentFrameVersion: number;
			targetId: string;
			targetPlanId: string;
			revision: number;
			sourceStatus: "failed" | "stale";
			reason: GoalRecoveryReason;
			guidance: string;
	  }
	| {
			kind: "checkpoint-external-pause";
			action: "start_next_target";
			blockedStateId: string;
			stateVersion: number;
			parentFrameVersion: number;
			checkpointId: string;
			checkpointResolutionId: string;
			reason: GoalRecoveryReason;
			guidance: string;
			parentDelta?: GoalParentStateDelta;
			nextTarget: GoalStartTargetInput;
	  }
	| {
			kind: "checkpoint-external-pause";
			action: "enter_parent_completion";
			blockedStateId: string;
			stateVersion: number;
			parentFrameVersion: number;
			checkpointId: string;
			checkpointResolutionId: string;
			reason: GoalRecoveryReason;
			guidance: string;
			parentDelta?: GoalParentStateDelta;
	  };
export interface GoalCheckpointResolutionInput {
	checkpointId: string;
	stateVersion: number;
	parentFrameVersion: number;
	decision: GoalCheckpointResolutionDecision;
	parentReading: string;
	parentDelta?: GoalParentStateDelta;
	notPropagated: string[];
	remainingParentWork: string[];
	broaderChecksOrInputs?: string[];
	lessonsForFuture?: string[];
	nextTarget?: GoalStartTargetInput;
}

export {
	collectPrimarySignalGroupHistory,
	collectTargetPlanGraphDiagnostics,
	effectiveTargetUnitRules,
	resolvePrimarySignalGroupId,
	validateTargetPlanSubmissionGraph,
} from "./target-plan-lint";

export interface GoalSideAgentExpectation {
	goalId: string;
	stateVersion: number;
	currentTargetId?: string;
	pendingCheckpointId?: string;
	parentFrameVersion?: number;
	verificationAttemptId?: string;
	checkpointId?: string;
}

export interface GoalContinuationPacket {
	transition: "target-checkpoint" | "context-compaction" | "verification-rejected" | "parent-completion-candidate";
	reason: string;
	stateVersion: number;
	runMode: GoalRunMode;
	parentGoalId?: string;
	parentFrameVersion?: number;
	parentFrameKind?: GoalParentFrame["kind"];
	currentTargetId?: string;
	currentTargetPlanId?: string;
	currentTargetPlanRevision?: number;
	currentTargetPlanFilePath?: string;
	currentTargetPlanPayloadFilePath?: string;
	currentWorkstreamBatchId?: string;
	currentWorkstreamBatchStatus?: GoalWorkstreamBatch["status"];
	currentWorkstreamStatuses?: string[];
	pendingCheckpointId?: string;
	verificationAttemptId?: string;
	parentGoalStillActive: boolean;
	currentTargetStillOpen: boolean;
	allowedNextActs: string[];
	disallowedNextActs: string[];
	continuationGuidanceSummary: string;
	nonClaims: string[];
	parentBoundaries: string[];
	parentResiduals: string[];
	parentGateStatuses: string[];
}

const DEFAULT_CHECKPOINT_NOT_CLAIMED = [
	"Parent goal complete",
	"External checks verified",
	"Future target selected",
	"Durable project memory or guidance updated",
	"External/user authority granted",
] as const;

function budgetValue(goal: Goal): string {
	return goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget);
}

function remainingValue(goal: Goal): string {
	return goal.tokenBudget === undefined ? "unbounded" : String(Math.max(0, goal.tokenBudget - goal.tokensUsed));
}

export function remainingTokens(goal: Goal | null | undefined): number | null {
	if (!goal || goal.tokenBudget === undefined) return null;
	return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

export function renderTrustedObjective(objective: string): string {
	return `<objective>\n${escapeXmlText(objective)}\n</objective>`;
}

export function goalTokenDelta(current: GoalTokenUsage, baseline: GoalTokenUsage): number {
	return (
		Math.max(0, current.input - baseline.input) +
		Math.max(0, current.cacheWrite - baseline.cacheWrite) +
		Math.max(0, current.output - baseline.output)
	);
}

function optionalPromptSection(value: string | undefined): string {
	return value ? escapeXmlText(value) : "";
}

function escapeJsonForPrompt(value: unknown): string {
	return escapeXmlText(JSON.stringify(value, null, 2));
}

function latestCheckpoint(goal: Goal): GoalCheckpointPacket | undefined {
	if (goal.pendingCheckpointId) {
		return goal.checkpoints?.find(packet => packet.id === goal.pendingCheckpointId);
	}
	return goal.checkpoints?.at(-1);
}

function latestResolution(goal: Goal): GoalCheckpointResolution | undefined {
	if (goal.lastCheckpointResolutionId) {
		return goal.checkpointResolutions?.find(resolution => resolution.id === goal.lastCheckpointResolutionId);
	}
	return goal.checkpointResolutions?.at(-1);
}

function compactRefIds(refs: GoalRef[] | undefined): string[] {
	if (!refs?.length) return [];
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const ref of refs) {
		if (seen.has(ref.id)) continue;
		seen.add(ref.id);
		ids.push(ref.id);
	}
	return ids;
}

function compactCheckpointEvidenceItem(item: GoalCheckpointEvidenceItem): Record<string, unknown> {
	return {
		id: item.id,
		current: item.current,
		signalIds: item.signalIds,
		scenarioRowIds: item.scenarioRowIds,
		workstreamIds: item.workstreamIds,
		verificationCommandIds: item.verificationCommandIds,
		evidenceRefIds: compactRefIds(item.evidenceRefs),
		staleIf: item.staleIf,
		claimPresent: Boolean(item.claim.trim()),
		evidenceBytes: Buffer.byteLength(item.evidence, "utf8"),
	};
}

function compactVerificationGaps(blockers: GoalVerificationGap[]): Record<string, unknown>[] {
	return blockers.map(blocker => ({
		id: blocker.id,
		deliverableId: blocker.deliverableId,
		severity: blocker.severity,
		problem: blocker.problem,
		requiredEvidenceOrFix: blocker.requiredEvidenceOrFix,
	}));
}

function compactDeliverableMap(items: GoalDeliverableMapItem[] | undefined): Record<string, unknown>[] {
	return (
		items?.map(item => ({
			id: item.id,
			summary: item.summary,
			status: item.status,
			evidenceRefs: compactRefIds(item.evidenceRefs),
			blockedBy: item.blockedBy,
			nextRelevantTarget: item.nextRelevantTarget,
		})) ?? []
	);
}

function cloneDeliverableMapForState(items: GoalDeliverableMapItem[]): GoalDeliverableMapItem[] {
	return items.map(item => ({
		...item,
		evidenceRefs: item.evidenceRefs ? cloneRefs(item.evidenceRefs) : undefined,
		blockedBy: item.blockedBy ? [...item.blockedBy] : undefined,
	}));
}

function compactTarget(target: GoalTarget | undefined): Record<string, unknown> | undefined {
	if (!target) return undefined;
	return {
		id: target.id,
		sequence: target.sequence,
		status: target.status,
		title: target.title,
		desiredFutureClaim: target.desiredFutureClaim,
		closureStandard: target.closureStandard,
		expectedParentContribution: target.expectedParentContribution,
		baselineRefs: compactRefIds(target.baselineRefs),
		gateRefs: target.gateRefs,
		evidenceExpectation: target.evidenceExpectation,
		nonGoals: target.nonGoals,
		forbiddenClaims: target.forbiddenClaims,
		staleIf: target.staleIf,
		createdBy: target.createdBy,
		createdFromCheckpointId: target.createdFromCheckpointId,
		createdFromVerificationAttemptId: target.createdFromVerificationAttemptId,
		linkedVerifierBlockerIds: target.linkedVerifierBlockerIds,
		parentDeliverableIds: target.parentDeliverableIds,
		parallelWorkstreamRequirement: target.parallelWorkstreamRequirement,
		workstreamBatchId: target.workstreamBatchId,
	};
}

function compactParentFrame(
	frame: GoalParentFrame | undefined,
	objective: string,
): Record<string, unknown> | undefined {
	if (!frame) return undefined;
	return {
		kind: frame.kind,
		desiredFuture: frame.desiredFuture === objective ? "same_as_objective" : frame.desiredFuture,
		currentTruth: frame.currentTruth,
		authority: frame.authority,
		baselineRefs: compactRefIds(frame.baselineRefs),
		acceptedClaims: frame.acceptedClaims.map(claim => ({
			id: claim.id,
			claim: claim.claim,
			scope: claim.scope,
			evidenceRefs: compactRefIds(claim.evidenceRefs),
			nonImplications: claim.nonImplications,
		})),
		candidateClaimIds: frame.candidateClaims.map(claim => claim.id),
		rejectedOrStaleClaimIds: frame.rejectedOrStaleClaims.map(claim => claim.id),
		boundaries: frame.boundaries.map(boundary => ({
			id: boundary.id,
			kind: boundary.kind,
			statement: boundary.statement,
			refs: compactRefIds(boundary.refs),
		})),
		residuals: frame.residuals.map(residual => ({
			id: residual.id,
			classification: residual.classification,
			statement: residual.statement,
			targetHorizon: residual.targetHorizon,
			refs: compactRefIds(residual.refs),
		})),
		gates: frame.gates.map(gate => ({
			id: gate.id,
			name: gate.name,
			status: gate.status,
			evidenceRefs: compactRefIds(gate.evidenceRefs),
			staleIf: gate.staleIf,
		})),
		frontier: frame.frontier.map(item => ({
			id: item.id,
			statement: item.statement,
			activationTrigger: item.activationTrigger,
			refs: compactRefIds(item.refs),
		})),
		staleIf: frame.staleIf,
		externalRefs: compactRefIds(frame.externalRefs),
		lastParentDeltaId: frame.lastParentDeltaId,
	};
}

function compactCheckpoint(checkpoint: GoalCheckpointPacket | undefined): Record<string, unknown> | undefined {
	if (!checkpoint) return undefined;
	return {
		id: checkpoint.id,
		sequence: checkpoint.sequence,
		targetId: checkpoint.targetId,
		parentFrameVersion: checkpoint.parentFrameVersion,
		summary: checkpoint.summary,
		localClaims: checkpoint.localClaims,
		evidence: checkpoint.evidence.map(compactCheckpointEvidenceItem),
		checksRun: checkpoint.checksRun,
		artifactsTouched: checkpoint.artifactsTouched,
		notClaimed: checkpoint.notClaimed,
		remainingQuestions: checkpoint.remainingQuestions,
		risksOrCaveats: checkpoint.risksOrCaveats,
		staleIf: checkpoint.staleIf,
		review: checkpoint.review
			? {
					status: checkpoint.review.status,
					blockers: compactVerificationGaps(checkpoint.review.blockers),
					evidenceChecked: checkpoint.review.evidenceChecked.map(compactCheckpointEvidenceItem),
					feedback: checkpoint.review.status === "rejected" ? checkpoint.review.feedback : undefined,
				}
			: undefined,
	};
}

function compactParentDelta(delta: GoalParentStateDelta | undefined): Record<string, unknown> | undefined {
	if (!delta) return undefined;
	return {
		admittedClaimIds: delta.admittedClaims.map(claim => claim.id),
		candidateClaimIds: delta.candidateClaimsAdded.map(claim => claim.id),
		rejectedClaimIds: delta.rejectedClaims.map(claim => claim.id),
		boundaryIds: delta.boundariesAdded.map(boundary => boundary.id),
		residualIds: delta.residualsAddedOrUpdated.map(residual => residual.id),
		gateDeltas: delta.gateDeltas.map(gate => ({ id: gate.gateId, status: gate.status })),
		frontierIds: delta.frontierDeltas.map(item => item.id),
		staleRefs: compactRefIds(delta.staleRefs),
		externalRecordRefs: compactRefIds(delta.externalRecordRefs),
		authorityDecisionRefs: compactRefIds(delta.authorityDecisionRefs),
		deliverableDeltas: delta.deliverableDeltas?.map(item => ({
			id: item.id,
			summary: item.summary,
			status: item.status,
			evidenceRefs: compactRefIds(item.evidenceRefs),
			blockedBy: item.blockedBy,
			nextRelevantTarget: item.nextRelevantTarget,
		})),
	};
}

function compactResolution(resolution: GoalCheckpointResolution | undefined): Record<string, unknown> | undefined {
	if (!resolution) return undefined;
	return {
		id: resolution.id,
		sequence: resolution.sequence,
		checkpointId: resolution.checkpointId,
		decision: resolution.decision,
		parentReading: resolution.parentReading,
		parentDelta: compactParentDelta(resolution.parentDelta),
		notPropagated: resolution.notPropagated,
		remainingParentWork: resolution.remainingParentWork,
		broaderChecksOrInputs: resolution.broaderChecksOrInputs,
		lessonsForFuture: resolution.lessonsForFuture,
		nextTarget: compactTarget(resolution.nextTarget),
	};
}

function compactGoalVerificationRepair(
	repair: GoalVerificationRepairState | undefined,
): Record<string, unknown> | undefined {
	if (!repair) return undefined;
	return {
		verificationAttemptId: repair.verificationAttemptId,
		feedback: repair.feedback,
		blockers: compactVerificationGaps(repair.blockers),
		evidenceToCollect: repair.evidenceToCollect,
		avoidRepeating: repair.avoidRepeating,
	};
}

type GoalPromptObject = Record<string, unknown>;

export interface GoalContextSurface {
	goal: GoalPromptObject;
	run: GoalPromptObject;
	policy: GoalPromptObject;
	deliverables?: GoalPromptObject;
	parent_truth?: GoalPromptObject;
	target_aperture_guidance?: GoalPromptObject;
	target_unit_rules?: GoalPromptObject[];
	current_target?: GoalPromptObject;
	target_plan?: GoalPromptObject;
	target_execution_contract?: GoalTargetPlanExecutionContract;
	workstream_batch?: GoalPromptObject;
	verification_freshness?: GoalPromptObject;
	checkpoint?: GoalPromptObject;
	latest_resolution?: GoalPromptObject;
	parent_completion?: GoalPromptObject;
	verifier_repair?: GoalPromptObject;
	blocked_state?: GoalPromptObject;
	refs?: GoalPromptObject;
}

const PROMPT_LABEL_MAX_LENGTH = 120;

function shortPromptLabel(value: string): string {
	const trimmed = value.trim();
	return trimmed.length <= PROMPT_LABEL_MAX_LENGTH ? trimmed : `${trimmed.slice(0, PROMPT_LABEL_MAX_LENGTH - 1)}…`;
}

function compactTargetForPrompt(target: GoalTarget | undefined): GoalPromptObject | undefined {
	if (!target) return undefined;
	return {
		id: target.id,
		title: target.title,
		parentDeliverableIds: target.parentDeliverableIds,
		desiredFutureClaim: target.desiredFutureClaim,
		closureStandard: target.closureStandard,
		expectedParentContribution: target.expectedParentContribution,
		baselineRefs: compactRefIds(target.baselineRefs),
		gateRefs: target.gateRefs,
		evidenceExpectation: target.evidenceExpectation,
		nonGoals: target.nonGoals,
		forbiddenClaims: target.forbiddenClaims,
		staleIf: target.staleIf,
		createdFromCheckpointId: target.createdFromCheckpointId,
		createdFromVerificationAttemptId: target.createdFromVerificationAttemptId,
		linkedVerifierBlockerIds: target.linkedVerifierBlockerIds,
		parallel_workstream_requirement: target.parallelWorkstreamRequirement,
		parallelWorkstreamRequirement: target.parallelWorkstreamRequirement,
		workstreamBatchId: target.workstreamBatchId,
	};
}

function compactWorkstreamBatchForPrompt(batch: GoalWorkstreamBatch | undefined): GoalPromptObject | undefined {
	if (!batch) return undefined;
	return {
		id: batch.id,
		required: batch.required,
		status: batch.status,
		targetPlanId: batch.targetPlanId,
		targetPlanRevision: batch.targetPlanRevision,
		sharedContract: batch.sharedContract,
		workstreams: batch.workstreams.map(run => ({
			id: run.workstreamId,
			taskId: run.scaffoldTaskId,
			label: run.label,
			kind: run.kind,
			status: run.status,
			agentId: run.agentId,
			jobId: run.jobId,
			historyUrl: run.historyUrl,
			outputUrl: run.outputUrl,
			summary: run.summary,
			latestActivity: run.latestActivity,
			blockers: run.blockers,
		})),
	};
}

function compactDeliverableForPrompt(
	item: GoalDeliverableMapItem,
	mode: "full" | "pending" | "satisfied",
): GoalPromptObject {
	if (mode === "satisfied") {
		return {
			id: item.id,
			status: item.status,
			label: shortPromptLabel(item.summary),
			evidenceRefs: compactRefIds(item.evidenceRefs),
		};
	}
	return {
		id: item.id,
		status: item.status,
		summary: item.summary,
		evidenceRefs: compactRefIds(item.evidenceRefs),
		blockedBy: item.blockedBy,
		nextRelevantTarget: item.nextRelevantTarget,
	};
}

function compactDeliverablesForPrompt(
	items: GoalDeliverableMapItem[] | undefined,
	currentTarget: GoalTarget | undefined,
): GoalPromptObject | undefined {
	if (!items?.length) return undefined;
	const currentIds = new Set(currentTarget?.parentDeliverableIds ?? []);
	const activeOrPartial: GoalPromptObject[] = [];
	const pending: GoalPromptObject[] = [];
	const satisfied: GoalPromptObject[] = [];
	const blockedOrStale: GoalPromptObject[] = [];
	for (const item of items) {
		if (item.status === "blocked" || item.status === "stale") {
			blockedOrStale.push(compactDeliverableForPrompt(item, "full"));
		} else if (item.status === "partial" || currentIds.has(item.id)) {
			activeOrPartial.push(compactDeliverableForPrompt(item, "full"));
		} else if (item.status === "satisfied") {
			satisfied.push(compactDeliverableForPrompt(item, "satisfied"));
		} else {
			pending.push(compactDeliverableForPrompt(item, "pending"));
		}
	}
	return {
		active_or_partial: activeOrPartial,
		pending,
		satisfied,
		blocked_or_stale: blockedOrStale,
	};
}

function currentDeliverableEvidenceRefIds(
	items: GoalDeliverableMapItem[] | undefined,
	currentTarget: GoalTarget | undefined,
): Set<string> {
	const refIds = new Set<string>();
	const currentIds = new Set(currentTarget?.parentDeliverableIds ?? []);
	if (currentIds.size === 0) return refIds;
	for (const item of items ?? []) {
		if (!currentIds.has(item.id)) continue;
		for (const ref of item.evidenceRefs ?? []) refIds.add(ref.id);
	}
	return refIds;
}

function compactParentTruthForPrompt(
	frame: GoalParentFrame | undefined,
	latest: GoalCheckpointResolution | undefined,
	deliverables: GoalDeliverableMapItem[] | undefined,
	currentTarget: GoalTarget | undefined,
): GoalPromptObject | undefined {
	if (!frame) return undefined;
	const latestAdmittedIds = new Set(latest?.parentDelta?.admittedClaims.map(claim => claim.id) ?? []);
	const relevantEvidenceRefIds = currentDeliverableEvidenceRefIds(deliverables, currentTarget);
	const acceptedRecent: GoalPromptObject[] = [];
	const acceptedCompact: GoalPromptObject[] = [];
	const claimNonImplications: GoalPromptObject[] = [];
	for (const claim of frame.acceptedClaims) {
		const isRecent = latestAdmittedIds.has(claim.id);
		const isCurrentRelevant =
			claim.evidenceRefs?.some(ref => relevantEvidenceRefIds.has(ref.id)) ||
			(currentTarget?.parentDeliverableIds?.some(id => claim.scope === id) ?? false);
		if (isRecent || isCurrentRelevant) {
			acceptedRecent.push({
				id: claim.id,
				claim: claim.claim,
				scope: claim.scope,
				evidenceRefs: compactRefIds(claim.evidenceRefs),
				nonImplications: claim.nonImplications,
			});
		} else {
			acceptedCompact.push({
				id: claim.id,
				label: shortPromptLabel(claim.claim),
				evidenceRefs: compactRefIds(claim.evidenceRefs),
			});
			for (const statement of claim.nonImplications ?? []) {
				claimNonImplications.push({ claimId: claim.id, statement });
			}
		}
	}
	return {
		kind: frame.kind,
		currentTruth: frame.currentTruth,
		authority: frame.authority,
		accepted_recent: acceptedRecent,
		accepted_compact: acceptedCompact,
		boundaries: frame.boundaries.map(boundary => ({
			id: boundary.id,
			kind: boundary.kind,
			statement: boundary.statement,
			refs: compactRefIds(boundary.refs),
		})),
		claimNonImplications,
		residuals: frame.residuals.map(residual => ({
			id: residual.id,
			classification: residual.classification,
			statement: residual.statement,
			targetHorizon: residual.targetHorizon,
		})),
		gates: frame.gates.map(gate => ({
			id: gate.id,
			name: gate.name,
			status: gate.status,
			evidenceRefs: compactRefIds(gate.evidenceRefs),
			staleIf: gate.staleIf,
		})),
		frontier: frame.frontier.map(item => ({
			id: item.id,
			statement: item.statement,
			activationTrigger: item.activationTrigger,
		})),
		staleIf: frame.staleIf,
		externalRefs: compactRefIds(frame.externalRefs),
		lastParentDeltaId: frame.lastParentDeltaId,
	};
}

function compactTargetPlanForPrompt(plan: GoalTargetPlanRecord | undefined): GoalPromptObject | undefined {
	if (!plan) return undefined;
	return {
		id: plan.id,
		status: plan.status,
		revision: plan.revision,
		planFilePath: plan.planFilePath,
		payloadFilePath: targetPlanPayloadFilePath(plan.planFilePath),
		failure: plan.failure,
		recoveredFrom: plan.recoveredFrom,
		requiredAction:
			plan.status === "failed" || plan.status === "stale"
				? "recover_blocked_state_after_input_or_refresh"
				: "draft_review_submit_target_plan",
	};
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		output.push(value);
	}
	return output;
}

export interface GoalContextMetricIdentity {
	goalId: string;
	stateVersion: number;
	parentFrameVersion: number;
	targetId?: string;
	targetPlanId?: string;
	checkpointId?: string;
	createdAt?: number;
}

function jsonByteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

function textByteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function sectionBytes(sections: Record<string, unknown>, limit = 8): Array<{ section: string; bytes: number }> {
	return Object.entries(sections)
		.map(([section, value]) => ({ section, bytes: jsonByteLength(value) }))
		.filter(item => item.bytes > 0)
		.sort((left, right) => right.bytes - left.bytes || left.section.localeCompare(right.section))
		.slice(0, limit);
}

export interface GoalProofGraphProjectionRefOwner {
	refId: string;
	ownerKind: "proof-path";
	ownerId: string;
}

export interface GoalProofGraphProjection {
	schemaVersion: 1;
	projectionId: string;
	goalId: string;
	stateVersion: number;
	parentFrameVersion: number;
	targetId?: string;
	targetPlanId?: string;
	pendingCheckpointId?: string;
	createdAt: number;
	refs: GoalRef[];
	duplicateRefObjects: number;
	refOwners: GoalProofGraphProjectionRefOwner[];
	parentFrame: unknown;
	currentTargetPlan: unknown;
	checkpoints: unknown;
	verificationCommands: unknown;
}

interface GoalProofGraphRefDedupeState {
	refs: GoalRef[];
	refOwners: GoalProofGraphProjectionRefOwner[];
	seenRefIds: Set<string>;
	duplicateRefObjects: number;
}

const GOAL_REF_KIND_LOOKUP: Record<GoalRef["kind"], true> = {
	doc: true,
	issue: true,
	artifact: true,
	test: true,
	commit: true,
	"external-record": true,
	other: true,
};

export function targetPlanRefId(targetPlanId: string, revision: number): string {
	return `target-plan:${targetPlanId}@r${revision}`;
}

export function targetPlanMarkdownRefId(targetPlanId: string, revision: number, planHash?: string): string {
	const hashSuffix = planHash ? `:${planHash}` : "";
	return `${targetPlanRefId(targetPlanId, revision)}:markdown${hashSuffix}`;
}

export function targetPlanPayloadRefId(targetPlanId: string, revision: number, payloadHash?: string): string {
	const hashSuffix = payloadHash ? `:${payloadHash}` : "";
	return `${targetPlanRefId(targetPlanId, revision)}:payload${hashSuffix}`;
}

export function signalRefId(targetPlanId: string, revision: number, signalId: string): string {
	return `${targetPlanRefId(targetPlanId, revision)}:signal:${signalId}`;
}

export function scenarioRowRefId(targetPlanId: string, revision: number, rowId: string): string {
	return `${targetPlanRefId(targetPlanId, revision)}:scenario-row:${rowId}`;
}

export function workstreamRefId(targetPlanId: string, revision: number, workstreamId: string): string {
	return `${targetPlanRefId(targetPlanId, revision)}:workstream:${workstreamId}`;
}

export function checkpointEvidenceRefId(checkpointId: string, evidenceId: string): string {
	return `checkpoint:${checkpointId}#evidence:${evidenceId}`;
}

function isGoalRefKind(value: unknown): value is GoalRef["kind"] {
	return typeof value === "string" && value in GOAL_REF_KIND_LOOKUP;
}

const GOAL_REF_KEYS: Record<keyof GoalRef, true> = {
	id: true,
	kind: true,
	label: true,
	uri: true,
};

function hasOnlyGoalRefKeys(record: Record<string, unknown>): boolean {
	return Object.keys(record).every(key => key in GOAL_REF_KEYS);
}

function isGoalRefRecord(
	record: Record<string, unknown>,
): record is Record<string, unknown> & { id: string; kind: GoalRef["kind"]; label?: string; uri?: string } {
	return (
		typeof record.id === "string" &&
		isGoalRefKind(record.kind) &&
		hasOnlyGoalRefKeys(record) &&
		(record.label === undefined || typeof record.label === "string") &&
		(record.uri === undefined || typeof record.uri === "string")
	);
}

function addProofGraphRef(state: GoalProofGraphRefDedupeState, ref: GoalRef, ownerId: string): string {
	if (state.seenRefIds.has(ref.id)) {
		state.duplicateRefObjects += 1;
	} else {
		state.seenRefIds.add(ref.id);
		state.refs.push({ ...ref });
	}
	state.refOwners.push({ refId: ref.id, ownerKind: "proof-path", ownerId });
	return ref.id;
}

function compactProofGraphRefs(value: unknown, state: GoalProofGraphRefDedupeState, path = ""): unknown {
	if (Array.isArray(value)) return value.map((item, index) => compactProofGraphRefs(item, state, `${path}/${index}`));
	if (!value || typeof value !== "object") return value;
	const record: Record<string, unknown> = value as Record<string, unknown>;
	if (isGoalRefRecord(record)) {
		const refId = addProofGraphRef(
			state,
			{ id: record.id, kind: record.kind, label: record.label, uri: record.uri },
			path || "/",
		);
		return { refId };
	}
	const output: Record<string, unknown> = {};
	for (const [key, entryValue] of Object.entries(record)) {
		output[key] = compactProofGraphRefs(entryValue, state, `${path}/${key}`);
	}
	return output;
}

function compactProofTargetPlan(
	plan: GoalTargetPlanRecord | undefined,
	state: GoalProofGraphRefDedupeState,
): Record<string, unknown> | undefined {
	if (!plan) return undefined;
	addProofGraphRef(
		state,
		{ id: targetPlanRefId(plan.id, plan.revision), kind: "artifact", label: `Target plan ${plan.id}` },
		"/currentTargetPlan",
	);
	addProofGraphRef(
		state,
		{
			id: targetPlanMarkdownRefId(plan.id, plan.revision, plan.planHash),
			kind: "artifact",
			label: "Approved target plan Markdown",
			uri: plan.planFilePath,
		},
		"/currentTargetPlan/planFilePath",
	);
	addProofGraphRef(
		state,
		{
			id: targetPlanPayloadRefId(plan.id, plan.revision, plan.payloadHash),
			kind: "artifact",
			label: "Approved target plan payload",
			uri: plan.payloadFilePath ?? targetPlanPayloadFilePath(plan.planFilePath),
		},
		"/currentTargetPlan/payloadFilePath",
	);
	return {
		id: plan.id,
		targetId: plan.targetId,
		revision: plan.revision,
		status: plan.status,
		planRefId: targetPlanRefId(plan.id, plan.revision),
		markdownRefId: targetPlanMarkdownRefId(plan.id, plan.revision, plan.planHash),
		payloadRefId: targetPlanPayloadRefId(plan.id, plan.revision, plan.payloadHash),
		requiredSignals:
			plan.verificationSignals
				?.filter(signal => signal.required)
				.map(signal => {
					const refId = signalRefId(plan.id, plan.revision, signal.id);
					addProofGraphRef(
						state,
						{ id: refId, kind: "other", label: `Required signal ${signal.id}` },
						`/currentTargetPlan/requiredSignals/${signal.id}`,
					);
					return {
						id: signal.id,
						refId,
						role: signal.role,
						layer: signal.layer,
						concernIds: signal.concernIds,
						staleIf: signal.staleIf,
					};
				}) ?? [],
		scenarioRows:
			plan.scenarioMatrix?.rowsInScope.map(row => {
				const refId = scenarioRowRefId(plan.id, plan.revision, row.id);
				addProofGraphRef(
					state,
					{ id: refId, kind: "other", label: `Scenario row ${row.id}` },
					`/currentTargetPlan/scenarioRows/${row.id}`,
				);
				return {
					id: row.id,
					refId,
					signalIds: row.signalIds,
					concernIds: row.concernIds,
					staleIf: row.staleIf,
				};
			}) ?? [],
		workstreams:
			plan.targetCard?.workstreams?.map(workstream => {
				const refId = workstreamRefId(plan.id, plan.revision, workstream.id);
				addProofGraphRef(
					state,
					{ id: refId, kind: "other", label: `Workstream ${workstream.id}` },
					`/currentTargetPlan/workstreams/${workstream.id}`,
				);
				return {
					id: workstream.id,
					refId,
					kind: workstream.kind,
					files: workstream.files,
				};
			}) ?? [],
		branchEvidence:
			plan.branchEvidence?.map(item => ({
				branch: item.branch,
				required: item.required,
				plannedSignalIds: item.plannedSignalIds,
				rowIds: item.rowIds,
			})) ?? [],
	};
}

function compactProofCheckpoint(
	checkpoint: GoalCheckpointPacket,
	state: GoalProofGraphRefDedupeState,
	index: number,
): Record<string, unknown> {
	return {
		id: checkpoint.id,
		targetId: checkpoint.targetId,
		status: checkpoint.status,
		evidence: checkpoint.evidence.map((item, evidenceIndex) => {
			const id = normalizedCheckpointEvidenceId(item, evidenceIndex);
			const refId = checkpointEvidenceRefId(checkpoint.id, id);
			addProofGraphRef(
				state,
				{ id: refId, kind: "artifact", label: item.claim },
				`/checkpoints/${index}/evidence/${id}`,
			);
			return {
				id,
				refId,
				current: item.current,
				signalIds: item.signalIds,
				scenarioRowIds: item.scenarioRowIds,
				workstreamIds: item.workstreamIds,
				verificationCommandIds: item.verificationCommandIds,
				evidenceRefs: compactRefIds(item.evidenceRefs),
				staleIf: item.staleIf,
			};
		}),
		review: checkpoint.review
			? {
					status: checkpoint.review.status,
					evidenceIds: checkpoint.review.evidenceChecked.map((item, evidenceIndex) =>
						normalizedCheckpointEvidenceId(item, evidenceIndex),
					),
					blockerIds: checkpoint.review.blockers.map(blocker => blocker.id),
				}
			: undefined,
	};
}

export function buildGoalProofGraphProjection(state: GoalModeState, createdAt = Date.now()): GoalProofGraphProjection {
	const dedupeState: GoalProofGraphRefDedupeState = {
		refs: [],
		refOwners: [],
		seenRefIds: new Set(),
		duplicateRefObjects: 0,
	};
	const goal = state.goal;
	const parentFrame = compactProofGraphRefs(goal.parentFrame, dedupeState, "/parentFrame");
	const currentTargetPlan = compactProofTargetPlan(goal.currentTargetPlan, dedupeState);
	const checkpoints = (goal.checkpoints ?? []).map((checkpoint, index) =>
		compactProofCheckpoint(checkpoint, dedupeState, index),
	);
	const verificationCommands =
		goal.verificationCommands?.map(record => ({
			id: record.id,
			targetId: record.targetId,
			targetPlanId: record.targetPlanId,
			kind: record.kind,
			status: record.status,
			freshness: record.freshness,
			workEpoch: record.workEpoch,
			source: record.source,
		})) ?? [];
	return {
		schemaVersion: 1,
		projectionId: `${goal.id}:proof:${state.parentFrameVersion}:${state.stateVersion}`,
		goalId: goal.id,
		stateVersion: state.stateVersion,
		parentFrameVersion: state.parentFrameVersion,
		targetId: goal.currentTarget?.id,
		targetPlanId: goal.currentTargetPlan?.id,
		pendingCheckpointId: goal.pendingCheckpointId,
		createdAt,
		refs: dedupeState.refs,
		duplicateRefObjects: dedupeState.duplicateRefObjects,
		refOwners: dedupeState.refOwners,
		parentFrame,
		currentTargetPlan,
		checkpoints,
		verificationCommands,
	};
}

function countArray(value: readonly unknown[] | undefined): number {
	return value?.length ?? 0;
}

function countObjectKeys(value: Record<string, unknown> | undefined): number {
	return value ? Object.keys(value).length : 0;
}

function metricFromState(
	kind: GoalContextMetric["kind"],
	state: GoalModeState,
	serializedBytes: number,
	counts: Record<string, number>,
	createdAt: number,
	extra: Partial<GoalContextMetric> = {},
): GoalContextMetric {
	return {
		kind,
		goalId: state.goal.id,
		stateVersion: state.stateVersion,
		parentFrameVersion: state.parentFrameVersion,
		serializedBytes,
		counts,
		createdAt,
		...extra,
	};
}

export function measureGoalSerializedState(state: GoalModeState, createdAt = Date.now()): GoalContextMetric {
	const serialized = serializeGoalModeState(state);
	const goal = serialized.goal;
	return metricFromState(
		"state_snapshot",
		state,
		jsonByteLength(serialized),
		{
			targets: countArray(goal.targets),
			targetPlans: countArray(goal.targetPlans),
			checkpoints: countArray(goal.checkpoints),
			checkpointResolutions: countArray(goal.checkpointResolutions),
			verificationAttempts: countArray(goal.verificationAttempts),
			verificationCommands: countArray(goal.verificationCommands),
			workstreamBatches: countArray(goal.workstreamBatches),
			deliverables: countArray(goal.deliverableMap),
			parentAcceptedClaims: countArray(goal.parentFrame?.acceptedClaims),
			parentCandidateClaims: countArray(goal.parentFrame?.candidateClaims),
			parentRejectedClaims: countArray(goal.parentFrame?.rejectedOrStaleClaims),
			parentGates: countArray(goal.parentFrame?.gates),
			parentResiduals: countArray(goal.parentFrame?.residuals),
			parentFrontier: countArray(goal.parentFrame?.frontier),
		},
		createdAt,
		{
			targetId: goal.currentTarget?.id,
			targetPlanId: goal.currentTargetPlan?.id,
			checkpointId: goal.pendingCheckpointId,
			largestSections: sectionBytes({
				goal,
				parentFrame: goal.parentFrame,
				currentTarget: goal.currentTarget,
				currentTargetPlan: goal.currentTargetPlan,
				targetPlans: goal.targetPlans,
				checkpoints: goal.checkpoints,
				verificationCommands: goal.verificationCommands,
				workstreamBatches: goal.workstreamBatches,
			}),
		},
	);
}

export function measureGoalPromptSurface(state: GoalModeState, createdAt = Date.now()): GoalContextMetric {
	const surface = buildGoalContextSurface(state, state.goal);
	const promptSurface = renderGoalPromptSurface(state, state.goal);
	const surfaceRecord: Record<string, unknown> = { ...surface };
	return metricFromState(
		"prompt_surface",
		state,
		jsonByteLength(surface),
		{
			topLevelSections: countObjectKeys(surfaceRecord),
			deliverables: countArray(state.goal.deliverableMap),
			requiredSignals: countArray(
				state.goal.currentTargetPlan?.verificationSignals?.filter(signal => signal.required),
			),
			scenarioRows: countArray(state.goal.currentTargetPlan?.scenarioMatrix?.rowsInScope),
			workstreams: countArray(state.goal.currentWorkstreamBatch?.workstreams),
		},
		createdAt,
		{
			targetId: state.goal.currentTarget?.id,
			targetPlanId: state.goal.currentTargetPlan?.id,
			checkpointId: state.goal.pendingCheckpointId,
			promptBytes: textByteLength(promptSurface),
			largestSections: sectionBytes(surfaceRecord),
		},
	);
}

function readArrayCount(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

export function measureGoalExecutionContract(
	contract: unknown,
	identity: GoalContextMetricIdentity,
): GoalContextMetric {
	const record =
		contract && typeof contract === "object" && !Array.isArray(contract)
			? Object.fromEntries(Object.entries(contract))
			: {};
	return {
		kind: "approved_plan_contract",
		goalId: identity.goalId,
		stateVersion: identity.stateVersion,
		parentFrameVersion: identity.parentFrameVersion,
		targetId: identity.targetId,
		targetPlanId: identity.targetPlanId,
		checkpointId: identity.checkpointId,
		serializedBytes: jsonByteLength(contract),
		counts: {
			requiredSignals: readArrayCount(record.requiredSignals),
			scenarioRowsInScope: readArrayCount(record.scenarioRowsInScope),
			scenarioRowsLeftOpen: readArrayCount(record.scenarioRowsLeftOpen),
			workstreams: readArrayCount(record.workstreams),
			checkpointEvidence: readArrayCount(record.checkpointEvidence),
			refs: readArrayCount(record.refs),
		},
		largestSections: sectionBytes(record),
		createdAt: identity.createdAt ?? Date.now(),
	};
}

export function measureGoalCompactionPreserve(
	state: GoalModeState,
	preserveData: Record<string, unknown> | undefined,
	createdAt = Date.now(),
): GoalContextMetric {
	const data = preserveData ?? {};
	return metricFromState(
		"compaction_preserve",
		state,
		jsonByteLength(data),
		{
			keys: countObjectKeys(data),
			hasGoalMode: data.goalMode === undefined ? 0 : 1,
			hasGoalStateRef: data.goalStateRef === undefined ? 0 : 1,
			hasGoalContinuationPacket: data.goalContinuationPacket === undefined ? 0 : 1,
			hasGoalRoutingCapsule: data.goalRoutingCapsule === undefined ? 0 : 1,
			hasGoalBoundaryRef: data.goalBoundaryRef === undefined ? 0 : 1,
		},
		createdAt,
		{
			targetId: state.goal.currentTarget?.id,
			targetPlanId: state.goal.currentTargetPlan?.id,
			checkpointId: state.goal.pendingCheckpointId,
			largestSections: sectionBytes(data),
		},
	);
}

export function measureGoalCheckpointPacket(
	state: GoalModeState,
	checkpoint: GoalCheckpointPacket,
	createdAt = Date.now(),
): GoalContextMetric {
	return metricFromState(
		"checkpoint_packet",
		state,
		jsonByteLength(checkpoint),
		{
			localClaims: checkpoint.localClaims.length,
			evidenceItems: checkpoint.evidence.length,
			checksRun: checkpoint.checksRun.length,
			artifactsTouched: checkpoint.artifactsTouched.length,
			notClaimed: checkpoint.notClaimed.length,
			remainingQuestions: checkpoint.remainingQuestions.length,
			risksOrCaveats: checkpoint.risksOrCaveats.length,
			staleIf: checkpoint.staleIf.length,
			reviewEvidenceChecked: checkpoint.review?.evidenceChecked.length ?? 0,
			reviewBlockers: checkpoint.review?.blockers.length ?? 0,
		},
		createdAt,
		{
			targetId: checkpoint.targetId,
			targetPlanId: state.goal.currentTargetPlan?.id,
			checkpointId: checkpoint.id,
			largestSections: sectionBytes({
				targetSnapshot: checkpoint.targetSnapshot,
				evidence: checkpoint.evidence,
				review: checkpoint.review,
				localClaims: checkpoint.localClaims,
				remainingQuestions: checkpoint.remainingQuestions,
			}),
		},
	);
}

export function measureGoalProofGraph(state: GoalModeState, createdAt = Date.now()): GoalContextMetric {
	const goal = state.goal;
	const parent = goal.parentFrame;
	const currentPlan = goal.currentTargetPlan;
	const checkpoints = goal.checkpoints ?? [];
	const evidenceItems = checkpoints.flatMap(checkpoint => checkpoint.evidence);
	const checkpointSignalIds = uniqueStrings(evidenceItems.flatMap(item => item.signalIds ?? []));
	const checkpointScenarioRowIds = uniqueStrings(evidenceItems.flatMap(item => item.scenarioRowIds ?? []));
	const checkpointWorkstreamIds = uniqueStrings(evidenceItems.flatMap(item => item.workstreamIds ?? []));
	const projection = buildGoalProofGraphProjection(state, createdAt);
	const proofSnapshot = {
		refs: projection.refs,
		refOwners: projection.refOwners,
		parentFrame: projection.parentFrame,
		currentTargetPlan: projection.currentTargetPlan,
		checkpoints: projection.checkpoints,
		verificationCommands: projection.verificationCommands,
	};
	return metricFromState(
		"proof_graph",
		state,
		jsonByteLength(proofSnapshot),
		{
			refs: projection.refs.length,
			uniqueRefs: projection.refs.length,
			duplicateRefObjects: projection.duplicateRefObjects,
			refOwners: projection.refOwners.length,
			acceptedClaims: countArray(parent?.acceptedClaims),
			candidateClaims: countArray(parent?.candidateClaims),
			rejectedClaims: countArray(parent?.rejectedOrStaleClaims),
			requiredSignals: countArray(currentPlan?.verificationSignals?.filter(signal => signal.required)),
			scenarioRowsInScope: countArray(currentPlan?.scenarioMatrix?.rowsInScope),
			workstreams: countArray(currentPlan?.targetCard?.workstreams),
			checkpoints: checkpoints.length,
			checkpointEvidenceItems: evidenceItems.length,
			checkpointEvidenceRefs: evidenceItems.reduce((sum, item) => sum + countArray(item.evidenceRefs), 0),
			checkpointSignalCoverage: checkpointSignalIds.length,
			checkpointScenarioRowCoverage: checkpointScenarioRowIds.length,
			checkpointWorkstreamCoverage: checkpointWorkstreamIds.length,
			verificationCommands: countArray(goal.verificationCommands),
			deliverables: countArray(goal.deliverableMap),
			gates: countArray(parent?.gates),
		},
		createdAt,
		{
			targetId: goal.currentTarget?.id,
			targetPlanId: currentPlan?.id,
			checkpointId: goal.pendingCheckpointId,
			largestSections: sectionBytes({
				refs: projection.refs,
				refOwners: projection.refOwners,
				parentFrame: projection.parentFrame,
				currentTargetPlan: projection.currentTargetPlan,
				checkpoints: projection.checkpoints,
				verificationCommands: projection.verificationCommands,
			}),
		},
	);
}

export function buildGoalTargetPlanExecutionSummary(
	plan: GoalTargetPlanRecord | undefined,
	target: GoalTarget | undefined,
	workstreamBatch?: GoalWorkstreamBatch,
): GoalTargetPlanExecutionSummary | undefined {
	if (!plan) return undefined;
	const targetCard = plan.targetCard ?? target?.targetCard;
	const workstreams = targetCard?.workstreams?.map(workstream => ({
		id: workstream.id,
		label: workstream.label,
		kind: workstream.kind,
		role: workstream.role,
		files: [...workstream.files],
		contractInputs: [...workstream.contractInputs],
		contractOutputs: [...workstream.contractOutputs],
	}));
	const requiredSignals =
		plan.verificationSignals
			?.filter(signal => signal.required)
			.map(signal => ({
				id: signal.id,
				role: signal.role,
				layer: signal.layer,
				concernIds: [...signal.concernIds],
				claim: signal.claim,
				observation: signal.observation,
				method: signal.method,
				expectedOutcome: signal.expectedOutcome,
				confidenceIfSatisfied: signal.confidenceIfSatisfied,
				confidenceRationale: signal.confidenceRationale,
				staleIf: [...signal.staleIf],
			})) ?? [];
	return {
		targetId: plan.targetId,
		targetPlanId: plan.id,
		planFilePath: plan.planFilePath,
		payloadFilePath: plan.payloadFilePath ?? targetPlanPayloadFilePath(plan.planFilePath),
		revision: plan.revision,
		targetTitle: target?.title,
		desiredFutureClaim: target?.desiredFutureClaim,
		closureStandard: target?.closureStandard,
		capabilityClaim: targetCard?.capabilityClaim,
		userVisibleSurface: targetCard?.userVisibleSurface,
		planDepth: plan.planDepth,
		primarySignalGroupId: plan.primarySignalGroupId ?? plan.verificationAperture?.primarySignalId,
		implementationFanoutRequired: implementationFanoutRequired(plan),
		implementationFiles: uniqueStrings(workstreams?.flatMap(workstream => workstream.files) ?? []),
		workstreams,
		verificationAperture: plan.verificationAperture
			? {
					...plan.verificationAperture,
					residualUncertainty: [...plan.verificationAperture.residualUncertainty],
					omittedLayers: plan.verificationAperture.omittedLayers.map(layer => ({ ...layer })),
				}
			: undefined,
		reviewLenses: targetCard?.reviewLenses ? [...targetCard.reviewLenses] : undefined,
		concernChecks: plan.concernChecks?.map(check => ({
			...check,
			coveredBySignalIds: [...check.coveredBySignalIds],
		})),
		scopeCalibration: plan.scopeCalibration
			? {
					...plan.scopeCalibration,
					whyNotSmaller: [...plan.scopeCalibration.whyNotSmaller],
					whyNotLarger: [...plan.scopeCalibration.whyNotLarger],
					includedRelatedWork: plan.scopeCalibration.includedRelatedWork.map(item => ({
						...item,
						signalIds: [...item.signalIds],
					})),
					deferredRelatedWork: plan.scopeCalibration.deferredRelatedWork.map(item => ({ ...item })),
					targetUnitRuleIds: plan.scopeCalibration.targetUnitRuleIds
						? [...plan.scopeCalibration.targetUnitRuleIds]
						: undefined,
					targetUnitExemptions: plan.scopeCalibration.targetUnitExemptions?.map(exemption => ({ ...exemption })),
				}
			: undefined,
		branchEvidence: plan.branchEvidence?.map(branch => ({
			...branch,
			plannedSignalIds: [...branch.plannedSignalIds],
			rowIds: branch.rowIds ? [...branch.rowIds] : undefined,
		})),
		sharedContract: targetCard?.sharedContract,
		acceptanceRows: targetCard
			? {
					closed: [...targetCard.acceptanceRows.closed],
					open: [...targetCard.acceptanceRows.open],
				}
			: undefined,
		requiredSignals,
		scenarioRowsInScope: plan.scenarioMatrix?.rowsInScope.map(row => ({
			id: row.id,
			branch: row.branch,
			signalIds: [...row.signalIds],
			acceptance: row.acceptance,
			expectedOutcome: row.expectedOutcome,
			staleIf: [...row.staleIf],
		})),
		scenarioRowsLeftOpen: plan.scenarioMatrix?.rowsLeftOpen.map(row => ({
			id: row.id,
			branch: row.branch,
			reason: row.reason,
			rationale: row.rationale,
			followUpHint: row.followUpHint,
		})),
		excludedWork:
			plan.excludedWorkReview?.map(item => ({
				item: item.item,
				classification: item.classification,
				rationale: item.rationale,
			})) ?? [],
		nonGoals: [...(target?.nonGoals ?? [])],
		forbiddenClaims: [...(target?.forbiddenClaims ?? [])],
		knownLimits: [...(targetCard?.knownLimits ?? [])],
		checkpointEvidence: [...(targetCard?.checkpointEvidence ?? [])],
		staleIf: uniqueStrings([
			...(target?.staleIf ?? []),
			...requiredSignals.flatMap(signal => signal.staleIf),
			...(plan.scenarioMatrix?.rowsInScope.flatMap(row => row.staleIf) ?? []),
		]),
		readPlanFileWhen:
			"Exact edit order, file/symbol details, command text, or recovery detail is missing from this summary.",
		taskBatchScaffold: buildTaskBatchScaffold(workstreamBatch),
	};
}

export interface GoalTargetPlanExecutionContractIdentity {
	planHash?: string;
	planBytes?: number;
	payloadHash?: string;
	payloadBytes?: number;
	postGreenReviewRequired?: boolean;
}

export function buildGoalTargetPlanExecutionContract(
	summary: GoalTargetPlanExecutionSummary | undefined,
	identity: GoalTargetPlanExecutionContractIdentity = {},
): GoalTargetPlanExecutionContract | undefined {
	if (!summary) return undefined;
	return {
		schemaVersion: 1,
		targetId: summary.targetId,
		targetPlanId: summary.targetPlanId,
		revision: summary.revision,
		planRef: {
			targetPlanId: summary.targetPlanId,
			revision: summary.revision,
			planFilePath: summary.planFilePath,
			planHash: identity.planHash,
			planBytes: identity.planBytes,
			payloadFilePath: summary.payloadFilePath,
			payloadHash: identity.payloadHash,
			payloadBytes: identity.payloadBytes,
		},
		target: {
			title: summary.targetTitle,
			desiredFutureClaim: summary.desiredFutureClaim,
			closureStandard: summary.closureStandard,
			capabilityClaim: summary.capabilityClaim,
			userVisibleSurface: summary.userVisibleSurface,
		},
		scope: {
			planDepth: summary.planDepth,
			primarySignalGroupId: summary.primarySignalGroupId,
			implementationFanoutRequired: summary.implementationFanoutRequired,
			implementationFiles: [...summary.implementationFiles],
			sharedContract: summary.sharedContract,
		},
		workstreams: summary.workstreams?.map(workstream => ({
			id: workstream.id,
			label: workstream.label,
			kind: workstream.kind,
			role: workstream.role,
			files: [...workstream.files],
			contractInputs: [...workstream.contractInputs],
			contractOutputs: [...workstream.contractOutputs],
		})),
		requiredSignals: summary.requiredSignals.map(signal => ({
			id: signal.id,
			role: signal.role,
			layer: signal.layer,
			concernIds: [...signal.concernIds],
			claim: signal.claim,
			observation: signal.observation,
			method: signal.method,
			expectedOutcome: signal.expectedOutcome,
			confidenceIfSatisfied: signal.confidenceIfSatisfied,
			confidenceRationale: signal.confidenceRationale,
			staleIf: [...signal.staleIf],
		})),
		scenarioRowsInScope: summary.scenarioRowsInScope?.map(row => ({
			id: row.id,
			branch: row.branch,
			signalIds: [...row.signalIds],
			acceptance: row.acceptance,
			expectedOutcome: row.expectedOutcome,
			staleIf: [...row.staleIf],
		})),
		scenarioRowsLeftOpen: summary.scenarioRowsLeftOpen?.map(row => ({
			id: row.id,
			branch: row.branch,
			reason: row.reason,
			rationale: row.rationale,
			followUpHint: row.followUpHint,
		})),
		branchEvidence: summary.branchEvidence?.map(branch => ({
			branch: branch.branch,
			required: branch.required,
			plannedSignalIds: [...branch.plannedSignalIds],
			rowIds: branch.rowIds ? [...branch.rowIds] : undefined,
			rationale: branch.rationale,
		})),
		acceptanceRows: summary.acceptanceRows
			? {
					closed: [...summary.acceptanceRows.closed],
					open: [...summary.acceptanceRows.open],
				}
			: undefined,
		excludedWork: summary.excludedWork.map(item => ({ ...item })),
		nonGoals: [...summary.nonGoals],
		forbiddenClaims: [...summary.forbiddenClaims],
		knownLimits: [...summary.knownLimits],
		checkpointEvidence: [...summary.checkpointEvidence],
		staleIf: [...summary.staleIf],
		reviewLenses: summary.reviewLenses ? [...summary.reviewLenses] : undefined,
		postGreenReviewRequired: identity.postGreenReviewRequired ?? true,
		readPlanFileWhen: summary.readPlanFileWhen,
		readPayloadFileWhen:
			"Exact matrix, proof graph, payload-only contract, or recovery detail is missing from this contract.",
		taskBatchScaffold: summary.taskBatchScaffold,
	};
}

function goalGetViewNextAction(state: GoalModeState | null | undefined): string {
	if (!state) return "No active goal.";
	if (state.runMode === "planning-target") return "Continue target planning; lint and submit before implementation.";
	if (state.runMode === "awaiting-checkpoint-resolution")
		return "Prepare checkpoint guidance, then resolve_checkpoint.";
	if (state.runMode === "awaiting-parent-completion") return 'Call goal({ op: "complete" }).';
	if (state.runMode === "awaiting-verification-repair") return "Repair verifier blockers with fresh evidence.";
	if (state.runMode === "awaiting-user-input") return "Wait for input or recover_blocked_state.";
	if (state.runMode === "completed") return "Goal completed.";
	return "Resume the same open target.";
}

function goalGetViewRequiredOperation(state: GoalModeState | null | undefined): string | undefined {
	if (!state) return undefined;
	if (state.runMode === "planning-target") return "submit_target_plan";
	if (state.runMode === "awaiting-checkpoint-resolution") return "resolve_checkpoint";
	if (state.runMode === "awaiting-parent-completion") return "complete";
	if (state.runMode === "awaiting-verification-repair") return "start_target";
	if (state.runMode === "awaiting-user-input" && state.goal.currentBlockedState) return "recover_blocked_state";
	if (state.runMode === "working-target" && !state.goal.currentTarget) return "start_target";
	if (state.runMode === "working-target" && state.goal.currentTarget?.status === "active") return "checkpoint";
	return undefined;
}

export function buildGoalToolViewEnvelope(
	state: GoalModeState | null | undefined,
	name: GoalGetViewName,
	generatedAt = Date.now(),
): GoalToolViewEnvelope {
	const goal = state?.goal;
	const activeBatch =
		goal?.currentWorkstreamBatch &&
		goal.currentWorkstreamBatch.targetId === goal.currentTarget?.id &&
		goal.currentWorkstreamBatch.targetPlanId === goal.currentTargetPlan?.id &&
		goal.currentWorkstreamBatch.targetPlanRevision === goal.currentTargetPlan?.revision
			? goal.currentWorkstreamBatch
			: undefined;
	const executionSummary = buildGoalTargetPlanExecutionSummary(
		goal?.currentTargetPlan,
		goal?.currentTarget,
		activeBatch,
	);
	const executionContract = buildGoalTargetPlanExecutionContract(executionSummary);
	const frame = goal?.parentFrame;
	const latestCheckpoint = goal?.checkpoints?.at(-1);
	const policy = state ? goalRunModePolicy(state.runMode) : { allowedNextActs: [], disallowedNextActs: [] };
	const viewRefs = {
		fullState: 'goal({op:"get"})',
		routing: 'goal({op:"get", view:"routing"})',
		activePlan: 'goal({op:"get", view:"active_plan"})',
		evidenceStatus: 'goal({op:"get", view:"evidence_status"})',
		unresolved: 'goal({op:"get", view:"unresolved"})',
		stateSize: 'goal({op:"get", view:"state_size"})',
	};
	const payloads: Record<GoalGetViewName, Record<string, unknown>> = {
		full: { state: state ? serializeGoalModeState(state) : null },
		routing: {
			runMode: state?.runMode,
			nextAction: goalGetViewNextAction(state),
			requiredOperation: goalGetViewRequiredOperation(state),
			allowedNextActs: policy.allowedNextActs,
			disallowedNextActs: policy.disallowedNextActs,
			currentTargetId: goal?.currentTarget?.id,
			currentTargetTitle: goal?.currentTarget?.title,
			currentTargetPlanId: goal?.currentTargetPlan?.id,
			currentTargetPlanPath: goal?.currentTargetPlan?.planFilePath,
			pendingCheckpointId: goal?.pendingCheckpointId,
			workstreamBatchId: goal?.currentWorkstreamBatch?.id,
			blockedStateId: goal?.currentBlockedState?.id,
			refs: viewRefs,
		},
		state: {
			runMode: state?.runMode,
			stateVersion: state?.stateVersion,
			parentFrameVersion: state?.parentFrameVersion,
			tokensUsed: goal?.tokensUsed ?? 0,
			tokenBudget: goal?.tokenBudget,
			currentTargetId: goal?.currentTarget?.id,
			currentTargetPlanId: goal?.currentTargetPlan?.id,
			pendingCheckpointId: goal?.pendingCheckpointId,
		},
		active_plan: {
			currentTarget: goal?.currentTarget
				? {
						id: goal.currentTarget.id,
						title: goal.currentTarget.title,
						status: goal.currentTarget.status,
						desiredFutureClaim: goal.currentTarget.desiredFutureClaim,
						closureStandard: goal.currentTarget.closureStandard,
					}
				: undefined,
			currentTargetPlan: goal?.currentTargetPlan
				? {
						id: goal.currentTargetPlan.id,
						status: goal.currentTargetPlan.status,
						revision: goal.currentTargetPlan.revision,
						planFilePath: goal.currentTargetPlan.planFilePath,
					}
				: undefined,
			executionContract,
		},
		proof_path: {
			acceptedClaims: frame?.acceptedClaims?.map(claim => claim.id) ?? [],
			candidateClaims: frame?.candidateClaims?.map(claim => claim.id) ?? [],
			rejectedOrStaleClaims: frame?.rejectedOrStaleClaims?.map(claim => claim.id) ?? [],
			boundaries: frame?.boundaries?.map(boundary => boundary.id) ?? [],
			residuals: frame?.residuals?.map(residual => residual.id) ?? [],
			checkpoints: goal?.checkpoints?.map(checkpoint => checkpoint.id) ?? [],
			pendingCheckpointId: goal?.pendingCheckpointId,
		},
		proof: {
			parentClaims: {
				accepted: frame?.acceptedClaims?.length ?? 0,
				candidate: frame?.candidateClaims?.length ?? 0,
				rejectedOrStale: frame?.rejectedOrStaleClaims?.length ?? 0,
			},
			boundaries: frame?.boundaries?.length ?? 0,
			residuals: frame?.residuals?.length ?? 0,
			checkpoints: goal?.checkpoints?.length ?? 0,
			pendingCheckpointId: goal?.pendingCheckpointId,
		},
		unresolved: {
			blockedState: goal?.currentBlockedState
				? {
						id: goal.currentBlockedState.id,
						kind: goal.currentBlockedState.kind,
						message: goal.currentBlockedState.message,
						blockers: [...goal.currentBlockedState.blockers],
					}
				: undefined,
			pendingCheckpointId: goal?.pendingCheckpointId,
			remainingQuestions: latestCheckpoint?.remainingQuestions ?? [],
			parentResiduals: frame?.residuals?.map(residual => ({
				id: residual.id,
				statement: residual.statement,
				classification: residual.classification,
			})),
		},
		diff: {
			stateVersion: state?.stateVersion,
			parentFrameVersion: state?.parentFrameVersion,
			currentTargetId: goal?.currentTarget?.id,
			currentTargetPlanId: goal?.currentTargetPlan?.id,
			pendingCheckpointId: goal?.pendingCheckpointId,
			latestResolutionId: goal?.checkpointResolutions?.at(-1)?.id,
		},
		state_size: {
			serializedBytes: state ? jsonByteLength(serializeGoalModeState(state)) : 0,
			promptSurfaceBytes: state ? jsonByteLength(buildGoalContextSurface(state, state.goal)) : 0,
			checkpointCount: goal?.checkpoints?.length ?? 0,
			targetPlanCount: goal?.targetPlans?.length ?? 0,
			proofGraphBytes: state ? measureGoalProofGraph(state, generatedAt).serializedBytes : 0,
		},
		parent_burndown: {
			acceptedClaims: frame?.acceptedClaims?.length ?? 0,
			candidateClaims: frame?.candidateClaims?.length ?? 0,
			rejectedOrStaleClaims: frame?.rejectedOrStaleClaims?.length ?? 0,
			residuals: frame?.residuals?.length ?? 0,
			boundaries: frame?.boundaries?.length ?? 0,
			gates: frame?.gates?.length ?? 0,
			latestResolutionId: goal?.checkpointResolutions?.at(-1)?.id,
		},
		evidence_status: {
			requiredSignals:
				executionSummary?.requiredSignals.map(signal => ({
					id: signal.id,
					role: signal.role,
					layer: signal.layer,
					staleIf: [...signal.staleIf],
				})) ?? [],
			currentEvidenceCount:
				goal?.checkpoints?.flatMap(checkpoint => checkpoint.evidence).filter(item => item.current).length ?? 0,
			staleEvidenceCount:
				goal?.checkpoints?.flatMap(checkpoint => checkpoint.evidence).filter(item => !item.current).length ?? 0,
			verificationCommands: goal?.verificationCommands?.length ?? 0,
			latestCheckpointId: latestCheckpoint?.id,
		},
	};
	return {
		name,
		goalId: goal?.id,
		stateVersion: state?.stateVersion,
		parentFrameVersion: state?.parentFrameVersion,
		generatedAt,
		payload: payloads[name],
	};
}

export function buildGoalTargetPlanExecutionGuardrails(
	summary: GoalTargetPlanExecutionSummary | undefined,
): Record<string, unknown> | undefined {
	if (!summary) return undefined;

	const guardrails: Record<string, unknown> = {};
	const setIfPresent = (key: string, value: unknown) => {
		if (value === undefined || value === null) return;
		if (typeof value === "string" && value.length === 0) return;
		if (Array.isArray(value) && value.length === 0) return;
		guardrails[key] = value;
	};

	setIfPresent("targetId", summary.targetId);
	setIfPresent("targetPlanId", summary.targetPlanId);
	setIfPresent("planFilePath", summary.planFilePath);
	setIfPresent("payloadFilePath", summary.payloadFilePath);
	setIfPresent("revision", summary.revision);
	setIfPresent("targetTitle", summary.targetTitle);
	setIfPresent("closureStandard", summary.closureStandard);
	setIfPresent("planDepth", summary.planDepth);
	setIfPresent("primarySignalGroupId", summary.primarySignalGroupId);
	setIfPresent("implementationFanoutRequired", summary.implementationFanoutRequired);
	setIfPresent("implementationFiles", summary.implementationFiles);
	setIfPresent(
		"workstreams",
		summary.workstreams?.map(workstream => ({
			id: workstream.id,
			label: workstream.label,
			kind: workstream.kind,
			role: workstream.role,
			files: [...workstream.files],
		})),
	);
	setIfPresent(
		"requiredSignals",
		summary.requiredSignals.map(signal => ({
			id: signal.id,
			role: signal.role,
			layer: signal.layer,
			claim: signal.claim,
			method: signal.method,
			expectedOutcome: signal.expectedOutcome,
			confidenceIfSatisfied: signal.confidenceIfSatisfied,
			staleIf: [...signal.staleIf],
		})),
	);
	setIfPresent("reviewLenses", summary.reviewLenses);
	setIfPresent("excludedWork", summary.excludedWork);
	setIfPresent("nonGoals", summary.nonGoals);
	setIfPresent("forbiddenClaims", summary.forbiddenClaims);
	setIfPresent("knownLimits", summary.knownLimits);
	setIfPresent("checkpointEvidence", summary.checkpointEvidence);
	setIfPresent(
		"readPayloadFileWhen",
		"Approved Markdown plan lacks exact command, contract, matrix, or recovery detail; read the payload sidecar.",
	);
	return guardrails;
}

function compactTargetUnitRulesForPrompt(rules: GoalTargetUnitRule[] | undefined): GoalPromptObject[] | undefined {
	if (!rules?.length) return undefined;
	return rules.map(rule => ({
		id: rule.id,
		kind: rule.kind,
		statement: rule.statement,
		source: rule.source,
		enforcement: rule.enforcement,
	}));
}

function compactBlockedStateForPrompt(block: GoalBlockedState | undefined): GoalPromptObject | undefined {
	if (!block) return undefined;
	return {
		id: block.id,
		kind: block.kind,
		message: block.message,
		blockers: block.blockers,
		suggestedQuestions: block.suggestedQuestions,
		source: block.source,
		allowedActions: block.allowedActions,
		requiredOperation: block.allowedActions.length > 0 ? "recover_blocked_state" : undefined,
		broaderChecksOrInputs: block.kind === "checkpoint-external-pause" ? block.broaderChecksOrInputs : undefined,
		remainingParentWork: block.kind === "checkpoint-external-pause" ? block.remainingParentWork : undefined,
	};
}

const TARGET_APERTURE_GUIDANCE_MAX_LENGTH = 1_600;

function truncateTargetApertureGuidance(guidance: string): string {
	if (guidance.length <= TARGET_APERTURE_GUIDANCE_MAX_LENGTH) return guidance;
	return `${guidance.slice(0, TARGET_APERTURE_GUIDANCE_MAX_LENGTH - 1)}…`;
}

function extractTargetApertureGuidance(rubric: string | undefined): GoalPromptObject | undefined {
	if (!rubric?.trim()) return undefined;
	const lines = rubric.split("\n");
	const collected: string[] = [];
	let inSection = false;

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		const trimmed = line.trim();
		if (!inSection) {
			const headingMatch = /^#{1,6}\s*Target aperture guidance\b[:\s—-]*(.*)$/i.exec(trimmed);
			const labelMatch = /^(?:[-*+]\s*)?Target aperture guidance\b[:\s—-]*(.*)$/i.exec(trimmed);
			const match = headingMatch ?? labelMatch;
			if (!match) continue;
			inSection = true;
			const remainder = match[1]?.trim();
			if (remainder) collected.push(remainder);
			continue;
		}
		if (/^#{1,6}\s+\S/.test(trimmed)) break;
		collected.push(line);
	}

	const guidance = collected.join("\n").trim();
	if (!guidance) return undefined;
	return { source: "goal_rubric", guidance: truncateTargetApertureGuidance(guidance) };
}

function compactCheckpointForPrompt(checkpoint: GoalCheckpointPacket | undefined): GoalPromptObject | undefined {
	if (!checkpoint) return undefined;
	return {
		id: checkpoint.id,
		sequence: checkpoint.sequence,
		targetId: checkpoint.targetId,
		targetTitle: checkpoint.targetSnapshot.title,
		reviewStatus: checkpoint.review?.status,
		summary: checkpoint.summary,
		localClaims: checkpoint.localClaims,
		notClaimed: checkpoint.notClaimed,
		remainingQuestions: checkpoint.remainingQuestions,
		risksOrCaveats: checkpoint.risksOrCaveats,
		staleIf: checkpoint.staleIf,
		requiredAction: "resolve_checkpoint",
	};
}

function compactDeliverableDeltaForPrompt(delta: GoalDeliverableDelta): GoalPromptObject {
	return {
		id: delta.id,
		status: delta.status,
		summary: delta.summary,
		evidenceRefs: compactRefIds(delta.evidenceRefs),
		blockedBy: delta.blockedBy,
		nextRelevantTarget: delta.nextRelevantTarget,
	};
}

function compactResolutionForPrompt(
	resolution: GoalCheckpointResolution | undefined,
	currentTarget: GoalTarget | undefined,
): GoalPromptObject | undefined {
	if (!resolution) return undefined;
	const nextTargetMatchesCurrent =
		resolution.nextTarget !== undefined &&
		currentTarget !== undefined &&
		resolution.nextTarget.id === currentTarget.id;
	return {
		id: resolution.id,
		sequence: resolution.sequence,
		checkpointId: resolution.checkpointId,
		decision: resolution.decision,
		parentReading: resolution.parentReading,
		admittedClaimIds: resolution.parentDelta?.admittedClaims.map(claim => claim.id),
		deliverableDeltas: resolution.parentDelta?.deliverableDeltas?.map(compactDeliverableDeltaForPrompt),
		notPropagated: resolution.notPropagated,
		remainingParentWork: resolution.remainingParentWork,
		broaderChecksOrInputs: resolution.broaderChecksOrInputs,
		lessonsForFuture: resolution.lessonsForFuture,
		nextTargetId: resolution.nextTarget?.id,
		nextTargetTitle: resolution.nextTarget && !nextTargetMatchesCurrent ? resolution.nextTarget.title : undefined,
	};
}

function compactVerifierRepairForPrompt(repair: GoalVerificationRepairState | undefined): GoalPromptObject | undefined {
	if (!repair) return undefined;
	return {
		attempt: repair.verificationAttemptId,
		feedback: repair.feedback,
		blockers: compactVerificationGaps(repair.blockers),
		evidenceToCollect: repair.evidenceToCollect,
		avoidRepeating: repair.avoidRepeating,
		requiredAction: "repair_verifier_blockers",
	};
}

export interface GoalRunModePolicy {
	allowedNextActs: string[];
	disallowedNextActs: string[];
}

export function goalRunModePolicy(runMode: GoalRunMode): GoalRunModePolicy {
	return {
		allowedNextActs: allowedActsForRunMode(runMode),
		disallowedNextActs: disallowedActsForRunMode(runMode),
	};
}

function policyForRunMode(runMode: GoalRunMode): GoalPromptObject {
	const policy = goalRunModePolicy(runMode);
	return {
		invariant: [
			"target closure is not parent completion",
			"parent truth changes only through goal.resolve_checkpoint.parent_delta",
		],
		now: policy.allowedNextActs,
		blocked: policy.disallowedNextActs,
	};
}

function isPromptObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prunePromptValue(value: unknown): unknown {
	if (value === undefined || value === null) return undefined;
	if (Array.isArray(value)) {
		const prunedItems = value.map(prunePromptValue).filter(item => item !== undefined);
		return prunedItems.length ? prunedItems : undefined;
	}
	if (!isPromptObject(value)) return value;
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const pruned = prunePromptValue(item);
		if (pruned !== undefined) output[key] = pruned;
	}
	return Object.keys(output).length ? output : undefined;
}

export function buildGoalContextSurface(state: GoalModeState | undefined, goal: Goal): GoalContextSurface {
	const runMode = state?.runMode ?? "working-target";
	const currentTarget = goal.currentTarget;
	const checkpoint = latestCheckpoint(goal);
	const resolution = latestResolution(goal);
	const surface: GoalContextSurface = {
		goal: {
			id: goal.id,
			status: goal.status,
			invariant: "Target closure is not parent completion; parent completion requires verifier acceptance.",
		},
		run: {
			mode: runMode,
			stateVersion: state?.stateVersion ?? 0,
			parentFrameVersion: state?.parentFrameVersion ?? (goal.parentFrame ? 1 : 0),
		},
		policy: policyForRunMode(runMode),
		deliverables: compactDeliverablesForPrompt(goal.deliverableMap, currentTarget),
		target_aperture_guidance: extractTargetApertureGuidance(goal.rubric),
		target_unit_rules: compactTargetUnitRulesForPrompt(goal.targetUnitRules),
		parent_truth: compactParentTruthForPrompt(goal.parentFrame, resolution, goal.deliverableMap, currentTarget),
		latest_resolution: compactResolutionForPrompt(resolution, currentTarget),
		refs: {
			fullState: 'goal({op:"get"})',
			checkpointDetails: checkpoint ? `goal({op:"get"}) checkpoint ${checkpoint.id}` : undefined,
		},
	};
	const verificationFreshness = compactVerificationFreshnessForPrompt(goal, currentTarget);
	if (verificationFreshness && runMode !== "planning-target") surface.verification_freshness = verificationFreshness;
	if (runMode === "working-target") {
		const currentBatch = goal.currentWorkstreamBatch;
		const activeBatch =
			currentBatch &&
			currentBatch.targetId === currentTarget?.id &&
			currentBatch.targetPlanId === goal.currentTargetPlan?.id &&
			currentBatch.targetPlanRevision === goal.currentTargetPlan?.revision
				? currentBatch
				: undefined;
		surface.current_target = compactTargetForPrompt(currentTarget);
		surface.workstream_batch = compactWorkstreamBatchForPrompt(activeBatch);
		const executionSummary = buildGoalTargetPlanExecutionSummary(goal.currentTargetPlan, currentTarget, activeBatch);
		const executionContract = buildGoalTargetPlanExecutionContract(executionSummary);
		if (executionContract) surface.target_execution_contract = executionContract;
	} else if (runMode === "planning-target") {
		surface.current_target = compactTargetForPrompt(currentTarget);
		surface.target_plan = compactTargetPlanForPrompt(goal.currentTargetPlan);
	} else if (runMode === "awaiting-checkpoint-resolution") {
		surface.checkpoint = compactCheckpointForPrompt(checkpoint);
	} else if (runMode === "awaiting-parent-completion") {
		surface.parent_completion = {
			requiredAction: "complete",
			latestResolutionId: resolution?.id,
			remainingParentWork: resolution?.remainingParentWork,
			notPropagated: resolution?.notPropagated,
		};
	} else if (runMode === "awaiting-verification-repair") {
		surface.verifier_repair = compactVerifierRepairForPrompt(goal.verificationRepair);
		surface.current_target = targetLinksBlockers(currentTarget, goal.verificationRepair?.blockers ?? [])
			? compactTargetForPrompt(currentTarget)
			: undefined;
	} else if (runMode === "awaiting-user-input") {
		surface.blocked_state = compactBlockedStateForPrompt(goal.currentBlockedState);
		if (goal.currentBlockedState?.kind === "target-plan") {
			surface.current_target = compactTargetForPrompt(currentTarget);
			surface.target_plan = compactTargetPlanForPrompt(goal.currentTargetPlan);
		}
	}
	return surface;
}

export function renderGoalPromptSurface(state: GoalModeState | undefined, goal: Goal): string {
	return escapeJsonForPrompt(prunePromptValue(buildGoalContextSurface(state, goal)) ?? {});
}

function guidanceSummary(guidance: string): string {
	const firstLines = guidance
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.slice(0, 6)
		.join(" ");
	return firstLines.length > 800 ? `${firstLines.slice(0, 800)}…` : firstLines;
}

export function renderGoalStateSnapshot(state: GoalModeState | undefined, goal: Goal): string {
	const snapshot = {
		stateVersion: state?.stateVersion ?? 0,
		parentFrameVersion: state?.parentFrameVersion ?? (goal.parentFrame ? 1 : 0),
		runMode: state?.runMode ?? "working-target",
		parentGoal: {
			id: goal.id,
			status: goal.status,
		},
		parentFrame: compactParentFrame(goal.parentFrame, goal.objective),
		deliverableMap: compactDeliverableMap(goal.deliverableMap),
		currentTarget: compactTarget(goal.currentTarget),
		currentWorkstreamBatch: compactWorkstreamBatchForPrompt(goal.currentWorkstreamBatch),
		verificationFreshness: compactVerificationFreshnessForPrompt(goal, goal.currentTarget),
		pendingCheckpoint: compactCheckpoint(latestCheckpoint(goal)),
		latestCheckpointResolution: compactResolution(latestResolution(goal)),
		lastCheckpointRejection: goal.lastCheckpointRejection
			? {
					candidateSummary: goal.lastCheckpointRejection.candidateSummary,
					feedback: goal.lastCheckpointRejection.review.feedback,
					blockers: compactVerificationGaps(goal.lastCheckpointRejection.review.blockers),
				}
			: undefined,
		verificationRepair: compactGoalVerificationRepair(goal.verificationRepair),
	};
	return escapeJsonForPrompt(snapshot);
}

export function buildGoalContinuationPacket(
	state: GoalModeState,
	transition: GoalContinuationPacket["transition"],
	reason: string,
	continuationGuidance: string,
): GoalContinuationPacket {
	const goal = state.goal;
	const frame = goal.parentFrame;
	const checkpoint = latestCheckpoint(goal);
	return {
		transition,
		reason,
		stateVersion: state.stateVersion,
		runMode: state.runMode,
		parentGoalId: goal.id,
		parentFrameVersion: state.parentFrameVersion,
		parentFrameKind: frame?.kind,
		currentTargetPlanId: goal.currentTargetPlan?.id,
		currentTargetPlanRevision: goal.currentTargetPlan?.revision,
		currentTargetPlanFilePath: goal.currentTargetPlan?.planFilePath,
		currentTargetPlanPayloadFilePath: goal.currentTargetPlan
			? targetPlanPayloadFilePath(goal.currentTargetPlan.planFilePath)
			: undefined,
		currentTargetId: goal.currentTarget?.id,
		currentWorkstreamBatchId: goal.currentWorkstreamBatch?.id,
		currentWorkstreamBatchStatus: goal.currentWorkstreamBatch?.status,
		currentWorkstreamStatuses: goal.currentWorkstreamBatch?.workstreams.map(
			run => `${run.workstreamId}:${run.status}${run.agentId ? `:${run.agentId}` : ""}`,
		),
		pendingCheckpointId: goal.pendingCheckpointId,
		verificationAttemptId: goal.verificationRepair?.verificationAttemptId,
		parentGoalStillActive: goal.status === "active" || goal.status === "budget-limited",
		currentTargetStillOpen: goal.currentTarget?.status === "active",
		allowedNextActs: allowedActsForRunMode(state.runMode),
		disallowedNextActs: disallowedActsForRunMode(state.runMode),
		continuationGuidanceSummary: guidanceSummary(continuationGuidance),
		nonClaims: [
			...(checkpoint?.notClaimed ?? []),
			...(goal.currentTarget?.forbiddenClaims ?? []),
			...(frame?.boundaries.map(boundary => boundary.statement) ?? []),
		],
		parentBoundaries: frame?.boundaries.map(boundary => `${boundary.id}: ${boundary.statement}`) ?? [],
		parentResiduals: frame?.residuals.map(residual => `${residual.id}: ${residual.statement}`) ?? [],
		parentGateStatuses: frame?.gates.map(gate => `${gate.id}: ${gate.status}`) ?? [],
	};
}

function allowedActsForRunMode(runMode: GoalRunMode): string[] {
	switch (runMode) {
		case "planning-target":
			return [
				'Call goal({op:"lint_target_plan", payload_file_path:...}) before submit_target_plan',
				'Call goal({op:"submit_target_plan", payload_file_path:...}) or goal({op:"fail_target_plan", ...})',
				"Edit or eval/bash-transform only the active target plan/payload sidecar",
				"Use planning-only agent()/task discovery and review",
				"Create missing target-plan files; patch or structured-transform existing plan and payload sidecar in place",
			];
		case "awaiting-checkpoint-resolution":
			return ['Call goal({op:"resolve_checkpoint", ...}) before ordinary tools'];
		case "completed":
			return ["Report completed parent goal outcome"];
		case "awaiting-parent-completion":
			return ['Call goal({op:"complete"}) for parent completion verification'];
		case "awaiting-verification-repair":
			return ['Call goal({op:"start_target", linked_verifier_blocker_ids:[...]}) or gather repair evidence'];
		case "awaiting-user-input":
			return [
				"Wait unless new user/broader-check/external input resolves blocked_state",
				'If blocked_state.requiredOperation is recover_blocked_state, call goal({op:"recover_blocked_state", ...}) with blocked_state identity and one allowed action',
			];
		default:
			return [
				"Continue current target",
				'Call goal({op:"start_target", ...}) if no current target exists',
				'Call goal({op:"checkpoint", ...}) only after target closure evidence',
			];
	}
}

function disallowedActsForRunMode(runMode: GoalRunMode): string[] {
	switch (runMode) {
		case "planning-target":
			return [
				"Implement code changes",
				"Run implementation/build/test/repo-mutating commands",
				"Checkpoint target work",
				"Call complete",
				"Shrink the target to pass review",
			];
		case "awaiting-checkpoint-resolution":
			return ["Continue local implementation", "Mutate parent frame in prose", "Call complete before resolution"];
		case "completed":
			return ["Resume local implementation under the completed goal"];
		case "awaiting-parent-completion":
			return ["Continue local implementation", "Start another target", "Checkpoint target work"];
		case "awaiting-verification-repair":
			return ["Retry complete without fresh repair/evidence", "Choose unrelated work"];
		case "awaiting-user-input":
			return [
				"Auto-continue ordinary work",
				"Call resume to recover blocked work",
				"Call start_target directly while blocked_state is open",
				"Invent a recovery action not listed in blocked_state.allowedActions",
			];
		default:
			return ["Checkpoint partial/fatigue/budget work", "Treat target closure as parent completion"];
	}
}

export function renderGoalPrompt(kind: GoalPromptKind, goal: Goal, state?: GoalModeState): string {
	const template =
		kind === "active"
			? goalModeActivePrompt
			: kind === "continuation"
				? goalContinuationPrompt
				: goalBudgetLimitPrompt;
	const verificationAttempt = goal.lastVerificationAttempt ?? goal.failedCompletionAttempts ?? 0;
	return prompt.render(template, {
		objective: escapeXmlText(goal.objective),
		failedCompletionAttempts: String(verificationAttempt),
		lastVerificationFeedback: optionalPromptSection(goal.lastVerificationFeedback),
		tokensUsed: String(goal.tokensUsed),
		tokenBudget: budgetValue(goal),
		remainingTokens: remainingValue(goal),
		timeUsedSeconds: String(goal.timeUsedSeconds),
		runMode: state?.runMode ?? "working-target",
		stateVersion: String(state?.stateVersion ?? 0),
		parentFrameVersion: String(state?.parentFrameVersion ?? (goal.parentFrame ? 1 : 0)),
		goalContextSurface: renderGoalPromptSurface(state, goal),
	});
}

export function completionBudgetReport(goal: Goal): string | null {
	const parts: string[] = [];
	if (goal.tokenBudget !== undefined) {
		parts.push(`tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}`);
	}
	if (goal.timeUsedSeconds > 0) {
		parts.push(`time used: ${goal.timeUsedSeconds} seconds`);
	}
	if (parts.length === 0) return null;
	return `Goal achieved. Report final budget usage to the user: ${parts.join("; ")}.`;
}

function validateTokenBudget(tokenBudget: number | undefined): void {
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new Error("goal token_budget must be a positive integer when provided");
	}
}

const TARGET_PLAN_REJECTION_CAP = 3;

export function sanitizeGoalPlanSlug(value: string): string {
	const sanitized = value.replaceAll(/[^A-Za-z0-9_-]/g, "-").replaceAll(/^-+|-+$/g, "");
	return sanitized || "goal";
}

const WORKSTREAM_SCAFFOLD_TASK_ID_MAX = 48;

function sanitizeWorkstreamIdentifier(value: string, fallback: string): string {
	const sanitized = value
		.replaceAll(/[^A-Za-z0-9_-]/g, "-")
		.replaceAll(/-+/g, "-")
		.replaceAll(/^-+|-+$/g, "");
	return sanitized || fallback;
}

function truncateIdentifierWithSuffix(base: string, suffix: string): string {
	const limit = WORKSTREAM_SCAFFOLD_TASK_ID_MAX - suffix.length;
	return `${base.slice(0, Math.max(1, limit))}${suffix}`;
}

export function buildWorkstreamScaffoldTaskIds(workstreams: GoalTargetWorkstream[]): Map<string, string> {
	const reserved = new Set<string>();
	const attempts = new Map<string, number>();
	const ids = new Map<string, string>();
	for (const workstream of workstreams) {
		const rawBase = sanitizeWorkstreamIdentifier(workstream.id, "workstream").slice(
			0,
			WORKSTREAM_SCAFFOLD_TASK_ID_MAX,
		);
		const base = rawBase || "workstream";
		let attempt = attempts.get(base) ?? 1;
		let candidate = attempt === 1 ? base : truncateIdentifierWithSuffix(base, `-${attempt}`);
		while (reserved.has(candidate)) {
			attempt += 1;
			candidate = truncateIdentifierWithSuffix(base, `-${attempt}`);
		}
		attempts.set(base, attempt + 1);
		reserved.add(candidate);
		ids.set(workstream.id, candidate);
	}
	return ids;
}

function targetPlanAcknowledgesParallelWorkstreams(plan: GoalTargetPlanRecord): boolean {
	return plan.scopeCalibration?.targetUnitRuleIds?.includes("parallel-workstreams-required") === true;
}

function nonDocWorkstreams(plan: GoalTargetPlanRecord): GoalTargetWorkstream[] {
	return plan.targetCard?.workstreams?.filter(workstream => workstream.kind !== "docs-changelog") ?? [];
}

function buildWorkstreamBatchId(targetId: string, planId: string, revision: number): string {
	return sanitizeWorkstreamIdentifier(`wsb-${targetId}-${planId}-${revision}`, "workstream-batch");
}

export function buildWorkstreamBatchFromApprovedPlan(input: {
	goal: Goal;
	target: GoalTarget;
	plan: GoalTargetPlanRecord;
	planFilePath: string;
	payloadFilePath: string;
	now: number;
}): GoalWorkstreamBatch | undefined {
	const requirement = input.target.parallelWorkstreamRequirement;
	const acknowledgedRule = targetPlanAcknowledgesParallelWorkstreams(input.plan);
	const workstreams = input.plan.targetCard?.workstreams ?? [];
	const actionableWorkstreams = nonDocWorkstreams(input.plan);
	const required = requirement?.required === true || acknowledgedRule;
	const shouldCreate =
		required || acknowledgedRule || requirement?.required === true || actionableWorkstreams.length >= 2;
	if (!shouldCreate) return undefined;
	const minRequiredNonDocWorkstreams = requirement?.minNonDocWorkstreams ?? 2;
	if (required && actionableWorkstreams.length < minRequiredNonDocWorkstreams) {
		throw new Error(
			`Parallel workstream execution is required for this target, but the approved target plan defines ${actionableWorkstreams.length} non-doc workstream(s); expected at least ${minRequiredNonDocWorkstreams}.`,
		);
	}
	const sharedContract = input.plan.targetCard?.sharedContract?.trim();
	if (required && requirement?.sharedContractRequired !== false && !sharedContract) {
		throw new Error(
			"Parallel workstream execution is required for this target, but target_card.shared_contract is empty.",
		);
	}
	if (workstreams.length === 0) return undefined;
	const scaffoldTaskIds = buildWorkstreamScaffoldTaskIds(workstreams);
	return {
		id: buildWorkstreamBatchId(input.target.id, input.plan.id, input.plan.revision),
		goalId: input.goal.id,
		targetId: input.target.id,
		targetPlanId: input.plan.id,
		targetPlanRevision: input.plan.revision,
		planFilePath: input.planFilePath,
		payloadFilePath: input.payloadFilePath,
		required,
		implementationFanoutRequired: implementationFanoutRequired(input.plan) === true,
		sharedContract: sharedContract || undefined,
		status: "pending-launch",
		workstreams: workstreams.map(workstream => ({
			workstreamId: workstream.id,
			scaffoldTaskId: scaffoldTaskIds.get(workstream.id),
			label: workstream.label,
			kind: workstream.kind,
			role: workstream.role,
			files: [...workstream.files],
			contractInputs: [...workstream.contractInputs],
			contractOutputs: [...workstream.contractOutputs],
			status: "pending",
			updatedAt: input.now,
		})),
		createdAt: input.now,
		updatedAt: input.now,
	};
}

function formatWorkstreamList(values: string[]): string {
	return values.length ? values.map(value => `- ${value}`).join("\n") : "- none";
}

function buildTaskBatchScaffold(batch: GoalWorkstreamBatch | undefined): GoalTaskBatchScaffold | undefined {
	if (!batch) return undefined;
	return {
		required: batch.required,
		batchId: batch.id,
		agent: "task",
		context: [
			"# Goal",
			`Execute workstream batch ${batch.id} for goal ${batch.goalId}, target ${batch.targetId}.`,
			"",
			"# Constraints",
			`- target_plan_id: ${batch.targetPlanId}`,
			`- target_plan_revision: ${batch.targetPlanRevision}`,
			`- plan_file_path: ${batch.planFilePath}`,
			`- payload_file_path: ${batch.payloadFilePath}`,
			"- Subagents do not run project-wide tests, lint, or formatters; main agent owns final integration and verification.",
			"- Subagents do not mark the parent target complete or call goal checkpoint/completion tools.",
			"",
			"# Contract",
			batch.sharedContract ?? "No shared contract was provided; obey each workstream's inputs/outputs exactly.",
		].join("\n"),
		tasks: batch.workstreams.map(workstream => ({
			id: workstream.scaffoldTaskId ?? workstream.workstreamId,
			description: workstream.label,
			role: workstream.role ?? `${workstream.label} workstream specialist`,
			assignment: [
				"# Target",
				`Workstream ${workstream.workstreamId}: ${workstream.label}.`,
				`Files:\n${formatWorkstreamList(workstream.files)}`,
				"Non-goal: do not mark the parent target complete or call goal checkpoint/completion tools.",
				"",
				"# Change",
				`Use approved plan ${batch.planFilePath} and payload ${batch.payloadFilePath}.`,
				`Contract inputs:\n${formatWorkstreamList(workstream.contractInputs)}`,
				`Contract outputs:\n${formatWorkstreamList(workstream.contractOutputs)}`,
				"Implement only this workstream and coordinate contract conflicts through the main agent or siblings.",
				"",
				"# Acceptance",
				"Return changed files, behavior evidence, blockers, and integration notes for this workstream.",
				"Skip project-wide gates, formatters, and full-suite tests; main agent verifies the integrated target.",
			].join("\n"),
		})),
	};
}

function isAccountingStatus(goal: Goal): boolean {
	return goal.status === "active" || goal.status === "budget-limited";
}

function trimmed(value: string, field: string): string {
	const result = value.trim();
	if (!result) throw new Error(`${field} is required`);
	return result;
}

function cloneRefs(refs: GoalRef[] | undefined): GoalRef[] {
	return refs?.map(ref => ({ ...ref })) ?? [];
}

function cloneStringArray(value: string[] | undefined): string[] {
	return value ? [...value] : [];
}

function normalizedCheckpointEvidenceId(item: GoalCheckpointEvidenceItem, index: number): string {
	const id = item.id?.trim();
	return id && id.length > 0 ? id : `evidence-${index + 1}`;
}

function checkpointEvidenceItemRefs(
	checkpointId: string,
	evidenceId: string,
	item: GoalCheckpointEvidenceItem,
): GoalRef[] {
	const refs = [
		{
			id: checkpointEvidenceRefId(checkpointId, evidenceId),
			kind: "artifact" as const,
			label: item.claim,
		},
		...cloneRefs(item.evidenceRefs),
	];
	const output: GoalRef[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		if (seen.has(ref.id)) continue;
		seen.add(ref.id);
		output.push({ ...ref });
	}
	return output;
}

function normalizeCheckpointEvidenceItems(
	evidence: GoalCheckpointEvidenceItem[],
	checkpointId: string,
): GoalCheckpointEvidenceItem[] {
	return evidence.map((item, index) => {
		const id = normalizedCheckpointEvidenceId(item, index);
		const refs = checkpointEvidenceItemRefs(checkpointId, id, item);
		return {
			id,
			claim: trimmed(item.claim, "evidence[].claim"),
			evidence: trimmed(item.evidence, "evidence[].evidence"),
			current: item.current,
			signalIds: cloneStringArray(item.signalIds),
			scenarioRowIds: cloneStringArray(item.scenarioRowIds),
			workstreamIds: cloneStringArray(item.workstreamIds),
			verificationCommandIds: cloneStringArray(item.verificationCommandIds),
			evidenceRefs: refs,
			staleIf: cloneStringArray(item.staleIf),
		};
	});
}

function approvedPlanForTarget(goal: Goal, targetId: string): GoalTargetPlanRecord | undefined {
	if (goal.currentTargetPlan?.targetId === targetId && goal.currentTargetPlan.status === "approved") {
		return goal.currentTargetPlan;
	}
	return goal.targetPlans?.find(plan => plan.targetId === targetId && plan.status === "approved");
}

function missingCheckpointCoverage(
	requiredIds: string[],
	evidence: GoalCheckpointEvidenceItem[],
	key: keyof GoalCheckpointEvidenceItem,
): string[] {
	if (requiredIds.length === 0) return [];
	const covered = new Set<string>();
	for (const item of evidence) {
		const values = item[key];
		if (!Array.isArray(values)) continue;
		for (const value of values) {
			if (typeof value === "string" && value.trim()) covered.add(value);
		}
	}
	return requiredIds.filter(id => !covered.has(id));
}

function assertCheckpointEvidenceCoversPlan(
	goal: Goal,
	target: GoalTarget,
	evidence: GoalCheckpointEvidenceItem[],
): void {
	const plan = approvedPlanForTarget(goal, target.id);
	if (!plan) return;
	const requiredSignalIds = uniqueStrings(
		plan.verificationSignals?.filter(signal => signal.required).map(signal => signal.id) ?? [],
	);
	const scenarioRowIds = uniqueStrings(plan.scenarioMatrix?.rowsInScope.map(row => row.id) ?? []);
	const workstreamIds = uniqueStrings(plan.targetCard?.workstreams?.map(workstream => workstream.id) ?? []);
	const missingSignals = missingCheckpointCoverage(requiredSignalIds, evidence, "signalIds");
	const missingRows = missingCheckpointCoverage(scenarioRowIds, evidence, "scenarioRowIds");
	const missingWorkstreams = missingCheckpointCoverage(workstreamIds, evidence, "workstreamIds");
	if (missingSignals.length || missingRows.length || missingWorkstreams.length) {
		const parts: string[] = [];
		if (missingSignals.length) parts.push(`signal_ids=${missingSignals.join(",")}`);
		if (missingRows.length) parts.push(`scenario_row_ids=${missingRows.join(",")}`);
		if (missingWorkstreams.length) parts.push(`workstream_ids=${missingWorkstreams.join(",")}`);
		throw new Error(`checkpoint evidence coverage missing: ${parts.join("; ")}`);
	}
}

function checkpointEvidenceRefs(checkpoint: GoalCheckpointPacket): GoalRef[] {
	return checkpoint.evidence.flatMap((item, index) =>
		checkpointEvidenceItemRefs(checkpoint.id, normalizedCheckpointEvidenceId(item, index), item),
	);
}

function replaceLegacyCheckpointRef(
	refs: GoalRef[] | undefined,
	checkpoint: GoalCheckpointPacket,
): GoalRef[] | undefined {
	if (!refs) return undefined;
	const legacyId = `checkpoint:${checkpoint.id}`;
	const evidenceRefs = checkpointEvidenceRefs(checkpoint);
	const output: GoalRef[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		const replacements = ref.id === legacyId ? [{ ...ref }, ...evidenceRefs] : [{ ...ref }];
		for (const replacement of replacements) {
			if (seen.has(replacement.id)) continue;
			seen.add(replacement.id);
			output.push({ ...replacement });
		}
	}
	return output;
}

function normalizeParentDeltaCheckpointEvidenceRefs(
	delta: GoalParentStateDelta,
	checkpoint: GoalCheckpointPacket,
): GoalParentStateDelta {
	return {
		admittedClaims: delta.admittedClaims.map(claim => ({
			...claim,
			evidenceRefs: replaceLegacyCheckpointRef(claim.evidenceRefs, checkpoint),
			nonImplications: claim.nonImplications ? [...claim.nonImplications] : undefined,
		})),
		candidateClaimsAdded: delta.candidateClaimsAdded.map(claim => ({
			...claim,
			evidenceRefs: replaceLegacyCheckpointRef(claim.evidenceRefs, checkpoint),
			nonImplications: claim.nonImplications ? [...claim.nonImplications] : undefined,
		})),
		rejectedClaims: delta.rejectedClaims.map(claim => ({
			...claim,
			evidenceRefs: replaceLegacyCheckpointRef(claim.evidenceRefs, checkpoint),
			nonImplications: claim.nonImplications ? [...claim.nonImplications] : undefined,
		})),
		boundariesAdded: delta.boundariesAdded.map(boundary => ({
			...boundary,
			refs: replaceLegacyCheckpointRef(boundary.refs, checkpoint),
		})),
		residualsAddedOrUpdated: delta.residualsAddedOrUpdated.map(residual => ({
			...residual,
			refs: replaceLegacyCheckpointRef(residual.refs, checkpoint),
			requiredEvidence: residual.requiredEvidence ? [...residual.requiredEvidence] : undefined,
			nonImplications: residual.nonImplications ? [...residual.nonImplications] : undefined,
		})),
		gateDeltas: delta.gateDeltas.map(gate => ({
			...gate,
			evidenceRefs: replaceLegacyCheckpointRef(gate.evidenceRefs, checkpoint),
		})),
		frontierDeltas: delta.frontierDeltas.map(item => ({
			...item,
			refs: replaceLegacyCheckpointRef(item.refs, checkpoint),
			evidenceRequired: item.evidenceRequired ? [...item.evidenceRequired] : undefined,
		})),
		staleRefs: replaceLegacyCheckpointRef(delta.staleRefs, checkpoint) ?? [],
		externalRecordRefs: replaceLegacyCheckpointRef(delta.externalRecordRefs, checkpoint) ?? [],
		authorityDecisionRefs: replaceLegacyCheckpointRef(delta.authorityDecisionRefs, checkpoint),
		deliverableDeltas: delta.deliverableDeltas?.map(item => ({
			...item,
			evidenceRefs: replaceLegacyCheckpointRef(item.evidenceRefs, checkpoint),
			blockedBy: item.blockedBy ? [...item.blockedBy] : undefined,
		})),
	};
}

function cloneParallelWorkstreamRequirement(
	requirement: GoalParallelWorkstreamRequirement | undefined,
): GoalParallelWorkstreamRequirement | undefined {
	return requirement
		? {
				...requirement,
				rationale: requirement.rationale.trim(),
			}
		: undefined;
}

function parentDeltaHasFrameChanges(delta: GoalParentStateDelta): boolean {
	return (
		delta.admittedClaims.length > 0 ||
		delta.candidateClaimsAdded.length > 0 ||
		delta.rejectedClaims.length > 0 ||
		delta.boundariesAdded.length > 0 ||
		delta.residualsAddedOrUpdated.length > 0 ||
		delta.gateDeltas.length > 0 ||
		delta.frontierDeltas.length > 0 ||
		delta.staleRefs.length > 0 ||
		delta.externalRecordRefs.length > 0 ||
		(delta.authorityDecisionRefs?.length ?? 0) > 0
	);
}

function parentDeltaHasDeliverableChanges(delta: GoalParentStateDelta): boolean {
	return (delta.deliverableDeltas?.length ?? 0) > 0;
}

function includesEquivalentClaim(values: string[], candidate: string): boolean {
	const normalized = candidate.trim().toLowerCase();
	return values.some(value => value.trim().toLowerCase() === normalized);
}

function withDefaultNotClaimed(values: string[]): string[] {
	const output = [...values];
	for (const claim of DEFAULT_CHECKPOINT_NOT_CLAIMED) {
		if (!includesEquivalentClaim(output, claim)) output.push(claim);
	}
	return output;
}

function nextTargetSequence(goal: Goal): number {
	const current = goal.currentTarget?.sequence ?? 0;
	const history = goal.targets?.reduce((max, target) => Math.max(max, target.sequence), 0) ?? 0;
	return Math.max(current, history) + 1;
}

export function nextTargetPlanAttempt(goal: Goal, target: GoalTarget): number {
	const prefix = `${target.id}-plan-attempt-`;
	let maxAttempt = goal.targetPlans?.some(plan => plan.id === `${target.id}-plan`) ? 1 : 0;
	for (const plan of goal.targetPlans ?? []) {
		if (!plan.id.startsWith(prefix)) continue;
		const suffix = plan.id.slice(prefix.length);
		if (!/^[1-9]\d*$/.test(suffix)) continue;
		const attempt = Number.parseInt(suffix, 10);
		if (attempt > maxAttempt) maxAttempt = attempt;
	}
	return maxAttempt + 1;
}

function recoveryBlockersForTargetPlan(plan: GoalTargetPlanRecord): string[] {
	if (plan.failure?.blockers.length) return [...plan.failure.blockers];
	const blockers = targetPlanRecoveryBlockersFromReviews(plan.reviews);
	return blockers.length ? blockers : [`target plan is ${plan.status}`];
}

function targetPlanReviewNeedsUserInput(reviews: GoalTargetPlanReview[]): boolean {
	return reviews.some(review => review.status === "rejected" && review.revisionDecision === "needs-user-input");
}

function targetPlanRecoveryBlockersFromReviews(reviews: GoalTargetPlanReview[]): string[] {
	const blockers: string[] = [];
	const seen = new Set<string>();
	for (const review of reviews) {
		for (const finding of review.findings) {
			if (finding.severity !== "blocking" && finding.severity !== "important") continue;
			const blocker = `${review.lens}:${finding.id}: ${finding.requiredRevision}`;
			if (seen.has(blocker)) continue;
			seen.add(blocker);
			blockers.push(blocker);
		}
	}
	return blockers;
}

function targetPlanReviewDiagnostic(input: {
	severity: GoalTargetPlanLintDiagnostic["severity"];
	code: string;
	path: Array<string | number>;
	message: string;
	guidance: string;
	review?: GoalTargetPlanReview;
	value?: unknown;
}): GoalTargetPlanLintDiagnostic {
	return lintDiagnostic({
		severity: input.severity,
		code: input.code,
		path: input.path,
		message: input.message,
		guidance: input.guidance,
		offender: {
			kind: "target_plan_review",
			id: input.review?.id,
			value: input.value,
		},
	});
}

function collectTargetPlanReviewEvidenceDiagnostics(input: GoalSubmitTargetPlanInput): GoalTargetPlanLintDiagnostic[] {
	const diagnostics: GoalTargetPlanLintDiagnostic[] = [];
	const reviewsByLens = new Map<
		GoalTargetPlanReview["lens"],
		Array<{ review: GoalTargetPlanReview; index: number }>
	>();
	input.targetPlanReviews.forEach((review, index) => {
		const reviews = reviewsByLens.get(review.lens);
		if (reviews) reviews.push({ review, index });
		else reviewsByLens.set(review.lens, [{ review, index }]);
	});
	for (const lens of ["aperture", "execution-readiness"] as const) {
		if (reviewsByLens.has(lens)) continue;
		diagnostics.push(
			targetPlanReviewDiagnostic({
				severity: "error",
				code: "review.missing_gate",
				path: ["target_plan_reviews"],
				message: `target_plan_reviews must include a current ${lens} gate review`,
				guidance: "Run explicit planning-mode reviews and write their current evidence into target_plan_reviews.",
				value: lens,
			}),
		);
	}
	input.targetPlanReviews.forEach((review, index) => {
		if (review.reviewedTargetPlanId !== input.targetPlanId) {
			diagnostics.push(
				targetPlanReviewDiagnostic({
					severity: "error",
					code: "review.target_plan_mismatch",
					path: ["target_plan_reviews", index, "reviewed_target_plan_id"],
					message: "target plan review was not performed against the submitted target_plan_id",
					guidance: "Rerun or revalidate the review against the current target_plan_id before submitting.",
					review,
					value: review.reviewedTargetPlanId,
				}),
			);
		}
		if (review.reviewedRevision !== input.revision) {
			diagnostics.push(
				targetPlanReviewDiagnostic({
					severity: "error",
					code: "review.revision_mismatch",
					path: ["target_plan_reviews", index, "reviewed_revision"],
					message: "target plan review revision does not match the submitted revision",
					guidance: "Rerun or revalidate the review after every target plan revision.",
					review,
					value: review.reviewedRevision,
				}),
			);
		}
		if (review.status === "accepted" && review.revisedAfterReview === true) {
			diagnostics.push(
				targetPlanReviewDiagnostic({
					severity: "error",
					code: "review.stale_after_revision",
					path: ["target_plan_reviews", index, "revised_after_review"],
					message: "accepted gate review is marked stale after a plan revision",
					guidance: "Ask the original reviewer to validate the fixed blocker or rerun the gate review.",
					review,
					value: review.revisedAfterReview,
				}),
			);
		}
		if (review.lens === "aperture") {
			if (!review.apertureClassification) {
				diagnostics.push(
					targetPlanReviewDiagnostic({
						severity: "error",
						code: "review.aperture_classification_missing",
						path: ["target_plan_reviews", index, "aperture_classification"],
						message: "aperture review must include aperture_classification",
						guidance: "Record the aperture reviewer classification for this revision.",
						review,
					}),
				);
			}
			if (!review.revisionDecision) {
				diagnostics.push(
					targetPlanReviewDiagnostic({
						severity: "error",
						code: "review.revision_decision_missing",
						path: ["target_plan_reviews", index, "revision_decision"],
						message: "aperture review must include revision_decision",
						guidance: "Record the aperture reviewer revision decision for this revision.",
						review,
					}),
				);
			}
			if (!review.scores) {
				diagnostics.push(
					targetPlanReviewDiagnostic({
						severity: "error",
						code: "review.scores_missing",
						path: ["target_plan_reviews", index, "scores"],
						message: "aperture review must include all seven scores",
						guidance:
							"Record product_signal, related_work_bundling, concern_cohesion, verification_aperture, blast_radius_coverage, parent_uncertainty_reduction, and anti_gaming.",
						review,
					}),
				);
			}
		}
		if (input.planDepth !== "standard" && input.planDepth !== "trust-heavy") return;
		const source = review.source;
		if (!source) {
			diagnostics.push(
				targetPlanReviewDiagnostic({
					severity: input.planDepth === "trust-heavy" ? "error" : "warning",
					code: "review.source_missing",
					path: ["target_plan_reviews", index, "source"],
					message: "target plan review lacks source metadata",
					guidance:
						"Record subagent reviewer_id plus agent:// or history:// artifact, or use local only for low-risk plans.",
					review,
				}),
			);
			return;
		}
		if (source.kind === "local") {
			diagnostics.push(
				targetPlanReviewDiagnostic({
					severity: input.planDepth === "trust-heavy" ? "error" : "warning",
					code: "review.local_source",
					path: ["target_plan_reviews", index, "source", "kind"],
					message: "non-light target uses a local review source",
					guidance:
						"Use planning-mode subagent reviews for standard/trust-heavy plans, or explain task unavailability in feedback.",
					review,
					value: source.kind,
				}),
			);
			return;
		}
		if (!source.reviewerId?.trim() || (!source.artifactUri?.trim() && !source.validationUri?.trim())) {
			diagnostics.push(
				targetPlanReviewDiagnostic({
					severity: input.planDepth === "trust-heavy" ? "error" : "warning",
					code: "review.subagent_source_incomplete",
					path: ["target_plan_reviews", index, "source"],
					message: "subagent review source must include reviewer_id and an artifact or validation URI",
					guidance: "Record the reviewer id and agent://, history://, or validation URI for this review.",
					review,
					value: source,
				}),
			);
		}
	});
	return diagnostics;
}

function nextRecoverySequence(goal: Goal): number {
	return (goal.recoveryHistory?.reduce((max, record) => Math.max(max, record.sequence), 0) ?? 0) + 1;
}

function nextBlockedStateSequence(goal: Goal): number {
	const historical = goal.blockedStates?.reduce((max, block) => Math.max(max, block.sequence), 0) ?? 0;
	const current = goal.currentBlockedState?.sequence ?? 0;
	return Math.max(historical, current) + 1;
}

function nextCheckpointSequence(goal: Goal): number {
	return (goal.checkpoints?.reduce((max, packet) => Math.max(max, packet.sequence), 0) ?? 0) + 1;
}

function nextResolutionSequence(goal: Goal): number {
	return (goal.checkpointResolutions?.reduce((max, resolution) => Math.max(max, resolution.sequence), 0) ?? 0) + 1;
}

function upsertById<T extends { id: string }>(values: T[], additions: T[]): T[] {
	const output = [...values];
	for (const addition of additions) {
		const index = output.findIndex(value => value.id === addition.id);
		if (index === -1) output.push(addition);
		else output[index] = addition;
	}
	return output;
}

function applyDeliverableDeltas(
	values: GoalDeliverableMapItem[] | undefined,
	deltas: GoalDeliverableDelta[] | undefined,
): GoalDeliverableMapItem[] | undefined {
	if (!deltas?.length) return values ? cloneDeliverableMapForState(values) : undefined;
	const current = new Map((values ?? []).map(item => [item.id, item]));
	for (const delta of deltas) {
		const existing = current.get(delta.id);
		const next: GoalDeliverableMapItem = {
			id: delta.id,
			summary: delta.summary ?? existing?.summary ?? delta.id,
			status: delta.status ?? existing?.status ?? "pending",
			evidenceRefs:
				delta.evidenceRefs !== undefined
					? cloneRefs(delta.evidenceRefs)
					: existing?.evidenceRefs
						? cloneRefs(existing.evidenceRefs)
						: undefined,
			blockedBy:
				delta.blockedBy !== undefined
					? [...delta.blockedBy]
					: existing?.blockedBy
						? [...existing.blockedBy]
						: undefined,
			nextRelevantTarget: delta.nextRelevantTarget ?? existing?.nextRelevantTarget,
		};
		current.set(delta.id, next);
	}
	return [...current.values()];
}

function blockerIds(blockers: GoalVerificationGap[]): Set<string> {
	return new Set(blockers.map(blocker => blocker.id));
}

function targetLinkedCurrentBlockerIds(target: GoalTarget | undefined, blockers: GoalVerificationGap[]): string[] {
	if (!target?.linkedVerifierBlockerIds?.length || blockers.length === 0) return [];
	const ids = blockerIds(blockers);
	return target.linkedVerifierBlockerIds.filter(id => ids.has(id));
}

function targetLinksBlockers(target: GoalTarget | undefined, blockers: GoalVerificationGap[]): boolean {
	return targetLinkedCurrentBlockerIds(target, blockers).length > 0;
}

function validateVerifierRepairLinks(
	linkedVerifierBlockerIds: string[] | undefined,
	blockers: GoalVerificationGap[],
	action: string,
): void {
	if (blockers.length === 0) return;
	const currentIds = blockerIds(blockers);
	if (!linkedVerifierBlockerIds?.length) {
		throw new Error(
			`${action} during verifier repair must link current verifier blocker ids: ${[...currentIds].join(", ")}`,
		);
	}
	const staleIds = linkedVerifierBlockerIds.filter(id => !currentIds.has(id));
	if (staleIds.length > 0) {
		throw new Error(
			`${action} during verifier repair referenced stale verifier blocker ids: ${staleIds.join(", ")}; current verifier blocker ids: ${[...currentIds].join(", ")}`,
		);
	}
}

function updateVerificationRepairForClosedTarget(
	repair: GoalVerificationRepairState,
	target: GoalTarget,
): GoalVerificationRepairState | undefined {
	if (repair.blockers.length === 0) {
		return target.createdBy === "verification-repair" ||
			target.createdFromVerificationAttemptId === repair.verificationAttemptId
			? undefined
			: repair;
	}
	const repairedIds = new Set(targetLinkedCurrentBlockerIds(target, repair.blockers));
	if (repairedIds.size === 0) return repair;
	const remainingBlockers = repair.blockers.filter(blocker => !repairedIds.has(blocker.id));
	if (remainingBlockers.length === 0) return undefined;
	if (remainingBlockers.length === repair.blockers.length) return repair;
	return { ...repair, blockers: remainingBlockers };
}

function targetFromInput(
	goal: Goal,
	input: GoalStartTargetInput,
	sequence: number,
	parentFrameVersion: number,
	now: number,
	createdBy: GoalTarget["createdBy"],
): GoalTarget {
	const parallelWorkstreamRequirement = cloneParallelWorkstreamRequirement(input.parallelWorkstreamRequirement);
	if (parallelWorkstreamRequirement?.required === true && !parallelWorkstreamRequirement.rationale) {
		throw new Error("parallel_workstream_requirement.rationale must be non-empty when required is true");
	}
	return {
		id: `${goal.id}-target-${sequence}`,
		sequence,
		status: "active",
		title: trimmed(input.title, "title"),
		desiredFutureClaim: trimmed(input.desiredFutureClaim, "desired_future_claim"),
		closureStandard: trimmed(input.closureStandard, "closure_standard"),
		expectedParentContribution: input.expectedParentContribution?.trim() || undefined,
		parentFrameVersion,
		baselineRefs: input.baselineRefs?.length
			? cloneRefs(input.baselineRefs)
			: cloneRefs(goal.parentFrame?.baselineRefs),
		gateRefs: cloneStringArray(input.gateRefs),
		evidenceExpectation: cloneStringArray(input.evidenceExpectation),
		nonGoals: cloneStringArray(input.nonGoals),
		forbiddenClaims: cloneStringArray(input.forbiddenClaims),
		staleIf: cloneStringArray(input.staleIf),
		createdAt: now,
		createdBy,
		createdFromCheckpointId: input.createdFromCheckpointId,
		createdFromVerificationAttemptId: input.createdFromVerificationAttemptId,
		linkedVerifierBlockerIds: input.linkedVerifierBlockerIds ? [...input.linkedVerifierBlockerIds] : undefined,
		parentDeliverableIds: input.parentDeliverableIds ? [...input.parentDeliverableIds] : undefined,
		parallelWorkstreamRequirement,
	};
}

function workstreamTaskIdMatches(run: GoalWorkstreamBatch["workstreams"][number], taskId: string | undefined): boolean {
	const trimmedTaskId = taskId?.trim();
	return Boolean(trimmedTaskId && (trimmedTaskId === run.scaffoldTaskId || trimmedTaskId === run.workstreamId));
}

function terminalWorkstreamStatusFromResult(
	result: TaskToolDetails["results"][number] | undefined,
): GoalWorkstreamBatch["workstreams"][number]["status"] | undefined {
	if (!result) return undefined;
	if (result.aborted) return "aborted";
	return result.exitCode === 0 && !result.error ? "completed" : "failed";
}

function terminalWorkstreamStatusFromProgress(
	progress: NonNullable<TaskToolDetails["progress"]>[number] | undefined,
): GoalWorkstreamBatch["workstreams"][number]["status"] | undefined {
	if (progress?.status === "completed" || progress?.status === "failed" || progress?.status === "aborted") {
		return progress.status;
	}
	return undefined;
}

const WORKSTREAM_TASK_SUMMARY_MAX_LENGTH = 600;

function compactWorkstreamTaskText(value: string | undefined): string | undefined {
	const lines =
		value
			?.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean)
			.slice(0, 6) ?? [];
	if (lines.length === 0) return undefined;
	const summary = lines.join(" ");
	return summary.length <= WORKSTREAM_TASK_SUMMARY_MAX_LENGTH
		? summary
		: `${summary.slice(0, WORKSTREAM_TASK_SUMMARY_MAX_LENGTH - 1)}…`;
}

function workstreamResultSummary(result: TaskToolDetails["results"][number] | undefined): string | undefined {
	if (!result) return undefined;
	if (result.aborted) return compactWorkstreamTaskText(`Task aborted: ${result.abortReason ?? "no reason reported"}`);
	const failure = result.error ?? result.retryFailure?.errorMessage;
	if (failure) return compactWorkstreamTaskText(`Task failed: ${failure}`);
	return (
		compactWorkstreamTaskText(result.output) ??
		compactWorkstreamTaskText(result.description) ??
		compactWorkstreamTaskText(result.assignment) ??
		compactWorkstreamTaskText(result.task)
	);
}

function workstreamLatestActivity(
	result: TaskToolDetails["results"][number] | undefined,
	progress: NonNullable<TaskToolDetails["progress"]>[number] | undefined,
): string | undefined {
	return (
		compactWorkstreamTaskText(result?.lastIntent) ??
		compactWorkstreamTaskText(progress?.lastIntent) ??
		compactWorkstreamTaskText(progress?.recentOutput.at(-1))
	);
}

function updateWorkstreamBatchStatus(batch: GoalWorkstreamBatch, now: number): void {
	if (batch.status === "closed" || batch.status === "superseded") return;
	const statuses = batch.workstreams.map(run => run.status);
	if (statuses.every(status => status === "completed" || status === "accepted")) {
		batch.status = "ready-for-integration";
	} else if (
		statuses.some(status => status === "failed" || status === "aborted" || status === "blocked") &&
		statuses.every(status => status !== "pending" && status !== "running")
	) {
		batch.status = "blocked";
	} else if (statuses.some(status => status === "completed" || status === "failed" || status === "aborted")) {
		batch.status = "collecting-results";
	} else if (statuses.some(status => status === "running")) {
		batch.status = "running";
	} else {
		batch.status = "pending-launch";
	}
	batch.updatedAt = now;
}

const GOAL_VERIFICATION_COMMAND_RECORD_LIMIT = 10;

export interface GoalObservedToolResultInput extends ObservedToolResultForFreshness {
	toolCallId: string;
	source?: "main-agent" | "task";
}

function targetFreshnessTrackingActive(state: GoalModeState): boolean {
	if (!state.enabled || state.mode !== "active") return false;
	if (state.goal.status !== "active" || !state.goal.currentTarget) return false;
	return state.runMode === "working-target" || state.runMode === "awaiting-verification-repair";
}

function nextVerificationCommandSequence(records: GoalVerificationCommandRecord[] | undefined): number {
	let sequence = 0;
	for (const record of records ?? []) {
		if (record.sequence > sequence) sequence = record.sequence;
	}
	return sequence + 1;
}

function effectiveVerificationFreshness(
	record: GoalVerificationCommandRecord,
	currentEpoch: number,
): GoalVerificationCommandRecord["freshness"] {
	if (record.status !== "passed") return "unknown";
	return record.workEpoch === currentEpoch ? "fresh" : "stale";
}

function compactVerificationFreshnessForPrompt(
	goal: Goal,
	currentTarget: GoalTarget | undefined,
): GoalPromptObject | undefined {
	const targetId = currentTarget?.id;
	const records = (goal.verificationCommands ?? [])
		.filter(record => !targetId || record.targetId === targetId)
		.slice(-GOAL_VERIFICATION_COMMAND_RECORD_LIMIT);
	if (!records.length && !goal.lastMutation) return undefined;
	const currentEpoch = goal.workEpoch ?? 0;
	return {
		workEpoch: currentEpoch,
		latestMutation: goal.lastMutation
			? {
					epoch: goal.lastMutation.epoch,
					toolName: goal.lastMutation.toolName,
					paths: goal.lastMutation.paths,
					reason: goal.lastMutation.reason,
					occurredAt: goal.lastMutation.occurredAt,
				}
			: undefined,
		commands: records.map(record => {
			const freshness = effectiveVerificationFreshness(record, currentEpoch);
			return {
				id: record.id,
				command: record.command,
				cwd: record.cwd,
				kind: record.kind,
				status: record.status,
				freshness,
				workEpoch: record.workEpoch,
				recordedAt: record.recordedAt,
				staleReason:
					freshness === "stale" ? (record.staleReason ?? "target changed after this command") : undefined,
			};
		}),
		guidance: records.some(record => effectiveVerificationFreshness(record, currentEpoch) !== "fresh")
			? "Do not use stale or failed verification as final checkpoint evidence; rerun focused verification after integration."
			: undefined,
	};
}

export class GoalRuntime {
	readonly #host: GoalRuntimeHost;
	#turnSnapshot: GoalTurnSnapshot | undefined;
	#wallClock: GoalWallClockSnapshot;
	#budgetReportedFor: string | undefined;
	#accountingTail: Promise<void> = Promise.resolve();

	constructor(host: GoalRuntimeHost) {
		this.#host = host;
		this.#wallClock = { lastAccountedAt: this.#now() };
	}

	get snapshot(): GoalRuntimeSnapshot {
		return {
			turnSnapshot: this.#turnSnapshot
				? { ...this.#turnSnapshot, baselineUsage: { ...this.#turnSnapshot.baselineUsage } }
				: undefined,
			wallClock: { ...this.#wallClock },
			budgetReportedFor: this.#budgetReportedFor,
		};
	}

	#now(): number {
		return this.#host.now?.() ?? Date.now();
	}

	#hasAccountingState(): boolean {
		const state = this.#host.getState();
		return Boolean(state?.enabled && isAccountingStatus(state.goal));
	}

	async #withAccounting<T>(fn: () => Promise<T> | T): Promise<T> {
		const previous = this.#accountingTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#accountingTail = previous.then(
			() => promise,
			() => promise,
		);
		await previous.catch(() => {});
		try {
			return await fn();
		} finally {
			resolve();
		}
	}

	#getStateClone(): GoalModeState | undefined {
		const state = this.#host.getState();
		return state ? cloneGoalModeState(state) : undefined;
	}

	async #commitState(
		state: GoalModeState | undefined,
		options?: {
			persist?: "goal" | "goal_paused" | "none";
			emit?: boolean;
			reason?: GoalPersistenceReason;
		},
	): Promise<void> {
		this.#host.setState(state ? cloneGoalModeState(state) : undefined);
		if (options?.persist) {
			const reason = options.reason ?? (state?.runMode === "completed" ? "terminal" : "semantic");
			await this.#host.persist(options.persist, state, reason);
		}
		if (options?.emit !== false) {
			await this.#host.emit({ type: "goal_updated", goal: state ? cloneGoal(state.goal) : null, state });
		}
	}

	#bumpState(state: GoalModeState, options?: { parentFrameChanged?: boolean }): void {
		state.stateVersion += 1;
		if (options?.parentFrameChanged) state.parentFrameVersion += 1;
		state.goal.updatedAt = this.#now();
	}

	#upsertTargetPlan(state: GoalModeState, plan: GoalTargetPlanRecord): GoalTargetPlanRecord {
		const cloned = cloneTargetPlan(plan);
		if (!cloned) throw new Error("cannot store invalid target plan");
		state.goal.currentTargetPlan = cloned;
		state.goal.targetPlans = upsertById(state.goal.targetPlans ?? [], [cloned]);
		return cloned;
	}

	#activeWorkstreamBatch(state: GoalModeState): GoalWorkstreamBatch | undefined {
		const batch = state.goal.currentWorkstreamBatch;
		const target = state.goal.currentTarget;
		const plan = state.goal.currentTargetPlan;
		if (!batch || !target || !plan) return undefined;
		if (target.workstreamBatchId !== batch.id) return undefined;
		if (batch.targetId !== target.id) return undefined;
		if (batch.targetPlanId !== plan.id || batch.targetPlanRevision !== plan.revision) return undefined;
		return batch;
	}

	#storeWorkstreamBatch(state: GoalModeState, batch: GoalWorkstreamBatch): void {
		state.goal.currentWorkstreamBatch = batch;
		state.goal.workstreamBatches = upsertWorkstreamBatch(state.goal.workstreamBatches, batch);
	}

	async recordGoalWorkstreamTaskDispatch(input: GoalWorkstreamTaskDispatchInput): Promise<void> {
		await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.status !== "active") return;
			const batch = this.#activeWorkstreamBatch(state);
			if (!batch) return;
			const now = this.#now();
			let changed = false;
			for (const run of batch.workstreams) {
				const spawn = input.spawns.find(item => workstreamTaskIdMatches(run, item.taskId));
				if (!spawn || run.status === "accepted" || run.status === "superseded") continue;
				run.status = "running";
				run.agentId = spawn.agentId;
				run.jobId = spawn.jobId;
				run.historyUrl = `history://${spawn.agentId}`;
				run.updatedAt = now;
				changed = true;
			}
			if (!changed) return;
			batch.status = "running";
			batch.launchedAt ??= now;
			batch.updatedAt = now;
			this.#storeWorkstreamBatch(state, batch);
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal", reason: "semantic" });
		});
	}

	async recordGoalWorkstreamTaskResult(input: GoalWorkstreamTaskResultInput): Promise<void> {
		await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.status !== "active") return;
			const batch = this.#activeWorkstreamBatch(state);
			if (!batch) return;
			const resultsByAgentId = new Map(input.details.results.map(result => [result.id, result]));
			const progressByAgentId = new Map(input.details.progress?.map(progress => [progress.id, progress]) ?? []);
			const spawns = input.spawns ?? [];
			const now = this.#now();
			let changed = false;
			for (const run of batch.workstreams) {
				if (run.status === "accepted" || run.status === "superseded") continue;
				const spawn = spawns.find(
					item =>
						workstreamTaskIdMatches(run, item.taskId) ||
						(run.agentId !== undefined && item.agentId === run.agentId),
				);
				const agentId = spawn?.agentId ?? run.agentId;
				const result = agentId ? resultsByAgentId.get(agentId) : undefined;
				const progress = agentId ? progressByAgentId.get(agentId) : undefined;
				const status = terminalWorkstreamStatusFromResult(result) ?? terminalWorkstreamStatusFromProgress(progress);
				if (!status) continue;
				run.status = status;
				if (agentId) {
					run.agentId = agentId;
					run.historyUrl = `history://${agentId}`;
					run.outputUrl = `agent://${agentId}`;
				}
				run.jobId = spawn?.jobId ?? run.jobId;
				run.summary = workstreamResultSummary(result) ?? run.summary;
				run.latestActivity = workstreamLatestActivity(result, progress) ?? run.latestActivity;
				run.blockers =
					status === "failed"
						? [
								result?.error ??
									result?.retryFailure?.errorMessage ??
									`Task ${agentId ?? run.workstreamId} failed.`,
							]
						: undefined;
				run.updatedAt = now;
				changed = true;
			}
			if (!changed) return;
			updateWorkstreamBatchStatus(batch, now);
			this.#storeWorkstreamBatch(state, batch);
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal", reason: "semantic" });
		});
	}

	#closeActiveWorkstreamBatchForTarget(state: GoalModeState, targetId: string, closedAt: number): void {
		const batch = this.#activeWorkstreamBatch(state);
		if (!batch || batch.targetId !== targetId) return;
		for (const run of batch.workstreams) {
			if (run.status === "superseded") continue;
			run.status = "accepted";
			run.updatedAt = closedAt;
		}
		batch.status = "closed";
		batch.closedAt = closedAt;
		batch.updatedAt = closedAt;
		this.#storeWorkstreamBatch(state, batch);
	}

	#enterBlockedState(state: GoalModeState, block: GoalBlockedState): GoalBlockedState {
		const current = state.goal.currentBlockedState;
		if (current?.status === "open" && current.id !== block.id) {
			const superseded = cloneBlockedState({
				...current,
				status: "superseded",
				updatedAt: block.createdAt,
				supersededAt: block.createdAt,
				supersededBy: block.id,
			});
			if (superseded) state.goal.blockedStates = upsertBlockedState(state.goal.blockedStates, superseded);
		}
		const installed = cloneBlockedState(block);
		if (!installed) throw new Error("cannot enter invalid blocked state");
		state.goal.currentBlockedState = installed;
		state.goal.blockedStates = upsertBlockedState(state.goal.blockedStates, installed);
		state.runMode = "awaiting-user-input";
		return installed;
	}

	#resolveBlockedState(state: GoalModeState, block: GoalBlockedState, recovery: GoalRecoveryRecord): void {
		const clonedRecovery = cloneRecoveryRecord(recovery);
		if (!clonedRecovery) throw new Error("cannot store invalid recovery record");
		state.goal.recoveryHistory = upsertRecoveryRecord(state.goal.recoveryHistory, clonedRecovery);
		const resolved = cloneBlockedState({
			...block,
			status: "resolved",
			updatedAt: recovery.at,
			resolvedAt: recovery.at,
			recoveryId: recovery.id,
		});
		if (!resolved) throw new Error("cannot resolve invalid blocked state");
		state.goal.blockedStates = upsertBlockedState(state.goal.blockedStates, resolved);
		if (state.goal.currentBlockedState?.id === block.id) state.goal.currentBlockedState = undefined;
	}

	#beginTargetPlanning(state: GoalModeState, target: GoalTarget): void {
		const planId = `${target.id}-plan`;
		const planFilePath = `local://goal-${sanitizeGoalPlanSlug(state.goal.id)}-target-${target.sequence}-plan.md`;
		const existing =
			state.goal.currentTargetPlan?.id === planId
				? state.goal.currentTargetPlan
				: state.goal.targetPlans?.find(plan => plan.id === planId);
		const now = this.#now();
		const plan: GoalTargetPlanRecord = {
			id: planId,
			goalId: state.goal.id,
			targetId: target.id,
			targetSequence: target.sequence,
			planFilePath,
			status: "drafting",
			revision: existing?.revision ?? 1,
			stateVersionAtStart: state.stateVersion,
			parentFrameVersionAtStart: target.parentFrameVersion ?? state.parentFrameVersion,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			reviews: existing?.reviews ?? [],
		};
		state.goal.currentTargetPlan = plan;
		this.#upsertTargetPlan(state, plan);
		state.runMode = "planning-target";
	}

	#assertGoalDropAllowed(state: GoalModeState): void {
		const plan = state.goal.currentTargetPlan;
		if (
			state.runMode === "planning-target" ||
			plan?.status === "drafting" ||
			plan?.status === "reviewing" ||
			plan?.status === "revision-required" ||
			state.goal.currentTarget?.status === "active" ||
			state.goal.pendingCheckpointId !== undefined ||
			state.runMode === "awaiting-parent-completion" ||
			state.runMode === "awaiting-verification-repair"
		) {
			throw new Error(ACTIVE_GOAL_DROP_ERROR);
		}
	}

	#assertFreshGoalMutationInput(
		state: GoalModeState | undefined,
		input: { stateVersion: number; parentFrameVersion: number },
		op: "resolve_checkpoint" | "recover_blocked_state",
	): asserts state is GoalModeState {
		if (!state?.enabled || state.goal.status !== "active") {
			const action = op === "resolve_checkpoint" ? "resolve checkpoint" : "recover blocked state";
			throw new Error(`cannot ${action} because no active parent goal exists`);
		}
		if (input.stateVersion !== state.stateVersion) {
			throw new Error(
				`${op} is stale: state_version must equal current goal stateVersion (${state.stateVersion}); got ${input.stateVersion}. Refresh with goal({op:"get"}) and retry.`,
			);
		}
		if (input.parentFrameVersion !== state.parentFrameVersion) {
			throw new Error(
				`${op} is stale: parent_frame_version must equal current goal parentFrameVersion (${state.parentFrameVersion}); got ${input.parentFrameVersion}. Refresh with goal({op:"get"}) and retry.`,
			);
		}
	}

	#validateTargetPlanSubmission(
		state: GoalModeState | undefined,
		input: GoalSubmitTargetPlanInput,
	): GoalTargetPlanRecord {
		if (!state?.enabled || state.goal.status !== "active")
			throw new Error("cannot submit target plan because no active parent goal exists");
		const target = state.goal.currentTarget;
		if (target?.status !== "active") throw new Error("cannot submit target plan without an active target");
		const plan = state.goal.currentTargetPlan;
		if (!plan) throw new Error("no current target plan is pending");
		if (plan.targetId !== target.id) throw new Error("current target plan is stale");
		const identity = currentTargetPlanSubmitIdentity(state);
		if (!identity) throw new Error("current target plan is stale");
		if (input.targetId !== identity.targetId)
			throw new Error(`target_id must equal currentTarget.id (${identity.targetId}); got ${input.targetId}`);
		if (input.targetPlanId !== identity.targetPlanId)
			throw new Error(
				`target_plan_id must equal currentTargetPlan.id (${identity.targetPlanId}); got ${input.targetPlanId}`,
			);
		if (input.planFilePath !== identity.planFilePath)
			throw new Error(
				`plan_file_path must equal currentTargetPlan.planFilePath (${identity.planFilePath}); got ${input.planFilePath}`,
			);
		if (input.revision !== identity.revision)
			throw new Error(
				`revision must equal currentTargetPlan.revision (${identity.revision}); got ${input.revision}`,
			);
		if (state.runMode !== "planning-target") {
			throw new Error("target plan submission is only allowed while runMode is planning-target");
		}
		if (plan.status !== "drafting" && plan.status !== "revision-required") {
			throw new Error("target plan submission requires a draft or revision-required plan");
		}
		const submitted = cloneTargetPlan({
			...plan,
			status: "reviewing",
			updatedAt: this.#now(),
			verificationAperture: input.verificationAperture,
			verificationSignals: input.verificationSignals,
			concernChecks: input.concernChecks,
			scopeCalibration: input.scopeCalibration,
			branchEvidence: input.branchEvidence,
			excludedWorkReview: input.excludedWorkReview,
			planDepth: input.planDepth,
			primarySignalGroupId: input.primarySignalGroupId,
			scenarioMatrix: input.scenarioMatrix,
			targetCard: input.targetCard,
		});
		if (!submitted) throw new Error("target plan submission is invalid");
		return submitted;
	}

	#mergeTargetPlanReviews(plan: GoalTargetPlanRecord, reviews: GoalTargetPlanReview[]): GoalTargetPlanReview[] {
		return upsertById(plan.reviews, reviews);
	}

	#assertCurrentTargetPlanApprovedForTarget(state: GoalModeState, target: GoalTarget): void {
		const plan = state.goal.currentTargetPlan;
		if (
			!target.planId ||
			!plan ||
			plan.id !== target.planId ||
			plan.targetId !== target.id ||
			plan.status !== "approved"
		) {
			throw new Error("cannot checkpoint before the current target plan is approved");
		}
	}

	#assertTargetPlanApprovalGates(input: GoalTargetPlanApprovalInput): void {
		const apertureReview = input.reviews.find(review => review.lens === "aperture");
		const executionReview = input.reviews.find(review => review.lens === "execution-readiness");
		if (!apertureReview || !executionReview) {
			throw new Error("target plan requires aperture and execution-readiness reviews");
		}
		for (const review of input.reviews) {
			if (review.reviewedTargetPlanId !== input.targetPlanId) {
				throw new Error("target plan review target_plan_id does not match the submitted target plan");
			}
			if (review.reviewedRevision !== input.revision) {
				throw new Error("target plan review revision does not match the submitted revision");
			}
			if (review.status === "accepted" && review.revisedAfterReview === true) {
				throw new Error("accepted target plan review is stale after a plan revision");
			}
			if (review.lens === "aperture" && !review.apertureClassification) {
				throw new Error("target plan aperture review must include aperture_classification");
			}
			if (review.lens === "aperture" && !review.revisionDecision) {
				throw new Error("target plan aperture review must include revision_decision");
			}
			if (review.lens === "aperture" && !review.scores) {
				throw new Error("target plan aperture review must include all seven scores");
			}
		}
		if (input.reviews.some(review => review.status !== "accepted")) {
			throw new Error("target plan cannot be approved with rejected or failed reviews");
		}
		if (apertureReview.apertureClassification !== "right-sized") {
			throw new Error("target plan aperture review must classify the target as right-sized");
		}
		if (!apertureReview.scores || Object.values(apertureReview.scores).some(score => score < 3)) {
			throw new Error("target plan aperture review scores must all be at least 3");
		}
		if (
			input.reviews.some(review =>
				review.findings.some(finding => finding.severity === "blocking" || finding.severity === "important"),
			)
		) {
			throw new Error("target plan cannot be approved with blocking or important findings");
		}
	}

	#markActiveAccounting(goal: Goal, resetWallClock = false): void {
		if (resetWallClock || this.#wallClock.activeGoalId !== goal.id) {
			this.#wallClock = { lastAccountedAt: this.#now(), activeGoalId: goal.id };
		}
		if (this.#turnSnapshot) {
			this.#turnSnapshot.activeGoalId = goal.id;
			this.#turnSnapshot.baselineUsage = { ...this.#host.getCurrentUsage() };
		}
	}

	#clearActiveAccounting(): void {
		this.#wallClock = { lastAccountedAt: this.#now() };
		if (this.#turnSnapshot) {
			this.#turnSnapshot.activeGoalId = undefined;
		}
	}

	clearAccounting(): void {
		this.#turnSnapshot = undefined;
		this.#clearActiveAccounting();
		this.#budgetReportedFor = undefined;
	}

	onTurnStart(turnId: string, baselineUsage: GoalTokenUsage): void {
		this.#turnSnapshot = { turnId, baselineUsage: { ...baselineUsage } };
		const state = this.#host.getState();
		if (state?.enabled && isAccountingStatus(state.goal)) {
			this.#turnSnapshot.activeGoalId = state.goal.id;
			if (this.#wallClock.activeGoalId !== state.goal.id) {
				this.#wallClock = { lastAccountedAt: this.#now(), activeGoalId: state.goal.id };
			}
		}
	}

	async onToolCompleted(toolName: string): Promise<void> {
		if (toolName === "goal") return;
		if (!this.#hasAccountingState()) return;
		await this.flushUsage("allowed");
	}

	async onGoalToolCompleted(): Promise<void> {
		if (!this.#hasAccountingState()) return;
		await this.flushUsage("suppressed");
	}

	async recordObservedToolResult(input: GoalObservedToolResultInput): Promise<void> {
		await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state || !targetFreshnessTrackingActive(state)) return;
			if (input.toolName === "goal") return;
			const observed = {
				toolName: input.toolName,
				args: input.args,
				result: input.result,
				isError: input.isError,
			};
			const mutation = classifyTargetMutation(observed);
			const verification = classifyVerificationCommand(observed);
			if (!mutation && !verification) return;
			const now = this.#now();
			if (mutation) {
				const nextEpoch = (state.goal.workEpoch ?? 0) + 1;
				const changedPaths = mutation.paths?.slice(0, 5);
				const staleReason = changedPaths?.length
					? `${mutation.reason}: ${changedPaths.join(", ")}`
					: mutation.reason;
				state.goal.workEpoch = nextEpoch;
				state.goal.lastMutation = {
					epoch: nextEpoch,
					toolName: mutation.toolName,
					paths: changedPaths,
					reason: mutation.reason,
					occurredAt: now,
				};
				for (const record of state.goal.verificationCommands ?? []) {
					if (record.status !== "passed" || record.workEpoch >= nextEpoch) continue;
					record.freshness = "stale";
					record.staleAt = now;
					record.staleReason = staleReason;
				}
			}
			if (verification) {
				const workEpoch = state.goal.workEpoch ?? 0;
				const sequence = nextVerificationCommandSequence(state.goal.verificationCommands);
				const record: GoalVerificationCommandRecord = {
					id: `${state.goal.id}-verification-command-${sequence}`,
					sequence,
					targetId: state.goal.currentTarget?.id,
					targetPlanId: state.goal.currentTargetPlan?.id,
					targetPlanRevision: state.goal.currentTargetPlan?.revision,
					command: verification.command,
					cwd: verification.cwd,
					kind: verification.kind,
					status: verification.status,
					freshness: verification.status === "passed" ? "fresh" : "unknown",
					workEpoch,
					recordedAt: now,
					source: input.source ?? "main-agent",
				};
				state.goal.verificationCommands = [...(state.goal.verificationCommands ?? []), record].slice(
					-GOAL_VERIFICATION_COMMAND_RECORD_LIMIT,
				);
			}
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal", reason: "semantic" });
		});
	}

	async onAgentEnd(options?: { turnCompleted?: boolean; currentUsage?: GoalTokenUsage }): Promise<void> {
		if (!this.#hasAccountingState()) {
			this.#turnSnapshot = undefined;
			return;
		}
		await this.flushUsage("suppressed", options?.currentUsage);
		this.#turnSnapshot = undefined;
	}

	async onTaskAborted(options?: { reason?: "interrupted" | "internal" }): Promise<void> {
		const state = this.#host.getState();
		const needsAccounting = state?.enabled && isAccountingStatus(state.goal);
		const needsPause = options?.reason === "interrupted" && state?.enabled && state.goal.status === "active";
		if (!needsAccounting && !needsPause) {
			this.#turnSnapshot = undefined;
			return;
		}
		await this.#withAccounting(async () => {
			await this.#flushUsageLocked("suppressed", undefined, options?.reason === "internal");
			this.#turnSnapshot = undefined;
			if (options?.reason !== "interrupted") return;
			const cloned = this.#getStateClone();
			if (!cloned?.enabled || cloned.goal.status !== "active") return;
			cloned.enabled = false;
			cloned.goal.status = "paused";
			this.#bumpState(cloned);
			this.#clearActiveAccounting();
			this.#budgetReportedFor = undefined;
			await this.#commitState(cloned, { persist: "goal_paused" });
		});
	}

	async onThreadResumed(options?: { preserveActiveGoal?: boolean }): Promise<GoalModeState | undefined> {
		const state = this.#getStateClone();
		if (!state) return undefined;
		if (options?.preserveActiveGoal && state.enabled && state.goal.status === "active") {
			this.#markActiveAccounting(state.goal, true);
			await this.#commitState(state, { emit: true });
			return state;
		}
		if (state.goal.status === "active") {
			state.enabled = false;
			state.goal.status = "paused";
			this.#bumpState(state);
			this.#clearActiveAccounting();
			this.#budgetReportedFor = undefined;
			await this.#commitState(state, { persist: "goal_paused" });
			return state;
		}
		if (state.enabled && isAccountingStatus(state.goal)) {
			this.#markActiveAccounting(state.goal);
		} else {
			this.#clearActiveAccounting();
		}
		await this.#commitState(state, { emit: true });
		return state;
	}

	async onBudgetMutated(newBudget: number | undefined): Promise<GoalModeState | undefined> {
		validateTokenBudget(newBudget);
		return await this.#withAccounting(async () => {
			this.#budgetReportedFor = undefined;
			await this.#flushUsageLocked("suppressed");
			const state = this.#getStateClone();
			if (!state?.goal) return undefined;
			state.goal.tokenBudget = newBudget;
			state.goal.updatedAt = this.#now();
			let shouldSteer = false;
			let semantic = false;
			if (newBudget !== undefined && state.goal.tokensUsed >= newBudget) {
				if (state.goal.status === "active") {
					state.goal.status = "budget-limited";
					semantic = true;
					shouldSteer = true;
				}
			} else if (state.goal.status === "budget-limited") {
				state.goal.status = "active";
				state.enabled = true;
				semantic = true;
				this.#markActiveAccounting(state.goal);
			}
			if (semantic) this.#bumpState(state);
			await this.#commitState(state, { persist: state.enabled ? "goal" : "goal_paused" });
			if (shouldSteer) {
				await this.#sendBudgetLimitSteer(state.goal);
			}
			return state;
		});
	}

	async #flushUsageLocked(
		steering: GoalBudgetSteering,
		currentUsage: GoalTokenUsage = this.#host.getCurrentUsage(),
		persistWallClock = false,
	): Promise<void> {
		const state = this.#getStateClone();
		if (!state?.enabled || !isAccountingStatus(state.goal)) return;
		if (this.#turnSnapshot?.activeGoalId !== state.goal.id && this.#wallClock.activeGoalId !== state.goal.id) return;

		const tokenDelta =
			this.#turnSnapshot?.activeGoalId === state.goal.id
				? goalTokenDelta(currentUsage, this.#turnSnapshot.baselineUsage)
				: 0;
		const wallSeconds =
			this.#wallClock.activeGoalId === state.goal.id
				? Math.max(0, Math.floor((this.#now() - this.#wallClock.lastAccountedAt) / 1000))
				: 0;
		if (tokenDelta <= 0 && wallSeconds <= 0) return;

		state.goal.tokensUsed += tokenDelta;
		state.goal.timeUsedSeconds += wallSeconds;
		state.goal.updatedAt = this.#now();
		const flippedToBudgetLimited =
			state.goal.tokenBudget !== undefined &&
			state.goal.tokensUsed >= state.goal.tokenBudget &&
			state.goal.status === "active";
		if (flippedToBudgetLimited) {
			state.goal.status = "budget-limited";
			this.#bumpState(state);
		}

		if (this.#turnSnapshot?.activeGoalId === state.goal.id) {
			this.#turnSnapshot.baselineUsage = { ...currentUsage };
		}
		if (this.#wallClock.activeGoalId === state.goal.id && wallSeconds > 0) {
			this.#wallClock.lastAccountedAt += wallSeconds * 1000;
		}

		if (flippedToBudgetLimited) {
			await this.#commitState(state, { persist: "goal", reason: "budget-limited" });
		} else {
			// Persisting wall-clock-only accounting on every tool event bloats /goal sessions.
			// Keep normal tool flushes in memory/UI only, but make wall-clock usage durable
			// before internal session switches because the active runtime is leaving.
			const shouldPersistUsage = tokenDelta > 0 || (persistWallClock && wallSeconds > 0);
			const shouldPersistSnapshot =
				(persistWallClock && wallSeconds > 0) || (shouldPersistUsage && !this.#host.persistUsage);
			if (shouldPersistUsage && this.#host.persistUsage) {
				this.#host.persistUsage({
					goalId: state.goal.id,
					stateVersion: state.stateVersion,
					tokenDelta,
					wallSeconds,
					tokensUsed: state.goal.tokensUsed,
					timeUsedSeconds: state.goal.timeUsedSeconds,
					updatedAt: state.goal.updatedAt,
				});
			}
			await this.#commitState(state, { persist: shouldPersistSnapshot ? "goal" : undefined });
		}

		if (state.goal.status !== "budget-limited") {
			this.#budgetReportedFor = undefined;
		}
		if (steering === "allowed" && flippedToBudgetLimited && this.#budgetReportedFor !== state.goal.id) {
			await this.#sendBudgetLimitSteer(state.goal);
		}
	}

	async flushUsage(
		steering: GoalBudgetSteering,
		currentUsage: GoalTokenUsage = this.#host.getCurrentUsage(),
	): Promise<void> {
		await this.#withAccounting(() => this.#flushUsageLocked(steering, currentUsage));
	}

	async setGoalRubric(
		goalId: string,
		rubric: string,
		deliverableMap?: GoalDeliverableMapItem[],
		targetUnitRules?: GoalTargetUnitRule[],
	): Promise<GoalModeState | undefined> {
		const trimmedRubric = rubric.trim();
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.id !== goalId || state.goal.status !== "active") return undefined;
			state.goal.rubric = trimmedRubric || undefined;
			state.goal.deliverableMap = deliverableMap?.length ? cloneDeliverableMapForState(deliverableMap) : undefined;
			state.goal.targetUnitRules = targetUnitRules?.length ? targetUnitRules.map(rule => ({ ...rule })) : undefined;
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	#appendVerificationAttempt(goal: Goal, input: GoalVerificationRecordInput): GoalVerificationAttempt {
		const sequence = Math.max(goal.totalVerificationAttempts ?? 0, goal.verificationAttempts?.length ?? 0) + 1;
		const compactorMemo = input.compactorMemo?.trim() || undefined;
		const attempt: GoalVerificationAttempt = {
			id: `${goal.id}-verification-${sequence}`,
			sequence,
			attempt: input.attempt,
			maxAttempts: input.maxAttempts,
			status: input.status,
			feedback: input.feedback.trim(),
			structuredFeedback: input.structuredFeedback,
			compactorMemo,
			createdAt: this.#now(),
			workEpoch: goal.workEpoch ?? 0,
			sideAgentTokensUsed: input.sideAgentTokensUsed,
		};
		goal.verificationAttempts = [...(goal.verificationAttempts ?? []), attempt];
		goal.totalVerificationAttempts = sequence;
		goal.lastVerificationAttempt = input.attempt;
		goal.lastVerificationAttemptId = attempt.id;
		goal.lastVerificationFeedback = attempt.feedback;
		goal.lastVerificationCompactorMemo = compactorMemo;
		return attempt;
	}

	async recordFailedCompletionVerification(
		goalId: string,
		feedback: string,
		options?: {
			attempt?: number;
			maxAttempts?: number;
			structuredFeedback?: GoalCompletionVerifierStructuredOutput;
			compactorMemo?: string;
			sideAgentTokensUsed?: number;
		},
	): Promise<Goal | undefined> {
		const trimmedFeedback = feedback.trim();
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.id !== goalId || !isAccountingStatus(state.goal)) return undefined;
			const wasBudgetLimited = state.goal.status === "budget-limited";
			const currentAttempts = state.goal.failedCompletionAttempts ?? 0;
			const nextAttempt =
				options?.attempt === undefined ? currentAttempts + 1 : Math.max(currentAttempts + 1, options.attempt);
			const attempt = this.#appendVerificationAttempt(state.goal, {
				status: "rejected",
				attempt: nextAttempt,
				maxAttempts: options?.maxAttempts ?? nextAttempt,
				feedback: trimmedFeedback,
				structuredFeedback: options?.structuredFeedback,
				compactorMemo: options?.compactorMemo,
				sideAgentTokensUsed: options?.sideAgentTokensUsed,
			});
			state.goal.failedCompletionAttempts = nextAttempt;
			state.goal.verificationRepair = this.#buildVerificationRepair(
				attempt,
				trimmedFeedback,
				options?.structuredFeedback,
			);
			if (!wasBudgetLimited) {
				state.goal.status = "active";
			}
			state.enabled = true;
			state.mode = "active";
			state.reason = undefined;
			state.runMode = targetLinksBlockers(state.goal.currentTarget, state.goal.verificationRepair.blockers)
				? "working-target"
				: "awaiting-verification-repair";
			this.#budgetReportedFor = undefined;
			if (!wasBudgetLimited) {
				this.#markActiveAccounting(state.goal);
			}
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state.goal;
		});
	}

	#buildVerificationRepair(
		attempt: GoalVerificationAttempt,
		feedback: string,
		structuredFeedback: GoalCompletionVerifierStructuredOutput | undefined,
	): GoalVerificationRepairState {
		const focus = structuredFeedback?.continuationFocus;
		return {
			verificationAttemptId: attempt.id,
			feedback,
			blockers: structuredFeedback?.completionBlockers.map(blocker => ({ ...blocker })) ?? [],
			evidenceToCollect: focus?.evidenceToCollect ? [...focus.evidenceToCollect] : [],
			avoidRepeating: focus?.avoidRepeating ? [...focus.avoidRepeating] : [],
			createdAt: this.#now(),
			workEpoch: attempt.workEpoch,
		};
	}

	async recordSuccessfulCompletionVerification(
		goalId: string,
		feedback: string,
		options: {
			attempt: number;
			maxAttempts: number;
			structuredFeedback?: GoalCompletionVerifierStructuredOutput;
			sideAgentTokensUsed?: number;
		},
	): Promise<Goal | undefined> {
		const trimmedFeedback = feedback.trim();
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.id !== goalId || !isAccountingStatus(state.goal)) return undefined;
			this.#appendVerificationAttempt(state.goal, {
				status: "verified",
				attempt: options.attempt,
				maxAttempts: options.maxAttempts,
				feedback: trimmedFeedback,
				structuredFeedback: options.structuredFeedback,
				sideAgentTokensUsed: options.sideAgentTokensUsed,
			});
			state.goal.failedCompletionAttempts = undefined;
			state.goal.lastVerificationAttempt = undefined;
			state.goal.lastVerificationAttemptId = undefined;
			state.goal.lastVerificationFeedback = undefined;
			state.goal.lastVerificationCompactorMemo = undefined;
			state.goal.verificationRepair = undefined;
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state.goal;
		});
	}

	async recordExternalUsage(usage?: GoalTokenUsage, durationMs?: number): Promise<void> {
		await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || !isAccountingStatus(state.goal)) return;
			const now = this.#now();
			const tokenDelta = usage
				? Math.max(0, usage.input) + Math.max(0, usage.cacheWrite) + Math.max(0, usage.output)
				: 0;
			const wallSeconds = durationMs === undefined ? 0 : Math.max(0, Math.floor(durationMs / 1000));
			this.#wallClock = { activeGoalId: state.goal.id, lastAccountedAt: now };
			if (tokenDelta <= 0 && wallSeconds <= 0) return;

			state.goal.tokensUsed += tokenDelta;
			state.goal.timeUsedSeconds += wallSeconds;
			state.goal.updatedAt = now;
			const flippedToBudgetLimited =
				state.goal.tokenBudget !== undefined &&
				state.goal.tokensUsed >= state.goal.tokenBudget &&
				state.goal.status === "active";
			if (flippedToBudgetLimited) {
				state.goal.status = "budget-limited";
				this.#bumpState(state);
			}
			if (flippedToBudgetLimited) {
				await this.#commitState(state, { persist: "goal", reason: "budget-limited" });
			} else {
				this.#host.persistUsage?.({
					goalId: state.goal.id,
					stateVersion: state.stateVersion,
					tokenDelta,
					wallSeconds,
					tokensUsed: state.goal.tokensUsed,
					timeUsedSeconds: state.goal.timeUsedSeconds,
					updatedAt: state.goal.updatedAt,
				});
				await this.#commitState(state);
			}
			if (state.goal.status !== "budget-limited") {
				this.#budgetReportedFor = undefined;
			}
			if (flippedToBudgetLimited && this.#budgetReportedFor !== state.goal.id) {
				await this.#sendBudgetLimitSteer(state.goal);
			}
		});
	}

	#createGoalState(objective: string, tokenBudget: number | undefined, parentFrame?: GoalParentFrame): GoalModeState {
		const now = this.#now();
		const goal: Goal = {
			id: String(Snowflake.next()),
			objective,
			status: "active",
			tokenBudget,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
			workEpoch: 0,
			totalVerificationAttempts: 0,
			verificationAttempts: [],
			parentFrame: cloneParentFrame(parentFrame),
			targets: [],
			checkpoints: [],
			checkpointResolutions: [],
		};
		const parentFrameVersion = parentFrame ? 1 : 0;
		return { enabled: true, mode: "active", runMode: "working-target", stateVersion: 1, parentFrameVersion, goal };
	}

	async createGoal(input: {
		objective: string;
		tokenBudget?: number;
		parentFrame?: GoalParentFrame;
	}): Promise<GoalModeState> {
		const objective = input.objective.trim();
		if (!objective) throw new Error("objective is required when op=create");
		validateTokenBudget(input.tokenBudget);
		return await this.#withAccounting(async () => {
			const existing = this.#host.getState();
			if (existing?.goal && existing.goal.status !== "dropped" && existing.goal.status !== "complete") {
				throw new Error("cannot create a new goal because this session already has a goal");
			}
			const state = this.#createGoalState(
				objective,
				input.tokenBudget,
				normalizeParentFrame(input.parentFrame, objective),
			);
			this.#budgetReportedFor = undefined;
			this.#markActiveAccounting(state.goal);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	async replaceGoal(input: {
		objective: string;
		tokenBudget?: number;
		parentFrame?: GoalParentFrame;
	}): Promise<GoalModeState> {
		const objective = input.objective.trim();
		if (!objective) throw new Error("objective is required when op=replace");
		validateTokenBudget(input.tokenBudget);
		return await this.#withAccounting(async () => {
			const existing = this.#host.getState();
			if (!existing?.enabled || !isAccountingStatus(existing.goal)) {
				throw new Error("cannot replace goal because no goal is active");
			}
			await this.#flushUsageLocked("suppressed");
			const state = this.#createGoalState(
				objective,
				input.tokenBudget,
				normalizeParentFrame(input.parentFrame, objective),
			);
			this.#budgetReportedFor = undefined;
			this.#markActiveAccounting(state.goal);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	async resumeGoal(): Promise<GoalModeState> {
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.goal) throw new Error("No paused goal.");
			if (state.goal.status === "complete") throw new Error("Goal is already complete.");
			state.enabled = true;
			state.mode = "active";
			state.reason = undefined;
			state.goal.status = "active";
			this.#bumpState(state);
			this.#budgetReportedFor = undefined;
			this.#markActiveAccounting(state.goal);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	async pauseGoal(): Promise<GoalModeState | undefined> {
		return await this.#withAccounting(async () => {
			await this.#flushUsageLocked("suppressed");
			const state = this.#getStateClone();
			if (!state?.goal) return undefined;
			state.enabled = false;
			state.mode = "active";
			state.reason = undefined;
			if (state.goal.status === "active" || state.goal.status === "budget-limited") {
				state.goal.status = "paused";
			}
			this.#bumpState(state);
			this.#clearActiveAccounting();
			this.#budgetReportedFor = undefined;
			await this.#commitState(state, { persist: "goal_paused" });
			return state;
		});
	}

	async dropGoal(): Promise<Goal | undefined> {
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.goal) return undefined;
			this.#assertGoalDropAllowed(state);
			await this.#flushUsageLocked("suppressed");
			const dropped = { ...state.goal, status: "dropped" as const, updatedAt: this.#now() };
			const droppedState: GoalModeState = {
				...state,
				enabled: false,
				goal: dropped,
				stateVersion: state.stateVersion + 1,
			};
			this.#clearActiveAccounting();
			this.#budgetReportedFor = undefined;
			await this.#commitState(droppedState, { persist: "goal" });
			await this.#commitState(undefined, { persist: "none", emit: false });
			return dropped;
		});
	}

	async completeGoalFromTool(): Promise<Goal> {
		return await this.#withAccounting(async () => {
			await this.#flushUsageLocked("suppressed");
			const state = this.#getStateClone();
			if (!state?.goal) throw new Error("cannot complete goal because no goal is active");
			if (state.goal.status === "complete") throw new Error("goal is already complete");
			if (state.goal.status === "dropped") throw new Error("cannot complete a dropped goal");
			if (state.runMode === "planning-target") {
				throw new Error("cannot complete parent goal while target planning is pending");
			}
			if (state.runMode === "awaiting-user-input") {
				throw new Error("cannot complete parent goal while awaiting user input or external authority");
			}
			if (state.goal.pendingCheckpointId) {
				throw new Error("cannot complete parent goal while a checkpoint is pending resolution");
			}
			if (state.goal.verificationRepair) {
				throw new Error("cannot retry parent completion until verifier blockers have fresh repair evidence");
			}
			state.enabled = false;
			state.goal.status = "complete";
			state.mode = "exiting";
			state.reason = "completed";
			state.runMode = "completed";
			this.#bumpState(state);
			this.#clearActiveAccounting();
			this.#budgetReportedFor = undefined;
			await this.#commitState(state, { persist: "goal" });
			return state.goal;
		});
	}

	async startTarget(input: GoalStartTargetInput): Promise<GoalModeState> {
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.status !== "active")
				throw new Error("cannot start target because no active parent goal exists");
			if (state.goal.pendingCheckpointId || state.runMode === "awaiting-checkpoint-resolution") {
				throw new Error("cannot start a target while a checkpoint is pending resolution");
			}
			if (state.runMode === "awaiting-parent-completion") {
				throw new Error("cannot start a target after parent_completion_candidate; call complete for verification");
			}
			const repair = state.goal.verificationRepair;
			const activeTarget = state.goal.currentTarget?.status === "active" ? state.goal.currentTarget : undefined;
			if (repair?.blockers.length) {
				validateVerifierRepairLinks(input.linkedVerifierBlockerIds, repair.blockers, "start_target");
			}
			const replacingForVerifierRepair =
				activeTarget !== undefined &&
				state.runMode === "awaiting-verification-repair" &&
				repair !== undefined &&
				(input.linkedVerifierBlockerIds?.length ?? 0) > 0;
			if (state.goal.currentBlockedState?.status === "open" && !replacingForVerifierRepair) {
				throw new Error(
					"cannot start target while goal is blocked; use recover_blocked_state with the current blocked_state identity",
				);
			}
			if (activeTarget && !replacingForVerifierRepair) {
				throw new Error("cannot start a target because another target is already active");
			}
			const createdBy =
				input.createdBy ??
				(state.runMode === "awaiting-verification-repair"
					? "verification-repair"
					: state.goal.targets?.length
						? "operator"
						: "initial");
			const targetInput =
				createdBy === "verification-repair" && repair && !input.createdFromVerificationAttemptId
					? { ...input, createdFromVerificationAttemptId: repair.verificationAttemptId }
					: input;
			const target = targetFromInput(
				state.goal,
				targetInput,
				nextTargetSequence(state.goal),
				state.parentFrameVersion,
				this.#now(),
				createdBy,
			);
			if (replacingForVerifierRepair && activeTarget) {
				state.goal.targets = upsertById(state.goal.targets ?? [], [{ ...activeTarget, status: "superseded" }]);
			}
			state.goal.currentTarget = target;
			this.#beginTargetPlanning(state, target);
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	buildCheckpointCandidate(input: GoalCheckpointInput): GoalCheckpointPacket {
		const state = this.#getStateClone();
		if (!state) throw new Error("cannot checkpoint because no active parent goal exists");
		if (state.goal.status === "paused" || state.enabled !== true) {
			throw new Error('cannot checkpoint while the goal is paused; call goal({op:"resume"}) before checkpointing');
		}
		if (state.goal.status !== "active") {
			throw new Error(`cannot checkpoint because parent goal status is ${state.goal.status}`);
		}
		if (state.runMode === "planning-target") {
			throw new Error("cannot checkpoint while target planning is pending");
		}
		if (state.runMode === "awaiting-checkpoint-resolution" || state.goal.pendingCheckpointId) {
			throw new Error("cannot checkpoint while another checkpoint is pending resolution");
		}
		if (input.status !== "closed_with_evidence") throw new Error("checkpoint status must be closed_with_evidence");
		if (input.localClaims.length === 0) throw new Error("checkpoint local_claims must not be empty");
		if (!input.evidence.some(item => item.current && item.claim.trim() && item.evidence.trim())) {
			throw new Error("checkpoint requires positive current evidence for the closed target");
		}
		if (input.notClaimed.length === 0) throw new Error("checkpoint not_claimed must not be empty");
		let target = cloneTarget(state.goal.currentTarget);
		if (!target) {
			if (!input.retrospectiveTarget) throw new Error("checkpoint requires an active target");
			target = targetFromInput(
				state.goal,
				{ ...input.retrospectiveTarget, createdBy: "retrospective" },
				nextTargetSequence(state.goal),
				state.parentFrameVersion,
				this.#now(),
				"retrospective",
			);
		}
		if (target.status !== "active") throw new Error("checkpoint requires an active target");
		if (state.goal.currentTarget?.id === target.id) {
			this.#assertCurrentTargetPlanApprovedForTarget(state, target);
		}
		const sequence = nextCheckpointSequence(state.goal);
		const checkpointId = `${state.goal.id}-checkpoint-${sequence}`;
		const evidence = normalizeCheckpointEvidenceItems(input.evidence, checkpointId);
		assertCheckpointEvidenceCoversPlan(state.goal, target, evidence);
		const packet: GoalCheckpointPacket = {
			id: checkpointId,
			sequence,
			goalId: state.goal.id,
			targetId: target.id,
			targetSnapshot: target,
			parentFrameVersion: state.parentFrameVersion,
			baselineRefs: cloneRefs(target.baselineRefs),
			gateRefs: [...target.gateRefs],
			workEpoch: state.goal.workEpoch ?? 0,
			status: input.status,
			summary: trimmed(input.summary, "summary"),
			localClaims: input.localClaims.map(claim => trimmed(claim, "local_claims[]")),
			evidence,
			checksRun: cloneStringArray(input.checksRun),
			artifactsTouched: cloneStringArray(input.artifactsTouched),
			notClaimed: withDefaultNotClaimed(input.notClaimed.map(claim => trimmed(claim, "not_claimed[]"))),
			remainingQuestions: input.remainingQuestions.map(question => trimmed(question, "remaining_questions[]")),
			risksOrCaveats: cloneStringArray(input.risksOrCaveats),
			staleIf: [...target.staleIf, ...cloneStringArray(input.staleIf)],
			suggestedControllerQuestions: cloneStringArray(input.suggestedControllerQuestions),
			createdAt: this.#now(),
		};
		return packet;
	}

	async commitCheckpoint(packet: GoalCheckpointPacket, review: GoalCheckpointReview): Promise<GoalModeState> {
		if (review.status !== "accepted") throw new Error("cannot commit checkpoint with a rejected review");
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.status !== "active")
				throw new Error("cannot checkpoint because no active parent goal exists");
			if (state.goal.pendingCheckpointId)
				throw new Error("cannot checkpoint while another checkpoint is pending resolution");
			let target = cloneTarget(state.goal.currentTarget);
			if (!target && packet.targetSnapshot.createdBy === "retrospective")
				target = cloneTarget(packet.targetSnapshot);
			if (!target || target.id !== packet.targetId || target.status !== "active") {
				throw new Error("checkpoint target is stale");
			}
			if (state.goal.currentTarget?.id === target.id) {
				this.#assertCurrentTargetPlanApprovedForTarget(state, target);
			}
			const closedAt = this.#now();
			const closedTarget: GoalTarget = { ...target, status: "closed", closedAt };
			const committedPacket: GoalCheckpointPacket = {
				...(cloneCheckpoint(packet) ?? packet),
				targetSnapshot: closedTarget,
				review: { ...review },
			};
			state.goal.currentTarget = closedTarget;
			state.goal.targets = upsertById(state.goal.targets ?? [], [closedTarget]);
			state.goal.checkpoints = [...(state.goal.checkpoints ?? []), committedPacket];
			state.goal.pendingCheckpointId = committedPacket.id;
			state.goal.lastCheckpointRejection = undefined;
			this.#closeActiveWorkstreamBatchForTarget(state, closedTarget.id, closedAt);
			if (state.goal.verificationRepair) {
				const nextRepair = updateVerificationRepairForClosedTarget(state.goal.verificationRepair, closedTarget);
				state.goal.verificationRepair = nextRepair;
				if (!nextRepair) state.goal.failedCompletionAttempts = undefined;
			}
			state.runMode = "awaiting-checkpoint-resolution";
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	async rejectCheckpoint(candidate: GoalCheckpointPacket, review: GoalCheckpointReview): Promise<GoalModeState> {
		if (review.status !== "rejected") throw new Error("checkpoint rejection requires a rejected review");
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.status !== "active")
				throw new Error("cannot reject checkpoint because no active parent goal exists");
			state.goal.lastCheckpointRejection = {
				candidateSummary: candidate.summary,
				review: { ...review },
				createdAt: this.#now(),
			};
			state.runMode = "working-target";
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	async recordCheckpointResolution(input: GoalCheckpointResolutionInput): Promise<GoalModeState> {
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.status !== "active")
				throw new Error("cannot resolve checkpoint because no active parent goal exists");
			if (!state.goal.pendingCheckpointId)
				throw new Error("cannot resolve checkpoint because no checkpoint is pending");
			if (state.goal.pendingCheckpointId !== input.checkpointId)
				throw new Error("checkpoint_id does not match the pending checkpoint");
			const pendingCheckpoint = state.goal.checkpoints?.find(checkpoint => checkpoint.id === input.checkpointId);
			if (!pendingCheckpoint) throw new Error("checkpoint_id does not match a committed checkpoint");
			if (input.decision === "next_target" && !input.nextTarget) {
				throw new Error("next_target is required when decision is next_target");
			}
			this.#assertFreshGoalMutationInput(state, input, "resolve_checkpoint");
			const repair = state.goal.verificationRepair;
			if (repair && input.decision === "parent_completion_candidate") {
				throw new Error(
					"cannot select parent_completion_candidate until verifier blockers have fresh repair evidence",
				);
			}
			const sequence = nextResolutionSequence(state.goal);
			const resolutionId = `${state.goal.id}-checkpoint-resolution-${sequence}`;
			let parentFrameChanged = false;
			const parentDelta = input.parentDelta
				? normalizeParentDeltaCheckpointEvidenceRefs(input.parentDelta, pendingCheckpoint)
				: undefined;
			if (parentDelta) {
				parentFrameChanged = parentDeltaHasFrameChanges(parentDelta);
				if (parentFrameChanged) {
					state.goal.parentFrame = this.#applyParentStateDeltaToFrame(state.goal, parentDelta, resolutionId);
				}
				if (parentDeltaHasDeliverableChanges(parentDelta)) {
					state.goal.deliverableMap = applyDeliverableDeltas(
						state.goal.deliverableMap,
						parentDelta.deliverableDeltas,
					);
				}
			}
			let nextTarget: GoalTarget | undefined;
			let runMode: GoalRunMode = "awaiting-user-input";
			if (input.decision === "next_target") {
				const nextTargetInput = input.nextTarget as GoalStartTargetInput;
				const normalizedNextTargetInput = {
					...nextTargetInput,
					baselineRefs: replaceLegacyCheckpointRef(nextTargetInput.baselineRefs, pendingCheckpoint),
				};
				if (repair?.blockers.length) {
					validateVerifierRepairLinks(
						normalizedNextTargetInput.linkedVerifierBlockerIds,
						repair.blockers,
						"next_target",
					);
				}
				nextTarget = targetFromInput(
					state.goal,
					{
						...normalizedNextTargetInput,
						createdBy: "checkpoint-resolution",
						createdFromCheckpointId: input.checkpointId,
						createdFromVerificationAttemptId:
							normalizedNextTargetInput.createdFromVerificationAttemptId ?? repair?.verificationAttemptId,
					},
					nextTargetSequence(state.goal),
					parentFrameChanged ? state.parentFrameVersion + 1 : state.parentFrameVersion,
					this.#now(),
					"checkpoint-resolution",
				);
				state.goal.currentTarget = nextTarget;
				this.#beginTargetPlanning(state, nextTarget);
				runMode = state.runMode;
			} else if (input.decision === "parent_completion_candidate") {
				runMode = "awaiting-parent-completion";
			}
			const resolution: GoalCheckpointResolution = {
				id: resolutionId,
				sequence,
				goalId: state.goal.id,
				checkpointId: input.checkpointId,
				decision: input.decision,
				parentReading: trimmed(input.parentReading, "parent_reading"),
				parentDelta,
				notPropagated: input.notPropagated.map(item => trimmed(item, "not_propagated[]")),
				remainingParentWork: input.remainingParentWork.map(item => trimmed(item, "remaining_parent_work[]")),
				broaderChecksOrInputs: cloneStringArray(input.broaderChecksOrInputs),
				lessonsForFuture: cloneStringArray(input.lessonsForFuture),
				nextTarget,
				createdAt: this.#now(),
			};
			state.goal.checkpointResolutions = [...(state.goal.checkpointResolutions ?? []), resolution];
			state.goal.lastCheckpointResolutionId = resolution.id;
			state.goal.pendingCheckpointId = undefined;
			if (isNonContinuingCheckpointDecision(resolution.decision)) {
				const message = "Checkpoint resolution is awaiting user, broader-check, or external input.";
				const sequence = nextBlockedStateSequence(state.goal);
				this.#enterBlockedState(state, {
					id: `${state.goal.id}-blocked-${sequence}`,
					sequence,
					kind: "checkpoint-external-pause",
					status: "open",
					message,
					blockers: resolution.broaderChecksOrInputs.length
						? [...resolution.broaderChecksOrInputs]
						: resolution.remainingParentWork.length
							? [...resolution.remainingParentWork]
							: [message],
					suggestedQuestions: [...resolution.broaderChecksOrInputs],
					allowedActions: ["start_next_target", "enter_parent_completion"],
					stateVersionAtBlock: state.stateVersion,
					parentFrameVersionAtBlock: parentFrameChanged ? state.parentFrameVersion + 1 : state.parentFrameVersion,
					createdAt: resolution.createdAt,
					updatedAt: resolution.createdAt,
					source: {
						checkpointId: resolution.checkpointId,
						checkpointResolutionId: resolution.id,
						decision: resolution.decision,
					},
					broaderChecksOrInputs: [...resolution.broaderChecksOrInputs],
					remainingParentWork: [...resolution.remainingParentWork],
				});
			} else {
				state.runMode = runMode;
			}
			this.#bumpState(state, { parentFrameChanged });
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	#applyParentStateDeltaToFrame(goal: Goal, delta: GoalParentStateDelta, deltaId: string): GoalParentFrame {
		const base = cloneParentFrame(goal.parentFrame) ?? {
			kind: "plain" as const,
			desiredFuture: goal.objective,
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
		};
		base.acceptedClaims = upsertById(
			base.acceptedClaims,
			delta.admittedClaims.map(claim => ({ ...claim, status: "accepted" as const })),
		);
		base.candidateClaims = upsertById(
			base.candidateClaims,
			delta.candidateClaimsAdded.map(claim => ({ ...claim, status: "candidate" as const })),
		);
		base.rejectedOrStaleClaims = upsertById(
			base.rejectedOrStaleClaims,
			delta.rejectedClaims.map(claim => ({ ...claim, status: claim.status === "stale" ? "stale" : "rejected" })),
		);
		base.boundaries = upsertById(base.boundaries, delta.boundariesAdded);
		base.residuals = upsertById(base.residuals, delta.residualsAddedOrUpdated);
		base.frontier = upsertById(base.frontier, delta.frontierDeltas);
		for (const gateDelta of delta.gateDeltas) {
			const index = base.gates.findIndex(gate => gate.id === gateDelta.gateId);
			if (index === -1) {
				base.gates.push({
					id: gateDelta.gateId,
					name: gateDelta.gateId,
					status: gateDelta.status,
					requiredEvidence: [],
					evidenceRefs: cloneRefs(gateDelta.evidenceRefs),
				});
			} else {
				const existing = base.gates[index];
				base.gates[index] = {
					...existing,
					status: gateDelta.status,
					evidenceRefs: gateDelta.evidenceRefs ? cloneRefs(gateDelta.evidenceRefs) : existing.evidenceRefs,
				};
			}
		}
		base.externalRefs = upsertById(base.externalRefs, [
			...delta.externalRecordRefs,
			...delta.staleRefs,
			...(delta.authorityDecisionRefs ?? []),
		]);
		base.lastParentDeltaId = deltaId;
		return base;
	}

	applyParentStateDelta(delta: GoalParentStateDelta): GoalParentFrame {
		const state = this.#getStateClone();
		if (!state?.goal) throw new Error("cannot apply parent delta because no goal exists");
		return this.#applyParentStateDeltaToFrame(state.goal, delta, `preview-${state.stateVersion + 1}`);
	}

	async recordVerificationRepairState(input: {
		verificationAttemptId: string;
		feedback: string;
		blockers: GoalVerificationGap[];
		evidenceToCollect?: string[];
		avoidRepeating?: string[];
	}): Promise<GoalModeState> {
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.status !== "active")
				throw new Error("cannot record verifier repair without active goal");
			state.goal.verificationRepair = {
				verificationAttemptId: input.verificationAttemptId,
				feedback: input.feedback,
				blockers: input.blockers.map(blocker => ({ ...blocker })),
				evidenceToCollect: cloneStringArray(input.evidenceToCollect),
				avoidRepeating: cloneStringArray(input.avoidRepeating),
				createdAt: this.#now(),
				workEpoch: state.goal.workEpoch ?? 0,
			};
			state.runMode = targetLinksBlockers(state.goal.currentTarget, state.goal.verificationRepair.blockers)
				? "working-target"
				: "awaiting-verification-repair";
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	async clearVerificationRepairAfterFreshEvidence(input?: {
		verificationAttemptId?: string;
	}): Promise<GoalModeState | undefined> {
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || !state.goal.verificationRepair) return state;
			if (
				input?.verificationAttemptId &&
				input.verificationAttemptId !== state.goal.verificationRepair.verificationAttemptId
			) {
				return state;
			}
			state.goal.verificationRepair = undefined;
			state.goal.failedCompletionAttempts = undefined;
			if (state.runMode === "awaiting-verification-repair") state.runMode = "working-target";
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	validateCurrentTargetPlanSubmission(input: GoalSubmitTargetPlanInput): GoalTargetPlanRecord {
		return this.#validateTargetPlanSubmission(this.#getStateClone(), input);
	}

	lintCurrentTargetPlanSubmission(
		input: GoalSubmitTargetPlanInput | undefined,
		schemaDiagnostics: GoalTargetPlanLintDiagnostic[] = [],
		mode: "lint" | "submit" = "lint",
	): GoalTargetPlanLintResult {
		const state = this.#getStateClone();
		const diagnostics: GoalTargetPlanLintDiagnostic[] = [...schemaDiagnostics];
		const identity = currentTargetPlanSubmitIdentity(state);
		const addIdentityDiagnostic = (
			path: Array<string | number>,
			message: string,
			guidance = 'Call goal({op:"get"}) and reuse the current target-plan submit identity.',
			value?: unknown,
		): void => {
			diagnostics.push(
				lintDiagnostic({
					severity: "error",
					code: "identity.mismatch",
					path,
					message,
					guidance,
					offender: { kind: "identity", value },
				}),
			);
		};
		if (!state?.enabled || state.goal.status !== "active") {
			addIdentityDiagnostic([], "cannot lint target plan because no active parent goal exists");
		} else if (state.goal.currentTarget?.status !== "active") {
			addIdentityDiagnostic(["target_id"], "cannot lint target plan without an active target");
		} else if (
			!state.goal.currentTargetPlan ||
			state.goal.currentTargetPlan.targetId !== state.goal.currentTarget.id
		) {
			addIdentityDiagnostic(["target_plan_id"], "current target plan is stale");
		} else if (state.runMode !== "planning-target") {
			addIdentityDiagnostic(
				[],
				"target plan lint is only valid while runMode is planning-target",
				"Return to target planning before linting or submitting a target plan.",
				state.runMode,
			);
		} else if (
			state.goal.currentTargetPlan.status !== "drafting" &&
			state.goal.currentTargetPlan.status !== "revision-required"
		) {
			addIdentityDiagnostic(
				["target_plan_id"],
				"target plan lint requires a draft or revision-required plan",
				"Recover or restart target planning before submitting this plan.",
				state.goal.currentTargetPlan.status,
			);
		}
		if (input && identity) {
			if (input.targetId !== identity.targetId) {
				addIdentityDiagnostic(
					["target_id"],
					`target_id must equal currentTarget.id (${identity.targetId}); got ${input.targetId}`,
					undefined,
					input.targetId,
				);
			}
			if (input.targetPlanId !== identity.targetPlanId) {
				addIdentityDiagnostic(
					["target_plan_id"],
					`target_plan_id must equal currentTargetPlan.id (${identity.targetPlanId}); got ${input.targetPlanId}`,
					undefined,
					input.targetPlanId,
				);
			}
			if (input.planFilePath !== identity.planFilePath) {
				addIdentityDiagnostic(
					["plan_file_path"],
					`plan_file_path must equal currentTargetPlan.planFilePath (${identity.planFilePath}); got ${input.planFilePath}`,
					undefined,
					input.planFilePath,
				);
			}
			if (input.revision !== identity.revision) {
				addIdentityDiagnostic(
					["revision"],
					`revision must equal currentTargetPlan.revision (${identity.revision}); got ${input.revision}`,
					undefined,
					input.revision,
				);
			}
			diagnostics.push(...collectTargetPlanReviewEvidenceDiagnostics(input));
			diagnostics.push(
				...collectTargetPlanGraphDiagnostics(input, {
					mode,
					goal: state?.goal,
					targetPlanId: input.targetPlanId,
				}),
			);
		}
		const errorCount = diagnostics.filter(diagnostic => diagnostic.severity === "error").length;
		const warningCount = diagnostics.filter(diagnostic => diagnostic.severity === "warning").length;
		const infoCount = diagnostics.filter(diagnostic => diagnostic.severity === "info").length;
		const currentPlan = state?.goal.currentTargetPlan;
		const primarySignalGroupId =
			input?.primarySignalGroupId ??
			currentPlan?.primarySignalGroupId ??
			currentPlan?.verificationAperture?.primarySignalId;
		return {
			ok: errorCount === 0,
			targetId: input?.targetId ?? state?.goal.currentTarget?.id,
			targetPlanId: input?.targetPlanId ?? currentPlan?.id,
			planFilePath: input?.planFilePath ?? currentPlan?.planFilePath,
			revision: input?.revision ?? currentPlan?.revision,
			stateVersion: state?.stateVersion ?? 0,
			parentFrameVersion: state?.parentFrameVersion ?? 0,
			planDepth: input?.planDepth ?? currentPlan?.planDepth,
			primarySignalGroupId,
			legacy: input
				? input.primarySignalGroupId === undefined ||
					input.planDepth === undefined ||
					input.targetCard === undefined
				: true,
			diagnostics,
			summary: {
				errorCount,
				warningCount,
				infoCount,
				blocksSubmission: errorCount > 0,
			},
		};
	}

	async approveCurrentTargetPlan(input: GoalTargetPlanApprovalInput): Promise<GoalModeState> {
		this.#assertTargetPlanApprovalGates(input);
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			const lintDiagnostics = collectTargetPlanGraphDiagnostics(input, {
				mode: "submit",
				goal: state?.goal,
				targetPlanId: input.targetPlanId,
			});
			const blockingDiagnostic = lintDiagnostics.find(diagnostic => diagnostic.severity === "error");
			if (blockingDiagnostic) throw new Error(blockingDiagnostic.message);
			const submittedPlan = this.#validateTargetPlanSubmission(state, input);
			if (!state?.goal.currentTarget) throw new Error("cannot approve target plan without an active target");
			const now = this.#now();
			const approvedPlan = cloneTargetPlan({
				...submittedPlan,
				planHash: input.planHash,
				planBytes: input.planBytes,
				payloadFilePath: input.payloadFilePath,
				payloadHash: input.payloadHash,
				payloadBytes: input.payloadBytes,
				status: "approved",
				updatedAt: now,
				approvedAt: now,
				failure: undefined,
				reviews: this.#mergeTargetPlanReviews(submittedPlan, input.reviews),
			});
			if (!approvedPlan) throw new Error("target plan approval record is invalid");
			const targetBase: GoalTarget = {
				...state.goal.currentTarget,
				planId: approvedPlan.id,
				verificationAperture: approvedPlan.verificationAperture,
				verificationSignals: approvedPlan.verificationSignals,
				concernChecks: approvedPlan.concernChecks,
				scopeCalibration: approvedPlan.scopeCalibration,
				planDepth: approvedPlan.planDepth,
				primarySignalGroupId: approvedPlan.primarySignalGroupId,
				scenarioMatrix: approvedPlan.scenarioMatrix,
				targetCard: approvedPlan.targetCard,
				workstreamBatchId: undefined,
			};
			const workstreamBatch = buildWorkstreamBatchFromApprovedPlan({
				goal: state.goal,
				target: targetBase,
				plan: approvedPlan,
				planFilePath: approvedPlan.planFilePath,
				payloadFilePath: targetPlanPayloadFilePath(approvedPlan.planFilePath),
				now,
			});
			const target: GoalTarget = {
				...targetBase,
				workstreamBatchId: workstreamBatch?.id,
			};
			state.goal.currentTarget = target;
			state.goal.targets = upsertById(state.goal.targets ?? [], [target]);
			if (workstreamBatch) {
				state.goal.currentWorkstreamBatch = workstreamBatch;
				state.goal.workstreamBatches = upsertWorkstreamBatch(state.goal.workstreamBatches, workstreamBatch);
			} else if (state.goal.currentWorkstreamBatch?.targetId === target.id) {
				state.goal.currentWorkstreamBatch = undefined;
			}
			this.#upsertTargetPlan(state, approvedPlan);
			state.runMode = "working-target";
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	async rejectCurrentTargetPlan(input: GoalTargetPlanRejectionInput): Promise<GoalModeState> {
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.status !== "active")
				throw new Error("cannot reject target plan because no active parent goal exists");
			const currentPlan = state.goal.currentTargetPlan;
			if (
				input.stage === "stale" &&
				currentPlan?.id === input.targetPlanId &&
				input.revision !== undefined &&
				currentPlan.revision !== input.revision
			) {
				return state;
			}
			if (input.stage === "stale" && (!currentPlan || currentPlan.id !== input.targetPlanId)) {
				const historicalPlan = state.goal.targetPlans?.find(plan => plan.id === input.targetPlanId);
				if (!historicalPlan) throw new Error("target_plan_id does not match a known target plan");
				const stalePlan = cloneTargetPlan({
					...historicalPlan,
					status: "stale",
					updatedAt: this.#now(),
					reviews: this.#mergeTargetPlanReviews(historicalPlan, input.reviews),
				});
				if (!stalePlan) throw new Error("stale target plan record is invalid");
				state.goal.targetPlans = upsertById(state.goal.targetPlans ?? [], [stalePlan]);
				this.#bumpState(state);
				await this.#commitState(state, { persist: "goal" });
				return state;
			}
			if (!currentPlan || currentPlan.id !== input.targetPlanId) {
				throw new Error("target_plan_id does not match the current target plan");
			}
			const now = this.#now();
			const reviews = this.#mergeTargetPlanReviews(currentPlan, input.reviews);
			let nextPlan: GoalTargetPlanRecord;
			let autoTargetPlanRecovery: { reason: GoalRecoveryReason; guidance: string; blockers: string[] } | undefined;
			if (input.stage === "stale" && (input.revision === undefined || input.revision === currentPlan.revision)) {
				nextPlan = {
					...currentPlan,
					status: "stale",
					updatedAt: now,
					reviews,
				};
				state.runMode = "awaiting-user-input";
			} else if (currentPlan.revision >= TARGET_PLAN_REJECTION_CAP) {
				const capReviews = input.reviews.length ? input.reviews : reviews;
				const hasReviewerFailure = capReviews.some(review => review.status === "failed");
				const rejectedCapReviews = capReviews.filter(review => review.status === "rejected");
				const reviewerBlockers = targetPlanRecoveryBlockersFromReviews(capReviews);
				const actionableBlockers = targetPlanRecoveryBlockersFromReviews(rejectedCapReviews);
				const failure: GoalTargetPlanFailure = {
					stage: input.stage,
					reason: "review-rejection-cap",
					message: input.message,
					blockers: reviewerBlockers.length ? reviewerBlockers : [input.message],
					suggestedQuestions: [
						"Clarify the right-sized product signal for this target.",
						"Identify which related same-signal work must be included before execution.",
					],
					at: now,
				};
				nextPlan = {
					...currentPlan,
					status: "failed",
					updatedAt: now,
					failedAt: now,
					failure,
					reviews,
				};
				if (
					input.stage === "review" &&
					!hasReviewerFailure &&
					actionableBlockers.length > 0 &&
					!targetPlanReviewNeedsUserInput(rejectedCapReviews)
				) {
					autoTargetPlanRecovery = {
						reason: "state-refresh",
						guidance: actionableBlockers.join("\n"),
						blockers: actionableBlockers,
					};
					state.runMode = "planning-target";
				} else {
					state.runMode = "awaiting-user-input";
				}
			} else {
				nextPlan = {
					...currentPlan,
					status: "revision-required",
					revision: currentPlan.revision + 1,
					updatedAt: now,
					reviews,
				};
				state.runMode = "planning-target";
			}
			const stored = this.#upsertTargetPlan(state, nextPlan);
			if (state.goal.currentTarget) state.goal.currentTarget.planId = stored.id;
			if (autoTargetPlanRecovery && state.goal.currentTarget?.status === "active") {
				const target = state.goal.currentTarget;
				const recovery = this.#startRecoveredTargetPlanAttempt(state, {
					target,
					now,
					blockedStateId: `${stored.id}-auto-consolidation`,
					reason: autoTargetPlanRecovery.reason,
					guidance: autoTargetPlanRecovery.guidance,
					blockers: autoTargetPlanRecovery.blockers,
					source: {
						targetId: target.id,
						targetSequence: target.sequence,
						targetPlanId: stored.id,
						revision: stored.revision,
						status: "failed",
						planFilePath: stored.planFilePath,
					},
				});
				state.goal.recoveryHistory = upsertRecoveryRecord(state.goal.recoveryHistory, recovery);
				state.runMode = "planning-target";
			} else if (
				(stored.status === "failed" || stored.status === "stale") &&
				state.goal.currentTarget?.status === "active"
			) {
				const target = state.goal.currentTarget;
				const message = stored.failure?.message ?? `target plan is ${stored.status}`;
				const sequence = nextBlockedStateSequence(state.goal);
				this.#enterBlockedState(state, {
					id: `${state.goal.id}-blocked-${sequence}`,
					sequence,
					kind: "target-plan",
					status: "open",
					message,
					blockers: recoveryBlockersForTargetPlan(stored),
					suggestedQuestions: stored.failure ? [...stored.failure.suggestedQuestions] : [],
					allowedActions: ["restart_target_planning"],
					stateVersionAtBlock: state.stateVersion,
					parentFrameVersionAtBlock: state.parentFrameVersion,
					createdAt: now,
					updatedAt: now,
					source: {
						targetId: target.id,
						targetSequence: target.sequence,
						targetPlanId: stored.id,
						revision: stored.revision,
						status: stored.status,
						planFilePath: stored.planFilePath,
					},
				});
			}
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}
	#startRecoveredTargetPlanAttempt(
		state: GoalModeState,
		input: {
			target: GoalTarget;
			now: number;
			blockedStateId: string;
			reason: GoalRecoveryReason;
			guidance: string;
			blockers: string[];
			source: GoalRecoveryRecord["source"];
		},
	): GoalRecoveryRecord {
		const sequence = nextRecoverySequence(state.goal);
		const recoveryId = `${state.goal.id}-recovery-${sequence}`;
		const attempt = nextTargetPlanAttempt(state.goal, input.target);
		const planId = `${input.target.id}-plan-attempt-${attempt}`;
		const planFilePath = `local://goal-${sanitizeGoalPlanSlug(state.goal.id)}-target-${input.target.sequence}-plan-attempt-${attempt}.md`;
		const recoveryLink: GoalRecoveryLink = {
			recoveryId,
			blockedStateId: input.blockedStateId,
			kind: "target-plan",
			action: "restart_target_planning",
			reason: input.reason,
			guidance: input.guidance,
			blockers: [...input.blockers],
			at: input.now,
		};
		const recoveredPlan: GoalTargetPlanRecord = {
			id: planId,
			goalId: state.goal.id,
			targetId: input.target.id,
			targetSequence: input.target.sequence,
			planFilePath,
			status: "drafting",
			revision: 1,
			stateVersionAtStart: state.stateVersion,
			parentFrameVersionAtStart: input.target.parentFrameVersion ?? state.parentFrameVersion,
			createdAt: input.now,
			updatedAt: input.now,
			recoveredFrom: recoveryLink,
			reviews: [],
		};
		this.#upsertTargetPlan(state, recoveredPlan);
		const recoveredTarget = { ...input.target, planId: recoveredPlan.id };
		state.goal.currentTarget = recoveredTarget;
		state.goal.targets = upsertById(state.goal.targets ?? [], [recoveredTarget]);
		return {
			id: recoveryId,
			sequence,
			blockedStateId: input.blockedStateId,
			kind: "target-plan",
			action: "restart_target_planning",
			reason: input.reason,
			guidance: input.guidance,
			blockers: [...input.blockers],
			source: input.source,
			result: {
				runMode: "planning-target",
				targetId: input.target.id,
				targetPlanId: recoveredPlan.id,
				planFilePath: recoveredPlan.planFilePath,
			},
			at: input.now,
		};
	}

	#restartTargetPlanningFromBlockedState(
		state: GoalModeState | undefined,
		input: Extract<GoalRecoverBlockedStateInput, { kind: "target-plan" }>,
		now: number,
	): GoalRecoveryRecord {
		if (!state?.enabled || state.goal.status !== "active")
			throw new Error("cannot recover blocked state because no active parent goal exists");
		if (state.runMode !== "awaiting-user-input")
			throw new Error("cannot recover blocked state unless goal is awaiting user input");
		const block = state.goal.currentBlockedState;
		if (block?.status !== "open") throw new Error("no current blocked state is recoverable");
		if (input.blockedStateId !== block.id)
			throw new Error(
				`blocked_state_id must equal currentBlockedState.id (${block.id}); got ${input.blockedStateId}`,
			);
		if (block.kind !== "target-plan" || input.action !== "restart_target_planning") {
			throw new Error("blocked state does not allow restart_target_planning");
		}
		if (state.goal.pendingCheckpointId)
			throw new Error("cannot recover target planning while a checkpoint is pending resolution");
		if (state.goal.verificationRepair)
			throw new Error("cannot recover target planning while verifier repair is pending");
		const target = state.goal.currentTarget;
		if (target?.status !== "active") throw new Error("cannot recover target planning without an active target");
		const plan = state.goal.currentTargetPlan;
		if (!plan || plan.targetId !== target.id) throw new Error("current target plan is stale");
		if (input.targetId !== target.id)
			throw new Error(`target_id must equal currentTarget.id (${target.id}); got ${input.targetId}`);
		if (input.targetPlanId !== plan.id)
			throw new Error(`target_plan_id must equal currentTargetPlan.id (${plan.id}); got ${input.targetPlanId}`);
		if (input.revision !== plan.revision)
			throw new Error(`revision must equal currentTargetPlan.revision (${plan.revision}); got ${input.revision}`);
		if (input.sourceStatus !== plan.status)
			throw new Error(
				`source_status must equal currentTargetPlan.status (${plan.status}); got ${input.sourceStatus}`,
			);
		if (target.planId && target.planId !== plan.id) throw new Error("current target plan is stale");
		if (plan.status !== "failed" && plan.status !== "stale") {
			throw new Error("target planning recovery requires a failed or stale current plan");
		}
		const guidance = input.guidance.trim();
		if (!guidance) throw new Error("recover_blocked_state guidance must be non-empty");
		const recovery = this.#startRecoveredTargetPlanAttempt(state, {
			target,
			now,
			blockedStateId: block.id,
			reason: input.reason,
			guidance,
			blockers: [...block.blockers],
			source: { ...block.source },
		});
		this.#resolveBlockedState(state, block, recovery);
		state.runMode = "planning-target";
		return recovery;
	}

	#recoverCheckpointExternalPause(
		state: GoalModeState | undefined,
		input: Extract<GoalRecoverBlockedStateInput, { kind: "checkpoint-external-pause" }>,
		now: number,
	): GoalRecoveryRecord {
		if (!state?.enabled || state.goal.status !== "active")
			throw new Error("cannot recover blocked state because no active parent goal exists");
		if (state.runMode !== "awaiting-user-input")
			throw new Error("cannot recover blocked state unless goal is awaiting user input");
		const block = state.goal.currentBlockedState;
		if (block?.status !== "open") throw new Error("no current blocked state is recoverable");
		if (input.blockedStateId !== block.id)
			throw new Error(
				`blocked_state_id must equal currentBlockedState.id (${block.id}); got ${input.blockedStateId}`,
			);
		if (block.kind !== "checkpoint-external-pause")
			throw new Error("blocked state does not allow checkpoint recovery");
		if (input.checkpointId !== block.source.checkpointId)
			throw new Error(
				`checkpoint_id must equal blocked_state.source.checkpointId (${block.source.checkpointId}); got ${input.checkpointId}`,
			);
		if (input.checkpointResolutionId !== block.source.checkpointResolutionId)
			throw new Error(
				`checkpoint_resolution_id must equal blocked_state.source.checkpointResolutionId (${block.source.checkpointResolutionId}); got ${input.checkpointResolutionId}`,
			);
		if (state.goal.pendingCheckpointId)
			throw new Error("cannot recover checkpoint external pause while a checkpoint is pending resolution");
		const guidance = input.guidance.trim();
		if (!guidance) throw new Error("recover_blocked_state guidance must be non-empty");
		const sequence = nextRecoverySequence(state.goal);
		const recoveryId = `${state.goal.id}-recovery-${sequence}`;
		if (input.parentDelta) {
			const parentFrameChanged = parentDeltaHasFrameChanges(input.parentDelta);
			if (parentFrameChanged) {
				state.goal.parentFrame = this.#applyParentStateDeltaToFrame(state.goal, input.parentDelta, recoveryId);
			}
			if (parentDeltaHasDeliverableChanges(input.parentDelta)) {
				state.goal.deliverableMap = applyDeliverableDeltas(
					state.goal.deliverableMap,
					input.parentDelta.deliverableDeltas,
				);
			}
		}
		if (input.action === "start_next_target") {
			if (state.goal.currentTarget?.status === "active")
				throw new Error("cannot start next target while another target is active");
			const repair = state.goal.verificationRepair;
			if (repair?.blockers.length) {
				validateVerifierRepairLinks(
					input.nextTarget.linkedVerifierBlockerIds,
					repair.blockers,
					"start_next_target",
				);
			}
			const target = targetFromInput(
				state.goal,
				{
					...input.nextTarget,
					createdBy: "checkpoint-resolution",
					createdFromCheckpointId: input.checkpointId,
					createdFromVerificationAttemptId:
						input.nextTarget.createdFromVerificationAttemptId ?? repair?.verificationAttemptId,
				},
				nextTargetSequence(state.goal),
				input.parentDelta && parentDeltaHasFrameChanges(input.parentDelta)
					? state.parentFrameVersion + 1
					: state.parentFrameVersion,
				now,
				"checkpoint-resolution",
			);
			state.goal.currentTarget = target;
			this.#beginTargetPlanning(state, target);
		} else {
			if (state.goal.currentTarget?.status === "active")
				throw new Error("cannot enter parent completion while a target is active");
			if (state.goal.verificationRepair)
				throw new Error(
					"cannot select parent_completion_candidate until verifier blockers have fresh repair evidence",
				);
			if ("nextTarget" in input && input.nextTarget !== undefined) {
				throw new Error("next_target is not allowed when action is enter_parent_completion");
			}
			state.runMode = "awaiting-parent-completion";
		}
		const recovery: GoalRecoveryRecord = {
			id: recoveryId,
			sequence,
			blockedStateId: block.id,
			kind: block.kind,
			action: input.action,
			reason: input.reason,
			guidance,
			blockers: [...block.blockers],
			source: { ...block.source },
			result: {
				runMode: state.runMode,
				targetId: state.goal.currentTarget?.id,
				targetPlanId: state.goal.currentTargetPlan?.id,
				planFilePath: state.goal.currentTargetPlan?.planFilePath,
				checkpointResolutionId: input.checkpointResolutionId,
				parentFrameVersion:
					input.parentDelta && parentDeltaHasFrameChanges(input.parentDelta)
						? state.parentFrameVersion + 1
						: state.parentFrameVersion,
			},
			at: now,
		};
		this.#resolveBlockedState(state, block, recovery);
		return recovery;
	}

	async recoverBlockedState(input: GoalRecoverBlockedStateInput): Promise<GoalModeState> {
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			this.#assertFreshGoalMutationInput(state, input, "recover_blocked_state");
			const now = this.#now();
			let parentFrameChanged = false;
			if (input.kind === "target-plan") {
				this.#restartTargetPlanningFromBlockedState(state, input, now);
			} else {
				parentFrameChanged = input.parentDelta ? parentDeltaHasFrameChanges(input.parentDelta) : false;
				this.#recoverCheckpointExternalPause(state, input, now);
			}
			this.#bumpState(state, { parentFrameChanged });
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	async failCurrentTargetPlan(input: GoalTargetPlanFailureInput): Promise<GoalModeState> {
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.status !== "active")
				throw new Error("cannot fail target plan because no active parent goal exists");
			const target = state.goal.currentTarget;
			if (target?.status !== "active") throw new Error("cannot fail target plan without an active target");
			const plan = state.goal.currentTargetPlan;
			if (!plan) throw new Error("no current target plan is pending");
			if (plan.targetId !== target.id) throw new Error("current target plan is stale");
			const identity = currentTargetPlanSubmitIdentity(state);
			if (!identity) throw new Error("current target plan is stale");
			if (input.targetId !== identity.targetId)
				throw new Error(`target_id must equal currentTarget.id (${identity.targetId}); got ${input.targetId}`);
			if (input.targetPlanId !== identity.targetPlanId)
				throw new Error(
					`target_plan_id must equal currentTargetPlan.id (${identity.targetPlanId}); got ${input.targetPlanId}`,
				);
			if (input.revision !== identity.revision)
				throw new Error(
					`revision must equal currentTargetPlan.revision (${identity.revision}); got ${input.revision}`,
				);
			if (plan.status !== "drafting" && plan.status !== "revision-required") {
				throw new Error("target plan failure requires a draft or revision-required plan");
			}
			const now = this.#now();
			const failedPlan = this.#upsertTargetPlan(state, {
				...plan,
				status: "failed",
				updatedAt: now,
				failedAt: now,
				failure: {
					stage: "draft",
					reason: input.reason,
					message: input.message,
					blockers: [...input.blockers],
					suggestedQuestions: [...input.suggestedQuestions],
					at: now,
				},
			});
			target.planId = failedPlan.id;
			const sequence = nextBlockedStateSequence(state.goal);
			this.#enterBlockedState(state, {
				id: `${state.goal.id}-blocked-${sequence}`,
				sequence,
				kind: "target-plan",
				status: "open",
				message: input.message,
				blockers: [...input.blockers],
				suggestedQuestions: [...input.suggestedQuestions],
				allowedActions: ["restart_target_planning"],
				stateVersionAtBlock: state.stateVersion,
				parentFrameVersionAtBlock: state.parentFrameVersion,
				createdAt: now,
				updatedAt: now,
				source: {
					targetId: target.id,
					targetSequence: target.sequence,
					targetPlanId: failedPlan.id,
					revision: failedPlan.revision,
					status: "failed",
					planFilePath: failedPlan.planFilePath,
				},
			});
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	captureTargetPlanExpectation(): GoalTargetPlanExpectation | undefined {
		const state = this.#host.getState();
		const target = state?.goal.currentTarget;
		const plan = state?.goal.currentTargetPlan;
		if (!state?.goal || !target || !plan) return undefined;
		return {
			goalId: state.goal.id,
			stateVersion: state.stateVersion,
			currentTargetId: target.id,
			pendingCheckpointId: state.goal.pendingCheckpointId,
			parentFrameVersion: state.parentFrameVersion,
			targetPlanId: plan.id,
			targetSequence: target.sequence,
		};
	}

	canCommitTargetPlanResult(expected: GoalTargetPlanExpectation | undefined): boolean {
		if (!expected) return false;
		const latest = this.#host.getState();
		if (!latest?.goal || latest.goal.id !== expected.goalId) return false;
		if (latest.runMode !== "planning-target") return false;
		if (latest.stateVersion !== expected.stateVersion) return false;
		if (latest.parentFrameVersion !== expected.parentFrameVersion) return false;
		if (latest.goal.currentTarget?.id !== expected.currentTargetId) return false;
		if (latest.goal.currentTarget?.sequence !== expected.targetSequence) return false;
		if (latest.goal.currentTargetPlan?.id !== expected.targetPlanId) return false;
		if (latest.goal.pendingCheckpointId !== expected.pendingCheckpointId) return false;
		return true;
	}

	captureSideAgentExpectation(options?: { includeParentFrame?: boolean }): GoalSideAgentExpectation | undefined {
		const state = this.#host.getState();
		if (!state?.goal) return undefined;
		const expectation: GoalSideAgentExpectation = {
			goalId: state.goal.id,
			stateVersion: state.stateVersion,
			currentTargetId: state.goal.currentTarget?.id,
			pendingCheckpointId: state.goal.pendingCheckpointId,
			verificationAttemptId: state.goal.lastVerificationAttemptId,
			checkpointId: state.goal.pendingCheckpointId,
		};
		if (options?.includeParentFrame) expectation.parentFrameVersion = state.parentFrameVersion;
		return expectation;
	}

	canCommitSideAgentResult(expected: GoalSideAgentExpectation | undefined): boolean {
		if (!expected) return false;
		const latest = this.#host.getState();
		if (!latest?.goal || latest.goal.id !== expected.goalId) return false;
		if (latest.stateVersion !== expected.stateVersion) return false;
		if (latest.goal.currentTarget?.id !== expected.currentTargetId) return false;
		if (latest.goal.pendingCheckpointId !== expected.pendingCheckpointId) return false;
		if (expected.parentFrameVersion !== undefined && latest.parentFrameVersion !== expected.parentFrameVersion)
			return false;
		if (
			expected.verificationAttemptId !== undefined &&
			latest.goal.lastVerificationAttemptId !== expected.verificationAttemptId
		) {
			return false;
		}
		if (expected.checkpointId !== undefined && latest.goal.pendingCheckpointId !== expected.checkpointId)
			return false;
		return true;
	}

	buildActivePrompt(): string | undefined {
		const state = this.#host.getState();
		return state?.enabled && state.goal && state.goal.status === "active"
			? renderGoalPrompt("active", state.goal, state)
			: undefined;
	}

	buildContinuationPrompt(): string | undefined {
		const state = this.#host.getState();
		return state?.enabled && state.goal.status === "active"
			? renderGoalPrompt("continuation", state.goal, state)
			: undefined;
	}

	async #sendBudgetLimitSteer(goal: Goal): Promise<void> {
		if (this.#budgetReportedFor === goal.id) return;
		this.#budgetReportedFor = goal.id;
		await this.#host.sendHiddenMessage({
			customType: "goal-budget-limit",
			content: renderGoalPrompt("budget-limit", goal, this.#host.getState()),
			deliverAs: "steer",
		});
	}
}
