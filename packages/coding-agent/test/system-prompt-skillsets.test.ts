import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { SkillsetActivation, SkillsetDefinition } from "@oh-my-pi/pi-coding-agent/capability/skillset";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

function source(filePath: string): SourceMeta {
	return { provider: "test", providerName: "Test", path: filePath, level: "project" };
}

function activeRustSkillset(root: string): SkillsetActivation {
	const configPath = path.join(root, ".omp", "skillsets.yaml");
	const skillset: SkillsetDefinition = {
		id: "rust",
		description: "Rust coding and review guidance",
		match: { facets: ["rust"] },
		provides: { skills: ["rust-skills"] },
		_source: source(configPath),
		source: source(configPath),
	};
	return {
		skillset,
		root,
		confidence: "strong",
		evidence: [{ kind: "rootMarker", path: path.join(root, "Cargo.toml"), value: "Cargo.toml" }],
		effects: {
			skills: ["rust-skills"],
			skillDirectories: [],
			rules: [],
			ruleDirectories: [],
			alwaysApplyRules: [],
			promptSummary: "Use rust-skills for ownership, async, errors, testing, and performance.",
			toolHints: [],
		},
	};
}

describe("system prompt skillsets", () => {
	test("renders compact active skillset metadata without loading skill content", async () => {
		const cwd = "/tmp/omp-rust-project";
		const result = await buildSystemPrompt({
			cwd,
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			skills: [
				{
					name: "rust-skills",
					description: "Rust coding, review, and refactoring guidance.",
					filePath: path.join(cwd, "external", "rust-skills", "SKILL.md"),
					baseDir: path.join(cwd, "external", "rust-skills"),
					source: "skillset:rust",
				},
			],
			activeSkillsets: [activeRustSkillset(cwd)],
			tools: new Map([["read", { label: "Read", description: "Read files" }]]),
		});
		const rendered = result.systemPrompt.join("\n");

		expect(rendered).toContain("# Active Project Skillsets");
		expect(rendered).toContain("rust: detected from Cargo.toml");
		expect(rendered).toContain("Skills: rust-skills");
		expect(rendered).toContain("Read `skill://<name>` before using an activated skill");
		expect(rendered).toContain("Use rust-skills for ownership");
		expect(rendered).not.toContain("# Own borrow over clone");
	});

	test("does not expose hidden activated skill names in skillset metadata", async () => {
		const cwd = "/tmp/omp-hidden-rust-project";
		const result = await buildSystemPrompt({
			cwd,
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			skills: [
				{
					name: "rust-skills",
					description: "Hidden Rust guidance.",
					filePath: path.join(cwd, "external", "rust-skills", "SKILL.md"),
					baseDir: path.join(cwd, "external", "rust-skills"),
					source: "skillset:rust",
					hide: true,
				},
			],
			activeSkillsets: [activeRustSkillset(cwd)],
			tools: new Map([["read", { label: "Read", description: "Read files" }]]),
		});
		const rendered = result.systemPrompt.join("\n");

		expect(rendered).not.toContain("# Active Project Skillsets");
		expect(rendered).not.toContain("Skills: rust-skills");
		expect(rendered).not.toContain("Read `skill://<name>` before using an activated skill");
		expect(rendered).not.toContain("- rust-skills: Hidden Rust guidance.");
	});
});
