/**
 * Regression: the agent hub row order must be stable while the hub is open.
 *
 * The hub is sorted by lastActivity on first open, but after that keyboard
 * selection must not jump around as agents heartbeat or update activity. New
 * agents that appear while the hub is open are appended at the end.
 */
import { afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

const AGENT_STATUSES = ["running", "waiting", "paused", "idle", "parked", "aborted"] as const;

interface GeometryStub {
	setRows(n: number): void;
	restore(): void;
}

function stubStdoutGeometry(cols: number): GeometryStub {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	let rows = 24;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		setRows(n: number) {
			rows = n;
		},
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function makeHub(agents: AgentRegistry) {
	return new AgentHubOverlayComponent({
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent: async () => {},
	});
}

function renderedAgentIds(hub: AgentHubOverlayComponent): string[] {
	return hub
		.render(120)
		.map(line => Bun.stripANSI(line))
		.map(line => line.split(" · "))
		.filter(parts => parts.length >= 4 && AGENT_STATUSES.some(status => parts[0].endsWith(status)))
		.map(parts => parts[1]!);
}

describe("Agent hub row ordering", () => {
	let geometry: GeometryStub | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
		setSystemTime();
		vi.restoreAllMocks();
		geometry?.restore();
		geometry = undefined;
		AgentRegistry.resetGlobalForTests();
	});

	it("orders, summarizes, and labels all six lifecycle states", () => {
		geometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		for (const status of AGENT_STATUSES.toReversed()) {
			const statusDetail =
				status === "waiting"
					? { code: "provider_retry" as const, reason: "provider retry", since: Date.now() }
					: status === "paused"
						? { code: "no_progress" as const, reason: "progress cap", since: Date.now() }
						: undefined;
			agents.register({
				id: `${status}-agent`,
				displayName: status,
				kind: "sub",
				session: status === "parked" || status === "aborted" ? null : ({} as AgentSession),
				status,
				statusDetail,
			});
		}

		const hub = makeHub(agents);
		const rendered = Bun.stripANSI(hub.render(120).join("\n"));
		expect(renderedAgentIds(hub)).toEqual(AGENT_STATUSES.map(status => `${status}-agent`));
		expect(rendered).toContain("1 running · 1 waiting · 1 paused · 1 idle · 1 parked · 1 aborted");
		expect(rendered).toContain("provider retry");
		expect(rendered).toContain("progress cap");
		hub.dispose();
	});

	it("freezes the initial lastActivity order while the hub is open", () => {
		vi.useFakeTimers();
		let hub: AgentHubOverlayComponent | undefined;
		try {
			geometry = stubStdoutGeometry(120);
			const agents = new AgentRegistry();
			setSystemTime(1000);
			const sessionA = {} as AgentSession;
			agents.register({ id: "A", displayName: "Alpha", kind: "sub", session: sessionA });

			setSystemTime(2000);
			const sessionB = {} as AgentSession;
			agents.register({ id: "B", displayName: "Beta", kind: "sub", session: sessionB });

			setSystemTime(3000);
			const sessionC = {} as AgentSession;
			agents.register({ id: "C", displayName: "Gamma", kind: "sub", session: sessionC });

			hub = makeHub(agents);
			expect(renderedAgentIds(hub)).toEqual(["C", "B", "A"]);

			// Bump A's lastActivity far ahead of the others. The hub is already open,
			// so the captured order must not change.
			setSystemTime(4000);
			agents.setActivity("A", "still running");

			// Registering a new agent schedules a coalesced row refresh; the
			// existing rows must stay put once the scheduled refresh runs.
			setSystemTime(5000);
			const sessionD = {} as AgentSession;
			agents.register({ id: "D", displayName: "Delta", kind: "sub", session: sessionD });

			expect(renderedAgentIds(hub)).toEqual(["C", "B", "A"]);
			vi.advanceTimersByTime(100);
			expect(renderedAgentIds(hub)).toEqual(["C", "B", "A", "D"]);
		} finally {
			hub?.dispose();
			vi.useRealTimers();
			setSystemTime();
		}
	});

	it("truncates lines and sanitizes newlines to prevent terminal wrapping", () => {
		geometry = stubStdoutGeometry(80);
		const agents = new AgentRegistry();
		const sessionA = {} as AgentSession;
		agents.register({
			id: "RevAgentStream",
			displayName: "Agent runtime + compaction reviewer",
			kind: "sub",
			session: sessionA,
		});

		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSessions").mockReturnValue([
			{
				id: "RevAgentStream",
				kind: "subagent",
				label: "Subagent",
				status: "active",
				description: "Complete the assignment below, thoroughly:\n- check performance\n- check leaks",
				lastUpdate: Date.now(),
			},
		]);

		const hub = new AgentHubOverlayComponent({
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
		});

		const lines = hub.render(80);
		for (const line of lines) {
			const cleanLine = Bun.stripANSI(line);
			expect(cleanLine.includes("\n")).toBe(false);
			expect(cleanLine.includes("\r")).toBe(false);
			const width = visibleWidth(line);
			expect(width).toBeLessThanOrEqual(78);
		}

		hub.dispose();
	});
});
