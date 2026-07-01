import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
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
import * as unexpectedStopClassifier from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";
import { getProjectAgentDir, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";

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
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("before_compact:enter");',
				"\t\tconst gate = globalThis.__ompManualCompactGate;",
				"\t\tif (gate) await gate;",
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
		try {
			await session?.dispose();
		} finally {
			try {
				authStorage?.close();
				vi.useRealTimers();
				await Bun.sleep(0);
				await tempDir?.remove();
			} finally {
				getRuntimeSignals().length = 0;
				(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
					undefined;
				vi.restoreAllMocks();
			}
		}
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

	it("marks manual compaction active before abort teardown can yield", async () => {
		session.settings.set("compaction.keepRecentTokens", 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
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
		sessionManager.appendMessage({
			role: "user",
			content: "second turn",
			timestamp: Date.now(),
		});

		const abortEntered = Promise.withResolvers<void>();
		const releaseAbort = Promise.withResolvers<void>();
		let compactingDuringAbort: boolean | undefined;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			compactingDuringAbort = session.isCompacting;
			abortEntered.resolve();
			await releaseAbort.promise;
		});

		const compactPromise = session.compact();
		await abortEntered.promise;
		releaseAbort.resolve();
		await compactPromise;

		expect(compactingDuringAbort).toBe(true);
	});

	it("cancels an in-flight auto-compaction when manual compact startup aborts", async () => {
		// Give the branch something to summarize so auto-compaction reaches the
		// awaited session_before_compact hook, where the test parks it.
		session.settings.set("compaction.keepRecentTokens", 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
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
		sessionManager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });

		// Park the in-flight auto-compaction inside its awaited hook so
		// #autoCompactionAbortController stays installed across the manual /compact
		// startup abort below.
		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;

		const appendCompactionSpy = vi.spyOn(sessionManager, "appendCompaction");
		let autoAborted: boolean | undefined;
		const autoEnded = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") {
				autoAborted = event.aborted;
				autoEnded.resolve();
			}
		});

		const autoPromise = session.runIdleCompaction();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}

		// Manual /compact startup performs exactly this internal abort while holding
		// its own freshly installed #compactionAbortController. The auto signal is
		// raised synchronously (before abort's first await), then the gate releases
		// the parked pass so it observes the abort and unwinds.
		const abortPromise = session.abort({ goalReason: "internal", preserveCompaction: true });
		gate.resolve();
		await abortPromise;
		await autoPromise;
		await autoEnded.promise;

		// The in-flight auto pass MUST be cancelled so it cannot race the manual run
		// and double-rewrite session history.
		expect(autoAborted).toBe(true);
		expect(appendCompactionSpy).not.toHaveBeenCalled();
	});

	it("runs threshold compaction for active goal turns that end with yield", async () => {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			runMode: "working-target",
			stateVersion: 0,
			parentFrameVersion: 0,
			goal: {
				id: "goal-threshold",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		const yieldCall = {
			type: "toolCall" as const,
			id: "call_goal_yield",
			name: "yield",
			arguments: { status: "progress" },
		};
		const assistantMsg = {
			role: "assistant" as const,
			content: [yieldCall],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "toolUse" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			isError: false,
			result: {
				content: [{ type: "text" as const, text: "Yielded." }],
				details: { status: "success" },
			},
		});
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
	});

	it("runs active-goal threshold compaction after yield followed by a trailing empty stop", async () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});

		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			runMode: "working-target",
			stateVersion: 0,
			parentFrameVersion: 0,
			goal: {
				id: "goal-yield-empty-stop-threshold",
				objective: "continue after compacting",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		const yieldCall = {
			type: "toolCall" as const,
			id: "call_goal_yield_then_empty",
			name: "yield",
			arguments: { status: "progress" },
		};
		const yieldMsg = {
			role: "assistant" as const,
			content: [yieldCall],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "toolUse" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};
		const trailingEmptyStop = {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 191000,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now + 1,
		};

		session.agent.emitExternalEvent({ type: "message_end", message: yieldMsg });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			isError: false,
			result: {
				content: [{ type: "text" as const, text: "Yielded." }],
				details: { status: "success" },
			},
		});
		session.agent.emitExternalEvent({ type: "message_end", message: trailingEmptyStop });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [yieldMsg, trailingEmptyStop] });

		await session.waitForIdle();

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
		expect(
			debugSpy.mock.calls.some(([message, context]) => {
				if (message !== "agent_end maintenance routing") return false;
				if (context?.route !== "post-yield-trailing-stop-active-goal-checkCompaction") return false;
				return context.successfulYield === true;
			}),
		).toBe(true);
	});

	it("triggers threshold compaction in active goals even when per-turn pruning shaves the post-prune estimate below threshold", async () => {
		// Regression for #3174. Goal mode is the most common scenario: the agent
		// runs many tool-result-heavy turns and the per-turn "useless" /
		// "supersede" passes shave tokens off every check. Pre-fix
		// `#checkCompaction` subtracted those savings from the threshold input, so
		// with the reporter's fixed `compaction.thresholdTokens: 76384`, the
		// threshold input fell below the trigger even when the provider-billed
		// prompt (and the visible context anchored to it) sat above 90k tokens —
		// auto-compaction silently no-op'd indefinitely while the loop kept
		// running.
		//
		// This seeds one large `useless` tool result whose suffix sits inside the
		// 8k cache-warm window so `#pruneStaleToolResults` actually returns ≥20k
		// savings (well above the buggy code's mis-subtraction needed to drop
		// 91000 below 76384). Compaction MUST still fire because the last turn's
		// billed context tokens (91k) are above the configured threshold.
		const now = Date.now();

		// Seed: small user, small toolCall, ONE big useless tool result, then a
		// handful of small turns that keep the suffix after the big result under
		// the 8000-token cache-warm cutoff. The big result is the only viable
		// prune candidate, and it alone saves well over 20k tokens — enough to
		// drag the pre-fix threshold input from 91k well below 76384.
		sessionManager.appendMessage({
			role: "user",
			content: "Investigate every module of the project.",
			timestamp: now - 200,
		});
		const bigCallId = "call-big-useless";
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: bigCallId, name: "grep", arguments: { pattern: "TODO" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now - 180,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: bigCallId,
			toolName: "grep",
			content: [{ type: "text", text: "match line\n".repeat(20000) }], // ~40k+ tokens
			isError: false,
			useless: true,
			timestamp: now - 170,
		});
		// A few small follow-up turns so the big result's suffix stays inside the
		// 8000-token cache-warm window. Each pair is well under a hundred tokens.
		for (let i = 0; i < 4; i++) {
			const smallId = `call-small-${i}`;
			const ts = now - 160 + i * 2;
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: smallId, name: "read", arguments: { path: `note-${i}.md` } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: ts,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: smallId,
				toolName: "read",
				content: [{ type: "text", text: `tiny note ${i}` }],
				isError: false,
				timestamp: ts + 1,
			});
		}
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.setGoalModeState({
			enabled: true,
			mode: "active",
			runMode: "working-target",
			stateVersion: 0,
			parentFrameVersion: 0,
			goal: {
				id: "goal-threshold-pruneable",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.strategy", "context-full");
		session.settings.set("compaction.dropUseless", true);
		session.settings.set("compaction.supersedeReads", true);
		session.settings.set("compaction.keepRecentTokens", 10000);
		session.settings.set("compaction.reserveTokens", 16384);

		// Final assistant turn: billed at ~91k context tokens, just over the
		// reporter's threshold. The pre-fix code would have subtracted ≥20k of
		// prune savings and dropped the threshold input below 76384, skipping
		// compaction. Post-fix it must trigger.
		const finalAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Investigated module-7; continuing." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
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

		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });

		await session.waitForIdle();

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
	});
	it("runs active-goal threshold compaction before unexpected-stop retry continuation", async () => {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			runMode: "working-target",
			stateVersion: 0,
			parentFrameVersion: 0,
			goal: {
				id: "goal-unexpected-stop-threshold",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.autoContinue", true);
		session.settings.set("features.unexpectedStopDetection", true);
		session.settings.set("providers.unexpectedStopModel", "online");

		vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "I should continue investigating another module." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
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

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
	});

	it("resolves a pending retry before active-goal compaction continuation returns", async () => {
		// Codex review on #3175: a retry can succeed with a non-empty text stop
		// that is already over the active-goal compaction threshold. If the
		// compaction pre-empt schedules its own continuation before the normal
		// bottom-of-handler `#resolveRetry()` call runs, the session stays
		// `isRetrying` and later prompt/idle gates remain blocked.
		vi.useRealTimers();
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			runMode: "working-target",
			stateVersion: 0,
			parentFrameVersion: 0,
			goal: {
				id: "goal-retry-threshold",
				objective: "recover from retry and compact",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.autoContinue", true);
		session.settings.set("retry.enabled", true);
		session.settings.set("retry.baseDelayMs", 5);
		session.settings.set("retry.maxDelayMs", 5_000);
		session.settings.set("retry.maxRetries", 1);
		session.settings.set("retry.modelFallback", false);

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const { promise: retryStarted, resolve: onRetryStarted } = Promise.withResolvers<void>();
		const { promise: retryEnded, resolve: onRetryEnded } = Promise.withResolvers<void>();
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_retry_start") onRetryStarted();
			if (event.type === "auto_retry_end") onRetryEnded();
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const retryableError = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Transient provider failure." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "error" as const,
			errorMessage: "503 service unavailable: overloaded_error retry-after-ms=50",
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now - 1,
		};
		session.agent.emitExternalEvent({ type: "message_end", message: retryableError });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [retryableError] });

		await withTimeout(retryStarted, 1000, "Retry start timed out");
		expect(session.isRetrying).toBe(true);

		const recoveredOverThreshold = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Recovered; continuing the active goal." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
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
		session.agent.emitExternalEvent({ type: "message_end", message: recoveredOverThreshold });
		await withTimeout(retryEnded, 1000, "Retry end timed out");
		expect(session.isRetrying).toBe(true);

		session.agent.emitExternalEvent({ type: "agent_end", messages: [recoveredOverThreshold] });

		await withTimeout(compactionDone, 1000, "Compaction end timed out");
		await session.waitForIdle();

		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
		expect(session.isRetrying).toBe(false);
	});

	it("removes orphan toolUse assistant before active-goal threshold compaction continuation", async () => {
		// Codex review on #3175: when an active goal turn is over threshold AND
		// stops with an empty `toolUse` (no tool call), the new ordering must NOT
		// skip `#handleEmptyAssistantStop` — that handler is the only path that
		// strips the orphan assistant from active context + session history. If a
		// compaction continuation runs with the orphan still in place, the next
		// Anthropic turn carries a `tool_use` block with no matching
		// `tool_result` and corrupts the message history.
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			runMode: "working-target",
			stateVersion: 0,
			parentFrameVersion: 0,
			goal: {
				id: "goal-orphan-toolUse-threshold",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.autoContinue", true);

		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const orphanToolUse = {
			role: "assistant" as const,
			// Empty toolUse stop: stopReason says a tool was requested but the
			// content block is empty (no toolCall). This is the case the empty-stop
			// cleanup defends against.
			content: [] as never[],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "toolUse" as const,
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
		session.agent.emitExternalEvent({ type: "message_end", message: orphanToolUse });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [orphanToolUse] });

		await session.waitForIdle();

		// Empty-stop cleanup short-circuits before any compaction continuation, so
		// the threshold compaction MUST NOT fire on this turn — the next turn
		// starts from the cleaned-up branch with the retry-reminder developer
		// message instead. The pre-fix ordering let compaction reach
		// `auto_compaction_start` first, scheduling a continuation while the
		// orphan `toolUse` entry was still the session leaf.
		const signals = getRuntimeSignals();
		expect(signals).not.toContain("compaction:start:threshold");

		// `#removeEmptyStopFromActiveContext` rewinds the session leaf past the
		// orphan via `sessionManager.branch(parentId)` / `resetLeaf()`. If the
		// cleanup is skipped, the orphan is still the leaf when the compaction
		// continuation runs and the next Anthropic turn sends a `tool_use` block
		// with no matching `tool_result`.
		const branch = sessionManager.getBranch();
		const orphanInBranch = branch.some(entry => {
			if (entry.type !== "message") return false;
			const message = entry.message as { role: string; stopReason?: string };
			return message.role === "assistant" && message.stopReason === "toolUse";
		});
		expect(orphanInBranch).toBe(false);
	});

	it("has isCompacting true when the auto_compaction_start event fires", async () => {
		// Defect 1: the compaction AbortController (which backs isCompacting) must be
		// installed before auto_compaction_start is emitted. If it is installed after,
		// a message typed the instant the loader appears is read while
		// isCompacting === false and mis-routed into the core steering queue (which a
		// later handoff reset would wipe) instead of the safe UI compaction queue.
		let capturedIsCompacting: boolean | undefined;
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") {
				capturedIsCompacting = session.isCompacting;
			} else if (event.type === "auto_compaction_end") {
				onCompactionDone();
			}
		});

		// Defensive: mirror the resume-drain stub so any queued continuation settles
		// instead of spinning the drain (see the threshold test above).
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const assistantMsg = {
			role: "assistant" as const,
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

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;

		expect(capturedIsCompacting).toBe(true);
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
				{
					claim: "Installer smoke has bounded current evidence",
					evidence: "Observed smoke output",
					current: true,
					signalIds: ["signal-primary"],
				},
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
		expect(compactionEntry.preserveData?.goalMode).toBeUndefined();
		expect(compactionEntry.preserveData?.goalStateRef).toMatchObject({
			stateVersion: state?.stateVersion,
			goalId: state?.goal.id,
		});
		expect(compactionEntry.preserveData?.goalContinuationPacket).toBeUndefined();
		expect(compactionEntry.preserveData?.goalRoutingCapsule).toMatchObject({
			transition: "target-checkpoint",
			pendingCheckpointId: checkpointId,
		});
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
				{
					claim: "Installer smoke has bounded current evidence",
					evidence: "Observed smoke output",
					current: true,
					signalIds: ["signal-primary"],
				},
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
				{
					claim: "Installer smoke has bounded current evidence",
					evidence: "Observed smoke output",
					current: true,
					signalIds: ["signal-primary"],
				},
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
