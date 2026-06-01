import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { getActiveRules, type Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getBuiltinSkillsetRules } from "@oh-my-pi/pi-coding-agent/discovery/builtin-skillsets";
import { TtsrManager, type TtsrMatchContext } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { extractTtsrFilePathsFromToolArgs } from "@oh-my-pi/pi-coding-agent/export/ttsr-paths";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function settings(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
	return Settings.isolated({
		"skills.enabled": false,
		"skillsets.enabled": true,
		"skillsets.mode": "auto",
		"ttsr.enabled": true,
		...overrides,
	});
}

interface RuleCase {
	name: string;
	positive: string;
	negatives: string[];
}

const RULE_CASES: RuleCase[] = [
	{
		name: "rs-async-std-mpsc",
		positive: "use std::sync::mpsc;\n#[tokio::test]\nasync fn sends() { let (_tx, _rx) = mpsc::channel(); }",
		negatives: [
			"use std::sync::mpsc;\nfn sends() { let (_tx, _rx) = mpsc::channel(); }",
			"use tokio::sync::mpsc;\nasync fn sends() { let (_tx, _rx) = mpsc::channel(16); }",
		],
	},
	{
		name: "rs-box-leak",
		positive: 'let static_name = Box::leak(Box::new(String::from("name")));',
		negatives: ['let name = Box::new(String::from("name"));', "let state = std::sync::Arc::new(state);"],
	},
	{
		name: "rs-error-source-chain",
		positive: "let value = read_config().map_err(|err| err.to_string())?;",
		negatives: [
			"let value = read_config().map_err(ConfigError::from)?;",
			"return Err(ApiError::BadRequest(err.to_string()));",
		],
	},
	{
		name: "rs-from-not-into",
		positive: "impl Into<String> for Name { fn into(self) -> String { self.0 } }",
		negatives: [
			"impl From<Name> for String { fn from(value: Name) -> Self { value.0 } }",
			"impl TryInto<String> for Name { type Error = Error; fn try_into(self) -> Result<String, Error> { Ok(self.0) } }",
		],
	},
	{
		name: "rs-lock-across-await",
		positive: "let guard = state.lock().unwrap();\ndo_work().await;\ndrop(guard);",
		negatives: [
			"let guard = state.lock().unwrap();\ndrop(guard);\ndo_work().await;",
			"let guard = state.lock().unwrap();\nuse_value(&guard);",
		],
	},
	{
		name: "rs-tokio-async-test",
		positive: "#[test]\nasync fn saves_record() { save().await; }",
		negatives: [
			"#[tokio::test]\nasync fn saves_record() { save().await; }",
			"#[test]\nfn parses_record() { parse(); }",
		],
	},
	{
		name: "rs-unbounded-channel",
		positive: "let (_tx, _rx) = mpsc::unbounded_channel();",
		negatives: ["let (_tx, _rx) = mpsc::channel(32);", "let sender: Sender<Event> = tx;"],
	},
];
const EXPECTED_RUST_RULE_NAMES = RULE_CASES.map(rule => rule.name).sort();

function ruleByName(name: string): Rule {
	const rule = getBuiltinSkillsetRules("rust").find(candidate => candidate.name === name);
	if (!rule) throw new Error(`missing rule ${name}`);
	return rule;
}

function matchNames(rule: Rule, text: string, context: TtsrMatchContext): string[] {
	const manager = new TtsrManager({ enabled: true });
	expect(manager.addRule(rule), `${rule.name} registers`).toBe(true);
	return manager.checkDelta(text, context).map(match => match.name);
}

describe("built-in Rust skillset TTSR pack", () => {
	let tempDir!: string;
	let homeDir!: string;
	let projectRoot!: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rust-skillset-"));
		homeDir = path.join(tempDir, "home");
		projectRoot = path.join(tempDir, "repo");
		fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
		fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
		fs.mkdirSync(homeDir, { recursive: true });
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

	test("ships only the audited first-wave Rust rule pack", () => {
		expect(
			getBuiltinSkillsetRules("rust")
				.map(rule => rule.name)
				.sort(),
		).toEqual(EXPECTED_RUST_RULE_NAMES);
	});

	test("activates only from strong Rust root markers and registers native Rust rules", async () => {
		fs.writeFileSync(path.join(projectRoot, "Cargo.toml"), '[package]\nname = "demo"\n');

		const { session } = await createAgentSession({
			cwd: projectRoot,
			agentDir: homeDir,
			sessionManager: SessionManager.inMemory(),
			enableMCP: false,
			skills: [],
			settings: settings(),
		});

		expect(session.skills).toEqual([]);
		expect(session.skillsetActivations.map(activation => activation.skillset.id)).toEqual(["rust"]);
		expect(
			session.ttsrManager
				?.checkDelta("impl Into<String> for Name {}", {
					source: "tool",
					toolName: "edit",
					filePaths: ["src/lib.rs"],
				})
				.map(rule => rule.name),
		).toEqual(["rs-from-not-into"]);
	});

	test("does not activate from weak standalone .rs evidence", async () => {
		fs.writeFileSync(path.join(projectRoot, "src", "lib.rs"), "pub fn demo() {}\n");

		const { session } = await createAgentSession({
			cwd: projectRoot,
			agentDir: homeDir,
			sessionManager: SessionManager.inMemory(),
			enableMCP: false,
			skills: [],
			settings: settings(),
		});

		expect(session.skillsetActivations.map(activation => activation.skillset.id)).toEqual([]);
		expect(
			session.ttsrManager?.checkDelta("impl Into<String> for Name {}", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/lib.rs"],
			}),
		).toEqual([]);
	});

	test("disable controls suppress the project-gated Rust pack", async () => {
		fs.writeFileSync(path.join(projectRoot, "Cargo.toml"), '[package]\nname = "demo"\n');
		for (const [label, override] of [
			["builtinRules", { "ttsr.builtinRules": false }],
			["disabledRules", { "ttsr.disabledRules": ["rs-from-not-into"] }],
			["skillset disabled", { "skillsets.disabled": ["rust"] }],
			["ttsr disabled", { "ttsr.enabled": false }],
		] as const) {
			const { session } = await createAgentSession({
				cwd: projectRoot,
				agentDir: homeDir,
				sessionManager: SessionManager.inMemory(),
				enableMCP: false,
				skills: [],
				settings: settings(override),
			});
			expect(
				session.ttsrManager?.checkDelta("impl Into<String> for Name {}", {
					source: "tool",
					toolName: "edit",
					filePaths: ["src/lib.rs"],
				}),
				label,
			).toEqual([]);
		}

		const { session } = await createAgentSession({
			cwd: projectRoot,
			agentDir: homeDir,
			sessionManager: SessionManager.inMemory(),
			enableMCP: false,
			skills: [],
			settings: settings({ disabledExtensions: ["rule:rs-from-not-into"] }),
		});
		expect(
			session.ttsrManager?.checkDelta("impl Into<String> for Name {}", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/lib.rs"],
			}),
		).toEqual([]);
	});

	test("explicit options.rules skips automatic built-in Rust rule merging", async () => {
		fs.writeFileSync(path.join(projectRoot, "Cargo.toml"), '[package]\nname = "demo"\n');

		const { session } = await createAgentSession({
			cwd: projectRoot,
			agentDir: homeDir,
			sessionManager: SessionManager.inMemory(),
			enableMCP: false,
			skills: [],
			rules: [],
			settings: settings(),
		});

		expect(session.skillsetActivations.map(activation => activation.skillset.id)).toEqual(["rust"]);
		expect(
			session.ttsrManager?.checkDelta("impl Into<String> for Name {}", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/lib.rs"],
			}),
		).toEqual([]);
	});

	test("project rules shadow same-name built-in Rust rules", async () => {
		fs.writeFileSync(path.join(projectRoot, "Cargo.toml"), '[package]\nname = "demo"\n');
		const ruleDir = path.join(projectRoot, ".omp", "rules");
		fs.mkdirSync(ruleDir, { recursive: true });
		fs.writeFileSync(
			path.join(ruleDir, "rs-from-not-into.md"),
			"---\ndescription: Project override\ncondition: PROJECT_ONLY\nscope: tool:edit(*.rs)\n---\nProject rule.\n",
		);

		const { session } = await createAgentSession({
			cwd: projectRoot,
			agentDir: homeDir,
			sessionManager: SessionManager.inMemory(),
			enableMCP: false,
			skills: [],
			settings: settings(),
		});

		expect(
			session.ttsrManager?.checkDelta("impl Into<String> for Name {}", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/lib.rs"],
			}),
		).toEqual([]);
		expect(
			session.ttsrManager
				?.checkDelta("PROJECT_ONLY", {
					source: "tool",
					toolName: "edit",
					filePaths: ["src/lib.rs"],
				})
				.map(rule => rule.name),
		).toEqual(["rs-from-not-into"]);
		expect(getActiveRules().some(rule => rule.name === "rs-from-not-into")).toBe(false);
	});

	for (const ruleCase of RULE_CASES) {
		test(`${ruleCase.name} parses, registers, scopes, and avoids rule-specific negatives`, () => {
			const rule = ruleByName(ruleCase.name);
			expect(rule._source.level).toBe("native");
			expect(rule._source.path).toStartWith("builtin://skillsets/rust/rules/");
			expect(rule.scope).toEqual(["tool:edit(*.rs)", "tool:write(*.rs)"]);
			for (const condition of rule.condition ?? []) expect(() => new RegExp(condition)).not.toThrow();

			expect(
				matchNames(rule, ruleCase.positive, { source: "tool", toolName: "write", filePaths: ["src/lib.rs"] }),
			).toEqual([ruleCase.name]);
			const editPaths = extractTtsrFilePathsFromToolArgs(
				{ input: `¶src/lib.rs#ABCD\nreplace 1..1:\n+${ruleCase.positive}\n` },
				{ cwd: projectRoot },
			);
			expect(
				matchNames(rule, ruleCase.positive, { source: "tool", toolName: "edit", filePaths: editPaths }),
			).toEqual([ruleCase.name]);
			expect(
				matchNames(rule, ruleCase.positive, { source: "tool", toolName: "edit", filePaths: ["src/lib.ts"] }),
			).toEqual([]);
			expect(
				matchNames(rule, ruleCase.positive, { source: "tool", toolName: "bash", filePaths: ["src/lib.rs"] }),
			).toEqual([]);
			for (const negative of ruleCase.negatives) {
				expect(
					matchNames(rule, negative, { source: "tool", toolName: "write", filePaths: ["src/lib.rs"] }),
					negative,
				).toEqual([]);
			}
		});
	}
});
