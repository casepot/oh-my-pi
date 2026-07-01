import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listFiles, RUST_BENCH_IGNORED_DIRS, RUST_BENCH_IGNORED_FILES } from "./shared";

export type RustTaskCategory =
	| "surgical"
	| "compiler-repair"
	| "error-handling"
	| "api-migration"
	| "workspace-migration";

export type ExactMatchMode = "required" | "preferred" | "disabled";

export interface RustCommandSpec {
	name: string;
	args: string[];
}

export interface RustVerificationSpec {
	rustfmt: boolean;
	exactMatch: ExactMatchMode;
	commands: RustCommandSpec[];
	allowedChangedFiles?: string[];
}

export interface RustTaskMetadata {
	category: RustTaskCategory;
	difficulty: "easy" | "medium" | "hard" | "nightmare";
	difficultyScore?: number;
	crateRoot: string;
	verification: RustVerificationSpec;
	filePath?: string;
	lineNumber?: number;
	originalSnippet?: string;
	expectedSnippet?: string;
}

export interface RustTask {
	id: string;
	name: string;
	prompt: string;
	files: string[];
	inputDir: string;
	expectedDir: string;
	metadata: RustTaskMetadata;
}

export interface FixtureValidationIssue {
	taskId: string;
	message: string;
}

const RUST_TASK_CATEGORIES = [
	"surgical",
	"compiler-repair",
	"error-handling",
	"api-migration",
	"workspace-migration",
] as const;
const RUST_TASK_DIFFICULTIES = ["easy", "medium", "hard", "nightmare"] as const;
const EXACT_MATCH_MODES = ["required", "preferred", "disabled"] as const;

const DEFAULT_COMMANDS: RustCommandSpec[] = [
	{ name: "cargo check", args: ["check", "--color", "never"] },
	{ name: "cargo test", args: ["test", "--lib", "--color", "never"] },
];

function titleize(id: string): string {
	return id
		.split(/[-_]/)
		.map(part => (part ? part[0].toUpperCase() + part.slice(1) : part))
		.join(" ");
}

function toPosixPath(filePath: string): string {
	return filePath.split(path.sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
	return typeof value === "string" && values.some(entry => entry === value);
}

function cloneCommands(commands: readonly RustCommandSpec[]): RustCommandSpec[] {
	return commands.map(command => ({ name: command.name, args: [...command.args] }));
}

async function comparableFiles(rootDir: string): Promise<string[]> {
	return (await listFiles(rootDir, "", { ignoreDirs: RUST_BENCH_IGNORED_DIRS, ignoreFiles: RUST_BENCH_IGNORED_FILES }))
		.map(toPosixPath)
		.sort();
}

async function directoryExists(dir: string): Promise<boolean> {
	const stat = await fs.stat(dir).catch(() => null);
	return stat?.isDirectory() ?? false;
}

const FORBIDDEN_FIXTURE_DIRS = new Set(["target", ".cargo-target", ".git"]);
const FORBIDDEN_FIXTURE_FILES = new Set(["Cargo.lock"]);

async function collectForbiddenFixtureArtifacts(rootDir: string, subPath = ""): Promise<string[]> {
	const artifacts: string[] = [];
	const entries = await fs.readdir(path.join(rootDir, subPath), { withFileTypes: true });
	for (const entry of entries) {
		const relativePath = toPosixPath(path.join(subPath, entry.name));
		if (entry.isDirectory()) {
			if (FORBIDDEN_FIXTURE_DIRS.has(entry.name)) {
				artifacts.push(relativePath);
				continue;
			}
			artifacts.push(...(await collectForbiddenFixtureArtifacts(rootDir, relativePath)));
			continue;
		}
		if (entry.isFile() && FORBIDDEN_FIXTURE_FILES.has(entry.name)) artifacts.push(relativePath);
	}
	return artifacts.sort();
}

async function validateExactRequiredRustComments(params: {
	taskId: string;
	rootDir: string;
	treeName: "input" | "expected";
	issues: FixtureValidationIssue[];
}): Promise<void> {
	const files = (await comparableFiles(params.rootDir)).filter(file => file.endsWith(".rs"));
	for (const file of files) {
		const text = await Bun.file(path.join(params.rootDir, file)).text();
		if (text.includes("Benchmark fixture rationale")) {
			params.issues.push({
				taskId: params.taskId,
				message: `exact-match fixture contains benchmark rationale comment: ${params.treeName}/${file}`,
			});
		}
	}
}

async function loadMetadata(metadataPath: string): Promise<RustTaskMetadata> {
	const file = Bun.file(metadataPath);
	if (!(await file.exists()))
		throw new Error(`Missing metadata.json for ${path.basename(path.dirname(metadataPath))}`);
	let raw: unknown;
	try {
		raw = JSON.parse(await file.text());
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		throw new Error(`Invalid metadata.json for ${path.basename(path.dirname(metadataPath))}: ${error}`);
	}
	const parsed = parseTaskMetadata(raw);
	if (parsed.issues.length > 0 || !parsed.metadata) {
		throw new Error(
			`Invalid metadata.json for ${path.basename(path.dirname(metadataPath))}: ${parsed.issues.join("; ")}`,
		);
	}
	return parsed.metadata;
}

export async function loadTasksFromDir(fixturesDir: string): Promise<RustTask[]> {
	const entries = await fs.readdir(fixturesDir, { withFileTypes: true });
	const tasks: RustTask[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const challengeDir = path.join(fixturesDir, entry.name);
		const promptPath = path.join(challengeDir, "prompt.md");
		const inputDir = path.join(challengeDir, "input");
		const expectedDir = path.join(challengeDir, "expected");
		const metadataPath = path.join(challengeDir, "metadata.json");

		const promptFile = Bun.file(promptPath);
		if (!(await promptFile.exists())) throw new Error(`Missing prompt.md for ${entry.name}`);
		const prompt = (await promptFile.text()).trim();
		if (prompt.length === 0) throw new Error(`Empty prompt.md for ${entry.name}`);
		if (!(await directoryExists(inputDir))) throw new Error(`Missing input directory for ${entry.name}`);
		if (!(await directoryExists(expectedDir))) throw new Error(`Missing expected directory for ${entry.name}`);

		const metadata = await loadMetadata(metadataPath);
		const files = await comparableFiles(inputDir);

		tasks.push({
			id: entry.name,
			name: titleize(entry.name),
			prompt,
			inputDir,
			expectedDir,
			files,
			metadata,
		});
	}

	return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

export async function validateFixturesFromDir(fixturesPath: string): Promise<FixtureValidationIssue[]> {
	const entries = await fs.readdir(fixturesPath, { withFileTypes: true });
	const issues: FixtureValidationIssue[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const taskId = entry.name;
		const challengeDir = path.join(fixturesPath, entry.name);
		const promptPath = path.join(challengeDir, "prompt.md");
		const inputDir = path.join(challengeDir, "input");
		const expectedDir = path.join(challengeDir, "expected");
		const metadataPath = path.join(challengeDir, "metadata.json");

		const promptFile = Bun.file(promptPath);
		if (!(await promptFile.exists())) {
			issues.push({ taskId, message: "prompt.md is missing" });
		} else if ((await promptFile.text()).trim().length === 0) {
			issues.push({ taskId, message: "prompt.md is empty" });
		}

		const inputExists = await directoryExists(inputDir);
		const expectedExists = await directoryExists(expectedDir);
		if (!inputExists) issues.push({ taskId, message: "input directory is missing" });
		if (!expectedExists) issues.push({ taskId, message: "expected directory is missing" });

		const metadataFile = Bun.file(metadataPath);
		if (!(await metadataFile.exists())) {
			issues.push({ taskId, message: "metadata.json is missing" });
			continue;
		}

		let raw: unknown;
		try {
			raw = JSON.parse(await metadataFile.text());
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			issues.push({ taskId, message: `metadata.json is invalid JSON: ${error}` });
			continue;
		}

		const parsed = parseTaskMetadata(raw);
		for (const message of parsed.issues) issues.push({ taskId, message });
		if (!parsed.metadata) continue;

		for (const root of [
			{ exists: inputExists, dir: inputDir, name: "input" },
			{ exists: expectedExists, dir: expectedDir, name: "expected" },
		]) {
			if (!root.exists) continue;
			for (const artifactPath of await collectForbiddenFixtureArtifacts(root.dir)) {
				issues.push({ taskId, message: `generated artifact must not be committed: ${root.name}/${artifactPath}` });
			}
		}

		if (parsed.metadata.verification.exactMatch === "required" && parsed.metadata.category !== "surgical") {
			issues.push({ taskId, message: "exact_match required is reserved for surgical deterministic fixtures" });
		}

		if (parsed.metadata.verification.exactMatch === "required") {
			if (inputExists) {
				await validateExactRequiredRustComments({ taskId, rootDir: inputDir, treeName: "input", issues });
			}
			if (expectedExists) {
				await validateExactRequiredRustComments({ taskId, rootDir: expectedDir, treeName: "expected", issues });
			}
		}

		if (inputExists && !(await directoryExists(path.join(inputDir, parsed.metadata.crateRoot)))) {
			issues.push({ taskId, message: `crate_root ${parsed.metadata.crateRoot} is missing in input` });
		}
		if (expectedExists && !(await directoryExists(path.join(expectedDir, parsed.metadata.crateRoot)))) {
			issues.push({ taskId, message: `crate_root ${parsed.metadata.crateRoot} is missing in expected` });
		}
		if (expectedExists && parsed.metadata.verification.allowedChangedFiles) {
			const expectedFiles = new Set(await comparableFiles(expectedDir));
			for (const file of parsed.metadata.verification.allowedChangedFiles) {
				if (!expectedFiles.has(file))
					issues.push({ taskId, message: `allowed_changed_files entry ${file} is missing in expected` });
			}
		}
	}

	return issues;
}

function parseTaskMetadata(raw: unknown): { metadata?: RustTaskMetadata; issues: string[] } {
	const issues: string[] = [];
	if (!isRecord(raw)) return { issues: ["metadata.json must be an object"] };

	const category = isOneOf(raw.category, RUST_TASK_CATEGORIES) ? raw.category : undefined;
	const difficulty = isOneOf(raw.difficulty, RUST_TASK_DIFFICULTIES) ? raw.difficulty : undefined;
	const crateRoot =
		typeof raw.crate_root === "string" && raw.crate_root.trim().length > 0 ? raw.crate_root : undefined;
	if (!category) issues.push("metadata.json missing category");
	if (!difficulty) issues.push("metadata.json missing difficulty");
	if (!crateRoot) issues.push("metadata.json missing crate_root");

	const verification = parseVerification(raw.verification, issues);
	if (!category || !difficulty || !crateRoot || !verification) return { issues };

	const metadata: RustTaskMetadata = { category, difficulty, crateRoot, verification };
	if (typeof raw.difficulty_score === "number") metadata.difficultyScore = raw.difficulty_score;
	if (typeof raw.file_path === "string") metadata.filePath = raw.file_path;
	if (typeof raw.line_number === "number") metadata.lineNumber = raw.line_number;
	if (typeof raw.original_snippet === "string") metadata.originalSnippet = raw.original_snippet;
	if (typeof raw.expected_snippet === "string") metadata.expectedSnippet = raw.expected_snippet;
	return { metadata, issues };
}

function parseVerification(raw: unknown, issues: string[]): RustVerificationSpec | undefined {
	if (!isRecord(raw)) {
		issues.push("metadata.json missing verification");
		return undefined;
	}

	let rustfmt = true;
	if (typeof raw.rustfmt === "boolean") {
		rustfmt = raw.rustfmt;
	} else if (raw.rustfmt !== undefined) {
		issues.push("verification.rustfmt must be boolean");
	}

	let exactMatch: ExactMatchMode = "required";
	if (isOneOf(raw.exact_match, EXACT_MATCH_MODES)) {
		exactMatch = raw.exact_match;
	} else if (raw.exact_match !== undefined) {
		issues.push("verification.exact_match is invalid");
	}

	const commands = parseCommands(raw.commands, issues);
	const allowedChangedFiles = parseStringArray(
		raw.allowed_changed_files,
		"verification.allowed_changed_files",
		issues,
	);
	if (!commands) return undefined;

	return {
		rustfmt,
		exactMatch,
		commands,
		...(allowedChangedFiles ? { allowedChangedFiles } : {}),
	};
}

function parseCommands(raw: unknown, issues: string[]): RustCommandSpec[] | undefined {
	if (raw === undefined) return cloneCommands(DEFAULT_COMMANDS);
	if (!Array.isArray(raw)) {
		issues.push("verification.commands must be an array");
		return undefined;
	}
	const commands: RustCommandSpec[] = [];
	for (const [index, command] of raw.entries()) {
		if (!isRecord(command)) {
			issues.push(`verification.commands[${index}] must be an object`);
			continue;
		}
		const name = typeof command.name === "string" ? command.name.trim() : "";
		const args = Array.isArray(command.args) ? command.args : undefined;
		if (name.length === 0) issues.push(`verification.commands[${index}].name must be non-empty`);
		if (!args || args.length === 0) {
			issues.push(`verification.commands[${index}].args must be a non-empty string array`);
			continue;
		}
		const parsedArgs: string[] = [];
		for (const [argIndex, arg] of args.entries()) {
			if (typeof arg !== "string" || arg.trim().length === 0) {
				issues.push(`verification.commands[${index}].args[${argIndex}] must be a non-empty string`);
				continue;
			}
			parsedArgs.push(arg);
		}
		if (name.length > 0 && parsedArgs.length === args.length) commands.push({ name, args: parsedArgs });
	}
	return commands;
}

function parseStringArray(raw: unknown, name: string, issues: string[]): string[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		issues.push(`${name} must be an array`);
		return undefined;
	}
	const values: string[] = [];
	for (const [index, value] of raw.entries()) {
		if (typeof value !== "string" || value.trim().length === 0) {
			issues.push(`${name}[${index}] must be a non-empty string`);
			continue;
		}
		values.push(value);
	}
	return values;
}
