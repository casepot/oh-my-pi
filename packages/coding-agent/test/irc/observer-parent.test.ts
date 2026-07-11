import { describe, expect, it } from "bun:test";
import { IrcObserverSessionIndex } from "@oh-my-pi/pi-coding-agent/irc/observer/attribution";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function rootSession(id: () => string, name: () => string | undefined): AgentSession {
	return {
		sessionManager: { getSessionId: id, getSessionName: name },
	} as unknown as AgentSession;
}

describe("IRC observer attribution", () => {
	it("snapshots descendants while resolving a bound root live across session switches", () => {
		const registry = new AgentRegistry();
		const index = new IrcObserverSessionIndex(registry);
		let sessionId = "old-session";
		let sessionName: string | undefined = "Old";
		const root = rootSession(
			() => sessionId,
			() => sessionName,
		);
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: root });
		registry.register({ id: "old-child", displayName: "old", kind: "sub", parentId: "Main", session: null });
		index.bindTopLevel("Main", root);
		expect(index.resolveRootSession("old-child")).toEqual({
			rootAgentId: "Main",
			rootSessionId: "old-session",
			rootSessionLabel: "Old",
		});

		sessionId = "new-session";
		sessionName = "New";
		registry.register({ id: "new-child", displayName: "new", kind: "sub", parentId: "Main", session: null });
		expect(index.resolveRootSession("Main")?.rootSessionId).toBe("new-session");
		expect(index.resolveRootSession("old-child")?.rootSessionId).toBe("old-session");
		expect(index.resolveRootSession("new-child")?.rootSessionId).toBe("new-session");
		expect(index.resolveMessageSession({ from: "Main", to: "old-child" })?.rootSessionId).toBe("old-session");
		expect(index.resolveMessageSession({ from: "old-child", to: "Main" })?.rootSessionId).toBe("old-session");
		expect(index.resolveMessageSession({ from: "missing", to: "old-child" })).toBeUndefined();
		index.dispose();
	});

	it("keeps separate top-level roots even when persisted session IDs match", () => {
		const registry = new AgentRegistry();
		const index = new IrcObserverSessionIndex(registry);
		const first = rootSession(
			() => "shared",
			() => undefined,
		);
		const second = rootSession(
			() => "shared",
			() => undefined,
		);
		registry.register({ id: "Root-A", displayName: "A", kind: "main", session: first });
		registry.register({ id: "Root-B", displayName: "B", kind: "main", session: second });
		index.bindTopLevel("Root-A", first);
		index.bindTopLevel("Root-B", second);
		expect(index.resolveRootSession("Root-A")?.rootAgentId).toBe("Root-A");
		expect(index.resolveRootSession("Root-B")?.rootAgentId).toBe("Root-B");
	});
});
