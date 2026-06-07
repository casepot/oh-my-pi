import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type {
	BackgroundLane,
	BackgroundLaneAgentHandle,
	BackgroundLaneBranchHandle,
	BackgroundLaneCloseDisposition,
	BackgroundLanePatchSnapshot,
	BackgroundLaneReport,
	BackgroundLaneSpawnFailure,
} from "../background-lanes/state";
import {
	cloneBackgroundLane,
	requiredBlockingBackgroundLanes,
	structuredBlockingBackgroundLanes,
} from "../background-lanes/state";
import goalBudgetLimitPrompt from "../prompts/goals/goal-budget-limit.md" with { type: "text" };
import goalContinuationPrompt from "../prompts/goals/goal-continuation.md" with { type: "text" };
import goalModeActivePrompt from "../prompts/goals/goal-mode-active.md" with { type: "text" };
import type {
	Goal,
	GoalBudgetSteering,
	GoalCheckpointEvidenceItem,
	GoalCheckpointPacket,
	GoalCheckpointResolution,
	GoalCheckpointResolutionDecision,
	GoalCheckpointReview,
	GoalCheckpointStatus,
	GoalCompletionVerifierStructuredOutput,
	GoalDeliverableDelta,
	GoalDeliverableMapItem,
	GoalModeState,
	GoalParentFrame,
	GoalParentStateDelta,
	GoalRef,
	GoalRunMode,
	GoalRuntimeEvent,
	GoalTarget,
	GoalTokenUsage,
	GoalVerificationAttempt,
	GoalVerificationGap,
	GoalVerificationRepairState,
	GoalVerificationStatus,
} from "./state";
import {
	cloneCheckpoint,
	cloneGoal,
	cloneGoalModeState,
	cloneParentFrame,
	cloneTarget,
	normalizeParentFrame,
} from "./state";

export interface GoalRuntimeHost {
	getState(): GoalModeState | undefined;
	setState(state: GoalModeState | undefined): void;
	getCurrentUsage(): GoalTokenUsage;
	emit(event: GoalRuntimeEvent): void | Promise<void>;
	persist(mode: "goal" | "goal_paused" | "none", state?: GoalModeState): void;
	sendHiddenMessage(message: {
		customType: string;
		content: string;
		deliverAs?: "steer" | "followUp" | "nextTurn";
	}): Promise<void>;
	now?(): number;
}

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
	transition:
		| "target-checkpoint"
		| "context-compaction"
		| "verification-rejected"
		| "parent-completion-candidate"
		| "background-lane-blocked";
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
		backgroundLaneCount: delta.backgroundLanesToSpawn?.length ?? 0,
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
		backgroundLanes: goal.backgroundLanes?.map(lane => ({
			id: lane.id,
			status: lane.status,
			question: lane.contract.question,
			requiredBeforeParent: lane.contract.requiredBeforeParent,
		})),
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
		case "awaiting-checkpoint-resolution":
			return ["Inspect checkpoint guidance", 'Call goal({ op: "resolve_checkpoint", ... })'];
		case "completed":
			return ["Report completed parent goal outcome"];
		case "awaiting-parent-completion":
			return ['Call goal({ op: "complete" }) for parent completion verification'];
		case "awaiting-verification-repair":
			return ["Repair verifier blockers", "Start a blocker-scoped target", "Gather fresh evidence"];
		case "awaiting-background-lane-intake":
			return ["Disposition blocked background lanes before ordinary implementation resumes"];
		case "awaiting-user-input":
			return ["Wait for user input, broader checks, or external authority"];
		default:
			return [
				"Continue current target",
				"Start a target if none exists",
				"Checkpoint only after target closure evidence",
			];
	}
}

function disallowedActsForRunMode(runMode: GoalRunMode): string[] {
	switch (runMode) {
		case "awaiting-checkpoint-resolution":
			return ["Continue local implementation", "Mutate parent frame in prose", "Call complete before resolution"];
		case "completed":
			return ["Resume local implementation under the completed goal"];
		case "awaiting-parent-completion":
			return ["Continue local implementation", "Start another target", "Checkpoint target work"];
		case "awaiting-verification-repair":
			return ["Retry complete without fresh repair/evidence", "Choose unrelated work"];
		case "awaiting-background-lane-intake":
			return ["Continue local implementation", "Start unrelated target work", "Retry complete before lane intake"];
		case "awaiting-user-input":
			return ["Auto-continue ordinary work"];
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
		goalStateSnapshot: renderGoalStateSnapshot(state, goal),
		parentFrame: escapeJsonForPrompt(goal.parentFrame ?? null),
		currentTarget: escapeJsonForPrompt(goal.currentTarget ?? null),
		pendingCheckpoint: escapeJsonForPrompt(latestCheckpoint(goal) ?? null),
		latestCheckpointResolution: escapeJsonForPrompt(latestResolution(goal) ?? null),
		verificationRepair: escapeJsonForPrompt(goal.verificationRepair ?? null),
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

function upsertStrings(values: string[], additions: string[]): string[] {
	const output = [...values];
	for (const addition of additions) {
		const clean = addition.trim();
		if (clean && !output.includes(clean)) output.push(clean);
	}
	return output;
}

function includesEquivalentClaim(values: string[], candidate: string): boolean {
	const normalizedCandidate = candidate.toLowerCase();
	return values.some(value => {
		const normalized = value.toLowerCase();
		return normalized === normalizedCandidate || normalized.includes(normalizedCandidate);
	});
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
		options?: { persist?: "goal" | "goal_paused" | "none"; emit?: boolean },
	): Promise<void> {
		this.#host.setState(state ? cloneGoalModeState(state) : undefined);
		if (options?.persist) {
			this.#host.persist(options.persist, state);
		}
		if (options?.emit !== false) {
			await this.#host.emit({ type: "goal_updated", goal: state ? cloneGoal(state.goal) : null, state });
		}
	}

	#requiredLaneCompletionBlockers(goal: Goal): BackgroundLane[] {
		return requiredBlockingBackgroundLanes(goal.backgroundLanes);
	}

	#structuredLaneIntakeBlockers(goal: Goal): BackgroundLane[] {
		return structuredBlockingBackgroundLanes(goal.backgroundLanes);
	}

	#assertNoBackgroundLaneCompletionBlockers(goal: Goal): void {
		const required = this.#requiredLaneCompletionBlockers(goal);
		if (required.length > 0) {
			throw new Error(
				`cannot complete parent goal while required background lanes remain undispositioned: ${required.map(lane => lane.id).join(", ")}`,
			);
		}
		const blocked = this.#structuredLaneIntakeBlockers(goal);
		if (blocked.length > 0) {
			throw new Error(
				`cannot complete parent goal while background lane blockers require intake: ${blocked.map(lane => lane.id).join(", ")}`,
			);
		}
	}

	#assertNoBackgroundLaneIntake(state: GoalModeState, action: string): void {
		if (state.runMode !== "awaiting-background-lane-intake") return;
		const blocked = this.#structuredLaneIntakeBlockers(state.goal);
		const suffix = blocked.length ? `: ${blocked.map(lane => lane.id).join(", ")}` : "";
		throw new Error(`${action} is blocked until background lane intake is recorded${suffix}`);
	}

	async #updateBackgroundLane(
		laneId: string,
		update: (lane: BackgroundLane, state: GoalModeState) => BackgroundLane,
		options?: { runMode?: GoalRunMode },
	): Promise<GoalModeState> {
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.goal) throw new Error("cannot update background lane because no goal exists");
			const lanes = state.goal.backgroundLanes ?? [];
			const index = lanes.findIndex(lane => lane.id === laneId);
			if (index === -1) throw new Error(`unknown background lane: ${laneId}`);
			const next = lanes.map((lane, laneIndex) =>
				laneIndex === index ? update(cloneBackgroundLane(lane), state) : cloneBackgroundLane(lane),
			);
			state.goal.backgroundLanes = next;
			if (options?.runMode) state.runMode = options.runMode;
			else if (
				state.runMode === "awaiting-background-lane-intake" &&
				this.#structuredLaneIntakeBlockers(state.goal).length === 0
			) {
				state.runMode = "working-target";
			}
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	#bumpState(state: GoalModeState, options?: { parentFrameChanged?: boolean }): void {
		state.stateVersion += 1;
		if (options?.parentFrameChanged) state.parentFrameVersion += 1;
		state.goal.updatedAt = this.#now();
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

		await this.#commitState(state, { persist: "goal" });

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
	): Promise<GoalModeState | undefined> {
		const trimmedRubric = rubric.trim();
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.id !== goalId || state.goal.status !== "active") return undefined;
			state.goal.rubric = trimmedRubric || undefined;
			state.goal.deliverableMap = deliverableMap?.length ? cloneDeliverableMapForState(deliverableMap) : undefined;
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
			await this.#commitState(state, { persist: "goal" });
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
			await this.#flushUsageLocked("suppressed");
			const state = this.#getStateClone();
			if (!state?.goal) return undefined;
			const dropped = { ...state.goal, status: "dropped" as const, updatedAt: this.#now() };
			const droppedState: GoalModeState = {
				...state,
				enabled: false,
				goal: dropped,
				stateVersion: state.stateVersion + 1,
			};
			this.#clearActiveAccounting();
			this.#budgetReportedFor = undefined;
			await this.#host.emit({ type: "goal_updated", goal: dropped, state: droppedState });
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
			if (state.goal.pendingCheckpointId) {
				throw new Error("cannot complete parent goal while a checkpoint is pending resolution");
			}
			if (state.goal.verificationRepair) {
				throw new Error("cannot retry parent completion until verifier blockers have fresh repair evidence");
			}
			this.#assertNoBackgroundLaneCompletionBlockers(state.goal);
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
			this.#assertNoBackgroundLaneIntake(state, "start_target");
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
			state.runMode = "working-target";
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	buildCheckpointCandidate(input: GoalCheckpointInput): GoalCheckpointPacket {
		const state = this.#getStateClone();
		if (!state?.enabled || state.goal.status !== "active")
			throw new Error("cannot checkpoint because no active parent goal exists");
		this.#assertNoBackgroundLaneIntake(state, "checkpoint");
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
			this.#assertNoBackgroundLaneIntake(state, "resolve_checkpoint");
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
			let clearPending = false;
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
				runMode = "working-target";
				clearPending = true;
			} else if (input.decision === "parent_completion_candidate") {
				runMode = "awaiting-parent-completion";
				clearPending = true;
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
			if (clearPending) state.goal.pendingCheckpointId = undefined;
			state.runMode = runMode;
			this.#bumpState(state, { parentFrameChanged });
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	async recordBackgroundLaneCreated(lane: BackgroundLane): Promise<GoalModeState> {
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.enabled || state.goal.status !== "active")
				throw new Error("cannot create background lane because no active parent goal exists");
			if (state.goal.backgroundLanes?.some(existing => existing.id === lane.id)) {
				throw new Error(`background lane already exists: ${lane.id}`);
			}
			state.goal.backgroundLanes = [...(state.goal.backgroundLanes ?? []), cloneBackgroundLane(lane)];
			this.#bumpState(state);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	async recordBackgroundLaneBranch(laneId: string, branch: BackgroundLaneBranchHandle): Promise<GoalModeState> {
		return await this.#updateBackgroundLane(laneId, lane => ({
			...lane,
			branch: { ...lane.branch, ...branch },
			agent: { ...lane.agent, status: lane.agent.status === "failed" ? "starting" : lane.agent.status },
			updatedAt: this.#now(),
		}));
	}

	async recordBackgroundLaneAgent(laneId: string, agent: Partial<BackgroundLaneAgentHandle>): Promise<GoalModeState> {
		return await this.#updateBackgroundLane(laneId, lane => ({
			...lane,
			agent: { ...lane.agent, ...agent, status: agent.status ?? lane.agent.status },
			updatedAt: this.#now(),
		}));
	}

	async recordBackgroundLaneSpawnFailed(
		laneId: string,
		input: BackgroundLaneSpawnFailure & { branchName?: string },
	): Promise<GoalModeState> {
		return await this.#updateBackgroundLane(laneId, lane => ({
			...lane,
			branch: input.branchName ? { ...lane.branch, name: lane.branch.name ?? input.branchName } : lane.branch,
			agent: { ...lane.agent, status: "failed" },
			status: "spawn_failed",
			spawnFailure: {
				stage: input.stage,
				message: input.message,
				retryable: true,
				failedAt: input.failedAt,
			},
			retryable: true,
			updatedAt: this.#now(),
		}));
	}

	async recordBackgroundLaneSnapshot(laneId: string, snapshot: BackgroundLanePatchSnapshot): Promise<GoalModeState> {
		return await this.#updateBackgroundLane(laneId, lane => ({
			...lane,
			latestSnapshot: {
				...snapshot,
				changedFiles: [...snapshot.changedFiles],
			},
			latestPatchRef: snapshot.patchRef ?? lane.latestPatchRef,
			changedFiles: snapshot.changedFiles.length > 0 ? [...snapshot.changedFiles] : lane.changedFiles,
			updatedAt: this.#now(),
		}));
	}

	async recordBackgroundLaneReport(laneId: string, report: BackgroundLaneReport): Promise<GoalModeState> {
		return await this.#updateBackgroundLane(
			laneId,
			lane => {
				const evidenceRefs = upsertStrings(lane.evidenceRefs, report.evidenceRefs);
				const changedFiles = upsertStrings(lane.changedFiles, report.changedFiles);
				const nonClaims = upsertStrings(lane.nonClaims, report.nonClaims);
				const staleIf = upsertStrings(lane.staleIf, report.staleIf);
				return {
					...lane,
					status: report.blocksIfFired ? "blocked" : lane.status === "spawn_failed" ? "open" : lane.status,
					blocksIfFired: lane.blocksIfFired || report.blocksIfFired,
					latestReportRef: report.artifactRef ?? report.sessionMessageRef ?? lane.latestReportRef,
					changedFiles,
					evidenceRefs,
					nonClaims,
					staleIf,
					reports: [...lane.reports, { ...report }],
					updatedAt: this.#now(),
				};
			},
			report.blocksIfFired ? { runMode: "awaiting-background-lane-intake" } : undefined,
		);
	}

	async recordBackgroundLaneReportSessionRef(
		laneId: string,
		reportId: string,
		sessionMessageRef: string,
	): Promise<GoalModeState> {
		return await this.#updateBackgroundLane(laneId, lane => ({
			...lane,
			reports: lane.reports.map(report =>
				report.id === reportId ? { ...report, sessionMessageRef } : { ...report },
			),
			latestReportRef: lane.latestReportRef ?? sessionMessageRef,
			updatedAt: this.#now(),
		}));
	}

	async recordBackgroundLaneClosed(
		laneId: string,
		closeDisposition: BackgroundLaneCloseDisposition,
	): Promise<GoalModeState> {
		return await this.#updateBackgroundLane(laneId, lane => ({
			...lane,
			status: "closed",
			outcome: closeDisposition.outcome,
			closeDisposition: { ...closeDisposition },
			retryable: undefined,
			spawnFailure: undefined,
			updatedAt: this.#now(),
		}));
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
