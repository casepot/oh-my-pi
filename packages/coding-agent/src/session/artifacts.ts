/**
 * Session-scoped artifact storage for truncated tool outputs.
 *
 * Artifacts are stored in a directory alongside the session file,
 * accessible via artifact:// URLs.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Sanitize a tool name for safe use as the middle segment of the artifact
 * filename (`${id}.${toolType}.log`). Built-in tool names are fixed, but MCP,
 * extension, and RPC-host tool names are arbitrary and may contain path
 * separators (`/`, `\`) or traversal sequences (`..`) that would otherwise let
 * a spilled artifact escape the artifacts directory. Collapse everything
 * outside `[A-Za-z0-9_-]` to `_`, and cap the length so an arbitrarily long
 * name cannot overflow the filesystem's filename limit (ENAMETOOLONG). Fall
 * back to `tool` when nothing survives.
 */
function sanitizeToolType(toolType: string): string {
	const sanitized = toolType
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.slice(0, 64)
		.replace(/^_+|_+$/g, "");
	return sanitized.length > 0 ? sanitized : "tool";
}

const ARTIFACT_REF_PATTERN = /artifact:\/\/(\d+)(?=$|[^A-Za-z0-9_-])/g;
const ARTIFACT_LOG_FILE_PATTERN = /^(\d+)\..*\.log$/;
const JSONL_SUFFIX_LENGTH = ".jsonl".length;

export interface ArtifactCopyReport {
	copiedIds: string[];
	missingIds: string[];
	failedIds: Array<{ id: string; error: string }>;
}

/**
 * Manages artifact storage for a session.
 *
 * Artifacts are stored with sequential IDs in the session's artifact directory.
 * The directory is created lazily on first write.
 *
 * Subagents do not own their own `ArtifactManager`. The parent's instance is
 * adopted via `SessionManager.adoptArtifactManager`, so the whole parent +
 * subagent tree shares one ID space and one directory.
 */
export class ArtifactManager {
	#nextId = 0;
	readonly #dir: string;
	#dirCreated = false;
	#initialized = false;

	/**
	 * @param dir Directory that will hold artifact files. Created lazily on first save.
	 */
	constructor(dir: string) {
		this.#dir = dir;
	}

	/**
	 * Artifact directory path.
	 * Directory may not exist until first artifact is saved.
	 */
	get dir(): string {
		return this.#dir;
	}

	static directoryForSessionFile(sessionFile: string | undefined): string | null {
		return sessionFile ? sessionFile.slice(0, -JSONL_SUFFIX_LENGTH) : null;
	}

	static forSessionFile(sessionFile: string | undefined): ArtifactManager | null {
		const dir = ArtifactManager.directoryForSessionFile(sessionFile);
		return dir ? new ArtifactManager(dir) : null;
	}

	async #ensureDir(): Promise<void> {
		if (!this.#dirCreated) {
			await fs.promises.mkdir(this.#dir, { recursive: true });
			this.#dirCreated = true;
		}
		if (!this.#initialized) {
			await this.#scanExistingIds();
			this.#initialized = true;
		}
	}

	#ensureDirSync(): void {
		if (!this.#dirCreated) {
			fs.mkdirSync(this.#dir, { recursive: true });
			this.#dirCreated = true;
		}
		if (!this.#initialized) {
			this.#scanExistingIdsSync();
			this.#initialized = true;
		}
	}

	/**
	 * Scan existing artifact files to find the next available ID.
	 * This ensures we don't overwrite artifacts when resuming a session.
	 */
	async #scanExistingIds(): Promise<void> {
		this.#scanExistingFiles(await this.listFiles());
	}

	#scanExistingIdsSync(): void {
		this.#scanExistingFiles(this.listFilesSync());
	}

	#scanExistingFiles(files: string[]): void {
		let maxId = -1;
		for (const file of files) {
			// Files are named: {id}.{toolType}.log
			const match = file.match(ARTIFACT_LOG_FILE_PATTERN);
			if (match) {
				const id = parseInt(match[1], 10);
				if (id > maxId) maxId = id;
			}
		}
		this.#nextId = maxId + 1;
	}

	/**
	 * Atomically allocate next artifact ID.
	 * IDs are sequential within the session.
	 */
	allocateId(): number {
		return this.#nextId++;
	}

	/**
	 * Allocate a new artifact path and ID without writing content.
	 *
	 * @param toolType Tool name for file extension (e.g., "bash", "read")
	 */
	async allocatePath(toolType: string): Promise<{ id: string; path: string }> {
		await this.#ensureDir();
		const id = String(this.allocateId());
		const filename = `${id}.${sanitizeToolType(toolType)}.log`;
		return { id, path: path.join(this.#dir, filename) };
	}

	/**
	 * Save content as an artifact and return the artifact ID.
	 *
	 * @param content Full content to save
	 * @param toolType Tool name for file extension (e.g., "bash", "read")
	 * @returns Artifact ID (numeric string)
	 */
	async save(content: string, toolType: string): Promise<string> {
		const { id, path } = await this.allocatePath(toolType);
		await Bun.write(path, content);
		return id;
	}

	/**
	 * Check if an artifact exists.
	 * @param id Artifact ID (numeric string)
	 */
	async exists(id: string): Promise<boolean> {
		const files = await this.listFiles();
		return files.some(f => f.startsWith(`${id}.`));
	}

	/**
	 * List all artifact files in the directory.
	 * Returns empty array if directory doesn't exist.
	 */
	async listFiles(): Promise<string[]> {
		try {
			return await fs.promises.readdir(this.#dir);
		} catch {
			return [];
		}
	}

	/**
	 * Synchronous variant for branch creation, which is intentionally a synchronous
	 * SessionManager API for existing callers.
	 */
	listFilesSync(): string[] {
		try {
			return fs.readdirSync(this.#dir);
		} catch {
			return [];
		}
	}

	/**
	 * Collect numeric artifact IDs referenced in persisted session payloads.
	 */
	static referencedIdsIn(value: unknown): string[] {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		if (!text) return [];

		const ids = new Set<string>();
		ARTIFACT_REF_PATTERN.lastIndex = 0;
		let match = ARTIFACT_REF_PATTERN.exec(text);
		while (match !== null) {
			ids.add(match[1]);
			match = ARTIFACT_REF_PATTERN.exec(text);
		}
		return [...ids];
	}

	/**
	 * Copy all files backing the given artifact IDs from another session's artifact
	 * directory into this manager's directory, preserving the original filenames
	 * (and therefore tool-type extensions/metadata suffixes).
	 *
	 * Missing source artifacts are reported rather than thrown so unrelated branch
	 * creation can still succeed.
	 */
	copyReferencedArtifactsFromSync(source: ArtifactManager, ids: Iterable<string>): ArtifactCopyReport {
		const report: ArtifactCopyReport = { copiedIds: [], missingIds: [], failedIds: [] };
		const sourceFiles = source.listFilesSync();
		let targetReady = false;

		for (const id of new Set(ids)) {
			const files = sourceFiles.filter(file => file.startsWith(`${id}.`));
			if (files.length === 0) {
				report.missingIds.push(id);
				continue;
			}

			try {
				if (!targetReady) {
					this.#ensureDirSync();
					targetReady = true;
				}
				for (const file of files) {
					fs.copyFileSync(path.join(source.dir, file), path.join(this.#dir, file));
				}
				report.copiedIds.push(id);
			} catch (error) {
				report.failedIds.push({ id, error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (targetReady) this.#scanExistingIdsSync();
		return report;
	}

	/**
	 * Get the full path to an artifact file.
	 * Returns null if artifact doesn't exist.
	 *
	 * @param id Artifact ID (numeric string)
	 */
	async getPath(id: string): Promise<string | null> {
		const files = await this.listFiles();
		const match = files.find(f => f.startsWith(`${id}.`));
		return match ? path.join(this.#dir, match) : null;
	}
}
