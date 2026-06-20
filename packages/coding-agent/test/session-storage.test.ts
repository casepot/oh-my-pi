import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

class IndexedMemoryBackend implements SessionStorageBackend {
	readonly files = new Map<string, { content: string; mtimeMs: number }>();
	appendCalls = 0;
	truncateCalls = 0;
	failNextWriteFull: Error | undefined;

	async init(): Promise<void> {}

	async loadIndex(): Promise<Iterable<{ path: string; size: number; mtimeMs: number }>> {
		return [...this.files.entries()].map(([path, entry]) => ({
			path,
			size: Buffer.byteLength(entry.content, "utf-8"),
			mtimeMs: entry.mtimeMs,
		}));
	}

	async readFull(path: string): Promise<string | null> {
		return this.files.get(path)?.content ?? null;
	}

	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const content = this.files.get(path)?.content ?? "";
		return [content.slice(0, prefixBytes), suffixBytes > 0 ? content.slice(-suffixBytes) : ""];
	}

	async writeFull(path: string, content: string, mtimeMs: number): Promise<void> {
		const error = this.failNextWriteFull;
		if (error) {
			this.failNextWriteFull = undefined;
			throw error;
		}
		this.files.set(path, { content, mtimeMs });
	}

	async append(path: string, line: string, mtimeMs: number): Promise<void> {
		this.appendCalls += 1;
		const content = `${this.files.get(path)?.content ?? ""}${line}`;
		this.files.set(path, { content, mtimeMs });
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		this.truncateCalls += 1;
		this.files.set(path, { content: "", mtimeMs });
	}

	async remove(paths: string[]): Promise<void> {
		for (const path of paths) this.files.delete(path);
	}

	async move(src: string, dst: string, mtimeMs: number): Promise<void> {
		const entry = this.files.get(src);
		if (!entry) return;
		this.files.delete(src);
		this.files.set(dst, { content: entry.content, mtimeMs });
	}
}

describe("FileSessionStorage.deleteSessionWithArtifacts", () => {
	let tempDir: string;
	let storage: { deleteSessionWithArtifacts(sessionPath: string): Promise<void> };

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-storage-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	async function createSessionFile(name: string): Promise<string> {
		const sessionPath = path.join(tempDir, `${name}.jsonl`);
		await Bun.write(
			sessionPath,
			`${JSON.stringify({ type: "session", id: "session-id", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir })}\n`,
		);
		return sessionPath;
	}

	it("succeeds when the artifact directory is already absent", async () => {
		const sessionPath = await createSessionFile("missing-artifacts");
		const artifactsDir = sessionPath.slice(0, -6);

		expect(fs.existsSync(sessionPath)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(false);

		await expect(storage.deleteSessionWithArtifacts(sessionPath)).resolves.toBeUndefined();
		expect(fs.existsSync(sessionPath)).toBe(false);
		expect(fs.existsSync(artifactsDir)).toBe(false);
	});

	it("throws when artifact cleanup fails after the session file is deleted", async () => {
		const sessionPath = await createSessionFile("cleanup-failure");
		const artifactsDir = sessionPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "artifact payload");

		const rmError = new Error("permission denied");
		const rmSpy = vi.spyOn(fsp, "rm").mockRejectedValueOnce(rmError);

		await expect(storage.deleteSessionWithArtifacts(sessionPath)).rejects.toThrow(
			`Session file deleted but failed to remove artifacts directory ${artifactsDir}: permission denied`,
		);
		expect(rmSpy).toHaveBeenCalledWith(artifactsDir, { recursive: true, force: true });
		expect(fs.existsSync(sessionPath)).toBe(false);
		expect(fs.existsSync(artifactsDir)).toBe(true);
	});
});

describe("IndexedSessionStorage.writeChunksAtomic", () => {
	it("rewrites through one backend full write instead of truncate plus append", async () => {
		const backend = new IndexedMemoryBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		await storage.writeText("/sessions/p/session.jsonl", "old\n");
		backend.appendCalls = 0;
		backend.truncateCalls = 0;

		await storage.writeChunksAtomic("/sessions/p/session.jsonl", ["new", "\n"]);

		expect(await storage.readText("/sessions/p/session.jsonl")).toBe("new\n");
		expect(backend.truncateCalls).toBe(0);
		expect(backend.appendCalls).toBe(0);
	});

	it("preserves durable content when an indexed rewrite fails", async () => {
		const backend = new IndexedMemoryBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		await storage.writeText("/sessions/p/session.jsonl", "old\n");
		backend.failNextWriteFull = new Error("backend exploded");

		await expect(storage.writeChunksAtomic("/sessions/p/session.jsonl", ["new\n"])).rejects.toThrow(
			"backend exploded",
		);

		expect(await storage.readText("/sessions/p/session.jsonl")).toBe("old\n");
		expect(storage.statSync("/sessions/p/session.jsonl").size).toBe(Buffer.byteLength("old\n", "utf-8"));
	});
});
