import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { PersistedAgentRefRecord } from "@oh-my-pi/pi-coding-agent/registry/agent-persistence";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { formatResultOutputFallback } from "@oh-my-pi/pi-coding-agent/task";
import { runSubprocess, SUBAGENT_WARNING_MISSING_YIELD } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

/**
 * Contract: subagent request and no-progress guards.
 *
 * 1. Assistant requests are counted and surfaced on `SingleResult.requests`.
 * 2. An enabled request budget emits exactly one advisory notice and never
 *    aborts, including far beyond the former 1.5× boundary.
 * 3. Consecutive completed assistant turns without a successful tool result
 *    trigger the mode-specific stall action; successful tools reset the counter.
 * 4. Terminal interruptions salvage the last assistant text for recovery.
 */

interface SteerCall {
	content: string;
	options?: { deliverAs?: "steer" | "followUp" };
}

interface FakeSessionConfig {
	/** Events pushed to the executor's subscriber on the next microtask. */
	events?: AgentSessionEvent[];
	/** When true, prompt/waitForIdle hang until abort() is called. */
	hang?: boolean;
	/** Returned from getLastAssistantMessage (salvage source). */
	lastAssistantMessage?: unknown;
}

interface FakeSessionHandle {
	session: AgentSession;
	steerCalls: SteerCall[];
	abortCalls: () => number;
	promptCalls: () => number;
	disposeCalls: () => number;
}

function assistantMessageEnd(text: string, usage?: Record<string, number>): AgentSessionEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: text ? [{ type: "text", text }] : [],
			usage: usage ?? { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
		},
	} as unknown as AgentSessionEvent;
}

function yieldToolEnd(): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: "tool-yield",
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data: { ok: true } },
		},
		isError: false,
	} as AgentSessionEvent;
}

function createFakeSession(config: FakeSessionConfig = {}): FakeSessionHandle {
	let abortCount = 0;
	let promptCount = 0;
	let disposeCount = 0;
	const steerCalls: SteerCall[] = [];
	const { promise: hang, resolve: releaseHang } = Promise.withResolvers<void>();
	if (!config.hang) releaseHang();

	const session: Partial<AgentSession> = {
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		extensionRunner: undefined as never,
		sessionManager: { appendSessionInit: () => {} } as never,
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_names: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			if (config.events?.length) {
				const events = config.events;
				queueMicrotask(() => {
					for (const event of events) listener(event);
				});
			}
			return () => {};
		},
		prompt: async () => {
			promptCount += 1;
			await hang;
			return true;
		},
		waitForIdle: async () => {
			await hang;
		},
		sendUserMessage: async (content, options) => {
			steerCalls.push({ content: String(content), options });
		},
		getLastAssistantMessage: () => (config.lastAssistantMessage ?? undefined) as never,
		abort: async () => {
			abortCount += 1;
			releaseHang();
		},
		dispose: async () => {
			disposeCount += 1;
		},
	};
	return {
		session: session as AgentSession,
		steerCalls,
		abortCalls: () => abortCount,
		promptCalls: () => promptCount,
		disposeCalls: () => disposeCount,
	};
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} satisfies CreateAgentSessionResult);
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "subagent-guards",
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

describe("runSubprocess request guards", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});
	it("defaults request advisories off and the stall guard to ten assistant turns", () => {
		const settings = Settings.isolated();
		expect(settings.get("task.softRequestBudget")).toBe(0);
		expect(settings.get("task.noProgressCycleLimit")).toBe(10);
	});

	it("counts assistant requests into SingleResult.requests", async () => {
		const settings = Settings.isolated({ "task.maxRuntimeMs": 0 });
		const handle = createFakeSession({
			events: [
				assistantMessageEnd("step one"),
				assistantMessageEnd("step two"),
				assistantMessageEnd("step three"),
				yieldToolEnd(),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-requests", settings });

		expect(result.termination.status).toBe("completed");
		expect(result.requests).toBe(3);
		// Well under any budget: no steer injected.
		expect(handle.steerCalls.length).toBe(0);
	});

	it("injects exactly one steering notice when the soft budget is crossed", async () => {
		// Budget 4: the advisory fires at request 4 and does not repeat.
		const settings = Settings.isolated({
			"task.maxRuntimeMs": 0,
			"task.softRequestBudget": 4,
			"task.softRequestBudgetNotice": true,
		});
		const handle = createFakeSession({
			events: [
				assistantMessageEnd("1"),
				assistantMessageEnd("2"),
				assistantMessageEnd("3"),
				assistantMessageEnd("4"),
				assistantMessageEnd("5"),
				yieldToolEnd(),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-steer", settings });

		expect(result.requests).toBe(5);
		expect(result.termination.status).toBe("completed");
		expect(handle.steerCalls.length).toBe(1);
		expect(handle.steerCalls[0].content).toContain("[budget notice]");
		expect(handle.steerCalls[0].content).toContain("4 requests");
		expect(handle.steerCalls[0].options?.deliverAs).toBe("steer");
	});

	it("does not inject a steering notice by default when the soft request budget is crossed", async () => {
		// Budget 4 is crossed, but notices default off.
		const settings = Settings.isolated({
			"task.maxRuntimeMs": 0,
			"task.softRequestBudget": 4,
		});
		const handle = createFakeSession({
			events: [
				assistantMessageEnd("1"),
				assistantMessageEnd("2"),
				assistantMessageEnd("3"),
				assistantMessageEnd("4"),
				assistantMessageEnd("5"),
				yieldToolEnd(),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-steer-disabled", settings });

		expect(result.requests).toBe(5);
		expect(result.termination.status).toBe("completed");
		expect(handle.steerCalls).toEqual([]);
	});

	it("never aborts beyond the former hard boundary when notices are disabled", async () => {
		const settings = Settings.isolated({
			"task.maxRuntimeMs": 0,
			"task.softRequestBudget": 2,
			"task.softRequestBudgetNotice": false,
			"task.noProgressCycleLimit": 0,
		});
		const handle = createFakeSession({
			events: [...Array.from({ length: 220 }, (_, index) => assistantMessageEnd(String(index + 1))), yieldToolEnd()],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-no-hard-stop", settings });

		expect(result.requests).toBe(220);
		expect(result.termination).toMatchObject({ status: "completed", code: "yielded" });
		expect(result.termination.policy.request).toEqual({
			termination: "disabled",
			advisory: { mode: "off", afterAssistantTurns: null },
		});
		expect(handle.steerCalls).toEqual([]);
	});

	it("emits one advisory but never aborts beyond the former hard boundary", async () => {
		const settings = Settings.isolated({
			"task.maxRuntimeMs": 0,
			"task.softRequestBudget": 2,
			"task.softRequestBudgetNotice": true,
			"task.noProgressCycleLimit": 0,
		});
		const handle = createFakeSession({
			events: [...Array.from({ length: 220 }, (_, index) => assistantMessageEnd(String(index + 1))), yieldToolEnd()],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-advisory-only", settings });

		expect(result.requests).toBe(220);
		expect(result.termination).toMatchObject({ status: "completed", code: "yielded" });
		expect(result.termination.policy.request).toEqual({
			termination: "disabled",
			advisory: { mode: "advisory", afterAssistantTurns: 2 },
		});
		expect(handle.steerCalls).toHaveLength(1);
	});

	it("pauses at the consecutive no-progress limit without sending another reminder", async () => {
		const settings = Settings.isolated({
			"task.maxRuntimeMs": 0,
			"task.noProgressCycleLimit": 2,
		});
		const handle = createFakeSession({
			events: [assistantMessageEnd("first"), assistantMessageEnd("second")],
		});
		mockCreateAgentSession(handle.session);
		const persisted: PersistedAgentRefRecord[] = [];

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-no-progress",
			settings,
			recordAgentRef: record => persisted.push(record),
		});

		expect(result.termination).toMatchObject({
			status: "paused",
			code: "no_progress",
			resumable: true,
			historyUri: "history://subagent-no-progress",
			outputUri: "agent://subagent-no-progress",
		});
		expect(result.termination.reason).toContain("2 consecutive assistant turns");
		expect(result.output).not.toContain(SUBAGENT_WARNING_MISSING_YIELD);
		expect(handle.promptCalls()).toBe(1);
		expect(handle.abortCalls()).toBe(0);
		expect(handle.disposeCalls()).toBe(0);
		expect(AgentRegistry.global().get("subagent-no-progress")?.status).toBe("paused");
		expect(persisted.at(-1)?.statusDetail).toMatchObject({
			code: "no_progress",
			consecutive: 2,
			limit: 2,
		});
	});

	it("fails and parks a stalled one-shot run instead of advertising resumability", async () => {
		const settings = Settings.isolated({
			"task.maxRuntimeMs": 0,
			"task.noProgressCycleLimit": 2,
		});
		const handle = createFakeSession({
			events: [assistantMessageEnd("first"), assistantMessageEnd("second")],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-one-shot-stall",
			settings,
			keepAlive: false,
		});

		expect(result.termination).toMatchObject({
			status: "failed",
			code: "no_progress",
			resumable: false,
			policy: {
				stall: { action: "fail", afterAssistantTurns: 2 },
				idle: { resumable: false, parkingTtlMs: null },
			},
		});
		expect(result.output).not.toContain(SUBAGENT_WARNING_MISSING_YIELD);
		expect(handle.disposeCalls()).toBe(1);
		expect(AgentRegistry.global().get("subagent-one-shot-stall")?.status).toBe("parked");
	});

	it("fails and parks a stalled isolated run instead of retaining a deleted worktree session", async () => {
		const settings = Settings.isolated({
			"task.maxRuntimeMs": 0,
			"task.noProgressCycleLimit": 2,
		});
		const handle = createFakeSession({
			events: [assistantMessageEnd("first"), assistantMessageEnd("second")],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-isolated-stall",
			settings,
			worktree: "/tmp/subagent-isolated-worktree",
		});

		expect(result.termination).toMatchObject({
			status: "failed",
			code: "no_progress",
			resumable: false,
			policy: {
				stall: { action: "fail", afterAssistantTurns: 2 },
				idle: { resumable: false, parkingTtlMs: null },
			},
		});
		expect(result.output).not.toContain(SUBAGENT_WARNING_MISSING_YIELD);
		expect(handle.disposeCalls()).toBe(1);
		expect(AgentRegistry.global().get("subagent-isolated-stall")?.status).toBe("parked");
	});

	it("resets the consecutive assistant-turn count after a successful tool result", async () => {
		const settings = Settings.isolated({
			"task.maxRuntimeMs": 0,
			"task.noProgressCycleLimit": 2,
		});
		const handle = createFakeSession({
			events: [
				assistantMessageEnd("first"),
				{
					type: "tool_execution_end",
					toolCallId: "tool-read",
					toolName: "read",
					result: { content: [{ type: "text", text: "ok" }] },
					isError: false,
				} as AgentSessionEvent,
				assistantMessageEnd("second"),
				yieldToolEnd(),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-progress-reset", settings });
		expect(result.termination.status).toBe("completed");
		expect(result.termination.code).toBe("yielded");
		expect(result.requests).toBe(2);
	});

	it("disables the stall guard when the configured turn limit is zero", async () => {
		const settings = Settings.isolated({
			"task.maxRuntimeMs": 0,
			"task.noProgressCycleLimit": 0,
		});
		const handle = createFakeSession({
			events: [assistantMessageEnd("first"), assistantMessageEnd("second")],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-no-progress-off", settings });

		expect(result.termination.status).toBe("failed");
		expect(result.termination.code).toBe("missing_yield");
		expect(result.termination.policy.stall).toEqual({ action: "off", afterAssistantTurns: null });
		expect(handle.promptCalls()).toBe(4);
		expect(handle.abortCalls()).toBe(0);
	});

	it("surfaces known blocking tools as waiting while they execute", async () => {
		const statuses: string[] = [];
		const persisted: PersistedAgentRefRecord[] = [];
		const handle = createFakeSession({
			events: [
				{
					type: "tool_execution_start",
					toolCallId: "wait-job",
					toolName: "job",
					args: { poll: ["background-1"] },
				} as AgentSessionEvent,
				{
					type: "tool_execution_end",
					toolCallId: "wait-job",
					toolName: "job",
					result: { content: [{ type: "text", text: "finished" }] },
					isError: false,
				} as AgentSessionEvent,
				yieldToolEnd(),
			],
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-wait-status",
			recordAgentRef: record => persisted.push(record),
			onProgress: progress => statuses.push(progress.status),
		});

		expect(statuses).toContain("waiting");
		expect(
			persisted.some(record => record.status === "waiting" && record.statusDetail?.code === "external_wait"),
		).toBe(true);
		expect(result.termination.status).toBe("completed");
	});

	it("salvages the last assistant text for an aborted child with no completed output", async () => {
		const settings = Settings.isolated({ "task.maxRuntimeMs": 50 });
		const handle = createFakeSession({
			hang: true,
			events: [
				// One completed assistant turn with usage but no text content:
				// counts a request and tokens without producing output chunks.
				assistantMessageEnd("", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 }),
			],
			lastAssistantMessage: {
				role: "assistant",
				stopReason: "aborted",
				content: [{ type: "text", text: "Reading   the\n\tconfig loader before patching" }],
			},
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-salvage", settings });

		expect(result.termination.status).toBe("aborted");
		expect(result.requests).toBe(1);
		expect(result.output).toContain("cancelled after 1 req");
		expect(result.output).toContain("150 tok");
		expect(result.output).toContain("last activity:");
		// Whitespace is flattened so the snippet stays a single line.
		expect(result.output).toContain("Reading the config loader before patching");
		expect(result.output).not.toContain("\n");
	});

	it("clips oversized salvage snippets", async () => {
		const settings = Settings.isolated({ "task.maxRuntimeMs": 50 });
		const longText = `start-marker ${"x".repeat(700)}`;
		const handle = createFakeSession({
			hang: true,
			lastAssistantMessage: {
				role: "assistant",
				stopReason: "aborted",
				content: [{ type: "text", text: longText }],
			},
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-salvage-clip", settings });

		expect(result.termination.status).toBe("aborted");
		expect(result.output).toContain("start-marker");
		expect(result.output).toContain("…");
		expect(result.output).not.toContain(longText);
		expect(result.output.length).toBeLessThan(700);
	});

	it("formats the (no output) fallback with the request count", () => {
		expect(formatResultOutputFallback({ output: "", stderr: "", requests: 7 })).toBe("(no output) after 7 req");
		expect(formatResultOutputFallback({ output: "  ", stderr: "", requests: 0 })).toBe("(no output)");
		expect(formatResultOutputFallback({ output: "real output", stderr: "", requests: 7 })).toBe("real output");
		expect(formatResultOutputFallback({ output: "", stderr: "boom", requests: 7 })).toBe("boom");
	});
});
