import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function writeRustSkillset(homeDir: string, externalSkills: string): void {
	fs.mkdirSync(path.join(homeDir, ".omp", "agent"), { recursive: true });
	fs.writeFileSync(
		path.join(homeDir, ".omp", "agent", "skillsets.yaml"),
		`skillsets:\n  rust:\n    description: Rust coding, review, and refactoring guidance.\n    mode: auto\n    match:\n      facets: [rust]\n    provides:\n      skillDirectories:\n        - ${externalSkills}\n      skills:\n        - rust-skills\n      promptSummary: Rust project detected. Use rust-skills for Rust work.\n`,
	);
}

function writeRustSkill(parentDir: string): void {
	const skillDir = path.join(parentDir, "rust-skills");
	fs.mkdirSync(path.join(skillDir, "rules"), { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		"---\nname: rust-skills\ndescription: Rust coding, review, and refactoring guidance.\n---\n\n# Rust Skills\n",
	);
	fs.writeFileSync(path.join(skillDir, "rules", "own-borrow-over-clone.md"), "# Own borrow over clone\n");
}

function isolatedSettings(mode: "auto" | "suggest" = "auto"): Settings {
	return Settings.isolated({
		"skills.enabled": true,
		"skills.enableCodexUser": false,
		"skills.enableClaudeUser": false,
		"skills.enableClaudeProject": false,
		"skills.enablePiUser": false,
		"skills.enablePiProject": true,
		"skillsets.enabled": true,
		"skillsets.mode": mode,
	});
}

describe("createAgentSession skillsets", () => {
	let tempDir!: string;
	let homeDir!: string;
	let projectRoot!: string;
	let externalSkills!: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sdk-skillsets-"));
		homeDir = path.join(tempDir, "home");
		projectRoot = path.join(tempDir, "repo");
		externalSkills = path.join(tempDir, "external-skills");
		fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
		fs.mkdirSync(homeDir, { recursive: true });
		fs.writeFileSync(path.join(projectRoot, "Cargo.toml"), '[package]\nname = "demo"\n');
		writeRustSkill(externalSkills);
		writeRustSkillset(homeDir, externalSkills);
		originalHome = process.env.HOME;
		process.env.HOME = homeDir;
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
	});

	afterEach(() => {
		clearCache();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("activates project skillset skills during session creation", async () => {
		const { session } = await createAgentSession({
			cwd: projectRoot,
			agentDir: homeDir,
			sessionManager: SessionManager.inMemory(),
			enableMCP: false,
			settings: isolatedSettings(),
		});

		expect(session.skills.some(skill => skill.name === "rust-skills")).toBe(true);
		expect(session.skillsetActivations.map(activation => activation.skillset.id)).toEqual(["rust"]);
		expect(session.skillsetActivations[0]?.effects.skills).toEqual(["rust-skills"]);
	});

	test("suggest mode records matching skillsets without loading skills", async () => {
		const { session } = await createAgentSession({
			cwd: projectRoot,
			agentDir: homeDir,
			sessionManager: SessionManager.inMemory(),
			enableMCP: false,
			settings: isolatedSettings("suggest"),
		});

		expect(session.skills.some(skill => skill.name === "rust-skills")).toBe(false);
		expect(session.skillsetActivations).toEqual([]);
		expect(session.suggestedSkillsets.map(activation => activation.skillset.id)).toEqual(["rust"]);
	});

	test("explicit skills option keeps prompt skills exact while preserving skillset activation", async () => {
		const { session } = await createAgentSession({
			cwd: projectRoot,
			agentDir: homeDir,
			sessionManager: SessionManager.inMemory(),
			enableMCP: false,
			skills: [],
			settings: isolatedSettings(),
		});

		expect(session.skills).toEqual([]);
		expect(session.skillsetActivations.map(activation => activation.skillset.id)).toEqual(["rust"]);
	});

	test("skillset ruleDirectories wire condition rules into session TTSR", async () => {
		const ruleDir = path.join(projectRoot, ".omp", "rules");
		fs.mkdirSync(ruleDir, { recursive: true });
		fs.writeFileSync(
			path.join(ruleDir, "no-into.md"),
			'---\ndescription: Prefer From\ncondition: "impl\\\\s+Into"\nscope: tool:edit(*.rs)\n---\nUse From.\n',
		);
		fs.writeFileSync(
			path.join(homeDir, ".omp", "agent", "skillsets.yaml"),
			`skillsets:\n  rust:\n    description: Rust TTSR rules.\n    mode: auto\n    match:\n      facets: [rust]\n    provides:\n      ruleDirectories:\n        - .omp/rules\n`,
		);

		const { session } = await createAgentSession({
			cwd: projectRoot,
			agentDir: homeDir,
			sessionManager: SessionManager.inMemory(),
			enableMCP: false,
			settings: isolatedSettings(),
		});

		expect(
			session.ttsrManager
				?.checkDelta("impl Into<String> for Name {}", {
					source: "tool",
					toolName: "edit",
					filePaths: ["src/lib.rs"],
				})
				.map(rule => rule.name),
		).toEqual(["no-into"]);
		expect(
			session.ttsrManager?.checkDelta("impl Into<String> for Name {}", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/lib.ts"],
			}),
		).toEqual([]);
	});
});
