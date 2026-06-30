import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation, CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { serializeGoalModeState, type GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getLatestCompactionEntry, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const OLD_CONTEXT = "stale compaction seed context ".repeat(400);
const THRESHOLD_TOKENS = 50;

type HookEvent = { type: string } & Record<string, unknown>;
type HookHandler = (event: HookEvent) => unknown | Promise<unknown>;

function testUsage(totalTokens = 120): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(model: Model, text = "seed response", totalTokens = 120): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: testUsage(totalTokens),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function compactionFromPreparation(preparation: CompactionPreparation, summary: string): CompactionResult {
	return {
		summary,
		shortSummary: undefined,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: {},
	};
}

function activeGoalState(): GoalModeState {
	const now = Date.now();
	return {
		enabled: true,
		mode: "active",
		runMode: "working-target",
		stateVersion: 1,
		parentFrameVersion: 0,
		goal: {
			id: "goal-compaction-race",
			objective: "Keep goal state safe through compaction",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		},
	};
}

describe("AgentSession stale-safe compaction commits", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let session: AgentSession | undefined;
	let sessionManager: SessionManager;
	let events: AgentSessionEvent[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-compaction-stale-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-anthropic-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled Anthropic model");
		model = { ...bundled, contextWindow: 1_000 };
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];
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

	function createExtensionRunner(handlers: Record<string, HookHandler>): ExtensionRunner {
		return {
			hasHandlers: (eventType: string) => handlers[eventType] !== undefined,
			emit: vi.fn((event: HookEvent) => handlers[event.type]?.(event)),
		} as unknown as ExtensionRunner;
	}

	function createSession(extensionRunner?: ExtensionRunner): AgentSession {
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
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
			extensionRunner,
		});
		session.subscribe(event => events.push(event));
		return session;
	}

	function appendSeedTurn(label = "seed"): { userId: string; assistantId: string } {
		const userId = sessionManager.appendMessage({
			role: "user",
			content: `${OLD_CONTEXT} ${label}`,
			timestamp: Date.now(),
		});
		const assistantId = sessionManager.appendMessage(assistantMessage(model, `${label} response`));
		return { userId, assistantId };
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
			await Bun.sleep(1);
		}
	}

	function blockCompactions() {
		const calls: Array<{
			preparation: CompactionPreparation;
			signal: AbortSignal;
			resolve: (summary: string) => void;
		}> = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(
			async (preparation, _model, _apiKey, _instructions, signal) => {
				const deferred = Promise.withResolvers<CompactionResult>();
				if (!signal) throw new Error("Expected compaction abort signal");
				const abort = () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					deferred.reject(error);
				};
				if (signal.aborted) {
					abort();
				} else {
					signal.addEventListener("abort", abort, { once: true });
				}
				calls.push({
					preparation,
					signal,
					resolve: summary => {
						signal.removeEventListener("abort", abort);
						deferred.resolve(compactionFromPreparation(preparation, summary));
					},
				});
				return await deferred.promise;
			},
		);
		return calls;
	}

	function emitAgentEnd(activeSession: AgentSession, assistant: AssistantMessage): void {
		activeSession.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
	}

	function emitCompletedAssistant(activeSession: AgentSession, assistant: AssistantMessage): void {
		activeSession.agent.emitExternalEvent({ type: "message_end", message: assistant });
		emitAgentEnd(activeSession, assistant);
	}

	function overflowAssistant(): AssistantMessage {
		return {
			...assistantMessage(model, "overflow response", (model.contextWindow ?? 0) + 10),
			stopReason: "error",
			errorMessage: "context_length_exceeded",
		};
	}

	function incompleteAssistant(): AssistantMessage {
		return {
			...assistantMessage(model, "incomplete response", THRESHOLD_TOKENS + 10),
			stopReason: "length",
		};
	}

	function compactionEntries() {
		return sessionManager.getEntries().filter(entry => entry.type === "compaction");
	}

	it("rejects duplicate prepared compaction appends for one branch window", () => {
		appendSeedTurn();
		const baseLeafId = sessionManager.getLeafId();
		const pathEntries = sessionManager.getBranch();
		const baseLatestCompactionId = getLatestCompactionEntry(pathEntries)?.id;

		const first = sessionManager.tryAppendPreparedCompaction({
			baseLeafId,
			baseLatestCompactionId,
			summary: "same branch compacted",
			shortSummary: undefined,
			firstKeptEntryId: pathEntries[0].id,
			tokensBefore: 100,
			details: {},
		});
		const second = sessionManager.tryAppendPreparedCompaction({
			baseLeafId,
			baseLatestCompactionId,
			summary: "same branch compacted again",
			shortSummary: undefined,
			firstKeptEntryId: pathEntries[0].id,
			tokensBefore: 100,
			details: {},
		});

		expect(first.status).toBe("appended");
		expect(second.status).toBe("already_compacted");
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
	});

	it("appends prepared compaction after append-only background entries race the base leaf", () => {
		const { userId } = appendSeedTurn("append-only suffix");
		const baseLeafId = sessionManager.getLeafId();
		const pathEntries = sessionManager.getBranch();
		const baseLatestCompactionId = getLatestCompactionEntry(pathEntries)?.id;
		const asyncMessageId = sessionManager.appendCustomMessageEntry(
			"async-result",
			"background job finished while compaction was running",
			true,
			{ jobs: [{ jobId: "job-1" }] },
			"agent",
		);
		sessionManager.appendCustomEntry("agent-ref", { id: "ReviewScout", status: "idle" });
		const usageId = sessionManager.appendGoalUsageDelta({
			goalId: "goal-1",
			stateVersion: 1,
			tokenDelta: 12,
			wallSeconds: 3,
			tokensUsed: 12,
			timeUsedSeconds: 3,
			updatedAt: Date.now(),
		});

		const result = sessionManager.tryAppendPreparedCompaction({
			baseLeafId,
			baseLatestCompactionId,
			summary: "summary prepared from the base branch",
			shortSummary: undefined,
			firstKeptEntryId: userId,
			tokensBefore: 100,
			details: {},
			allowAppendAfterBaseLeaf: true,
			isAppendOnlySafeEntry: entry =>
				entry.type === "custom" ||
				entry.type === "goal_usage_delta" ||
				(entry.type === "custom_message" && entry.customType === "async-result"),
		});

		expect(result.status).toBe("appended");
		if (result.status !== "appended") throw new Error("Expected append to succeed");
		expect(result.appendedAfterBaseLeaf).toBe(true);
		expect(sessionManager.getEntry(asyncMessageId)?.type).toBe("custom_message");
		expect(sessionManager.getEntry(result.entryId)?.parentId).toBe(usageId);
		expect(
			sessionManager
				.buildSessionContext()
				.messages.some(message => JSON.stringify(message).includes("background job finished")),
		).toBe(true);
	});

	it("rejects prepared compaction after an ordinary user message races the base leaf", () => {
		const { userId } = appendSeedTurn("unsafe suffix");
		const baseLeafId = sessionManager.getLeafId();
		const pathEntries = sessionManager.getBranch();
		const baseLatestCompactionId = getLatestCompactionEntry(pathEntries)?.id;
		sessionManager.appendMessage({
			role: "user",
			content: "new user input should force a fresh compaction snapshot",
			timestamp: Date.now(),
		});

		const result = sessionManager.tryAppendPreparedCompaction({
			baseLeafId,
			baseLatestCompactionId,
			summary: "stale summary",
			shortSummary: undefined,
			firstKeptEntryId: userId,
			tokensBefore: 100,
			details: {},
			allowAppendAfterBaseLeaf: true,
			isAppendOnlySafeEntry: entry =>
				entry.type === "custom" ||
				entry.type === "goal_usage_delta" ||
				(entry.type === "custom_message" && entry.customType === "async-result"),
		});

		expect(result.status).toBe("stale");
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
	});

	it("appends provider compaction after goal bookkeeping entries race the base leaf", async () => {
		appendSeedTurn("goal bookkeeping suffix");
		const activeSession = createSession();
		const calls = blockCompactions();
		const compactRun = activeSession.compact();
		await waitFor(() => calls.length === 1);

		const goalState = activeGoalState();
		const serializedState = serializeGoalModeState(goalState);
		const snapshotId = sessionManager.appendGoalStateSnapshot({
			goalId: goalState.goal.id,
			stateVersion: goalState.stateVersion,
			schemaVersion: serializedState.schemaVersion,
			reason: "semantic",
			state: serializedState,
		});
		const modeChangeId = sessionManager.appendModeChange("goal", {
			goalId: goalState.goal.id,
			stateVersion: goalState.stateVersion,
			snapshotEntryId: snapshotId,
		});

		calls[0].resolve("summary after goal bookkeeping");
		await compactRun;

		expect(compactionEntries()).toHaveLength(1);
		expect(compactionEntries()[0].summary).toBe("summary after goal bookkeeping");
		expect(compactionEntries()[0].parentId).toBe(modeChangeId);
		expect(
			sessionManager
				.buildSessionContext()
				.messages.some(message => JSON.stringify(message).includes(goalState.goal.objective)),
		).toBe(false);
	});

	it("discards provider compaction after an ordinary user message races the base leaf", async () => {
		appendSeedTurn("provider unsafe suffix");
		const activeSession = createSession();
		const calls = blockCompactions();
		const compactRun = activeSession.compact();
		await waitFor(() => calls.length === 1);

		sessionManager.appendMessage({
			role: "user",
			content: "new user input should still force a fresh provider compaction snapshot",
			timestamp: Date.now(),
		});

		calls[0].resolve("stale provider summary");
		await compactRun.then(
			() => {
				throw new Error("Expected provider compaction to reject as stale");
			},
			error => {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain("stale");
			},
		);

		expect(compactionEntries()).toHaveLength(0);
	});

	it("discards a manual compaction summary when the branch mutates before append", async () => {
		appendSeedTurn("first");
		appendSeedTurn("second");
		const staleSummary = "stale manual summary";
		const runner = createExtensionRunner({
			session_before_compact: event => {
				sessionManager.appendMessage({
					role: "user",
					content: "branch changed during compaction",
					timestamp: Date.now(),
				});
				return { compaction: compactionFromPreparation(event.preparation as CompactionPreparation, staleSummary) };
			},
		});
		createSession(runner);

		await expect(session!.compact()).rejects.toThrow("stale");

		expect(
			sessionManager.getEntries().some(entry => entry.type === "compaction" && entry.summary === staleSummary),
		).toBe(false);
	});

	it("routes duplicate-summary session_compact hooks by the returned compaction entry id", async () => {
		const { userId } = appendSeedTurn("before previous compaction");
		const previousCompactionId = sessionManager.appendCompaction("duplicate summary", undefined, userId, 100, {});
		appendSeedTurn("after previous compaction");
		let emittedCompactionId: string | undefined;
		const runner = createExtensionRunner({
			session_before_compact: event => ({
				compaction: compactionFromPreparation(event.preparation as CompactionPreparation, "duplicate summary"),
			}),
			session_compact: event => {
				emittedCompactionId = (event.compactionEntry as { id: string }).id;
			},
		});
		createSession(runner);

		await session!.compact();

		const duplicateEntries = sessionManager
			.getEntries()
			.filter(entry => entry.type === "compaction" && entry.summary === "duplicate summary");
		expect(duplicateEntries).toHaveLength(2);
		expect(emittedCompactionId).toBe(duplicateEntries[1].id);
		expect(emittedCompactionId).not.toBe(previousCompactionId);
	});

	it("discards an auto-compaction summary when the branch mutates before append", async () => {
		appendSeedTurn("first");
		const staleSummary = "stale auto summary";
		const runner = createExtensionRunner({
			session_before_compact: event => {
				sessionManager.appendMessage({
					role: "user",
					content: "branch changed before auto append",
					timestamp: Date.now(),
				});
				return { compaction: compactionFromPreparation(event.preparation as CompactionPreparation, staleSummary) };
			},
		});
		const activeSession = createSession(runner);
		const assistant = assistantMessage(model, "threshold response", THRESHOLD_TOKENS + 10);

		activeSession.agent.emitExternalEvent({ type: "message_end", message: assistant });
		activeSession.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
		await waitFor(() => events.some(event => event.type === "auto_compaction_end"));

		expect(
			sessionManager.getEntries().some(entry => entry.type === "compaction" && entry.summary === staleSummary),
		).toBe(false);
		expect(events).toContainEqual({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		});
	});

	it("coalesces concurrent threshold compaction checks for the same branch", async () => {
		appendSeedTurn("threshold");
		const activeSession = createSession();
		const calls = blockCompactions();
		const assistant = assistantMessage(model, "threshold response", THRESHOLD_TOKENS + 10);

		activeSession.agent.emitExternalEvent({ type: "message_end", message: assistant });
		emitAgentEnd(activeSession, assistant);
		emitAgentEnd(activeSession, assistant);
		await waitFor(() => calls.length === 1);

		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		expect(calls[0].signal.aborted).toBe(false);
		calls[0].resolve("coalesced threshold summary");
		await waitFor(() => compactionEntries().length === 1);

		expect(compactionEntries()).toHaveLength(1);
		expect(compactionEntries()[0].summary).toBe("coalesced threshold summary");
		expect(
			events.filter(event => event.type === "auto_compaction_end" && event.action === "context-full"),
		).toHaveLength(1);
	});

	it("lets only the appended recovery run schedule continuation after coalescing callers", async () => {
		appendSeedTurn("overflow continuation");
		const activeSession = createSession();
		const calls = blockCompactions();
		const continueSpy = vi.spyOn(activeSession.agent, "continue").mockResolvedValue(undefined);
		const assistant = overflowAssistant();

		activeSession.agent.emitExternalEvent({ type: "message_end", message: assistant });
		emitAgentEnd(activeSession, assistant);
		emitAgentEnd(activeSession, assistant);
		await waitFor(() => calls.length === 1);

		calls[0].resolve("coalesced overflow continuation");
		await waitFor(() => compactionEntries().length === 1);
		await waitFor(() => continueSpy.mock.calls.length === 1);

		expect(calls).toHaveLength(1);
		expect(compactionEntries()).toHaveLength(1);
		expect(compactionEntries()[0].summary).toBe("coalesced overflow continuation");
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(
			events.filter(event => event.type === "auto_compaction_end" && event.action === "context-full"),
		).toHaveLength(1);
	});

	it("skips idle compaction without aborting active overflow recovery", async () => {
		appendSeedTurn("overflow");
		const activeSession = createSession();
		const calls = blockCompactions();
		const assistant = overflowAssistant();

		emitCompletedAssistant(activeSession, assistant);
		await waitFor(() => calls.length === 1);
		await activeSession.runIdleCompaction();

		expect(calls).toHaveLength(1);
		expect(calls[0].signal.aborted).toBe(false);
		expect(events.some(event => event.type === "auto_compaction_start" && event.reason === "idle")).toBe(false);
		calls[0].resolve("overflow recovery summary");
		await waitFor(() => compactionEntries().length === 1);

		expect(compactionEntries()[0].summary).toBe("overflow recovery summary");
		expect(events).toContainEqual({
			type: "auto_compaction_end",
			action: "context-full",
			result: expect.objectContaining({ summary: "overflow recovery summary" }),
			aborted: false,
			willRetry: true,
		});
	});

	it("supersedes active idle compaction with overflow recovery", async () => {
		appendSeedTurn("idle");
		const activeSession = createSession();
		const calls = blockCompactions();
		const idleRun = activeSession.runIdleCompaction();
		await waitFor(() => calls.length === 1);
		const idleSignal = calls[0].signal;
		const assistant = overflowAssistant();

		emitCompletedAssistant(activeSession, assistant);
		await waitFor(() => calls.length === 2);

		expect(idleSignal.aborted).toBe(true);
		expect(events).toContainEqual({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: true,
			willRetry: false,
		});
		calls[1].resolve("superseding overflow summary");
		await waitFor(() => compactionEntries().length === 1);
		await idleRun;

		expect(compactionEntries()).toHaveLength(1);
		expect(compactionEntries()[0].summary).toBe("superseding overflow summary");
		expect(events).toContainEqual({
			type: "auto_compaction_end",
			action: "context-full",
			result: expect.objectContaining({ summary: "superseding overflow summary" }),
			aborted: false,
			willRetry: true,
		});
	});

	it("recovers incomplete responses locally without starting compaction", async () => {
		appendSeedTurn("incomplete-local");
		const activeSession = createSession();
		const calls = blockCompactions();
		const continueSpy = vi.spyOn(activeSession.agent, "continue").mockResolvedValue(undefined);
		const assistant = incompleteAssistant();

		emitCompletedAssistant(activeSession, assistant);
		await waitFor(() => continueSpy.mock.calls.length === 1);

		expect(calls).toHaveLength(0);
		expect(compactionEntries()).toHaveLength(0);
		expect(events.some(event => event.type === "auto_compaction_start")).toBe(false);
		const developerReminder = activeSession.agent.state.messages.find(message => message.role === "developer");
		if (developerReminder?.role !== "developer") throw new Error("expected developer reminder");
		const reminderText =
			typeof developerReminder.content === "string"
				? developerReminder.content
				: developerReminder.content.map(content => (content.type === "text" ? content.text : "")).join("");
		expect(reminderText).toContain("Continue exactly where you left off");
	});
});
