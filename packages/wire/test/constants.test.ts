import { describe, expect, it } from "bun:test";
import {
	type AgentSnapshot,
	type AgentStatus,
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	DEFAULT_RELAY_URL,
	ENVELOPE_HEADER_LENGTH,
	ROOM_ID_BYTES,
} from "../src";

describe("collab wire constants", () => {
	it("exports the protocol constants consumed by host, guest, and relay links", () => {
		expect(COLLAB_PROTO).toBe(4);
		expect(COLLAB_PROMPT_MESSAGE_TYPE).toBe("collab-prompt");
		expect(ENVELOPE_HEADER_LENGTH).toBe(4);
		expect(ROOM_ID_BYTES).toBe(16);
		expect(DEFAULT_RELAY_URL).toBe("wss://my.omp.sh");
	});

	it("types the six lifecycle states and structured status detail on agent snapshots", () => {
		const statuses = ["running", "waiting", "paused", "idle", "parked", "aborted"] satisfies AgentStatus[];
		const snapshots: AgentSnapshot[] = statuses.map((status, index) => ({
			id: `agent-${index}`,
			displayName: status,
			kind: "sub",
			status,
			statusDetail:
				status === "waiting"
					? {
							code: "provider_retry",
							reason: "provider asked the agent to retry",
							since: 1_000,
							consecutive: 2,
							limit: 5,
						}
					: undefined,
			hasSessionFile: true,
			createdAt: 500,
			lastActivity: 1_000,
		}));

		expect(snapshots.map(snapshot => snapshot.status)).toEqual(statuses);
		expect(snapshots[1]?.statusDetail).toEqual({
			code: "provider_retry",
			reason: "provider asked the agent to retry",
			since: 1_000,
			consecutive: 2,
			limit: 5,
		});
	});
});
