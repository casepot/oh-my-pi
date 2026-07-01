import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { loadTasksFromDir, validateFixturesFromDir } from "@oh-my-pi/rust-maintainer-benchmark/tasks";

async function withTempFixture<T>(fn: (root: string) => Promise<T>): Promise<T> {
	const temp = await TempDir.create("@rust-maintainer-benchmark-tasks-");
	try {
		return await fn(temp.absolute());
	} finally {
		await temp.remove();
	}
}

async function writeMinimalFixture(
	root: string,
	id = "fixture-one",
	metadata?: Record<string, unknown>,
): Promise<string> {
	const taskDir = path.join(root, id);
	await Bun.write(path.join(taskDir, "prompt.md"), "Fix the crate\n");
	await Bun.write(
		path.join(taskDir, "input/Cargo.toml"),
		'[package]\nname = "fixture"\nversion = "0.0.0"\nedition = "2024"\n',
	);
	await Bun.write(path.join(taskDir, "input/src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
	await Bun.write(
		path.join(taskDir, "expected/Cargo.toml"),
		'[package]\nname = "fixture"\nversion = "0.0.0"\nedition = "2024"\n',
	);
	await Bun.write(path.join(taskDir, "expected/src/lib.rs"), "pub fn value() -> u8 { 2 }\n");
	await Bun.write(
		path.join(taskDir, "metadata.json"),
		JSON.stringify(
			metadata ?? {
				category: "compiler-repair",
				difficulty: "easy",
				difficulty_score: 2,
				crate_root: ".",
				verification: {
					rustfmt: false,
					exact_match: "required",
					allowed_changed_files: ["src/lib.rs"],
					commands: [{ name: "cargo check", args: ["check", "--color", "never"] }],
				},
			},
			null,
			2,
		),
	);
	return taskDir;
}

describe("loadTasksFromDir", () => {
	it("loads Rust task metadata, commands, and sorted comparable files", async () => {
		await withTempFixture(async root => {
			await writeMinimalFixture(root);
			await Bun.write(path.join(root, "fixture-one/input/target/debug/ignored"), "ignored");
			await Bun.write(path.join(root, "fixture-one/input/Cargo.lock"), "ignored");

			const tasks = await loadTasksFromDir(root);

			expect(tasks).toHaveLength(1);
			expect(tasks[0]?.metadata.category).toBe("compiler-repair");
			expect(tasks[0]?.metadata.crateRoot).toBe(".");
			expect(tasks[0]?.metadata.verification.commands).toEqual([
				{ name: "cargo check", args: ["check", "--color", "never"] },
			]);
			expect(tasks[0]?.files).toEqual(["Cargo.toml", "src/lib.rs"]);
		});
	});

	it("fills default verification values when optional fields are absent", async () => {
		await withTempFixture(async root => {
			await writeMinimalFixture(root, "defaulted", {
				category: "surgical",
				difficulty: "medium",
				crate_root: ".",
				verification: {},
			});

			const [task] = await loadTasksFromDir(root);

			expect(task?.metadata.verification.rustfmt).toBe(true);
			expect(task?.metadata.verification.exactMatch).toBe("required");
			expect(task?.metadata.verification.commands).toEqual([
				{ name: "cargo check", args: ["check", "--color", "never"] },
				{ name: "cargo test", args: ["test", "--lib", "--color", "never"] },
			]);
		});
	});
});

describe("validateFixturesFromDir", () => {
	it("reports missing prompt, missing input, invalid JSON metadata, and empty command args", async () => {
		await withTempFixture(async root => {
			await writeMinimalFixture(root, "missing-prompt");
			await Bun.write(path.join(root, "missing-prompt/prompt.md"), "");

			await writeMinimalFixture(root, "missing-input");
			await fs.rm(path.join(root, "missing-input/input"), { recursive: true, force: true });

			await writeMinimalFixture(root, "invalid-json");
			await Bun.write(path.join(root, "invalid-json/metadata.json"), "{");

			await writeMinimalFixture(root, "empty-args", {
				category: "surgical",
				difficulty: "easy",
				crate_root: ".",
				verification: {
					commands: [{ name: "cargo check", args: [] }],
				},
			});

			const issues = await validateFixturesFromDir(root);

			expect(issues).toContainEqual({ taskId: "missing-prompt", message: "prompt.md is empty" });
			expect(issues).toContainEqual({ taskId: "missing-input", message: "input directory is missing" });
			expect(issues.some(issue => issue.taskId === "invalid-json" && issue.message.includes("invalid JSON"))).toBe(
				true,
			);
			expect(issues.some(issue => issue.taskId === "empty-args" && issue.message.includes("args"))).toBe(true);
		});
	});

	it("reports generated artifacts committed under fixture trees", async () => {
		await withTempFixture(async root => {
			await writeMinimalFixture(root, "generated-artifacts", {
				category: "surgical",
				difficulty: "easy",
				crate_root: ".",
				verification: {
					exact_match: "required",
					commands: [{ name: "cargo check", args: ["check", "--color", "never"] }],
				},
			});
			await Bun.write(path.join(root, "generated-artifacts/expected/Cargo.lock"), "generated\n");
			await Bun.write(path.join(root, "generated-artifacts/expected/.cargo-target/file"), "generated\n");

			const issues = await validateFixturesFromDir(root);

			expect(issues).toContainEqual({
				taskId: "generated-artifacts",
				message: "generated artifact must not be committed: expected/.cargo-target",
			});
			expect(issues).toContainEqual({
				taskId: "generated-artifacts",
				message: "generated artifact must not be committed: expected/Cargo.lock",
			});
		});
	});

	it("reserves exact required matching for surgical fixtures", async () => {
		await withTempFixture(async root => {
			await writeMinimalFixture(root, "non-surgical-required", {
				category: "api-migration",
				difficulty: "medium",
				crate_root: ".",
				verification: {
					exact_match: "required",
					commands: [{ name: "cargo check", args: ["check", "--color", "never"] }],
				},
			});

			const issues = await validateFixturesFromDir(root);

			expect(issues).toContainEqual({
				taskId: "non-surgical-required",
				message: "exact_match required is reserved for surgical deterministic fixtures",
			});
		});
	});

	it("reports benchmark rationale comments in exact required Rust fixtures", async () => {
		await withTempFixture(async root => {
			await writeMinimalFixture(root, "surgical-rationale", {
				category: "surgical",
				difficulty: "easy",
				crate_root: ".",
				verification: {
					exact_match: "required",
					commands: [{ name: "cargo check", args: ["check", "--color", "never"] }],
				},
			});
			await Bun.write(
				path.join(root, "surgical-rationale/input/src/lib.rs"),
				"// Benchmark fixture rationale: hidden exact-text hint\npub fn value() -> u8 { 1 }\n",
			);

			const issues = await validateFixturesFromDir(root);

			expect(issues).toContainEqual({
				taskId: "surgical-rationale",
				message: "exact-match fixture contains benchmark rationale comment: input/src/lib.rs",
			});
		});
	});
});
