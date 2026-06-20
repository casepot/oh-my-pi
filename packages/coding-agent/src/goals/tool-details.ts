import type {
	Goal,
	GoalCheckpointPacket,
	GoalCheckpointResolution,
	GoalCheckpointReview,
	GoalCompletionVerificationDetails,
	GoalModeState,
	GoalTarget,
	GoalTargetPlanApprovedDetails,
	GoalToolCheckpointResolutionSummary,
	GoalToolCheckpointSummary,
	GoalToolDetails,
	GoalToolGoalSummary,
	GoalToolStateSummary,
	GoalToolTargetSummary,
} from "./state";

export interface GoalToolDetailSource {
	goal: Goal | null;
	state?: GoalModeState | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
	completionVerification?: GoalCompletionVerificationDetails;
	checkpoint?: GoalCheckpointPacket;
	checkpointReview?: GoalCheckpointReview;
	checkpointResolution?: GoalCheckpointResolution;
	targetPlanApproval?: GoalTargetPlanApprovedDetails;
}

export function summarizeTarget(target: GoalTarget | undefined): GoalToolTargetSummary | undefined {
	if (!target) return undefined;
	return {
		id: target.id,
		title: target.title,
		status: target.status,
	};
}

export function summarizeGoal(goal: Goal | null): GoalToolGoalSummary | null {
	if (!goal) return null;
	const pendingCheckpointId = goal.pendingCheckpointId;
	const pendingCheckpointResolved = pendingCheckpointId
		? goal.checkpointResolutions?.some(resolution => resolution.checkpointId === pendingCheckpointId) === true
		: false;
	return {
		id: goal.id,
		objective: goal.objective,
		status: goal.status,
		tokenBudget: goal.tokenBudget,
		tokensUsed: goal.tokensUsed,
		timeUsedSeconds: goal.timeUsedSeconds,
		currentTarget: summarizeTarget(goal.currentTarget),
		pendingCheckpointId,
		pendingCheckpointRequiresResolution: pendingCheckpointId !== undefined && !pendingCheckpointResolved,
	};
}

export function summarizeState(state: GoalModeState | null | undefined): GoalToolStateSummary | null {
	if (!state) return null;
	return {
		enabled: state.enabled,
		runMode: state.runMode,
		stateVersion: state.stateVersion,
		parentFrameVersion: state.parentFrameVersion,
		goalId: state.goal.id,
	};
}

export function summarizeCheckpoint(
	checkpoint: GoalCheckpointPacket | undefined,
): GoalToolCheckpointSummary | undefined {
	if (!checkpoint) return undefined;
	return {
		id: checkpoint.id,
		sequence: checkpoint.sequence,
		targetId: checkpoint.targetId,
		summary: checkpoint.summary,
		notClaimed: checkpoint.notClaimed,
		remainingQuestions: checkpoint.remainingQuestions,
	};
}

export function summarizeCheckpointReview(
	review: GoalCheckpointReview | undefined,
): Pick<GoalCheckpointReview, "status" | "feedback"> | undefined {
	if (!review) return undefined;
	return {
		status: review.status,
		feedback: review.feedback,
	};
}

export function summarizeCheckpointResolution(
	resolution: GoalCheckpointResolution | undefined,
): GoalToolCheckpointResolutionSummary | undefined {
	if (!resolution) return undefined;
	return {
		id: resolution.id,
		checkpointId: resolution.checkpointId,
		decision: resolution.decision,
		nextTarget: summarizeTarget(resolution.nextTarget),
	};
}

export function buildGoalToolDetails(op: GoalToolDetails["op"], source: GoalToolDetailSource): GoalToolDetails {
	return {
		op,
		goal: summarizeGoal(source.goal),
		state: summarizeState(source.state),
		remainingTokens: source.remainingTokens,
		completionBudgetReport:
			source.completionVerification?.status === "rejected" ? null : source.completionBudgetReport,
		completionVerification: source.completionVerification,
		checkpoint: summarizeCheckpoint(source.checkpoint),
		checkpointReview: summarizeCheckpointReview(source.checkpointReview),
		checkpointResolution: summarizeCheckpointResolution(source.checkpointResolution),
		targetPlanApproval: source.targetPlanApproval,
	};
}
