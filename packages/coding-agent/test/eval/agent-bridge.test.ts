import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { runEvalAgent } from "../../src/eval/agent-bridge";
import type { LocalProtocolOptions } from "../../src/internal-urls";
import type { MCPManager } from "../../src/mcp";
import * as taskDiscovery from "../../src/task/discovery";
import * as taskExecutor from "../../src/task/executor";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

function createResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "0-Task",
		agent: "task",
		agentSource: "bundled",
		task: "do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		...overrides,
	};
}

function createTaskAgent(): AgentDefinition {
	return {
		name: "task",
		description: "Task agent",
		systemPrompt: "Handle task",
		source: "bundled",
	};
}

describe("runEvalAgent", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards session-scoped MCP and local protocol options", async () => {
		const agent = createTaskAgent();
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult());

		const mcpManager = { sentinel: "mcp" } as unknown as MCPManager;
		const localProtocolOptions: LocalProtocolOptions = {
			getArtifactsDir: () => "/tmp/parent-artifacts",
			getSessionId: () => "parent-session",
		};
		const session = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			mcpManager,
			localProtocolOptions,
		} as unknown as ToolSession;

		await runEvalAgent({ prompt: "do work", agentType: "task" }, { session });

		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		const options = runSubprocessSpy.mock.calls[0]?.[0];
		expect(options?.mcpManager).toBe(mcpManager);
		expect(options?.localProtocolOptions).toBe(localProtocolOptions);
	});

	it("passes configured auth fallback context to subprocess and returns fallback notices", async () => {
		const agent = createTaskAgent();
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(
			createResult({
				providerNotice:
					"Subagent model credentials unavailable; using parent session model deepseek/deepseek-v4-pro because task.fallbackToParentModelOnAuthFailure=true.",
				resolvedModel: "deepseek/deepseek-v4-pro",
			}),
		);
		const settings = Settings.isolated({
			"task.fallbackToParentModelOnAuthFailure": true,
			"task.agentModelOverrides": { task: ["opencode-zen/qwen3.6-plus-free"] },
		});
		const session = {
			cwd: "/tmp",
			settings,
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			getActiveModelString: () => "deepseek/deepseek-v4-pro",
		} as unknown as ToolSession;

		const result = await runEvalAgent({ prompt: "do work", agentType: "task" }, { session });

		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		const options = runSubprocessSpy.mock.calls[0]?.[0];
		expect(options?.settings?.get("task.fallbackToParentModelOnAuthFailure")).toBe(true);
		expect(options?.parentActiveModelPattern).toBe("deepseek/deepseek-v4-pro");
		expect(options?.modelOverride).toEqual(["opencode-zen/qwen3.6-plus-free"]);
		expect(result.details.notice).toContain("task.fallbackToParentModelOnAuthFailure=true");
		expect(result.details.model).toBe("deepseek/deepseek-v4-pro");
	});

	it("surfaces provider classifications returned by eval agent subprocess failures", async () => {
		const agent = createTaskAgent();
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess");
		const settings = Settings.isolated();
		const session = {
			cwd: "/tmp",
			settings,
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			getActiveModelString: () => "deepseek/deepseek-v4-pro",
		} as unknown as ToolSession;
		const errors = [
			"Subagent provider failure [auth]: 401 unauthorized\nAction: Configure credentials for this provider/model or choose an authenticated model.",
			"Subagent provider failure [model_not_found]: model does not exist\nAction: Update the configured model id/role or choose a model present in the registry.",
			"Subagent provider failure [rate_limit]: 429 rate limit\nAction: Wait for provider quota to recover, switch credentials, or choose another model tier.",
			"Subagent provider failure [context_overflow]: context window exceeded\nAction: Compact or reduce context before retrying, or choose a model with a larger context window.",
			"Subagent provider failure [stream_stall]: stream stalled\nAction: Retry or choose another provider/model; the provider stream stopped making progress.",
			"Subagent provider failure [first_event_timeout]: timed out while waiting for the first provider event\nAction: Retry or choose another provider/model; the provider stream produced no initial event.",
		];

		for (const error of errors) {
			runSubprocessSpy.mockResolvedValueOnce(createResult({ exitCode: 1, error }));
			await expect(runEvalAgent({ prompt: "do work", agentType: "task" }, { session })).rejects.toThrow(error);
		}
	});
});
