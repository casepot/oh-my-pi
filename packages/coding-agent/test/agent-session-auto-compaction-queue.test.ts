import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const runtimeSignalStoreKey = "__ompRuntimeSignals";

type RuntimeSignalGlobal = typeof globalThis & { [runtimeSignalStoreKey]?: string[] };

function getRuntimeSignals(): string[] {
	const globalWithSignals = globalThis as RuntimeSignalGlobal;
	if (!globalWithSignals[runtimeSignalStoreKey]) {
		globalWithSignals[runtimeSignalStoreKey] = [];
	}
	return globalWithSignals[runtimeSignalStoreKey];
}

/**
 * Regression test: auto-compaction completion should resume the agent loop when
 * there are queued agent-level messages (follow-up/steering/custom).
 */
describe("AgentSession auto-compaction queue resume", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-auto-compaction-queue-");
		vi.useFakeTimers();

		// Provide an extension that short-circuits compaction so the test doesn't
		// make any LLM calls.
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				"\t\treturn {",
				"\t\t\tcompaction: {",
				'\t\t\t\tsummary: "compacted",',
				"\t\t\t\tshortSummary: undefined,",
				"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\t\tdetails: {},",
				"\t\t\t},",
				"\t\t};",
				"\t});",
				'\tpi.on("auto_compaction_start", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:start:" + event.reason);',
				"\t});",
				'\tpi.on("auto_compaction_end", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:end:" + (event.aborted ? "aborted" : "ok"));',
				"\t});",
				'\tpi.on("todo_reminder", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("todo:" + event.attempt + "/" + event.maxAttempts);',
				"\t});",
				"}",
			].join("\n"),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		getRuntimeSignals().length = 0;

		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		// Seed a minimal session branch so prepareCompaction() returns a preparation.
		sessionManager.appendMessage({
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": false,
				"todo.reminders": true,
				"todo.reminders.max": 3,
			}),
			modelRegistry,
			extensionRunner,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.useRealTimers();
		getRuntimeSignals().length = 0;
		vi.restoreAllMocks();
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		expect(session.agent.hasQueuedMessages()).toBe(true);

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		// Wait for auto_compaction_end event to know when the async handler is done
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		// Build a fake AssistantMessage with high token usage to trigger threshold
		// compaction (contextWindow=200000, threshold ~80%).
		const assistantMsg = {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		// Drive auto-compaction through the event flow:
		// message_end → stores #lastAssistantMessage
		// agent_end   → #checkCompaction → shouldCompact → #runAutoCompaction
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		// Wait for compaction completion, then verify waitForIdle blocks on queued continuation.
		await compactionDone;
		await Promise.resolve();
		const idlePromise = session.waitForIdle();
		let idleResolved = false;
		void idlePromise.then(() => {
			idleResolved = true;
		});
		await Promise.resolve();
		expect(idleResolved).toBe(false);
		vi.advanceTimersByTime(200);
		await idlePromise;

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
	});

	it("overflow recovery preserves pending goal checkpoints without resolving or creating checkpoints", async () => {
		await session.goalRuntime.createGoal({ objective: "Improve release reliability" });
		await session.goalRuntime.startTarget({
			title: "Close one installer smoke target",
			desiredFutureClaim: "Installer smoke has bounded current evidence.",
			closureStandard: "Current smoke output is recorded.",
		});
		const candidate = session.goalRuntime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Installer smoke target closed.",
			localClaims: ["Installer smoke has bounded current evidence"],
			evidence: [
				{ claim: "Installer smoke has bounded current evidence", evidence: "Observed smoke output", current: true },
			],
			notClaimed: ["Parent goal is complete"],
			remainingQuestions: ["Which target follows?"],
		});
		const checkpointState = await session.goalRuntime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Checkpoint accepted.",
			evidenceChecked: candidate.evidence,
			blockers: [],
			reviewedAt: Date.now(),
		});
		const checkpointId = checkpointState.goal.pendingCheckpointId;
		const checkpointCount = checkpointState.goal.checkpoints?.length ?? 0;
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});
		const model = session.model;
		if (!model) throw new Error("expected model");
		session.settings.set("compaction.keepRecentTokens", 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "pre-overflow context" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({ role: "user", content: "recent overflow prompt", timestamp: Date.now() });
		const overflowAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "overflow" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "error" as const,
			errorMessage: "maximum context length is 200000 tokens, however you requested 200001 tokens",
			usage: {
				input: 120_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: overflowAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowAssistant] });
		await withTimeout(compactionDone, 1000, "auto compaction did not finish");

		const state = session.getGoalModeState();
		expect(state?.runMode).toBe("awaiting-checkpoint-resolution");
		expect(state?.goal.pendingCheckpointId).toBe(checkpointId);
		expect(state?.goal.checkpoints?.length).toBe(checkpointCount);
		expect(state?.goal.checkpointResolutions?.length ?? 0).toBe(0);
		const compactionEntry = sessionManager.getEntries().find(entry => entry.type === "compaction");
		if (compactionEntry?.type !== "compaction") throw new Error("expected compaction entry");
		expect(JSON.stringify(compactionEntry.preserveData?.goalMode)).toContain(
			'"runMode":"awaiting-checkpoint-resolution"',
		);
		expect(JSON.stringify(compactionEntry.preserveData?.goalContinuationPacket)).toContain(
			'"transition":"target-checkpoint"',
		);
		expect(getRuntimeSignals()).toContain("compaction:start:overflow");
	});

	it("incomplete-output recovery preserves verifier repair state without creating checkpoints", async () => {
		const created = await session.goalRuntime.createGoal({ objective: "Improve release reliability" });
		await session.goalRuntime.recordFailedCompletionVerification(created.goal.id, "Missing parent evidence", {
			attempt: 1,
			maxAttempts: 3,
			structuredFeedback: {
				summary: "Missing parent evidence",
				score: 2,
				deliverableResults: [],
				evidenceChecked: [],
				completionBlockers: [
					{
						id: "parent-evidence",
						severity: "blocking",
						problem: "Parent evidence is missing.",
						requiredEvidenceOrFix: "Collect current parent evidence.",
					},
				],
			},
		});
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});
		const model = session.model;
		if (!model) throw new Error("expected model");
		session.settings.set("compaction.keepRecentTokens", 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "pre-incomplete context" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({ role: "user", content: "recent incomplete prompt", timestamp: Date.now() });
		const incompleteAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "length" as const,
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

		session.agent.emitExternalEvent({ type: "message_end", message: incompleteAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [incompleteAssistant] });
		await withTimeout(compactionDone, 1000, "auto compaction did not finish");

		const state = session.getGoalModeState();
		expect(state?.runMode).toBe("awaiting-verification-repair");
		expect(state?.goal.verificationRepair?.feedback).toBe("Missing parent evidence");
		expect(state?.goal.checkpoints?.length ?? 0).toBe(0);
		const compactionEntry = sessionManager.getEntries().find(entry => entry.type === "compaction");
		if (compactionEntry?.type !== "compaction") throw new Error("expected compaction entry");
		expect(JSON.stringify(compactionEntry.preserveData?.goalMode)).toContain(
			'"runMode":"awaiting-verification-repair"',
		);
		expect(JSON.stringify(compactionEntry.preserveData?.goalContinuationPacket)).toContain(
			'"transition":"verification-rejected"',
		);
		expect(getRuntimeSignals()).toContain("compaction:start:incomplete");
	});

	it("forwards todo reminder lifecycle signals to extensions", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		session.setTodoPhases([
			{
				name: "Execution",
				tasks: [{ content: "Finish pending task", status: "in_progress" }],
			},
		]);

		const { promise: reminderDone, resolve: onReminderDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "todo_reminder") onReminderDone();
		});

		const assistantMsg = {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await withTimeout(reminderDone, 1000, "Todo reminder timed out");
		await Promise.resolve();

		expect(getRuntimeSignals()).toContain("todo:1/3");
		expect(continueSpy).toHaveBeenCalledTimes(1);
		await session.waitForIdle();
	});
});
