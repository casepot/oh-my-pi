import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import goalBudgetLimitPrompt from "../prompts/goals/goal-budget-limit.md" with { type: "text" };
import goalContinuationPrompt from "../prompts/goals/goal-continuation.md" with { type: "text" };
import goalModeActivePrompt from "../prompts/goals/goal-mode-active.md" with { type: "text" };
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
	GoalDeliverableDelta,
	GoalDeliverableMapItem,
	GoalModeState,
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
	GoalTargetPlanFailureReason,
	GoalTargetPlanLintDiagnostic,
	GoalTargetPlanLintResult,
	GoalTargetPlanRecord,
	GoalTargetPlanReview,
	GoalTargetUnitRule,
	GoalTokenUsage,
	GoalVerificationAperture,
	GoalVerificationAttempt,
	GoalVerificationGap,
	GoalVerificationRepairState,
	GoalVerificationSignal,
	GoalVerificationStatus,
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
	upsertBlockedState,
	upsertRecoveryRecord,
} from "./state";
import { collectTargetPlanGraphDiagnostics, lintDiagnostic } from "./target-plan-lint";

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
	persist(mode: "goal" | "goal_paused" | "none", state?: GoalModeState, reason?: GoalPersistenceReason): void;
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
	workflowReviewRounds: GoalTargetPlanWorkflowReviewRound[];
	dryRun: GoalTargetPlanDryRun;
}

export interface GoalTargetPlanWorkflowReviewRound {
	lens: string;
	verdict: "accepted" | "revision-required";
	summary: string;
	blockers: string[];
	revised: boolean;
}

export interface GoalTargetPlanDryRun {
	status: "passed" | "failed";
	checks: Array<{ id: string; passed: boolean; rationale: string }>;
}

export interface GoalTargetPlanExpectation extends GoalSideAgentExpectation {
	targetPlanId: string;
	targetSequence: number;
}

export interface GoalTargetPlanApprovalInput extends GoalSubmitTargetPlanInput {
	reviews: GoalTargetPlanReview[];
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
			checkpointId: string;
			checkpointResolutionId: string;
			reason: GoalRecoveryReason;
			guidance: string;
			parentDelta?: GoalParentStateDelta;
	  };
export interface GoalCheckpointResolutionInput {
	checkpointId: string;
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

export function escapeXmlText(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else output += char;
	}
	return output;
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
	return refs?.map(ref => ref.id) ?? [];
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
		evidence: checkpoint.evidence.map(item => ({
			claim: item.claim,
			evidence: item.evidence,
			current: item.current,
		})),
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
					evidenceChecked: checkpoint.review.evidenceChecked.map(item => ({
						claim: item.claim,
						current: item.current,
					})),
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
		failure: plan.failure,
		recoveredFrom: plan.recoveredFrom,
		requiredAction:
			plan.status === "failed" || plan.status === "stale"
				? "recover_blocked_state_after_input_or_refresh"
				: "draft_review_submit_target_plan",
	};
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
	if (runMode === "working-target") {
		surface.current_target = compactTargetForPrompt(currentTarget);
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
		currentTargetId: goal.currentTarget?.id,
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
				"Draft/revise the current target plan",
				"Use read-only task discovery and review",
				"Create missing target-plan files; edit existing plan and payload sidecar in place",
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
				"Run mutating commands",
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
	const blockers = plan.reviews.flatMap(review =>
		review.findings
			.filter(finding => finding.severity === "blocking" || finding.severity === "important")
			.map(finding => `${review.lens}:${finding.id}: ${finding.requiredRevision}`),
	);
	return blockers.length ? blockers : [`target plan is ${plan.status}`];
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
			this.#host.persist(options.persist, state, reason);
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

	#markActiveAccounting(goal: Goal): void {
		if (this.#wallClock.activeGoalId !== goal.id) {
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
			await this.#flushUsageLocked("suppressed");
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

	async onThreadResumed(): Promise<GoalModeState | undefined> {
		const state = this.#getStateClone();
		if (!state) return undefined;
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
			if (tokenDelta > 0) {
				this.#host.persistUsage?.({
					goalId: state.goal.id,
					stateVersion: state.stateVersion,
					tokenDelta,
					wallSeconds,
					tokensUsed: state.goal.tokensUsed,
					timeUsedSeconds: state.goal.timeUsedSeconds,
					updatedAt: state.goal.updatedAt,
				});
			}
			await this.#commitState(state);
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
		const packet: GoalCheckpointPacket = {
			id: `${state.goal.id}-checkpoint-${sequence}`,
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
			evidence: input.evidence.map(item => ({
				claim: trimmed(item.claim, "evidence[].claim"),
				evidence: trimmed(item.evidence, "evidence[].evidence"),
				current: item.current,
			})),
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
			const closedTarget: GoalTarget = { ...target, status: "closed", closedAt: this.#now() };
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
			if (input.decision === "next_target" && !input.nextTarget) {
				throw new Error("next_target is required when decision is next_target");
			}
			const repair = state.goal.verificationRepair;
			if (repair && input.decision === "parent_completion_candidate") {
				throw new Error(
					"cannot select parent_completion_candidate until verifier blockers have fresh repair evidence",
				);
			}
			const sequence = nextResolutionSequence(state.goal);
			const resolutionId = `${state.goal.id}-checkpoint-resolution-${sequence}`;
			let parentFrameChanged = false;
			if (input.parentDelta) {
				parentFrameChanged = parentDeltaHasFrameChanges(input.parentDelta);
				if (parentFrameChanged) {
					state.goal.parentFrame = this.#applyParentStateDeltaToFrame(state.goal, input.parentDelta, resolutionId);
				}
				if (parentDeltaHasDeliverableChanges(input.parentDelta)) {
					state.goal.deliverableMap = applyDeliverableDeltas(
						state.goal.deliverableMap,
						input.parentDelta.deliverableDeltas,
					);
				}
			}
			let nextTarget: GoalTarget | undefined;
			let runMode: GoalRunMode = "awaiting-user-input";
			if (input.decision === "next_target") {
				const nextTargetInput = input.nextTarget as GoalStartTargetInput;
				if (repair?.blockers.length) {
					validateVerifierRepairLinks(nextTargetInput.linkedVerifierBlockerIds, repair.blockers, "next_target");
				}
				nextTarget = targetFromInput(
					state.goal,
					{
						...nextTargetInput,
						createdBy: "checkpoint-resolution",
						createdFromCheckpointId: input.checkpointId,
						createdFromVerificationAttemptId:
							nextTargetInput.createdFromVerificationAttemptId ?? repair?.verificationAttemptId,
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
				parentDelta: input.parentDelta,
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
				status: "approved",
				updatedAt: now,
				approvedAt: now,
				failure: undefined,
				reviews: this.#mergeTargetPlanReviews(submittedPlan, input.reviews),
			});
			if (!approvedPlan) throw new Error("target plan approval record is invalid");
			const target = {
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
			};
			state.goal.currentTarget = target;
			state.goal.targets = upsertById(state.goal.targets ?? [], [target]);
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
			if (input.stage === "stale" && (input.revision === undefined || input.revision === currentPlan.revision)) {
				nextPlan = {
					...currentPlan,
					status: "stale",
					updatedAt: now,
					reviews,
				};
				state.runMode = "awaiting-user-input";
			} else if (currentPlan.revision >= TARGET_PLAN_REJECTION_CAP) {
				const reviewerBlockers = reviews.flatMap(review =>
					review.findings
						.filter(finding => finding.severity === "blocking" || finding.severity === "important")
						.map(finding => `${review.lens}:${finding.id}: ${finding.requiredRevision}`),
				);
				nextPlan = {
					...currentPlan,
					status: "failed",
					updatedAt: now,
					failedAt: now,
					failure: {
						stage: input.stage,
						reason: "review-rejection-cap",
						message: input.message,
						blockers: reviewerBlockers.length ? reviewerBlockers : [input.message],
						suggestedQuestions: [
							"Clarify the right-sized product signal for this target.",
							"Identify which related same-signal work must be included before execution.",
						],
						at: now,
					},
					reviews,
				};
				state.runMode = "awaiting-user-input";
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
			if (
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
		const sequence = nextRecoverySequence(state.goal);
		const recoveryId = `${state.goal.id}-recovery-${sequence}`;
		const attempt = nextTargetPlanAttempt(state.goal, target);
		const planId = `${target.id}-plan-attempt-${attempt}`;
		const planFilePath = `local://goal-${sanitizeGoalPlanSlug(state.goal.id)}-target-${target.sequence}-plan-attempt-${attempt}.md`;
		const recoveryLink: GoalRecoveryLink = {
			recoveryId,
			blockedStateId: block.id,
			kind: block.kind,
			action: input.action,
			reason: input.reason,
			guidance,
			blockers: [...block.blockers],
			at: now,
		};
		const recoveredPlan: GoalTargetPlanRecord = {
			id: planId,
			goalId: state.goal.id,
			targetId: target.id,
			targetSequence: target.sequence,
			planFilePath,
			status: "drafting",
			revision: 1,
			stateVersionAtStart: state.stateVersion,
			parentFrameVersionAtStart: target.parentFrameVersion ?? state.parentFrameVersion,
			createdAt: now,
			updatedAt: now,
			recoveredFrom: recoveryLink,
			reviews: [],
		};
		this.#upsertTargetPlan(state, recoveredPlan);
		const recoveredTarget = { ...target, planId: recoveredPlan.id };
		state.goal.currentTarget = recoveredTarget;
		state.goal.targets = upsertById(state.goal.targets ?? [], [recoveredTarget]);
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
				runMode: "planning-target",
				targetId: target.id,
				targetPlanId: recoveredPlan.id,
				planFilePath: recoveredPlan.planFilePath,
			},
			at: now,
		};
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
			const now = this.#now();
			let parentFrameChanged = false;
			if (input.kind === "target-plan") {
				this.#restartTargetPlanningFromBlockedState(state, input, now);
			} else {
				parentFrameChanged = input.parentDelta ? parentDeltaHasFrameChanges(input.parentDelta) : false;
				this.#recoverCheckpointExternalPause(state, input, now);
			}
			if (!state) throw new Error("cannot recover blocked state because no active parent goal exists");
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
