import { prompt } from "@oh-my-pi/pi-utils";
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

const GOAL_SIDE_AGENT_TOOLS = ["read", "search", "find", "yield"] as const;

const goalRubricOutputSchema = {
	properties: {
		rubric: { type: "string" },
	},
} as const;

const goalCompletionOutputSchema = {
	properties: {
		status: { enum: ["verified", "rejected"] },
		feedback: { type: "string" },
	},
	optionalProperties: {
		continuationMessage: { type: "string" },
	},
} as const;

const goalContinuationOutputSchema = {
	properties: {
		continuationMessage: { type: "string" },
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

export interface GoalRubricOutput {
	rubric: string;
}

export interface GoalCompletionVerifierOutput {
	status: "verified" | "rejected";
	feedback: string;
	continuationMessage?: string;
}

export interface GoalContinuationCompactorOutput {
	continuationMessage: string;
}

export function renderGoalRubricAssignment(input: { objective: string; contextFile: string }): string {
	return prompt.render(goalRubricAssignment, input);
}

export function renderGoalCompletionVerifierAssignment(input: {
	objective: string;
	rubric: string;
	contextFile: string;
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
	rubric: string;
	contextFile: string;
	verificationFeedback?: string;
}): string {
	return prompt.render(goalContinuationCompactorAssignment, input);
}

export function renderPreparedGoalContinuation(input: { basePrompt: string; continuationMessage: string }): string {
	return prompt.render(goalPreparedContinuation, input);
}
