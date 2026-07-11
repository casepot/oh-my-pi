import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const usage = {
	input: 16,
	output: 8,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 24,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("AgentSession shake", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let events: AgentSessionEvent[];
	let apiInfo: { api: AssistantMessage["api"]; provider: AssistantMessage["provider"]; model: string };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-shake-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		apiInfo = { api: model.api, provider: model.provider, model: model.id };

		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry,
		});
		session.subscribe(event => events.push(event));
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	/** Seed a user → assistant(toolCall) → toolResult turn carrying a heavy bash result. */
	function seedHeavyToolResult(text: string, toolName = "bash"): void {
		const toolCallId = `call_${toolName}_${Math.random().toString(36).slice(2)}`;
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "do it" }],
			timestamp: Date.now() - 3,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "working" },
				{ type: "toolCall", id: toolCallId, name: toolName, arguments: { command: "ls" } },
			],
			...apiInfo,
			stopReason: "toolUse",
			usage,
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now() - 1,
		});
	}

	function branchToolResults(): ToolResultMessage[] {
		return sessionManager
			.getBranch()
			.filter(e => e.type === "message" && (e.message as { role?: string }).role === "toolResult")
			.map(e => (e as { message: ToolResultMessage }).message);
	}

	describe("elide", () => {
		it("drops the tool result, offloads to an artifact, and embeds the recovery link", async () => {
			seedHeavyToolResult("X".repeat(4000));
			const replaceSpy = vi.spyOn(session.agent, "replaceMessages");

			const result = await session.shake("elide");

			expect(result.mode).toBe("elide");
			expect(result.toolResultsDropped).toBe(1);
			expect(result.tokensFreed).toBeGreaterThan(0);
			expect(result.artifactId).toBeDefined();
			expect(replaceSpy).toHaveBeenCalled();

			const [tr] = branchToolResults();
			expect(tr.prunedAt).toBeGreaterThan(0);
			const text = tr.content.map(b => (b.type === "text" ? b.text : "")).join("");
			expect(text).toContain(`artifact://${result.artifactId}`);
			expect(text).toContain("shaken");
		});

		it("does not mutate session state when saving the recovery artifact fails", async () => {
			seedHeavyToolResult("A".repeat(4000));
			session.agent.replaceMessages(sessionManager.buildSessionContext().messages);
			await sessionManager.flush();
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file");
			const initialToolResult = branchToolResults()[0];
			if (!initialToolResult) throw new Error("Expected a seeded tool result");
			const before = {
				branch: structuredClone(sessionManager.getBranch()),
				prunedAt: initialToolResult.prunedAt,
				agentMessages: structuredClone(session.agent.state.messages),
				durableJsonl: await Bun.file(sessionFile).text(),
			};
			const saveArtifactSpy = vi
				.spyOn(sessionManager, "saveArtifact")
				.mockRejectedValueOnce(new Error("artifact write failed"));

			await expect(session.shake("elide")).rejects.toThrow("artifact write failed");

			const failedToolResult = branchToolResults()[0];
			if (!failedToolResult) throw new Error("Expected the tool result after the failed shake");
			expect(saveArtifactSpy).toHaveBeenCalledTimes(1);
			expect({
				branch: sessionManager.getBranch(),
				prunedAt: failedToolResult.prunedAt,
				agentMessages: session.agent.state.messages,
				durableJsonl: await Bun.file(sessionFile).text(),
			}).toEqual(before);
		});

		it("rolls back elision when rewriting fails and allows a subsequent retry", async () => {
			seedHeavyToolResult("R".repeat(4000));
			session.agent.replaceMessages(sessionManager.buildSessionContext().messages);
			const initialToolResult = branchToolResults()[0];
			if (!initialToolResult) throw new Error("Expected a seeded tool result");
			const before = {
				content: structuredClone(initialToolResult.content),
				prunedAt: initialToolResult.prunedAt,
				agentMessages: structuredClone(session.agent.state.messages),
			};
			const rewriteSpy = vi
				.spyOn(sessionManager, "rewriteEntries")
				.mockRejectedValueOnce(new Error("session rewrite failed"));

			await expect(session.shake("elide")).rejects.toThrow("session rewrite failed");

			const rolledBackToolResult = branchToolResults()[0];
			if (!rolledBackToolResult) throw new Error("Expected the tool result after rollback");
			expect(rewriteSpy).toHaveBeenCalledTimes(1);
			expect({
				content: rolledBackToolResult.content,
				prunedAt: rolledBackToolResult.prunedAt,
				agentMessages: session.agent.state.messages,
			}).toEqual(before);

			const retry = await session.shake("elide");

			expect(rewriteSpy).toHaveBeenCalledTimes(2);
			expect(retry.artifactId).toBeDefined();
			const retriedToolResult = branchToolResults()[0];
			if (!retriedToolResult) throw new Error("Expected the retried tool result");
			const retriedText = retriedToolResult.content.map(block => (block.type === "text" ? block.text : "")).join("");
			expect(retriedToolResult.prunedAt).toBeGreaterThan(0);
			expect(retriedText).toContain(`artifact://${retry.artifactId}`);
		});

		it("resets stale provider usage floors after eliding history", async () => {
			seedHeavyToolResult("X".repeat(4000));
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "after tool" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 11_000,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
			session.settings.set("compaction.thresholdTokens", 10_000);
			session.settings.set("compaction.thresholdPercent", -1);

			const shakeResult = await session.shake("elide");
			expect(shakeResult.tokensFreed).toBeGreaterThan(0);

			const preflight = await session.preflightProviderContext({
				agentContext: {
					messages: session.agent.state.messages,
					systemPrompt: session.agent.state.systemPrompt,
					tools: session.agent.state.tools,
				},
				providerContext: { messages: [], systemPrompt: [], tools: [] },
			});

			expect(preflight.action).toBe("continue");
		});

		it("returns zero counts for an empty branch", async () => {
			const result = await session.shake("elide");
			expect(result.toolResultsDropped).toBe(0);
			expect(result.blocksDropped).toBe(0);
			expect(result.tokensFreed).toBe(0);
		});
	});

	describe("images", () => {
		it("mirrors dropImages and reports the removed image count", async () => {
			const png: ImageContent = { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" };
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "look" }, png],
				timestamp: Date.now(),
			});

			const result = await session.shake("images");

			expect(result.mode).toBe("images");
			expect(result.imagesDropped).toBe(1);
			const branch = sessionManager.getBranch();
			const userMsg = branch.find(e => e.type === "message" && (e.message as { role?: string }).role === "user");
			const content = (userMsg as { message: { content: unknown } }).message.content as Array<{ type: string }>;
			expect(content.some(b => b.type === "image")).toBe(false);
		});

		it("rolls back image removal when rewriting fails and allows a subsequent retry", async () => {
			const png: ImageContent = { type: "image", data: "rollback-image", mimeType: "image/png" };
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "keep this image until commit" }, png],
				timestamp: Date.now(),
			});
			session.agent.replaceMessages(sessionManager.buildSessionContext().messages);
			const userEntry = sessionManager
				.getBranch()
				.find(entry => entry.type === "message" && entry.message.role === "user");
			if (!userEntry || userEntry.type !== "message" || userEntry.message.role !== "user") {
				throw new Error("Expected a seeded user message");
			}
			const before = {
				content: structuredClone(userEntry.message.content),
				agentMessages: structuredClone(session.agent.state.messages),
			};
			const rewriteSpy = vi
				.spyOn(sessionManager, "rewriteEntries")
				.mockRejectedValueOnce(new Error("image rewrite failed"));

			await expect(session.shake("images")).rejects.toThrow("image rewrite failed");

			expect(rewriteSpy).toHaveBeenCalledTimes(1);
			expect({
				content: userEntry.message.content,
				agentMessages: session.agent.state.messages,
			}).toEqual(before);
			expect(userEntry.message.content).toEqual([{ type: "text", text: "keep this image until commit" }, png]);

			const retry = await session.shake("images");

			expect(rewriteSpy).toHaveBeenCalledTimes(2);
			expect(retry.imagesDropped).toBe(1);
			expect(userEntry.message.content).toEqual([{ type: "text", text: "keep this image until commit" }]);
		});
	});

	describe("protected tools", () => {
		it("never shakes skill results", async () => {
			seedHeavyToolResult("S".repeat(4000), "skill");
			const result = await session.shake("elide");
			expect(result.toolResultsDropped).toBe(0);
		});
	});

	describe("auto-shake strategy", () => {
		it("dispatches the elide path and emits a shake action for threshold maintenance", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdPercent", 1);

			// Reclaim enough that the corrected (provider − tokensFreed) figure lands
			// below the configured threshold, so shake handles the maintenance pass
			// without falling back to context-full.
			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10_000 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await Bun.sleep(20);

			expect(shakeSpy).toHaveBeenCalledWith("elide", expect.anything());
			const start = events.filter(e => e.type === "auto_compaction_start");
			expect(start).toHaveLength(1);
			expect(start[0]).toMatchObject({ type: "auto_compaction_start", reason: "threshold", action: "shake" });
			const end = events.filter(e => e.type === "auto_compaction_end");
			expect(end).toHaveLength(1);
			expect(end[0]).toMatchObject({ type: "auto_compaction_end", action: "shake" });
		});

		it("continues after auto-shake when reclaimed context is below the configured threshold", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.override("compaction.autoContinue", true);
			session.settings.set("compaction.thresholdTokens", 10_000);
			session.settings.set("compaction.thresholdPercent", -1);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 1_500 });
			const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => undefined);
			const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end" && event.action === "shake") onCompactionDone();
			});

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_500,
					output: 500,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};

			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });

			await compactionDone;
			await session.waitForIdle();

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			expect(promptSpy).toHaveBeenCalledTimes(1);
			const shakeEnd = events.find(event => event.type === "auto_compaction_end" && event.action === "shake");
			expect(shakeEnd).toMatchObject({ type: "auto_compaction_end", action: "shake", willRetry: false });
			const fullStart = events.find(
				event => event.type === "auto_compaction_start" && event.action === "context-full",
			);
			expect(fullStart).toBeUndefined();
		});

		it("keeps a successful overflow shake recovery committed before retrying", async () => {
			session.settings.set("compaction.strategy", "shake");
			seedHeavyToolResult("X ".repeat(20000));
			branchToolResults()[0].useless = true;
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			vi.spyOn(session.agent, "continue").mockResolvedValue();
			vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 200000, percent: 0.5 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				...apiInfo,
				stopReason: "error",
				errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
				usage: {
					input: 250_000,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 250_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end" && event.action === "shake") onCompactionDone();
			});
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });

			await compactionDone;
			await session.waitForIdle();

			const shakeEnd = events.find(event => event.type === "auto_compaction_end" && event.action === "shake");
			expect(shakeEnd).toMatchObject({ type: "auto_compaction_end", action: "shake", willRetry: true });
			expect(sessionManager.getBranch()).not.toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({
						role: "assistant",
						stopReason: "error",
						errorMessage: assistantMessage.errorMessage,
					}),
				}),
			);
			expect(session.agent.state.messages).not.toContainEqual(
				expect.objectContaining({
					role: "assistant",
					stopReason: "error",
					errorMessage: assistantMessage.errorMessage,
				}),
			);
		});

		it("recovers incomplete output locally instead of running shake compaction", async () => {
			session.settings.set("compaction.strategy", "shake");
			const { promise: continued, resolve: onContinue } = Promise.withResolvers<void>();
			const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
				onContinue();
			});
			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "partial response" }],
				...apiInfo,
				stopReason: "length",
				usage: {
					input: 20_000,
					output: 5_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 25_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });

			await continued;
			await session.waitForIdle();

			expect(shakeSpy).not.toHaveBeenCalled();
			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(
				events.filter(event => event.type === "auto_compaction_start" || event.type === "auto_compaction_end"),
			).toHaveLength(0);
			expect(sessionManager.getBranch()).toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({
						role: "assistant",
						stopReason: "length",
						timestamp: assistantMessage.timestamp,
					}),
				}),
			);
			expect(sessionManager.getBranch()).toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({ role: "developer", attribution: "agent" }),
				}),
			);
		});

		it("has isCompacting true when the shake auto_compaction_start event fires", async () => {
			// Defect 1 parity for the shake strategy: the controller backing isCompacting
			// must be installed before auto_compaction_start is emitted, so a message
			// typed as the loader appears is queued safely rather than mis-routed.
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdPercent", 1);

			let capturedIsCompacting: boolean | undefined;
			const { promise: shakeStarted, resolve: onShakeStarted } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_start" && event.action === "shake") {
					capturedIsCompacting = session.isCompacting;
					onShakeStarted();
				}
			});

			vi.spyOn(session, "shake").mockResolvedValue({
				mode: "elide",
				toolResultsDropped: 1,
				blocksDropped: 0,
				tokensFreed: 10_000,
			});

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await shakeStarted;

			expect(capturedIsCompacting).toBe(true);
		});

		it("falls back to context-full when shake cannot drop context below the threshold (regression #2119)", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdPercent", 1);

			// Seed agent state so the post-shake estimate is well above the 1% threshold
			// (~2K tokens for a 200K window). The mocked shake returns reclaimed=true but
			// does not modify state, mimicking the dead-loop scenario where shake removes
			// nothing material yet the threshold check stays positive.
			session.agent.replaceMessages([
				{
					role: "user",
					content: [{ type: "text", text: "x".repeat(40000) }],
					timestamp: Date.now(),
				} as never,
			]);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await Bun.sleep(50);

			// Shake fires once. The pre-fix bug auto-continued, which would re-trigger shake
			// on the next agent_end. The fix replaces that loop with a one-shot fallback.
			expect(shakeSpy).toHaveBeenCalledTimes(1);

			const shakeEnd = events.find(
				e => e.type === "auto_compaction_end" && (e as { action?: string }).action === "shake",
			) as { errorMessage?: string; skipped?: boolean } | undefined;
			expect(shakeEnd).toBeDefined();
			expect(shakeEnd?.errorMessage).toMatch(/falling back to context-full/i);

			// Fallback enters the context-full path so the situation actually resolves.
			const fullStart = events.find(
				e => e.type === "auto_compaction_start" && (e as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeDefined();
		});

		it("falls back when provider-reported usage stays above the threshold even though the local estimate is below it (regression #2275)", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdTokens", 5_000);

			// Agent state holds almost no content, so #estimatePendingPromptTokens reads
			// well below the 5K threshold. The pre-fix post-shake check trusted that
			// estimate and treated the pressure as resolved, even though the assistant
			// message's provider-reported usage (11K) was well above the threshold.
			// This is the metric-divergence dead loop from #2275: thinking-heavy
			// sessions hit it for real (thinkingSignature payloads aren't counted by
			// the estimator), and an empty-state probe mimics it deterministically.
			session.agent.replaceMessages([]);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await Bun.sleep(50);

			expect(shakeSpy).toHaveBeenCalledTimes(1);

			const shakeEnd = events.find(
				e => e.type === "auto_compaction_end" && (e as { action?: string }).action === "shake",
			) as { errorMessage?: string; skipped?: boolean } | undefined;
			expect(shakeEnd).toBeDefined();
			expect(shakeEnd?.errorMessage).toMatch(/falling back to context-full/i);

			const fullStart = events.find(
				e => e.type === "auto_compaction_start" && (e as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeDefined();
		});

		it("counts pre-shake prune savings when deciding whether to fall back to context-full", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdTokens", 76384);
			session.settings.set("compaction.thresholdPercent", -1);
			session.settings.set("compaction.dropUseless", true);

			const now = Date.now();
			sessionManager.appendMessage({
				role: "user",
				content: "Investigate every module of the project.",
				timestamp: now - 200,
			});
			const bigCallId = "call-big-useless-for-shake";
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: bigCallId, name: "grep", arguments: { pattern: "TODO" } }],
				...apiInfo,
				stopReason: "toolUse",
				usage,
				timestamp: now - 180,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: bigCallId,
				toolName: "grep",
				content: [{ type: "text", text: "match line\n".repeat(20000) }],
				isError: false,
				useless: true,
				timestamp: now - 170,
			});
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 100 });

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 5000,
					output: 1000,
					cacheRead: 85000,
					cacheWrite: 0,
					totalTokens: 91000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: now,
			};

			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await Bun.sleep(50);

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			const fullStart = events.find(
				event => event.type === "auto_compaction_start" && (event as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeUndefined();
		});

		it("falls back after pre-prompt shake when the floored stored conversation remains over threshold", async () => {
			session.settings.set("compaction.strategy", "shake");
			session.settings.set("compaction.thresholdTokens", 8_000);
			session.settings.set("compaction.keepRecentTokens", 1);

			const seedUser: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: "seed" }],
				timestamp: Date.now() - 2,
			};
			const bulkText = "alpha beta gamma delta epsilon ".repeat(3_000);
			const seedAssistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: bulkText }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 1_000,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_010,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now() - 1,
			};
			sessionManager.appendMessage(seedUser);
			sessionManager.appendMessage(seedAssistant);
			session.agent.replaceMessages([seedUser, seedAssistant]);

			const shakeSpy = vi
				.spyOn(session, "shake")
				.mockResolvedValue({ mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 10 });
			const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
				summary: "pre-prompt shake fallback compacted",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));
			vi.spyOn(session.agent, "prompt").mockImplementation(async () => {});

			expect(session.getContextUsage({ contextWindow: 200_000 })?.tokens).toBe(1_000);

			await session.prompt("small pending prompt", { skipCompactionCheck: true });

			expect(shakeSpy).toHaveBeenCalledTimes(1);
			expect(compactSpy).toHaveBeenCalled();
			const fullStart = events.find(
				event => event.type === "auto_compaction_start" && (event as { action?: string }).action === "context-full",
			);
			expect(fullStart).toBeDefined();
		});
	});
});
