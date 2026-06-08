import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context, Model, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const CONTEXT_WINDOW = 1_000;
const THRESHOLD_TOKENS = 100;
const HUGE_TOOL_RESULT = "provider usage floor tool result ".repeat(20);

function testUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(
	model: Model,
	totalTokens: number,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "seed response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: testUsage(totalTokens),
		stopReason,
		timestamp: Date.now(),
	};
}

function providerContext(): Context {
	return {
		systemPrompt: ["Test"],
		messages: [{ role: "user", content: "tiny", timestamp: Date.now() }],
		tools: [],
	};
}

describe("AgentSession provider-context estimator", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-provider-estimator-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-anthropic-key");
		modelRegistry = new ModelRegistry(authStorage);
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseModel) throw new Error("Expected bundled Anthropic model");
		model = { ...baseModel, contextWindow: CONTEXT_WINDOW };
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": THRESHOLD_TOKENS,
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry,
		});
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	function appendUser(content = "seed"): string {
		return sessionManager.appendMessage({ role: "user", content, timestamp: Date.now() });
	}

	function appendAssistant(
		totalTokens: number,
		stopReason?: AssistantMessage["stopReason"],
		targetModel: Model = model,
	): string {
		return sessionManager.appendMessage(assistantMessage(targetModel, totalTokens, stopReason));
	}

	function mockCompaction(summary = "usage floor compacted") {
		return vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary,
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	}

	async function runProviderPreflight() {
		return await session.preflightProviderContext({
			agentContext: {
				systemPrompt: ["Test"],
				messages: sessionManager.buildSessionContext().messages,
				tools: [],
			},
			providerContext: providerContext(),
		});
	}

	it("uses same-model provider usage as a provider-call floor when local context is below threshold", async () => {
		appendUser();
		appendAssistant(THRESHOLD_TOKENS + 25);
		const compactSpy = mockCompaction();

		const result = await runProviderPreflight();

		expect(result.action).toBe("rematerialize");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
	});

	it("uses the same usage floor for pre-prompt maintenance", async () => {
		appendUser();
		appendAssistant(THRESHOLD_TOKENS + 25);
		const compactSpy = mockCompaction("pre-prompt usage floor compacted");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("small pending prompt");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
	});

	it("adds post-usage tool results to the provider usage floor", async () => {
		session.settings.override("compaction.keepRecentTokens", 300);
		appendUser("old seed context ".repeat(3_000));
		appendAssistant(12);
		appendUser("old seed context second ".repeat(3_000));
		appendAssistant(12);
		appendUser();
		const toolCall: ToolCall = { type: "toolCall", id: "call_floor", name: "floor", arguments: {} };
		sessionManager.appendMessage({
			...assistantMessage(model, 12, "toolUse"),
			content: [toolCall],
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: HUGE_TOOL_RESULT }],
			isError: false,
			timestamp: Date.now(),
		});
		const compactSpy = mockCompaction("tool-result floor compacted");

		const result = await runProviderPreflight();

		expect(result.action).toBe("rematerialize");
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("ignores aborted and error assistant usage for the provider usage floor", async () => {
		appendUser();
		appendAssistant(THRESHOLD_TOKENS + 100, "aborted");
		appendUser("next");
		appendAssistant(THRESHOLD_TOKENS + 100, "error");
		const compactSpy = mockCompaction("ignored invalid usage");

		const result = await runProviderPreflight();

		expect(result.action).toBe("continue");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("ignores assistant usage from a previous model", async () => {
		const oldModel: Model = { ...model, id: "old-model" };
		appendUser();
		appendAssistant(THRESHOLD_TOKENS + 100, "stop", oldModel);
		const compactSpy = mockCompaction("ignored old model usage");

		const result = await runProviderPreflight();

		expect(result.action).toBe("continue");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("ignores usage before the latest compaction boundary even when the message is kept", async () => {
		appendUser();
		const keptAssistantId = appendAssistant(THRESHOLD_TOKENS + 100);
		sessionManager.appendCompaction("previous compaction", undefined, keptAssistantId, THRESHOLD_TOKENS + 100, {});
		appendUser("after compaction");
		const compactSpy = mockCompaction("ignored pre-compaction usage");

		const result = await runProviderPreflight();

		expect(result.action).toBe("continue");
		expect(compactSpy).not.toHaveBeenCalled();
	});
});
