import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import {
	type AgentSnapshot,
	COLLAB_PROTO,
	type CollabFrame,
	formatCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import {
	countRunningSubagentBadgeAgents,
	getRunningSubagentBadgeRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/running-subagent-badge";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// In-memory transport: shared FakeWebSocket + InMemoryRelay harness (see
// ./helpers/in-memory-relay), mirroring the relay's forwarding contract.

function makeState(): Extract<CollabFrame, { t: "welcome" }>["state"] {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

function makeAgent(
	id: string,
	index: number,
	status: AgentSnapshot["status"] = "running",
	statusDetail?: AgentSnapshot["statusDetail"],
): AgentSnapshot {
	return {
		id,
		displayName: `Remote ${index + 1}`,
		kind: "sub",
		parentId: "Main",
		status,
		statusDetail,
		hasSessionFile: true,
		createdAt: 1000 + index,
		lastActivity: 2000 + index,
	};
}

function makeGuestContext(counts: number[]): InteractiveModeContext {
	let statusLineCount = 0;
	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: { get: () => "" },
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setSubagentCount: (count: number) => {
				statusLineCount = count;
			},
			get subagentCount() {
				return statusLineCount;
			},
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: () => Promise.resolve() },
		syncRunningSubagentBadge: () => {
			const registry = getRunningSubagentBadgeRegistry(ctx.collabGuest);
			const count = countRunningSubagentBadgeAgents(registry);
			ctx.statusLine.setSubagentCount(count);
			counts.push(count);
		},
	} as unknown as InteractiveModeContext;
	return ctx;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("collab guest running-subagents badge", () => {
	it("preserves six-state snapshots and detail while counting only running agents", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const roomId = "badge-room-1";
		const roomKey = generateRoomKey();
		const cryptoKey = await importRoomKey(roomKey);
		const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
		const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
		const hostOpen = Promise.withResolvers<void>();
		const waitingDetail = {
			code: "provider_retry",
			reason: "provider retry backoff",
			since: 1_500,
			consecutive: 2,
			limit: 4,
		} satisfies NonNullable<AgentSnapshot["statusDetail"]>;
		let nextWelcomeAgents = [
			makeAgent("remote-running", 0),
			makeAgent("remote-waiting", 1, "waiting", waitingDetail),
			makeAgent("remote-paused", 2, "paused", {
				code: "no_progress",
				reason: "no observable progress",
				since: 1_600,
			}),
			makeAgent("remote-idle", 3, "idle"),
			makeAgent("remote-parked", 4, "parked"),
			makeAgent("remote-aborted", 5, "aborted"),
		];
		const sendWelcome = (agents: AgentSnapshot[]) => {
			hostSocket.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
				state: makeState(),
				agents,
				entryCount: 0,
			});
		};
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t === "hello") sendWelcome(nextWelcomeAgents);
		};
		hostSocket.connect();
		await hostOpen.promise;

		const counts: number[] = [];
		const ctx = makeGuestContext(counts);
		const guest = new CollabGuestLink(ctx);

		try {
			await guest.join(link);
			expect(ctx.collabGuest).toBe(guest);
			expect(counts).toEqual([0, 1]);
			expect(ctx.statusLine.subagentCount).toBe(1);

			expect(guest.agentRegistry.get("remote-waiting")).toMatchObject({
				status: "waiting",
				statusDetail: waitingDetail,
			});
			expect(guest.agentRegistry.list().map(ref => ref.status)).toEqual([
				"running",
				"waiting",
				"paused",
				"idle",
				"parked",
				"aborted",
			]);

			const pausedDetail = {
				code: "no_progress",
				reason: "paused after repeated tool loops",
				since: 2_500,
				consecutive: 3,
				limit: 3,
			} satisfies NonNullable<AgentSnapshot["statusDetail"]>;
			const agentsFrameApplied = Promise.withResolvers<void>();
			const unsubscribe = guest.agentRegistry.onChange(event => {
				if (event.ref.id === "remote-waiting" && event.ref.status === "paused") agentsFrameApplied.resolve();
			});
			nextWelcomeAgents = nextWelcomeAgents.map(agent =>
				agent.id === "remote-waiting" ? { ...agent, status: "paused", statusDetail: pausedDetail } : agent,
			);
			hostSocket.send({ t: "agents", agents: nextWelcomeAgents });
			await agentsFrameApplied.promise;
			unsubscribe();
			expect(guest.agentRegistry.get("remote-waiting")).toMatchObject({
				status: "paused",
				statusDetail: pausedDetail,
			});
			expect(ctx.statusLine.subagentCount).toBe(1);

			const secondSnapshot = Promise.withResolvers<void>();
			const originalSync = ctx.syncRunningSubagentBadge.bind(ctx);
			ctx.syncRunningSubagentBadge = () => {
				originalSync();
				if (ctx.statusLine.subagentCount === 2) secondSnapshot.resolve();
			};
			hostSocket.send({ t: "agents", agents: [...nextWelcomeAgents, makeAgent("remote-two", 6)] });
			await secondSnapshot.promise;
			expect(ctx.statusLine.subagentCount).toBe(2);

			await guest.leave("test cleanup");
			expect(ctx.collabGuest).toBeUndefined();
			expect(ctx.statusLine.subagentCount).toBe(0);
			expect(counts.at(-1)).toBe(0);
		} finally {
			hostSocket.close();
			writeSpy.mockRestore();
			await guest.leave("test cleanup").catch(() => {});
		}
	});
});
