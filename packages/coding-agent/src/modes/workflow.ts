import { prompt } from "@oh-my-pi/pi-utils";
import workflowNotice from "../prompts/system/workflow-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { keywordInProse } from "./markdown-prose";

/**
 * "workflow" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a warm
 * amber→green gradient ({@link highlightWorkflow}); submitting a message that
 * mentions it appends a hidden {@link WORKFLOW_NOTICE} that steers the model to
 * author a deterministic multi-subagent workflow in eval cells (agent/parallel/
 * pipeline). Matching is whitespace-delimited and case-sensitive (lowercase
 * only) — "workflow"/"workflows" trigger, but "workflowed", "Workflow", and
 * "workflow.ts" never do.
 */

// Detection: lowercase keyword (singular or plural) flanked by whitespace or a string edge. Non-global so `.test` stays stateless.
const WORKFLOW_WORD = /(?<!\S)workflows?(?!\S)/;

export interface WorkflowNoticeCapabilities {
	evalAvailable: boolean;
	taskToolAvailable: boolean;
	planMode: boolean;
	sessionSpawns: string | null | undefined;
	taskDepth: number;
	taskMaxRecursionDepth: number;
	disabledAgents: readonly string[];
	availableAgentTypes?: readonly string[];
}

function uniqueEnabledAgents(
	agentTypes: readonly string[] | undefined,
	disabledAgents: ReadonlySet<string>,
): string[] | null {
	if (!agentTypes) return null;
	const seen = new Set<string>();
	const enabled: string[] = [];
	for (const agentType of agentTypes) {
		const trimmed = agentType.trim();
		if (!trimmed || disabledAgents.has(trimmed) || seen.has(trimmed)) continue;
		seen.add(trimmed);
		enabled.push(trimmed);
	}
	return enabled;
}

function allowedSpawnList(
	sessionSpawns: string | null | undefined,
	disabledAgents: ReadonlySet<string>,
	availableAgentTypes?: readonly string[],
): string[] | null {
	const availableAgents = uniqueEnabledAgents(availableAgentTypes, disabledAgents);
	const spawns = sessionSpawns ?? "*";
	if (spawns === "*") {
		if (availableAgents) return availableAgents;
		return disabledAgents.has("task") ? [] : null;
	}
	if (spawns === "") return [];
	const requested = spawns
		.split(",")
		.map(spawn => spawn.trim())
		.filter(spawn => spawn.length > 0 && !disabledAgents.has(spawn));
	if (!availableAgents) return requested;
	const available = new Set(availableAgents);
	return requested.filter(spawn => available.has(spawn));
}

export function renderWorkflowNotice(capabilities: WorkflowNoticeCapabilities): string {
	const disabledAgents = new Set(capabilities.disabledAgents);
	const allowedSpawns = allowedSpawnList(capabilities.sessionSpawns, disabledAgents, capabilities.availableAgentTypes);
	const wildcardSpawns = allowedSpawns === null;
	const canSpawnByPolicy = wildcardSpawns || allowedSpawns.length > 0;
	const taskAllowedBySpawns = wildcardSpawns || allowedSpawns.includes("task");
	const taskAgentUsable = taskAllowedBySpawns && !disabledAgents.has("task");
	const taskDepthAllowsTask =
		capabilities.taskMaxRecursionDepth < 0 || capabilities.taskDepth < capabilities.taskMaxRecursionDepth;
	const evalDepthAllowsAgent = capabilities.taskDepth < 3;
	const canUseEvalAgents =
		capabilities.evalAvailable && !capabilities.planMode && evalDepthAllowsAgent && canSpawnByPolicy;
	const canUseTaskTool =
		capabilities.taskToolAvailable && !capabilities.planMode && taskDepthAllowsTask && canSpawnByPolicy;
	const allowedAgentSummary = wildcardSpawns
		? disabledAgents.size > 0
			? `all agents except disabled agents (${[...disabledAgents].join(", ")})`
			: "all agents"
		: allowedSpawns.length > 0
			? allowedSpawns.join(", ")
			: "none";
	const preferredAgentType = taskAgentUsable ? "task" : (allowedSpawns?.[0] ?? "");
	const agentCallExample = taskAgentUsable
		? 'agent("…")'
		: preferredAgentType
			? `agent("…", agent_type="${preferredAgentType}")`
			: "";
	const agentUnavailableReason = capabilities.planMode
		? "plan mode blocks eval agent() and nested task spawning"
		: !capabilities.evalAvailable
			? "eval is not available in this session"
			: !evalDepthAllowsAgent
				? "eval agent() recursion depth is exhausted"
				: !canSpawnByPolicy
					? "this session has no allowed subagent spawns"
					: "subagent spawning is unavailable";
	const taskUnavailableReason = capabilities.planMode
		? "plan mode child agents are read-only and cannot recursively spawn"
		: !capabilities.taskToolAvailable
			? "task tool is not active in this session"
			: !taskDepthAllowsTask
				? "task.maxRecursionDepth is exhausted"
				: !canSpawnByPolicy
					? "this session has no allowed subagent spawns"
					: "task spawning is unavailable";

	return prompt
		.render(workflowNotice, {
			canUseEvalAgents,
			canUseTaskTool,
			evalAvailable: capabilities.evalAvailable,
			taskToolAvailable: capabilities.taskToolAvailable,
			planMode: capabilities.planMode,
			allowedAgentSummary,
			preferredAgentType,
			agentCallExample,
			agentUnavailableReason,
			taskUnavailableReason,
			taskAgentUsable,
			restrictedSpawns: !wildcardSpawns,
			noSpawns: !canSpawnByPolicy,
		})
		.trim();
}

/** Hidden system notice appended after a user message that mentions "workflow". */
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
 * Whether `text` contains the standalone keyword "workflow"/"workflows"
 * (lowercase, whitespace-delimited) in prose — never inside a code block, inline
 * code span, or XML/HTML section.
 */
export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_WORD);
}

/**
 * Highlight every standalone "workflow"/"workflows" in `text` for editor display
 * with a warm amber→green gradient (hue 30..150), visually distinct from
 * ultrathink's rainbow and orchestrate's teal→violet.
 */
export const highlightWorkflow: KeywordHighlighter = createGradientHighlighter({
	probe: /workflow/,
	highlight: /(?<!\S)workflows?(?!\S)/g,
	stops: 14,
	hue: t => 30 + t * 120,
});
