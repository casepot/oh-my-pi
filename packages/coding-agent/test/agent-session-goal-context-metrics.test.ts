import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { GoalContextMetric } from "@oh-my-pi/pi-coding-agent/goals/state";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	AgentSession,
	GOAL_CONTEXT_METRIC_CUSTOM_TYPE,
	GOAL_PROOF_GRAPH_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { GoalStateSnapshotEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";

function isGoalContextMetric(value: unknown): value is GoalContextMetric {
	return (
		value !== null &&
		typeof value === "object" &&
		"kind" in value &&
		"goalId" in value &&
		"stateVersion" in value &&
		"serializedBytes" in value &&
		"counts" in value
	);
}

function goalMetrics(sessionManager: SessionManager): GoalContextMetric[] {
	return sessionManager.getEntries().flatMap(entry => {
		if (entry.type !== "custom" || entry.customType !== GOAL_CONTEXT_METRIC_CUSTOM_TYPE) return [];
		return isGoalContextMetric(entry.data) ? [entry.data] : [];
	});
}

function goalSnapshots(sessionManager: SessionManager): GoalStateSnapshotEntry[] {
	return sessionManager.getEntries().flatMap(entry => (entry.type === "goal_state_snapshot" ? [entry] : []));
}

function sideAgentResult(options: ExecutorOptions, data: unknown): SingleResult {
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
		requests: 1,
		modelOverride: options.modelOverride,
		termination: {
			status: "completed",
			code: "yielded",
			reason: "Goal side agent yielded a result",
			resumable: false,
			historyUri: `history://${options.id}`,
			outputUri: `agent://${options.id}`,
			policy: {
				request: { termination: "disabled", advisory: { mode: "off", afterAssistantTurns: null } },
				wallClock: { maxRuntimeMs: null },
				stall: { action: "off", afterAssistantTurns: null },
				spawn: { remainingDepth: null },
				idle: { resumable: true, parkingTtlMs: null },
			},
		},
	};
}

function installCheckpointReviewerMock(): void {
	vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
		if (options.agent.name !== "goal-checkpoint-reviewer") {
			throw new Error(`unexpected side agent ${options.agent.name}`);
		}
		return sideAgentResult(options, {
			status: "accepted",
			feedback: "Checkpoint target is locally closed and bounded.",
			evidenceChecked: [{ claim: "Checkpoint claim", evidence: "Mock reviewer inspected evidence", current: true }],
			blockers: [],
		});
	});
}

describe("AgentSession goal context metrics", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let sessionManager: SessionManager;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-goal-context-metrics-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled Anthropic model");
		model = bundled;
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			advisorTools: [],
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("emits non-context metrics when goal snapshots persist", async () => {
		const state = await session.goalRuntime.createGoal({ objective: "Measure goal metrics without prompt bloat" });
		const metrics = goalMetrics(sessionManager);

		expect(metrics.map(metric => metric.kind)).toEqual(["state_snapshot", "prompt_surface", "proof_graph"]);
		for (const metric of metrics) {
			expect(metric.goalId).toBe(state.goal.id);
			expect(metric.stateVersion).toBe(state.stateVersion);
			expect(metric.serializedBytes).toBeGreaterThan(0);
			expect(JSON.stringify(metric)).not.toContain("Measure goal metrics without prompt bloat");
		}
		const snapshot = goalSnapshots(sessionManager).at(-1);
		expect(snapshot?.stateRef).toMatchObject({
			kind: "goal_state_snapshot_ref",
			goalId: state.goal.id,
			stateVersion: state.stateVersion,
		});
		if (!snapshot?.stateRef) throw new Error("expected goal snapshot stateRef");
		const localProtocolOptions = {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		};
		const sidecarContent = await Bun.file(resolveLocalUrlToPath(snapshot.stateRef.path, localProtocolOptions)).text();
		expect(Bun.hash(sidecarContent).toString(16)).toBe(snapshot.stateRef.hash);
		expect(new Blob([sidecarContent]).size).toBe(snapshot.stateRef.bytes);
		const sidecarState = JSON.parse(sidecarContent);
		expect(sidecarState.goal.id).toBe(state.goal.id);
		const projections = sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === GOAL_PROOF_GRAPH_CUSTOM_TYPE);
		expect(projections).toHaveLength(1);
		const projectionEntry = projections.at(-1);
		if (projectionEntry?.type !== "custom") {
			throw new Error("expected proof graph projection entry");
		}
		const projection = projectionEntry.data;
		if (!projection || typeof projection !== "object" || Array.isArray(projection)) {
			throw new Error("expected proof graph projection custom entry");
		}
		const projectionRecord: Record<string, unknown> = projection as Record<string, unknown>;
		expect(projectionRecord.goalId).toBe(state.goal.id);
		expect(projectionRecord.contentHash).toEqual(expect.any(String));
		expect(projectionRecord.refOwners).toEqual([]);
		const context = sessionManager.buildSessionContext();
		expect(JSON.stringify(context.messages)).not.toContain(GOAL_CONTEXT_METRIC_CUSTOM_TYPE);
		expect(JSON.stringify(context.messages)).not.toContain(GOAL_PROOF_GRAPH_CUSTOM_TYPE);
		expect(JSON.stringify(context.messages)).not.toContain("Measure goal metrics without prompt bloat");
	});

	it("emits approval contract and compaction preserve metrics after execution context reset", async () => {
		const state = await session.goalRuntime.createGoal({ objective: "Measure approval metrics" });
		const planUrl = "local://approved-plan.md";
		const payloadUrl = "local://approved-plan.payload.json";
		const localProtocolOptions = {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		};
		await Bun.write(resolveLocalUrlToPath(planUrl, localProtocolOptions), "# Approved plan\n\nExecute bounded work.");
		await Bun.write(resolveLocalUrlToPath(payloadUrl, localProtocolOptions), JSON.stringify({ ok: true }));

		const prompt = await session.prepareGoalTargetPlanExecutionContext({
			goalId: state.goal.id,
			targetId: "target-approval",
			targetPlanId: "plan-approval",
			planFilePath: planUrl,
			payloadFilePath: payloadUrl,
			title: "Measure approval metrics",
			revision: 1,
			stateVersionAtApproval: state.stateVersion,
			parentFrameVersionAtApproval: state.parentFrameVersion,
		});
		expect(prompt).toContain("<approved_target_execution_contract>");
		expect(prompt).toContain('"targetId": "target-approval"');
		expect(prompt).not.toContain("<approved_target_plan_markdown");
		expect(prompt).not.toContain("Execute bounded work.");

		const metrics = goalMetrics(sessionManager);
		expect(metrics.some(metric => metric.kind === "approved_plan_contract")).toBe(true);
		expect(metrics.some(metric => metric.kind === "compaction_preserve")).toBe(true);
		const compactionEntry = sessionManager.getEntries().findLast(entry => entry.type === "compaction");
		expect(compactionEntry?.preserveData?.goalMode).toBeUndefined();
		expect(compactionEntry?.preserveData?.goalStateRef).toMatchObject({
			goalId: state.goal.id,
			stateVersion: state.stateVersion,
		});
		expect(compactionEntry?.preserveData?.goalRoutingCapsule).toMatchObject({
			goalId: state.goal.id,
			stateVersion: state.stateVersion,
			nextAction: "Resume the same open target.",
		});
		const compactionMetric = metrics.filter(metric => metric.kind === "compaction_preserve").at(-1);
		expect(compactionMetric?.counts.hasGoalStateRef).toBe(1);
		expect(compactionMetric?.counts.hasGoalRoutingCapsule).toBe(1);
		expect(compactionMetric?.counts.hasGoalMode).toBe(0);
		expect(metrics.filter(metric => metric.kind === "compaction_preserve").at(-1)?.targetPlanId).toBeUndefined();
		expect(JSON.stringify(sessionManager.buildSessionContext().messages)).not.toContain(
			GOAL_CONTEXT_METRIC_CUSTOM_TYPE,
		);
	});

	it("rejects compaction preserve data when the goal state ref sidecar hash drifts", async () => {
		const state = await session.goalRuntime.createGoal({ objective: "Reject corrupt goal ref" });
		const planUrl = "local://corrupt-plan.md";
		const payloadUrl = "local://corrupt-plan.payload.json";
		const localProtocolOptions = {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		};
		await Bun.write(resolveLocalUrlToPath(planUrl, localProtocolOptions), "# Corrupt plan\n\nExecute bounded work.");
		await Bun.write(resolveLocalUrlToPath(payloadUrl, localProtocolOptions), JSON.stringify({ ok: true }));
		type BunWriteOptions = Parameters<typeof Bun.write>[2];
		const originalWrite = Bun.write.bind(Bun) as (
			destination: string,
			input: string,
			options?: BunWriteOptions,
		) => Promise<number>;
		vi.spyOn(Bun, "write").mockImplementation(async (destination, input, options) => {
			if (typeof destination !== "string" || typeof input !== "string") {
				throw new Error("expected string sidecar write");
			}
			const result = await originalWrite(destination, input, options);
			if (destination.includes("goal-state-snapshots")) {
				await originalWrite(destination, `${input}\ncorrupt`, options);
			}
			return result;
		});

		await expect(
			session.prepareGoalTargetPlanExecutionContext({
				goalId: state.goal.id,
				targetId: "target-corrupt",
				targetPlanId: "plan-corrupt",
				planFilePath: planUrl,
				payloadFilePath: payloadUrl,
				title: "Reject corrupt goal ref",
				revision: 1,
				stateVersionAtApproval: state.stateVersion,
				parentFrameVersionAtApproval: state.parentFrameVersion,
			}),
		).rejects.toThrow("goalStateRef.hash:mismatch");
	});

	it("emits checkpoint packet metrics from the AgentSession checkpoint flow", async () => {
		installCheckpointReviewerMock();
		const state = await session.goalRuntime.createGoal({ objective: "Measure checkpoint metrics" });

		await session.requestGoalCheckpoint({
			status: "closed_with_evidence",
			summary: "Retrospective target closed",
			localClaims: ["Retrospective claim"],
			evidence: [{ claim: "Retrospective claim", evidence: "Focused checkpoint evidence", current: true }],
			checksRun: ["bun test focused"],
			artifactsTouched: ["src/checkpoint.ts"],
			notClaimed: ["Parent complete"],
			remainingQuestions: ["Next checkpoint"],
			risksOrCaveats: ["Bounded claim"],
			staleIf: ["Code changes"],
			suggestedControllerQuestions: [],
			retrospectiveTarget: {
				title: "Close retrospective metric target",
				desiredFutureClaim: "Retrospective claim",
				closureStandard: "Focused evidence closes the target.",
				expectedParentContribution: "Retrospective closure contributes bounded evidence.",
				baselineRefs: [],
				gateRefs: [],
				evidenceExpectation: ["Focused checkpoint evidence"],
				nonGoals: [],
				forbiddenClaims: ["Parent complete"],
				staleIf: ["Code changes"],
			},
		});

		const checkpointMetric = goalMetrics(sessionManager).find(metric => metric.kind === "checkpoint_packet");
		expect(checkpointMetric).toMatchObject({
			goalId: state.goal.id,
			targetId: `${state.goal.id}-target-1`,
			counts: { evidenceItems: 1, checksRun: 1 },
		});
		expect(JSON.stringify(checkpointMetric)).not.toContain("Focused checkpoint evidence");
		expect(JSON.stringify(sessionManager.buildSessionContext().messages)).not.toContain(
			GOAL_CONTEXT_METRIC_CUSTOM_TYPE,
		);
	});
});
