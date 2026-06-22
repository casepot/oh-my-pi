import type { UsageStatistics } from "../session/session-entries";

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";
export type GoalVerificationStatus = "verified" | "rejected" | "stale" | "max-attempts";
export type GoalVerificationGateStatus = "passed" | "failed" | "unknown";
export type GoalVerificationGapSeverity = "blocking" | "important" | "polish";
export type GoalModeLifecycle = "active" | "exiting";
export type GoalRunMode =
	| "working-target"
	| "planning-target"
	| "completed"
	| "awaiting-checkpoint-resolution"
	| "awaiting-parent-completion"
	| "awaiting-verification-repair"
	| "awaiting-user-input";
export const GOAL_MODE_SCHEMA_VERSION = 5;
export type GoalDeliverableStatus = "pending" | "partial" | "satisfied" | "blocked" | "stale";

export type GoalTargetPlanStatus = "drafting" | "reviewing" | "revision-required" | "approved" | "failed" | "stale";
export type GoalTargetPlanReviewStatus = "accepted" | "rejected" | "failed" | "stale";
export type GoalTargetPlanReviewLens = "aperture" | "execution-readiness";
export type GoalApertureClassification = "right-sized" | "too-narrow" | "too-broad" | "stale" | "unclear";
export type GoalTargetPlanRevisionDecision =
	| "keep"
	| "merge-required"
	| "split-required"
	| "rescope-required"
	| "refresh-intention"
	| "needs-user-input";
export type GoalTargetPlanFailureReason =
	| "needs-user-input"
	| "task-unavailable"
	| "external-authority"
	| "unable-to-find-right-sized-target"
	| "review-rejection-cap";
export type GoalVerificationLayer = "unit" | "integration" | "e2e" | "manual" | "product" | "release-gate";
export type GoalSignalRole = "primary" | "supporting" | "guardrail";
export type GoalSignalConfidence = "low" | "medium" | "high";
export type GoalBlastRadius = "local" | "module" | "workflow" | "multi-subsystem" | "external-or-irreversible";
export type GoalConcernKind =
	| "behavior"
	| "contract"
	| "state-persistence"
	| "error-handling"
	| "security"
	| "performance"
	| "migration"
	| "ux-manual"
	| "docs-or-operator";
export type GoalExcludedWorkClassification =
	| "valid-boundary"
	| "parent-non-claim"
	| "essential-related-work"
	| "stale-or-unsupported";

export type GoalTargetPlanDepth = "light" | "standard" | "trust-heavy";

export interface GoalScenarioMatrixRow {
	id: string;
	branch: string;
	signalIds: string[];
	concernIds: string[];
	acceptance: string;
	expectedOutcome: string;
	staleIf: string[];
}

export interface GoalScenarioMatrixOpenRow {
	id: string;
	branch: string;
	reason:
		| "different-primary-signal"
		| "different-authority"
		| "different-blast-radius"
		| "blocked-external"
		| "non-goal"
		| "unsafe-to-bundle";
	rationale?: string;
	followUpHint: string;
}

export interface GoalScenarioMatrix {
	id: string;
	primarySignalGroupId: string;
	rowsInScope: GoalScenarioMatrixRow[];
	rowsLeftOpen: GoalScenarioMatrixOpenRow[];
	splittingSafety: {
		safe: boolean;
		rationale: string;
	};
	nextLargerTarget?: {
		title: string;
		primarySignalGroupId: string;
		rows: string[];
		unblocksMatrixId?: string;
	};
}

export interface GoalTargetWorkstream {
	id: string;
	label: string;
	kind: "main" | "backend-rust" | "app-ui" | "e2e-harness" | "docs-changelog" | "other";
	role?: string;
	files: string[];
	contractInputs: string[];
	contractOutputs: string[];
}

export interface GoalTargetCard {
	capabilityClaim: string;
	trustPrivacyClaim?: string;
	confidenceEarned?: string;
	knownLimits: string[];
	authorityBoundary?: string;
	policyDeletionImplications?: string;
	userVisibleSurface: string;
	acceptanceRows: {
		closed: string[];
		open: string[];
	};
	workstreams?: GoalTargetWorkstream[];
	sharedContract?: string;
	reviewLenses?: string[];
	verificationScenarios: string[];
	checkpointEvidence: string[];
	rollbackCutover?: string;
}

export type GoalTargetUnitRuleKind =
	| "complete-acceptance-slice"
	| "scenario-matrix"
	| "gate-prerequisite"
	| "no-process-phase"
	| "same-primary-signal-together"
	| "branch-unblocks-matrix";

export interface GoalTargetUnitRule {
	id: string;
	kind: GoalTargetUnitRuleKind;
	statement: string;
	source: "rubric" | "checkpoint-guidance" | "operator" | "built-in";
	enforcement: "error" | "warning";
}

export interface GoalVerificationEvidenceItem {
	claim: string;
	evidence: string;
	current: boolean;
}

export interface GoalVerificationDeliverableResult {
	id: string;
	status: GoalVerificationGateStatus;
	rationale: string;
	evidence?: GoalVerificationEvidenceItem[];
}

export interface GoalVerificationGap {
	id: string;
	deliverableId?: string;
	severity: GoalVerificationGapSeverity;
	problem: string;
	requiredEvidenceOrFix: string;
}

export interface GoalContinuationFocus {
	openGaps: string[];
	nextActions: string[];
	evidenceToCollect: string[];
	avoidRepeating?: string[];
}

export interface GoalCompletionVerifierStructuredOutput {
	summary: string;
	score: number;
	deliverableResults: GoalVerificationDeliverableResult[];
	evidenceChecked: GoalVerificationEvidenceItem[];
	completionBlockers: GoalVerificationGap[];
	continuationFocus?: GoalContinuationFocus;
}

export interface GoalVerificationAttempt {
	id: string;
	sequence: number;
	attempt: number;
	maxAttempts: number;
	status: GoalVerificationStatus;
	feedback: string;
	structuredFeedback?: GoalCompletionVerifierStructuredOutput;
	compactorMemo?: string;
	createdAt: number;
	workEpoch: number;
	sideAgentTokensUsed?: number;
}

export type GoalParentFrameKind = "plain" | "claim-gated";

export type GoalRefKind = "doc" | "issue" | "artifact" | "test" | "commit" | "external-record" | "other";

export interface GoalRef {
	id: string;
	kind: GoalRefKind;
	label?: string;
	uri?: string;
}

export interface GoalDeliverableMapItem {
	id: string;
	summary: string;
	status: GoalDeliverableStatus;
	evidenceRefs?: GoalRef[];
	blockedBy?: string[];
	nextRelevantTarget?: string;
}

export interface GoalDeliverableDelta {
	id: string;
	summary?: string;
	status?: GoalDeliverableStatus;
	evidenceRefs?: GoalRef[];
	blockedBy?: string[];
	nextRelevantTarget?: string;
}

export type GoalClaimStatus = "accepted" | "candidate" | "rejected" | "stale";

export interface GoalClaim {
	id: string;
	claim: string;
	status: GoalClaimStatus;
	scope?: string;
	evidenceRefs?: GoalRef[];
	nonImplications?: string[];
	acceptedBy?: string;
	acceptedAt?: number;
}

export type GoalBoundaryKind =
	| "non-claim"
	| "forbidden-inference"
	| "unsupported"
	| "local-only"
	| "mock-only"
	| "unavailable"
	| "stale-path";

export interface GoalBoundary {
	id: string;
	kind: GoalBoundaryKind;
	statement: string;
	refs?: GoalRef[];
}

export type GoalResidualClassification =
	| "current-parent-blocker"
	| "accepted-risk"
	| "future-frontier"
	| "decision-needed"
	| "architecture-debt"
	| "anti-laundering-non-claim"
	| "local-shortcut"
	| "capability-gap"
	| "rejected-or-stale-path"
	| "unspecified";

export interface GoalResidual {
	id: string;
	statement: string;
	classification: GoalResidualClassification;
	whyItMatters?: string;
	requiredEvidence?: string[];
	targetHorizon?: string;
	authorityRequired?: string;
	nonImplications?: string[];
	refs?: GoalRef[];
}

export type GoalGateStatus = "unknown" | "passed" | "failed" | "stale" | "not-applicable";

export interface GoalGate {
	id: string;
	name: string;
	status: GoalGateStatus;
	requiredEvidence: string[];
	evidenceRefs?: GoalRef[];
	nonClaims?: string[];
	staleIf?: string[];
}

export interface GoalAuthorityState {
	parentStateAuthority?: string;
	riskAcceptanceAuthority?: string;
	externalRecordAuthority?: string;
	workerMayOnlyPropose?: boolean;
}

export interface GoalFrontierItem {
	id: string;
	statement: string;
	evidenceRequired?: string[];
	activationTrigger?: string;
	refs?: GoalRef[];
}

export interface GoalParentFrame {
	kind: GoalParentFrameKind;
	desiredFuture: string;
	currentTruth?: string;
	baselineRefs: GoalRef[];
	acceptedClaims: GoalClaim[];
	candidateClaims: GoalClaim[];
	rejectedOrStaleClaims: GoalClaim[];
	boundaries: GoalBoundary[];
	residuals: GoalResidual[];
	gates: GoalGate[];
	frontier: GoalFrontierItem[];
	staleIf: string[];
	authority?: GoalAuthorityState;
	externalRefs: GoalRef[];
	lastParentDeltaId?: string;
}

export interface GoalVerificationSignal {
	id: string;
	role: GoalSignalRole;
	layer: GoalVerificationLayer;
	concernIds: string[];
	claim: string;
	observation: string;
	method: string;
	expectedOutcome: string;
	required: boolean;
	confidenceIfSatisfied: GoalSignalConfidence;
	confidenceRationale?: string;
	staleIf: string[];
}

export interface GoalConcernCheck {
	id: string;
	kind: GoalConcernKind;
	whyIndependent: string;
	lens?: string;
	coveredBySignalIds: string[];
}

export interface GoalVerificationAperture {
	productIntention: string;
	primarySignalId: string;
	blastRadius: GoalBlastRadius;
	confidenceTarget: GoalSignalConfidence;
	blastRadiusScope?: string;
	layerRationale: string;
	confidenceRationale?: string;
	residualUncertainty: string[];
	omittedLayers: Array<{ layer: GoalVerificationLayer; reason: string }>;
}

export interface GoalScopeCalibration {
	rightSizingBasis: "product-signal" | "minimum-domain-unit" | "verifier-repair" | "external-authority-slice";
	rightSizingRationale?: string;
	whyNotSmaller: string[];
	whyNotLarger: string[];
	includedRelatedWork: Array<{ item: string; reason: string; signalIds: string[] }>;
	deferredRelatedWork: Array<{
		item: string;
		reason:
			| "different-primary-signal"
			| "different-authority"
			| "different-blast-radius"
			| "blocked-external"
			| "non-goal";
		followUpHint?: string;
		rationale?: string;
	}>;
	targetUnitRuleIds?: string[];
	targetUnitExemptions?: Array<{ ruleId: string; rationale: string }>;
}

export interface GoalTargetPlanExcludedWorkReview {
	item: string;
	classification: GoalExcludedWorkClassification;
	rationale: string;
}

export interface GoalTargetPlanBranchEvidence {
	branch: string;
	required: boolean;
	plannedSignalIds: string[];
	rowIds?: string[];
	rationale: string;
}

export interface GoalTargetPlanReviewScore {
	productSignal: number;
	relatedWorkBundling: number;
	concernCohesion: number;
	verificationAperture: number;
	blastRadiusCoverage: number;
	parentUncertaintyReduction: number;
	antiGaming: number;
}

export interface GoalTargetPlanReviewFinding {
	id: string;
	severity: GoalVerificationGapSeverity;
	problem: string;
	requiredRevision: string;
	supportingEvidence?: string;
}

export interface GoalTargetPlanReview {
	id: string;
	lens: GoalTargetPlanReviewLens;
	status: GoalTargetPlanReviewStatus;
	feedback: string;
	apertureClassification?: GoalApertureClassification;
	revisionDecision?: GoalTargetPlanRevisionDecision;
	scores?: GoalTargetPlanReviewScore;
	findings: GoalTargetPlanReviewFinding[];
	reviewedAt: number;
	sideAgentTokensUsed?: number;
}

export interface GoalTargetPlanFailure {
	stage: "draft" | "review" | "approval" | "stale";
	reason: GoalTargetPlanFailureReason;
	message: string;
	blockers: string[];
	suggestedQuestions: string[];
	at: number;
}

export type GoalBlockedStateKind = "target-plan" | "checkpoint-external-pause" | "operator-input-required";
export type GoalBlockedStateStatus = "open" | "resolved" | "superseded";
export type GoalRecoveryReason = "user-input" | "broader-checks" | "external-authority" | "state-refresh";
export type GoalBlockedStateAction = "restart_target_planning" | "start_next_target" | "enter_parent_completion";

export interface GoalBlockedStateBase {
	id: string;
	sequence: number;
	kind: GoalBlockedStateKind;
	status: GoalBlockedStateStatus;
	message: string;
	blockers: string[];
	suggestedQuestions: string[];
	allowedActions: GoalBlockedStateAction[];
	stateVersionAtBlock: number;
	parentFrameVersionAtBlock: number;
	createdAt: number;
	updatedAt: number;
	resolvedAt?: number;
	recoveryId?: string;
	supersededAt?: number;
	supersededBy?: string;
}

export interface GoalTargetPlanBlockedState extends GoalBlockedStateBase {
	kind: "target-plan";
	source: {
		targetId: string;
		targetSequence: number;
		targetPlanId: string;
		revision: number;
		status: "failed" | "stale";
		planFilePath: string;
	};
	allowedActions: ["restart_target_planning"];
}

export interface GoalCheckpointExternalPauseBlockedState extends GoalBlockedStateBase {
	kind: "checkpoint-external-pause";
	source: {
		checkpointId: string;
		checkpointResolutionId: string;
		decision:
			| "needs_user_input"
			| "needs_broader_checks"
			| "pause_for_external_control"
			| "drop_or_replace_recommended";
	};
	broaderChecksOrInputs: string[];
	remainingParentWork: string[];
	allowedActions: Array<"start_next_target" | "enter_parent_completion">;
}

export interface GoalOperatorInputBlockedState extends GoalBlockedStateBase {
	kind: "operator-input-required";
	source: {
		reason: "legacy-migration" | "ambiguous-controller-state";
	};
	allowedActions: [];
}

export type GoalBlockedState =
	| GoalTargetPlanBlockedState
	| GoalCheckpointExternalPauseBlockedState
	| GoalOperatorInputBlockedState;

export type GoalBlockedStateSource = GoalBlockedState["source"];

export interface GoalRecoveryResultSummary {
	runMode: GoalRunMode;
	targetId?: string;
	targetPlanId?: string;
	planFilePath?: string;
	checkpointResolutionId?: string;
	parentFrameVersion?: number;
}

export interface GoalRecoveryRecord {
	id: string;
	sequence: number;
	blockedStateId: string;
	kind: GoalBlockedStateKind;
	action: GoalBlockedStateAction;
	reason: GoalRecoveryReason;
	guidance: string;
	blockers: string[];
	source: GoalBlockedStateSource;
	result: GoalRecoveryResultSummary;
	at: number;
}

export interface GoalRecoveryLink {
	recoveryId: string;
	blockedStateId: string;
	kind: GoalBlockedStateKind;
	action: GoalBlockedStateAction;
	reason: GoalRecoveryReason;
	guidance: string;
	blockers: string[];
	at: number;
}

export interface GoalTargetPlanExecutionSignalSummary {
	id: string;
	role: GoalSignalRole;
	layer: GoalVerificationLayer;
	claim: string;
	method: string;
	expectedOutcome: string;
	confidenceRationale?: string;
	staleIf: string[];
}

export interface GoalTargetPlanExecutionScenarioSummary {
	id: string;
	branch: string;
	signalIds: string[];
	acceptance: string;
	expectedOutcome: string;
	staleIf: string[];
}

export interface GoalTargetPlanExecutionOpenScenarioSummary {
	id: string;
	branch: string;
	reason: GoalScenarioMatrixOpenRow["reason"];
	rationale?: string;
	followUpHint: string;
}

export interface GoalTargetPlanExecutionExcludedWorkSummary {
	item: string;
	classification: GoalExcludedWorkClassification;
	rationale: string;
}

export interface GoalTargetPlanExecutionSummary {
	targetId: string;
	targetPlanId: string;
	planFilePath: string;
	payloadFilePath: string;
	revision: number;
	targetTitle?: string;
	desiredFutureClaim?: string;
	closureStandard?: string;
	capabilityClaim?: string;
	userVisibleSurface?: string;
	planDepth?: GoalTargetPlanDepth;
	primarySignalGroupId?: string;
	implementationFanoutRequired?: boolean;
	implementationFiles: string[];
	workstreams?: Array<
		Pick<GoalTargetWorkstream, "id" | "label" | "kind" | "role" | "files" | "contractInputs" | "contractOutputs">
	>;
	sharedContract?: string;
	acceptanceRows?: GoalTargetCard["acceptanceRows"];
	verificationAperture?: GoalVerificationAperture;
	concernChecks?: GoalConcernCheck[];
	scopeCalibration?: GoalScopeCalibration;
	branchEvidence?: GoalTargetPlanBranchEvidence[];
	requiredSignals: GoalTargetPlanExecutionSignalSummary[];
	scenarioRowsInScope?: GoalTargetPlanExecutionScenarioSummary[];
	scenarioRowsLeftOpen?: GoalTargetPlanExecutionOpenScenarioSummary[];
	excludedWork: GoalTargetPlanExecutionExcludedWorkSummary[];
	nonGoals: string[];
	forbiddenClaims: string[];
	knownLimits: string[];
	checkpointEvidence: string[];
	staleIf: string[];
	readPlanFileWhen: string;
}

export interface GoalTargetPlanRecord {
	id: string;
	goalId: string;
	targetId: string;
	targetSequence: number;
	planFilePath: string;
	status: GoalTargetPlanStatus;
	revision: number;
	stateVersionAtStart: number;
	parentFrameVersionAtStart: number;
	createdAt: number;
	updatedAt: number;
	approvedAt?: number;
	failedAt?: number;
	failure?: GoalTargetPlanFailure;
	recoveredFrom?: GoalRecoveryLink;
	verificationAperture?: GoalVerificationAperture;
	verificationSignals?: GoalVerificationSignal[];
	concernChecks?: GoalConcernCheck[];
	scopeCalibration?: GoalScopeCalibration;
	branchEvidence?: GoalTargetPlanBranchEvidence[];
	excludedWorkReview?: GoalTargetPlanExcludedWorkReview[];
	planDepth?: GoalTargetPlanDepth;
	primarySignalGroupId?: string;
	scenarioMatrix?: GoalScenarioMatrix;
	targetCard?: GoalTargetCard;
	reviews: GoalTargetPlanReview[];
}

export interface GoalTarget {
	id: string;
	parentDeliverableIds?: string[];
	sequence: number;
	status: "active" | "closed" | "superseded";
	title: string;
	desiredFutureClaim: string;
	closureStandard: string;
	expectedParentContribution?: string;
	parentFrameVersion?: number;
	baselineRefs: GoalRef[];
	gateRefs: string[];
	evidenceExpectation: string[];
	nonGoals: string[];
	forbiddenClaims: string[];
	staleIf: string[];
	createdAt: number;
	closedAt?: number;
	createdBy: "initial" | "checkpoint-resolution" | "verification-repair" | "retrospective" | "operator";
	createdFromCheckpointId?: string;
	createdFromVerificationAttemptId?: string;
	linkedVerifierBlockerIds?: string[];
	planId?: string;
	verificationAperture?: GoalVerificationAperture;
	verificationSignals?: GoalVerificationSignal[];
	concernChecks?: GoalConcernCheck[];
	scopeCalibration?: GoalScopeCalibration;
	planDepth?: GoalTargetPlanDepth;
	primarySignalGroupId?: string;
	scenarioMatrix?: GoalScenarioMatrix;
	targetCard?: GoalTargetCard;
}

export interface GoalCheckpointEvidenceItem {
	claim: string;
	evidence: string;
	current: boolean;
}

export type GoalCheckpointStatus = "closed_with_evidence";

export interface GoalCheckpointReview {
	status: "accepted" | "rejected";
	feedback: string;
	evidenceChecked: GoalCheckpointEvidenceItem[];
	blockers: GoalVerificationGap[];
	continuationFocus?: GoalContinuationFocus;
	reviewedAt: number;
	sideAgentTokensUsed?: number;
}

export interface GoalCheckpointPacket {
	id: string;
	sequence: number;
	goalId: string;
	targetId: string;
	targetSnapshot: GoalTarget;
	parentFrameVersion: number;
	baselineRefs: GoalRef[];
	gateRefs: string[];
	workEpoch: number;
	status: GoalCheckpointStatus;
	summary: string;
	localClaims: string[];
	evidence: GoalCheckpointEvidenceItem[];
	checksRun: string[];
	artifactsTouched: string[];
	notClaimed: string[];
	remainingQuestions: string[];
	risksOrCaveats: string[];
	staleIf: string[];
	suggestedControllerQuestions: string[];
	createdAt: number;
	review?: GoalCheckpointReview;
}

export interface GoalCheckpointRejection {
	candidateSummary: string;
	review: GoalCheckpointReview;
	createdAt: number;
}

export type GoalCheckpointResolutionDecision =
	| "next_target"
	| "parent_completion_candidate"
	| "needs_user_input"
	| "needs_broader_checks"
	| "pause_for_external_control"
	| "drop_or_replace_recommended";

export interface GoalGateDelta {
	gateId: string;
	status: GoalGateStatus;
	evidenceRefs?: GoalRef[];
	rationale?: string;
}

export interface GoalParentStateDelta {
	admittedClaims: GoalClaim[];
	candidateClaimsAdded: GoalClaim[];
	rejectedClaims: GoalClaim[];
	boundariesAdded: GoalBoundary[];
	residualsAddedOrUpdated: GoalResidual[];
	gateDeltas: GoalGateDelta[];
	frontierDeltas: GoalFrontierItem[];
	staleRefs: GoalRef[];
	externalRecordRefs: GoalRef[];
	authorityDecisionRefs?: GoalRef[];
	deliverableDeltas?: GoalDeliverableDelta[];
}

export interface GoalCheckpointResolution {
	id: string;
	sequence: number;
	goalId: string;
	checkpointId: string;
	decision: GoalCheckpointResolutionDecision;
	parentReading: string;
	parentDelta?: GoalParentStateDelta;
	notPropagated: string[];
	remainingParentWork: string[];
	broaderChecksOrInputs: string[];
	lessonsForFuture: string[];
	nextTarget?: GoalTarget;
	createdAt: number;
}

export interface GoalVerificationRepairState {
	verificationAttemptId: string;
	feedback: string;
	blockers: GoalVerificationGap[];
	evidenceToCollect: string[];
	avoidRepeating: string[];
	createdAt: number;
	workEpoch: number;
}

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
	rubric?: string;
	deliverableMap?: GoalDeliverableMapItem[];
	workEpoch?: number;
	totalVerificationAttempts?: number;
	verificationAttempts?: GoalVerificationAttempt[];
	failedCompletionAttempts?: number;
	lastVerificationFeedback?: string;
	lastVerificationCompactorMemo?: string;
	lastVerificationAttempt?: number;
	lastVerificationAttemptId?: string;
	parentFrame?: GoalParentFrame;
	currentTarget?: GoalTarget;
	targets?: GoalTarget[];
	currentTargetPlan?: GoalTargetPlanRecord;
	targetPlans?: GoalTargetPlanRecord[];
	targetUnitRules?: GoalTargetUnitRule[];
	checkpoints?: GoalCheckpointPacket[];
	pendingCheckpointId?: string;
	checkpointResolutions?: GoalCheckpointResolution[];
	lastCheckpointResolutionId?: string;
	lastCheckpointRejection?: GoalCheckpointRejection;
	verificationRepair?: GoalVerificationRepairState;
	currentBlockedState?: GoalBlockedState;
	blockedStates?: GoalBlockedState[];
	recoveryHistory?: GoalRecoveryRecord[];
}

export interface GoalModeState {
	enabled: boolean;
	mode: GoalModeLifecycle;
	runMode: GoalRunMode;
	reason?: "completed";
	stateVersion: number;
	parentFrameVersion: number;
	goal: Goal;
}

export interface SerializedGoalModeState extends Record<string, unknown> {
	schemaVersion: typeof GOAL_MODE_SCHEMA_VERSION;
	enabled: boolean;
	mode: GoalModeLifecycle;
	runMode: GoalRunMode;
	reason?: "completed";
	stateVersion: number;
	parentFrameVersion: number;
	goal: Goal;
}

export interface GoalCompletionVerificationDetails {
	status: "verified" | "rejected";
	attempt: number;
	maxAttempts: number;
	totalAttempts?: number;
	feedback: string;
	structuredFeedback?: GoalCompletionVerifierStructuredOutput;
	compactorMemo?: string;
	/** Legacy/compatibility field; visible renderers must never contain a hidden prepared continuation prompt. */
	continuationMessage?: string;
}

export interface GoalTargetPlanApprovedDetails {
	goalId: string;
	targetId: string;
	targetPlanId: string;
	planFilePath: string;
	payloadFilePath: string;
	title: string;
	revision?: number;
	planHash?: string;
	planBytes?: number;
	stateVersionAtApproval?: number;
	parentFrameVersionAtApproval?: number;
	planDepth?: GoalTargetPlanDepth;
	primarySignalGroupId?: string;
	matrixRowCounts?: { inScope: number; leftOpen: number };
	implementationFanoutRequired?: boolean;
	workstreamSummary?: Array<Pick<GoalTargetWorkstream, "id" | "label" | "kind" | "role" | "files">>;
	executionSummary?: GoalTargetPlanExecutionSummary;
}

export interface GoalToolTargetPlanReviewSummary {
	lens: GoalTargetPlanReviewLens;
	status: GoalTargetPlanReviewStatus;
	feedback: string;
	findingCount: number;
	blockingFindingCount: number;
}

export interface GoalToolTargetPlanSummary {
	id: string;
	targetPlanId: string;
	targetId: string;
	planFilePath: string;
	status: GoalTargetPlanStatus;
	revision: number;
	reviews: GoalToolTargetPlanReviewSummary[];
	failure?: Pick<GoalTargetPlanFailure, "stage" | "reason" | "message" | "blockers">;
	recoveredFrom?: GoalRecoveryLink;
	planDepth?: GoalTargetPlanDepth;
	primarySignalGroupId?: string;
	matrixRowCounts?: { inScope: number; leftOpen: number };
	implementationFanoutRequired?: boolean;
	lintSummary?: { errorCount: number; warningCount: number };
}

export interface GoalToolTargetSummary {
	id: string;
	title: string;
	status: GoalTarget["status"];
}

export interface GoalToolGoalSummary {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	currentTarget?: GoalToolTargetSummary;
	pendingCheckpointId?: string;
	pendingCheckpointRequiresResolution: boolean;
}

export interface GoalToolStateSummary {
	enabled: boolean;
	runMode: GoalRunMode;
	stateVersion: number;
	parentFrameVersion: number;
	goalId: string;
}

export interface GoalToolCheckpointSummary {
	id: string;
	sequence: number;
	targetId: string;
	summary: string;
	notClaimed: string[];
	remainingQuestions: string[];
}

export interface GoalToolCheckpointResolutionSummary {
	id: string;
	checkpointId: string;
	decision: GoalCheckpointResolutionDecision;
	nextTarget?: GoalToolTargetSummary;
}
export interface GoalToolBlockedStateSummary {
	id: string;
	kind: GoalBlockedStateKind;
	status: GoalBlockedStateStatus;
	message: string;
	blockers: string[];
	suggestedQuestions: string[];
	allowedActions: GoalBlockedStateAction[];
	source: GoalBlockedStateSource;
	requiredOperation?: "recover_blocked_state";
	broaderChecksOrInputs?: string[];
	remainingParentWork?: string[];
}

export type GoalToolRecoverySummary = Pick<
	GoalRecoveryRecord,
	"id" | "blockedStateId" | "kind" | "action" | "reason" | "guidance" | "blockers" | "result" | "at"
>;

export interface GoalTargetPlanRepairPatch {
	description: string;
	operations: Array<{
		op: "add" | "replace" | "remove";
		path: string;
		value?: unknown;
	}>;
}

export interface GoalTargetPlanLintDiagnostic {
	severity: "error" | "warning" | "info";
	code: string;
	path: string;
	message: string;
	guidance: string;
	blocksSubmission: boolean;
	offender?: {
		kind:
			| "schema"
			| "identity"
			| "signal"
			| "concern"
			| "excluded_work"
			| "matrix_row"
			| "target_card"
			| "target_unit_rule"
			| "history";
		id?: string;
		value?: unknown;
	};
	repairPatches?: GoalTargetPlanRepairPatch[];
}

export interface GoalTargetPlanLintResult {
	ok: boolean;
	targetId?: string;
	targetPlanId?: string;
	planFilePath?: string;
	revision?: number;
	stateVersion: number;
	parentFrameVersion: number;
	planDepth?: GoalTargetPlanDepth;
	primarySignalGroupId?: string;
	legacy: boolean;
	diagnostics: GoalTargetPlanLintDiagnostic[];
	summary: {
		errorCount: number;
		warningCount: number;
		infoCount: number;
		blocksSubmission: boolean;
	};
}

export interface GoalToolDetails {
	op:
		| "create"
		| "get"
		| "complete"
		| "resume"
		| "drop"
		| "start_target"
		| "checkpoint"
		| "resolve_checkpoint"
		| "submit_target_plan"
		| "lint_target_plan"
		| "target_plan_schema"
		| "fail_target_plan"
		| "recover_blocked_state";
	goal?: GoalToolGoalSummary | null;
	state?: GoalToolStateSummary | null;
	remainingTokens?: number | null;
	completionBudgetReport?: string | null;
	completionVerification?: GoalCompletionVerificationDetails;
	checkpoint?: GoalToolCheckpointSummary;
	checkpointReview?: Pick<GoalCheckpointReview, "status" | "feedback">;
	checkpointResolution?: GoalToolCheckpointResolutionSummary;
	targetPlanApproval?: GoalTargetPlanApprovedDetails;
	targetPlan?: GoalToolTargetPlanSummary;
	targetPlanLint?: GoalTargetPlanLintResult;
	blockedState?: GoalToolBlockedStateSummary;
	recovery?: GoalToolRecoverySummary;
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export type GoalTokenUsage = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite">;

export type GoalBudgetSteering = "allowed" | "suppressed";
export type GoalTerminalMetricEmission = "emit" | "suppress";

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeRefKind(value: unknown): GoalRefKind {
	switch (value) {
		case "doc":
		case "issue":
		case "artifact":
		case "test":
		case "commit":
		case "external-record":
		case "other":
			return value;
		default:
			return "other";
	}
}

function normalizeClaimStatus(value: unknown, fallback: GoalClaimStatus): GoalClaimStatus {
	switch (value) {
		case "accepted":
		case "candidate":
		case "rejected":
		case "stale":
			return value;
		default:
			return fallback;
	}
}

function normalizeBoundaryKind(value: unknown): GoalBoundaryKind {
	switch (value) {
		case "non-claim":
		case "forbidden-inference":
		case "unsupported":
		case "local-only":
		case "mock-only":
		case "unavailable":
		case "stale-path":
			return value;
		default:
			return "unsupported";
	}
}

function normalizeResidualClassification(value: unknown): GoalResidualClassification {
	switch (value) {
		case "current-parent-blocker":
		case "accepted-risk":
		case "future-frontier":
		case "decision-needed":
		case "architecture-debt":
		case "anti-laundering-non-claim":
		case "local-shortcut":
		case "capability-gap":
		case "rejected-or-stale-path":
		case "unspecified":
			return value;
		default:
			return "unspecified";
	}
}

function normalizeGateStatus(value: unknown): GoalGateStatus {
	switch (value) {
		case "unknown":
		case "passed":
		case "failed":
		case "stale":
		case "not-applicable":
			return value;
		default:
			return "unknown";
	}
}

function normalizeGoalStatus(value: unknown): GoalStatus {
	switch (value) {
		case "active":
		case "paused":
		case "budget-limited":
		case "complete":
		case "dropped":
			return value;
		default:
			return "active";
	}
}

function normalizeRunMode(value: unknown): GoalRunMode {
	switch (value) {
		case "working-target":
		case "planning-target":
		case "completed":
		case "awaiting-checkpoint-resolution":
		case "awaiting-parent-completion":
		case "awaiting-verification-repair":
		case "awaiting-user-input":
			return value;
		default:
			return "working-target";
	}
}

function normalizeDeliverableStatus(value: unknown): GoalDeliverableStatus {
	switch (value) {
		case "partial":
		case "satisfied":
		case "blocked":
		case "stale":
			return value;
		default:
			return "pending";
	}
}

function normalizeLifecycle(value: unknown): GoalModeLifecycle {
	return value === "exiting" ? "exiting" : "active";
}

function normalizeRef(value: unknown): GoalRef | undefined {
	if (!isRecord(value) || typeof value.id !== "string") return undefined;
	const ref: GoalRef = {
		id: value.id,
		kind: normalizeRefKind(value.kind),
	};
	const label = optionalString(value.label);
	if (label !== undefined) ref.label = label;
	const uri = optionalString(value.uri);
	if (uri !== undefined) ref.uri = uri;
	return ref;
}

function normalizeRefs(value: unknown): GoalRef[] {
	return Array.isArray(value) ? value.flatMap(ref => normalizeRef(ref) ?? []) : [];
}

function normalizeDeliverableMapItem(value: unknown): GoalDeliverableMapItem | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.summary !== "string") return undefined;
	const item: GoalDeliverableMapItem = {
		id: value.id,
		summary: value.summary,
		status: normalizeDeliverableStatus(value.status),
	};
	const evidenceRefs = normalizeRefs(value.evidenceRefs ?? value.evidence_refs);
	if (evidenceRefs.length > 0) item.evidenceRefs = evidenceRefs;
	const blockedBy = stringArray(value.blockedBy ?? value.blocked_by);
	if (blockedBy.length > 0) item.blockedBy = blockedBy;
	const nextRelevantTarget = optionalString(value.nextRelevantTarget ?? value.next_relevant_target);
	if (nextRelevantTarget !== undefined) item.nextRelevantTarget = nextRelevantTarget;
	return item;
}

function normalizeDeliverableMap(value: unknown): GoalDeliverableMapItem[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.flatMap(item => normalizeDeliverableMapItem(item) ?? []);
	return items.length > 0 ? items : undefined;
}

function normalizeClaim(value: unknown, fallbackStatus: GoalClaimStatus): GoalClaim | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.claim !== "string") return undefined;
	const claim: GoalClaim = {
		id: value.id,
		claim: value.claim,
		status: normalizeClaimStatus(value.status, fallbackStatus),
	};
	const scope = optionalString(value.scope);
	if (scope !== undefined) claim.scope = scope;
	const evidenceRefs = normalizeRefs(value.evidenceRefs ?? value.evidence_refs);
	if (evidenceRefs.length > 0) claim.evidenceRefs = evidenceRefs;
	const nonImplications = stringArray(value.nonImplications ?? value.non_implications);
	if (nonImplications.length > 0) claim.nonImplications = nonImplications;
	const acceptedBy = optionalString(value.acceptedBy ?? value.accepted_by);
	if (acceptedBy !== undefined) claim.acceptedBy = acceptedBy;
	const acceptedAt = optionalNumber(value.acceptedAt ?? value.accepted_at);
	if (acceptedAt !== undefined) claim.acceptedAt = acceptedAt;
	return claim;
}

function normalizeClaims(value: unknown, fallbackStatus: GoalClaimStatus): GoalClaim[] {
	return Array.isArray(value) ? value.flatMap(claim => normalizeClaim(claim, fallbackStatus) ?? []) : [];
}

function normalizeBoundary(value: unknown): GoalBoundary | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.statement !== "string") return undefined;
	const boundary: GoalBoundary = {
		id: value.id,
		kind: normalizeBoundaryKind(value.kind),
		statement: value.statement,
	};
	const refs = normalizeRefs(value.refs);
	if (refs.length > 0) boundary.refs = refs;
	return boundary;
}

function normalizeBoundaries(value: unknown): GoalBoundary[] {
	return Array.isArray(value) ? value.flatMap(boundary => normalizeBoundary(boundary) ?? []) : [];
}

function normalizeResidual(value: unknown): GoalResidual | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.statement !== "string") return undefined;
	const residual: GoalResidual = {
		id: value.id,
		statement: value.statement,
		classification: normalizeResidualClassification(value.classification),
	};
	const whyItMatters = optionalString(value.whyItMatters ?? value.why_it_matters);
	if (whyItMatters !== undefined) residual.whyItMatters = whyItMatters;
	const requiredEvidence = stringArray(value.requiredEvidence ?? value.required_evidence);
	if (requiredEvidence.length > 0) residual.requiredEvidence = requiredEvidence;
	const targetHorizon = optionalString(value.targetHorizon ?? value.target_horizon);
	if (targetHorizon !== undefined) residual.targetHorizon = targetHorizon;
	const authorityRequired = optionalString(value.authorityRequired ?? value.authority_required);
	if (authorityRequired !== undefined) residual.authorityRequired = authorityRequired;
	const nonImplications = stringArray(value.nonImplications ?? value.non_implications);
	if (nonImplications.length > 0) residual.nonImplications = nonImplications;
	const refs = normalizeRefs(value.refs);
	if (refs.length > 0) residual.refs = refs;
	return residual;
}

function normalizeResiduals(value: unknown): GoalResidual[] {
	return Array.isArray(value) ? value.flatMap(residual => normalizeResidual(residual) ?? []) : [];
}

function normalizeGate(value: unknown): GoalGate | undefined {
	if (!isRecord(value) || typeof value.id !== "string") return undefined;
	const name = typeof value.name === "string" ? value.name : value.id;
	const gate: GoalGate = {
		id: value.id,
		name,
		status: normalizeGateStatus(value.status),
		requiredEvidence: stringArray(value.requiredEvidence ?? value.required_evidence),
	};
	const evidenceRefs = normalizeRefs(value.evidenceRefs ?? value.evidence_refs);
	if (evidenceRefs.length > 0) gate.evidenceRefs = evidenceRefs;
	const nonClaims = stringArray(value.nonClaims ?? value.non_claims);
	if (nonClaims.length > 0) gate.nonClaims = nonClaims;
	const staleIf = stringArray(value.staleIf ?? value.stale_if);
	if (staleIf.length > 0) gate.staleIf = staleIf;
	return gate;
}

function normalizeGates(value: unknown): GoalGate[] {
	return Array.isArray(value) ? value.flatMap(gate => normalizeGate(gate) ?? []) : [];
}

function normalizeAuthority(value: unknown): GoalAuthorityState | undefined {
	if (!isRecord(value)) return undefined;
	const authority: GoalAuthorityState = {};
	const parentStateAuthority = optionalString(value.parentStateAuthority ?? value.parent_state_authority);
	if (parentStateAuthority !== undefined) authority.parentStateAuthority = parentStateAuthority;
	const riskAcceptanceAuthority = optionalString(value.riskAcceptanceAuthority ?? value.risk_acceptance_authority);
	if (riskAcceptanceAuthority !== undefined) authority.riskAcceptanceAuthority = riskAcceptanceAuthority;
	const externalRecordAuthority = optionalString(value.externalRecordAuthority ?? value.external_record_authority);
	if (externalRecordAuthority !== undefined) authority.externalRecordAuthority = externalRecordAuthority;
	if (typeof (value.workerMayOnlyPropose ?? value.worker_may_only_propose) === "boolean") {
		authority.workerMayOnlyPropose = (value.workerMayOnlyPropose ?? value.worker_may_only_propose) as boolean;
	}
	return Object.keys(authority).length > 0 ? authority : undefined;
}

function normalizeFrontierItem(value: unknown): GoalFrontierItem | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.statement !== "string") return undefined;
	const item: GoalFrontierItem = { id: value.id, statement: value.statement };
	const evidenceRequired = stringArray(value.evidenceRequired ?? value.evidence_required);
	if (evidenceRequired.length > 0) item.evidenceRequired = evidenceRequired;
	const activationTrigger = optionalString(value.activationTrigger ?? value.activation_trigger);
	if (activationTrigger !== undefined) item.activationTrigger = activationTrigger;
	const refs = normalizeRefs(value.refs);
	if (refs.length > 0) item.refs = refs;
	return item;
}

function normalizeFrontier(value: unknown): GoalFrontierItem[] {
	return Array.isArray(value) ? value.flatMap(item => normalizeFrontierItem(item) ?? []) : [];
}

export function normalizeParentFrame(value: unknown, objective = ""): GoalParentFrame | undefined {
	if (!isRecord(value)) return undefined;
	const desiredFuture = optionalString(value.desiredFuture ?? value.desired_future) ?? objective;
	const kind = (value.kind === "claim-gated" ? "claim-gated" : "plain") satisfies GoalParentFrameKind;
	const frame: GoalParentFrame = {
		kind,
		desiredFuture,
		baselineRefs: normalizeRefs(value.baselineRefs ?? value.baseline_refs),
		acceptedClaims: normalizeClaims(value.acceptedClaims ?? value.accepted_claims, "accepted"),
		candidateClaims: normalizeClaims(value.candidateClaims ?? value.candidate_claims, "candidate"),
		rejectedOrStaleClaims: normalizeClaims(value.rejectedOrStaleClaims ?? value.rejected_or_stale_claims, "rejected"),
		boundaries: normalizeBoundaries(value.boundaries),
		residuals: normalizeResiduals(value.residuals),
		gates: normalizeGates(value.gates),
		frontier: normalizeFrontier(value.frontier),
		staleIf: stringArray(value.staleIf ?? value.stale_if),
		externalRefs: normalizeRefs(value.externalRefs ?? value.external_refs),
	};
	const currentTruth = optionalString(value.currentTruth ?? value.current_truth);
	if (currentTruth !== undefined) frame.currentTruth = currentTruth;
	const authority = normalizeAuthority(value.authority);
	if (authority) frame.authority = authority;
	const lastParentDeltaId = optionalString(value.lastParentDeltaId ?? value.last_parent_delta_id);
	if (lastParentDeltaId !== undefined) frame.lastParentDeltaId = lastParentDeltaId;
	return frame;
}

function cloneRefs(value: GoalRef[] | undefined): GoalRef[] {
	return value?.map(ref => ({ ...ref })) ?? [];
}

function cloneDeliverableMap(value: GoalDeliverableMapItem[] | undefined): GoalDeliverableMapItem[] | undefined {
	return value?.map(item => ({
		...item,
		evidenceRefs: item.evidenceRefs ? cloneRefs(item.evidenceRefs) : undefined,
		blockedBy: item.blockedBy ? [...item.blockedBy] : undefined,
	}));
}

function cloneClaims(value: GoalClaim[] | undefined): GoalClaim[] {
	return (
		value?.map(claim => ({
			...claim,
			evidenceRefs: claim.evidenceRefs ? cloneRefs(claim.evidenceRefs) : undefined,
			nonImplications: claim.nonImplications ? [...claim.nonImplications] : undefined,
		})) ?? []
	);
}

function cloneBoundaries(value: GoalBoundary[] | undefined): GoalBoundary[] {
	return value?.map(boundary => ({ ...boundary, refs: boundary.refs ? cloneRefs(boundary.refs) : undefined })) ?? [];
}

function cloneResiduals(value: GoalResidual[] | undefined): GoalResidual[] {
	return (
		value?.map(residual => ({
			...residual,
			requiredEvidence: residual.requiredEvidence ? [...residual.requiredEvidence] : undefined,
			nonImplications: residual.nonImplications ? [...residual.nonImplications] : undefined,
			refs: residual.refs ? cloneRefs(residual.refs) : undefined,
		})) ?? []
	);
}

function cloneGates(value: GoalGate[] | undefined): GoalGate[] {
	return (
		value?.map(gate => ({
			...gate,
			requiredEvidence: [...gate.requiredEvidence],
			evidenceRefs: gate.evidenceRefs ? cloneRefs(gate.evidenceRefs) : undefined,
			nonClaims: gate.nonClaims ? [...gate.nonClaims] : undefined,
			staleIf: gate.staleIf ? [...gate.staleIf] : undefined,
		})) ?? []
	);
}

function cloneFrontier(value: GoalFrontierItem[] | undefined): GoalFrontierItem[] {
	return (
		value?.map(item => ({
			...item,
			evidenceRequired: item.evidenceRequired ? [...item.evidenceRequired] : undefined,
			refs: item.refs ? cloneRefs(item.refs) : undefined,
		})) ?? []
	);
}

export function cloneParentFrame(frame: GoalParentFrame | undefined): GoalParentFrame | undefined {
	if (!frame) return undefined;
	const cloned: GoalParentFrame = {
		...frame,
		baselineRefs: cloneRefs(frame.baselineRefs),
		acceptedClaims: cloneClaims(frame.acceptedClaims),
		candidateClaims: cloneClaims(frame.candidateClaims),
		rejectedOrStaleClaims: cloneClaims(frame.rejectedOrStaleClaims),
		boundaries: cloneBoundaries(frame.boundaries),
		residuals: cloneResiduals(frame.residuals),
		gates: cloneGates(frame.gates),
		frontier: cloneFrontier(frame.frontier),
		staleIf: [...frame.staleIf],
		externalRefs: cloneRefs(frame.externalRefs),
	};
	if (frame.authority) cloned.authority = { ...frame.authority };
	return cloned;
}

export function cloneStructuredFeedback(
	structuredFeedback: GoalCompletionVerifierStructuredOutput | undefined,
): GoalCompletionVerifierStructuredOutput | undefined {
	if (!structuredFeedback) return undefined;
	return {
		...structuredFeedback,
		deliverableResults: structuredFeedback.deliverableResults.map(result => ({
			...result,
			evidence: result.evidence?.map(item => ({ ...item })),
		})),
		evidenceChecked: structuredFeedback.evidenceChecked.map(item => ({ ...item })),
		completionBlockers: structuredFeedback.completionBlockers.map(item => ({ ...item })),
		continuationFocus: structuredFeedback.continuationFocus
			? cloneContinuationFocus(structuredFeedback.continuationFocus)
			: undefined,
	};
}

export function cloneContinuationFocus(focus: GoalContinuationFocus): GoalContinuationFocus {
	return {
		openGaps: [...focus.openGaps],
		nextActions: [...focus.nextActions],
		evidenceToCollect: [...focus.evidenceToCollect],
		avoidRepeating: focus.avoidRepeating ? [...focus.avoidRepeating] : undefined,
	};
}

function cloneVerificationAperture(
	aperture: GoalVerificationAperture | undefined,
): GoalVerificationAperture | undefined {
	if (!aperture) return undefined;
	return {
		...aperture,
		residualUncertainty: [...aperture.residualUncertainty],
		omittedLayers: aperture.omittedLayers.map(layer => ({ ...layer })),
	};
}

function cloneVerificationSignals(signals: GoalVerificationSignal[] | undefined): GoalVerificationSignal[] | undefined {
	return signals?.map(signal => ({
		...signal,
		concernIds: [...signal.concernIds],
		staleIf: [...signal.staleIf],
	}));
}

function cloneConcernChecks(checks: GoalConcernCheck[] | undefined): GoalConcernCheck[] | undefined {
	return checks?.map(check => ({
		...check,
		coveredBySignalIds: [...check.coveredBySignalIds],
	}));
}

function cloneScopeCalibration(calibration: GoalScopeCalibration | undefined): GoalScopeCalibration | undefined {
	if (!calibration) return undefined;
	return {
		...calibration,
		whyNotSmaller: [...calibration.whyNotSmaller],
		whyNotLarger: [...calibration.whyNotLarger],
		includedRelatedWork: calibration.includedRelatedWork.map(item => ({
			...item,
			signalIds: [...item.signalIds],
		})),
		deferredRelatedWork: calibration.deferredRelatedWork.map(item => ({ ...item })),
		targetUnitRuleIds: calibration.targetUnitRuleIds ? [...calibration.targetUnitRuleIds] : undefined,
		targetUnitExemptions: calibration.targetUnitExemptions?.map(exemption => ({ ...exemption })),
	};
}

function cloneTargetPlanBranchEvidence(
	branches: GoalTargetPlanBranchEvidence[] | undefined,
): GoalTargetPlanBranchEvidence[] | undefined {
	return branches?.map(branch => ({
		...branch,
		plannedSignalIds: [...branch.plannedSignalIds],
		rowIds: branch.rowIds ? [...branch.rowIds] : undefined,
	}));
}

function cloneTargetPlanExcludedWorkReview(
	reviews: GoalTargetPlanExcludedWorkReview[] | undefined,
): GoalTargetPlanExcludedWorkReview[] | undefined {
	return reviews?.map(review => ({ ...review }));
}

function cloneScenarioMatrix(matrix: GoalScenarioMatrix | undefined): GoalScenarioMatrix | undefined {
	if (!matrix) return undefined;
	return {
		...matrix,
		rowsInScope: matrix.rowsInScope.map(row => ({
			...row,
			signalIds: [...row.signalIds],
			concernIds: [...row.concernIds],
			staleIf: [...row.staleIf],
		})),
		rowsLeftOpen: matrix.rowsLeftOpen.map(row => ({ ...row })),
		splittingSafety: { ...matrix.splittingSafety },
		nextLargerTarget: matrix.nextLargerTarget
			? {
					...matrix.nextLargerTarget,
					rows: [...matrix.nextLargerTarget.rows],
				}
			: undefined,
	};
}

function cloneTargetWorkstreams(workstreams: GoalTargetWorkstream[] | undefined): GoalTargetWorkstream[] | undefined {
	return workstreams?.map(workstream => ({
		...workstream,
		files: [...workstream.files],
		contractInputs: [...workstream.contractInputs],
		contractOutputs: [...workstream.contractOutputs],
	}));
}

function cloneTargetCard(card: GoalTargetCard | undefined): GoalTargetCard | undefined {
	if (!card) return undefined;
	return {
		...card,
		knownLimits: [...card.knownLimits],
		acceptanceRows: {
			closed: [...card.acceptanceRows.closed],
			open: [...card.acceptanceRows.open],
		},
		workstreams: cloneTargetWorkstreams(card.workstreams),
		reviewLenses: card.reviewLenses ? [...card.reviewLenses] : undefined,
		verificationScenarios: [...card.verificationScenarios],
		checkpointEvidence: [...card.checkpointEvidence],
	};
}

function cloneTargetUnitRules(rules: GoalTargetUnitRule[] | undefined): GoalTargetUnitRule[] | undefined {
	return rules?.map(rule => ({ ...rule }));
}

function cloneTargetPlanFailure(failure: GoalTargetPlanFailure | undefined): GoalTargetPlanFailure | undefined {
	if (!failure) return undefined;
	return {
		...failure,
		blockers: [...failure.blockers],
		suggestedQuestions: [...failure.suggestedQuestions],
	};
}

export function cloneRecoveryLink(recovery: GoalRecoveryLink | undefined): GoalRecoveryLink | undefined {
	if (!recovery) return undefined;
	return {
		...recovery,
		blockers: [...recovery.blockers],
	};
}

export function cloneBlockedState(block: GoalBlockedState | undefined): GoalBlockedState | undefined {
	if (!block) return undefined;
	const base = {
		...block,
		blockers: [...block.blockers],
		suggestedQuestions: [...block.suggestedQuestions],
		allowedActions: [...block.allowedActions],
		source: { ...block.source },
	};
	if (block.kind === "checkpoint-external-pause") {
		return {
			...base,
			kind: "checkpoint-external-pause",
			source: { ...block.source },
			broaderChecksOrInputs: [...block.broaderChecksOrInputs],
			remainingParentWork: [...block.remainingParentWork],
			allowedActions: [...block.allowedActions],
		};
	}
	if (block.kind === "target-plan") {
		return {
			...base,
			kind: "target-plan",
			source: { ...block.source },
			allowedActions: ["restart_target_planning"],
		};
	}
	return {
		...base,
		kind: "operator-input-required",
		source: { ...block.source },
		allowedActions: [],
	};
}

export function cloneRecoveryRecord(recovery: GoalRecoveryRecord | undefined): GoalRecoveryRecord | undefined {
	if (!recovery) return undefined;
	return {
		...recovery,
		blockers: [...recovery.blockers],
		source: { ...recovery.source },
		result: { ...recovery.result },
	};
}

function cloneTargetPlanReview(review: GoalTargetPlanReview): GoalTargetPlanReview {
	return {
		...review,
		scores: review.scores ? { ...review.scores } : undefined,
		findings: review.findings.map(finding => ({ ...finding })),
	};
}

export function cloneTargetPlan(plan: GoalTargetPlanRecord | undefined): GoalTargetPlanRecord | undefined {
	if (!plan) return undefined;
	return {
		...plan,
		failure: cloneTargetPlanFailure(plan.failure),
		recoveredFrom: cloneRecoveryLink(plan.recoveredFrom),
		verificationAperture: cloneVerificationAperture(plan.verificationAperture),
		verificationSignals: cloneVerificationSignals(plan.verificationSignals),
		concernChecks: cloneConcernChecks(plan.concernChecks),
		scopeCalibration: cloneScopeCalibration(plan.scopeCalibration),
		branchEvidence: cloneTargetPlanBranchEvidence(plan.branchEvidence),
		excludedWorkReview: cloneTargetPlanExcludedWorkReview(plan.excludedWorkReview),
		scenarioMatrix: cloneScenarioMatrix(plan.scenarioMatrix),
		targetCard: cloneTargetCard(plan.targetCard),
		reviews: plan.reviews.map(review => cloneTargetPlanReview(review)),
	};
}

function upsertTargetPlan(
	plans: GoalTargetPlanRecord[] | undefined,
	plan: GoalTargetPlanRecord,
): GoalTargetPlanRecord[] {
	const next =
		plans?.map(item => cloneTargetPlan(item)).filter((item): item is GoalTargetPlanRecord => item !== undefined) ??
		[];
	const cloned = cloneTargetPlan(plan);
	if (!cloned) return next;
	const existingIndex = next.findIndex(item => item.id === cloned.id);
	if (existingIndex >= 0) {
		next[existingIndex] = cloned;
	} else {
		next.push(cloned);
	}
	return next;
}

export function upsertBlockedState(
	states: GoalBlockedState[] | undefined,
	block: GoalBlockedState,
): GoalBlockedState[] {
	const next =
		states?.map(item => cloneBlockedState(item)).filter((item): item is GoalBlockedState => item !== undefined) ?? [];
	const cloned = cloneBlockedState(block);
	if (!cloned) return next;
	const existingIndex = next.findIndex(item => item.id === cloned.id);
	if (existingIndex >= 0) {
		next[existingIndex] = cloned;
	} else {
		next.push(cloned);
	}
	return next;
}

export function upsertRecoveryRecord(
	records: GoalRecoveryRecord[] | undefined,
	record: GoalRecoveryRecord,
): GoalRecoveryRecord[] {
	const next =
		records
			?.map(item => cloneRecoveryRecord(item))
			.filter((item): item is GoalRecoveryRecord => item !== undefined) ?? [];
	const cloned = cloneRecoveryRecord(record);
	if (!cloned) return next;
	const existingIndex = next.findIndex(item => item.id === cloned.id);
	if (existingIndex >= 0) {
		next[existingIndex] = cloned;
	} else {
		next.push(cloned);
	}
	return next;
}

export function cloneTarget(target: GoalTarget | undefined): GoalTarget | undefined {
	if (!target) return undefined;
	return {
		...target,
		baselineRefs: cloneRefs(target.baselineRefs),
		gateRefs: [...target.gateRefs],
		evidenceExpectation: [...target.evidenceExpectation],
		nonGoals: [...target.nonGoals],
		forbiddenClaims: [...target.forbiddenClaims],
		staleIf: [...target.staleIf],
		linkedVerifierBlockerIds: target.linkedVerifierBlockerIds ? [...target.linkedVerifierBlockerIds] : undefined,
		parentDeliverableIds: target.parentDeliverableIds ? [...target.parentDeliverableIds] : undefined,
		verificationAperture: cloneVerificationAperture(target.verificationAperture),
		verificationSignals: cloneVerificationSignals(target.verificationSignals),
		concernChecks: cloneConcernChecks(target.concernChecks),
		scopeCalibration: cloneScopeCalibration(target.scopeCalibration),
		scenarioMatrix: cloneScenarioMatrix(target.scenarioMatrix),
		targetCard: cloneTargetCard(target.targetCard),
	};
}

function cloneCheckpointReview(review: GoalCheckpointReview | undefined): GoalCheckpointReview | undefined {
	if (!review) return undefined;
	return {
		...review,
		evidenceChecked: review.evidenceChecked.map(item => ({ ...item })),
		blockers: review.blockers.map(blocker => ({ ...blocker })),
		continuationFocus: review.continuationFocus ? cloneContinuationFocus(review.continuationFocus) : undefined,
	};
}

export function cloneCheckpoint(packet: GoalCheckpointPacket | undefined): GoalCheckpointPacket | undefined {
	if (!packet) return undefined;
	const targetSnapshot = cloneTarget(packet.targetSnapshot);
	if (!targetSnapshot) return undefined;
	return {
		...packet,
		targetSnapshot,
		baselineRefs: cloneRefs(packet.baselineRefs),
		gateRefs: [...packet.gateRefs],
		localClaims: [...packet.localClaims],
		evidence: packet.evidence.map(item => ({ ...item })),
		checksRun: [...packet.checksRun],
		artifactsTouched: [...packet.artifactsTouched],
		notClaimed: [...packet.notClaimed],
		remainingQuestions: [...packet.remainingQuestions],
		risksOrCaveats: [...packet.risksOrCaveats],
		staleIf: [...packet.staleIf],
		suggestedControllerQuestions: [...packet.suggestedControllerQuestions],
		review: cloneCheckpointReview(packet.review),
	};
}

function cloneParentDelta(delta: GoalParentStateDelta | undefined): GoalParentStateDelta | undefined {
	if (!delta) return undefined;
	return {
		admittedClaims: cloneClaims(delta.admittedClaims),
		candidateClaimsAdded: cloneClaims(delta.candidateClaimsAdded),
		rejectedClaims: cloneClaims(delta.rejectedClaims),
		boundariesAdded: cloneBoundaries(delta.boundariesAdded),
		residualsAddedOrUpdated: cloneResiduals(delta.residualsAddedOrUpdated),
		gateDeltas: delta.gateDeltas.map(gate => ({
			...gate,
			evidenceRefs: gate.evidenceRefs ? cloneRefs(gate.evidenceRefs) : undefined,
		})),
		frontierDeltas: cloneFrontier(delta.frontierDeltas),
		staleRefs: cloneRefs(delta.staleRefs),
		externalRecordRefs: cloneRefs(delta.externalRecordRefs),
		authorityDecisionRefs: delta.authorityDecisionRefs ? cloneRefs(delta.authorityDecisionRefs) : undefined,
		deliverableDeltas: delta.deliverableDeltas?.map(item => ({
			...item,
			evidenceRefs: item.evidenceRefs ? cloneRefs(item.evidenceRefs) : undefined,
			blockedBy: item.blockedBy ? [...item.blockedBy] : undefined,
		})),
	};
}

export function cloneCheckpointResolution(
	resolution: GoalCheckpointResolution | undefined,
): GoalCheckpointResolution | undefined {
	if (!resolution) return undefined;
	return {
		...resolution,
		parentDelta: cloneParentDelta(resolution.parentDelta),
		notPropagated: [...resolution.notPropagated],
		remainingParentWork: [...resolution.remainingParentWork],
		broaderChecksOrInputs: [...resolution.broaderChecksOrInputs],
		lessonsForFuture: [...resolution.lessonsForFuture],
		nextTarget: cloneTarget(resolution.nextTarget),
	};
}

export function cloneVerificationRepair(
	repair: GoalVerificationRepairState | undefined,
): GoalVerificationRepairState | undefined {
	if (!repair) return undefined;
	return {
		...repair,
		blockers: repair.blockers.map(blocker => ({ ...blocker })),
		evidenceToCollect: [...repair.evidenceToCollect],
		avoidRepeating: [...repair.avoidRepeating],
	};
}

export function cloneGoal(goal: Goal): Goal {
	return {
		...goal,
		verificationAttempts: goal.verificationAttempts?.map(attempt => ({
			...attempt,
			structuredFeedback: cloneStructuredFeedback(attempt.structuredFeedback),
		})),
		deliverableMap: cloneDeliverableMap(goal.deliverableMap),
		parentFrame: cloneParentFrame(goal.parentFrame),
		currentTarget: cloneTarget(goal.currentTarget),
		targets: goal.targets
			?.map(target => cloneTarget(target))
			.filter((target): target is GoalTarget => target !== undefined),
		currentTargetPlan: cloneTargetPlan(goal.currentTargetPlan),
		targetPlans: goal.targetPlans
			?.map(plan => cloneTargetPlan(plan))
			.filter((plan): plan is GoalTargetPlanRecord => plan !== undefined),
		targetUnitRules: cloneTargetUnitRules(goal.targetUnitRules),
		checkpoints: goal.checkpoints
			?.map(packet => cloneCheckpoint(packet))
			.filter((packet): packet is GoalCheckpointPacket => packet !== undefined),
		checkpointResolutions: goal.checkpointResolutions
			?.map(resolution => cloneCheckpointResolution(resolution))
			.filter((resolution): resolution is GoalCheckpointResolution => resolution !== undefined),
		lastCheckpointRejection: goal.lastCheckpointRejection
			? {
					candidateSummary: goal.lastCheckpointRejection.candidateSummary,
					review:
						cloneCheckpointReview(goal.lastCheckpointRejection.review) ?? goal.lastCheckpointRejection.review,
					createdAt: goal.lastCheckpointRejection.createdAt,
				}
			: undefined,
		verificationRepair: cloneVerificationRepair(goal.verificationRepair),
		currentBlockedState: cloneBlockedState(goal.currentBlockedState),
		blockedStates: goal.blockedStates
			?.map(block => cloneBlockedState(block))
			.filter((block): block is GoalBlockedState => block !== undefined),
		recoveryHistory: goal.recoveryHistory
			?.map(record => cloneRecoveryRecord(record))
			.filter((record): record is GoalRecoveryRecord => record !== undefined),
	};
}

export function cloneGoalModeState(state: GoalModeState): GoalModeState {
	return {
		...state,
		goal: cloneGoal(state.goal),
	};
}

function normalizeVerificationAttempts(value: unknown): GoalVerificationAttempt[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap(item => {
		if (!isRecord(item)) return [];
		if (typeof item.id !== "string" || typeof item.sequence !== "number") return [];
		return [item as unknown as GoalVerificationAttempt];
	});
}

function isGoalRecoveryReason(value: unknown): value is GoalRecoveryReason {
	return (
		value === "user-input" ||
		value === "broader-checks" ||
		value === "external-authority" ||
		value === "state-refresh"
	);
}

function normalizeRecoveryReason(value: unknown): GoalRecoveryReason {
	return isGoalRecoveryReason(value) ? value : "user-input";
}

export function isNonContinuingCheckpointDecision(
	decision: unknown,
): decision is Extract<
	GoalCheckpointResolutionDecision,
	"needs_user_input" | "needs_broader_checks" | "pause_for_external_control" | "drop_or_replace_recommended"
> {
	return (
		decision === "needs_user_input" ||
		decision === "needs_broader_checks" ||
		decision === "pause_for_external_control" ||
		decision === "drop_or_replace_recommended"
	);
}

function normalizeTargetPlanDepth(value: unknown): GoalTargetPlanDepth | undefined {
	return value === "light" || value === "standard" || value === "trust-heavy" ? value : undefined;
}

function normalizeScenarioOpenReason(value: unknown): GoalScenarioMatrixOpenRow["reason"] | undefined {
	return value === "different-primary-signal" ||
		value === "different-authority" ||
		value === "different-blast-radius" ||
		value === "blocked-external" ||
		value === "non-goal" ||
		value === "unsafe-to-bundle"
		? value
		: undefined;
}

function normalizeScenarioMatrixRow(value: unknown): GoalScenarioMatrixRow | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || typeof value.branch !== "string") return undefined;
	if (
		typeof value.acceptance !== "string" ||
		typeof value.expectedOutcome !== "string" ||
		!Array.isArray(value.signalIds) ||
		!Array.isArray(value.concernIds) ||
		!Array.isArray(value.staleIf)
	) {
		return undefined;
	}
	return {
		id: value.id,
		branch: value.branch,
		signalIds: stringArray(value.signalIds),
		concernIds: stringArray(value.concernIds),
		acceptance: value.acceptance,
		expectedOutcome: value.expectedOutcome,
		staleIf: stringArray(value.staleIf),
	};
}

function normalizeScenarioMatrixOpenRow(value: unknown): GoalScenarioMatrixOpenRow | undefined {
	if (!isRecord(value)) return undefined;
	const reason = normalizeScenarioOpenReason(value.reason);
	if (
		typeof value.id !== "string" ||
		typeof value.branch !== "string" ||
		!reason ||
		typeof value.followUpHint !== "string"
	) {
		return undefined;
	}
	return {
		id: value.id,
		branch: value.branch,
		reason,
		rationale: optionalString(value.rationale),
		followUpHint: value.followUpHint,
	};
}

function normalizeScenarioMatrix(value: unknown): GoalScenarioMatrix | undefined {
	if (!isRecord(value)) return undefined;
	const splittingSafety = value.splittingSafety;
	if (
		typeof value.id !== "string" ||
		typeof value.primarySignalGroupId !== "string" ||
		!Array.isArray(value.rowsInScope) ||
		!Array.isArray(value.rowsLeftOpen) ||
		!isRecord(splittingSafety) ||
		typeof splittingSafety.safe !== "boolean" ||
		typeof splittingSafety.rationale !== "string"
	) {
		return undefined;
	}
	const rowsInScope = value.rowsInScope.flatMap(row => normalizeScenarioMatrixRow(row) ?? []);
	const rowsLeftOpen = value.rowsLeftOpen.flatMap(row => normalizeScenarioMatrixOpenRow(row) ?? []);
	if (rowsInScope.length !== value.rowsInScope.length || rowsLeftOpen.length !== value.rowsLeftOpen.length) {
		return undefined;
	}
	const matrix: GoalScenarioMatrix = {
		id: value.id,
		primarySignalGroupId: value.primarySignalGroupId,
		rowsInScope,
		rowsLeftOpen,
		splittingSafety: { safe: splittingSafety.safe, rationale: splittingSafety.rationale },
	};
	const nextLargerTarget = value.nextLargerTarget;
	if (isRecord(nextLargerTarget)) {
		if (
			typeof nextLargerTarget.title !== "string" ||
			typeof nextLargerTarget.primarySignalGroupId !== "string" ||
			!Array.isArray(nextLargerTarget.rows)
		) {
			return undefined;
		}
		matrix.nextLargerTarget = {
			title: nextLargerTarget.title,
			primarySignalGroupId: nextLargerTarget.primarySignalGroupId,
			rows: stringArray(nextLargerTarget.rows),
			unblocksMatrixId: optionalString(nextLargerTarget.unblocksMatrixId),
		};
	}
	return matrix;
}

function normalizeTargetWorkstreamKind(value: unknown): GoalTargetWorkstream["kind"] | undefined {
	return value === "main" ||
		value === "backend-rust" ||
		value === "app-ui" ||
		value === "e2e-harness" ||
		value === "docs-changelog" ||
		value === "other"
		? value
		: undefined;
}

function normalizeTargetWorkstream(value: unknown): GoalTargetWorkstream | undefined {
	if (!isRecord(value)) return undefined;
	const kind = normalizeTargetWorkstreamKind(value.kind);
	if (
		typeof value.id !== "string" ||
		typeof value.label !== "string" ||
		!kind ||
		!Array.isArray(value.files) ||
		!Array.isArray(value.contractInputs) ||
		!Array.isArray(value.contractOutputs)
	) {
		return undefined;
	}
	return {
		id: value.id,
		label: value.label,
		kind,
		role: optionalString(value.role),
		files: stringArray(value.files),
		contractInputs: stringArray(value.contractInputs),
		contractOutputs: stringArray(value.contractOutputs),
	};
}

function normalizeTargetCard(value: unknown): GoalTargetCard | undefined {
	if (!isRecord(value)) return undefined;
	const acceptanceRows = value.acceptanceRows;
	if (
		typeof value.capabilityClaim !== "string" ||
		typeof value.userVisibleSurface !== "string" ||
		!Array.isArray(value.knownLimits) ||
		!isRecord(acceptanceRows) ||
		!Array.isArray(acceptanceRows.closed) ||
		!Array.isArray(acceptanceRows.open) ||
		!Array.isArray(value.verificationScenarios) ||
		!Array.isArray(value.checkpointEvidence)
	) {
		return undefined;
	}
	const workstreams = Array.isArray(value.workstreams)
		? value.workstreams.flatMap(workstream => normalizeTargetWorkstream(workstream) ?? [])
		: undefined;
	if (Array.isArray(value.workstreams) && workstreams?.length !== value.workstreams.length) return undefined;
	return {
		capabilityClaim: value.capabilityClaim,
		trustPrivacyClaim: optionalString(value.trustPrivacyClaim),
		confidenceEarned: optionalString(value.confidenceEarned),
		knownLimits: stringArray(value.knownLimits),
		authorityBoundary: optionalString(value.authorityBoundary),
		policyDeletionImplications: optionalString(value.policyDeletionImplications),
		userVisibleSurface: value.userVisibleSurface,
		acceptanceRows: {
			closed: stringArray(acceptanceRows.closed),
			open: stringArray(acceptanceRows.open),
		},
		workstreams,
		sharedContract: optionalString(value.sharedContract),
		reviewLenses: Array.isArray(value.reviewLenses) ? stringArray(value.reviewLenses) : undefined,
		verificationScenarios: stringArray(value.verificationScenarios),
		checkpointEvidence: stringArray(value.checkpointEvidence),
		rollbackCutover: optionalString(value.rollbackCutover),
	};
}

function normalizeTargetUnitRuleKind(value: unknown): GoalTargetUnitRuleKind | undefined {
	return value === "complete-acceptance-slice" ||
		value === "scenario-matrix" ||
		value === "gate-prerequisite" ||
		value === "no-process-phase" ||
		value === "same-primary-signal-together" ||
		value === "branch-unblocks-matrix"
		? value
		: undefined;
}

function normalizeTargetUnitRule(value: unknown): GoalTargetUnitRule | undefined {
	if (!isRecord(value)) return undefined;
	const kind = normalizeTargetUnitRuleKind(value.kind);
	const source =
		value.source === "rubric" ||
		value.source === "checkpoint-guidance" ||
		value.source === "operator" ||
		value.source === "built-in"
			? value.source
			: undefined;
	const enforcement = value.enforcement === "warning" || value.enforcement === "error" ? value.enforcement : undefined;
	if (typeof value.id !== "string" || !kind || typeof value.statement !== "string" || !source || !enforcement) {
		return undefined;
	}
	return { id: value.id, kind, statement: value.statement, source, enforcement };
}

function normalizeTargetUnitRules(value: unknown): GoalTargetUnitRule[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const rules = value.flatMap(rule => normalizeTargetUnitRule(rule) ?? []);
	return rules.length ? rules : undefined;
}

function applyOptionalTargetPlanFields(record: Record<string, unknown>): void {
	const planDepth = normalizeTargetPlanDepth(record.planDepth);
	if (planDepth) record.planDepth = planDepth;
	else delete record.planDepth;
	const primarySignalGroupId = optionalString(record.primarySignalGroupId);
	if (primarySignalGroupId) record.primarySignalGroupId = primarySignalGroupId;
	else delete record.primarySignalGroupId;
	const scenarioMatrix = normalizeScenarioMatrix(record.scenarioMatrix);
	if (scenarioMatrix) record.scenarioMatrix = scenarioMatrix;
	else delete record.scenarioMatrix;
	const targetCard = normalizeTargetCard(record.targetCard);
	if (targetCard) record.targetCard = targetCard;
	else delete record.targetCard;
	const calibration = record.scopeCalibration;
	if (isRecord(calibration)) {
		const targetUnitRuleIds = stringArray(calibration.targetUnitRuleIds);
		if (targetUnitRuleIds.length > 0) calibration.targetUnitRuleIds = targetUnitRuleIds;
		else delete calibration.targetUnitRuleIds;
		const exemptions = Array.isArray(calibration.targetUnitExemptions)
			? calibration.targetUnitExemptions.flatMap(exemption => {
					if (!isRecord(exemption)) return [];
					const ruleId = optionalString(exemption.ruleId);
					const rationale = optionalString(exemption.rationale);
					return ruleId && rationale ? [{ ruleId, rationale }] : [];
				})
			: undefined;
		if (exemptions?.length) calibration.targetUnitExemptions = exemptions;
		else delete calibration.targetUnitExemptions;
	}
}

function normalizeTargetRecord(value: unknown): GoalTarget | undefined {
	if (!isRecord(value)) return undefined;
	const normalized: Record<string, unknown> = { ...value };
	applyOptionalTargetPlanFields(normalized);
	return cloneTarget(normalized as unknown as GoalTarget);
}

function normalizeTargetPlanRecord(value: unknown): GoalTargetPlanRecord | undefined {
	if (!isRecord(value)) return undefined;
	const normalized: Record<string, unknown> = { ...value };
	const legacyRecoveryKey = "recoveredFrom" + "Failure";
	const legacyRecovery = normalized[legacyRecoveryKey];
	delete normalized[legacyRecoveryKey];
	if (!isRecord(normalized.recoveredFrom) && isRecord(legacyRecovery)) {
		const planId = optionalString(normalized.id) ?? "unknown-target-plan";
		normalized.recoveredFrom = {
			recoveryId: `${planId}-legacy-recovery`,
			blockedStateId: `${planId}-legacy-blocked-state`,
			kind: "target-plan",
			action: "restart_target_planning",
			reason: normalizeRecoveryReason(legacyRecovery.reason),
			guidance: optionalString(legacyRecovery.guidance) ?? "",
			blockers: stringArray(legacyRecovery.blockers),
			at: optionalNumber(legacyRecovery.at) ?? optionalNumber(normalized.updatedAt) ?? 0,
		} satisfies GoalRecoveryLink;
	}
	applyOptionalTargetPlanFields(normalized);
	return cloneTargetPlan(normalized as unknown as GoalTargetPlanRecord);
}

function normalizeBlockedStateRecord(value: unknown): GoalBlockedState | undefined {
	if (!isRecord(value)) return undefined;
	const kind = value.kind;
	if (kind !== "target-plan" && kind !== "checkpoint-external-pause" && kind !== "operator-input-required") {
		return undefined;
	}
	const status: GoalBlockedStateStatus =
		value.status === "resolved" || value.status === "superseded" || value.status === "open" ? value.status : "open";
	const base = {
		id: optionalString(value.id) ?? "",
		sequence: optionalNumber(value.sequence) ?? 0,
		status,
		message: optionalString(value.message) ?? "",
		blockers: stringArray(value.blockers),
		suggestedQuestions: stringArray(value.suggestedQuestions),
		stateVersionAtBlock: optionalNumber(value.stateVersionAtBlock) ?? 0,
		parentFrameVersionAtBlock: optionalNumber(value.parentFrameVersionAtBlock) ?? 0,
		createdAt: optionalNumber(value.createdAt) ?? 0,
		updatedAt: optionalNumber(value.updatedAt) ?? optionalNumber(value.createdAt) ?? 0,
		resolvedAt: optionalNumber(value.resolvedAt),
		recoveryId: optionalString(value.recoveryId),
		supersededAt: optionalNumber(value.supersededAt),
		supersededBy: optionalString(value.supersededBy),
	};
	if (!base.id) return undefined;
	if (kind === "target-plan") {
		const source = isRecord(value.source) ? value.source : undefined;
		const sourceStatus = source?.status === "stale" ? "stale" : source?.status === "failed" ? "failed" : undefined;
		if (!source || !sourceStatus) return undefined;
		return cloneBlockedState({
			...base,
			kind: "target-plan",
			source: {
				targetId: optionalString(source.targetId) ?? "",
				targetSequence: optionalNumber(source.targetSequence) ?? 0,
				targetPlanId: optionalString(source.targetPlanId) ?? "",
				revision: optionalNumber(source.revision) ?? 0,
				status: sourceStatus,
				planFilePath: optionalString(source.planFilePath) ?? "",
			},
			allowedActions: ["restart_target_planning"],
		});
	}
	if (kind === "checkpoint-external-pause") {
		const source = isRecord(value.source) ? value.source : undefined;
		const decision = source?.decision;
		if (!source || !isNonContinuingCheckpointDecision(decision)) return undefined;
		return cloneBlockedState({
			...base,
			kind: "checkpoint-external-pause",
			source: {
				checkpointId: optionalString(source.checkpointId) ?? "",
				checkpointResolutionId: optionalString(source.checkpointResolutionId) ?? "",
				decision,
			},
			broaderChecksOrInputs: stringArray(value.broaderChecksOrInputs),
			remainingParentWork: stringArray(value.remainingParentWork),
			allowedActions: ["start_next_target", "enter_parent_completion"],
		});
	}
	return cloneBlockedState({
		...base,
		kind: "operator-input-required",
		source: {
			reason:
				isRecord(value.source) && value.source.reason === "legacy-migration"
					? "legacy-migration"
					: "ambiguous-controller-state",
		},
		allowedActions: [],
	});
}

function normalizeRecoveryRecord(value: unknown): GoalRecoveryRecord | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.blockedStateId !== "string") return undefined;
	return cloneRecoveryRecord({
		...(value as unknown as GoalRecoveryRecord),
		reason: normalizeRecoveryReason(value.reason),
		blockers: stringArray(value.blockers),
		source: isRecord(value.source) ? ({ ...value.source } as GoalBlockedStateSource) : ({} as GoalBlockedStateSource),
		result: isRecord(value.result)
			? ({ ...value.result } as unknown as GoalRecoveryResultSummary)
			: { runMode: "awaiting-user-input" },
	});
}

export function normalizeGoal(value: unknown): Goal | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.objective !== "string" ||
		typeof value.tokensUsed !== "number" ||
		typeof value.timeUsedSeconds !== "number" ||
		typeof value.createdAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return undefined;
	}
	const goal: Goal = {
		id: value.id,
		objective: value.objective,
		status: normalizeGoalStatus(value.status),
		tokenBudget: optionalNumber(value.tokenBudget),
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		rubric: optionalString(value.rubric),
		deliverableMap: normalizeDeliverableMap(value.deliverableMap ?? value.deliverable_map),
		workEpoch: optionalNumber(value.workEpoch),
		totalVerificationAttempts: optionalNumber(value.totalVerificationAttempts),
		verificationAttempts: normalizeVerificationAttempts(value.verificationAttempts),
		failedCompletionAttempts: optionalNumber(value.failedCompletionAttempts),
		lastVerificationFeedback: optionalString(value.lastVerificationFeedback),
		lastVerificationCompactorMemo: optionalString(value.lastVerificationCompactorMemo),
		lastVerificationAttempt: optionalNumber(value.lastVerificationAttempt),
		lastVerificationAttemptId: optionalString(value.lastVerificationAttemptId),
	};
	const parentFrame = normalizeParentFrame(value.parentFrame, value.objective);
	if (parentFrame) goal.parentFrame = parentFrame;
	if (isRecord(value.currentTarget)) goal.currentTarget = normalizeTargetRecord(value.currentTarget);
	if (Array.isArray(value.targets)) {
		goal.targets = value.targets.flatMap(target => normalizeTargetRecord(target) ?? []);
	}
	if (isRecord(value.currentTargetPlan)) goal.currentTargetPlan = normalizeTargetPlanRecord(value.currentTargetPlan);
	if (Array.isArray(value.targetPlans)) {
		goal.targetPlans = value.targetPlans
			.map(plan => normalizeTargetPlanRecord(plan))
			.filter((plan): plan is GoalTargetPlanRecord => plan !== undefined);
	}
	goal.targetUnitRules = normalizeTargetUnitRules(value.targetUnitRules);
	if (Array.isArray(value.checkpoints)) goal.checkpoints = value.checkpoints as GoalCheckpointPacket[];
	goal.pendingCheckpointId = optionalString(value.pendingCheckpointId);
	if (Array.isArray(value.checkpointResolutions)) {
		goal.checkpointResolutions = value.checkpointResolutions as GoalCheckpointResolution[];
	}
	goal.lastCheckpointResolutionId = optionalString(value.lastCheckpointResolutionId);
	if (isRecord(value.lastCheckpointRejection))
		goal.lastCheckpointRejection = value.lastCheckpointRejection as unknown as GoalCheckpointRejection;
	if (isRecord(value.verificationRepair))
		goal.verificationRepair = value.verificationRepair as unknown as GoalVerificationRepairState;
	if (isRecord(value.currentBlockedState))
		goal.currentBlockedState = normalizeBlockedStateRecord(value.currentBlockedState);
	if (Array.isArray(value.blockedStates)) {
		goal.blockedStates = value.blockedStates
			.map(block => normalizeBlockedStateRecord(block))
			.filter((block): block is GoalBlockedState => block !== undefined);
	}
	if (Array.isArray(value.recoveryHistory)) {
		goal.recoveryHistory = value.recoveryHistory
			.map(record => normalizeRecoveryRecord(record))
			.filter((record): record is GoalRecoveryRecord => record !== undefined);
	}
	return cloneGoal(goal);
}

function hasResolutionForCheckpoint(goal: Goal, checkpointId: string): boolean {
	return goal.checkpointResolutions?.some(resolution => resolution.checkpointId === checkpointId) ?? false;
}

function markTargetPlanStale(goal: Goal, plan: GoalTargetPlanRecord): void {
	const stalePlan = cloneTargetPlan({
		...plan,
		status: "stale",
		updatedAt: Math.max(plan.updatedAt, goal.updatedAt),
	});
	if (!stalePlan) return;
	goal.targetPlans = upsertTargetPlan(goal.targetPlans, stalePlan);
}

function nextBlockedStateSequence(goal: Goal): number {
	const maxHistorical = goal.blockedStates?.reduce((max, block) => Math.max(max, block.sequence), 0) ?? 0;
	const currentSequence = goal.currentBlockedState?.sequence ?? 0;
	return Math.max(maxHistorical, currentSequence) + 1;
}

function currentRecoverableTargetPlan(goal: Goal): GoalTargetPlanRecord | undefined {
	const target = goal.currentTarget;
	const plan = goal.currentTargetPlan;
	if (target?.status !== "active") return undefined;
	if (!plan || plan.targetId !== target.id) return undefined;
	return plan.status === "failed" || plan.status === "stale" ? plan : undefined;
}

function latestNonContinuingCheckpointResolution(goal: Goal): GoalCheckpointResolution | undefined {
	const resolution = goal.checkpointResolutions?.find(item => item.id === goal.lastCheckpointResolutionId);
	return resolution && isNonContinuingCheckpointDecision(resolution.decision) ? resolution : undefined;
}

function targetPlanBlockedStateBlockers(plan: GoalTargetPlanRecord, message: string): string[] {
	if (plan.failure?.blockers.length) return [...plan.failure.blockers];
	const reviewBlockers = plan.reviews.flatMap(review =>
		review.findings
			.filter(finding => finding.severity === "blocking" || finding.severity === "important")
			.map(finding => `${review.lens}:${finding.id}: ${finding.requiredRevision}`),
	);
	return reviewBlockers.length ? reviewBlockers : [message];
}

function blockedStateMatchesCurrentGoal(goal: Goal, block: GoalBlockedState): boolean {
	if (block.kind === "target-plan") {
		const target = goal.currentTarget;
		const plan = goal.currentTargetPlan;
		return (
			target?.status === "active" &&
			target.id === block.source.targetId &&
			target.sequence === block.source.targetSequence &&
			plan?.id === block.source.targetPlanId &&
			plan.revision === block.source.revision &&
			plan.status === block.source.status &&
			plan.planFilePath === block.source.planFilePath
		);
	}
	if (block.kind === "checkpoint-external-pause") {
		const resolution = goal.checkpointResolutions?.find(item => item.id === block.source.checkpointResolutionId);
		return (
			goal.pendingCheckpointId === undefined &&
			goal.lastCheckpointResolutionId === block.source.checkpointResolutionId &&
			resolution?.checkpointId === block.source.checkpointId &&
			resolution.decision === block.source.decision &&
			isNonContinuingCheckpointDecision(resolution.decision)
		);
	}
	return (
		currentRecoverableTargetPlan(goal) === undefined && latestNonContinuingCheckpointResolution(goal) === undefined
	);
}

function installBlockedState(goal: Goal, block: GoalBlockedState): GoalBlockedState {
	const current = goal.currentBlockedState;
	if (current?.status === "open" && current.id !== block.id) {
		const superseded = cloneBlockedState({
			...current,
			status: "superseded",
			updatedAt: block.createdAt,
			supersededAt: block.createdAt,
			supersededBy: block.id,
		});
		if (superseded) goal.blockedStates = upsertBlockedState(goal.blockedStates, superseded);
	}
	const installed = cloneBlockedState(block) ?? block;
	goal.currentBlockedState = installed;
	goal.blockedStates = upsertBlockedState(goal.blockedStates, installed);
	return installed;
}

function synthesizeTargetPlanBlockedState(
	goal: Goal,
	plan: GoalTargetPlanRecord,
	stateVersion: number,
	parentFrameVersion: number,
): GoalBlockedState | undefined {
	const target = goal.currentTarget;
	if (target?.status !== "active" || (plan.status !== "failed" && plan.status !== "stale")) return undefined;
	const message = plan.failure?.message || `target plan is ${plan.status}`;
	const sequence = nextBlockedStateSequence(goal);
	return {
		id: `${goal.id}-blocked-${sequence}`,
		sequence,
		kind: "target-plan",
		status: "open",
		message,
		blockers: targetPlanBlockedStateBlockers(plan, message),
		suggestedQuestions: plan.failure ? [...plan.failure.suggestedQuestions] : [],
		allowedActions: ["restart_target_planning"],
		stateVersionAtBlock: stateVersion,
		parentFrameVersionAtBlock: parentFrameVersion,
		createdAt: goal.updatedAt,
		updatedAt: goal.updatedAt,
		source: {
			targetId: target.id,
			targetSequence: target.sequence,
			targetPlanId: plan.id,
			revision: plan.revision,
			status: plan.status,
			planFilePath: plan.planFilePath,
		},
	};
}

function synthesizeCheckpointBlockedState(
	goal: Goal,
	resolution: GoalCheckpointResolution,
	stateVersion: number,
	parentFrameVersion: number,
): GoalBlockedState {
	const message = "Checkpoint resolution is awaiting user, broader-check, or external input.";
	const blockers = resolution.broaderChecksOrInputs.length
		? [...resolution.broaderChecksOrInputs]
		: resolution.remainingParentWork.length
			? [...resolution.remainingParentWork]
			: [message];
	const sequence = nextBlockedStateSequence(goal);
	return {
		id: `${goal.id}-blocked-${sequence}`,
		sequence,
		kind: "checkpoint-external-pause",
		status: "open",
		message,
		blockers,
		suggestedQuestions: [...resolution.broaderChecksOrInputs],
		allowedActions: ["start_next_target", "enter_parent_completion"],
		stateVersionAtBlock: stateVersion,
		parentFrameVersionAtBlock: parentFrameVersion,
		createdAt: goal.updatedAt,
		updatedAt: goal.updatedAt,
		source: {
			checkpointId: resolution.checkpointId,
			checkpointResolutionId: resolution.id,
			decision: resolution.decision as Extract<
				GoalCheckpointResolutionDecision,
				"needs_user_input" | "needs_broader_checks" | "pause_for_external_control" | "drop_or_replace_recommended"
			>,
		},
		broaderChecksOrInputs: [...resolution.broaderChecksOrInputs],
		remainingParentWork: [...resolution.remainingParentWork],
	};
}

function synthesizeOperatorBlockedState(
	goal: Goal,
	stateVersion: number,
	parentFrameVersion: number,
): GoalBlockedState {
	const message = "Goal is awaiting user input without a recoverable blocked source.";
	const sequence = nextBlockedStateSequence(goal);
	return {
		id: `${goal.id}-blocked-${sequence}`,
		sequence,
		kind: "operator-input-required",
		status: "open",
		message,
		blockers: [message],
		suggestedQuestions: [],
		allowedActions: [],
		stateVersionAtBlock: stateVersion,
		parentFrameVersionAtBlock: parentFrameVersion,
		createdAt: goal.updatedAt,
		updatedAt: goal.updatedAt,
		source: { reason: "ambiguous-controller-state" },
	};
}

export function synthesizeBlockedStateForAwaitingInput(
	goal: Goal,
	runMode: GoalRunMode,
	stateVersion: number,
	parentFrameVersion: number,
): GoalBlockedState | undefined {
	if (runMode !== "awaiting-user-input") {
		const current = goal.currentBlockedState;
		if (current?.status === "open") {
			const superseded = cloneBlockedState({
				...current,
				status: "superseded",
				updatedAt: current.updatedAt,
				supersededAt: current.updatedAt,
			});
			if (superseded) goal.blockedStates = upsertBlockedState(goal.blockedStates, superseded);
		}
		goal.currentBlockedState = undefined;
		return undefined;
	}
	const current = goal.currentBlockedState;
	if (current?.status === "open" && blockedStateMatchesCurrentGoal(goal, current)) {
		goal.blockedStates = upsertBlockedState(goal.blockedStates, current);
		return current;
	}
	const plan = currentRecoverableTargetPlan(goal);
	if (plan) {
		const block = synthesizeTargetPlanBlockedState(goal, plan, stateVersion, parentFrameVersion);
		return block ? installBlockedState(goal, block) : undefined;
	}
	const resolution = latestNonContinuingCheckpointResolution(goal);
	if (resolution) {
		return installBlockedState(
			goal,
			synthesizeCheckpointBlockedState(goal, resolution, stateVersion, parentFrameVersion),
		);
	}
	return installBlockedState(goal, synthesizeOperatorBlockedState(goal, stateVersion, parentFrameVersion));
}

export function normalizeGoalModeState(value: unknown): GoalModeState | undefined {
	if (!isRecord(value)) return undefined;
	const goal = normalizeGoal(value.goal);
	if (!goal) return undefined;
	let mode = normalizeLifecycle(value.mode);
	let runMode = normalizeRunMode(value.runMode);
	let reason: "completed" | undefined = value.reason === "completed" ? "completed" : undefined;
	const stateVersion = optionalNumber(value.stateVersion) ?? 0;
	const parentFrameVersion = optionalNumber(value.parentFrameVersion) ?? (goal.parentFrame ? 1 : 0);
	if (goal.status === "complete" || (mode === "exiting" && reason === "completed")) {
		mode = "exiting";
		reason = "completed";
		runMode = "completed";
	}
	if (
		goal.pendingCheckpointId !== undefined &&
		runMode !== "awaiting-checkpoint-resolution" &&
		hasResolutionForCheckpoint(goal, goal.pendingCheckpointId)
	) {
		goal.pendingCheckpointId = undefined;
	}
	if (runMode === "planning-target") {
		const currentTarget = goal.currentTarget;
		const currentPlan = goal.currentTargetPlan;
		if (!currentTarget) {
			if (currentPlan) markTargetPlanStale(goal, currentPlan);
			goal.currentTargetPlan = undefined;
			runMode = "awaiting-user-input";
		} else if (!currentPlan || currentPlan.targetId !== currentTarget.id) {
			if (currentPlan) markTargetPlanStale(goal, currentPlan);
			goal.currentTargetPlan = undefined;
			runMode = "awaiting-user-input";
		} else if (currentPlan.status === "approved") {
			runMode = "working-target";
		}
	}
	synthesizeBlockedStateForAwaitingInput(goal, runMode, stateVersion, parentFrameVersion);
	return {
		enabled: value.enabled === true,
		mode,
		runMode,
		reason,
		stateVersion,
		parentFrameVersion,
		goal,
	};
}

export function serializeGoalModeState(state: GoalModeState): SerializedGoalModeState {
	const normalized = normalizeGoalModeState(state);
	if (!normalized) {
		throw new Error("cannot serialize invalid goal mode state");
	}
	return {
		schemaVersion: GOAL_MODE_SCHEMA_VERSION,
		enabled: normalized.enabled,
		mode: normalized.mode,
		runMode: normalized.runMode,
		reason: normalized.reason,
		stateVersion: normalized.stateVersion,
		parentFrameVersion: normalized.parentFrameVersion,
		goal: normalized.goal,
	};
}

export function parseGoalModeState(modeData: unknown, fallbackEnabled?: boolean): GoalModeState | undefined {
	if (!isRecord(modeData)) return undefined;
	const direct = normalizeGoalModeState(modeData);
	if (direct) {
		return fallbackEnabled === undefined ? direct : { ...direct, enabled: fallbackEnabled };
	}
	const serialized = isRecord(modeData.state) ? normalizeGoalModeState(modeData.state) : undefined;
	if (serialized) {
		return fallbackEnabled === undefined ? serialized : { ...serialized, enabled: fallbackEnabled };
	}
	const legacyGoal = normalizeGoal(modeData.goal);
	if (!legacyGoal) return undefined;
	return {
		enabled: fallbackEnabled ?? true,
		mode: legacyGoal.status === "complete" ? "exiting" : "active",
		runMode: legacyGoal.status === "complete" ? "completed" : "working-target",
		stateVersion: 0,
		parentFrameVersion: legacyGoal.parentFrame ? 1 : 0,
		goal: legacyGoal,
	};
}
