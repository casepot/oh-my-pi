import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { isReadOnlyAgent, TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

function createSession(overrides: Partial<Record<string, unknown>> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(overrides),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function createResult(options: ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

function createGoalPlanningState(): GoalModeState {
	return {
		enabled: true,
		mode: "active",
		runMode: "planning-target",
		stateVersion: 3,
		parentFrameVersion: 0,
		goal: {
			id: "goal-1",
			objective: "Ship target planning",
			status: "active",
			tokenBudget: undefined,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 0,
			updatedAt: 0,
			currentTargetPlan: {
				id: "target-plan-1",
				goalId: "goal-1",
				targetId: "target-1",
				targetSequence: 1,
				planFilePath: "local://goal-goal-1-target-1-plan.md",
				status: "drafting",
				revision: 1,
				stateVersionAtStart: 3,
				parentFrameVersionAtStart: 0,
				createdAt: 0,
				updatedAt: 0,
				reviews: [],
			},
		},
	};
}

function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
	const agent = agents.find(candidate => candidate.name === name);
	expect(agent).toBeDefined();
	return agent as AgentDefinition;
}

describe("task agent capability descriptions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("classifies bundled explore as the only read-only delegated agent", () => {
		const agents = loadBundledAgents();

		expect(isReadOnlyAgent(agentByName(agents, "explore"))).toBe(true);
		for (const name of ["task", "quick_task", "plan", "reviewer", "oracle", "designer"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(false);
		}
	});

	it("disables read summarization for explore and librarian, leaves other agents summarizing", () => {
		const agents = loadBundledAgents();

		expect(agentByName(agents, "explore").readSummarize).toBe(false);
		expect(agentByName(agents, "librarian").readSummarize).toBe(false);
		for (const name of ["task", "quick_task", "plan", "reviewer", "oracle", "designer"]) {
			expect(agentByName(agents, name).readSummarize).toBeUndefined();
		}
	});

	it("marks read-only agents in the task description and keeps full agents unmarked", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "read_scout",
					description: "Read-only scout",
					systemPrompt: "Scout the codebase.",
					tools: ["read", "search", "find"],
					source: "project",
				},
				{
					name: "full_agent",
					description: "Full agent",
					systemPrompt: "Modify the codebase.",
					source: "project",
				},
			],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession());
		const description = tool.description;

		expect(description).toContain("# read_scout — READ-ONLY (no edit/write/exec tools)\nRead-only scout");
		expect(description).toContain("# full_agent\nFull agent");
		expect(description).not.toContain("# full_agent — READ-ONLY");
		expect(description).toContain(
			"NEVER offload reasoning, analysis, design, or decision-making to `quick_task` or `explore`",
		);
	});

	it("forces subagents into read-only planning mode during goal target planning", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "task",
					description: "Task agent",
					systemPrompt: "Modify the codebase.",
					source: "bundled",
				},
			],
			projectAgentsDir: null,
		});
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => createResult(options));
		const session = {
			...createSession({ "async.enabled": false }),
			getGoalModeState: () => createGoalPlanningState(),
			getGoalTargetPlanReference: () => ({
				goalId: "goal-1",
				targetId: "target-1",
				targetPlanId: "target-plan-1",
				planFilePath: "local://goal-goal-1-target-1-plan.md",
				payloadFilePath: "local://goal-goal-1-target-1-plan.payload.json",
				title: "goal-goal-1-target-1",
			}),
		} as ToolSession;
		const tool = await TaskTool.create(session);

		await tool.execute("task-call", { agent: "task", assignment: "Inspect the target plan." });

		const options = runSpy.mock.calls[0]?.[0];
		expect(options?.agent.systemPrompt).toContain("Plan mode active");
		expect(options?.agent.tools).toEqual(["read", "search", "find", "lsp", "web_search"]);
		expect(options?.agent.spawns).toBeUndefined();
		expect(options?.planReference).toBeUndefined();
		expect(options?.targetPlanReference).toBeUndefined();
	});

	it("passes approved target plan references to execution subagents", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "task",
					description: "Task agent",
					systemPrompt: "Modify the codebase.",
					source: "bundled",
				},
			],
			projectAgentsDir: null,
		});
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => createResult(options));
		const tempDir = TempDir.createSync("@pi-task-target-plan-");
		try {
			const planFilePath = "local://goal-goal-1-target-1-plan.md";
			const payloadFilePath = "local://goal-goal-1-target-1-plan.payload.json";
			const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
				getArtifactsDir: () => tempDir.path(),
				getSessionId: () => "session-1",
			});
			await Bun.write(resolvedPlanPath, "# Approved target plan\n\nFULL_PLAN_CONTENT_SHOULD_NOT_INLINE");
			const session = {
				...createSession({ "async.enabled": false }),
				getArtifactsDir: () => tempDir.path(),
				getSessionId: () => "session-1",
				getGoalTargetPlanReference: () => ({
					goalId: "goal-1",
					targetId: "target-1",
					targetPlanId: "target-plan-1",
					planFilePath,
					payloadFilePath,
					title: "goal-goal-1-target-1",
					revision: 1,
					executionSummary: {
						targetId: "target-1",
						targetPlanId: "target-plan-1",
						planFilePath,
						payloadFilePath,
						revision: 1,
						targetTitle: "Prove target behavior",
						closureStandard: "Target behavior is observed.",
						implementationFiles: ["src/release.ts"],
						requiredSignals: [
							{
								id: "signal-target-1",
								role: "primary",
								layer: "integration",
								claim: "Target behavior is verified.",
								method: "Run the focused check.",
								expectedOutcome: "The focused check passes.",
								staleIf: ["Relevant code changes."],
							},
						],
						excludedWork: [],
						nonGoals: [],
						forbiddenClaims: [],
						knownLimits: [],
						checkpointEvidence: ["Focused check passes."],
						staleIf: ["Relevant code changes."],
						readPlanFileWhen: "Exact details are missing.",
					},
				}),
			} as ToolSession;
			const tool = await TaskTool.create(session);

			await tool.execute("task-call", { agent: "task", assignment: "Execute the target plan." });

			const options = runSpy.mock.calls[0]?.[0];
			expect(options?.targetPlanReference?.path).toBe(planFilePath);
			expect(options?.targetPlanReference?.content).toContain("Target behavior is verified.");
			expect(options?.targetPlanReference?.content).not.toContain("FULL_PLAN_CONTENT_SHOULD_NOT_INLINE");
		} finally {
			tempDir.removeSync();
		}
	});
});
