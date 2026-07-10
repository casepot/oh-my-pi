import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import "../../src/config/prompt-templates";
import subagentSystemPromptTemplate from "../../src/prompts/system/subagent-system-prompt.md" with { type: "text" };
import taskDescriptionTemplate from "../../src/prompts/tools/task.md" with { type: "text" };
import { createSubagentRuntimePolicy, formatRuntimePolicyPrompt } from "../../src/task/runtime-policy";
import type { RuntimePolicyPrompt } from "../../src/task/types";

const resumablePolicy = createSubagentRuntimePolicy({
	requestBudget: 24,
	requestBudgetNotice: true,
	noProgressCycleLimit: 3,
	maxRuntimeMs: 720_000,
	maxRecursionDepth: 3,
	taskDepth: 1,
	idleTtlMs: 420_000,
	resumable: true,
});
const nonResumablePolicy = createSubagentRuntimePolicy({
	requestBudget: 24,
	requestBudgetNotice: true,
	noProgressCycleLimit: 3,
	maxRuntimeMs: 720_000,
	maxRecursionDepth: 3,
	taskDepth: 1,
	idleTtlMs: 420_000,
	resumable: false,
});
const offPolicy = createSubagentRuntimePolicy({
	requestBudget: 0,
	requestBudgetNotice: false,
	noProgressCycleLimit: 0,
	maxRuntimeMs: 0,
	maxRecursionDepth: -1,
	taskDepth: 1,
	idleTtlMs: 0,
	resumable: true,
});

function renderParent(runtimePolicy: RuntimePolicyPrompt, isolationEnabled = false): string {
	return prompt.render(taskDescriptionTemplate, {
		agents: [],
		spawningDisabled: true,
		defaultAgent: "task",
		defaultAgentIsGeneric: true,
		allowedAgentsText: "",
		MAX_CONCURRENCY: 0,
		isolationEnabled,
		batchEnabled: true,
		asyncEnabled: false,
		ircEnabled: false,
		runtimePolicy,
	});
}

function renderChild(runtimePolicy: RuntimePolicyPrompt): string {
	return prompt.render(subagentSystemPromptTemplate, {
		agent: "Base worker.",
		ircPeers: "",
		ircSelfId: "",
		runtimePolicy,
		historyUri: "history://Child42",
		outputUri: "agent://Child42",
	});
}

describe("effective runtime policy prompts", () => {
	it("renders the same canonical policy for parent and child", () => {
		const policyPrompt = formatRuntimePolicyPrompt(resumablePolicy);
		const parent = renderParent(policyPrompt);
		const child = renderChild(policyPrompt);

		for (const statement of Object.values(policyPrompt)) {
			expect(parent).toContain(statement);
			expect(child).toContain(statement);
		}
		expect(policyPrompt.request).toContain("No hidden request-count cap");
		expect(policyPrompt.request).toContain("request-count termination disabled");
		expect(policyPrompt.wallClock).toContain("provider, caller-cancellation, and executor failures still apply");
		expect(policyPrompt.stall).toContain("3 consecutive completed assistant turns");
		expect(policyPrompt.stall).toContain("a successful tool resets the count");
		expect(policyPrompt.stall).toContain("waiting time does not increment it");
		expect(policyPrompt.spawn).toBe("2 further generations");
		expect(policyPrompt.idle).toBe("resumable; park idle or paused sessions after 7m");
	});

	it("shows structured spawn policy transport and concrete recovery URIs", () => {
		const policyPrompt = formatRuntimePolicyPrompt(resumablePolicy);
		const parent = renderParent(policyPrompt);
		const child = renderChild(policyPrompt);

		expect(parent).toContain("details.effectivePolicies");
		expect(parent).toContain("`history://<id>`");
		expect(parent).toContain("`agent://<id>`");
		expect(child).toContain("`history://Child42` transcript");
		expect(child).toContain("`agent://Child42` latest output");
		expect(child).toContain("Messages resume `paused`/`idle` sessions only while resumable");
		expect(child).toContain("`parked` revival also requires a retained resumable session");
	});

	it("states non-resumable stall and retention semantics without promising wake-up", () => {
		const policyPrompt = formatRuntimePolicyPrompt(nonResumablePolicy);
		const parent = renderParent(policyPrompt, true);
		const child = renderChild(policyPrompt);

		expect(policyPrompt.stall).toContain("fail with no_progress after 3 consecutive completed assistant turns");
		expect(policyPrompt.stall).toContain("this run retains no resumable session");
		expect(policyPrompt.idle).toBe("non-resumable; no live session retained");
		expect(parent).toContain("Isolated runs retain no live session; their stall action is `fail`, not `pause`.");
		expect(child).toContain("Retention: non-resumable; no live session retained.");
		expect(child).not.toContain("A deliberate message resumes");
	});

	it("states disabled guards and unlimited depth explicitly", () => {
		const policyPrompt = formatRuntimePolicyPrompt(offPolicy);
		const parent = renderParent(policyPrompt);

		expect(parent).toContain(
			"Request policy: No hidden request-count cap; request-count termination disabled; advisory off.",
		);
		expect(parent).toContain(
			"Runtime policy: OMP wall-clock cap disabled; provider, caller-cancellation, and executor failures still apply.",
		);
		expect(parent).toContain("Stall guard: off.");
		expect(parent).toContain("Descendant spawn depth: unlimited.");
		expect(parent).toContain("Retention: resumable; keep live indefinitely with no parking TTL.");
	});
});
