import { describe, expect, it } from "bun:test";
import type { AgentSnapshot } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentDrawer } from "../src/components/agents/AgentDrawer";
import { AgentsPanel } from "../src/components/agents/AgentsPanel";
import { GuestClient } from "../src/lib/client";
import { encodeBase64Url } from "../src/lib/link";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const client = new GuestClient(LINK, "tester");

function makeAgent(
	status: AgentSnapshot["status"],
	index: number,
	statusDetail?: AgentSnapshot["statusDetail"],
): AgentSnapshot {
	return {
		id: `agent-${status}`,
		displayName: `Agent ${status}`,
		kind: "sub",
		parentId: "main",
		status,
		statusDetail,
		hasSessionFile: false,
		createdAt: 1_000 + index,
		lastActivity: 2_000 + index,
	};
}

function renderDrawer(agent: AgentSnapshot): string {
	return renderToStaticMarkup(
		<AgentDrawer agent={agent} client={client} onClose={() => {}} />,
	);
}

describe("web agent lifecycle rendering", () => {
	it("renders distinct waiting, paused, idle, and parked panel states with detail", () => {
		const agents = [
			makeAgent("waiting", 0, {
				code: "provider_retry",
				reason: "provider retry backoff",
				since: 1_000,
			}),
			makeAgent("paused", 1, {
				code: "no_progress",
				reason: "paused after repeated tool loops",
				since: 2_000,
			}),
			makeAgent("idle", 2),
			makeAgent("parked", 3),
		];
		const html = renderToStaticMarkup(
			<AgentsPanel
				agents={agents}
				progress={new Map()}
				lifecycle={new Map()}
				selectedId={null}
				onSelect={() => {}}
			/>,
		);

		for (const status of ["waiting", "paused", "idle", "parked"]) {
			expect(html).toContain(`ag-dot--${status}`);
		}
		expect(html).toContain("waiting · provider retry backoff");
		expect(html).toContain("paused · paused after repeated tool loops");
		expect(html).toContain(">idle<");
		expect(html).toContain(">parked<");
	});

	it("renders structured detail in the drawer", () => {
		const html = renderDrawer(
			makeAgent("waiting", 0, {
				code: "provider_retry",
				reason: "provider retry backoff",
				since: 1_000,
				consecutive: 2,
				limit: 4,
			}),
		);

		expect(html).toContain("provider retry");
		expect(html).toContain("provider retry backoff");
		expect(html).toContain("attempt 2/4");
	});

	it("offers revive only for parked agents and keeps waiting and paused chat-capable", () => {
		for (const status of ["running", "waiting", "paused", "idle", "parked", "aborted"] as const) {
			const html = renderDrawer(makeAgent(status, 0));
			expect(html.includes("revive</button>")).toBe(status === "parked");
			if (status === "waiting" || status === "paused") expect(html).toContain('class="ag-chat"');
			if (status === "aborted") expect(html).not.toContain('class="ag-chat"');
		}
	});
});
