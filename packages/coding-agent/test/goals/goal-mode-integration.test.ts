import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
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
	authStorage: AuthStorage;
	settings: Settings;
	session: AgentSession;
	mode: InteractiveMode;
	toolSession: ToolSession;
	cleanup: () => Promise<void>;
};

type GoalSideAgentMock = {
	completionStatus: "verified" | "rejected";
	feedback: string;
	continuationMessage: string;
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
		continuationMessage: "Continue with the highest-value missing evidence.",
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
				continuationMessage: goalSideAgentMock.continuationMessage,
			});
		}
		if (options.agent.name === "goal-continuation-compactor") {
			return createSideAgentResult(options, {
				continuationMessage: goalSideAgentMock.continuationMessage,
			});
		}
		throw new Error(`unexpected side agent ${options.agent.name}`);
	});
}

async function createGoalHarness(): Promise<GoalHarness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-goal-mode-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}

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
	});
	const mode = new InteractiveMode(session, "test");
	const toolSession = createToolSession(tempDir.path(), settings, {
		getGoalModeState: () => session.getGoalModeState(),
		getGoalRuntime: () => session.goalRuntime,
		createGoalWithRubric: (input, signal) => session.createGoalWithRubric(input, signal),
		replaceGoalWithRubric: (input, signal) => session.replaceGoalWithRubric(input, signal),
		requestGoalCompletion: signal => session.requestGoalCompletion(signal),
	});
	toolRegistry.set("goal", new GoalTool(toolSession) as unknown as Tool);

	return {
		tempDir,
		authStorage,
		settings,
		session,
		mode,
		toolSession,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
			resetSettingsForTest();
		},
	};
}

async function toolNamesFor(harness: GoalHarness): Promise<string[]> {
	return (await createTools(harness.toolSession, harness.session.getActiveToolNames())).map(tool => tool.name);
}

describe("InteractiveMode goal mode integration", () => {
	let harness: GoalHarness;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		installGoalSideAgentMock();
		harness = await createGoalHarness();
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
		await harness.mode.handleGoalModeCommand("Ship the release");

		const state = harness.session.getGoalModeState();
		const rubricCall = goalSideAgentCalls.find(call => call.agent.name === "goal-rubric");
		expect(state?.goal.rubric).toContain("Strict test rubric");
		expect(rubricCall?.agent.tools).toEqual(["read", "search", "find", "yield"]);
		expect(rubricCall?.task).toContain("<full_transcript_file>");
		expect(rubricCall?.task).toContain("Ship the release");
		if (!rubricCall?.contextFile) throw new Error("expected rubric side agent context file");
		const transcript = await Bun.file(rubricCall.contextFile).text();
		expect(transcript).toContain("Test");
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
		goalSideAgentMock.continuationMessage = "Run the focused integration proof before trying completion again.";
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
			feedback: "Missing end-to-end verification evidence.",
		});
		expect(result.details?.completionVerification?.continuationMessage).toContain(
			"Run the focused integration proof before trying completion again.",
		);
		expect(result.details?.completionVerification?.continuationMessage).toContain("<goal_continuation_compaction>");
		expect(completionText).toContain("Completion verification rejected");
		expect(completionText).toContain("Continuation guidance");
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.mode).toBe("active");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("active");
		expect(harness.session.getGoalModeState()?.goal.failedCompletionAttempts).toBe(1);
		expect(goalSideAgentCalls.map(call => call.agent.name)).toContain("goal-completion-verifier");
		expect(goalSideAgentCalls.map(call => call.agent.name)).toContain("goal-continuation-compactor");
		const verifierCall = goalSideAgentCalls.find(call => call.agent.name === "goal-completion-verifier");
		const compactorCall = goalSideAgentCalls.find(call => call.agent.name === "goal-continuation-compactor");
		expect(verifierCall?.agent.tools).toEqual(["read", "search", "find", "yield"]);
		expect(compactorCall?.agent.tools).toEqual(["read", "search", "find", "yield"]);
		expect(verifierCall?.task).toContain("<full_transcript_file>");
		expect(verifierCall?.task).toContain("Strict test rubric");
		expect(compactorCall?.task).toContain("<verification_feedback>");
		expect(compactorCall?.task).toContain("Missing end-to-end verification evidence.");
		expect(goalSideAgentCalls.map(call => call.agent.name)).toEqual([
			"goal-rubric",
			"goal-completion-verifier",
			"goal-continuation-compactor",
		]);
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
