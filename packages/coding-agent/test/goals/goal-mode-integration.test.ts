import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	type GoalContinuationFocus,
	parseGoalModeState,
	serializeGoalModeState,
} from "@oh-my-pi/pi-coding-agent/goals/state";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	GOAL_CHECKPOINT_MESSAGE_TYPE,
	GOAL_CHECKPOINT_RESOLUTION_MESSAGE_TYPE,
	GOAL_RUBRIC_MESSAGE_TYPE,
	GOAL_VERIFICATION_FEEDBACK_MESSAGE_TYPE,
	type GoalCheckpointMessageDetails,
	type GoalCheckpointResolutionMessageDetails,
	type GoalRubricMessageDetails,
	type GoalVerificationFeedbackMessageDetails,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

function createToolSession(cwd: string, settings: Settings, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		...overrides,
	};
}

type GoalHarness = {
	tempDir: TempDir;
	settings: Settings;
	authStorage: AuthStorage;
	session: AgentSession;
	mode: InteractiveMode;
	toolSession: ToolSession;
	cleanup: () => Promise<void>;
};

type GoalSideAgentMock = {
	completionStatus: "verified" | "rejected";
	feedback: string;
	compactorFails: boolean;
	compactorMemo: string;
	continuationFocus: GoalContinuationFocus | undefined;
	checkpointReviewStatus: "accepted" | "rejected";
	checkpointReviewFeedback: string;
	checkpointGuidance: string;
};

let goalSideAgentMock: GoalSideAgentMock;
let goalSideAgentCalls: ExecutorOptions[];

function createSideAgentResult(options: ExecutorOptions, data: unknown): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: JSON.stringify(data, null, 2),
		stderr: "",
		truncated: false,
		durationMs: 25,
		tokens: 7,
		modelOverride: options.modelOverride,
	};
}

function installGoalSideAgentMock(): void {
	goalSideAgentMock = {
		completionStatus: "verified",
		feedback: "Verifier accepted the test goal.",
		compactorFails: false,
		compactorMemo: "Continue with the highest-value missing evidence.",
		continuationFocus: {
			openGaps: ["Missing end-to-end verification evidence."],
			nextActions: ["Continue with the highest-value missing evidence."],
			evidenceToCollect: ["Current focused integration proof."],
			avoidRepeating: ["Do not redo accepted setup work."],
		},
		checkpointReviewStatus: "accepted",
		checkpointReviewFeedback: "Checkpoint target is locally closed and bounded.",
		checkpointGuidance: "Controller must resolve the checkpoint before local work resumes.",
	};
	goalSideAgentCalls = [];
	vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
		goalSideAgentCalls.push(options);
		if (options.agent.name === "goal-rubric") {
			return createSideAgentResult(options, {
				rubric: "Strict test rubric with labeled score levels.",
			});
		}
		if (options.agent.name === "goal-completion-verifier") {
			return createSideAgentResult(options, {
				status: goalSideAgentMock.completionStatus,
				feedback: goalSideAgentMock.feedback,
				summary: goalSideAgentMock.feedback,
				score: goalSideAgentMock.completionStatus === "verified" ? 4 : 2,
				deliverableResults: [
					{
						id: "D1",
						status: goalSideAgentMock.completionStatus === "verified" ? "passed" : "failed",
						rationale: goalSideAgentMock.feedback,
					},
				],
				evidenceChecked: [{ claim: "Goal state", evidence: "Mock verifier inspected state", current: true }],
				completionBlockers:
					goalSideAgentMock.completionStatus === "verified"
						? []
						: [
								{
									id: "B1",
									deliverableId: "D1",
									severity: "blocking",
									problem: goalSideAgentMock.feedback,
									requiredEvidenceOrFix: goalSideAgentMock.compactorMemo,
								},
							],
				continuationFocus: goalSideAgentMock.continuationFocus,
				continuationMessage:
					"<goal_continuation_compaction>Hidden prepared verifier hint.</goal_continuation_compaction>",
			});
		}
		if (options.agent.name === "goal-continuation-compactor") {
			if (goalSideAgentMock.compactorFails) {
				return {
					...createSideAgentResult(options, {}),
					exitCode: 1,
					error: "compactor failed",
					output: "",
				};
			}
			return createSideAgentResult(options, {
				compactorMemo: goalSideAgentMock.compactorMemo,
				continuationMessage: goalSideAgentMock.compactorMemo,
			});
		}
		if (options.agent.name === "goal-checkpoint-reviewer") {
			return createSideAgentResult(options, {
				status: goalSideAgentMock.checkpointReviewStatus,
				feedback: goalSideAgentMock.checkpointReviewFeedback,
				evidenceChecked: [
					{ claim: "Checkpoint claim", evidence: "Mock reviewer inspected evidence", current: true },
				],
				blockers:
					goalSideAgentMock.checkpointReviewStatus === "accepted"
						? []
						: [
								{
									id: "checkpoint-evidence",
									severity: "blocking",
									problem: goalSideAgentMock.checkpointReviewFeedback,
									requiredEvidenceOrFix: "Gather current target-closure evidence.",
								},
							],
				continuationFocus:
					goalSideAgentMock.checkpointReviewStatus === "accepted"
						? undefined
						: goalSideAgentMock.continuationFocus,
			});
		}
		if (options.agent.name === "goal-checkpoint-guidance") {
			return createSideAgentResult(options, {
				continuationMessage: goalSideAgentMock.checkpointGuidance,
				checkpointSummary: "Checkpoint accepted in mock guidance.",
				controllerQuestions: ["Which target or external check should happen next?"],
				possibleNextTargets: ["Prove tarball smoke path"],
				broaderChecksOrInputs: ["Ask operator whether CI is required now."],
				parentDeltaConsiderations: ["Admit only the bounded checkpoint claim."],
				lessonsForFuture: ["Keep checkpoint claims bounded."],
				avoidRepeating: ["Do not treat checkpoint as parent completion."],
			});
		}
		throw new Error(`unexpected side agent ${options.agent.name}`);
	});
}

// Immutable, expensive fixtures shared across every test. `new ModelRegistry`
// alone is ~110ms (loads + parses the bundled model catalog), which dominated
// this file's wall time when rebuilt per test. The registry, its auth storage,
// and the resolved model are never mutated by goal-mode flows, and
// AgentSession.dispose() never closes authStorage — so a single shared instance
// is safe and drops repeated pure setup overhead.
type SharedFixture = {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model;
	baseDir: TempDir;
};

async function createSharedFixture(): Promise<SharedFixture> {
	const baseDir = TempDir.createSync("@pi-goal-mode-shared-");
	const authStorage = await AuthStorage.create(path.join(baseDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}
	return { authStorage, modelRegistry, model, baseDir };
}

async function createGoalHarness(
	shared: SharedFixture,
	options: { extensionRunner?: ExtensionRunner } = {},
): Promise<GoalHarness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-goal-mode-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const { modelRegistry, model } = shared;

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
		"plan.enabled": true,
	});
	const bootstrapToolSession = createToolSession(tempDir.path(), settings);
	const initialTools = await createTools(bootstrapToolSession, ["read"]);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));

	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
		extensionRunner: options.extensionRunner,
	});
	const mode = new InteractiveMode(session, "test");
	const toolSession = createToolSession(tempDir.path(), settings, {
		getGoalModeState: () => session.getGoalModeState(),
		getGoalRuntime: () => session.goalRuntime,
		createGoalWithRubric: (input, signal) => session.createGoalWithRubric(input, signal),
		requestGoalCheckpoint: (input, signal) => session.requestGoalCheckpoint(input, signal),
		requestGoalCheckpointResolution: (input, signal) => session.requestGoalCheckpointResolution(input, signal),
		replaceGoalWithRubric: (input, signal) => session.replaceGoalWithRubric(input, signal),
		requestGoalCompletion: signal => session.requestGoalCompletion(signal),
	});
	toolRegistry.set("goal", new GoalTool(toolSession) as unknown as Tool);

	return {
		tempDir,
		authStorage: shared.authStorage,
		settings,
		session,
		mode,
		toolSession,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
			tempDir.removeSync();
			resetSettingsForTest();
		},
	};
}

async function toolNamesFor(harness: GoalHarness): Promise<string[]> {
	return (await createTools(harness.toolSession, harness.session.getActiveToolNames())).map(tool => tool.name);
}

async function activeGoalTool(harness: GoalHarness): Promise<Tool> {
	const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
		tool => tool.name === "goal",
	);
	if (!goalTool) throw new Error("Expected goal tool to be active");
	return goalTool;
}

function appendCompactableHistory(harness: GoalHarness): void {
	const model = harness.session.model;
	if (!model) throw new Error("Expected model to be selected");
	const now = Date.now();
	const usage = {
		input: 120,
		output: 40,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 160,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	harness.session.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "first compactable turn" }],
		timestamp: now - 4,
	});
	harness.session.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "first compactable response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage,
		timestamp: now - 3,
	});
	harness.session.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "second compactable turn" }],
		timestamp: now - 2,
	});
	harness.session.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "second compactable response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage,
		timestamp: now - 1,
	});
}

function installCompactionMock() {
	return vi
		.spyOn(compactionModule, "compact")
		.mockImplementation(async (preparation, _model, _apiKey, _instructions, _signal, options) => ({
			summary: "goal-aware compacted summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: { extraContext: options?.extraContext },
			preserveData: { compactMock: "preserved" },
		}));
}

function createRestoredSession(
	harness: GoalHarness,
	sessionManager: SessionManager,
): {
	session: AgentSession;
	mode: InteractiveMode;
	cleanup: () => Promise<void>;
} {
	const model = harness.session.model;
	if (!model) throw new Error("Expected model to be selected");
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
		}),
		sessionManager,
		settings: harness.settings,
		modelRegistry: new ModelRegistry(harness.authStorage),
		toolRegistry: new Map<string, Tool>(),
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const mode = new InteractiveMode(session, "test-restore");
	return {
		session,
		mode,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
		},
	};
}

describe("InteractiveMode goal mode integration", () => {
	let harness: GoalHarness;
	let shared: SharedFixture;

	beforeAll(async () => {
		initTheme();
		shared = await createSharedFixture();
	});

	afterAll(() => {
		shared.authStorage.close();
		shared.baseDir.removeSync();
	});

	beforeEach(async () => {
		installGoalSideAgentMock();
		harness = await createGoalHarness(shared);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.cleanup();
	});

	it("toggles goal tool exposure when goal mode enters and pauses", async () => {
		expect(await toolNamesFor(harness)).not.toContain("goal");

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(await toolNamesFor(harness)).toContain("goal");

		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.handleGoalModeCommand();

		expect(harness.mode.goalModeEnabled).toBe(false);
		expect(harness.mode.goalModePaused).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
		expect(await toolNamesFor(harness)).not.toContain("goal");
	});

	it("generates a rubric through a read-only side agent before goal work starts", async () => {
		const showStatus = vi.spyOn(harness.mode, "showStatus");

		await harness.mode.handleGoalModeCommand("Ship the release");

		const state = harness.session.getGoalModeState();
		const rubricCall = goalSideAgentCalls.find(call => call.agent.name === "goal-rubric");
		expect(state?.goal.rubric).toContain("Strict test rubric");
		expect(showStatus).toHaveBeenCalledWith("Generating goal rubric…");
		expect(showStatus).toHaveBeenCalledWith("Goal rubric generated.");
		const artifact = harness.session.sessionManager
			.getEntries()
			.find(entry => entry.type === "custom_message" && entry.customType === GOAL_RUBRIC_MESSAGE_TYPE);
		if (artifact?.type !== "custom_message") throw new Error("expected rubric artifact");
		expect(JSON.stringify(artifact.content)).toContain("Strict test rubric");
		expect((artifact.details as GoalRubricMessageDetails).objective).toBe("Ship the release");
		expect((artifact.details as GoalRubricMessageDetails).rubric).toContain("Strict test rubric");
		const renderedChat = Bun.stripANSI(harness.mode.chatContainer.render(120).join("\n"));
		expect(renderedChat).toContain("[goal-rubric]");
		expect(renderedChat).toContain("ctrl+o to expand");
		expect(showStatus.mock.calls.map(call => String(call[0])).join("\n")).not.toContain("Strict test rubric");
		expect(rubricCall?.agent.tools).toEqual(["read", "search", "find", "yield"]);
		expect(rubricCall?.task).toContain("<full_transcript_file>");
		expect(rubricCall?.task).toContain("Ship the release");
		if (!rubricCall?.contextFile) throw new Error("expected rubric side agent context file");
		const transcript = await Bun.file(rubricCall.contextFile).text();
		expect(transcript).toContain("Test");
	});

	it("surfaces rubric generation status when replacing the active goal", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const showStatus = vi.spyOn(harness.mode, "showStatus");
		const beforeRubricCount = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === GOAL_RUBRIC_MESSAGE_TYPE).length;

		await harness.mode.handleGoalModeCommand("set Replace the objective");

		expect(showStatus).toHaveBeenCalledWith("Generating goal rubric…");
		expect(showStatus).toHaveBeenCalledWith("Goal rubric generated.");
		const rubricEntries = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === GOAL_RUBRIC_MESSAGE_TYPE);
		expect(rubricEntries.length).toBe(beforeRubricCount + 1);
		const latestRubricEntry = rubricEntries[rubricEntries.length - 1];
		if (latestRubricEntry?.type !== "custom_message") throw new Error("expected replacement rubric artifact");
		expect((latestRubricEntry.details as GoalRubricMessageDetails).objective).toBe("Replace the objective");
		expect((latestRubricEntry.details as GoalRubricMessageDetails).rubric).toContain("Strict test rubric");
		const renderedChat = Bun.stripANSI(harness.mode.chatContainer.render(120).join("\n"));
		expect(renderedChat).toContain("[goal-rubric]");
		expect(showStatus.mock.calls.map(call => String(call[0])).join("\n")).not.toContain("Strict test rubric");
	});

	it("replaces the active goal via /goal set", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const originalGoal = harness.session.getGoalModeState()?.goal;
		if (!originalGoal) throw new Error("expected active goal");

		await harness.mode.handleGoalModeCommand("set Replace the objective");

		const state = harness.session.getGoalModeState();
		expect(state?.enabled).toBe(true);
		expect(state?.goal.objective).toBe("Replace the objective");
		expect(state?.goal.status).toBe("active");
		expect(state?.goal.id).not.toBe(originalGoal.id);
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(await toolNamesFor(harness)).toContain("goal");
	});

	it("refuses /goal while plan mode is active", async () => {
		const showWarning = vi.spyOn(harness.mode, "showWarning");
		harness.mode.planModeEnabled = true;

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(showWarning).toHaveBeenCalledWith("Exit plan mode first.");
		expect(harness.session.getGoalModeState()).toBeUndefined();
	});

	it("refuses /plan while goal mode is active", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.handlePlanModeCommand();

		expect(showWarning).toHaveBeenCalledWith("Exit goal mode first.");
		expect(harness.mode.planModeEnabled).toBe(false);
	});

	it("rejects a new /goal objective while paused", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.handleGoalModeCommand();
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.handleGoalModeCommand("Replace the objective");

		expect(showWarning).toHaveBeenCalledWith(
			"Resume the current goal first, or drop it before setting a new objective.",
		);
		expect(harness.session.getGoalModeState()?.enabled).toBe(false);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
	});

	it("resumes the paused goal via the bare /goal menu", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValueOnce("Pause");
		await harness.mode.handleGoalModeCommand();
		expect(harness.mode.goalModePaused).toBe(true);
		selector.mockResolvedValueOnce("Resume");
		const showStatus = vi.spyOn(harness.mode, "showStatus");

		await harness.mode.handleGoalModeCommand();

		expect(showStatus).toHaveBeenCalledWith("Goal mode resumed.");
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.mode.goalModePaused).toBe(false);
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("active");
		expect(await toolNamesFor(harness)).toContain("goal");
	});

	it("mutates the goal token budget via /goal budget without resetting accumulated usage", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		// Seed accumulated usage by driving the runtime directly — equivalent to a turn's flush.
		const goal = harness.session.getGoalModeState()?.goal;
		if (!goal) throw new Error("expected active goal");
		goal.tokensUsed = 42;
		goal.timeUsedSeconds = 5;

		await harness.mode.handleGoalModeCommand("budget 123");

		const after = harness.session.getGoalModeState();
		expect(after?.goal.tokenBudget).toBe(123);
		// Accumulated counters are preserved across the mutation.
		expect(after?.goal.tokensUsed).toBe(42);
		expect(after?.goal.timeUsedSeconds).toBe(5);

		await harness.mode.handleGoalModeCommand("budget off");
		expect(harness.session.getGoalModeState()?.goal.tokenBudget).toBeUndefined();
		expect(harness.session.getGoalModeState()?.goal.tokensUsed).toBe(42);
	});

	it("refuses /goal budget while only a paused goal exists (fix #5)", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.handleGoalModeCommand();
		expect(harness.mode.goalModePaused).toBe(true);
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.handleGoalModeCommand("budget 99");

		expect(showWarning).toHaveBeenCalledWith("Resume the goal before adjusting the budget.");
		// Mutation must not have run while the goal is paused.
		expect(harness.session.getGoalModeState()?.goal.tokenBudget).toBeUndefined();
	});

	it("keeps the goal active and returns continuation guidance when verification rejects completion", async () => {
		goalSideAgentMock.completionStatus = "rejected";
		goalSideAgentMock.feedback = "Missing end-to-end verification evidence.";
		goalSideAgentMock.compactorMemo = "Run the focused integration proof before trying completion again.";
		goalSideAgentMock.continuationFocus = {
			openGaps: [goalSideAgentMock.feedback],
			nextActions: [goalSideAgentMock.compactorMemo],
			evidenceToCollect: ["Current focused integration proof."],
			avoidRepeating: ["Do not redo accepted setup work."],
		};
		await harness.mode.handleGoalModeCommand("Ship the release");
		const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
			tool => tool.name === "goal",
		);
		if (!goalTool) {
			throw new Error("Expected goal tool to be active");
		}

		const result = await goalTool.execute("call-verify-reject", { op: "complete" });
		const completionText = JSON.stringify(result.content);

		expect(result.details?.completionBudgetReport).toBeNull();
		expect(result.details?.completionVerification).toMatchObject({
			status: "rejected",
			attempt: 1,
			maxAttempts: 3,
			totalAttempts: 1,
			feedback: "Missing end-to-end verification evidence.",
			structuredFeedback: {
				score: 2,
			},
		});
		expect(result.details?.completionVerification?.compactorMemo).toContain(
			"Run the focused integration proof before trying completion again.",
		);
		expect(result.details?.completionVerification?.compactorMemo).not.toContain("<goal_continuation_compaction>");
		expect(result.details?.completionVerification?.continuationMessage).toBeUndefined();
		expect(completionText).toContain("Completion verification rejected");
		expect(completionText).toContain("Run the focused integration proof before trying completion again.");
		expect(completionText).not.toContain("<goal_continuation_compaction>");
		expect(completionText).not.toContain("<prepared_goal_continuation>");
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.mode).toBe("active");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("active");
		expect(harness.session.getGoalModeState()?.goal.failedCompletionAttempts).toBe(1);
		expect(harness.session.getGoalModeState()?.runMode).toBe("awaiting-verification-repair");
		const repairDispatch = await harness.session.prepareGoalContinuationDispatch();
		expect(repairDispatch?.kind).toBe("verification-repair");
		expect(repairDispatch?.customType).toBe("goal-verification-repair");
		expect(repairDispatch?.prompt).toContain("Run the focused integration proof before trying completion again.");
		expect(goalSideAgentCalls.map(call => call.agent.name)).toContain("goal-completion-verifier");
		expect(goalSideAgentCalls.map(call => call.agent.name)).not.toContain("goal-continuation-compactor");
		const verifierCall = goalSideAgentCalls.find(call => call.agent.name === "goal-completion-verifier");
		expect(verifierCall?.agent.tools).toEqual(["read", "search", "find", "yield"]);
		expect(verifierCall?.strictToolNames).toBe(true);
		expect(verifierCall?.task).toContain("<full_transcript_file>");
		expect(verifierCall?.task).toContain("Strict test rubric");
		const entries = harness.session.sessionManager.getEntries();
		const rubricEntries = entries.filter(
			entry => entry.type === "custom_message" && entry.customType === GOAL_RUBRIC_MESSAGE_TYPE,
		);
		const feedbackEntries = entries.filter(
			entry => entry.type === "custom_message" && entry.customType === GOAL_VERIFICATION_FEEDBACK_MESSAGE_TYPE,
		);
		expect(rubricEntries.length).toBeGreaterThan(0);
		expect(feedbackEntries.length).toBeGreaterThan(0);
		const latestFeedbackEntry = feedbackEntries[feedbackEntries.length - 1];
		if (latestFeedbackEntry?.type !== "custom_message") throw new Error("expected verification feedback artifact");
		expect(JSON.stringify(latestFeedbackEntry.content)).not.toContain("<goal_continuation_compaction>");
		expect(JSON.stringify(latestFeedbackEntry.content)).not.toContain("<prepared_goal_continuation>");
		expect(JSON.stringify(latestFeedbackEntry.details)).not.toContain("<goal_continuation_compaction>");
		expect(JSON.stringify(latestFeedbackEntry.details)).not.toContain("<prepared_goal_continuation>");
		expect(JSON.stringify(latestFeedbackEntry.content)).toContain(
			"Run the focused integration proof before trying completion again.",
		);
		expect((latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails).attempt).toBe(1);
		expect((latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails).maxAttempts).toBe(3);
		expect((latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails).totalAttempts).toBe(1);
		expect((latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails).feedback).toBe(
			"Missing end-to-end verification evidence.",
		);
		expect((latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails).structuredFeedback?.score).toBe(2);
		expect((latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails).compactorMemo).toContain(
			"Run the focused integration proof before trying completion again.",
		);
		const beforeMenuCount = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message").length;
		const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Show verification feedback");
		await harness.mode.handleGoalModeCommand();
		expect(selector.mock.calls[0]?.[1]).toContain("Show rubric");
		expect(selector.mock.calls[0]?.[1]).toContain("Show verification feedback");
		const afterMenuEntries = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message");
		expect(afterMenuEntries.length).toBe(beforeMenuCount);
		const renderedAfterMenu = Bun.stripANSI(harness.mode.chatContainer.render(120).join("\n"));
		expect(renderedAfterMenu).toContain("[goal-verification-feedback]");
		const beforeSubcommandCount = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message").length;
		await harness.mode.handleGoalModeCommand("rubric");
		await harness.mode.handleGoalModeCommand("feedback");
		const afterSubcommandEntries = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message");
		expect(afterSubcommandEntries.length).toBe(beforeSubcommandCount);
		const addedSubcommandEntries = afterSubcommandEntries.slice(beforeSubcommandCount);
		expect(addedSubcommandEntries).toEqual([]);
		const renderedAfterSubcommands = Bun.stripANSI(harness.mode.chatContainer.render(120).join("\n"));
		expect(renderedAfterSubcommands).toContain("[goal-rubric]");
		expect(renderedAfterSubcommands).toContain("[goal-verification-feedback]");
		expect(renderedAfterSubcommands).toContain("ctrl+o to expand");
		expect(goalSideAgentCalls.map(call => call.agent.name)).toEqual(["goal-rubric", "goal-completion-verifier"]);
	});

	it("checkpoints a closed target, schedules controller guidance, and resolves to the next target", async () => {
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const toolsForTurn = await createTools(harness.toolSession, harness.session.getActiveToolNames());
		const goalTool = toolsForTurn.find(tool => tool.name === "goal");
		const readTool = toolsForTurn.find(tool => tool.name === "read");
		if (!goalTool || !readTool) throw new Error("Expected goal and read tools to be active");

		await goalTool.execute("target", {
			op: "start_target",
			title: "Prove source-link smoke",
			desired_future_claim: "Source-link install exercises smoke path.",
			closure_standard: "Current smoke output exists.",
			forbidden_claims: ["Release is ready"],
		});
		const checkpoint = await goalTool.execute("checkpoint", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Source-link smoke passed.",
			local_claims: ["Source-link install exercises smoke path"],
			evidence: [
				{
					claim: "Source-link install exercises smoke path",
					evidence: "Observed smoke output",
					current: true,
				},
			],
			not_claimed: ["Release is ready"],
			remaining_questions: ["Should tarball smoke be next?"],
			checks_run: ["bun test focused-smoke"],
			artifacts_touched: ["scripts/install-tests/run-ci.sh"],
		});
		const checkpointId = checkpoint.details?.checkpoint?.id;
		if (!checkpointId) throw new Error("expected checkpoint id");

		expect(checkpoint.details?.state?.runMode).toBe("awaiting-checkpoint-resolution");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("active");
		expect(harness.session.getGoalModeState()?.goal.pendingCheckpointId).toBe(checkpointId);
		expect(JSON.stringify(checkpoint.content)).toContain("Parent goal remains active");
		await expect(goalTool.execute("complete-while-pending", { op: "complete" })).rejects.toThrow(
			"checkpoint is pending resolution",
		);
		await expect(readTool.execute("read-after-checkpoint", { path: "package.json" })).rejects.toThrow(
			"checkpoint is pending resolution",
		);

		const checkpointEntry = harness.session.sessionManager
			.getEntries()
			.find(entry => entry.type === "custom_message" && entry.customType === GOAL_CHECKPOINT_MESSAGE_TYPE);
		if (checkpointEntry?.type !== "custom_message") throw new Error("expected checkpoint artifact");
		const checkpointDetails = checkpointEntry.details as GoalCheckpointMessageDetails;
		expect(checkpointDetails.parentGoalActive).toBe(true);
		expect(checkpointDetails.checkpoint.id).toBe(checkpointId);
		harness.mode.rebuildChatFromMessages();
		expect(Bun.stripANSI(harness.mode.chatContainer.render(120).join("\n"))).toContain("[goal-checkpoint]");

		const guidance = await harness.session.prepareGoalContinuationDispatch();
		expect(guidance?.kind).toBe("checkpoint-resolution");
		expect(guidance?.customType).toBe("goal-checkpoint-resolution");
		expect(guidance?.prompt).toContain(goalSideAgentMock.checkpointGuidance);
		expect(guidance?.prompt).toContain("resolve_checkpoint");
		const guidanceCall = goalSideAgentCalls.find(call => call.agent.name === "goal-checkpoint-guidance");
		expect(guidanceCall?.agent.tools).toEqual(["read", "search", "find", "yield"]);
		expect(guidanceCall?.task).toContain("<goal_state_snapshot>");

		const resolved = await goalTool.execute("resolve", {
			op: "resolve_checkpoint",
			checkpoint_id: checkpointId,
			decision: "next_target",
			parent_reading: "Source-link smoke is bounded local evidence; tarball smoke remains open.",
			parent_delta: {
				admitted_claims: [
					{
						id: "source-link-smoke",
						claim: "Source-link smoke passed locally.",
						status: "accepted",
						non_implications: ["Release is ready"],
					},
				],
				residuals_added_or_updated: [
					{
						id: "tarball-smoke",
						statement: "Tarball smoke remains unproven.",
						classification: "current-parent-blocker",
					},
				],
			},
			not_propagated: ["Release is ready"],
			remaining_parent_work: ["Tarball smoke evidence"],
			next_target: {
				title: "Prove tarball smoke",
				desired_future_claim: "Tarball install exercises smoke path.",
				closure_standard: "Current tarball smoke output exists.",
				forbidden_claims: ["Release is ready"],
			},
		});

		expect(resolved.details?.state?.runMode).toBe("working-target");
		expect(resolved.details?.state?.goal.pendingCheckpointId).toBeUndefined();
		expect(resolved.details?.state?.goal.currentTarget?.title).toBe("Prove tarball smoke");
		expect(resolved.details?.state?.goal.parentFrame?.acceptedClaims[0]?.id).toBe("source-link-smoke");
		const resolutionEntry = harness.session.sessionManager
			.getEntries()
			.find(
				entry => entry.type === "custom_message" && entry.customType === GOAL_CHECKPOINT_RESOLUTION_MESSAGE_TYPE,
			);
		if (resolutionEntry?.type !== "custom_message") throw new Error("expected resolution artifact");
		const resolutionDetails = resolutionEntry.details as GoalCheckpointResolutionMessageDetails;
		expect(resolutionDetails.parentGoalActive).toBe(true);
		harness.mode.rebuildChatFromMessages();
		expect(resolutionDetails.resolution.decision).toBe("next_target");
		expect(Bun.stripANSI(harness.mode.chatContainer.render(120).join("\n"))).toContain(
			"[goal-checkpoint-resolution]",
		);

		await harness.session.sessionManager.ensureOnDisk();
		const sessionFile = harness.session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const reopenedManager = await SessionManager.open(sessionFile);
		const restored = createRestoredSession(harness, reopenedManager);
		try {
			const restoredContext = restored.session.buildDisplaySessionContext();
			const restoredCustomTypes = restoredContext.messages.flatMap(message =>
				message.role === "custom" ? [message.customType] : [],
			);
			expect(restoredCustomTypes).toContain(GOAL_CHECKPOINT_MESSAGE_TYPE);
			expect(restoredCustomTypes).toContain(GOAL_CHECKPOINT_RESOLUTION_MESSAGE_TYPE);
			restored.mode.renderSessionContext(restoredContext);
			const restoredRendered = Bun.stripANSI(restored.mode.chatContainer.render(120).join("\n"));
			expect(restoredRendered).toContain("[goal-checkpoint]");
			expect(restoredRendered).toContain("[goal-checkpoint-resolution]");
		} finally {
			await restored.cleanup();
		}
	});

	it("recovers committed checkpoint and resolution artifacts from restored goal state when custom messages are missing", async () => {
		await harness.mode.handleGoalModeCommand("Recover committed checkpoint artifacts");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target-recovery", {
			op: "start_target",
			title: "Prove recoverable checkpoint",
			desired_future_claim: "Committed checkpoint artifacts are recoverable.",
			closure_standard: "Restored state can rebuild checkpoint and resolution artifacts.",
		});
		const checkpoint = await goalTool.execute("checkpoint-recovery", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Recovery checkpoint committed.",
			local_claims: ["Committed checkpoint artifacts are recoverable"],
			evidence: [
				{
					claim: "Committed checkpoint artifacts are recoverable",
					evidence: "Runtime state stores the committed checkpoint packet.",
					current: true,
				},
			],
			not_claimed: ["Parent goal is complete"],
			remaining_questions: ["Which target follows recovery proof?"],
		});
		const checkpointId = checkpoint.details?.checkpoint?.id;
		if (!checkpointId) throw new Error("expected recovery checkpoint id");
		const resolved = await goalTool.execute("resolve-recovery", {
			op: "resolve_checkpoint",
			checkpoint_id: checkpointId,
			decision: "needs_broader_checks",
			parent_reading: "Recovery proof is local; broader restored-session checks remain relevant.",
			not_propagated: ["Parent goal is complete"],
			remaining_parent_work: ["Restore/handoff evidence"],
			broader_checks_or_inputs: ["Reload persisted session and rebuild UI."],
		});
		const resolutionId = resolved.details?.checkpointResolution?.id;
		if (!resolutionId) throw new Error("expected recovery resolution id");
		const committedState = harness.session.getGoalModeState();
		if (!committedState) throw new Error("expected committed goal state");

		const recoveryManager = SessionManager.create(
			harness.tempDir.path(),
			path.join(harness.tempDir.path(), "recovery-sessions"),
		);
		recoveryManager.appendModeChange("goal", serializeGoalModeState(committedState));
		await recoveryManager.ensureOnDisk();
		const recoveryFile = recoveryManager.getSessionFile();
		if (!recoveryFile) throw new Error("expected recovery session file");
		const reopenedManager = await SessionManager.open(recoveryFile);
		expect(reopenedManager.getEntries().some(entry => entry.type === "custom_message")).toBe(false);
		const reopenedContext = reopenedManager.buildSessionContext();
		const restoredState = parseGoalModeState(reopenedContext.modeData, reopenedContext.mode === "goal");
		if (!restoredState) throw new Error("expected restored recovery goal state");
		const restored = createRestoredSession(harness, reopenedManager);
		try {
			restored.session.setGoalModeState(restoredState);
			restored.session.recoverGoalArtifactsFromState();
			restored.session.recoverGoalArtifactsFromState();
			const customEntries = reopenedManager.getEntries().filter(entry => entry.type === "custom_message");
			const checkpointEntries = customEntries.filter(entry => entry.customType === GOAL_CHECKPOINT_MESSAGE_TYPE);
			const resolutionEntries = customEntries.filter(
				entry => entry.customType === GOAL_CHECKPOINT_RESOLUTION_MESSAGE_TYPE,
			);
			expect(checkpointEntries).toHaveLength(1);
			expect(resolutionEntries).toHaveLength(1);
			const checkpointDetails = checkpointEntries[0]?.details as GoalCheckpointMessageDetails | undefined;
			const resolutionDetails = resolutionEntries[0]?.details as GoalCheckpointResolutionMessageDetails | undefined;
			expect(checkpointDetails?.checkpoint.id).toBe(checkpointId);
			expect(checkpointDetails?.parentGoalActive).toBe(true);
			expect(resolutionDetails?.resolution.id).toBe(resolutionId);
			expect(resolutionDetails?.parentGoalActive).toBe(true);
			restored.mode.rebuildChatFromMessages();
			const rendered = Bun.stripANSI(restored.mode.chatContainer.render(120).join("\n"));
			expect(rendered).toContain("[goal-checkpoint]");
			expect(rendered).toContain("[goal-checkpoint-resolution]");
			expect(rendered).toContain("Target closed; parent goal still active");
			expect(JSON.stringify(resolutionEntries[0]?.content)).toContain("Checkpoint resolution");
		} finally {
			await restored.cleanup();
		}
	});

	it("resumes a paused checkpoint-resolution goal from the goal menu action", async () => {
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target-menu", {
			op: "start_target",
			title: "Prove menu checkpoint",
			desired_future_claim: "Menu checkpoint has current evidence.",
			closure_standard: "Current evidence exists.",
		});
		await goalTool.execute("checkpoint-menu", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Menu checkpoint is pending.",
			local_claims: ["Menu checkpoint has current evidence"],
			evidence: [{ claim: "Menu checkpoint has current evidence", evidence: "Observed output", current: true }],
			not_claimed: ["Parent goal is complete"],
			remaining_questions: ["Which target follows?"],
		});
		const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValueOnce("Pause");
		await harness.mode.handleGoalModeCommand();
		expect(harness.mode.goalModePaused).toBe(true);
		selector.mockResolvedValueOnce("Resume checkpoint resolution");
		const showStatus = vi.spyOn(harness.mode, "showStatus");

		await harness.mode.handleGoalModeCommand();

		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.mode.goalModePaused).toBe(false);
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.runMode).toBe("awaiting-checkpoint-resolution");
		expect(showStatus).toHaveBeenCalledWith("Checkpoint resolution continuation scheduled.");
	});

	it("exercises a Gateway-like release flow through checkpoint, compaction, verifier repair, and final completion", async () => {
		harness.authStorage.setRuntimeApiKey("anthropic", "test-key");
		harness.settings.set("compaction.keepRecentTokens", 1);
		const compactSpy = installCompactionMock();
		const goalTool = new GoalTool(harness.toolSession);

		await goalTool.execute("create-gateway", {
			op: "create",
			objective: "Improve release reliability",
			parent_frame: {
				kind: "claim-gated",
				desired_future:
					"Release reliability advances only through explicit claims, bounded evidence, gates, and controller-approved targets.",
				current_truth: "Installer smoke coverage exists, but release readiness is not established.",
				baseline_refs: [{ id: "release-plan", kind: "doc", uri: "docs/release-plan.md" }],
				gates: [
					{
						id: "installer-smoke",
						name: "Installer smoke evidence",
						status: "unknown",
						required_evidence: ["focused installer smoke output"],
						stale_if: ["installer script changes"],
					},
				],
				boundaries: [
					{
						id: "local-smoke-not-release",
						kind: "forbidden-inference",
						statement: "Local smoke success does not imply release readiness, CI health, or tarball coverage.",
					},
				],
				residuals: [
					{
						id: "tarball-smoke-evidence",
						statement: "Tarball install path still needs current smoke evidence.",
						classification: "current-parent-blocker",
					},
				],
				authority: {
					parent_state_authority: "controller turn",
					worker_may_only_propose: true,
				},
				external_refs: [{ id: "release-record", kind: "external-record", uri: "release://candidate" }],
			},
		});
		await harness.session.setActiveToolsByName(["read", "goal"]);

		await goalTool.execute("target-gateway", {
			op: "start_target",
			title: "Prove source-link installer smoke",
			desired_future_claim: "Source-link installer flow exercises the smoke path with current evidence.",
			expected_parent_contribution: "Closes one installer-smoke evidence gap without claiming release readiness.",
			closure_standard: "Focused smoke output exists and would fail if the smoke path broke.",
			baseline_refs: [{ id: "release-plan", kind: "doc", uri: "docs/release-plan.md" }],
			gate_refs: ["installer-smoke"],
			evidence_expectation: ["focused smoke output"],
			non_goals: ["full release readiness", "tarball install coverage"],
			forbidden_claims: ["Release is ready", "CI is green", "Tarball install path is verified"],
			stale_if: ["installer script changes"],
		});
		const checkpoint = await goalTool.execute("checkpoint-gateway", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Source-link installer smoke produced current focused evidence.",
			local_claims: ["Source-link installer flow exercises the smoke path"],
			evidence: [
				{
					claim: "Source-link installer flow exercises the smoke path",
					evidence: "Observed focused source-link smoke output",
					current: true,
				},
			],
			checks_run: ["bun test packages/coding-agent/test/goals/goal-mode-integration.test.ts"],
			artifacts_touched: ["scripts/install-tests/run-ci.sh"],
			not_claimed: [
				"Parent goal is complete",
				"Release is ready",
				"CI is green",
				"Tarball install path is verified",
			],
			remaining_questions: ["Should controller choose tarball smoke evidence next?"],
			risks_or_caveats: ["Only the source-link install surface has current evidence."],
			suggested_controller_questions: ["Is tarball smoke the next release-reliability target?"],
		});
		const checkpointId = checkpoint.details?.checkpoint?.id;
		if (!checkpointId) throw new Error("expected checkpoint id");
		expect(harness.session.getGoalModeState()?.runMode).toBe("awaiting-checkpoint-resolution");
		expect((await harness.session.prepareGoalContinuationDispatch())?.kind).toBe("checkpoint-resolution");

		const resolved = await goalTool.execute("resolve-gateway", {
			op: "resolve_checkpoint",
			checkpoint_id: checkpointId,
			decision: "next_target",
			parent_reading:
				"Source-link smoke is accepted as bounded local evidence; tarball install evidence remains parent work.",
			parent_delta: {
				admitted_claims: [
					{
						id: "source-link-installer-smoke",
						claim: "Source-link installer smoke has current bounded evidence.",
						status: "accepted",
						evidence_refs: [{ id: `checkpoint:${checkpointId}`, kind: "artifact" }],
						non_implications: ["Release is ready", "Tarball install path is verified"],
					},
				],
				residuals_added_or_updated: [
					{
						id: "tarball-smoke-evidence",
						statement: "Tarball install path still needs current smoke evidence.",
						classification: "current-parent-blocker",
						required_evidence: ["tarball install smoke output"],
					},
				],
				gate_deltas: [
					{
						gate_id: "installer-smoke",
						status: "passed",
						evidence_refs: [{ id: `checkpoint:${checkpointId}`, kind: "artifact" }],
					},
				],
				boundaries_added: [
					{
						id: "source-link-not-tarball",
						kind: "forbidden-inference",
						statement: "Source-link smoke evidence does not prove tarball install behavior.",
					},
				],
			},
			not_propagated: ["Release is ready", "Tarball install path is verified"],
			remaining_parent_work: ["Collect tarball install smoke evidence", "Run broader release checks if required"],
			broader_checks_or_inputs: ["Ask operator whether CI is required before parent completion."],
			lessons_for_future: ["Keep installer smoke claims tied to the install surface that produced evidence."],
			next_target: {
				title: "Prove tarball installer smoke",
				desired_future_claim: "Tarball installer flow exercises the same smoke path with current evidence.",
				expected_parent_contribution: "Extends smoke evidence to the distribution path users install.",
				closure_standard: "Focused tarball install smoke output exists.",
				baseline_refs: [{ id: `checkpoint:${checkpointId}`, kind: "artifact" }],
				gate_refs: ["tarball-smoke"],
				evidence_expectation: ["tarball install smoke output"],
				forbidden_claims: ["Release is ready", "CI is green"],
				stale_if: ["tarball installer script changes"],
			},
		});
		expect(resolved.details?.state?.runMode).toBe("working-target");
		expect(resolved.details?.state?.goal.currentTarget?.title).toBe("Prove tarball installer smoke");

		appendCompactableHistory(harness);
		const compacted = await harness.session.compact();
		const compactCall = compactSpy.mock.calls[0];
		if (!compactCall) throw new Error("expected compaction call");
		const compactOptions = compactCall[5];
		const extraContext = compactOptions?.extraContext?.join("\n") ?? "";
		expect(extraContext).toContain("<goal_mode_compaction_context>");
		expect(extraContext).toContain("Prove tarball installer smoke");
		expect(extraContext).toContain("Release is ready");
		expect(extraContext).toContain("tarball-smoke-evidence");
		expect(JSON.stringify(compacted.preserveData?.goalMode)).toContain('"runMode":"working-target"');
		expect(JSON.stringify(compacted.preserveData?.goalMode)).toContain("Prove tarball installer smoke");
		expect(JSON.stringify(compacted.preserveData?.goalContinuationPacket)).toContain(
			'"transition":"context-compaction"',
		);

		goalSideAgentMock.completionStatus = "rejected";
		goalSideAgentMock.feedback = "Tarball smoke evidence is still missing.";
		goalSideAgentMock.continuationFocus = {
			openGaps: ["Tarball smoke evidence is still missing."],
			nextActions: ["Run or inspect tarball install smoke evidence before retrying completion."],
			evidenceToCollect: ["Current tarball install smoke output."],
			avoidRepeating: ["Do not cite source-link smoke as tarball evidence."],
		};
		const earlyCompletion = await goalTool.execute("complete-too-early", { op: "complete" });
		expect(earlyCompletion.details?.completionVerification?.status).toBe("rejected");
		expect(harness.session.getGoalModeState()?.runMode).toBe("awaiting-verification-repair");
		expect(harness.session.getGoalModeState()?.goal.verificationRepair?.feedback).toBe(
			"Tarball smoke evidence is still missing.",
		);
		const repairDispatch = await harness.session.prepareGoalContinuationDispatch();
		expect(repairDispatch?.kind).toBe("verification-repair");
		expect(repairDispatch?.prompt).toContain("Tarball smoke evidence is still missing.");
		expect(repairDispatch?.prompt).toContain("Do not retry `complete`");

		await goalTool.execute("repair-target", {
			op: "start_target",
			title: "Repair tarball smoke evidence",
			desired_future_claim: "Tarball smoke evidence is current enough for parent completion.",
			closure_standard: "Current tarball smoke output is recorded.",
			linked_verifier_blocker_ids: ["B1"],
			forbidden_claims: ["Release is ready without verifier acceptance"],
		});
		const repairCheckpoint = await goalTool.execute("repair-checkpoint", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Tarball smoke evidence was gathered for verifier repair.",
			local_claims: ["Tarball smoke evidence is current"],
			evidence: [
				{ claim: "Tarball smoke evidence is current", evidence: "Observed tarball smoke output", current: true },
			],
			not_claimed: ["Parent goal is complete"],
			remaining_questions: ["Can the parent verifier accept completion now?"],
		});
		const repairCheckpointId = repairCheckpoint.details?.checkpoint?.id;
		if (!repairCheckpointId) throw new Error("expected repair checkpoint id");
		expect(harness.session.getGoalModeState()?.goal.verificationRepair).toBeUndefined();
		const repairResolution = await goalTool.execute("repair-resolution", {
			op: "resolve_checkpoint",
			checkpoint_id: repairCheckpointId,
			decision: "parent_completion_candidate",
			parent_reading: "Verifier repair evidence is now recorded; parent completion may be retried.",
			not_propagated: ["Parent goal is complete without verifier acceptance"],
			remaining_parent_work: ["Run parent completion verifier."],
		});
		expect(repairResolution.details?.state?.runMode).toBe("awaiting-parent-completion");
		const parentCompletionDispatch = await harness.session.prepareGoalContinuationDispatch();
		expect(parentCompletionDispatch?.kind).toBe("parent-completion");
		expect(parentCompletionDispatch?.prompt).toContain('goal({op:"complete"})');
		goalSideAgentMock.completionStatus = "verified";
		goalSideAgentMock.feedback = "Verifier accepted the repaired release-reliability evidence.";
		const finalCompletion = await goalTool.execute("complete-after-repair", { op: "complete" });
		expect(finalCompletion.details?.completionVerification?.status).toBe("verified");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("complete");
		expect(harness.session.getGoalModeState()?.mode).toBe("exiting");
	});

	it("carries pending checkpoint state and goal tools across handoff compaction", async () => {
		harness.authStorage.setRuntimeApiKey("anthropic", "test-key");
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target-handoff", {
			op: "start_target",
			title: "Prove source-link smoke before handoff",
			desired_future_claim: "Source-link smoke has current evidence before handoff.",
			closure_standard: "Current smoke output exists before handoff.",
			forbidden_claims: ["Release is ready"],
		});
		const checkpoint = await goalTool.execute("checkpoint-handoff", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Source-link smoke was closed before handoff.",
			local_claims: ["Source-link smoke has current evidence before handoff"],
			evidence: [
				{
					claim: "Source-link smoke has current evidence before handoff",
					evidence: "Observed output",
					current: true,
				},
			],
			not_claimed: ["Release is ready"],
			remaining_questions: ["Which target should follow handoff?"],
		});
		const checkpointId = checkpoint.details?.checkpoint?.id;
		if (!checkpointId) throw new Error("expected checkpoint id");
		appendCompactableHistory(harness);
		const handoffSpy = vi
			.spyOn(compactionModule, "generateHandoff")
			.mockResolvedValue("## Goal\nContinue from handoff");

		const result = await harness.session.handoff();
		expect(result?.document).toBe("## Goal\nContinue from handoff");
		const handoffCall = handoffSpy.mock.calls[0];
		if (!handoffCall) throw new Error("expected handoff call");
		expect(handoffCall[3].customInstructions).toContain("<goal_mode_compaction_context>");
		expect(handoffCall[3].customInstructions).toContain("awaiting-checkpoint-resolution");
		expect(harness.session.getGoalModeState()?.goal.pendingCheckpointId).toBe(checkpointId);
		expect(harness.session.getActiveToolNames()).toContain("goal");

		const sessionFile = harness.session.sessionFile;
		if (!sessionFile) throw new Error("expected handoff session file");
		const persistedEntries = (await Bun.file(sessionFile).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { type?: string; mode?: string; data?: unknown; customType?: string });
		const modeEntry = persistedEntries.find(entry => entry.type === "mode_change" && entry.mode === "goal");
		if (!modeEntry) throw new Error("expected carried goal mode change");
		const restored = parseGoalModeState(modeEntry.data);
		if (!restored) throw new Error("expected restorable goal mode state");
		expect(restored.runMode).toBe("awaiting-checkpoint-resolution");
		expect(restored.goal.pendingCheckpointId).toBe(checkpointId);
		expect(restored.goal.checkpoints?.[0]?.id).toBe(checkpointId);

		const dispatch = await harness.session.prepareGoalContinuationDispatch();
		expect(dispatch?.kind).toBe("checkpoint-resolution");
		expect(dispatch?.customType).toBe("goal-checkpoint-resolution");
		expect(dispatch?.prompt).toContain("resolve_checkpoint");
	});

	it("rejects checkpoint packets through the read-only reviewer without closing the target", async () => {
		goalSideAgentMock.checkpointReviewStatus = "rejected";
		goalSideAgentMock.checkpointReviewFeedback = "Smoke output is missing.";
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
			tool => tool.name === "goal",
		);
		if (!goalTool) throw new Error("Expected goal tool to be active");
		await goalTool.execute("target", {
			op: "start_target",
			title: "Prove source-link smoke",
			desired_future_claim: "Source-link install exercises smoke path.",
			closure_standard: "Current smoke output exists.",
		});

		const checkpoint = await goalTool.execute("checkpoint", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Weak source-link smoke evidence.",
			local_claims: ["Source-link install exercises smoke path"],
			evidence: [{ claim: "Source-link install exercises smoke path", evidence: "File changed", current: true }],
			not_claimed: ["Release is ready"],
			remaining_questions: ["Need stronger evidence."],
		});

		const checkpointText = checkpoint.content[0]?.type === "text" ? checkpoint.content[0].text : "";
		expect(checkpointText).toContain("Checkpoint rejected. Target remains active");
		expect(checkpointText).not.toContain("Target checkpoint recorded");
		expect(checkpointText).not.toContain("Ordinary continuation is paused");
		expect(checkpoint.details?.checkpointReview?.status).toBe("rejected");
		expect(checkpoint.details?.state?.runMode).toBe("working-target");
		expect(harness.session.getGoalModeState()?.goal.currentTarget?.status).toBe("active");
		expect(harness.session.getGoalModeState()?.goal.lastCheckpointRejection?.review.feedback).toBe(
			"Smoke output is missing.",
		);
		const checkpointEntry = harness.session.sessionManager
			.getEntries()
			.find(entry => entry.type === "custom_message" && entry.customType === GOAL_CHECKPOINT_MESSAGE_TYPE);
		if (checkpointEntry?.type !== "custom_message") throw new Error("expected rejected checkpoint artifact");
		expect(JSON.stringify(checkpointEntry.content)).toContain("Checkpoint rejected; target remains active");
		expect(JSON.stringify(checkpointEntry.content)).not.toContain("Target closed; parent goal still active");
		const reviewerCall = goalSideAgentCalls.find(call => call.agent.name === "goal-checkpoint-reviewer");
		expect(reviewerCall?.agent.tools).toEqual(["read", "search", "find", "yield"]);
		expect(reviewerCall?.task).toContain("<goal_state_snapshot>");
	});

	it("persists verifier feedback when continuation compaction fails", async () => {
		goalSideAgentMock.completionStatus = "rejected";
		goalSideAgentMock.feedback = "Verifier found a blocking gap before compaction.";
		goalSideAgentMock.compactorFails = true;
		goalSideAgentMock.continuationFocus = undefined;
		await harness.mode.handleGoalModeCommand("Ship the release");
		const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
			tool => tool.name === "goal",
		);
		if (!goalTool) {
			throw new Error("Expected goal tool to be active");
		}

		const result = await goalTool.execute("call-verify-compactor-fail", { op: "complete" });
		expect(result.details?.completionVerification?.status).toBe("rejected");
		expect(result.details?.completionVerification?.compactorMemo).toBeUndefined();
		const repairDispatch = await harness.session.prepareGoalContinuationDispatch();
		expect(repairDispatch?.kind).toBe("verification-repair");
		expect(repairDispatch?.prompt).toContain("Verifier found a blocking gap before compaction.");

		const goal = harness.session.getGoalModeState()?.goal;
		expect(goal?.failedCompletionAttempts).toBe(1);
		expect(goal?.lastVerificationAttempt).toBe(1);
		expect(goal?.lastVerificationFeedback).toBe("Verifier found a blocking gap before compaction.");
		expect(goal?.lastVerificationCompactorMemo).toBeUndefined();
		const feedbackEntries = harness.session.sessionManager
			.getEntries()
			.filter(
				entry => entry.type === "custom_message" && entry.customType === GOAL_VERIFICATION_FEEDBACK_MESSAGE_TYPE,
			);
		expect(feedbackEntries.length).toBeGreaterThan(0);
		const latestFeedbackEntry = feedbackEntries[feedbackEntries.length - 1];
		if (latestFeedbackEntry?.type !== "custom_message") throw new Error("expected verification feedback artifact");
		const details = latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails;
		expect(details.attempt).toBe(1);
		expect(details.maxAttempts).toBe(3);
		expect(details.feedback).toBe("Verifier found a blocking gap before compaction.");
		expect(details.totalAttempts).toBe(1);
		expect(details.structuredFeedback?.completionBlockers[0]?.id).toBe("B1");
		expect(details.compactorMemo).toBeUndefined();
		expect(JSON.stringify(latestFeedbackEntry.content)).not.toContain("<goal_continuation_compaction>");
	});
	it("blocks repeated parent completion until verifier blockers get fresh repair evidence", async () => {
		goalSideAgentMock.completionStatus = "rejected";
		goalSideAgentMock.feedback = "Still missing verification evidence.";
		goalSideAgentMock.compactorMemo = "Keep gathering proof.";
		goalSideAgentMock.continuationFocus = undefined;
		await harness.mode.handleGoalModeCommand("Ship the release");
		const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
			tool => tool.name === "goal",
		);
		if (!goalTool) {
			throw new Error("Expected goal tool to be active");
		}

		await goalTool.execute("call-verify-reject-1", { op: "complete" });
		await expect(goalTool.execute("call-verify-reject-2", { op: "complete" })).rejects.toThrow("verifier blockers");
		expect(harness.session.getGoalModeState()?.runMode).toBe("awaiting-verification-repair");
		expect(harness.session.getGoalModeState()?.goal.failedCompletionAttempts).toBe(1);
		expect(harness.session.getGoalModeState()?.goal.verificationRepair?.feedback).toBe(
			"Still missing verification evidence.",
		);

		await harness.session.goalRuntime.onToolCompleted("read");
		await expect(goalTool.execute("call-verify-reject-3", { op: "complete" })).rejects.toThrow("verifier blockers");
		await goalTool.execute("repair-target-repeat", {
			op: "start_target",
			title: "Gather missing verifier evidence",
			desired_future_claim: "Missing verifier evidence is current.",
			closure_standard: "Current evidence is recorded for blocker B1.",
			linked_verifier_blocker_ids: ["B1"],
		});
		const checkpoint = await goalTool.execute("repair-checkpoint-repeat", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Fresh verifier evidence was gathered.",
			local_claims: ["Missing verifier evidence is current"],
			evidence: [
				{ claim: "Missing verifier evidence is current", evidence: "Observed focused proof", current: true },
			],
			not_claimed: ["Parent goal is complete"],
			remaining_questions: ["Should completion be retried?"],
		});
		const checkpointId = checkpoint.details?.checkpoint?.id;
		if (!checkpointId) throw new Error("expected repair checkpoint id");
		await goalTool.execute("repair-resolution-repeat", {
			op: "resolve_checkpoint",
			checkpoint_id: checkpointId,
			decision: "parent_completion_candidate",
			parent_reading: "Fresh verifier evidence is recorded.",
			not_propagated: ["Parent goal is complete without verifier acceptance"],
			remaining_parent_work: ["Retry parent completion verification."],
		});
		const second = await goalTool.execute("call-verify-reject-4", { op: "complete" });

		expect(second.details?.completionVerification?.attempt).toBe(1);
		expect(second.details?.completionVerification?.totalAttempts).toBe(2);
		expect(harness.session.getGoalModeState()?.goal.failedCompletionAttempts).toBe(1);
		const feedbackEntries = harness.session.sessionManager
			.getEntries()
			.filter(
				entry => entry.type === "custom_message" && entry.customType === GOAL_VERIFICATION_FEEDBACK_MESSAGE_TYPE,
			);
		const latestFeedbackEntry = feedbackEntries[feedbackEntries.length - 1];
		if (latestFeedbackEntry?.type !== "custom_message") throw new Error("expected verification feedback artifact");
		const details = latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails;
		expect(details.attempt).toBe(1);
		expect(details.totalAttempts).toBe(2);
		expect(details.feedback).toBe("Still missing verification evidence.");
		expect(harness.session.getGoalModeState()?.goal.verificationAttempts?.length).toBe(2);
	});

	it("returns the completion report from the goal tool and exits goal mode before the next turn rebuild", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		await harness.mode.handleGoalModeCommand("budget 50");
		const appendCustomEntry = vi.spyOn(harness.session.sessionManager, "appendCustomEntry");
		const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
			tool => tool.name === "goal",
		);
		if (!goalTool) {
			throw new Error("Expected goal tool to be active");
		}

		const result = await goalTool.execute("call-1", { op: "complete" });
		const completionText = JSON.stringify(result.content);

		expect(result.details?.completionBudgetReport).toBe(
			"Goal achieved. Report final budget usage to the user: tokens used: 7 of 50.",
		);
		expect(completionText).toContain("Goal achieved. Report final budget usage to the user: tokens used: 7 of 50.");
		expect(harness.session.getGoalModeState()?.mode).toBe("exiting");
		// Per fix #1: completeGoalFromTool clears state.enabled so subsequent createTools
		// calls (e.g. mid-turn refreshes) no longer advertise the goal tool. The model's
		// existing toolset for the in-flight turn is unaffected — what we care about here
		// is that the next createTools observation reflects the deactivation.
		expect(harness.session.getGoalModeState()?.enabled).toBe(false);
		expect(await toolNamesFor(harness)).not.toContain("goal");

		const nextTurn = harness.mode.getUserInput();
		// getUserInput observes mode === "exiting" and awaits #exitGoalMode before
		// arming onInputCallback. Drain microtasks until that side-effect lands.
		for (let i = 0; i < 100 && harness.session.getGoalModeState() !== undefined; i++) {
			await Bun.sleep(0);
		}
		expect(harness.mode.goalModeEnabled).toBe(false);
		expect(harness.mode.goalModePaused).toBe(false);
		expect(harness.session.getGoalModeState()).toBeUndefined();
		expect(await toolNamesFor(harness)).not.toContain("goal");
		expect(appendCustomEntry).toHaveBeenCalledWith(
			"goal-completed",
			expect.objectContaining({
				objective: "Ship the release",
				tokenBudget: 50,
				tokensUsed: 7,
			}),
		);

		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "next turn" }));
		await nextTurn;
	});
});
