import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./session-manager/helpers";

class FailOnceAppendStorage extends MemorySessionStorage {
	readonly failure = new Error("injected append failure");
	appendAttempts = 0;
	#failNextAppend = false;

	failNextAppend(): void {
		this.#failNextAppend = true;
	}

	override appendSync(filePath: string, chunk: string): void {
		this.appendAttempts++;
		if (this.#failNextAppend) {
			this.#failNextAppend = false;
			throw this.failure;
		}
		super.appendSync(filePath, chunk);
	}
}

describe("AgentSession persistence notices", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("emits one failure notice until successful recovery emits one healthy notice", async () => {
		tempDir = TempDir.createSync("@pi-agent-session-persistence-notices-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const storage = new FailOnceAppendStorage();
		const sessionManager = SessionManager.create("/workspace", "/sessions", storage);
		const agent = new Agent({
			initialState: {
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"advisor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
			}),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		const persistenceNotices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "session-persistence") persistenceNotices.push(event);
		});

		sessionManager.appendMessage({ role: "user", content: "persisted before failure", timestamp: 1 });
		sessionManager.appendMessage(makeAssistantMessage());
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const persistedBeforeFailure = await storage.readText(sessionFile);

		storage.failNextAppend();
		const failedAppendId = sessionManager.appendMessage({
			role: "user",
			content: "retained after failed append",
			timestamp: 2,
		});
		const laterAppendId = sessionManager.appendMessage({
			role: "user",
			content: "also retained while persistence is failed",
			timestamp: 3,
		});

		expect(sessionManager.getPersistenceState()).toEqual({ status: "failed", error: storage.failure });
		expect(storage.appendAttempts).toBe(1);
		expect(await storage.readText(sessionFile)).toBe(persistedBeforeFailure);
		expect(
			sessionManager
				.getEntries()
				.slice(-2)
				.map(entry => entry.id),
		).toEqual([failedAppendId, laterAppendId]);
		expect(persistenceNotices).toEqual([
			{
				type: "notice",
				level: "error",
				message:
					"Session writes are paused. Changes remain in memory; the next flush or history rewrite will retry.",
				source: "session-persistence",
			},
		]);

		await sessionManager.recoverPersistence();
		await sessionManager.recoverPersistence();

		expect(sessionManager.getPersistenceState()).toEqual({ status: "healthy" });
		const header = sessionManager.getHeader();
		if (!header) throw new Error("Expected session header");
		expect(await loadEntriesFromFile(sessionFile, storage)).toEqual([header, ...sessionManager.getEntries()]);
		expect(persistenceNotices).toEqual([
			{
				type: "notice",
				level: "error",
				message:
					"Session writes are paused. Changes remain in memory; the next flush or history rewrite will retry.",
				source: "session-persistence",
			},
			{
				type: "notice",
				level: "info",
				message: "Session persistence recovered. The current in-memory snapshot is saved.",
				source: "session-persistence",
			},
		]);
	});
});
