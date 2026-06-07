import type { BackgroundLane, BackgroundLaneSpawnRequest } from "../background-lanes/state";
import { cloneBackgroundLane, normalizeBackgroundLanes } from "../background-lanes/state";
import type { UsageStatistics } from "../session/session-manager";

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";
export type GoalVerificationStatus = "verified" | "rejected" | "stale" | "max-attempts";
export type GoalVerificationGateStatus = "passed" | "failed" | "unknown";
export type GoalVerificationGapSeverity = "blocking" | "important" | "polish";
export type GoalModeLifecycle = "active" | "exiting";
export type GoalRunMode =
	| "working-target"
	| "completed"
	| "awaiting-checkpoint-resolution"
	| "awaiting-parent-completion"
	| "awaiting-verification-repair"
	| "awaiting-background-lane-intake"
	| "awaiting-user-input";
export const GOAL_MODE_SCHEMA_VERSION = 2;

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

export interface GoalTarget {
	id: string;
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
	backgroundLanesToSpawn?: BackgroundLaneSpawnRequest[];
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
	checkpoints?: GoalCheckpointPacket[];
	pendingCheckpointId?: string;
	checkpointResolutions?: GoalCheckpointResolution[];
	lastCheckpointResolutionId?: string;
	lastCheckpointRejection?: GoalCheckpointRejection;
	verificationRepair?: GoalVerificationRepairState;
	backgroundLanes?: BackgroundLane[];
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

export interface GoalToolDetails {
	op: "create" | "get" | "complete" | "resume" | "drop" | "start_target" | "checkpoint" | "resolve_checkpoint";
	goal?: Goal | null;
	state?: GoalModeState | null;
	remainingTokens?: number | null;
	completionBudgetReport?: string | null;
	completionVerification?: GoalCompletionVerificationDetails;
	checkpoint?: GoalCheckpointPacket;
	checkpointReview?: GoalCheckpointReview;
	checkpointResolution?: GoalCheckpointResolution;
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
		case "completed":
		case "awaiting-checkpoint-resolution":
		case "awaiting-parent-completion":
		case "awaiting-verification-repair":
		case "awaiting-background-lane-intake":
		case "awaiting-user-input":
			return value;
		default:
			return "working-target";
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
		backgroundLanesToSpawn: delta.backgroundLanesToSpawn
			? delta.backgroundLanesToSpawn.map(request => ({
					from: { ...request.from },
					contract: { ...request.contract },
					assignment: request.assignment,
					agent: request.agent,
				}))
			: undefined,
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
		parentFrame: cloneParentFrame(goal.parentFrame),
		currentTarget: cloneTarget(goal.currentTarget),
		targets: goal.targets
			?.map(target => cloneTarget(target))
			.filter((target): target is GoalTarget => target !== undefined),
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
		backgroundLanes: goal.backgroundLanes?.map(cloneBackgroundLane),
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
	if (isRecord(value.currentTarget)) goal.currentTarget = value.currentTarget as unknown as GoalTarget;
	if (Array.isArray(value.targets)) goal.targets = value.targets as GoalTarget[];
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
	const backgroundLanes = normalizeBackgroundLanes(value.backgroundLanes);
	if (backgroundLanes) goal.backgroundLanes = backgroundLanes;
	return cloneGoal(goal);
}

export function normalizeGoalModeState(value: unknown): GoalModeState | undefined {
	if (!isRecord(value)) return undefined;
	const goal = normalizeGoal(value.goal);
	if (!goal) return undefined;
	let mode = normalizeLifecycle(value.mode);
	let runMode = normalizeRunMode(value.runMode);
	let reason: "completed" | undefined = value.reason === "completed" ? "completed" : undefined;
	if (goal.status === "complete" || (mode === "exiting" && reason === "completed")) {
		mode = "exiting";
		reason = "completed";
		runMode = "completed";
	}
	return {
		enabled: value.enabled === true,
		mode,
		runMode,
		reason,
		stateVersion: optionalNumber(value.stateVersion) ?? 0,
		parentFrameVersion: optionalNumber(value.parentFrameVersion) ?? (goal.parentFrame ? 1 : 0),
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
