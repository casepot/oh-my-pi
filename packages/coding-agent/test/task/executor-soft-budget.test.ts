import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Caller-driven cancellation remains terminal even when request-budget
 * settings are present. Advisory request budgets never own termination; their
 * notice-only behavior is covered by task-guards.test.ts.
 */

interface MockSessionHandle {
	session: AgentSession;
	prompts: Array<{ text: string; options?: PromptOptions }>;
	abortCalls: () => number;
	disposeCalls: () => number;
}

function assistantText(text: string, stopReason: "stop" | "aborted" = "stop") {
	return { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason };
}

function createMockSession(
	onPrompt: (params: {
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		pushMessage: (message: unknown) => void;
	}) => void,
): MockSessionHandle {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: unknown[] = [];
	const prompts: Array<{ text: string; options?: PromptOptions }> = [];
	let abortCount = 0;
	let disposeCount = 0;
	let promptIndex = 0;

	const emit = (event: AgentSessionEvent) => {
		for (const listener of [...listeners]) listener(event);
	};

	const session: Partial<AgentSession> = {
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		model: { api: "anthropic-messages" } as never,
		extensionRunner: undefined as never,
		sessionManager: { appendSessionInit: () => {} } as never,
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			promptIndex += 1;
			prompts.push({ text, options });
			onPrompt({ promptIndex, emit, pushMessage: message => messages.push(message) });
			return true;
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => messages[messages.length - 1] as never,
		sendUserMessage: async () => {},
		deliverIrcMessage: async () => "woken",
		abort: async () => {
			abortCount += 1;
		},
		dispose: async () => {
			disposeCount += 1;
		},
	};

	return {
		session: session as AgentSession,
		prompts,
		abortCalls: () => abortCount,
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
// Named "task": bundled scout/sonic budgets are built-in and override the
// `task.softRequestBudget` setting, which these tests pin to a tiny value.
const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("runSubprocess external abort lifecycle", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-soft-budget-");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	function baseOptions(id: string) {
		return {
			cwd: "/tmp",
			agent: baseAgent,
			task: "inventory the api surface",
			index: 0,
			id,
			settings: Settings.isolated({ "task.softRequestBudget": 2 }),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: tempDir.path(),
		};
	}

	function registerRunning(id: string, session: AgentSession) {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile: null,
			status: "running",
		});
	}

	it("a caller-signal abort stays terminal and irc names the aborted agent precisely", async () => {
		const id = "CancelledScout";
		const controller = new AbortController();
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex !== 1) return;
			const message = assistantText("working");
			pushMessage(message);
			emit({ type: "message_end", message } as unknown as AgentSessionEvent);
			controller.abort();
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess({ ...baseOptions(id), signal: controller.signal });

		expect(result.termination.status).toBe("aborted");
		expect(AgentRegistry.global().get(id)?.status).toBe("aborted");
		expect(handle.disposeCalls()).toBeGreaterThanOrEqual(1);

		const receipt = await new IrcBus().send({ from: "Main", to: id, body: "resume" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/hard-aborted/);
		expect(receipt.error).toMatch(new RegExp(`history://${id}`));
	});
});
