import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AsyncJob, type AsyncJobDeliveryPayload, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { YieldQueue } from "@oh-my-pi/pi-coding-agent/session/yield-queue";
import type { SingleResult, SubagentTermination } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { JobTool } from "@oh-my-pi/pi-coding-agent/tools/job";

type AsyncEntry = {
	jobId: string;
	result: string;
	termination?: SubagentTermination;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
};

type AsyncDetails = {
	jobs: Array<{
		jobId: string;
		type?: "bash" | "task";
		label?: string;
		termination?: SubagentTermination;
		durationMs?: number;
	}>;
};

function buildAsyncMessage(entries: AsyncEntry[]): CustomMessage<AsyncDetails> | null {
	if (entries.length === 0) return null;
	return {
		role: "custom",
		customType: "async-result",
		content: entries.map(entry => entry.result).join("\n"),
		display: true,
		attribution: "agent",
		details: {
			jobs: entries.map(entry => ({
				jobId: entry.jobId,
				type: entry.job?.type,
				label: entry.job?.label,
				termination: entry.termination,
				durationMs: entry.durationMs,
			})),
		},
		timestamp: 0,
	};
}

function asyncDetails(message: AgentMessage): AsyncDetails {
	if (message.role !== "custom") throw new Error(`Expected custom message, got ${message.role}`);
	return (message as CustomMessage<AsyncDetails>).details ?? { jobs: [] };
}

function createToolSession(asyncJobManager?: AsyncJobManager): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: {
			get: (key: string) => (key === "async.pollWaitDuration" ? "5s" : undefined),
		},
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getAgentId: () => null,
		asyncJobManager,
	} as unknown as ToolSession;
}

function termination(id: string, status: SubagentTermination["status"]): SubagentTermination {
	return {
		status,
		code: status === "paused" ? "no_progress" : "yielded",
		reason: status === "paused" ? "Paused after three no-progress cycles" : "Yielded structured result",
		resumable: status === "paused",
		historyUri: `history://${id}`,
		outputUri: `agent://${id}`,
		policy: {
			request: { termination: "disabled", advisory: { mode: "advisory", afterAssistantTurns: 24 } },
			wallClock: { maxRuntimeMs: null },
			stall: { action: "pause", afterAssistantTurns: 3 },
			spawn: { remainingDepth: null },
			idle: { resumable: true, parkingTtlMs: null },
		},
	};
}

function taskResult(id: string, settled: SubagentTermination): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Do the thing.",
		exitCode: settled.status === "completed" ? 0 : 1,
		output: "structured task result",
		stderr: "",
		truncated: false,
		durationMs: 10,
		tokens: 1,
		requests: 1,
		termination: settled,
	};
}

function createHarness(initialStreaming: boolean) {
	let streaming = initialStreaming;
	const followUps: AgentMessage[] = [];
	const prompts: AgentMessage[][] = [];
	const scheduledFlushes: Array<() => Promise<void>> = [];
	const queue = new YieldQueue({
		isStreaming: () => streaming,
		injectStreaming: message => {
			followUps.push(message);
		},
		injectIdle: async messages => {
			prompts.push(messages);
		},
		scheduleIdleFlush: run => {
			scheduledFlushes.push(run);
		},
	});
	let manager!: AsyncJobManager;
	queue.register<AsyncEntry>("async-result", {
		isStale: entry => manager.isDeliverySuppressed(entry.jobId),
		build: buildAsyncMessage,
	});
	manager = new AsyncJobManager({
		onJobComplete: (jobId, payload: AsyncJobDeliveryPayload, job) => {
			if (manager.isDeliverySuppressed(jobId)) return;
			queue.enqueue<AsyncEntry>("async-result", {
				jobId,
				result: payload.text,
				termination: payload.kind === "task" ? payload.result.termination : undefined,
				job,
				durationMs: job ? Math.max(0, Date.now() - job.startTime) : undefined,
			});
		},
	});
	AsyncJobManager.setInstance(manager);
	return {
		manager,
		queue,
		followUps,
		prompts,
		scheduledFlushes,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
	};
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await Bun.sleep(5);
	}
}

afterEach(async () => {
	const manager = AsyncJobManager.instance();
	if (manager) {
		await manager.dispose({ timeoutMs: 200 });
	}
	AsyncJobManager.resetForTests();
});

describe("async result yield queue delivery", () => {
	test("job poll acknowledgement suppresses already staged completion", async () => {
		const harness = createHarness(true);
		const jobId = harness.manager.register("bash", "race job", async () => "inline result");

		await harness.manager.waitForAll();
		await waitUntil(() => harness.queue.has("async-result"), "Timed out waiting for staged async result");

		const tool = new JobTool(createToolSession(harness.manager));
		const result = await tool.execute("tool-call", { poll: [jobId] });
		expect(result.details?.jobs.find(job => job.id === jobId)?.status).toBe("completed");

		await harness.queue.flush("streaming");

		expect(harness.followUps).toHaveLength(0);
	});

	test("multiple completions in one yield window become one follow-up", async () => {
		const harness = createHarness(true);
		const firstJobId = harness.manager.register("bash", "first", async () => "first result");
		const secondJobId = harness.manager.register("task", "second", async () => "second result");

		await harness.manager.waitForAll();
		expect(await harness.manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);
		await harness.queue.flush("streaming");

		expect(harness.followUps).toHaveLength(1);
		const deliveredIds = asyncDetails(harness.followUps[0]!)
			.jobs.map(job => job.jobId)
			.sort();
		expect(deliveredIds).toEqual([firstJobId, secondJobId].sort());
	});

	test("paused task completion preserves the exact termination through staged delivery", async () => {
		const harness = createHarness(true);
		const settled = termination("PausedWorker", "paused");
		const jobId = harness.manager.register("task", "paused worker", async () => ({
			kind: "task",
			text: '<task-result status="paused">structured task result</task-result>',
			result: taskResult("PausedWorker", settled),
		}));

		await harness.manager.waitForAll();
		expect(await harness.manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);
		await harness.queue.flush("streaming");

		expect(harness.followUps).toHaveLength(1);
		const delivered = asyncDetails(harness.followUps[0]!).jobs.find(job => job.jobId === jobId);
		expect(delivered?.termination).toBe(settled);
		expect(delivered?.termination).toEqual(settled);
		expect(harness.followUps[0]?.role === "custom" ? harness.followUps[0].content : "").toContain('status="paused"');
	});

	test("idle completion prompts once after scheduled idle flush", async () => {
		const harness = createHarness(false);
		const jobId = harness.manager.register("bash", "idle job", async () => "idle result");

		await harness.manager.waitForAll();
		expect(await harness.manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);

		expect(harness.scheduledFlushes).toHaveLength(1);
		expect(harness.prompts).toHaveLength(0);
		await harness.scheduledFlushes[0]!();

		expect(harness.prompts).toHaveLength(1);
		expect(harness.prompts[0]).toHaveLength(1);
		expect(asyncDetails(harness.prompts[0]![0]!).jobs.map(job => job.jobId)).toEqual([jobId]);
	});
});
