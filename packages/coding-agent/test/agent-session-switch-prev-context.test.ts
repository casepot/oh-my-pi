import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { BuildSessionContextOptions, SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression for issue #3846: in-TUI `/resume` rebuilt the *previous*
 * session's display context before switching files. That call expands persisted
 * snapcompact archives and `openaiRemoteCompaction.replacementHistory` payloads
 * into messages, which can OOM on huge pre-fix sessions even though the loader
 * itself streams. The previous context is only needed for same-session reloads
 * (where `#didSessionMessagesChange` compares against the freshly rebuilt one);
 * different-session switches MUST skip that work.
 */
describe("AgentSession.switchSession previous-context build", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-switch-prev-ctx-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	afterEach(async () => {
		while (sessions.length > 0) {
			await sessions.pop()?.dispose();
		}
		for (const dir of tempDirs.splice(0)) {
			try {
				await dir.remove();
			} catch {}
		}
	});

	function buildSession(
		tempDir: TempDir,
		options: {
			sessionManager?: SessionManager;
			promptCacheKey?: string;
			inheritedProviderPromptCacheKey?: boolean;
		} = {},
	): { session: AgentSession; sessionManager: SessionManager } {
		const sessionManager = options.sessionManager ?? SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			promptCacheKey: options.promptCacheKey,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			providerPromptCacheKeySource: options.inheritedProviderPromptCacheKey ? "fork" : undefined,
		});
		sessions.push(session);
		return { session, sessionManager };
	}

	async function createForkedManager(tempDir: TempDir, label: string): Promise<SessionManager> {
		const parentManager = SessionManager.create(tempDir.path(), tempDir.path());
		parentManager.appendMessage({ role: "user", content: label, timestamp: 1 });
		await parentManager.ensureOnDisk();
		const parentFile = parentManager.getSessionFile();
		if (!parentFile) throw new Error("Expected parent session file");
		const forkedManager = await SessionManager.forkFrom(parentFile, tempDir.path(), tempDir.path());
		await parentManager.close();
		return forkedManager;
	}

	/** Wrap `sessionManager.buildSessionContext` so each call's caller-visible
	 *  state (the manager's currently-loaded session file) is recorded in
	 *  invocation order. The constructor itself calls `buildSessionContext`
	 *  once; spying *after* construction means only switchSession-driven calls
	 *  are observed. */
	function instrumentBuildSessionContext(sessionManager: SessionManager): {
		calls: Array<{ sessionFile: string | undefined; transcript: boolean | undefined }>;
		restore: () => void;
	} {
		const calls: Array<{ sessionFile: string | undefined; transcript: boolean | undefined }> = [];
		const original = sessionManager.buildSessionContext.bind(sessionManager);
		const patched = (options?: BuildSessionContextOptions): SessionContext => {
			calls.push({ sessionFile: sessionManager.getSessionFile(), transcript: options?.transcript });
			return original(options);
		};
		sessionManager.buildSessionContext = patched as SessionManager["buildSessionContext"];
		return {
			calls,
			restore: () => {
				sessionManager.buildSessionContext = original;
			},
		};
	}

	it("skips building the previous display context when switching to a different session", async () => {
		const tempDir = TempDir.createSync("@pi-switch-prev-ctx-different-");
		tempDirs.push(tempDir);

		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		expect(previousSessionFile).toBeString();

		const otherManager = SessionManager.create(tempDir.path(), tempDir.path());
		otherManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await otherManager.flush();
		const targetSessionFile = otherManager.getSessionFile();
		expect(targetSessionFile).toBeString();
		expect(targetSessionFile).not.toBe(previousSessionFile);
		await otherManager.close();

		const { calls, restore } = instrumentBuildSessionContext(sessionManager);
		try {
			const switched = await session.switchSession(targetSessionFile!);
			expect(switched).toBe(true);
			expect(session.sessionFile).toBe(targetSessionFile);
		} finally {
			restore();
		}

		// The previous session's display context MUST NOT be materialized. Only
		// the new target context (post-`setSessionFile`) should be built.
		expect(calls).toEqual([{ sessionFile: targetSessionFile!, transcript: undefined }]);
	});

	it("preserves the target affinity during adoption and restores the live key when switching fails", async () => {
		const tempDir = TempDir.createSync("@pi-switch-cache-key-rollback-");
		tempDirs.push(tempDir);

		const sourceManager = await createForkedManager(tempDir, "source");
		const sourceKey = sourceManager.getHeader()?.providerPromptCacheKey;
		const sourceFile = sourceManager.getSessionFile();
		expect(sourceKey).toBeString();
		expect(sourceFile).toBeString();
		const { session, sessionManager } = buildSession(tempDir, {
			sessionManager: sourceManager,
			promptCacheKey: sourceKey,
			inheritedProviderPromptCacheKey: true,
		});

		const targetManager = await createForkedManager(tempDir, "target");
		const targetKey = targetManager.getHeader()?.providerPromptCacheKey;
		const targetFile = targetManager.getSessionFile();
		expect(targetKey).toBeString();
		expect(targetKey).not.toBe(sourceKey);
		expect(targetFile).toBeString();
		await targetManager.close();

		const originalBuildSessionContext = sessionManager.buildSessionContext.bind(sessionManager);
		const observedTargetAffinity: Array<{ header: string | undefined; live: string | undefined }> = [];
		sessionManager.buildSessionContext = ((options?: BuildSessionContextOptions): SessionContext => {
			if (sessionManager.getSessionFile() === targetFile) {
				observedTargetAffinity.push({
					header: sessionManager.getHeader()?.providerPromptCacheKey,
					live: session.agent.promptCacheKey,
				});
				throw new Error("forced target context failure");
			}
			return originalBuildSessionContext(options);
		}) as SessionManager["buildSessionContext"];

		let switchError: unknown;
		try {
			await session.switchSession(targetFile!);
		} catch (error) {
			switchError = error;
		} finally {
			sessionManager.buildSessionContext = originalBuildSessionContext;
		}
		expect(switchError).toBeInstanceOf(Error);
		expect(String(switchError)).toContain("forced target context failure");

		expect(observedTargetAffinity).toEqual([{ header: targetKey, live: targetKey }]);
		expect(session.sessionFile).toBe(sourceFile);
		expect(sessionManager.getHeader()?.providerPromptCacheKey).toBe(sourceKey);
		expect(session.agent.promptCacheKey).toBe(sourceKey);
		session.setThinkingLevel(ThinkingLevel.Off);
		expect(session.agent.promptCacheKey).toBeUndefined();
		expect(sessionManager.getHeader()?.providerPromptCacheKey).toBeUndefined();

		const reopenedTarget = await SessionManager.open(targetFile!, tempDir.path());
		try {
			expect(reopenedTarget.getHeader()?.providerPromptCacheKey).toBe(targetKey);
		} finally {
			await reopenedTarget.close();
		}
	});

	it("builds the previous display context for same-session reloads", async () => {
		const tempDir = TempDir.createSync("@pi-switch-prev-ctx-reload-");
		tempDirs.push(tempDir);

		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "current", timestamp: 1 });
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeString();

		const { calls, restore } = instrumentBuildSessionContext(sessionManager);
		try {
			const switched = await session.switchSession(sessionFile!);
			expect(switched).toBe(true);
			expect(session.sessionFile).toBe(sessionFile);
		} finally {
			restore();
		}

		// Same-session reload must snapshot the pre-reload context so
		// `#didSessionMessagesChange` can detect rollback edits.
		expect(calls).toEqual([
			{ sessionFile: sessionFile!, transcript: undefined },
			{ sessionFile: sessionFile!, transcript: undefined },
		]);
	});
});
