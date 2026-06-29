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

		expect(restored).toBe(3);
		expect(registry.get("RunningAgent")?.status).toBe("parked");
		expect(registry.get("RunningAgent")?.session).toBeNull();
		expect(registry.get("IsolatedAgent")?.status).toBe("parked");
		expect(registry.get("AbortedAgent")?.status).toBe("aborted");
		expect(lifecycle.has("RunningAgent")).toBe(true);
		expect(lifecycle.has("IsolatedAgent")).toBe(true);
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
	});
});
