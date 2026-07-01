import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ListFilesOptions {
	ignoreDirs?: ReadonlySet<string>;
	ignoreFiles?: ReadonlySet<string>;
}

export const RUST_BENCH_IGNORED_DIRS = new Set(["target", ".cargo-target", ".git"]);
export const RUST_BENCH_IGNORED_FILES = new Set(["Cargo.lock"]);

export async function listFiles(rootDir: string, subPath = "", options: ListFilesOptions = {}): Promise<string[]> {
	const entries = await fs.readdir(path.join(rootDir, subPath), { withFileTypes: true });
	const files: string[] = [];
	const ignoreDirs = options.ignoreDirs ?? new Set<string>();
	const ignoreFiles = options.ignoreFiles ?? new Set<string>();

	for (const entry of entries) {
		const relativePath = path.join(subPath, entry.name);
		if (entry.isDirectory()) {
			if (ignoreDirs.has(entry.name)) continue;
			files.push(...(await listFiles(rootDir, relativePath, options)));
		} else if (entry.isFile()) {
			if (ignoreFiles.has(entry.name)) continue;
			files.push(relativePath);
		}
	}

	return files.sort();
}
