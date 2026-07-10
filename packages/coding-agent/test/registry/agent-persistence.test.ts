import { afterEach, describe, expect, it } from "bun:test";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import {
	AGENT_REF_CUSTOM_TYPE,
	collectLatestPersistedAgentRefs,
	installRegistryStatusSync,
	restorePersistedAgentRefs,
} from "@oh-my-pi/pi-coding-agent/registry/agent-persistence";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

function customEntry(data: unknown, timestamp = "2026-06-24T00:00:00.000Z"): SessionEntry {
	return {
		type: "custom",
		id: `entry-${timestamp}`,
		parentId: null,
		timestamp,
		customType: AGENT_REF_CUSTOM_TYPE,
		data,
	} as SessionEntry;
}

function makeSession(): AgentSession {
	return { dispose: async () => {} } as AgentSession;
}

function makeSubscribableSession(): { session: AgentSession; emit: (event: AgentSessionEvent) => void } {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		dispose: async () => {},
	} as unknown as AgentSession;
	return {
		session,
		emit: event => {
			for (const listener of listeners) listener(event);
		},
	};
}

describe("persisted agent refs", () => {
	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("collects only the latest valid subagent ref per id", () => {
		const records = collectLatestPersistedAgentRefs([
			customEntry({ schemaVersion: 1, id: "Worker", displayName: "old", kind: "sub", status: "running" }),
			customEntry({ schemaVersion: 999, id: "Ignored", displayName: "bad", kind: "sub" }),
			customEntry({ schemaVersion: 1, id: MAIN_AGENT_ID, displayName: "main", kind: "sub" }),
			customEntry(
				{
					schemaVersion: 1,
					id: "Worker",
					displayName: "Reviewer",
					kind: "sub",
					status: "idle",
					sessionFile: "/tmp/worker.jsonl",
					spawns: null,
					updatedAt: 42,
				},
				"2026-06-24T00:00:01.000Z",
			),
		]);

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			id: "Worker",
			displayName: "Reviewer",
			status: "idle",
			sessionFile: "/tmp/worker.jsonl",
			spawns: null,
			updatedAt: 42,
		});
	});

	it("parses waiting, paused detail, and legacy records additively", () => {
		const records = collectLatestPersistedAgentRefs([
			customEntry({
				schemaVersion: 1,
				id: "Legacy",
				displayName: "Legacy",
				kind: "sub",
				status: "idle",
				sessionFile: "/tmp/legacy.jsonl",
			}),
			customEntry({
				schemaVersion: 1,
				id: "Waiting",
				displayName: "Waiting",
				kind: "sub",
				status: "waiting",
				sessionFile: "/tmp/waiting.jsonl",
			}),
			customEntry({
				schemaVersion: 1,
				id: "Paused",
				displayName: "Paused",
				kind: "sub",
				status: "paused",
				statusDetail: {
					code: "no_progress",
					reason: "No observable progress for 10 cycles",
					since: 42,
					consecutive: 10,
					limit: 10,
				},
				sessionFile: "/tmp/paused.jsonl",
			}),
			customEntry({
				schemaVersion: 1,
				id: "MalformedDetail",
				displayName: "Malformed",
				kind: "sub",
				status: "paused",
				statusDetail: { code: "no_progress", reason: 42, since: "now" },
				sessionFile: "/tmp/malformed.jsonl",
			}),
		]);

		expect(records.map(record => record.id)).toEqual(["Legacy", "Waiting", "Paused", "MalformedDetail"]);
		expect(records.find(record => record.id === "Legacy")?.statusDetail).toBeUndefined();
		expect(records.find(record => record.id === "Waiting")?.status).toBe("waiting");
		expect(records.find(record => record.id === "MalformedDetail")).toMatchObject({
			status: "paused",
			statusDetail: undefined,
		});
		expect(records.find(record => record.id === "Paused")).toMatchObject({
			status: "paused",
			statusDetail: {
				code: "no_progress",
				reason: "No observable progress for 10 cycles",
				since: 42,
				consecutive: 10,
				limit: 10,
			},
		});
	});

	it("restores refs as parked, never running, and revives only resumable agents", async () => {
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const revived = makeSession();
		let reviveCount = 0;

		const restored = restorePersistedAgentRefs({
			entries: [
				customEntry({
					schemaVersion: 1,
					id: "RunningAgent",
					displayName: "Runner",
					kind: "sub",
					status: "running",
					sessionFile: "/tmp/running.jsonl",
					resumable: true,
				}),
				customEntry({
					schemaVersion: 1,
					id: "IsolatedAgent",
					displayName: "Isolated",
					kind: "sub",
					status: "idle",
					sessionFile: "/tmp/isolated.jsonl",
					resumable: false,
				}),
				customEntry({
					schemaVersion: 1,
					id: "WaitingAgent",
					displayName: "Waiting",
					kind: "sub",
					status: "waiting",
					sessionFile: "/tmp/waiting.jsonl",
					resumable: true,
				}),
				customEntry({
					schemaVersion: 1,
					id: "PausedAgent",
					displayName: "Paused",
					kind: "sub",
					status: "paused",
					statusDetail: {
						code: "no_progress",
						reason: "No progress",
						since: 42,
					},
					sessionFile: "/tmp/paused.jsonl",
					resumable: true,
				}),
				customEntry({
					schemaVersion: 1,
					id: "AbortedAgent",
					displayName: "Aborted",
					kind: "sub",
					status: "aborted",
					sessionFile: "/tmp/aborted.jsonl",
					resumable: true,
				}),
			],
			registry,
			lifecycle,
			idleTtlMs: 0,
			makeReviver: () => async () => {
				reviveCount++;
				return revived;
			},
		});

		expect(restored).toBe(5);
		expect(registry.get("RunningAgent")?.status).toBe("parked");
		expect(registry.get("RunningAgent")?.session).toBeNull();
		expect(registry.get("IsolatedAgent")?.status).toBe("parked");
		expect(registry.get("WaitingAgent")).toMatchObject({
			status: "parked",
			session: null,
			sessionFile: "/tmp/waiting.jsonl",
			statusDetail: undefined,
		});
		expect(registry.get("PausedAgent")).toMatchObject({
			status: "parked",
			session: null,
			sessionFile: "/tmp/paused.jsonl",
			statusDetail: undefined,
		});
		expect(registry.get("AbortedAgent")?.status).toBe("aborted");
		expect(lifecycle.has("RunningAgent")).toBe(true);
		expect(lifecycle.has("IsolatedAgent")).toBe(true);
		expect(lifecycle.has("WaitingAgent")).toBe(true);
		expect(lifecycle.has("PausedAgent")).toBe(true);
		expect(lifecycle.has("AbortedAgent")).toBe(false);

		expect(await lifecycle.ensureLive("RunningAgent")).toBe(revived);
		expect(registry.get("RunningAgent")?.status).toBe("idle");
		expect(registry.get("RunningAgent")?.session).toBe(revived);
		expect(reviveCount).toBe(1);
		await expect(lifecycle.ensureLive("IsolatedAgent")).rejects.toThrow(/no reviver registered/);
		await expect(lifecycle.ensureLive("AbortedAgent")).rejects.toThrow(/cannot be revived/);
	});

	it("syncs revived agent registry status from session lifecycle events", () => {
		const registry = AgentRegistry.global();
		const { session, emit } = makeSubscribableSession();
		registry.register({
			id: "RevivedAgent",
			displayName: "Revived",
			kind: "sub",
			session,
			sessionFile: "/tmp/revived.jsonl",
			status: "idle",
		});

		installRegistryStatusSync("RevivedAgent", session, registry);
		emit({ type: "agent_start" });
		expect(registry.get("RevivedAgent")?.status).toBe("running");

		emit({ type: "agent_end", messages: [] });
		expect(registry.get("RevivedAgent")?.status).toBe("idle");

		const pauseDetail = {
			code: "no_progress" as const,
			reason: "No observable progress",
			since: 42,
			consecutive: 10,
			limit: 10,
		};
		registry.setStatus("RevivedAgent", "paused", pauseDetail);
		emit({ type: "agent_end", messages: [] });
		expect(registry.get("RevivedAgent")).toMatchObject({
			status: "paused",
			statusDetail: pauseDetail,
		});

		registry.setStatus("RevivedAgent", "aborted");
		emit({ type: "agent_end", messages: [] });
		expect(registry.get("RevivedAgent")?.status).toBe("aborted");
	});
});
