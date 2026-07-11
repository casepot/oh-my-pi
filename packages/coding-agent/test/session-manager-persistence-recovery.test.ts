import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";

interface AtomicRewriteGate {
	readonly started: Promise<void>;
	release(): void;
}

class FailingPersistenceStorage extends MemorySessionStorage {
	readonly appendError = Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
	readonly atomicRewriteError = Object.assign(new Error("Atomic rewrite failed"), { code: "EIO" });
	atomicRewriteAttempts = 0;

	#failNextAppend = true;
	#failNextAtomicRewrite = false;
	#nextAtomicRewriteGate:
		| {
				started: PromiseWithResolvers<void>;
				release: PromiseWithResolvers<void>;
		  }
		| undefined;

	override openWriter(
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const inner = super.openWriter(path, options);
		const storage = this;
		let injectedError: Error | undefined;

		return {
			append(line: string): Promise<void> {
				if (injectedError) return Promise.reject(injectedError);
				if (storage.#failNextAppend) {
					storage.#failNextAppend = false;
					injectedError = storage.appendError;
					options?.onError?.(injectedError);
					return Promise.reject(injectedError);
				}
				return inner.append(line);
			},
			flush(): Promise<void> {
				if (injectedError) return Promise.reject(injectedError);
				return inner.flush();
			},
			isOpen(): boolean {
				return inner.isOpen();
			},
			close(): Promise<void> {
				return inner.close();
			},
			getError(): Error | undefined {
				return injectedError ?? inner.getError();
			},
		};
	}

	failOneAtomicRewrite(): void {
		this.#failNextAtomicRewrite = true;
	}

	holdNextAtomicRewrite(): AtomicRewriteGate {
		if (this.#nextAtomicRewriteGate) throw new Error("An atomic rewrite is already held");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		this.#nextAtomicRewriteGate = { started, release };
		return {
			started: started.promise,
			release: () => release.resolve(),
		};
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.atomicRewriteAttempts++;
		const gate = this.#nextAtomicRewriteGate;
		this.#nextAtomicRewriteGate = undefined;
		if (gate) {
			gate.started.resolve();
			await gate.release.promise;
		}
		if (this.#failNextAtomicRewrite) {
			this.#failNextAtomicRewrite = false;
			throw this.atomicRewriteError;
		}
		return super.writeTextAtomic(path, content, options);
	}
}

function branchMessageTexts(manager: SessionManager): string[] {
	return manager.getBranch().flatMap(entry => {
		if (entry.type !== "message") return [];
		if (entry.message.role !== "user" && entry.message.role !== "assistant") return [];
		const { content } = entry.message;
		if (typeof content === "string") return [content];
		return content.flatMap(part => (part.type === "text" ? [part.text] : []));
	});
}

function expectValidJsonl(content: string, entryCount: number): void {
	const lines = content.split("\n");
	expect(lines.pop()).toBe("");
	expect(lines).toHaveLength(entryCount + 2);
	for (const line of lines) {
		expect(() => JSON.parse(line)).not.toThrow();
	}
}

async function createSeededManager(storage: FailingPersistenceStorage): Promise<{
	manager: SessionManager;
	sessionFile: string;
}> {
	const manager = SessionManager.create("/cwd", "/sessions", storage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model");

	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "seed response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	});
	await manager.flush();

	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected session file");
	return { manager, sessionFile };
}

async function reopen(sessionFile: string, storage: FailingPersistenceStorage): Promise<SessionManager> {
	return SessionManager.open(sessionFile, "/sessions", storage, {
		initialCwd: "/cwd",
		suppressBreadcrumb: true,
	});
}

describe("SessionManager persistence recovery", () => {
	it("retains failed and later entries once, coalesces recovery, and resumes immediate durability", async () => {
		const storage = new FailingPersistenceStorage();
		const { manager, sessionFile } = await createSeededManager(storage);
		const transitions: string[] = [];
		const failureErrors: Error[] = [];
		manager.onPersistenceStateChanged(state => {
			transitions.push(state.status);
			if (state.status === "failed") failureErrors.push(state.error);
		});

		manager.appendMessage({ role: "user", content: "failed append", timestamp: 2 });
		const failedState = manager.getPersistenceState();
		expect(failedState.status).toBe("failed");
		if (failedState.status !== "failed") throw new Error("Expected failed persistence state");
		expect(failedState.error).toBe(storage.appendError);
		expect(transitions).toEqual(["failed"]);
		expect(failureErrors).toEqual([storage.appendError]);

		manager.appendMessage({ role: "user", content: "accepted while failed", timestamp: 3 });
		expect(branchMessageTexts(manager)).toEqual(["seed response", "failed append", "accepted while failed"]);
		expect(transitions).toEqual(["failed"]);

		const oldBytes = await storage.readText(sessionFile);
		expectValidJsonl(oldBytes, 1);
		expect(branchMessageTexts(await reopen(sessionFile, storage))).toEqual(["seed response"]);

		const gate = storage.holdNextAtomicRewrite();
		const firstRecovery = manager.recoverPersistence();
		await gate.started;
		const concurrentRecovery = manager.recoverPersistence();
		expect(storage.atomicRewriteAttempts).toBe(1);
		expect(transitions).toEqual(["failed"]);

		gate.release();
		await Promise.all([firstRecovery, concurrentRecovery]);
		expect(storage.atomicRewriteAttempts).toBe(1);
		expect(manager.getPersistenceState()).toEqual({ status: "healthy" });
		expect(transitions).toEqual(["failed", "healthy"]);

		const recoveredBytes = await storage.readText(sessionFile);
		expectValidJsonl(recoveredBytes, 3);
		expect(branchMessageTexts(await reopen(sessionFile, storage))).toEqual([
			"seed response",
			"failed append",
			"accepted while failed",
		]);

		manager.appendMessage({ role: "user", content: "immediately durable", timestamp: 4 });
		const appendedBytes = await storage.readText(sessionFile);
		expectValidJsonl(appendedBytes, 4);
		expect(branchMessageTexts(await reopen(sessionFile, storage))).toEqual([
			"seed response",
			"failed append",
			"accepted while failed",
			"immediately durable",
		]);
	});

	it("preserves the prior parseable target when recovery fails and succeeds on retry", async () => {
		const storage = new FailingPersistenceStorage();
		const { manager, sessionFile } = await createSeededManager(storage);
		const transitions: string[] = [];
		manager.onPersistenceStateChanged(state => transitions.push(state.status));
		const oldBytes = await storage.readText(sessionFile);
		expectValidJsonl(oldBytes, 1);

		manager.appendMessage({ role: "user", content: "failed append", timestamp: 2 });
		manager.appendMessage({ role: "user", content: "accepted while failed", timestamp: 3 });
		storage.failOneAtomicRewrite();

		let recoveryError: unknown;
		try {
			await manager.recoverPersistence();
		} catch (error) {
			recoveryError = error;
		}
		expect(recoveryError).toBe(storage.appendError);
		expect(storage.atomicRewriteAttempts).toBe(1);
		expect(await storage.readText(sessionFile)).toBe(oldBytes);
		expectValidJsonl(await storage.readText(sessionFile), 1);
		const stillFailed = manager.getPersistenceState();
		expect(stillFailed.status).toBe("failed");
		if (stillFailed.status !== "failed") throw new Error("Expected failed persistence state");
		expect(stillFailed.error).toBe(storage.appendError);
		expect(transitions).toEqual(["failed"]);
		expect(branchMessageTexts(await reopen(sessionFile, storage))).toEqual(["seed response"]);

		await manager.recoverPersistence();
		expect(storage.atomicRewriteAttempts).toBe(2);
		expect(manager.getPersistenceState()).toEqual({ status: "healthy" });
		expect(transitions).toEqual(["failed", "healthy"]);
		const recoveredBytes = await storage.readText(sessionFile);
		expectValidJsonl(recoveredBytes, 3);
		expect(branchMessageTexts(await reopen(sessionFile, storage))).toEqual([
			"seed response",
			"failed append",
			"accepted while failed",
		]);
	});
});
