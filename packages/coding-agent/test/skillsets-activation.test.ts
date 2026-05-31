import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SkillsetDefinition } from "@oh-my-pi/pi-coding-agent/capability/skillset";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { SkillsetsSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { compileSkillsetActivationPlan } from "@oh-my-pi/pi-coding-agent/extensibility/skillsets";
import type { ProjectFacet } from "@oh-my-pi/pi-coding-agent/project-detection";

function source(filePath: string, level: SourceMeta["level"] = "user"): SourceMeta {
	return { provider: "test", providerName: "Test", path: filePath, level };
}

function rustDefinition(
	filePath: string,
	skillDirectory: string,
	level: SourceMeta["level"] = "user",
): SkillsetDefinition {
	return {
		id: "rust",
		description: "Rust coding guidance",
		match: { facets: ["rust"] },
		provides: {
			skillDirectories: [skillDirectory],
			skills: ["rust-skills"],
			promptSummary: "Rust project detected. Use rust-skills for Rust work.",
		},
		mode: "auto",
		_source: source(filePath, level),
		source: source(filePath, level),
	};
}

function baseSettings(overrides: Partial<SkillsetsSettings> = {}): SkillsetsSettings {
	return {
		enabled: true,
		mode: "auto" as const,
		disabled: [],
		include: [],
		customFiles: [],
		customDirectories: [],
		maxAlwaysApplyChars: 12000,
		maxPromptSummaryChars: 3000,
		showDetectedInPrompt: true,
		...overrides,
	};
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

describe("skillset activation compiler", () => {
	let tempDir!: string;
	let repoRoot!: string;
	let externalSkills!: string;
	let configPath!: string;
	let rustFacet!: ProjectFacet;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-skillsets-activation-"));
		repoRoot = path.join(tempDir, "repo");
		externalSkills = path.join(tempDir, "external-skills");
		configPath = path.join(repoRoot, ".omp", "skillsets.yaml");
		fs.mkdirSync(repoRoot, { recursive: true });
		writeRustSkill(externalSkills);
		rustFacet = {
			id: "rust",
			root: repoRoot,
			confidence: "strong",
			evidence: [{ kind: "rootMarker", path: path.join(repoRoot, "Cargo.toml"), value: "Cargo.toml" }],
		};
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("Rust project activates rust-skills from parent skill directory", async () => {
		const plan = await compileSkillsetActivationPlan({
			cwd: repoRoot,
			facets: [rustFacet],
			definitions: [rustDefinition(configPath, externalSkills)],
			settings: baseSettings(),
			baseSkills: [],
		});

		expect(plan.activations.map(activation => activation.skillset.id)).toEqual(["rust"]);
		expect(plan.activations[0]?.effects.skills).toEqual(["rust-skills"]);
		expect(
			plan.skills.some(
				skill => skill.name === "rust-skills" && skill.baseDir === path.join(externalSkills, "rust-skills"),
			),
		).toBe(true);
	});

	test("non-Rust project does not activate Rust skillset", async () => {
		const plan = await compileSkillsetActivationPlan({
			cwd: repoRoot,
			facets: [{ ...rustFacet, id: "node" }],
			definitions: [rustDefinition(configPath, externalSkills)],
			settings: baseSettings(),
			baseSkills: [],
		});

		expect(plan.activations).toEqual([]);
		expect(plan.skills).toEqual([]);
	});

	test("missing skill directory emits warning", async () => {
		const missingDir = path.join(tempDir, "missing-skills");
		const plan = await compileSkillsetActivationPlan({
			cwd: repoRoot,
			facets: [rustFacet],
			definitions: [rustDefinition(configPath, missingDir)],
			settings: baseSettings(),
			baseSkills: [],
		});

		expect(
			plan.skillWarnings.some(
				warning => warning.skillPath === missingDir && warning.message.includes("does not exist"),
			),
		).toBe(true);
		expect(plan.activations[0]?.effects.skills).toEqual([]);
	});

	test("project skillsets cannot load absolute external skill directories", async () => {
		const plan = await compileSkillsetActivationPlan({
			cwd: repoRoot,
			facets: [rustFacet],
			definitions: [rustDefinition(configPath, externalSkills, "project")],
			settings: baseSettings(),
			baseSkills: [],
		});

		expect(plan.activations[0]?.effects.skills).toEqual([]);
		expect(plan.skillWarnings.some(warning => warning.message.includes("must be relative to the project root"))).toBe(
			true,
		);
		expect(plan.skills.some(skill => skill.name === "rust-skills")).toBe(false);
	});

	test("project skillsets cannot load symlinked external skill children", async () => {
		const projectSkillParent = path.join(repoRoot, ".omp", "project-skills");
		fs.mkdirSync(projectSkillParent, { recursive: true });
		fs.symlinkSync(path.join(externalSkills, "rust-skills"), path.join(projectSkillParent, "rust-skills"), "dir");

		const plan = await compileSkillsetActivationPlan({
			cwd: repoRoot,
			facets: [rustFacet],
			definitions: [rustDefinition(configPath, ".omp/project-skills", "project")],
			settings: baseSettings(),
			baseSkills: [],
		});

		expect(plan.activations[0]?.effects.skills).toEqual([]);
		expect(plan.skillWarnings.some(warning => warning.message.includes("skill file escapes the project root"))).toBe(
			true,
		);
		expect(plan.skills.some(skill => skill.name === "rust-skills")).toBe(false);
	});

	test("skill filters apply to skillset-loaded skills", async () => {
		const plan = await compileSkillsetActivationPlan({
			cwd: repoRoot,
			facets: [rustFacet],
			definitions: [rustDefinition(configPath, externalSkills)],
			settings: baseSettings(),
			baseSkills: [],
			disabledExtensions: ["skill:rust-skills"],
			skillsSettings: { enabled: true },
		});

		expect(plan.activations[0]?.effects.skills).toEqual([]);
		expect(plan.skills.some(skill => skill.name === "rust-skills")).toBe(false);
	});

	test("dependency file matchers cannot escape candidate roots", async () => {
		const outsideFile = path.join(tempDir, "outside.toml");
		fs.writeFileSync(outsideFile, "secret = true\n");
		const escapingDefinition: SkillsetDefinition = {
			...rustDefinition(configPath, externalSkills),
			match: { dependencyFiles: [{ path: path.relative(repoRoot, outsideFile), contains: ["secret"] }] },
		};

		const plan = await compileSkillsetActivationPlan({
			cwd: repoRoot,
			facets: [],
			definitions: [escapingDefinition],
			settings: baseSettings(),
			baseSkills: [],
		});

		expect(plan.activations).toEqual([]);
	});

	test("root marker and file glob matchers cannot escape candidate roots", async () => {
		const outsideFile = path.join(tempDir, "outside.marker");
		fs.writeFileSync(outsideFile, "outside\n");
		const escapePath = path.relative(repoRoot, outsideFile);
		const rootMarkerDefinition: SkillsetDefinition = {
			...rustDefinition(configPath, externalSkills),
			match: { rootMarkers: [escapePath] },
		};
		const fileGlobDefinition: SkillsetDefinition = {
			...rustDefinition(configPath, externalSkills),
			id: "rust-glob",
			match: { fileGlobs: [escapePath] },
		};

		const plan = await compileSkillsetActivationPlan({
			cwd: repoRoot,
			facets: [],
			definitions: [rootMarkerDefinition, fileGlobDefinition],
			settings: baseSettings(),
			baseSkills: [],
		});

		expect(plan.activations).toEqual([]);
	});

	test("global suggest mode surfaces suggestions without loading skills", async () => {
		const plan = await compileSkillsetActivationPlan({
			cwd: repoRoot,
			facets: [rustFacet],
			definitions: [rustDefinition(configPath, externalSkills)],
			settings: baseSettings({ mode: "suggest" }),
			baseSkills: [],
		});

		expect(plan.activations).toEqual([]);
		expect(plan.suggestions.map(suggestion => suggestion.skillset.id)).toEqual(["rust"]);
		expect(plan.skills).toEqual([]);
	});

	test("disabled and include settings narrow the active set", async () => {
		const rust = rustDefinition(configPath, externalSkills);
		const node: SkillsetDefinition = {
			...rustDefinition(configPath, externalSkills),
			id: "node",
			description: "Node guidance",
			match: { facets: ["node"] },
		};
		const plan = await compileSkillsetActivationPlan({
			cwd: repoRoot,
			facets: [rustFacet, { ...rustFacet, id: "node" }],
			definitions: [rust, node],
			settings: baseSettings({ include: ["rust"], disabled: ["rust"] }),
			baseSkills: [],
		});

		expect(plan.activations).toEqual([]);
		expect(plan.skills).toEqual([]);
	});

	test("prompt summaries are truncated by the activation compiler", async () => {
		const definition = rustDefinition(configPath, externalSkills);
		definition.provides.promptSummary = "abcdefghijklmnopqrstuvwxyz";

		const plan = await compileSkillsetActivationPlan({
			cwd: repoRoot,
			facets: [rustFacet],
			definitions: [definition],
			settings: baseSettings({ maxPromptSummaryChars: 8 }),
			baseSkills: [],
		});

		expect(plan.activations[0]?.effects.promptSummary).toBe("abcdefgh");
	});
});
