import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ensureSourceCheckoutCleanForUpdate,
	getReleaseAssetUrlForTest,
	replaceBinaryForUpdate,
	resolveUpdateMethodForTest,
	resolveUpdateTargetForTest,
} from "../src/cli/update-cli";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-test-"));
	tempDirs.push(dir);
	return dir;
}

async function makeGitRepo(): Promise<string> {
	const dir = await makeTempDir();
	await runGit(dir, ["init"]);
	return dir;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("update-cli install target detection", () => {
	it("detects when the prioritized omp is inside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.bun/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses binary update when prioritized omp is outside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/omp", undefined);

		expect(method).toBe("binary");
	});

	it("migrates bun package installs to the fork source checkout", () => {
		const target = resolveUpdateTargetForTest({
			ompPath: "/Users/test/.bun/bin/omp",
			bunGlobalBinDir: "/Users/test/.bun/bin",
			defaultSourceRoot: "/Users/test/.local/share/omp/source/oh-my-pi",
		});

		expect(target).toEqual({
			method: "source",
			root: "/Users/test/.local/share/omp/source/oh-my-pi",
			mode: "migrate",
		});
	});

	it("uses source updates when the prioritized omp resolves inside a checkout", async () => {
		const dir = await makeTempDir();
		await fs.mkdir(path.join(dir, ".git"), { recursive: true });
		const cliPath = path.join(dir, "packages", "coding-agent", "src", "cli.ts");
		await Bun.write(path.join(dir, "packages", "coding-agent", "package.json"), "{}");
		await Bun.write(cliPath, "");

		const target = resolveUpdateTargetForTest({
			ompPath: cliPath,
			bunGlobalBinDir: "/Users/test/.bun/bin",
			defaultSourceRoot: "/Users/test/.local/share/omp/source/oh-my-pi",
		});

		const realDir = await fs.realpath(dir);
		expect(target).toEqual({ method: "source", root: realDir, mode: "linked" });
	});
});

describe("update-cli source checkout safety", () => {
	it("refuses to update dirty source checkouts", async () => {
		const dir = await makeGitRepo();
		await Bun.write(path.join(dir, "dirty.txt"), "local change");

		await expect(ensureSourceCheckoutCleanForUpdate(dir)).rejects.toThrow("uncommitted changes");
	});
});

describe("update-cli fork release URLs", () => {
	it("downloads binary updates from the fork releases", () => {
		expect(getReleaseAssetUrlForTest("15.7.0", "omp-darwin-arm64")).toBe(
			"https://github.com/casepot/oh-my-pi/releases/download/v15.7.0/omp-darwin-arm64",
		);
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous omp binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});
