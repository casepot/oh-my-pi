import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, ASSISTANT_OUTPUT_INCOMPLETE_TOOL_RESULT_SKIP_REASON } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { GoalTargetPlanApprovalInput } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { GoalModeState, GoalTargetPlanReview } from "@oh-my-pi/pi-coding-agent/goals/state";
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

function acceptedTargetPlanReview(lens: GoalTargetPlanReview["lens"]): GoalTargetPlanReview {
	return {
		id: `${lens}-review`,
		lens,
		status: "accepted",
		feedback: `${lens} accepted.`,
		apertureClassification: lens === "aperture" ? "right-sized" : undefined,
		revisionDecision: lens === "aperture" ? "keep" : undefined,
		scores:
			lens === "aperture"
				? {
						productSignal: 4,
						relatedWorkBundling: 4,
						concernCohesion: 4,
						verificationAperture: 4,
						blastRadiusCoverage: 4,
						parentUncertaintyReduction: 4,
						antiGaming: 4,
					}
				: undefined,
		findings: [],
		reviewedAt: Date.now(),
		revisedAfterReview: false,
	};
}

function buildTargetPlanApprovalInput(state: GoalModeState): GoalTargetPlanApprovalInput {
	const target = state.goal.currentTarget;
	const plan = state.goal.currentTargetPlan;
	if (!target || !plan) throw new Error("expected current target plan");
	const reviews = [
		{
			...acceptedTargetPlanReview("aperture"),
			reviewedTargetPlanId: plan.id,
			reviewedRevision: plan.revision,
		},
		{
			...acceptedTargetPlanReview("execution-readiness"),
			reviewedTargetPlanId: plan.id,
			reviewedRevision: plan.revision,
		},
	];
	return {
		targetId: target.id,
		targetPlanId: plan.id,
		planFilePath: plan.planFilePath,
		revision: plan.revision,
		primarySignalGroupId: "signal-primary",
		planDepth: "light",
		targetCard: {
			capabilityClaim: "Target behavior is directly verified.",
			knownLimits: ["Parent completion remains outside this target."],
			userVisibleSurface: "Target behavior",
			acceptanceRows: { closed: ["happy path"], open: [] },
			verificationScenarios: ["happy path signal-primary"],
			checkpointEvidence: ["Focused check passes."],
		},
		verificationAperture: {
			productIntention: "Prove the target behavior with direct evidence.",
			primarySignalId: "signal-primary",
			blastRadius: "local",
			confidenceTarget: "high",
			layerRationale: "The target is local and directly observable.",
			residualUncertainty: ["Parent completion remains outside this target."],
			omittedLayers: [{ layer: "e2e", reason: "Parent-level e2e belongs to a later target." }],
		},
		verificationSignals: [
			{
				id: "signal-primary",
				role: "primary",
				layer: "integration",
				concernIds: ["concern-behavior"],
				claim: "Target behavior is verified.",
				observation: "Focused evidence is observed.",
				method: "Run the focused check.",
				expectedOutcome: "The focused check passes.",
				required: true,
				confidenceIfSatisfied: "high",
				staleIf: ["Relevant code changes."],
			},
		],
		concernChecks: [
			{
				id: "concern-behavior",
				kind: "behavior",
				whyIndependent: "Behavior can fail independently of parent completion.",
				coveredBySignalIds: ["signal-primary"],
			},
		],
		scopeCalibration: {
			rightSizingBasis: "product-signal",
			whyNotSmaller: ["Smaller work would not produce an observable signal."],
			whyNotLarger: ["Larger work would claim parent-level completion."],
			includedRelatedWork: [
				{ item: "Focused target work", reason: "Needed for primary signal.", signalIds: ["signal-primary"] },
			],
			deferredRelatedWork: [
				{
					item: "Parent completion verification",
					reason: "different-primary-signal",
					followUpHint: "Checkpoint first.",
				},
			],
		},
		branchEvidence: [
			{ branch: "happy path", required: true, plannedSignalIds: ["signal-primary"], rationale: "Primary signal." },
		],
		excludedWorkReview: [
			{ item: "Parent completion", classification: "parent-non-claim", rationale: "Checkpoint is bounded." },
		],
		targetPlanReviews: reviews,
		dryRun: { status: "passed", checks: [{ id: "dry-run", passed: true, rationale: "Plan steps are executable." }] },
		reviews,
	};
}

async function approveActiveTargetPlan(session: AgentSession): Promise<void> {
	const state = session.getGoalModeState();
	if (!state) throw new Error("expected goal state");
	await session.goalRuntime.approveCurrentTargetPlan(buildTargetPlanApprovalInput(state));
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

		let syncSession: AgentSession | undefined;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			syncContextBeforeModelCall: (context, signal) => syncSession?.syncContextBeforeModelCall(context, signal),
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
		syncSession = session;
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

		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			// Real continue() polls and consumes the queued steering/follow-up
			// messages. Mirror that here so the stranded-queue drain settles after
			// one resume instead of rescheduling itself forever (a no-op mock
			// leaves the queue populated, spinning the drain into an OOM loop).
			session.agent.clearAllQueues();
		});

		// Wait for auto_compaction_end event to know when the async handler is done
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		// Build a fake AssistantMessage with high token usage to trigger threshold
		// compaction (contextWindow=200000, threshold ~80%).
		const assistantMsg = {
			role: "assistant" as const,
			// Non-empty content: an empty `stop` turn would trip the empty-stop guard
			// (#handleEmptyAssistantStop) and short-circuit the agent_end handler before
			// compaction/todo checks run — hanging this test forever under fake timers.
			content: [{ type: "text" as const, text: "Done." }],
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

	it("rewinds incomplete tool-call recovery cheaply instead of compacting", async () => {
		const model = session.model;
		if (!model) throw new Error("expected model");
		const now = Date.now();
		const userMessage = { role: "user" as const, content: "write huge file", timestamp: now };
		const firstAssistant = {
			role: "assistant" as const,
			content: [{ type: "toolCall" as const, id: "call_1|fc_1", name: "write", arguments: { content: "partial" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "length" as const,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now + 1,
		};
		const firstToolResult = {
			role: "toolResult" as const,
			toolCallId: "call_1|fc_1",
			toolName: "write",
			content: [{ type: "text" as const, text: "Tool call was not executed because stop_reason: length." }],
			details: {
				skipReason: ASSISTANT_OUTPUT_INCOMPLETE_TOOL_RESULT_SKIP_REASON,
				stopReason: "length",
			},
			isError: true,
			timestamp: now + 2,
		};
		const secondAssistant = {
			...firstAssistant,
			content: [{ type: "toolCall" as const, id: "call_2|fc_2", name: "write", arguments: { content: "partial" } }],
			timestamp: now + 3,
		};
		const secondToolResult = {
			...firstToolResult,
			toolCallId: "call_2|fc_2",
			timestamp: now + 4,
		};
		sessionManager.appendMessage(userMessage);
		sessionManager.appendMessage(firstAssistant);
		sessionManager.appendMessage(firstToolResult);
		sessionManager.appendMessage(secondAssistant);
		sessionManager.appendMessage(secondToolResult);
		session.agent.replaceMessages([userMessage, firstAssistant, firstToolResult, secondAssistant, secondToolResult]);

		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {});

		session.agent.emitExternalEvent({ type: "agent_end", messages: [secondAssistant, secondToolResult] });
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const activeMessages = session.agent.state.messages;
		expect(activeMessages[0]).toEqual(userMessage);
		expect(activeMessages).toHaveLength(2);
		const recoveryReminder = activeMessages[1];
		expect(recoveryReminder?.role).toBe("developer");
		if (recoveryReminder?.role !== "developer") throw new Error("expected developer reminder");
		const recoveryReminderText =
			typeof recoveryReminder.content === "string"
				? recoveryReminder.content
				: recoveryReminder.content.map(content => (content.type === "text" ? content.text : "")).join("");
		expect(recoveryReminderText).toContain("truncated before its arguments were complete");

		const branchMessages = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message);
		expect(branchMessages.at(-2)).toEqual(userMessage);
		expect(branchMessages.at(-1)?.role).toBe("developer");
		expect(branchMessages.some(message => message.role === "toolResult")).toBe(false);
		expect(getRuntimeSignals().some(signal => signal.startsWith("compaction:start:"))).toBe(false);
	});

	it("continues partial visible length output without compacting or discarding text", async () => {
		const model = session.model;
		if (!model) throw new Error("expected model");
		const now = Date.now();
		const userMessage = { role: "user" as const, content: "explain the fix", timestamp: now };
		const assistantMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "The first part of the answer" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "length" as const,
			stopDetails: { type: "max_output_tokens", category: "response.incomplete" },
			usage: {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now + 1,
		};
		sessionManager.appendMessage(userMessage);
		sessionManager.appendMessage(assistantMessage);
		session.agent.replaceMessages([userMessage, assistantMessage]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {});

		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const activeMessages = session.agent.state.messages;
		expect(activeMessages.map(message => message.role)).toEqual(["user", "assistant", "developer"]);
		expect(activeMessages[1]).toEqual(assistantMessage);
		const recoveryReminder = activeMessages[2];
		if (recoveryReminder?.role !== "developer") throw new Error("expected developer reminder");
		const recoveryReminderText =
			typeof recoveryReminder.content === "string"
				? recoveryReminder.content
				: recoveryReminder.content.map(content => (content.type === "text" ? content.text : "")).join("");
		expect(recoveryReminderText).toContain("Continue exactly where you left off");
		expect(getRuntimeSignals().some(signal => signal.startsWith("compaction:start:"))).toBe(false);
	});

	it("rewinds empty length output without compacting", async () => {
		const model = session.model;
		if (!model) throw new Error("expected model");
		const now = Date.now();
		const userMessage = { role: "user" as const, content: "continue", timestamp: now };
		const assistantMessage = {
			role: "assistant" as const,
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "length" as const,
			stopDetails: { type: "max_output_tokens", category: "response.incomplete" },
			usage: {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now + 1,
		};
		sessionManager.appendMessage(userMessage);
		sessionManager.appendMessage(assistantMessage);
		session.agent.replaceMessages([userMessage, assistantMessage]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {});

		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const activeMessages = session.agent.state.messages;
		expect(activeMessages.map(message => message.role)).toEqual(["user", "developer"]);
		const recoveryReminder = activeMessages[1];
		if (recoveryReminder?.role !== "developer") throw new Error("expected developer reminder");
		const recoveryReminderText =
			typeof recoveryReminder.content === "string"
				? recoveryReminder.content
				: recoveryReminder.content.map(content => (content.type === "text" ? content.text : "")).join("");
		expect(recoveryReminderText).toContain("before producing actionable visible output");
		const branchMessages = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message);
		expect(branchMessages.at(-2)).toEqual(userMessage);
		expect(branchMessages.at(-1)?.role).toBe("developer");
		expect(getRuntimeSignals().some(signal => signal.startsWith("compaction:start:"))).toBe(false);
	});

	it("keeps incomplete-output recovery prompt through pre-provider context sync", async () => {
		vi.useRealTimers();
		const mock = createMockModel({
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			responses: [
				{
					content: [],
					stopReason: "length",
					stopDetails: { type: "max_output_tokens", category: "response.incomplete" },
				},
				{ content: ["recovered"] },
			],
		});
		const localSessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		let syncSession: AgentSession | undefined;
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm: messages =>
				messages.filter(
					(message): message is Message =>
						message.role === "user" ||
						message.role === "developer" ||
						message.role === "assistant" ||
						message.role === "toolResult",
				),
			streamFn: mock.stream,
			syncContextBeforeModelCall: (context, signal) => syncSession?.syncContextBeforeModelCall(context, signal),
		});
		const localSession = new AgentSession({
			agent,
			sessionManager: localSessionManager,
			settings: Settings.isolated({ "compaction.autoContinue": false }),
			modelRegistry,
		});
		syncSession = localSession;

		try {
			await localSession.prompt("start");
			await localSession.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			const secondCallText = mock.calls[1]?.context.messages
				.map(message => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
				.join("\n");
			expect(secondCallText).toContain("before producing actionable visible output");
			expect(
				localSessionManager
					.getBranch()
					.some(entry => entry.type === "message" && entry.message.role === "developer"),
			).toBe(true);
		} finally {
			await localSession.dispose();
		}
	});

	it("escalates repeated incomplete output to no-tool recovery and then a visible diagnostic", async () => {
		const model = session.model;
		if (!model) throw new Error("expected model");
		const now = Date.now();
		const userMessage = { role: "user" as const, content: "continue", timestamp: now };
		sessionManager.appendMessage(userMessage);
		session.agent.replaceMessages([userMessage]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {});

		for (let attempt = 1; attempt <= 4; attempt++) {
			const assistantMessage = {
				role: "assistant" as const,
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "length" as const,
				stopDetails: { type: "max_output_tokens", category: "response.incomplete" },
				usage: {
					input: 10,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 30,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: now + attempt,
			};
			sessionManager.appendMessage(assistantMessage);
			session.agent.replaceMessages([...session.agent.state.messages, assistantMessage]);
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await session.waitForIdle();
		}

		expect(continueSpy).toHaveBeenCalledTimes(3);
		expect(session.toolChoiceQueue.inspect()).toContain("incomplete-output-final");
		const activeMessages = session.agent.state.messages;
		const developerText = activeMessages
			.filter(message => message.role === "developer")
			.map(message => {
				if (typeof message.content === "string") return message.content;
				return message.content.map(content => (content.type === "text" ? content.text : "")).join("");
			})
			.join("\n");
		expect(developerText).toContain("For this final recovery attempt");
		const diagnostic = activeMessages.find(
			message => message.role === "custom" && message.customType === "incomplete-output-diagnostic",
		);
		expect(diagnostic).toBeDefined();
		if (diagnostic?.role !== "custom") throw new Error("expected diagnostic message");
		expect(diagnostic.display).toBe(true);
		expect(diagnostic.includeInContext).toBe(false);
		expect(String(diagnostic.content)).toContain("No automatic compaction was run");
		expect(getRuntimeSignals().some(signal => signal.startsWith("compaction:start:"))).toBe(false);
	});

	it("overflow recovery preserves pending goal checkpoints without resolving or creating checkpoints", async () => {
		await session.goalRuntime.createGoal({ objective: "Improve release reliability" });
		await session.goalRuntime.startTarget({
			title: "Close one installer smoke target",
			desiredFutureClaim: "Installer smoke has bounded current evidence.",
			closureStandard: "Current smoke output is recorded.",
		});
		await approveActiveTargetPlan(session);
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

	it("incomplete-output recovery preserves verifier repair state without compacting", async () => {
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
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {});

		session.agent.emitExternalEvent({ type: "message_end", message: incompleteAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [incompleteAssistant] });
		await session.waitForIdle();

		const state = session.getGoalModeState();
		expect(state?.runMode).toBe("awaiting-verification-repair");
		expect(state?.goal.verificationRepair?.feedback).toBe("Missing parent evidence");
		expect(state?.goal.checkpoints?.length ?? 0).toBe(0);
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
		expect(getRuntimeSignals().some(signal => signal.startsWith("compaction:start:"))).toBe(false);
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
			// Non-empty content: see comment on the first test's assistantMsg.
			content: [{ type: "text" as const, text: "Done." }],
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

	it("suppresses todo reminders while goal checkpoint resolution blocks ordinary tools", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		await session.goalRuntime.createGoal({ objective: "Improve release reliability" });
		await session.goalRuntime.startTarget({
			title: "Close one installer smoke target",
			desiredFutureClaim: "Installer smoke has bounded current evidence.",
			closureStandard: "Current smoke output is recorded.",
		});
		await approveActiveTargetPlan(session);
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
		await session.goalRuntime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Checkpoint accepted.",
			evidenceChecked: candidate.evidence,
			blockers: [],
			reviewedAt: Date.now(),
		});
		session.setTodoPhases([
			{
				name: "Evidence closeout",
				tasks: [{ content: "Checkpoint current target", status: "in_progress" }],
			},
		]);
		const reminders: string[] = [];
		session.subscribe(event => {
			if (event.type === "todo_reminder") reminders.push(event.type);
		});

		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Run mode is now awaiting-checkpoint-resolution." }],
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
		await session.waitForIdle();

		expect(session.getGoalModeState()?.runMode).toBe("awaiting-checkpoint-resolution");
		expect(reminders).toHaveLength(0);
		expect(getRuntimeSignals().some(signal => signal.startsWith("todo:"))).toBe(false);
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("suppresses todo reminders while resolved goal pause awaits external input", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		await session.goalRuntime.createGoal({ objective: "Improve release reliability" });
		await session.goalRuntime.startTarget({
			title: "Close one installer smoke target",
			desiredFutureClaim: "Installer smoke has bounded current evidence.",
			closureStandard: "Current smoke output is recorded.",
		});
		await approveActiveTargetPlan(session);
		const candidate = session.goalRuntime.buildCheckpointCandidate({
			status: "closed_with_evidence",
			summary: "Installer smoke target closed.",
			localClaims: ["Installer smoke has bounded current evidence"],
			evidence: [
				{ claim: "Installer smoke has bounded current evidence", evidence: "Observed smoke output", current: true },
			],
			notClaimed: ["Parent goal is complete"],
			remainingQuestions: ["Operator must choose a release gate."],
		});
		const committed = await session.goalRuntime.commitCheckpoint(candidate, {
			status: "accepted",
			feedback: "Checkpoint accepted.",
			evidenceChecked: candidate.evidence,
			blockers: [],
			reviewedAt: Date.now(),
		});
		await session.goalRuntime.recordCheckpointResolution({
			checkpointId: candidate.id,
			stateVersion: committed.stateVersion,
			parentFrameVersion: committed.parentFrameVersion,
			decision: "pause_for_external_control",
			parentReading: "External operator must choose a release gate.",
			notPropagated: ["Next target selected"],
			remainingParentWork: ["Choose the next release gate"],
			broaderChecksOrInputs: ["Operator gate selection"],
		});
		session.setTodoPhases([
			{
				name: "Evidence closeout",
				tasks: [{ content: "Checkpoint current target", status: "in_progress" }],
			},
		]);
		const reminders: string[] = [];
		session.subscribe(event => {
			if (event.type === "todo_reminder") reminders.push(event.type);
		});

		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Run mode is now awaiting-user-input." }],
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
		await session.waitForIdle();

		expect(session.getGoalModeState()?.runMode).toBe("awaiting-user-input");
		expect(session.getGoalModeState()?.goal.pendingCheckpointId).toBeUndefined();
		expect(reminders).toHaveLength(0);
		expect(getRuntimeSignals().some(signal => signal.startsWith("todo:"))).toBe(false);
		expect(continueSpy).not.toHaveBeenCalled();
	});
});
