import { prompt } from "@oh-my-pi/pi-utils";
import goalCheckpointGuidanceAssignment from "../prompts/goals/goal-checkpoint-guidance-assignment.md" with {
	type: "text",
};
import goalCheckpointGuidanceSystem from "../prompts/goals/goal-checkpoint-guidance-system.md" with { type: "text" };
import goalCheckpointReviewerAssignment from "../prompts/goals/goal-checkpoint-reviewer-assignment.md" with {
	type: "text",
};
import goalCheckpointReviewerSystem from "../prompts/goals/goal-checkpoint-reviewer-system.md" with { type: "text" };
import goalCompletionVerifierAssignment from "../prompts/goals/goal-completion-verifier-assignment.md" with {
	type: "text",
};
import goalCompletionVerifierSystem from "../prompts/goals/goal-completion-verifier-system.md" with { type: "text" };
import goalContinuationCompactorAssignment from "../prompts/goals/goal-continuation-compactor-assignment.md" with {
	type: "text",
};
import goalContinuationCompactorSystem from "../prompts/goals/goal-continuation-compactor-system.md" with {
	type: "text",
};
import goalPreparedContinuation from "../prompts/goals/goal-prepared-continuation.md" with { type: "text" };
import goalRubricAssignment from "../prompts/goals/goal-rubric-assignment.md" with { type: "text" };
import goalRubricSystem from "../prompts/goals/goal-rubric-system.md" with { type: "text" };
import type { AgentDefinition } from "../task/types";
import type {
	GoalCheckpointEvidenceItem,
	GoalCompletionVerifierStructuredOutput,
	GoalContinuationFocus,
	GoalDeliverableMapItem,
	GoalVerificationGap,
} from "./state";

export const GOAL_SIDE_AGENT_TOOLS = ["read", "search", "find", "yield"] as const;

const deliverableMapItemSchema = {
	properties: {
		id: { type: "string" },
		summary: { type: "string" },
		status: { enum: ["pending", "partial", "satisfied", "blocked", "stale"] },
	},
	optionalProperties: {
		evidenceRefs: {
			elements: {
				properties: {
					id: { type: "string" },
					kind: { enum: ["doc", "issue", "artifact", "test", "commit", "external-record", "other"] },
				},
				optionalProperties: {
					label: { type: "string" },
					uri: { type: "string" },
				},
			},
		},
		blockedBy: { elements: { type: "string" } },
		nextRelevantTarget: { type: "string" },
	},
} as const;

const goalRubricOutputSchema = {
	properties: {
		rubric: { type: "string" },
		deliverableMap: { elements: deliverableMapItemSchema },
	},
} as const;

const evidenceItemSchema = {
	properties: {
		claim: { type: "string" },
		evidence: { type: "string" },
		current: { type: "boolean" },
	},
} as const;

const deliverableResultSchema = {
	properties: {
		id: { type: "string" },
		status: { enum: ["passed", "failed", "unknown"] },
		rationale: { type: "string" },
	},
	optionalProperties: {
		evidence: { elements: evidenceItemSchema },
	},
} as const;

const completionBlockerSchema = {
	properties: {
		id: { type: "string" },
		severity: { enum: ["blocking", "important", "polish"] },
		problem: { type: "string" },
		requiredEvidenceOrFix: { type: "string" },
	},
	optionalProperties: {
		deliverableId: { type: "string" },
	},
} as const;

const continuationFocusSchema = {
	properties: {
		openGaps: { elements: { type: "string" } },
		nextActions: { elements: { type: "string" } },
		evidenceToCollect: { elements: { type: "string" } },
	},
	optionalProperties: {
		avoidRepeating: { elements: { type: "string" } },
	},
} as const;

const goalCompletionOutputSchema = {
	properties: {
		status: { enum: ["verified", "rejected"] },
		feedback: { type: "string" },
		summary: { type: "string" },
		score: { type: "float64" },
		deliverableResults: { elements: deliverableResultSchema },
		evidenceChecked: { elements: evidenceItemSchema },
		completionBlockers: { elements: completionBlockerSchema },
	},
	optionalProperties: {
		continuationFocus: continuationFocusSchema,
		continuationMessage: { type: "string" },
	},
} as const;

const goalContinuationOutputSchema = {
	properties: {
		continuationMessage: { type: "string" },
	},
	optionalProperties: {
		continuationFocus: continuationFocusSchema,
	},
} as const;

const goalCheckpointReviewOutputSchema = {
	properties: {
		status: { enum: ["accepted", "rejected"] },
		feedback: { type: "string" },
		evidenceChecked: { elements: evidenceItemSchema },
		blockers: { elements: completionBlockerSchema },
	},
	optionalProperties: {
		continuationFocus: continuationFocusSchema,
	},
} as const;

const goalCheckpointGuidanceOutputSchema = {
	properties: {
		continuationMessage: { type: "string" },
		checkpointSummary: { type: "string" },
		controllerQuestions: { elements: { type: "string" } },
		possibleNextTargets: { elements: { type: "string" } },
		broaderChecksOrInputs: { elements: { type: "string" } },
		parentDeltaConsiderations: { elements: { type: "string" } },
		lessonsForFuture: { elements: { type: "string" } },
		avoidRepeating: { elements: { type: "string" } },
	},
} as const;

export const goalRubricAgent = {
	name: "goal-rubric",
	description: "Read-only goal rubric generator",
	systemPrompt: goalRubricSystem,
	tools: [...GOAL_SIDE_AGENT_TOOLS],
	output: goalRubricOutputSchema,
	source: "bundled",
} satisfies AgentDefinition;

export const goalCompletionVerifierAgent = {
	name: "goal-completion-verifier",
	description: "Read-only goal completion verifier",
	systemPrompt: goalCompletionVerifierSystem,
	tools: [...GOAL_SIDE_AGENT_TOOLS],
	output: goalCompletionOutputSchema,
	source: "bundled",
} satisfies AgentDefinition;

export const goalContinuationCompactorAgent = {
	name: "goal-continuation-compactor",
	description: "Read-only goal continuation compactor",
	systemPrompt: goalContinuationCompactorSystem,
	tools: [...GOAL_SIDE_AGENT_TOOLS],
	output: goalContinuationOutputSchema,
	source: "bundled",
} satisfies AgentDefinition;

export const goalCheckpointReviewerAgent = {
	name: "goal-checkpoint-reviewer",
	description: "Read-only goal checkpoint reviewer",
	systemPrompt: goalCheckpointReviewerSystem,
	tools: [...GOAL_SIDE_AGENT_TOOLS],
	output: goalCheckpointReviewOutputSchema,
	source: "bundled",
} satisfies AgentDefinition;

export const goalCheckpointGuidanceAgent = {
	name: "goal-checkpoint-guidance",
	description: "Read-only goal checkpoint guidance writer",
	systemPrompt: goalCheckpointGuidanceSystem,
	tools: [...GOAL_SIDE_AGENT_TOOLS],
	output: goalCheckpointGuidanceOutputSchema,
	source: "bundled",
} satisfies AgentDefinition;

export interface GoalRubricOutput {
	rubric: string;
	deliverableMap: GoalDeliverableMapItem[];
}

export interface GoalCompletionVerifierOutput extends GoalCompletionVerifierStructuredOutput {
	status: "verified" | "rejected";
	feedback: string;
	continuationMessage?: string;
}

export interface GoalContinuationCompactorOutput {
	continuationMessage: string;
	continuationFocus?: GoalContinuationFocus;
}

export interface GoalCheckpointReviewerOutput {
	status: "accepted" | "rejected";
	feedback: string;
	evidenceChecked: GoalCheckpointEvidenceItem[];
	blockers: GoalVerificationGap[];
	continuationFocus?: GoalContinuationFocus;
}

export interface GoalCheckpointGuidanceOutput {
	continuationMessage: string;
	checkpointSummary: string;
	controllerQuestions: string[];
	possibleNextTargets: string[];
	broaderChecksOrInputs: string[];
	parentDeltaConsiderations: string[];
	lessonsForFuture: string[];
	avoidRepeating: string[];
}

export function renderGoalRubricAssignment(input: { objective: string; contextFile: string }): string {
	return prompt.render(goalRubricAssignment, input);
}

export function renderGoalCompletionVerifierAssignment(input: {
	objective: string;
	rubric: string;
	contextFile: string;
	goalStateFile?: string;
	goalStateSnapshot?: string;
	attempt: number;
	maxAttempts: number;
}): string {
	return prompt.render(goalCompletionVerifierAssignment, {
		...input,
		attempt: String(input.attempt),
		maxAttempts: String(input.maxAttempts),
	});
}

export function renderGoalContinuationCompactorAssignment(input: {
	objective: string;
	contextFile: string;
	goalStateFile?: string;
	goalStateSnapshot?: string;
	verificationFeedback?: string;
}): string {
	return prompt.render(goalContinuationCompactorAssignment, input);
}

export function renderGoalCheckpointReviewerAssignment(input: {
	contextFile: string;
	goalStateFile: string;
	goalStateSnapshot: string;
	candidateCheckpoint: string;
}): string {
	return prompt.render(goalCheckpointReviewerAssignment, input);
}

export function renderGoalCheckpointGuidanceAssignment(input: {
	contextFile: string;
	goalStateFile: string;
	goalStateSnapshot: string;
	checkpointPacket: string;
}): string {
	return prompt.render(goalCheckpointGuidanceAssignment, input);
}

export function renderPreparedGoalContinuation(input: { basePrompt: string; continuationMessage: string }): string {
	return prompt.render(goalPreparedContinuation, input);
}
