import { prompt } from "@oh-my-pi/pi-utils";
import workflowNotice from "../prompts/system/workflow-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { keywordInProse } from "./markdown-prose";

/**
 * "workflowz" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a warm
 * amber→green gradient ({@link highlightWorkflow}); submitting a message that
 * mentions it appends a hidden {@link WORKFLOW_NOTICE} that steers the model to
 * author a deterministic multi-subagent workflow in eval cells (agent/parallel/
 * pipeline). Matching is whitespace-delimited and case-sensitive (lowercase
 * only) — "workflowz" triggers, but "workflowzed", "Workflowz", and
 * "workflowz.ts" never do.
 */

// Detection: lowercase keyword flanked by whitespace or a string edge. Non-global so `.test` stays stateless.
const WORKFLOW_WORD = /(?<!\S)workflowz(?!\S)/;

export interface WorkflowNoticeCapabilities {
	evalAvailable: boolean;
	taskToolAvailable: boolean;
	planMode: boolean;
	sessionSpawns?: string;
	taskDepth?: number;
	taskMaxRecursionDepth?: number;
	disabledAgents?: readonly string[];
	availableAgentTypes?: readonly string[];
}

function allowedSpawnList(
	sessionSpawns: string | undefined,
	disabledAgents: ReadonlySet<string>,
	availableAgentTypes: readonly string[] | undefined,
): string[] | null {
	if (sessionSpawns === "") return [];
	if (sessionSpawns === undefined || sessionSpawns === "*") {
		if (!availableAgentTypes) return null;
		return availableAgentTypes.filter(agent => !disabledAgents.has(agent));
	}
	return sessionSpawns
		.split(",")
		.map(agent => agent.trim())
		.filter(agent => agent.length > 0 && !disabledAgents.has(agent));
}

export function renderWorkflowNotice(capabilities: WorkflowNoticeCapabilities): string {
	const disabledAgents = new Set(capabilities.disabledAgents);
	const allowedSpawns = allowedSpawnList(capabilities.sessionSpawns, disabledAgents, capabilities.availableAgentTypes);
	const wildcardSpawns = allowedSpawns === null;
	const concreteSpawns = allowedSpawns ?? [];
	const depth = capabilities.taskDepth ?? 0;
	const maxDepth = capabilities.taskMaxRecursionDepth ?? 2;
	const recursionExhausted = maxDepth >= 0 && depth >= maxDepth;
	const canUseEvalAgents =
		capabilities.evalAvailable &&
		!capabilities.planMode &&
		!recursionExhausted &&
		(wildcardSpawns || concreteSpawns.length > 0);
	const canUseTaskTool =
		capabilities.taskToolAvailable &&
		!capabilities.planMode &&
		!recursionExhausted &&
		(wildcardSpawns || concreteSpawns.length > 0);
	const preferredAgentType = wildcardSpawns ? (disabledAgents.has("task") ? "" : "task") : (concreteSpawns[0] ?? "");
	const allowedAgentSummary = wildcardSpawns
		? disabledAgents.size > 0
			? `any discovered agent except ${Array.from(disabledAgents).sort().join(", ")}`
			: "any discovered agent"
		: concreteSpawns.length > 0
			? concreteSpawns.join(", ")
			: "none";
	const spawnPolicy = capabilities.planMode
		? "Plan mode is active. Do not call eval `agent()` or the task tool from this notice."
		: recursionExhausted
			? `eval agent() recursion depth is exhausted (task.maxRecursionDepth is exhausted at depth ${depth}/${maxDepth}). Do not call eval \`agent()\` or the task tool from this notice.`
			: canUseEvalAgents || canUseTaskTool
				? `Allowed subagent spawns now: ${allowedAgentSummary}.`
				: "Allowed subagent spawns now: none. Do not call eval `agent()` or the task tool from this notice.";
	const agentExample = canUseEvalAgents
		? preferredAgentType && preferredAgentType !== "task"
			? `agent("…", agent_type="${preferredAgentType}")`
			: 'agent("…")'
		: "";

	return prompt
		.render(workflowNotice, {
			canUseEvalAgents,
			canUseTaskTool,
			evalAvailable: capabilities.evalAvailable,
			taskToolAvailable: capabilities.taskToolAvailable,
			spawnPolicy,
			preferredAgentType,
			allowedAgentSummary,
			agentExample,
		})
		.trim();
}

/** Hidden system notice appended after a user message that mentions "workflowz". */
export const WORKFLOW_NOTICE: string = renderWorkflowNotice({
	evalAvailable: true,
	taskToolAvailable: true,
	planMode: false,
	sessionSpawns: "*",
	taskDepth: 0,
	taskMaxRecursionDepth: 2,
	disabledAgents: [],
});

/**
 * Whether `text` contains the standalone keyword "workflowz"
 * (lowercase, whitespace-delimited) in prose — never inside a code block, inline
 * code span, or XML/HTML section.
 */
export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_WORD);
}

/**
 * Highlight every standalone "workflowz" in `text` for editor display
 * with a warm amber→green gradient (hue 30..150), visually distinct from
 * ultrathink's rainbow and orchestrate's teal→violet.
 */
export const highlightWorkflow: KeywordHighlighter = createGradientHighlighter({
	probe: /workflowz/,
	highlight: /(?<!\S)workflowz(?!\S)/g,
	stops: 14,
	hue: t => 30 + t * 120,
});
