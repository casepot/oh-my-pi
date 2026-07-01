import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { RustTask } from "@oh-my-pi/rust-maintainer-benchmark/tasks";
import { verifyExpectedFiles, verifyRustTask } from "@oh-my-pi/rust-maintainer-benchmark/verify";

async function createTempDirs(): Promise<{
	root: TempDir;
	expectedDir: string;
	actualDir: string;
	inputDir: string;
	cleanup: () => Promise<void>;
}> {
	const root = await TempDir.create("@rust-maintainer-benchmark-verify-");
	const expectedDir = root.join("expected");
	const actualDir = root.join("actual");
	const inputDir = root.join("input");
	await fs.mkdir(expectedDir, { recursive: true });
	await fs.mkdir(actualDir, { recursive: true });
	await fs.mkdir(inputDir, { recursive: true });
	return {
		root,
		expectedDir,
		actualDir,
		inputDir,
		cleanup: async () => root.remove(),
	};
}

function createTask(id: string, dirs: { inputDir: string; expectedDir: string }): RustTask {
	return {
		id,
		name: id,
		prompt: "verify",
		files: ["Cargo.toml", "src/lib.rs"],
		inputDir: dirs.inputDir,
		expectedDir: dirs.expectedDir,
		metadata: {
			category: "surgical",
			difficulty: "easy",
			crateRoot: ".",
			verification: {
				rustfmt: true,
				exactMatch: "required",
				commands: [
					{ name: "cargo check", args: ["check", "--color", "never"] },
					{ name: "cargo test", args: ["test", "--lib", "--color", "never"] },
				],
			},
		},
	};
}

async function writeCrate(dir: string, lib: string): Promise<void> {
	await Bun.write(
		path.join(dir, "Cargo.toml"),
		'[package]\nname = "verify_tmp"\nversion = "0.0.0"\nedition = "2024"\n\n[dependencies]\n',
	);
	await Bun.write(path.join(dir, "src/lib.rs"), lib);
}

const PASSING_LIB = `pub fn value() -> u8 {
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_value() {
        assert_eq!(value(), 2);
    }
}
`;

describe("verifyExpectedFiles", () => {
	it("reports missing files", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(false);
			expect(result.error).toContain("Missing files: src/lib.rs");
		} finally {
			await cleanup();
		}
	});

	it("reports unexpected files", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
			await Bun.write(path.join(actualDir, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
			await Bun.write(path.join(actualDir, "src/extra.rs"), "pub fn extra() {}\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(false);
			expect(result.error).toContain("Unexpected files: src/extra.rs");
		} finally {
			await cleanup();
		}
	});

	it("returns a compact diff for content mismatches", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
			await Bun.write(path.join(actualDir, "src/lib.rs"), "pub fn value() -> u8 { 2 }\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(false);
			expect(result.diff).toContain("-pub fn value() -> u8 { 1 }");
			expect(result.diff).toContain("+pub fn value() -> u8 { 2 }");
			expect(result.diffStats?.linesChanged).toBeGreaterThan(0);
			expect(result.diffStats?.charsChanged).toBeGreaterThan(0);
		} finally {
			await cleanup();
		}
	});

	it("normalizes line endings before comparison", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "src/lib.rs"), "pub fn value() -> u8 { 1 }\r\n");
			await Bun.write(path.join(actualDir, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(true);
		} finally {
			await cleanup();
		}
	});
});

describe("verifyRustTask", () => {
	it("passes exact match, cargo check, and cargo test for a dependency-free crate", async () => {
		const { inputDir, expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await writeCrate(inputDir, PASSING_LIB);
			await writeCrate(expectedDir, PASSING_LIB);
			await writeCrate(actualDir, PASSING_LIB);

			const result = await verifyRustTask(createTask("passing", { inputDir, expectedDir }), {
				actualDir,
				timeoutMs: 60000,
			});

			expect(result.success).toBe(true);
			expect(result.checks.map(check => check.name)).toEqual([
				"exact match",
				"cargo fmt",
				"cargo check",
				"cargo test",
			]);
		} finally {
			await cleanup();
		}
	});

	it("fails with cargo test failed when tests fail", async () => {
		const { inputDir, expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			const failingLib = PASSING_LIB.replace("assert_eq!(value(), 2);", "assert_eq!(value(), 1);");
			await writeCrate(inputDir, failingLib);
			await writeCrate(expectedDir, failingLib);
			await writeCrate(actualDir, failingLib);
			const task = createTask("failing", { inputDir, expectedDir });
			task.metadata.verification.commands = [{ name: "cargo test", args: ["test", "--lib", "--color", "never"] }];

			const result = await verifyRustTask(task, { actualDir, timeoutMs: 60000 });

			expect(result.success).toBe(false);
			expect(result.error).toBe("cargo test failed");
			const failedCheck = result.checks.find(check => check.name === "cargo test");
			expect(failedCheck?.success).toBe(false);
			expect(failedCheck?.exitCode).not.toBe(0);
		} finally {
			await cleanup();
		}
	});

	it("continues Cargo diagnostics after required exact mismatch", async () => {
		const { inputDir, expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await writeCrate(inputDir, PASSING_LIB);
			await writeCrate(expectedDir, PASSING_LIB);
			await writeCrate(actualDir, `${PASSING_LIB}\n// behaviorally equivalent implementation\n`);
			const task = createTask("required-mismatch", { inputDir, expectedDir });
			task.metadata.verification.commands = [{ name: "cargo test", args: ["test", "--lib", "--color", "never"] }];

			const result = await verifyRustTask(task, { actualDir, timeoutMs: 60000 });

			expect(result.success).toBe(false);
			expect(result.exactMatched).toBe(false);
			expect(result.error).toBe("File mismatch for src/lib.rs");
			expect(result.checks).toContainEqual(
				expect.objectContaining({ name: "exact match", kind: "exact", required: true, success: false }),
			);
			expect(result.checks).toContainEqual(
				expect.objectContaining({ name: "cargo fmt", kind: "cargo", required: true, success: true }),
			);
			expect(result.checks).toContainEqual(
				expect.objectContaining({ name: "cargo test", kind: "cargo", required: true, success: true }),
			);
		} finally {
			await cleanup();
		}
	});

	it("treats preferred exact mismatch as successful when Cargo passes", async () => {
		const { inputDir, expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await writeCrate(inputDir, PASSING_LIB);
			await writeCrate(expectedDir, PASSING_LIB);
			await writeCrate(actualDir, `${PASSING_LIB}\n// behaviorally equivalent implementation\n`);
			const task = createTask("preferred-mismatch", { inputDir, expectedDir });
			task.metadata.verification.exactMatch = "preferred";
			task.metadata.verification.commands = [{ name: "cargo test", args: ["test", "--lib", "--color", "never"] }];

			const result = await verifyRustTask(task, { actualDir, timeoutMs: 60000 });

			expect(result.success).toBe(true);
			expect(result.exactMatched).toBe(false);
			expect(result.checks).toContainEqual(
				expect.objectContaining({ name: "exact match", kind: "exact", required: false, success: false }),
			);
			expect(result.checks).toContainEqual(
				expect.objectContaining({ name: "cargo fmt", kind: "cargo", required: true, success: true }),
			);
			expect(result.checks).toContainEqual(
				expect.objectContaining({ name: "cargo test", kind: "cargo", required: true, success: true }),
			);
		} finally {
			await cleanup();
		}
	});

	it("fails when a changed file is outside allowed_changed_files", async () => {
		const { inputDir, expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await writeCrate(inputDir, PASSING_LIB);
			await Bun.write(path.join(inputDir, "src/other.rs"), "pub fn other() -> u8 { 1 }\n");
			await writeCrate(expectedDir, PASSING_LIB);
			await Bun.write(path.join(expectedDir, "src/other.rs"), "pub fn other() -> u8 { 2 }\n");
			await writeCrate(actualDir, PASSING_LIB);
			await Bun.write(path.join(actualDir, "src/other.rs"), "pub fn other() -> u8 { 2 }\n");
			const task = createTask("allowed", { inputDir, expectedDir });
			task.metadata.verification.allowedChangedFiles = ["src/lib.rs"];
			task.metadata.verification.exactMatch = "disabled";

			const result = await verifyRustTask(task, { actualDir, timeoutMs: 60000 });

			expect(result.success).toBe(false);
			expect(result.error).toBe("Unexpected changed files: src/other.rs");
			expect(result.checks).toContainEqual(
				expect.objectContaining({
					name: "allowed changed files",
					kind: "metadata",
					required: true,
					success: false,
				}),
			);
			expect(result.checks).toContainEqual(
				expect.objectContaining({ name: "cargo fmt", kind: "cargo", required: true, success: true }),
			);
			expect(result.checks).toContainEqual(
				expect.objectContaining({ name: "cargo test", kind: "cargo", required: true, success: true }),
			);
		} finally {
			await cleanup();
		}
	});
});
