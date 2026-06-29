import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ensureSourceCheckoutCleanForUpdate,
	getReleaseAssetUrlForTest,
	pruneBunInstallCache,
	replaceBinaryForUpdate,
	resolveBunGlobalNodeModulesDirFromLocations,
	resolveUpdateMethodForTest,
	resolveUpdateTargetForTest,
	sweepStaleBackups,
} from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
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

	it("detects when the prioritized omp resolves into the Homebrew formula", async () => {
		const dir = await makeTempDir();
		const prefix = path.join(dir, "opt", "omp");
		const linkedBin = path.join(dir, "bin");
		await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
		await fs.mkdir(linkedBin, { recursive: true });
		await Bun.write(path.join(prefix, "bin", "omp"), "binary");
		await fs.symlink(path.join(prefix, "bin", "omp"), path.join(linkedBin, "omp"));

		const method = resolveUpdateMethodForTest(path.join(linkedBin, "omp"), "/Users/test/.bun/bin", {
			homebrewPrefix: prefix,
		});

		expect(method).toBe("brew");
	});

	it("migrates Homebrew-owned installs to the fork source checkout", () => {
		const target = resolveUpdateTargetForTest({
			ompPath: "/opt/homebrew/opt/omp/bin/omp",
			homebrewPrefix: "/opt/homebrew/opt/omp",
			defaultSourceRoot: "/Users/test/.local/share/omp/source/oh-my-pi",
		});

		expect(target).toEqual({
			method: "source",
			root: "/Users/test/.local/share/omp/source/oh-my-pi",
			mode: "migrate",
		});
	});

	it("detects when the prioritized omp is in an active mise bin path", () => {
		const method = resolveUpdateMethodForTest(
			"/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin/omp",
			undefined,
			{
				miseBinDirs: ["/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin"],
			},
		);

		expect(method).toBe("mise");
	});

	it("detects when the prioritized omp is a mise shim", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/share/mise/shims/omp", undefined, {
			miseDataDir: "/Users/test/.local/share/mise",
		});

		expect(method).toBe("mise");
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

	it("derives global node_modules from supported bun global locations", () => {
		expect(resolveBunGlobalNodeModulesDirFromLocations(path.join("home", ".bun", "bin"), undefined)).toBe(
			path.join("home", ".bun", "install", "global", "node_modules"),
		);
		expect(
			resolveBunGlobalNodeModulesDirFromLocations(undefined, path.join("home", ".bun", "install", "cache")),
		).toBe(path.join("home", ".bun", "install", "global", "node_modules"));
	});
});

describe("update-cli bun cache pruning", () => {
	it("keeps only the newest cached version for filtered global install packages", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "react", "18.3.1@@@1"), "");
		await Bun.write(path.join(dir, "react", "19.2.6@@@1"), "");
		await Bun.write(
			path.join(dir, "react@18.3.1@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "18.3.1" }),
		);
		await Bun.write(
			path.join(dir, "react@19.2.6@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "19.2.6" }),
		);
		await Bun.write(path.join(dir, "@oh-my-pi", "pi-utils", "15.7.6@@@1"), "");
		await Bun.write(path.join(dir, "@oh-my-pi", "pi-utils", "15.8.0@@@1"), "");
		await Bun.write(
			path.join(dir, "@oh-my-pi", "pi-utils@15.7.6@@@1", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-utils", version: "15.7.6" }),
		);
		await Bun.write(
			path.join(dir, "@oh-my-pi", "pi-utils@15.8.0@@@1", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-utils", version: "15.8.0" }),
		);
		await Bun.write(path.join(dir, "chalk", "4.1.2@@@1"), "");
		await Bun.write(path.join(dir, "chalk", "5.6.2@@@1"), "");
		await Bun.write(
			path.join(dir, "chalk@4.1.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "4.1.2" }),
		);
		await Bun.write(
			path.join(dir, "chalk@5.6.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "5.6.2" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["react", "@oh-my-pi/pi-utils"]));

		expect(result).toEqual({ scannedPackages: 2, removedEntries: 4 });
		expect(await Bun.file(path.join(dir, "react", "18.3.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react@18.3.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react", "19.2.6@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "react@19.2.6@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils", "15.7.6@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils@15.7.6@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils", "15.8.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils@15.8.0@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk", "4.1.2@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk@4.1.2@@@1", "package.json")).exists()).toBe(true);
	});

	it("keeps current registry-qualified marker entries with their materialized package", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["pkg"]));

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 0 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json")).exists()).toBe(true);
	});

	it("treats a stable release as newer than a matching prerelease", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0-beta.1@@@1"), "");
		await Bun.write(path.join(dir, "pkg", "1.0.0@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0-beta.1" }),
		);
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir);

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 2 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0-beta.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@@1", "package.json")).exists()).toBe(true);
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

describe("update-cli binary replacement on locked backups", () => {
	it("treats an EPERM on backup cleanup as a successful, completed update", async () => {
		// Regression: on Windows the binary moved aside during the swap is still
		// the running process image, so unlinking it throws EPERM. That cleanup
		// failure must not turn a verified swap into "Update failed" (issue #845).
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.1700000000000.4242.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		const realUnlink = nodeFs.promises.unlink.bind(nodeFs.promises);
		const spy = spyOn(nodeFs.promises, "unlink").mockImplementation(async (p: nodeFs.PathLike) => {
			if (String(p) === backupPath) {
				const err = new Error(`EPERM: operation not permitted, unlink '${p}'`) as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			return realUnlink(p);
		});
		try {
			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
		} finally {
			spy.mockRestore();
		}

		// New binary is installed and the temp consumed even though the locked
		// backup survives; the next run's sweep reclaims it once it is unlocked.
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).text()).toBe("old binary");
	});
});

describe("update-cli stale backup sweep", () => {
	it("reclaims timestamped and legacy backups while leaving unrelated .bak files", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		await Bun.write(targetPath, "current binary");
		await Bun.write(`${targetPath}.bak`, "legacy backup");
		await Bun.write(`${targetPath}.1700000000000.4242.bak`, "timestamped backup");
		await Bun.write(`${targetPath}.1800000000000.99.bak`, "another backup");
		// Must survive: foreign basename and a non-numeric middle segment.
		await Bun.write(path.join(dir, "notes.bak"), "keep me");
		await Bun.write(`${targetPath}.config.bak`, "keep me too");

		await sweepStaleBackups(targetPath);

		expect(await Bun.file(targetPath).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1800000000000.99.bak`).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "notes.bak")).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.bak`).exists()).toBe(true);
	});
});
