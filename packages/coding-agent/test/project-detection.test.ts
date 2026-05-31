import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { clearProjectDetectionCacheForTests, detectProjectFacets } from "@oh-my-pi/pi-coding-agent/project-detection";

function touch(filePath: string, content = ""): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

describe("project detection", () => {
	let tempDir!: string;
	let repoRoot!: string;

	beforeEach(() => {
		clearCache();
		clearProjectDetectionCacheForTests();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-project-detection-"));
		repoRoot = path.join(tempDir, "repo");
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
	});

	afterEach(() => {
		clearCache();
		clearProjectDetectionCacheForTests();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("detects Rust from Cargo.toml with marker evidence", async () => {
		touch(path.join(repoRoot, "Cargo.toml"), '[package]\nname = "demo"\n');

		const facets = await detectProjectFacets({ cwd: repoRoot, repoRoot });
		const rust = facets.find(facet => facet.id === "rust");

		expect(rust?.root).toBe(repoRoot);
		expect(rust?.confidence).toBe("strong");
		expect(rust?.evidence[0]).toMatchObject({ kind: "rootMarker", value: "Cargo.toml" });
		expect(rust?.evidence[0]?.path).toBe(path.join(repoRoot, "Cargo.toml"));
	});

	test("detects Node from package.json", async () => {
		touch(path.join(repoRoot, "package.json"), '{"name":"demo"}');

		const facets = await detectProjectFacets({ cwd: repoRoot, repoRoot });

		expect(facets.some(facet => facet.id === "node" && facet.root === repoRoot)).toBe(true);
	});

	test("uses nearest nested monorepo package root", async () => {
		const appRoot = path.join(repoRoot, "packages", "app");
		touch(path.join(repoRoot, "package.json"), '{"workspaces":["packages/*"]}');
		touch(path.join(appRoot, "package.json"), '{"name":"app"}');

		const facets = await detectProjectFacets({ cwd: appRoot, repoRoot });
		const node = facets.find(facet => facet.id === "node");

		expect(node?.root).toBe(appRoot);
		expect(node?.evidence.some(evidence => evidence.path === path.join(appRoot, "package.json"))).toBe(true);
	});

	test("returns weak file evidence for unmarked source file", async () => {
		const crateDir = path.join(repoRoot, "scratch");
		touch(path.join(crateDir, "main.rs"), "fn main() {}\n");

		const facets = await detectProjectFacets({ cwd: crateDir, repoRoot });
		const rust = facets.find(facet => facet.id === "rust");

		expect(rust?.confidence).toBe("weak");
		expect(rust?.evidence[0]).toMatchObject({ kind: "fileGlob", value: "**/*.rs" });
	});

	test("handles no match without returning facets", async () => {
		const emptyProject = path.join(repoRoot, "empty");
		fs.mkdirSync(emptyProject, { recursive: true });

		const facets = await detectProjectFacets({ cwd: emptyProject, repoRoot });

		expect(facets).toEqual([]);
	});
});
