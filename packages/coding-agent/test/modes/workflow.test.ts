import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "../../src/modes/theme/theme";
import { containsWorkflow, highlightWorkflow, renderWorkflowNotice, WORKFLOW_NOTICE } from "../../src/modes/workflow";

beforeAll(() => {
	// highlightWorkflow reads the global theme's color mode.
	initTheme();
});

describe("workflow keyword detection", () => {
	it("matches the lowercase word (singular or plural) delimited by whitespace", () => {
		expect(containsWorkflow("workflow")).toBe(true);
		expect(containsWorkflow("please workflow this rollout")).toBe(true);
		expect(containsWorkflow("run these workflows")).toBe(true);
		expect(containsWorkflow("design the workflow")).toBe(true);
	});

	it("ignores casing, inflections, punctuation-adjacent, and path-embedded forms", () => {
		expect(containsWorkflow("Workflow")).toBe(false);
		expect(containsWorkflow("WORKFLOW")).toBe(false);
		expect(containsWorkflow("workflowed the build")).toBe(false);
		expect(containsWorkflow("reworkflow everything")).toBe(false);
		// A path/extension is not whitespace, so the word never triggers.
		expect(containsWorkflow("packages/coding-agent/test/modes/workflow.test.ts")).toBe(false);
		expect(containsWorkflow("do it. workflow.")).toBe(false);
		expect(containsWorkflow("nothing to see here")).toBe(false);
	});
});

describe("workflow keyword highlighting", () => {
	it("decorates the keyword with zero-width escapes, preserving visible text", () => {
		const input = "please workflow this";
		const decorated = highlightWorkflow(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b");
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		// Probe hits the substring but the whitespace boundary fails — no decoration.
		expect(highlightWorkflow("workflowed builds")).toBe("workflowed builds");
		expect(highlightWorkflow("Workflow this")).toBe("Workflow this");
		const filePath = "packages/coding-agent/test/modes/workflow.test.ts";
		expect(highlightWorkflow(filePath)).toBe(filePath);
	});
});

describe("workflow notice", () => {
	const base = {
		evalAvailable: true,
		taskToolAvailable: true,
		planMode: false,
		sessionSpawns: "*",
		taskDepth: 0,
		taskMaxRecursionDepth: 2,
		disabledAgents: [],
		availableAgentTypes: ["task", "explore"],
	} as const;

	it("is a non-empty system notice carrying the eval-fan-out contract when task spawning is allowed", () => {
		expect(WORKFLOW_NOTICE.length).toBeGreaterThan(0);
		expect(WORKFLOW_NOTICE).toContain("**workflow** keyword");
		expect(WORKFLOW_NOTICE).toContain("parallel_settled(");
		expect(WORKFLOW_NOTICE).toContain('agent("…")');
	});

	it("renders an inline-only notice when spawns are disabled", () => {
		const notice = renderWorkflowNotice({ ...base, sessionSpawns: "" });
		expect(notice).toContain("Allowed subagent spawns now: none");
		expect(notice).toContain("Do not call eval `agent()`");
		expect(notice).not.toContain('agent("…")');
		expect(notice).not.toContain("parallel_settled([lambda");
	});

	it("renders restricted spawn examples without defaulting to task", () => {
		const notice = renderWorkflowNotice({ ...base, sessionSpawns: "explore" });
		expect(notice).toContain("Allowed subagent spawns now: explore");
		expect(notice).toContain('agent("…", agent_type="explore")');
		expect(notice).toContain('agent_type="explore"');
		expect(notice).not.toContain('agent("…")`.');
	});

	it("keeps recursive spawning available below depth limits and disables it at max depth", () => {
		const recursiveNotice = renderWorkflowNotice({ ...base, taskDepth: 1 });
		expect(recursiveNotice).toContain('agent("…")');
		expect(recursiveNotice).toContain("parallel_settled(");

		const exhaustedNotice = renderWorkflowNotice({ ...base, taskDepth: 3 });
		expect(exhaustedNotice).toContain("eval agent() recursion depth is exhausted");
		expect(exhaustedNotice).toContain("task.maxRecursionDepth is exhausted");
		expect(exhaustedNotice).not.toContain('agent("…")');
	});

	it("uses a concrete enabled agent when wildcard spawns disable task", () => {
		const notice = renderWorkflowNotice({ ...base, disabledAgents: ["task"] });
		expect(notice).toContain("Allowed subagent spawns now: explore");
		expect(notice).toContain('agent("…", agent_type="explore")');
		expect(notice).not.toContain('agent_type=""');
		expect(notice).not.toContain('agent("…")`.');
	});

	it("falls back to inline workflow when every discovered wildcard agent is disabled", () => {
		const notice = renderWorkflowNotice({
			...base,
			disabledAgents: ["task"],
			availableAgentTypes: ["task"],
		});
		expect(notice).toContain("Allowed subagent spawns now: none");
		expect(notice).toContain("Do not call eval `agent()`");
		expect(notice).not.toContain('agent_type=""');
		expect(notice).not.toContain('agent("…")');
	});

	it("does not instruct eval agent fan-out in plan mode", () => {
		const notice = renderWorkflowNotice({ ...base, planMode: true });
		expect(notice).toContain("Plan mode is active");
		expect(notice).toContain("Do not call eval `agent()`");
		expect(notice).not.toContain("parallel_settled([lambda");
	});
});
