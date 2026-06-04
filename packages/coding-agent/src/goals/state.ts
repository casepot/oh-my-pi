import type { UsageStatistics } from "../session/session-manager";

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";
export type GoalVerificationStatus = "verified" | "rejected" | "stale" | "max-attempts";
export type GoalVerificationGateStatus = "passed" | "failed" | "unknown";
export type GoalVerificationGapSeverity = "blocking" | "important" | "polish";

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
}

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
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
	op: "create" | "get" | "complete" | "resume" | "drop";
	goal?: Goal | null;
	remainingTokens?: number | null;
	completionBudgetReport?: string | null;
	completionVerification?: GoalCompletionVerificationDetails;
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export type GoalTokenUsage = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite">;

export type GoalBudgetSteering = "allowed" | "suppressed";
export type GoalTerminalMetricEmission = "emit" | "suppress";
