import * as path from "node:path";
import { diffLines } from "diff";
import type { CargoCommandResult } from "./cargo";
import { runCargoCommand } from "./cargo";
import { listFiles, RUST_BENCH_IGNORED_DIRS, RUST_BENCH_IGNORED_FILES } from "./shared";
import type { RustTask } from "./tasks";

export interface DiffStats {
	linesChanged: number;
	charsChanged: number;
}

export interface RustCheckResult {
	name: string;
	success: boolean;
	command?: string[];
	exitCode?: number | null;
	stdout?: string;
	stderr?: string;
	duration?: number;
	timedOut?: boolean;
	kind?: "metadata" | "exact" | "cargo";
	required?: boolean;
	error?: string;
}

export interface RustVerificationResult {
	success: boolean;
	duration: number;
	error?: string;
	diff?: string;
	diffStats?: DiffStats;
	exactMatched?: boolean;
	changedFiles: string[];
	checks: RustCheckResult[];
}

export interface VerifyRustTaskOptions {
	actualDir: string;
	timeoutMs: number;
}

function formatFileList(files: readonly string[]): string {
	return files.length === 0 ? "(none)" : files.join(", ");
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function splitLines(value: string): string[] {
	return value.split("\n").filter((line, index, lines) => index < lines.length - 1 || line.length > 0);
}

function toPosixPath(filePath: string): string {
	return filePath.split(path.sep).join("/");
}

async function comparableFiles(rootDir: string): Promise<string[]> {
	return (await listFiles(rootDir, "", { ignoreDirs: RUST_BENCH_IGNORED_DIRS, ignoreFiles: RUST_BENCH_IGNORED_FILES }))
		.map(toPosixPath)
		.sort();
}

function createCompactDiff(expected: string, actual: string, contextLines = 3): string {
	const changes = diffLines(expected, actual);
	const output: string[] = [];
	let lineNum = 1;

	for (let i = 0; i < changes.length; i++) {
		const change = changes[i]!;
		const lines = splitLines(change.value);

		if (change.added || change.removed) {
			if (i > 0 && !changes[i - 1]!.added && !changes[i - 1]!.removed) {
				const previousLines = splitLines(changes[i - 1]!.value);
				const contextStart = Math.max(0, previousLines.length - contextLines);
				if (contextStart > 0) output.push(`@@ -${lineNum - (previousLines.length - contextStart)} @@`);
				for (let j = contextStart; j < previousLines.length; j++) output.push(` ${previousLines[j]}`);
			}

			const prefix = change.added ? "+" : "-";
			for (const line of lines) output.push(`${prefix}${line}`);

			if (i + 1 < changes.length && !changes[i + 1]!.added && !changes[i + 1]!.removed) {
				const nextLines = splitLines(changes[i + 1]!.value);
				const contextEnd = Math.min(nextLines.length, contextLines);
				for (let j = 0; j < contextEnd; j++) output.push(` ${nextLines[j]}`);
			}

			if (!change.added) lineNum += lines.length;
		} else {
			lineNum += lines.length;
		}
	}

	return output.join("\n");
}

function computeDiffStats(expected: string, actual: string): DiffStats {
	const changes = diffLines(expected, actual);
	let linesChanged = 0;
	let charsChanged = 0;

	for (const change of changes) {
		if (!change.added && !change.removed) continue;
		linesChanged += splitLines(change.value).length;
		charsChanged += change.value.length;
	}

	return { linesChanged, charsChanged };
}

async function readNormalized(filePath: string): Promise<string> {
	return normalizeLineEndings(await Bun.file(filePath).text());
}

export async function verifyExpectedFiles(expectedDir: string, actualDir: string): Promise<RustVerificationResult> {
	return verifyExpectedFileSubset(expectedDir, actualDir);
}

export async function verifyExpectedFileSubset(
	expectedDir: string,
	actualDir: string,
	files?: string[],
): Promise<RustVerificationResult> {
	const start = performance.now();

	try {
		const expectedFixtureFiles = await comparableFiles(expectedDir);
		const expectedFiles = files?.length ? files.map(toPosixPath).sort() : expectedFixtureFiles;
		const actualFiles = await comparableFiles(actualDir);
		const missingExpected = expectedFiles.filter(file => !expectedFixtureFiles.includes(file));
		const missingFiles = expectedFiles.filter(file => !actualFiles.includes(file));
		const extraFiles = actualFiles.filter(file => !expectedFiles.includes(file));

		if (missingExpected.length > 0) {
			return {
				success: false,
				error: `Expected files missing from fixture: ${formatFileList(missingExpected)}`,
				duration: performance.now() - start,
				exactMatched: false,
				changedFiles: [],
				checks: [],
			};
		}

		if (missingFiles.length > 0 || (files === undefined && extraFiles.length > 0)) {
			const parts: string[] = [];
			if (missingFiles.length > 0) parts.push(`Missing files: ${formatFileList(missingFiles)}`);
			if (files === undefined && extraFiles.length > 0)
				parts.push(`Unexpected files: ${formatFileList(extraFiles)}`);
			return {
				success: false,
				error: parts.join("; "),
				duration: performance.now() - start,
				exactMatched: false,
				changedFiles: [],
				checks: [],
			};
		}

		for (const file of expectedFiles) {
			const expected = await readNormalized(path.join(expectedDir, file));
			const actual = await readNormalized(path.join(actualDir, file));
			if (expected !== actual) {
				const diff = createCompactDiff(expected, actual);
				return {
					success: false,
					error: `File mismatch for ${file}`,
					duration: performance.now() - start,
					diff,
					diffStats: computeDiffStats(expected, actual),
					exactMatched: false,
					changedFiles: [],
					checks: [],
				};
			}
		}

		return {
			success: true,
			duration: performance.now() - start,
			diffStats: { linesChanged: 0, charsChanged: 0 },
			exactMatched: true,
			changedFiles: [],
			checks: [],
		};
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
			duration: performance.now() - start,
			exactMatched: false,
			changedFiles: [],
			checks: [],
		};
	}
}

async function computeChangedFiles(inputDir: string, actualDir: string): Promise<string[]> {
	const inputFiles = await comparableFiles(inputDir);
	const actualFiles = await comparableFiles(actualDir);
	const allFiles = Array.from(new Set([...inputFiles, ...actualFiles])).sort();
	const changedFiles: string[] = [];
	for (const file of allFiles) {
		if (!inputFiles.includes(file) || !actualFiles.includes(file)) {
			changedFiles.push(file);
			continue;
		}
		const input = await readNormalized(path.join(inputDir, file));
		const actual = await readNormalized(path.join(actualDir, file));
		if (input !== actual) changedFiles.push(file);
	}
	return changedFiles;
}

function toCheckResult(result: CargoCommandResult): RustCheckResult {
	const success = result.exitCode === 0 && !result.timedOut;
	return {
		name: result.name,
		success,
		command: ["cargo", ...result.args],
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		duration: result.duration,
		timedOut: result.timedOut,
		kind: "cargo",
		required: true,
	};
}

async function runRustCheck(params: {
	name: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	targetDir: string;
}): Promise<RustCheckResult> {
	try {
		return toCheckResult(await runCargoCommand(params));
	} catch (err) {
		return {
			name: params.name,
			success: false,
			command: ["cargo", ...params.args],
			kind: "cargo",
			required: true,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function failedCheckError(check: RustCheckResult): string {
	return check.timedOut ? `${check.name} timed out` : `${check.name} failed`;
}

function failedRequiredCheckError(check: RustCheckResult): string {
	if (check.kind === "cargo" || (check.kind === undefined && check.name.startsWith("cargo "))) {
		return failedCheckError(check);
	}
	return check.error ?? failedCheckError(check);
}

export async function verifyRustTask(task: RustTask, options: VerifyRustTaskOptions): Promise<RustVerificationResult> {
	const start = performance.now();
	const checks: RustCheckResult[] = [];
	const changedFiles = await computeChangedFiles(task.inputDir, options.actualDir);
	const allowedChangedFiles = task.metadata.verification.allowedChangedFiles;
	if (allowedChangedFiles) {
		const unexpected = changedFiles.filter(file => !allowedChangedFiles.includes(file));
		checks.push({
			name: "allowed changed files",
			kind: "metadata",
			required: true,
			success: unexpected.length === 0,
			error: unexpected.length === 0 ? undefined : `Unexpected changed files: ${unexpected.join(", ")}`,
		});
	}

	let diff: string | undefined;
	let diffStats: DiffStats | undefined;
	let exactMatched: boolean | undefined;
	const exactMode = task.metadata.verification.exactMatch;
	if (exactMode === "required" || exactMode === "preferred") {
		const exact = await verifyExpectedFileSubset(task.expectedDir, options.actualDir);
		diff = exact.diff;
		diffStats = exact.diffStats;
		exactMatched = exact.success;
		checks.push({
			name: "exact match",
			kind: "exact",
			required: exactMode === "required",
			success: exact.success,
			error: exact.success ? undefined : exact.error,
		});
	}

	const crateRoot = path.join(options.actualDir, task.metadata.crateRoot);
	const targetDir = path.join(options.actualDir, ".cargo-target");
	if (task.metadata.verification.rustfmt) {
		const check = await runRustCheck({
			name: "cargo fmt",
			args: ["fmt", "--", "--check"],
			cwd: crateRoot,
			timeoutMs: options.timeoutMs,
			targetDir,
		});
		checks.push(check);
	}

	for (const command of task.metadata.verification.commands) {
		const check = await runRustCheck({
			name: command.name,
			args: command.args,
			cwd: crateRoot,
			timeoutMs: options.timeoutMs,
			targetDir,
		});
		checks.push(check);
	}

	const firstFailedRequiredCheck = checks.find(check => !check.success && check.required !== false);
	const success = firstFailedRequiredCheck === undefined;

	return {
		success,
		duration: performance.now() - start,
		error: firstFailedRequiredCheck ? failedRequiredCheckError(firstFailedRequiredCheck) : undefined,
		diff,
		diffStats,
		exactMatched,
		changedFiles,
		checks,
	};
}
