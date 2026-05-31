import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { loadSkillsetDefinitions } from "@oh-my-pi/pi-coding-agent/extensibility/skillsets";

function writeSkillsetConfig(filePath: string, description: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		`skillsets:\n  rust:\n    description: ${description}\n    mode: auto\n    match:\n      facets: [rust]\n    provides:\n      skills: [rust-skills]\n`,
	);
}

describe("skillset config loading", () => {
	let tempDir!: string;
	let homeDir!: string;
	let repoRoot!: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		clearCache();
		clearClaudePluginRootsCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-skillsets-config-"));
		homeDir = path.join(tempDir, "home");
		repoRoot = path.join(tempDir, "repo");
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
		fs.mkdirSync(homeDir, { recursive: true });
		originalHome = process.env.HOME;
		process.env.HOME = homeDir;
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
	});

	afterEach(() => {
		clearCache();
		clearClaudePluginRootsCache();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("project config overrides user config for the same skillset id", async () => {
		writeSkillsetConfig(path.join(homeDir, ".omp", "agent", "skillsets.yaml"), "User Rust skillset");
		writeSkillsetConfig(path.join(repoRoot, ".omp", "skillsets.yaml"), "Project Rust skillset");

		const { definitions, warnings } = await loadSkillsetDefinitions({ cwd: repoRoot });
		const rust = definitions.find(definition => definition.id === "rust");

		expect(warnings).toEqual([]);
		expect(rust?.description).toBe("Project Rust skillset");
		expect(definitions.filter(definition => definition.id === "rust")).toHaveLength(1);
	});

	test("custom skillset files have highest precedence", async () => {
		writeSkillsetConfig(path.join(repoRoot, ".omp", "skillsets.yaml"), "Project Rust skillset");
		const customFile = path.join(tempDir, "custom-skillsets.yaml");
		writeSkillsetConfig(customFile, "Custom Rust skillset");

		const { definitions } = await loadSkillsetDefinitions({ cwd: repoRoot, customFiles: [customFile] });

		expect(definitions.find(definition => definition.id === "rust")?.description).toBe("Custom Rust skillset");
	});

	test("custom skillset directories have highest precedence", async () => {
		writeSkillsetConfig(path.join(repoRoot, ".omp", "skillsets.yaml"), "Project Rust skillset");
		const customDir = path.join(tempDir, "skillset-dir");
		writeSkillsetConfig(path.join(customDir, "skillsets.yaml"), "Directory Rust skillset");

		const { definitions } = await loadSkillsetDefinitions({ cwd: repoRoot, customDirectories: [customDir] });

		expect(definitions.find(definition => definition.id === "rust")?.description).toBe("Directory Rust skillset");
	});

	test("project-scoped plugin skillsets keep project trust level", async () => {
		const pluginRoot = path.join(tempDir, "plugins", "rust-pack");
		const externalSkills = path.join(tempDir, "external-skills");
		fs.mkdirSync(pluginRoot, { recursive: true });
		fs.writeFileSync(
			path.join(pluginRoot, "skillsets.yaml"),
			`skillsets:\n  rust:\n    description: Plugin Rust skillset\n    mode: auto\n    match:\n      facets: [rust]\n    provides:\n      skillDirectories: [${externalSkills}]\n      skills: [rust-skills]\n`,
		);
		const registryPath = path.join(repoRoot, ".omp", "plugins", "installed_plugins.json");
		fs.mkdirSync(path.dirname(registryPath), { recursive: true });
		fs.writeFileSync(
			registryPath,
			JSON.stringify({
				version: 2,
				plugins: {
					"rust-pack@test": [
						{
							installPath: pluginRoot,
							version: "1.0.0",
							installedAt: "2026-05-31T00:00:00Z",
							lastUpdated: "2026-05-31T00:00:00Z",
						},
					],
				},
			}),
		);

		const { definitions } = await loadSkillsetDefinitions({ cwd: repoRoot });
		const rust = definitions.find(definition => definition.id === "rust");

		expect(rust?._source.level).toBe("project");
		expect(rust?.provides.skillDirectories).toEqual([externalSkills]);
	});

	test("invalid definition produces a warning and does not crash", async () => {
		const configPath = path.join(repoRoot, ".omp", "skillsets.yaml");
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, "skillsets:\n  broken:\n    description: Missing provides and match\n");

		const { definitions, warnings } = await loadSkillsetDefinitions({ cwd: repoRoot });

		expect(definitions).toEqual([]);
		expect(warnings.some(warning => warning.includes("Invalid skillset definition"))).toBe(true);
	});
});
