import type {
	Goal,
	GoalBlockedState,
	GoalCheckpointPacket,
	GoalCheckpointResolution,
	GoalCheckpointReview,
	GoalCompletionVerificationDetails,
	GoalModeState,
	GoalRecoveryRecord,
	GoalTarget,
	GoalTargetPlanApprovedDetails,
	GoalTargetPlanLintResult,
	GoalTargetPlanRecord,
	GoalTargetPlanReview,
	GoalToolBlockedStateSummary,
	GoalToolCheckpointResolutionSummary,
	GoalToolCheckpointSummary,
	GoalToolDetails,
	GoalToolGoalSummary,
	GoalToolRecoverySummary,
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
	targetPlanLint?: GoalTargetPlanLintResult;
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

export function matrixRowCounts(
	plan: Pick<GoalTargetPlanRecord, "scenarioMatrix"> | undefined,
): { inScope: number; leftOpen: number } | undefined {
	if (!plan?.scenarioMatrix) return undefined;
	return {
		inScope: plan.scenarioMatrix.rowsInScope.length,
		leftOpen: plan.scenarioMatrix.rowsLeftOpen.length,
	};
}

export function implementationFanoutRequired(plan: GoalTargetPlanRecord | undefined): boolean | undefined {
	if (!plan) return undefined;
	if (plan.planDepth === "light") return false;
	const nonDocWorkstreams =
		plan.targetCard?.workstreams?.filter(workstream => workstream.kind !== "docs-changelog") ?? [];
	if (nonDocWorkstreams.length >= 2) return true;
	if (
		(plan.verificationAperture?.blastRadius === "multi-subsystem" ||
			plan.verificationAperture?.blastRadius === "external-or-irreversible") &&
		nonDocWorkstreams.length !== 1
	) {
		return true;
	}
	return false;
}

export function summarizeTargetPlan(
	plan: GoalTargetPlanRecord | undefined,
	reviews: GoalTargetPlanReview[] = plan?.reviews ?? [],
	lint?: GoalTargetPlanLintResult,
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
		recoveredFrom: plan.recoveredFrom
			? {
					...plan.recoveredFrom,
					blockers: [...plan.recoveredFrom.blockers],
				}
			: undefined,
		planDepth: plan.planDepth,
		primarySignalGroupId: plan.primarySignalGroupId ?? plan.verificationAperture?.primarySignalId,
		matrixRowCounts: matrixRowCounts(plan),
		implementationFanoutRequired: implementationFanoutRequired(plan),
		lintSummary: lint ? { errorCount: lint.summary.errorCount, warningCount: lint.summary.warningCount } : undefined,
	};
}

export function summarizeBlockedState(block: GoalBlockedState | undefined): GoalToolBlockedStateSummary | undefined {
	if (!block) return undefined;
	return {
		id: block.id,
		kind: block.kind,
		status: block.status,
		message: block.message,
		blockers: [...block.blockers],
		suggestedQuestions: [...block.suggestedQuestions],
		allowedActions: [...block.allowedActions],
		source: { ...block.source },
		requiredOperation: block.allowedActions.length ? "recover_blocked_state" : undefined,
		broaderChecksOrInputs: block.kind === "checkpoint-external-pause" ? [...block.broaderChecksOrInputs] : undefined,
		remainingParentWork: block.kind === "checkpoint-external-pause" ? [...block.remainingParentWork] : undefined,
	};
}

export function summarizeRecovery(recovery: GoalRecoveryRecord | undefined): GoalToolRecoverySummary | undefined {
	if (!recovery) return undefined;
	return {
		id: recovery.id,
		blockedStateId: recovery.blockedStateId,
		kind: recovery.kind,
		action: recovery.action,
		reason: recovery.reason,
		guidance: recovery.guidance,
		blockers: [...recovery.blockers],
		result: { ...recovery.result },
		at: recovery.at,
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
		targetPlan: summarizeTargetPlan(source.targetPlan, source.targetPlanReviews, source.targetPlanLint),
		targetPlanLint: source.targetPlanLint,
		blockedState: summarizeBlockedState(source.goal?.currentBlockedState),
		recovery: summarizeRecovery(
			op === "recover_blocked_state" ? source.state?.goal.recoveryHistory?.at(-1) : undefined,
		),
	};
}
