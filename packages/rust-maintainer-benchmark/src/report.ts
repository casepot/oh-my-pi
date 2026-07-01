import { formatDuration, formatPercent, truncate } from "@oh-my-pi/pi-utils";
import type { RustBenchmarkResult, RustTaskResult, RustTaskRunResult } from "./runner";

function formatNumber(value: number): string {
	return value.toLocaleString();
}

function escapeMarkdown(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function formatRate(numerator: number, denominator: number): string {
	if (denominator === 0) return "—";
	return `${((numerator / denominator) * 100).toFixed(1)}% (${numerator}/${denominator})`;
}

function changedFilesText(files: readonly string[]): string {
	return files.length > 0 ? truncate(files.join(", "), 120) : "—";
}

function bestRun(task: RustTaskResult): RustTaskRunResult | undefined {
	if (task.bestRunIndex < 0) return undefined;
	return task.runs.find(run => run.runIndex === task.bestRunIndex);
}

function completedRuns(task: RustTaskResult): number {
	return task.runs.filter(
		run =>
			run.success ||
			run.tokens.total > 0 ||
			run.toolCalls.read > 0 ||
			run.toolCalls.edit > 0 ||
			run.toolCalls.write > 0 ||
			run.toolCalls.bash > 0,
	).length;
}

function exactStatus(run: RustTaskRunResult | undefined): string {
	const mode = run?.exactMatchMode ?? "disabled";
	if (mode === "disabled") return "disabled";
	const exactCheck = run?.checks.find(check => check.name === "exact match");
	const matched = run?.exactMatched ?? exactCheck?.success;
	if (matched) return `${mode} passed`;
	return mode === "required" ? "required failed" : "preferred mismatch";
}

function taskStatus(task: RustTaskResult, runsPerTask: number): string {
	const completed = completedRuns(task);
	const succeeded = task.runs.filter(run => run.success).length;
	return task.success ? `PASS (${succeeded}/${completed || runsPerTask})` : `FAIL (0/${completed || runsPerTask})`;
}

function outputExcerpt(run: RustTaskRunResult | undefined): string {
	const failed = run?.checks.find(
		check =>
			!check.success && (check.kind === "cargo" || (check.kind === undefined && check.name.startsWith("cargo "))),
	);
	if (!failed) return "—";
	const command = failed.command?.join(" ") ?? failed.name;
	const output = failed.stderr || failed.stdout || failed.error || "";
	return escapeMarkdown(truncate(`${command}: ${output}`.trim(), 180));
}

function failedCheckNames(run: RustTaskRunResult | undefined): string {
	const failed = run?.checks.filter(check => !check.success).map(check => check.name) ?? [];
	return failed.length > 0 ? failed.join(", ") : "—";
}

function appendGroupedSummary(
	lines: string[],
	title: string,
	tasks: readonly RustTaskResult[],
	field: "category" | "difficulty",
): void {
	const groups = new Map<string, RustTaskResult[]>();
	for (const task of tasks) {
		const key = task[field] ?? "unknown";
		const group = groups.get(key) ?? [];
		group.push(task);
		groups.set(key, group);
	}
	lines.push(title);
	lines.push("");
	lines.push("| Group | Tasks | Successes | Success rate | Avg best tokens | Avg best duration |");
	lines.push("|-------|-------|-----------|--------------|-----------------|-------------------|");
	for (const [group, groupTasks] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const successes = groupTasks.filter(task => task.success).length;
		const tokenTotal = groupTasks.reduce((sum, task) => sum + task.tokens.total, 0);
		const durationTotal = groupTasks.reduce((sum, task) => sum + task.duration, 0);
		const denominator = groupTasks.length || 1;
		lines.push(
			`| ${escapeMarkdown(group)} | ${groupTasks.length} | ${successes} | ${formatRate(successes, groupTasks.length)} | ${formatNumber(Math.round(tokenTotal / denominator))} | ${formatDuration(Math.round(durationTotal / denominator))} |`,
		);
	}
	lines.push("");
}

function appendFailedTasks(lines: string[], tasks: readonly RustTaskResult[]): void {
	lines.push("## Failed tasks");
	lines.push("");
	const failedTasks = tasks.filter(task => !task.success);
	if (failedTasks.length === 0) {
		lines.push("All tasks passed.");
		lines.push("");
		return;
	}

	for (const task of failedTasks) {
		const run = bestRun(task) ?? task.runs[0];
		lines.push(`### ${escapeMarkdown(task.id)}`);
		lines.push("");
		lines.push(`- Category: ${escapeMarkdown(task.category ?? "unknown")}`);
		lines.push(`- Difficulty: ${escapeMarkdown(task.difficulty ?? "unknown")}`);
		lines.push(`- Error: ${escapeMarkdown(run?.error ?? "unknown")}`);
		lines.push(`- Changed files: ${escapeMarkdown(changedFilesText(run?.changedFiles ?? []))}`);
		lines.push(`- Exact match: ${exactStatus(run)}`);
		lines.push(`- Failed checks: ${escapeMarkdown(failedCheckNames(run))}`);
		lines.push(`- Check output: ${outputExcerpt(run)}`);
		if (run?.diff) {
			lines.push("");
			lines.push("```diff");
			lines.push(run.diff);
			lines.push("```");
		}
		lines.push("");
	}
}

export function generateReport(result: RustBenchmarkResult): string {
	const { config, tasks, summary } = result;
	const lines: string[] = [];

	lines.push("# Rust Maintainer Benchmark Report");
	lines.push("");
	lines.push("## Configuration");
	lines.push("");
	lines.push("| Setting | Value |");
	lines.push("|---------|-------|");
	lines.push(`| Date | ${result.startTime} |`);
	lines.push(`| Provider | ${config.provider} |`);
	lines.push(`| Model | ${config.model} |`);
	lines.push(`| Thinking | ${config.thinkingLevel ?? "default"} |`);
	lines.push(`| Runs per task | ${config.runsPerTask} |`);
	lines.push(`| Timeout | ${formatDuration(config.timeout)} |`);
	lines.push(`| Task concurrency | ${config.taskConcurrency} |`);
	lines.push(`| Verification timeout | ${formatDuration(config.verificationTimeout ?? 60000)} |`);
	if (config.editVariant !== undefined) lines.push(`| Edit variant | ${config.editVariant} |`);
	if (config.editFuzzy !== undefined) lines.push(`| Edit fuzzy | ${config.editFuzzy} |`);
	if (config.editFuzzyThreshold !== undefined) lines.push(`| Edit fuzzy threshold | ${config.editFuzzyThreshold} |`);
	lines.push("");

	lines.push("## Summary");
	lines.push("");
	lines.push("| Metric | Value |");
	lines.push("|--------|-------|");
	lines.push(`| Total tasks | ${summary.totalTasks} |`);
	lines.push(`| Total completed runs | ${summary.totalRuns} |`);
	lines.push(`| Successful runs | ${summary.successfulRuns} |`);
	lines.push(`| Successful tasks | ${summary.successfulTasks} |`);
	lines.push(`| Task success rate | ${formatPercent(summary.taskSuccessRate)} |`);
	lines.push(`| Flaky tasks | ${summary.flakyTasks} |`);
	lines.push(`| One-shot successes | ${summary.successfulOneShotTasks} |`);
	lines.push(`| Total best-run tokens | ${formatNumber(summary.totalTokens.total)} |`);
	lines.push(`| Average best-run tokens | ${formatNumber(summary.avgTokensPerTask.total)} |`);
	lines.push(`| Median best-run tokens | ${formatNumber(summary.medianTokensPerTask.total)} |`);
	lines.push(`| Total best-run duration | ${formatDuration(summary.totalDuration)} |`);
	lines.push(`| Average best-run duration | ${formatDuration(summary.avgDurationPerTask)} |`);
	lines.push("");

	lines.push("## Exact match");
	lines.push("");
	lines.push("| Metric | Value |");
	lines.push("|--------|-------|");
	lines.push(`| Required exact-match failures | ${summary.exactMatchFailures} |`);
	lines.push(`| Preferred exact-match mismatches | ${summary.preferredExactMismatches} |`);
	lines.push(`| Allowed changed-file failures | ${summary.allowedChangedFileFailures} |`);
	lines.push("");

	lines.push("## Rust checks");
	lines.push("");
	lines.push("| Check | Failure count |");
	lines.push("|-------|---------------|");
	const checkEntries = Object.entries(summary.rustCheckFailures).sort(([left], [right]) => left.localeCompare(right));
	if (checkEntries.length === 0) {
		lines.push("| None | 0 |");
	} else {
		for (const [name, count] of checkEntries) lines.push(`| ${escapeMarkdown(name)} | ${count} |`);
	}
	lines.push("");

	appendGroupedSummary(lines, "## Category summary", tasks, "category");
	appendGroupedSummary(lines, "## Difficulty summary", tasks, "difficulty");
	appendFailedTasks(lines, tasks);

	lines.push("## Task details");
	lines.push("");
	lines.push(
		"| Task | Status | Best run | Category | Difficulty | Changed files | Exact | Checks | Tokens | Duration | Reads | Edits | Writes | Bash |",
	);
	lines.push(
		"|------|--------|----------|----------|------------|---------------|-------|--------|--------|----------|-------|-------|--------|------|",
	);
	for (const task of tasks) {
		const run = bestRun(task);
		const checks = task.checks.length > 0 ? task.checks.map(check => check.name).join(", ") : "—";
		lines.push(
			`| ${escapeMarkdown(task.id)} | ${taskStatus(task, config.runsPerTask)} | ${task.bestRunIndex >= 0 ? task.bestRunIndex + 1 : "—"} | ${escapeMarkdown(task.category ?? "unknown")} | ${escapeMarkdown(task.difficulty ?? "unknown")} | ${task.changedFiles.length} | ${exactStatus(run)} | ${escapeMarkdown(checks)} | ${formatNumber(task.tokens.total)} | ${formatDuration(task.duration)} | ${task.toolCalls.read} | ${task.toolCalls.edit} | ${task.toolCalls.write} | ${task.toolCalls.bash} |`,
		);
		if (!task.success && run?.diff && run.diff.length > 0) {
			lines.push(
				`| ${escapeMarkdown(task.id)} diff | — | — | — | — | — | — | — | — | — | — | — | — | ${escapeMarkdown(truncate(run.diff, 80))} |`,
			);
		}
	}
	lines.push("");

	return lines.join("\n");
}

export function generateJsonReport(result: RustBenchmarkResult): string {
	return JSON.stringify(result, null, 2);
}
