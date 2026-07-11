/**
 * Contracts: task tool spawn routing (rework-contracts.md §3).
 *
 * 1. With an AsyncJobManager wired, `execute` returns immediately (agent id +
 *    job id) while the job body is still gated; settlement transports the
 *    exact structured termination and model-facing summary.
 * 2. The session-scoped spawn semaphore (task.maxConcurrency) serializes job
 *    bodies: with concurrency 1 the second body does not start until the
 *    first releases.
 *
 * Param validation (missing agent / missing assignment) is covered by
 * test/task/task-schema.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AsyncJob,
	type AsyncJobDeliveryPayload,
	AsyncJobManager,
} from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(options: {
	manager?: AsyncJobManager;
	settings?: Record<string, unknown>;
	recordAgentRef?: ToolSession["recordAgentRef"];
}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		asyncJobManager: options.manager,
		recordAgentRef: options.recordAgentRef,
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		termination: {
			status: "completed",
			code: "yielded",
			reason: "Yielded structured result",
			resumable: true,
			historyUri: `history://${id}`,
			outputUri: `agent://${id}`,
			policy: {
				request: { termination: "disabled", advisory: { mode: "off", afterAssistantTurns: null } },
				wallClock: { maxRuntimeMs: null },
				stall: { action: "pause", afterAssistantTurns: 10 },
				spawn: { remainingDepth: null },
				idle: { resumable: true, parkingTtlMs: null },
			},
		},
		...overrides,
	};
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
		await Bun.sleep(5);
	}
}

describe("task spawn routing", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("returns immediately and delivers the exact structured termination when the job settles", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const gate = deferred();
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await gate.promise;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));

		const result = await tool.execute("tc-spawn", {
			agent: "task",
			id: "Spawnling",
			description: "background work",
			assignment: "Do the thing.",
		} as TaskParams);

		// Tool returned while the job body is still gated on the deferred.
		const text = getFirstText(result);
		expect(text).toContain("Spawned agent `Spawnling`");
		const jobId = result.details?.async?.jobId;
		expect(jobId).toBeTruthy();
		expect(text).toContain(`job \`${jobId}\``);
		expect(result.details?.async?.state).toBe("waiting");
		expect(result.details?.effectivePolicies?.Spawnling).toEqual({
			request: { termination: "disabled", advisory: { mode: "off", afterAssistantTurns: null } },
			wallClock: { maxRuntimeMs: null },
			stall: { action: "pause", afterAssistantTurns: 10 },
			spawn: { remainingDepth: 1 },
			idle: { resumable: true, parkingTtlMs: 420_000 },
		});
		expect(text).toContain("Applied policy: request termination disabled");
		const job = manager.getJob(jobId!);
		expect(job?.status).toBe("running");
		expect(job?.resultText).toBeUndefined();

		gate.resolve();
		await job!.promise;

		expect(job!.status).toBe("completed");
		expect(job!.resultText).toBeUndefined();
		expect(job!.result?.kind).toBe("task");
		if (job!.result?.kind !== "task") throw new Error("Expected structured task result");
		expect(job!.result.result.termination).toEqual({
			status: "completed",
			code: "yielded",
			reason: "Yielded structured result",
			resumable: true,
			historyUri: "history://Spawnling",
			outputUri: "agent://Spawnling",
			policy: {
				request: { termination: "disabled", advisory: { mode: "off", afterAssistantTurns: null } },
				wallClock: { maxRuntimeMs: null },
				stall: { action: "pause", afterAssistantTurns: 10 },
				spawn: { remainingDepth: null },
				idle: { resumable: true, parkingTtlMs: null },
			},
		});
		expect(job!.result.text).toContain("<termination>");
		expect(job!.result.text).toContain('"historyUri":"history://Spawnling"');
		expect(job!.result.text).toContain('"outputUri":"agent://Spawnling"');
		expect(job!.result.text).not.toContain("<retry-failure>");
		expect(runSpy).toHaveBeenCalledTimes(1);
	});

	it("surfaces retry continuation failure separately in synchronous and asynchronous results", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const providerError = "503 server error";
		const continuationError = "Retry continuation failed: Cannot continue from message role: assistant";
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "RetryFailure";
			return makeResult(id, {
				exitCode: 1,
				output: providerError,
				stderr: providerError,
				error: providerError,
				retryFailure: {
					attempt: 2,
					errorMessage: `${providerError}\n${continuationError}`,
				},
				termination: {
					status: "failed",
					code: "provider_error",
					reason: providerError,
					resumable: true,
					historyUri: `history://${id}`,
					outputUri: `agent://${id}`,
					policy: {
						request: { termination: "disabled", advisory: { mode: "off", afterAssistantTurns: null } },
						wallClock: { maxRuntimeMs: null },
						stall: { action: "pause", afterAssistantTurns: 10 },
						spawn: { remainingDepth: null },
						idle: { resumable: true, parkingTtlMs: null },
					},
				},
			});
		});

		const syncTool = await TaskTool.create(createSession({ settings: { "async.enabled": false } }));
		const sync = await syncTool.execute("tc-retry-failure-sync", {
			agent: "task",
			id: "RetryFailureSync",
			assignment: "Report a failed retry.",
		} as TaskParams);
		const syncText = getFirstText(sync);
		expect(sync.details?.results[0]?.termination.reason).toBe(providerError);
		expect(sync.details?.results[0]?.retryFailure?.errorMessage).toContain(continuationError);
		expect(syncText).toContain(
			`<termination>\n${JSON.stringify(sync.details?.results[0]?.termination)}\n</termination>`,
		);
		expect(syncText).toContain("<retry-failure>");
		expect(syncText).toContain(continuationError);

		const deliveries: AsyncJobDeliveryPayload[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: (_jobId, payload) => {
				deliveries.push(payload);
			},
		});
		managers.push(manager);
		const asyncTool = await TaskTool.create(createSession({ manager, settings: { "async.enabled": true } }));
		const started = await asyncTool.execute("tc-retry-failure-async", {
			agent: "task",
			id: "RetryFailureAsync",
			assignment: "Report a failed retry.",
		} as TaskParams);
		const job = manager.getJob(started.details?.async?.jobId ?? "");
		await job?.promise;
		await manager.drainDeliveries({ timeoutMs: 1000 });
		expect(job?.result?.kind).toBe("task");
		if (job?.result?.kind !== "task") throw new Error("Expected structured task result");
		expect(job.result.result.termination.reason).toBe(providerError);
		expect(job.result.result.retryFailure?.errorMessage).toContain(continuationError);
		expect(job.result.text).toContain("<retry-failure>");
		expect(job.result.text).toContain(continuationError);
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.text).toContain(continuationError);
	});

	it("preserves the same paused termination through synchronous and asynchronous paths", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const termination = {
			status: "paused",
			code: "no_progress",
			reason: "Paused after three no-progress cycles",
			resumable: true,
			historyUri: "history://PausedWorker",
			outputUri: "agent://PausedWorker",
			policy: {
				request: { termination: "disabled", advisory: { mode: "advisory", afterAssistantTurns: 24 } },
				wallClock: { maxRuntimeMs: null },
				stall: { action: "pause", afterAssistantTurns: 3 },
				spawn: { remainingDepth: null },
				idle: { resumable: true, parkingTtlMs: null },
			},
		} as const;
		const pausedResult = makeResult("PausedWorker", {
			exitCode: 0,
			output: termination.reason,
			termination,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(pausedResult);

		const syncTool = await TaskTool.create(createSession({ settings: { "async.enabled": false } }));
		const sync = await syncTool.execute("tc-paused-sync", {
			agent: "task",
			id: "PausedWorker",
			assignment: "Pause after no progress.",
		} as TaskParams);
		expect(sync.details?.results[0]?.termination).toBe(termination);
		expect(getFirstText(sync)).toContain('"status":"paused"');
		expect(getFirstText(sync).split(termination.reason)).toHaveLength(2);

		const deliveries: AsyncJobDeliveryPayload[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: (_jobId, payload) => {
				deliveries.push(payload);
			},
		});
		managers.push(manager);
		const asyncTool = await TaskTool.create(createSession({ manager, settings: { "async.enabled": true } }));
		const started = await asyncTool.execute("tc-paused-async", {
			agent: "task",
			id: "PausedWorker",
			assignment: "Pause after no progress.",
		} as TaskParams);
		const job = manager.getJob(started.details?.async?.jobId ?? "");
		if (!job) throw new Error("Expected paused task job");
		await job.promise;
		expect(await manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);

		expect(job.status).toBe("completed");
		expect(job.taskStatus).toBe("paused");
		expect(job.result?.kind).toBe("task");
		if (job.result?.kind !== "task") throw new Error("Expected structured task result");
		expect(job.result.result.termination).toBe(termination);
		expect(deliveries[0]).toBe(job.result);
	});

	it("forwards the session agent-ref persistence hook into subprocess runs", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Persisted"));
		const recordAgentRef: NonNullable<ToolSession["recordAgentRef"]> = () => {};
		const tool = await TaskTool.create(createSession({ recordAgentRef }));

		await tool.execute("tc-persist", {
			agent: "task",
			id: "Persisted",
			assignment: "Do the thing.",
		} as TaskParams);

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy.mock.calls[0]?.[0]?.recordAgentRef).toBe(recordAgentRef);
	});

	it("bounds concurrent job bodies with the session spawn semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", id: "First", assignment: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", id: "Second", assignment: "Work B." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		// First job body reaches the executor; second stays parked at the
		// semaphore — still flagged queued because markRunning never ran.
		await pollUntil(() => started.length >= 1);
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		// Releasing the first body lets the second one start.
		gates.get(started[0]!)!.resolve();
		await firstJob.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Second"]);

		gates.get("Second")!.resolve();
		await secondJob.promise;
		expect(firstJob.status).toBe("completed");
		expect(secondJob.status).toBe("completed");
	});

	it("settles a cancelled spawn while it is queued behind the semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", id: "First", assignment: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", id: "Second", assignment: "Work B." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		await pollUntil(() => started.length === 1);
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		expect(manager.cancel(secondJob.id)).toBe(true);
		const queuedResult = await Promise.race([
			secondJob.promise.then(() => "settled" as const),
			Bun.sleep(75).then(() => "timeout" as const),
		]);

		gates.get("First")!.resolve();
		await firstJob.promise;
		await secondJob.promise;

		expect(queuedResult).toBe("settled");
		expect(started).toEqual(["First"]);
		expect(secondJob.status).toBe("cancelled");
	});

	it("keeps the concurrency cap intact when a queued spawn is cancelled (no permit leak)", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		// A holds the only permit, gated inside the executor.
		const first = await tool.execute("tc-1", { agent: "task", id: "First", assignment: "Work A." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		await pollUntil(() => started.length === 1);

		// B parks at the semaphore, then is cancelled while queued. Its
		// teardown must NOT release a permit it never acquired.
		const second = await tool.execute("tc-2", { agent: "task", id: "Second", assignment: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;
		expect(secondJob.queued).toBe(true);
		expect(manager.cancel(secondJob.id)).toBe(true);
		await secondJob.promise;
		expect(secondJob.status).toBe("cancelled");

		// C must stay parked while A still holds the cap. A phantom release
		// from B's cancellation would admit C here, running 2 bodies at cap 1.
		const third = await tool.execute("tc-3", { agent: "task", id: "Third", assignment: "Work C." } as TaskParams);
		const thirdJob = manager.getJob(third.details!.async!.jobId)!;
		await Bun.sleep(50);
		expect(started).toEqual(["First"]);
		expect(thirdJob.queued).toBe(true);

		// A finishing admits C — the cap still cycles normally.
		gates.get("First")!.resolve();
		await firstJob.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Third"]);

		// D queued behind running C stays serialized: if B's teardown had
		// double-released, two permits would be free and D would start now.
		const fourth = await tool.execute("tc-4", { agent: "task", id: "Fourth", assignment: "Work D." } as TaskParams);
		const fourthJob = manager.getJob(fourth.details!.async!.jobId)!;
		await Bun.sleep(50);
		expect(started).toEqual(["First", "Third"]);
		expect(fourthJob.queued).toBe(true);

		gates.get("Third")!.resolve();
		await thirdJob.promise;
		await pollUntil(() => started.length === 3);
		gates.get("Fourth")!.resolve();
		await fourthJob.promise;

		expect(started).toEqual(["First", "Third", "Fourth"]);
		expect(firstJob.status).toBe("completed");
		expect(thirdJob.status).toBe("completed");
		expect(fourthJob.status).toBe("completed");
	});

	for (const maxConcurrency of [0, 0.5]) {
		it(`runs spawn job bodies unbounded when task.maxConcurrency is ${maxConcurrency}`, async () => {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [taskAgent],
				projectAgentsDir: null,
			});
			const started: string[] = [];
			const gates = new Map<string, Deferred>();
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				const id = options.id ?? "?";
				started.push(id);
				const gate = deferred();
				gates.set(id, gate);
				await gate.promise;
				return makeResult(id);
			});

			const manager = createManager();
			const tool = await TaskTool.create(
				createSession({ manager, settings: { "task.maxConcurrency": maxConcurrency } }),
			);

			const first = await tool.execute("tc-1", { agent: "task", id: "First", assignment: "Work A." } as TaskParams);
			const second = await tool.execute("tc-2", {
				agent: "task",
				id: "Second",
				assignment: "Work B.",
			} as TaskParams);
			const third = await tool.execute("tc-3", { agent: "task", id: "Third", assignment: "Work C." } as TaskParams);

			// All three job bodies clear the spawn semaphore in parallel — none stays queued.
			await pollUntil(() => started.length === 3);
			expect(started.sort()).toEqual(["First", "Second", "Third"]);

			for (const id of ["First", "Second", "Third"]) gates.get(id)!.resolve();
			await Promise.all([
				manager.getJob(first.details!.async!.jobId)!.promise,
				manager.getJob(second.details!.async!.jobId)!.promise,
				manager.getJob(third.details!.async!.jobId)!.promise,
			]);
		});
	}

	it("re-reads task.maxConcurrency on each spawn so a mid-session change applies on the next acquire", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const settings = Settings.isolated({ "task.maxConcurrency": 4 });
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
		} as unknown as ToolSession);

		// Prime the semaphore at the initial high cap.
		const first = await tool.execute("tc-1", { agent: "task", id: "First", assignment: "Work A." } as TaskParams);
		await pollUntil(() => started.length === 1);

		// Tighten the cap mid-session. The next spawn MUST see the new ceiling.
		settings.override("task.maxConcurrency", 1);
		const second = await tool.execute("tc-2", { agent: "task", id: "Second", assignment: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		// First is still running (and holding the only slot under the new cap),
		// so Second is parked at the semaphore — queued, not running.
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		// Releasing First admits Second.
		gates.get("First")!.resolve();
		await manager.getJob(first.details!.async!.jobId)!.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Second"]);

		gates.get("Second")!.resolve();
		await secondJob.promise;
	});

	it("applies a lowered maxConcurrency to work already queued in the semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const settings = Settings.isolated({ "task.maxConcurrency": 4 });
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
		} as unknown as ToolSession);

		const jobs: AsyncJob[] = [];
		for (const id of ["First", "Second", "Third", "Fourth", "Fifth"]) {
			const result = await tool.execute(`tc-${id}`, { agent: "task", id, assignment: `Work ${id}.` } as TaskParams);
			jobs.push(manager.getJob(result.details!.async!.jobId)!);
		}
		const fifthJob = jobs[4]!;

		await pollUntil(() => started.length === 4);
		expect([...started].sort()).toEqual(["First", "Fourth", "Second", "Third"]);
		expect(fifthJob.queued).toBe(true);

		settings.override("task.maxConcurrency", 1);
		gates.get("First")!.resolve();
		await jobs[0]!.promise;
		await Promise.resolve();
		expect([...started].sort()).toEqual(["First", "Fourth", "Second", "Third"]);
		expect(fifthJob.queued).toBe(true);

		for (const id of ["Second", "Third", "Fourth"]) gates.get(id)!.resolve();
		await pollUntil(() => started.length === 5);
		expect([...started].sort()).toEqual(["Fifth", "First", "Fourth", "Second", "Third"]);

		gates.get("Fifth")!.resolve();
		await Promise.all(jobs.map(job => job.promise));
	});

	it("returns an exact policy snapshot for each mixed shared and isolated spawn", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? "?"));
		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: {
					"async.enabled": true,
					"task.batch": true,
					"task.isolation.mode": "auto",
					"task.noProgressCycleLimit": 3,
					"task.maxRecursionDepth": 3,
				},
			}),
		);

		const result = await tool.execute("tc-mixed-policy", {
			agent: "task",
			context: "# Goal\nTest policy transport\n# Constraints\nNone\n# Contract\nReturn results",
			tasks: [
				{ id: "SharedPolicy", assignment: "# Target\nShared\n# Change\nRun\n# Acceptance\nFinish" },
				{
					id: "IsolatedPolicy",
					assignment: "# Target\nIsolated\n# Change\nRun\n# Acceptance\nFinish",
					isolated: true,
				},
			],
		} as TaskParams);

		expect(result.details?.effectivePolicies).toEqual({
			SharedPolicy: {
				request: { termination: "disabled", advisory: { mode: "off", afterAssistantTurns: null } },
				wallClock: { maxRuntimeMs: null },
				stall: { action: "pause", afterAssistantTurns: 3 },
				spawn: { remainingDepth: 2 },
				idle: { resumable: true, parkingTtlMs: 420_000 },
			},
			IsolatedPolicy: {
				request: { termination: "disabled", advisory: { mode: "off", afterAssistantTurns: null } },
				wallClock: { maxRuntimeMs: null },
				stall: { action: "fail", afterAssistantTurns: 3 },
				spawn: { remainingDepth: 2 },
				idle: { resumable: false, parkingTtlMs: null },
			},
		});
		const text = getFirstText(result);
		expect(text).toContain("`SharedPolicy`");
		expect(text).toContain("stall pause/3 turns");
		expect(text).toContain("`IsolatedPolicy`");
		expect(text).toContain("stall fail/3 turns");
	});

	it("surfaces task.maxConcurrency in the tool description so the model can self-throttle", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});

		const defaultTool = await TaskTool.create(createSession({}));
		expect(defaultTool.description).toContain("At most 32 subagents");

		const cappedTool = await TaskTool.create(createSession({ settings: { "task.maxConcurrency": 1 } }));
		expect(cappedTool.description).toContain("At most 1 subagent");
		expect(cappedTool.description).toContain("Concurrency cap");

		const fanoutTool = await TaskTool.create(createSession({ settings: { "task.maxConcurrency": 4 } }));
		expect(fanoutTool.description).toContain("At most 4 subagents");
		const fractionalTool = await TaskTool.create(createSession({ settings: { "task.maxConcurrency": 4.9 } }));
		expect(fractionalTool.description).toContain("At most 4 subagents");

		// `0` = Unlimited in the settings UI; fractional values truncate to 0.
		for (const maxConcurrency of [0, 0.5]) {
			const unboundedTool = await TaskTool.create(
				createSession({ settings: { "task.maxConcurrency": maxConcurrency } }),
			);
			expect(unboundedTool.description).not.toContain("Concurrency cap");
		}
	});

	it("renders the effective child runtime policy from live settings and task depth", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const tool = await TaskTool.create(
			createSession({
				settings: {
					"task.softRequestBudget": 24,
					"task.softRequestBudgetNotice": true,
					"task.maxRuntimeMs": 720_000,
					"task.noProgressCycleLimit": 3,
					"task.maxRecursionDepth": 3,
					"task.agentIdleTtlMs": 420_000,
				},
			}),
		);

		expect(tool.description).toContain(
			"Request policy: No hidden request-count cap; request-count termination disabled; one advisory after 24 completed assistant turns.",
		);
		expect(tool.description).toContain(
			"Runtime policy: OMP wall-clock cap 12m; expiry returns runtime_limit; earlier provider, caller-cancellation, and executor failures still apply.",
		);
		expect(tool.description).toContain(
			"Stall guard: pause after 3 consecutive completed assistant turns without a successful tool result or terminal yield;",
		);
		expect(tool.description).toContain("Descendant spawn depth: 2 further generations.");
		expect(tool.description).toContain("Retention: resumable; park idle or paused sessions after 7m.");
	});
});
