import { describe, expect, it } from "bun:test";
import { generateJsonReport, generateReport } from "@oh-my-pi/rust-maintainer-benchmark/report";
import type { RustBenchmarkResult } from "@oh-my-pi/rust-maintainer-benchmark/runner";

function createResult(): RustBenchmarkResult {
	return {
		config: {
			provider: "anthropic",
			model: "claude",
			runsPerTask: 1,
			timeout: 180000,
			taskConcurrency: 1,
			verificationTimeout: 60000,
		},
		startTime: "2026-07-01T00:00:00.000Z",
		endTime: "2026-07-01T00:00:01.000Z",
		tasks: [
			{
				id: "compiler-move-after-iter-001",
				name: "compiler-move-after-iter-001",
				files: ["src/lib.rs"],
				category: "compiler-repair",
				difficulty: "easy",
				runs: [
					{
						runIndex: 0,
						success: false,
						patchApplied: true,
						verificationPassed: false,
						category: "compiler-repair",
						difficulty: "easy",
						error: "File mismatch for src/lib.rs",
						tokens: { input: 10, output: 4, reasoning: 0, total: 14 },
						duration: 1200,
						diff: "-old\n+new",
						exactMatched: false,
						exactMatchMode: "required",
						changedFiles: ["src/lib.rs"],
						checks: [
							{
								name: "exact match",
								kind: "exact",
								required: true,
								success: false,
								error: "File mismatch for src/lib.rs",
							},
						],
						toolCalls: {
							read: 1,
							edit: 1,
							write: 0,
							bash: 2,
							editSuccesses: 1,
							editFailures: 0,
							editWarnings: 0,
							editAutocorrects: 0,
							totalInputChars: 10,
						},
						editFailures: [],
						editWarnings: [],
						editAutocorrectCount: 0,
					},
				],
				bestRunIndex: 0,
				success: false,
				tokens: { input: 10, output: 4, reasoning: 0, total: 14 },
				duration: 1200,
				changedFiles: ["src/lib.rs"],
				checks: [
					{
						name: "exact match",
						kind: "exact",
						required: true,
						success: false,
						error: "File mismatch for src/lib.rs",
					},
				],
				toolCalls: {
					read: 1,
					edit: 1,
					write: 0,
					bash: 2,
					editSuccesses: 1,
					editFailures: 0,
					editWarnings: 0,
					editAutocorrects: 0,
					totalInputChars: 10,
				},
				editSuccessRate: 1,
				autocorrectFreeSuccess: false,
				flakeSuccessRate: 0,
			},
		],
		summary: {
			totalTasks: 1,
			totalRuns: 1,
			successfulRuns: 0,
			successfulTasks: 0,
			taskSuccessRate: 0,
			flakyTasks: 0,
			consistentlyPassingTasks: 0,
			successfulOneShotTasks: 0,
			totalOneShotSuccessTokens: { input: 0, output: 0, reasoning: 0, total: 0 },
			avgOneShotSuccessTokensPerTask: { input: 0, output: 0, reasoning: 0, total: 0 },
			medianOneShotSuccessTokensPerTask: { input: 0, output: 0, reasoning: 0, total: 0 },
			p1OneShotSuccessTokensPerTask: { input: 0, output: 0, reasoning: 0, total: 0 },
			p99OneShotSuccessTokensPerTask: { input: 0, output: 0, reasoning: 0, total: 0 },
			totalTokens: { input: 10, output: 4, reasoning: 0, total: 14 },
			avgTokensPerTask: { input: 10, output: 4, reasoning: 0, total: 14 },
			medianTokensPerTask: { input: 10, output: 4, reasoning: 0, total: 14 },
			p1TokensPerTask: { input: 10, output: 4, reasoning: 0, total: 14 },
			p99TokensPerTask: { input: 10, output: 4, reasoning: 0, total: 14 },
			totalDuration: 1200,
			avgDurationPerTask: 1200,
			totalToolCalls: {
				read: 1,
				edit: 1,
				write: 0,
				bash: 2,
				editSuccesses: 1,
				editFailures: 0,
				editWarnings: 0,
				editAutocorrects: 0,
				totalInputChars: 10,
			},
			avgToolCallsPerTask: {
				read: 1,
				edit: 1,
				write: 0,
				bash: 2,
				editSuccesses: 1,
				editFailures: 0,
				editWarnings: 0,
				editAutocorrects: 0,
				totalInputChars: 10,
			},
			editSuccessRate: 1,
			autocorrectFreeSuccessfulTasks: 0,
			autocorrectFreeSuccessRate: 0,
			autocorrectedBestRuns: 0,
			editAutocorrectRate: 0,
			timeoutRuns: 0,
			ghostRuns: 0,
			transportFailureRuns: 0,
			rustCheckFailures: {},
			exactMatchFailures: 1,
			preferredExactMismatches: 0,
			allowedChangedFileFailures: 0,
		},
	};
}

describe("generateReport", () => {
	it("renders Rust benchmark sections and task details", () => {
		const report = generateReport(createResult());

		expect(report).toContain("# Rust Maintainer Benchmark Report");
		expect(report).toContain("## Exact match");
		expect(report).toContain("| Required exact-match failures | 1 |");
		expect(report).toContain("## Rust checks");
		expect(report).toContain("| None | 0 |");
		expect(report).toContain("| compiler-repair | 1 | 0 |");
		expect(report).toContain("- Exact match: required failed");
		expect(report).toContain("| Task | Status | Best run | Category | Difficulty | Changed files | Exact | Checks |");
		expect(report).toContain("| compiler-move-after-iter-001 | FAIL");
		expect(report).toContain("| 1 | required failed | exact match |");
		expect(report).toContain("| 1 | 1 | 0 | 2 |");
	});
});

describe("generateJsonReport", () => {
	it("serializes the benchmark result", () => {
		const parsed = JSON.parse(generateJsonReport(createResult())) as RustBenchmarkResult;

		expect(parsed.tasks[0]?.id).toBe("compiler-move-after-iter-001");
		expect(parsed.summary.totalTasks).toBe(1);
	});
});
