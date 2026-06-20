import type {
	Goal,
	GoalCheckpointPacket,
	GoalCheckpointResolution,
	GoalCheckpointReview,
	GoalCompletionVerificationDetails,
	GoalModeState,
	GoalTarget,
	GoalTargetPlanApprovedDetails,
	GoalTargetPlanRecord,
	GoalTargetPlanReview,
	GoalToolCheckpointResolutionSummary,
	GoalToolCheckpointSummary,
	GoalToolDetails,
	GoalToolGoalSummary,
	GoalToolStateSummary,
	GoalToolTargetPlanSummary,
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
	targetPlan?: GoalTargetPlanRecord;
	targetPlanReviews?: GoalTargetPlanReview[];
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

export function summarizeTargetPlan(
	plan: GoalTargetPlanRecord | undefined,
	reviews: GoalTargetPlanReview[] = plan?.reviews ?? [],
): GoalToolTargetPlanSummary | undefined {
	if (!plan) return undefined;
	return {
		id: plan.id,
		targetPlanId: plan.id,
		targetId: plan.targetId,
		planFilePath: plan.planFilePath,
		status: plan.status,
		revision: plan.revision,
		reviews: reviews.map(review => ({
			lens: review.lens,
			status: review.status,
			feedback: review.feedback,
			findingCount: review.findings.length,
			blockingFindingCount: review.findings.filter(finding => finding.severity === "blocking").length,
		})),
		failure: plan.failure
			? {
					stage: plan.failure.stage,
					reason: plan.failure.reason,
					message: plan.failure.message,
					blockers: [...plan.failure.blockers],
				}
			: undefined,
		recoveredFromFailure: plan.recoveredFromFailure
			? {
					sourceTargetPlanId: plan.recoveredFromFailure.sourceTargetPlanId,
					sourceRevision: plan.recoveredFromFailure.sourceRevision,
					reason: plan.recoveredFromFailure.reason,
					guidance: plan.recoveredFromFailure.guidance,
					blockers: [...plan.recoveredFromFailure.blockers],
				}
			: undefined,
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
		targetPlan: summarizeTargetPlan(source.targetPlan, source.targetPlanReviews),
	};
}
