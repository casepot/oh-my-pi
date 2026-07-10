import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { JobTool } from "@oh-my-pi/pi-coding-agent/tools/job";

describe("AsyncJobManager", () => {
	test("forwards progress updates and delivers completion", async () => {
		const progressEvents: Array<{ text: string; details?: Record<string, unknown> }> = [];
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, payload) => {
				completions.push({ jobId, text: payload.text });
			},
		});

		const jobId = manager.register(
			"bash",
			"echo hi",
			async ({ reportProgress }) => {
				await reportProgress("running step", { async: { state: "running" } });
				return "final output";
			},
			{
				onProgress: async (text, details) => {
					progressEvents.push({ text, details });
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(progressEvents).toEqual([{ text: "running step", details: { async: { state: "running" } } }]);
		expect(completions).toEqual([{ jobId, text: "final output" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
		expect(manager.getJob(jobId)?.resultText).toBe("final output");
		expect(manager.getJob(jobId)?.result).toEqual({ kind: "text", text: "final output" });
		expect(manager.getJob(jobId)?.taskStatus).toBeUndefined();
	});

	test("preserves an exact task result through waiting, storage, polling, and delivery", async () => {
		const delivered: unknown[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (_jobId, payload) => {
				delivered.push(payload);
			},
		});
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const singleResult: SingleResult = {
			index: 0,
			id: "PausedAgent",
			agent: "task",
			agentSource: "bundled",
			task: "inspect the stalled work",
			exitCode: 0,
			output: "Checkpoint preserved.",
			stderr: "",
			truncated: false,
			durationMs: 1_234,
			tokens: 55,
			requests: 3,
			termination: {
				status: "paused",
				code: "no_progress",
				reason: "No measurable progress after three cycles.",
				resumable: true,
				historyUri: "history://PausedAgent",
				outputUri: "agent://PausedAgent",
				policy: {
					request: { termination: "disabled", advisory: { mode: "advisory", afterAssistantTurns: 12 } },
					wallClock: { maxRuntimeMs: 90_000 },
					stall: { action: "pause", afterAssistantTurns: 3 },
					spawn: { remainingDepth: null },
					idle: { resumable: true, parkingTtlMs: null },
				},
			},
		};
		const taskPayload = {
			kind: "task" as const,
			text: "<task-result>Checkpoint preserved.</task-result>",
			result: singleResult,
		};
		const jobId = manager.register(
			"task",
			"PausedAgent",
			async ({ markRunning }) => {
				await gate.promise;
				markRunning();
				started.resolve();
				await release.promise;
				return taskPayload;
			},
			{ id: "PausedAgent", queued: true },
		);
		const tool = new JobTool({
			asyncJobManager: manager,
			settings: { get: () => "5s" },
			getAgentId: () => null,
		} as unknown as ToolSession);

		const waiting = await tool.execute("waiting", { list: true });
		expect(waiting.details?.jobs).toMatchObject([{ id: jobId, status: "waiting", schedulerStatus: "running" }]);

		gate.resolve();
		await started.promise;
		const running = await tool.execute("running", { list: true });
		expect(running.details?.jobs).toMatchObject([{ id: jobId, status: "running", schedulerStatus: "running" }]);

		release.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });
		const polled = await tool.execute("paused", { poll: [jobId] });
		const snapshot = polled.details?.jobs[0];
		expect(snapshot).toMatchObject({
			id: jobId,
			status: "paused",
			schedulerStatus: "completed",
			result: taskPayload,
		});
		expect(snapshot?.result).toBe(taskPayload);
		expect(snapshot?.result?.kind === "task" ? snapshot.result.result.termination : undefined).toEqual(
			singleResult.termination,
		);
		const pollText = polled.content.find(part => part.type === "text")?.text ?? "";
		expect(pollText.match(/No measurable progress after three cycles\./g)).toHaveLength(1);
		expect(manager.getJob(jobId)?.result).toBe(taskPayload);
		expect(manager.getJob(jobId)?.taskStatus).toBe("paused");
		expect(delivered).toEqual([taskPayload]);
		expect(delivered[0]).toBe(taskPayload);
	});

	test("keeps text-only task registrations on the legacy text path", async () => {
		const deliveries: unknown[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (_jobId, payload) => {
				deliveries.push(payload);
			},
		});

		const jobId = manager.register("task", "/tan inspect", async () => "tan assistant text");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)).toMatchObject({
			type: "task",
			status: "completed",
			resultText: "tan assistant text",
			result: { kind: "text", text: "tan assistant text" },
		});
		expect(manager.getJob(jobId)?.taskStatus).toBeUndefined();
		expect(deliveries).toEqual([{ kind: "text", text: "tan assistant text" }]);
	});

	test("keeps completed, failed, aborted, and paused task terminations distinct from scheduler state", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const terminations: SingleResult["termination"][] = [
			{
				status: "completed",
				code: "yielded",
				reason: "Work yielded.",
				resumable: false,
				historyUri: "history://CompletedAgent",
				outputUri: "agent://CompletedAgent",
				policy: {
					request: { termination: "disabled", advisory: { mode: "off", afterAssistantTurns: null } },
					wallClock: { maxRuntimeMs: null },
					stall: { action: "off", afterAssistantTurns: null },
					spawn: { remainingDepth: null },
					idle: { resumable: true, parkingTtlMs: null },
				},
			},
			{
				status: "failed",
				code: "execution_error",
				reason: "Provider request failed.",
				resumable: false,
				historyUri: "history://FailedAgent",
				outputUri: "agent://FailedAgent",
				policy: {
					request: { termination: "disabled", advisory: { mode: "off", afterAssistantTurns: null } },
					wallClock: { maxRuntimeMs: null },
					stall: { action: "off", afterAssistantTurns: null },
					spawn: { remainingDepth: null },
					idle: { resumable: true, parkingTtlMs: null },
				},
			},
			{
				status: "aborted",
				code: "caller_cancelled",
				reason: "Cancelled by caller.",
				resumable: false,
				historyUri: "history://AbortedAgent",
				outputUri: "agent://AbortedAgent",
				policy: {
					request: { termination: "disabled", advisory: { mode: "off", afterAssistantTurns: null } },
					wallClock: { maxRuntimeMs: null },
					stall: { action: "off", afterAssistantTurns: null },
					spawn: { remainingDepth: null },
					idle: { resumable: true, parkingTtlMs: null },
				},
			},
			{
				status: "paused",
				code: "no_progress",
				reason: "No measurable progress.",
				resumable: true,
				historyUri: "history://PausedAgent",
				outputUri: "agent://PausedAgent",
				policy: {
					request: { termination: "disabled", advisory: { mode: "off", afterAssistantTurns: null } },
					wallClock: { maxRuntimeMs: null },
					stall: { action: "pause", afterAssistantTurns: 3 },
					spawn: { remainingDepth: null },
					idle: { resumable: true, parkingTtlMs: null },
				},
			},
		];

		for (const [index, termination] of terminations.entries()) {
			const id = `${termination.status}-agent`;
			const result: SingleResult = {
				index,
				id,
				agent: "task",
				agentSource: "bundled",
				task: `${termination.status} task`,
				exitCode: termination.status === "failed" ? 1 : 0,
				output: `${termination.status} output`,
				stderr: "",
				truncated: false,
				durationMs: 10,
				tokens: 1,
				requests: 1,
				termination,
			};
			manager.register("task", id, async () => ({ kind: "task", text: result.output, result }), { id });
		}
		await manager.waitForAll();

		const tool = new JobTool({
			asyncJobManager: manager,
			settings: { get: () => "5s" },
			getAgentId: () => null,
		} as unknown as ToolSession);
		const listed = await tool.execute("all-statuses", { list: true });
		expect(listed.details?.jobs.map(job => ({ status: job.status, schedulerStatus: job.schedulerStatus }))).toEqual([
			{ status: "completed", schedulerStatus: "completed" },
			{ status: "failed", schedulerStatus: "completed" },
			{ status: "aborted", schedulerStatus: "completed" },
			{ status: "paused", schedulerStatus: "completed" },
		]);
	});

	test("swallows progress callback errors without failing the job", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, payload) => {
				completions.push({ jobId, text: payload.text });
			},
		});

		const jobId = manager.register(
			"task",
			"agent task",
			async ({ reportProgress }) => {
				await reportProgress("subagent started");
				return "task done";
			},
			{
				onProgress: async () => {
					throw new Error("progress renderer exploded");
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "task done" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("delivers error text when run fails", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, payload) => {
				completions.push({ jobId, text: payload.text });
			},
		});

		const jobId = manager.register("bash", "bad command", async () => {
			throw new Error("command failed");
		});

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "command failed" }]);
		expect(manager.getJob(jobId)?.status).toBe("failed");
		expect(manager.getJob(jobId)?.errorText).toBe("command failed");
	});

	test("cancels a running job by id", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, payload) => {
				completions.push({ jobId, text: payload.text });
			},
		});

		const jobId = manager.register("bash", "sleep", async ({ signal }) => {
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
			throw new Error("unreachable");
		});

		expect(manager.cancel(jobId)).toBe(true);
		expect(manager.cancel(jobId)).toBe(false);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("cancelled");
		expect(completions).toHaveLength(0);
	});

	test("enforces maxRunningJobs cap", () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const firstJobId = manager.register("bash", "first", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		expect(() =>
			manager.register("bash", "second", async () => {
				return "second";
			}),
		).toThrow(/Background job limit reached/);

		manager.cancel(firstJobId);
	});

	test("queued jobs do not count toward the cap until markRunning", async () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const queuedJobId = manager.register(
			"task",
			"queued",
			async ({ markRunning }) => {
				await gate.promise;
				markRunning();
				started.resolve();
				await release.promise;
				return "queued done";
			},
			{ queued: true },
		);

		// Queued job holds no slot: another job registers fine at cap 1.
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		// Free the slot, then let the queued job start: it now occupies the slot.
		manager.cancel(runningJobId);
		gate.resolve();
		await started.promise;
		expect(() => manager.register("bash", "third", async () => "third")).toThrow(/Background job limit reached/);

		release.resolve();
		await manager.waitForAll();
		expect(manager.getJob(queuedJobId)?.status).toBe("completed");
	});

	test("evicts completed jobs after retention period", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 25,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("task", "short", async () => "done");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("completed");
		await Bun.sleep(60);
		expect(manager.getJob(jobId)).toBeUndefined();
	});

	test("cancelAll does not clear retention timers for already completed jobs", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 30,
			onJobComplete: async () => {},
		});

		const completedJobId = manager.register("task", "completed", async () => "done");
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			throw new Error("aborted");
		});

		const completedDeadline = Date.now() + 2_000;
		while (manager.getJob(completedJobId)?.status === "running") {
			if (Date.now() >= completedDeadline) throw new Error("Timed out waiting for completed job");
			await Bun.sleep(5);
		}
		manager.cancelAll();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(completedJobId)?.status).toBe("completed");
		expect(manager.getJob(runningJobId)?.status).toBe("cancelled");

		await Bun.sleep(80);
		expect(manager.getJob(completedJobId)).toBeUndefined();
		expect(manager.getJob(runningJobId)).toBeUndefined();
	});

	test("acknowledgeDeliveries suppresses pending retries for completed jobs", async () => {
		let attempts = 0;
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				attempts += 1;
				throw new Error("delivery failed");
			},
		});

		const jobId = manager.register("task", "awaited-job", async () => "done");
		await manager.waitForAll();

		const firstAttemptDeadline = Date.now() + 2_000;
		while (attempts === 0) {
			if (Date.now() >= firstAttemptDeadline) throw new Error("Timed out waiting for first delivery attempt");
			await Bun.sleep(5);
		}

		expect(manager.hasPendingDeliveries()).toBe(true);
		const removed = manager.acknowledgeDeliveries([jobId]);
		expect(removed).toBeGreaterThanOrEqual(1);

		const drained = await manager.drainDeliveries({ timeoutMs: 200 });
		expect(drained).toBe(true);
		expect(manager.hasPendingDeliveries()).toBe(false);

		const attemptsAfterAck = attempts;
		await Bun.sleep(700);
		expect(attempts).toBe(attemptsAfterAck);
	});

	test("dispose clears jobs and pending deliveries", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				throw new Error("delivery failed");
			},
		});

		manager.register("bash", "will-complete", async () => "output");
		await manager.waitForAll();
		expect(manager.hasPendingDeliveries()).toBe(true);

		const drained = await manager.dispose({ timeoutMs: 25 });
		expect(drained).toBe(false);
		expect(manager.getAllJobs()).toHaveLength(0);
		expect(manager.hasPendingDeliveries()).toBe(false);
	});

	test("dispose honors timeout when a cancelled job never settles", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		manager.register("bash", "ignores-abort", async () => {
			await Promise.withResolvers<never>().promise;
			return "unreachable";
		});

		const startedAt = Date.now();
		const result = await Promise.race([
			manager.dispose({ timeoutMs: 25 }).then(drained => ({ drained, settled: true })),
			Bun.sleep(150).then(() => ({ drained: true, settled: false })),
		]);

		expect(result.settled).toBe(true);
		expect(result.drained).toBe(false);
		expect(Date.now() - startedAt).toBeLessThan(150);
		expect(manager.getAllJobs()).toHaveLength(0);
	});

	test("scoped delivery drain returns once matching owner deliveries finish", async () => {
		let mainJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const subagentCompletions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async (jobId, payload) => {
				if (jobId === mainJobId) {
					notifyMainDeliveryStarted();
					await mainDeliveryReleased;
					return;
				}
				subagentCompletions.push({ jobId, text: payload.text });
			},
		});

		mainJobId = manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		const targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(true);
		const drained = await manager.drainDeliveries({ timeoutMs: 50, filter: { ownerId: "3-AuthLoader" } });

		expect(drained).toBe(true);
		expect(subagentCompletions).toEqual([{ jobId: targetJobId, text: "subagent result" }]);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(false);

		expect(manager.acknowledgeDeliveries([mainJobId])).toBe(0);
		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(false);
		releaseMainDelivery();
		await Bun.sleep(0);
	});

	test("scoped delivery drain times out while a matching delivery callback is in flight", async () => {
		let mainJobId = "";
		let targetJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		let releaseTargetDelivery = (): void => {};
		let notifyTargetDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const targetDeliveryStarted = new Promise<void>(resolve => {
			notifyTargetDeliveryStarted = resolve;
		});
		const targetDeliveryReleased = new Promise<void>(resolve => {
			releaseTargetDelivery = resolve;
		});
		const completions: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				if (jobId === mainJobId) {
					notifyMainDeliveryStarted();
					await mainDeliveryReleased;
					return;
				}
				if (jobId === targetJobId) {
					notifyTargetDeliveryStarted();
					await targetDeliveryReleased;
					completions.push(jobId);
				}
			},
		});

		mainJobId = manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		const timedOut = await manager.drainDeliveries({ timeoutMs: 10, filter: { ownerId: "3-AuthLoader" } });
		await targetDeliveryStarted;

		expect(timedOut).toBe(false);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(true);
		expect(completions).toEqual([]);

		releaseTargetDelivery();
		const drained = await manager.drainDeliveries({ timeoutMs: 200, filter: { ownerId: "3-AuthLoader" } });
		expect(drained).toBe(true);
		expect(completions).toEqual([targetJobId]);

		releaseMainDelivery();
		expect(await manager.drainDeliveries({ timeoutMs: 200 })).toBe(true);
	});

	test("cancelAll with ownerId only cancels matching jobs", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		const hold = (signal: AbortSignal) =>
			new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});

		const parentJobId = manager.register(
			"bash",
			"parent-job",
			async ({ signal }) => {
				await hold(signal);
				return "parent-cancelled";
			},
			{ ownerId: "0-Main" },
		);
		const subagentJobId = manager.register(
			"bash",
			"subagent-job",
			async ({ signal }) => {
				await hold(signal);
				return "subagent-cancelled";
			},
			{ ownerId: "3-AuthLoader" },
		);

		manager.cancelAll({ ownerId: "3-AuthLoader" });

		expect(manager.getJob(parentJobId)?.status).toBe("running");
		expect(manager.getJob(subagentJobId)?.status).toBe("cancelled");

		// Filtered query mirrors filtered cancel.
		expect(manager.getRunningJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);
		expect(manager.getRunningJobs({ ownerId: "3-AuthLoader" })).toEqual([]);
		expect(manager.getAllJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);

		// Unscoped cancelAll still cleans up everything.
		manager.cancelAll();
		await manager.waitForAll();
		expect(manager.getJob(parentJobId)?.status).toBe("cancelled");
	});
});

describe("AsyncJobManager smart poll-wait escalation", () => {
	const newManager = () => new AsyncJobManager({ onJobComplete: async () => {} });

	test("first poll waits the ladder floor", () => {
		const m = newManager();
		expect(m.nextPollWaitMs("Main", 1_000)).toBe(5_000);
		// A fresh owner also starts at the floor.
		expect(m.nextPollWaitMs("Other", 1_000)).toBe(5_000);
	});

	test("back-to-back polls climb the ladder to the top rung", () => {
		const m = newManager();
		const owner = "Main";
		const t = 1_000;
		const waits: number[] = [];
		for (let i = 0; i < 6; i++) {
			// Same timestamp every time → zero gap → always escalates.
			waits.push(m.nextPollWaitMs(owner, t));
			m.recordPollWaitEnd(owner, t);
		}
		// Climbs the rungs, then saturates at the top.
		expect(waits).toEqual([5_000, 10_000, 30_000, 60_000, 300_000, 300_000]);
	});

	test("a quiet gap of a minute resets back to the floor", () => {
		const m = newManager();
		const owner = "Main";

		expect(m.nextPollWaitMs(owner, 0)).toBe(5_000);
		m.recordPollWaitEnd(owner, 0);

		// Still within the reset window (just under a minute) → keeps climbing.
		expect(m.nextPollWaitMs(owner, 59_999)).toBe(10_000);
		m.recordPollWaitEnd(owner, 60_000);

		// A full minute without polling resets the climb to the floor.
		expect(m.nextPollWaitMs(owner, 120_000)).toBe(5_000);
	});

	test("escalation is tracked independently per owner", () => {
		const m = newManager();
		const t = 1_000;

		m.nextPollWaitMs("A", t);
		m.recordPollWaitEnd("A", t);
		m.nextPollWaitMs("A", t);
		m.recordPollWaitEnd("A", t);

		// A fresh owner starts at the floor regardless of A's escalation.
		expect(m.nextPollWaitMs("B", t)).toBe(5_000);
		// A keeps climbing from where it left off.
		expect(m.nextPollWaitMs("A", t)).toBe(30_000);
	});
});
