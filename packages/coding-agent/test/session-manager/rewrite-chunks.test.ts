import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorage,
	type SessionStorageStat,
	type SessionStorageWriter,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

class ChunkRecordingStorage implements SessionStorage {
	readonly #inner = new MemorySessionStorage();
	syncRewriteCalls = 0;
	textAtomicRewriteCalls = 0;
	titleUpdateCalls = 0;
	lastChunkCount = 0;
	lastTotalBytes = 0;

	resetRecords(): void {
		this.syncRewriteCalls = 0;
		this.textAtomicRewriteCalls = 0;
		this.titleUpdateCalls = 0;
		this.lastChunkCount = 0;
		this.lastTotalBytes = 0;
	}

	#record(chunks: readonly string[]): void {
		this.lastChunkCount = chunks.length;
		this.lastTotalBytes = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk, "utf-8"), 0);
	}

	ensureDirSync(dir: string): void {
		this.#inner.ensureDirSync(dir);
	}

	existsSync(p: string): boolean {
		return this.#inner.existsSync(p);
	}

	writeTextSync(): void {
		throw new Error("writeTextSync should not be used for session rewrites");
	}

	writeChunksSync(p: string, chunks: Iterable<string>): void {
		const materialized = [...chunks];
		this.syncRewriteCalls++;
		this.#record(materialized);
		this.#inner.writeChunksSync(p, materialized);
	}

	updateSessionTitle(p: string, update: SessionTitleUpdate): Promise<void> {
		this.titleUpdateCalls++;
		return this.#inner.updateSessionTitle(p, update);
	}

	statSync(p: string): SessionStorageStat {
		return this.#inner.statSync(p);
	}

	listFilesSync(dir: string, pattern: string): string[] {
		return this.#inner.listFilesSync(dir, pattern);
	}

	exists(p: string): Promise<boolean> {
		return this.#inner.exists(p);
	}

	readText(p: string): Promise<string> {
		return this.#inner.readText(p);
	}

	readTextSlices(p: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		return this.#inner.readTextSlices(p, prefixBytes, suffixBytes);
	}

	writeText(p: string, content: string): Promise<void> {
		return this.#inner.writeText(p, content);
	}

	async writeTextAtomic(
		p: string,
		content: string,
		options?: Parameters<SessionStorage["writeTextAtomic"]>[2],
	): Promise<void> {
		this.textAtomicRewriteCalls++;
		this.#record([content]);
		await this.#inner.writeTextAtomic(p, content, options);
	}

	rename(p: string, nextPath: string): Promise<void> {
		return this.#inner.rename(p, nextPath);
	}

	unlink(p: string): Promise<void> {
		return this.#inner.unlink(p);
	}

	deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		return this.#inner.deleteSessionWithArtifacts(sessionPath);
	}

	openWriter(p: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return this.#inner.openWriter(p, options);
	}

	drain(): Promise<void> {
		return this.#inner.drain();
	}
}

function assistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
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
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function createManager(storage: ChunkRecordingStorage): SessionManager {
	const root = path.join(os.tmpdir(), `omp-chunk-rewrite-${Bun.randomUUIDv7()}`);
	return SessionManager.create(root, path.join(root, "sessions"), storage);
}

describe("SessionManager full-text rewrites", () => {
	it("uses atomic full-text rewrites and title slot updates for renames", async () => {
		let storage = new ChunkRecordingStorage();
		let manager = createManager(storage);
		manager.appendMessage({ role: "user", content: "before assistant", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("materialize"));
		storage.resetRecords();
		const renamed = await manager.setSessionName("renamed", "user");
		expect(renamed).toBe(true);
		expect(storage.titleUpdateCalls).toBe(1);
		expect(storage.textAtomicRewriteCalls).toBe(0);
		expect(storage.lastChunkCount).toBe(0);

		storage = new ChunkRecordingStorage();
		manager = createManager(storage);
		manager.appendMessage({ role: "user", content: "force disk", timestamp: Date.now() });
		storage.resetRecords();
		await manager.ensureOnDisk();
		expect(storage.textAtomicRewriteCalls).toBe(1);
		expect(storage.lastChunkCount).toBe(1);
		expect(storage.lastTotalBytes).toBeGreaterThan(0);

		storage = new ChunkRecordingStorage();
		manager = createManager(storage);
		manager.appendMessage({ role: "user", content: "sync rewrite", timestamp: Date.now() });
		storage.resetRecords();
		manager.appendMessage(assistantMessage("materialize sync"));
		expect(storage.syncRewriteCalls).toBe(1);
		expect(storage.lastChunkCount).toBeGreaterThan(1);
		expect(storage.lastTotalBytes).toBeGreaterThan(0);
	});

	it("does not rewrite a current append-only file during flushSync", () => {
		const storage = new ChunkRecordingStorage();
		const manager = createManager(storage);
		manager.appendMessage(assistantMessage("materialize"));
		storage.resetRecords();
		manager.appendMessage({ role: "user", content: "hot append", timestamp: Date.now() });
		manager.flushSync();
		expect(storage.syncRewriteCalls).toBe(0);
		expect(storage.textAtomicRewriteCalls).toBe(0);
		expect(storage.lastChunkCount).toBe(0);
	});
});
