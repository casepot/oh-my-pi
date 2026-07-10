import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, ProviderSessionState, Usage } from "@oh-my-pi/pi-ai";
import { z } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

const LONG_TOOL_RESULT = "inline maintenance tool result ".repeat(20);
const OLD_CONTEXT = "old seed context ".repeat(3_000);
const RESTING_THRESHOLD_TOKENS = 49_000;

describe("AgentSession inline provider-call maintenance", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-inline-maintenance-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-anthropic-key");
		authStorage.setRuntimeApiKey("openai", "test-openai-key");
		authStorage.setRuntimeApiKey("openai-codex", "test-codex-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	function testUsage(totalTokens = 24): Usage {
		return {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	function createAssistantMessage(model: Model, text: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: testUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function createEchoTool(onExecute?: () => void): AgentTool {
		const schema = z.object({ value: z.string() });
		return {
			name: "echo",
			label: "Echo",
			description: "Echoes a large result",
			parameters: schema,
			async execute() {
				onExecute?.();
				return { content: [{ type: "text", text: LONG_TOOL_RESULT }], details: { ok: true } };
			},
		};
	}

	function createHarness(options?: {
		model?: Model;
		strategy?: "context-full" | "handoff" | "snapcompact";
		seedContext?: boolean;
		firstUsageTokens?: number;
		mockMatchesSessionModel?: boolean;
	}) {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseModel) throw new Error("Expected bundled Anthropic model");
		const model = options?.model ?? { ...baseModel, contextWindow: 50_000 };
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		if (options?.seedContext !== false) {
			const seedTime = Date.now() - 10;
			sessionManager.appendMessage({ role: "user", content: OLD_CONTEXT, timestamp: seedTime });
			sessionManager.appendMessage({ ...createAssistantMessage(model, "seed response"), timestamp: seedTime + 1 });
			sessionManager.appendMessage({ role: "user", content: `${OLD_CONTEXT} second`, timestamp: seedTime + 2 });
			sessionManager.appendMessage({
				...createAssistantMessage(model, "second seed response"),
				timestamp: seedTime + 3,
			});
		}
		let activeSession: AgentSession | undefined;
		const tool = createEchoTool(() => {
			activeSession?.settings.override("compaction.thresholdTokens", 1_500);
		});
		const firstUsage = options?.firstUsageTokens === undefined ? undefined : testUsage(options.firstUsageTokens);
		const mock = createMockModel({
			...(options?.mockMatchesSessionModel ? { id: model.id, provider: model.provider } : {}),
			responses: [
				{
					content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "go" } }],
					...(firstUsage ? { usage: firstUsage } : {}),
				},
				{ content: ["after inline maintenance"] },
			],
		});
		let hasSession = false;
		const initialContext = sessionManager.buildSessionContext();
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [tool],
				messages: initialContext.messages,
			},
			streamFn: mock.stream,
			convertToLlm,
			syncContextBeforeModelCall: (context, signal) => {
				if (!hasSession || !activeSession) return;
				if (context.messages.some(message => message.role === "toolResult")) {
					activeSession.settings.override("compaction.thresholdTokens", 1_500);
				}
				return activeSession.syncContextBeforeModelCall(context, signal);
			},
			preflightProviderContext: input => {
				if (!hasSession || !activeSession) return { action: "continue" };
				return activeSession.preflightProviderContext(input);
			},
		});
		const events: AgentSessionEvent[] = [];
		activeSession = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": true,
				"compaction.strategy": options?.strategy ?? "context-full",
				"compaction.thresholdTokens": RESTING_THRESHOLD_TOKENS,
				"compaction.keepRecentTokens": 300,
			}),
			modelRegistry,
		});
		hasSession = true;
		activeSession.subscribe(event => events.push(event));
		session = activeSession;
		return { agent, session: activeSession, sessionManager, mock, events, model };
	}

	function findCurrentPromptEntryId(sessionManager: SessionManager): string {
		const entry = sessionManager.getEntries().find(entry => {
			if (entry.type !== "message" || entry.message.role !== "user") return false;
			const content = entry.message.content;
			const text =
				typeof content === "string"
					? content
					: content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			return text.includes("use the echo tool");
		});
		if (!entry) throw new Error("Expected persisted prompt entry");
		return entry.id;
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
			await Bun.sleep(1);
		}
	}

	it("compacts and rematerializes a tool-result continuation before the second provider call", async () => {
		const { mock, sessionManager, events } = createHarness({ strategy: "handoff" });
		let callsAtCompact = -1;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			callsAtCompact = mock.calls.length;
			session!.settings.override("compaction.thresholdTokens", RESTING_THRESHOLD_TOKENS);
			return {
				summary: "inline provider-call compacted",
				shortSummary: undefined,
				firstKeptEntryId: findCurrentPromptEntryId(sessionManager),
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});
		const handoffSpy = vi.spyOn(session!, "handoff");
		const continueSpy = vi.spyOn(session!.agent, "continue");

		await session!.prompt("use the echo tool");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(handoffSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(callsAtCompact).toBe(1);
		expect(mock.calls).toHaveLength(2);
		const secondCallRoles = mock.calls[1]?.context.messages.map(message => message.role);
		expect(secondCallRoles?.[0]).toBe("user");
		const secondCallFirstMessage = JSON.stringify(mock.calls[1]?.context.messages[0]);
		expect(secondCallFirstMessage).toContain("inline provider-call compacted");
		expect(JSON.stringify(mock.calls[0]?.context.messages)).not.toContain("inline provider-call compacted");
		expect(JSON.stringify(mock.calls[1]?.context.messages)).toContain("inline provider-call compacted");
		expect(JSON.stringify(mock.calls[1]?.context.messages)).not.toContain(OLD_CONTEXT);
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(events).toContainEqual({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		expect(events.some(event => event.type === "auto_compaction_end" && event.action === "context-full")).toBe(true);
	});

	it("uses snapcompact instead of the local LLM summarizer for inline provider-call maintenance", async () => {
		const { mock, sessionManager, events } = createHarness({ strategy: "snapcompact" });
		const localCompactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValue(new Error("local compaction should not run"));
		let callsAtSnapcompact = -1;
		const snapcompactSpy = vi.spyOn(snapcompact, "compact").mockImplementation(async preparation => {
			callsAtSnapcompact = mock.calls.length;
			session!.settings.override("compaction.thresholdTokens", RESTING_THRESHOLD_TOKENS);
			return {
				summary: "inline snapcompact archive",
				shortSummary: "snapcompact",
				firstKeptEntryId: findCurrentPromptEntryId(sessionManager),
				tokensBefore: preparation.tokensBefore,
				details: { readFiles: [], modifiedFiles: [] },
				preserveData: {
					snapcompact: { frames: [], totalChars: 0, truncatedChars: 0 },
				},
			};
		});

		await session!.prompt("use the echo tool");

		expect(snapcompactSpy).toHaveBeenCalledTimes(1);
		expect(localCompactSpy).not.toHaveBeenCalled();
		expect(callsAtSnapcompact).toBe(1);
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[0]?.context.messages)).not.toContain("inline snapcompact archive");
		expect(JSON.stringify(mock.calls[1]?.context.messages)).toContain("inline snapcompact archive");
		expect(JSON.stringify(mock.calls[1]?.context.messages)).not.toContain(OLD_CONTEXT);
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(events).toContainEqual({ type: "auto_compaction_start", reason: "threshold", action: "snapcompact" });
		expect(events.some(event => event.type === "auto_compaction_end" && event.action === "snapcompact")).toBe(true);
	});

	it("does not warn when stale pending usage exceeds the band but compacted context fits", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseModel) throw new Error("Expected bundled Anthropic model");
		const { mock, sessionManager, events, model } = createHarness({
			model: { ...baseModel, contextWindow: 272_000 },
			firstUsageTokens: 204_405,
			mockMatchesSessionModel: true,
		});
		let callsAtCompact = -1;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			callsAtCompact = mock.calls.length;
			session!.settings.override("compaction.thresholdTokens", RESTING_THRESHOLD_TOKENS);
			return {
				summary: "provider-floor compacted before second call",
				shortSummary: undefined,
				firstKeptEntryId: findCurrentPromptEntryId(sessionManager),
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});
		const preflightResults: string[] = [];
		const originalPreflight = session!.preflightProviderContext.bind(session!);
		vi.spyOn(session!, "preflightProviderContext").mockImplementation(async input => {
			const result = await originalPreflight(input);
			preflightResults.push(result.action);
			return result;
		});

		await session!.prompt("use the echo tool");
		const persistedToolUse = sessionManager.getEntries().find(entry => {
			return (
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "toolUse"
			);
		});
		expect(persistedToolUse).toBeDefined();
		if (persistedToolUse?.type !== "message" || persistedToolUse.message.role !== "assistant") {
			throw new Error("Expected persisted tool-use assistant");
		}
		expect(persistedToolUse.message.provider).toBe(model.provider);
		expect(persistedToolUse.message.model).toBe(model.id);
		expect(persistedToolUse.message.usage.totalTokens).toBe(204_405);

		expect(preflightResults).toEqual(["continue", "continue"]);
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(callsAtCompact).toBe(1);
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[0]?.context.messages)).not.toContain(
			"provider-floor compacted before second call",
		);
		expect(JSON.stringify(mock.calls[1]?.context.messages)).toContain("provider-floor compacted before second call");
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(events).toContainEqual({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		expect(events.some(event => event.type === "auto_compaction_end" && event.action === "context-full")).toBe(true);
		const noProgressNotices = events.filter(
			event =>
				event.type === "notice" &&
				event.source === "compaction" &&
				event.message.includes("Compaction freed too little context"),
		);
		expect(noProgressNotices).toHaveLength(0);
	});

	it("fails closed and keeps an empty maintenance assistant error out of persisted history", async () => {
		const { mock, sessionManager } = createHarness();
		vi.spyOn(compactionModule, "compact").mockRejectedValue(new Error("summary backend down"));

		await session!.prompt("use the echo tool");

		expect(mock.calls).toHaveLength(1);
		const persistedAssistantErrors = sessionManager.getEntries().filter(entry => {
			return (
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.stopReason === "error" &&
				entry.message.errorMessage?.includes("Context maintenance failed before provider call")
			);
		});
		expect(persistedAssistantErrors).toHaveLength(0);
		expect(session!.agent.state.messages.at(-1)?.role).toBe("assistant");
		expect(session!.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("Context maintenance failed before provider call"),
		});
	});

	it("retries from the fresh branch instead of appending stale inline maintenance history", async () => {
		const { mock, sessionManager } = createHarness();
		let callsAtCompact = -1;
		let compactCalls = 0;
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			compactCalls += 1;
			callsAtCompact = mock.calls.length;
			if (compactCalls === 1) {
				sessionManager.appendMessage({
					role: "user",
					content: "branch changed while inline maintenance was preparing",
					timestamp: Date.now(),
				});
			}
			session!.settings.override("compaction.thresholdTokens", RESTING_THRESHOLD_TOKENS);
			return {
				summary: compactCalls === 1 ? "stale inline compacted" : "fresh inline compacted after branch change",
				shortSummary: undefined,
				firstKeptEntryId: findCurrentPromptEntryId(sessionManager),
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		await session!.prompt("use the echo tool");

		expect(callsAtCompact).toBe(1);
		expect(compactCalls).toBe(2);
		expect(mock.calls).toHaveLength(2);
		expect(
			sessionManager
				.getEntries()
				.some(entry => entry.type === "compaction" && entry.summary === "stale inline compacted"),
		).toBe(false);
		expect(
			sessionManager
				.getEntries()
				.some(
					entry => entry.type === "compaction" && entry.summary === "fresh inline compacted after branch change",
				),
		).toBe(true);
		expect(JSON.stringify(mock.calls[1]?.context.messages)).toContain("fresh inline compacted after branch change");
		const persistedAssistantErrorMessages = sessionManager.getEntries().flatMap(entry => {
			if (
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.stopReason === "error" &&
				entry.message.errorMessage?.includes("Context maintenance failed before provider call")
			) {
				return [entry.message.errorMessage];
			}
			return [];
		});
		expect(persistedAssistantErrorMessages).toHaveLength(0);
	});

	it("commits inline maintenance across append-only background entries without retrying", async () => {
		const { mock, sessionManager } = createHarness();
		let compactCalls = 0;
		let usageId: string | undefined;
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			compactCalls += 1;
			sessionManager.appendCustomMessageEntry(
				"async-result",
				"background job finished during inline maintenance",
				true,
				{ jobs: [{ jobId: "job-1" }] },
				"agent",
			);
			sessionManager.appendCustomEntry("agent-ref", { id: "ReviewScout", status: "idle" });
			usageId = sessionManager.appendGoalUsageDelta({
				goalId: "goal-1",
				stateVersion: 1,
				tokenDelta: 9,
				wallSeconds: 2,
				tokensUsed: 9,
				timeUsedSeconds: 2,
				updatedAt: Date.now(),
			});
			session!.settings.override("compaction.thresholdTokens", RESTING_THRESHOLD_TOKENS);
			return {
				summary: "inline compacted despite append-only suffix",
				shortSummary: undefined,
				firstKeptEntryId: findCurrentPromptEntryId(sessionManager),
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		await session!.prompt("use the echo tool");

		expect(compactCalls).toBe(1);
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[1]?.context.messages)).toContain("inline compacted despite append-only suffix");
		expect(JSON.stringify(mock.calls[1]?.context.messages)).toContain(
			"background job finished during inline maintenance",
		);
		const compactionEntries = sessionManager.getEntries().filter(entry => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		const compactionEntry = compactionEntries[0];
		if (!compactionEntry || !usageId) throw new Error("Expected one compaction appended after usage delta");
		expect(compactionEntry.parentId).toBe(usageId);
		const persistedAssistantErrorMessages = sessionManager.getEntries().filter(entry => {
			return (
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.stopReason === "error" &&
				entry.message.errorMessage?.includes("Context maintenance failed before provider call")
			);
		});
		expect(persistedAssistantErrorMessages).toHaveLength(0);
	});

	it("supersedes stale idle work before inline provider-call maintenance", async () => {
		const { mock, sessionManager } = createHarness();
		let compactCalls = 0;
		let idleSignal: AbortSignal | undefined;
		vi.spyOn(compactionModule, "compact").mockImplementation(
			async (preparation, _model, _apiKey, _instructions, signal) => {
				if (!signal) throw new Error("Expected compaction abort signal");
				compactCalls++;
				if (compactCalls === 1) {
					idleSignal = signal;
					return await new Promise<never>((_resolve, reject) => {
						const abort = () => {
							const error = new Error("aborted");
							error.name = "AbortError";
							reject(error);
						};
						if (signal.aborted) {
							abort();
						} else {
							signal.addEventListener("abort", abort, { once: true });
						}
					});
				}
				session!.settings.override("compaction.thresholdTokens", RESTING_THRESHOLD_TOKENS);
				return {
					summary: "fresh inline compacted after idle",
					shortSummary: undefined,
					firstKeptEntryId: findCurrentPromptEntryId(sessionManager),
					tokensBefore: preparation.tokensBefore,
					details: {},
				};
			},
		);
		const idleRun = session!.runIdleCompaction();
		await waitFor(() => compactCalls === 1);

		await session!.prompt("use the echo tool");
		await idleRun;

		expect(idleSignal?.aborted).toBe(true);
		expect(compactCalls).toBe(2);
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[1]?.context.messages)).toContain("fresh inline compacted after idle");
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(
			sessionManager
				.getEntries()
				.some(entry => entry.type === "compaction" && entry.summary === "fresh inline compacted after idle"),
		).toBe(true);
	});

	it("supersedes active threshold work before inline provider-call maintenance", async () => {
		const { mock, sessionManager, model } = createHarness();
		let compactCalls = 0;
		let thresholdSignal: AbortSignal | undefined;
		vi.spyOn(compactionModule, "compact").mockImplementation(
			async (preparation, _model, _apiKey, _instructions, signal) => {
				if (!signal) throw new Error("Expected compaction abort signal");
				compactCalls++;
				if (compactCalls === 1) {
					thresholdSignal = signal;
					return await new Promise<never>((_resolve, reject) => {
						const abort = () => {
							const error = new Error("aborted");
							error.name = "AbortError";
							reject(error);
						};
						if (signal.aborted) {
							abort();
						} else {
							signal.addEventListener("abort", abort, { once: true });
						}
					});
				}
				session!.settings.override("compaction.thresholdTokens", RESTING_THRESHOLD_TOKENS);
				return {
					summary: "fresh inline compacted after threshold",
					shortSummary: undefined,
					firstKeptEntryId: findCurrentPromptEntryId(sessionManager),
					tokensBefore: preparation.tokensBefore,
					details: {},
				};
			},
		);
		const continueSpy = vi.spyOn(session!.agent, "continue").mockResolvedValue(undefined);
		const handoffSpy = vi.spyOn(session!, "handoff");
		session!.settings.override("compaction.thresholdTokens", 1_500);
		const thresholdAssistant = {
			...createAssistantMessage(model, "active threshold response"),
			usage: testUsage(2_000),
		};
		session!.agent.emitExternalEvent({ type: "message_end", message: thresholdAssistant });
		session!.agent.emitExternalEvent({ type: "agent_end", messages: [thresholdAssistant] });
		await waitFor(() => compactCalls === 1);
		session!.settings.override("compaction.thresholdTokens", RESTING_THRESHOLD_TOKENS);

		await session!.prompt("use the echo tool", { skipCompactionCheck: true });

		expect(thresholdSignal?.aborted).toBe(true);
		expect(compactCalls).toBe(2);
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[1]?.context.messages)).toContain("fresh inline compacted after threshold");
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(handoffSpy).not.toHaveBeenCalled();
	});
	it("resets codex provider replay state after inline history rewrite", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.3-codex");
		if (!codexModel) throw new Error("Expected bundled Codex model");
		const { mock, sessionManager } = createHarness({ model: { ...codexModel, contextWindow: 50_000 } });
		const closeSpy = vi.fn();
		session!.providerSessionState.set("openai-codex-responses", { close: closeSpy } satisfies ProviderSessionState);
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			session!.settings.override("compaction.thresholdTokens", RESTING_THRESHOLD_TOKENS);
			return {
				summary: "codex inline compacted",
				shortSummary: undefined,
				firstKeptEntryId: findCurrentPromptEntryId(sessionManager),
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		await session!.prompt("use the echo tool");

		expect(mock.calls).toHaveLength(2);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session!.providerSessionState.size).toBe(0);
	});

	it("resets OpenAI Responses provider replay state after inline history rewrite", async () => {
		const openAiModel = getBundledModel("openai", "gpt-5-mini");
		if (!openAiModel) throw new Error("Expected bundled OpenAI Responses model");
		const { mock, sessionManager } = createHarness({ model: { ...openAiModel, contextWindow: 50_000 } });
		const closeSpy = vi.fn();
		session!.providerSessionState.set("openai-responses:openai", { close: closeSpy } satisfies ProviderSessionState);
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			session!.settings.override("compaction.thresholdTokens", RESTING_THRESHOLD_TOKENS);
			return {
				summary: "openai inline compacted",
				shortSummary: undefined,
				firstKeptEntryId: findCurrentPromptEntryId(sessionManager),
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		await session!.prompt("use the echo tool");

		expect(mock.calls).toHaveLength(2);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session!.providerSessionState.size).toBe(0);
	});
});
