/**
 * Update CLI command handler.
 *
 * Handles `omp update` to check for and install updates.
 * Uses fork source checkouts when possible, otherwise downloads fork release binaries.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { $which, APP_NAME, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import {
	DEFAULT_SOURCE_BRANCH,
	FORK_REPO,
	FORK_REPO_URL,
	getBunGlobalBinDir,
	getDefaultSourceCheckoutDir,
	isPathInDirectory,
	readSourceCheckoutStatus,
	remoteMatchesRepo,
	resolveSourceRootFromOmpPath,
	type SourceCheckoutStatus,
	UPSTREAM_REPO_URL,
} from "../update/source-status";

interface ReleaseInfo {
	version: string;
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

/**
 * Parse update subcommand arguments.
 * Returns undefined if not an update command.
 */
export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
	};
}

type UpdateTarget = { method: "source"; root: string; mode: "linked" | "migrate" } | { method: "binary"; path: string };

interface UpdateTargetResolutionInput {
	ompPath?: string;
	bunGlobalBinDir?: string;
	defaultSourceRoot?: string;
}

function resolveUpdateMethod(ompPath: string, bunBinDir: string | undefined): "bun" | "binary" {
	if (!bunBinDir) return "binary";
	return isPathInDirectory(ompPath, bunBinDir) ? "bun" : "binary";
}

export function resolveUpdateMethodForTest(ompPath: string, bunBinDir: string | undefined): "bun" | "binary" {
	return resolveUpdateMethod(ompPath, bunBinDir);
}

function resolveUpdateTargetFromPaths(input: UpdateTargetResolutionInput): UpdateTarget | undefined {
	const sourceRoot = resolveSourceRootFromOmpPath(input.ompPath);
	if (sourceRoot) return { method: "source", root: sourceRoot, mode: "linked" };

	if (input.ompPath && resolveUpdateMethod(input.ompPath, input.bunGlobalBinDir) === "binary") {
		return { method: "binary", path: input.ompPath };
	}

	if (input.bunGlobalBinDir) {
		return {
			method: "source",
			root: input.defaultSourceRoot ?? getDefaultSourceCheckoutDir(),
			mode: "migrate",
		};
	}

	return undefined;
}

export function resolveUpdateTargetForTest(input: UpdateTargetResolutionInput): UpdateTarget | undefined {
	return resolveUpdateTargetFromPaths(input);
}

async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const bunGlobalBinDir = await getBunGlobalBinDir();
	const ompPath = resolveOmpPath();
	const target = resolveUpdateTargetFromPaths({ ompPath, bunGlobalBinDir });
	if (target) return target;

	throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
}

/**
 * Get the latest release info from the fork's GitHub releases.
 */
async function getLatestRelease(): Promise<ReleaseInfo> {
	const response = await fetch(`https://api.github.com/repos/${FORK_REPO}/releases/latest`);
	if (!response.ok) {
		throw new Error(`Failed to fetch release info: ${response.statusText}`);
	}

	const data = (await response.json()) as { tag_name?: string };
	const tag = data.tag_name;
	if (!tag) {
		throw new Error("Latest release response did not include a tag");
	}
	const version = tag.replace(/^v/u, "");

	return {
		version,
	};
}

/**
 * Compare semver versions. Returns:
 * - negative if a < b
 * - 0 if a == b
 * - positive if a > b
 */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);

	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] || 0;
		const nb = pb[i] || 0;
		if (na !== nb) return na - nb;
	}
	return 0;
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(): string {
	const platform = process.platform;
	const arch = process.arch;

	let os: string;
	switch (platform) {
		case "linux":
			os = "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	if (os === "windows") {
		return `${APP_NAME}-${os}-${archName}.exe`;
	}
	return `${APP_NAME}-${os}-${archName}`;
}

/**
 * Resolve the path that `omp` maps to in the user's PATH.
 */
function resolveOmpPath(): string | undefined {
	return $which(APP_NAME) ?? undefined;
}

/**
 * Run the resolved omp binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const ompPath = resolveOmpPath();
	if (!ompPath) return { ok: false };
	try {
		const result = await $`${ompPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return { ok: false, path: ompPath };
		const output = result.text().trim();
		// Output format: "omp/X.Y.Z"
		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		return { ok: actual === expectedVersion, actual, path: ompPath };
	} catch {
		return { ok: false, path: ompPath };
	}
}

function printVerifiedVersion(expectedVersion: string): void {
	console.log(chalk.green(`\n${theme.status.success} Updated to ${expectedVersion}`));
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		await unlinkIfExists(options.backupPath);
		await fs.promises.rename(options.targetPath, options.backupPath);
		backupReady = true;
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		await unlinkIfExists(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

async function runProcess(command: string, args: string[], cwd?: string): Promise<void> {
	const proc = Bun.spawn([command, ...args], {
		cwd,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		windowsHide: true,
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}`);
	}
}

async function pathExistsForUpdate(filePath: string): Promise<boolean> {
	try {
		await fs.promises.stat(filePath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function readDirectoryEntryCount(dir: string): Promise<number | undefined> {
	try {
		return (await fs.promises.readdir(dir)).length;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

export async function ensureSourceCheckoutCleanForUpdate(root: string): Promise<SourceCheckoutStatus> {
	const status = await readSourceCheckoutStatus(root, { fetchRemotes: false });
	if (status.dirty) {
		throw new Error(
			`Source checkout has uncommitted changes at ${root}; commit or stash them before running ${APP_NAME} update.`,
		);
	}
	return status;
}

function printForkDivergence(status: SourceCheckoutStatus): void {
	if ((status.forkBehindUpstream ?? 0) > 0) {
		console.log(chalk.yellow(`Fork is behind upstream by ${status.forkBehindUpstream} commits.`));
	}
}

async function installSourceLinks(root: string): Promise<void> {
	console.log(chalk.dim("Installing source dependencies and global links..."));
	await runProcess("bun", ["install"], root);
	await runProcess("bun", ["--cwd=packages/coding-agent", "link"], root);
	await runProcess("bun", ["--cwd=packages/ai", "link"], root);
}

async function ensureRemoteUrl(
	root: string,
	name: string,
	currentUrl: string | undefined,
	expectedUrl: string,
): Promise<void> {
	if (currentUrl) {
		if (currentUrl !== expectedUrl) {
			await runProcess("git", ["remote", "set-url", name, expectedUrl], root);
		}
		return;
	}
	await runProcess("git", ["remote", "add", name, expectedUrl], root);
}

async function prepareForkSourceCheckout(root: string): Promise<SourceCheckoutStatus> {
	const gitPath = path.join(root, ".git");
	if (!(await pathExistsForUpdate(gitPath))) {
		const entryCount = await readDirectoryEntryCount(root);
		if (entryCount !== undefined && entryCount > 0) {
			throw new Error(`Cannot install fork source into non-empty directory: ${root}`);
		}
		await fs.promises.mkdir(path.dirname(root), { recursive: true });
		console.log(chalk.dim(`Cloning ${FORK_REPO} into ${root}...`));
		await runProcess("git", ["clone", FORK_REPO_URL, root]);
		await runProcess("git", ["remote", "add", "upstream", UPSTREAM_REPO_URL], root);
	} else {
		const status = await ensureSourceCheckoutCleanForUpdate(root);
		await ensureRemoteUrl(root, "origin", status.originUrl, FORK_REPO_URL);
		await ensureRemoteUrl(root, "upstream", status.upstreamUrl, UPSTREAM_REPO_URL);
	}

	await runProcess("git", ["fetch", "origin", DEFAULT_SOURCE_BRANCH], root);
	await runProcess("git", ["checkout", "-B", DEFAULT_SOURCE_BRANCH, `origin/${DEFAULT_SOURCE_BRANCH}`], root);
	return readSourceCheckoutStatus(root, { fetchRemotes: true });
}

async function fastForwardSourceCheckout(root: string, status: SourceCheckoutStatus): Promise<void> {
	const branch = status.branch ?? DEFAULT_SOURCE_BRANCH;
	await runProcess("git", ["fetch", "origin", branch], root);
	if (status.branch) {
		await runProcess("git", ["merge", "--ff-only", `origin/${branch}`], root);
	} else {
		await runProcess("git", ["checkout", "-B", DEFAULT_SOURCE_BRANCH, `origin/${DEFAULT_SOURCE_BRANCH}`], root);
	}
}

async function updateViaSource(
	target: Extract<UpdateTarget, { method: "source" }>,
	opts: { force: boolean; check: boolean },
): Promise<void> {
	if (target.mode === "migrate") {
		console.log(chalk.cyan(`Fork source install available at ${target.root}`));
		if (opts.check) return;

		const status = await prepareForkSourceCheckout(target.root);
		await installSourceLinks(target.root);
		console.log(
			chalk.green(
				`\n${theme.status.success} Installed fork source checkout ${status.branch ?? DEFAULT_SOURCE_BRANCH}@${status.head ?? "HEAD"}`,
			),
		);
		printForkDivergence(status);
		return;
	}

	const status = await readSourceCheckoutStatus(target.root, { fetchRemotes: true });
	if (status.dirty) {
		throw new Error(
			`Source checkout has uncommitted changes at ${target.root}; commit or stash them before running ${APP_NAME} update.`,
		);
	}
	if (!remoteMatchesRepo(status.originUrl, FORK_REPO)) {
		const repo = status.originRepo ?? status.originUrl ?? "unknown";
		throw new Error(`Source checkout tracks ${repo}; expected ${FORK_REPO}. Run the fork installer to migrate.`);
	}

	const ahead = status.localAheadOrigin ?? 0;
	const behind = status.localBehindOrigin ?? 0;
	if (ahead > 0 && behind > 0) {
		throw new Error(
			`Source checkout has diverged from fork ${status.branch ?? DEFAULT_SOURCE_BRANCH}; reconcile it before updating.`,
		);
	}

	if (behind > 0) {
		console.log(
			chalk.cyan(`Source update available: fork ${status.branch ?? DEFAULT_SOURCE_BRANCH} +${behind} commits`),
		);
	} else if (ahead > 0) {
		console.log(chalk.yellow(`Local branch is ahead of fork by ${ahead} commits; nothing to pull.`));
	} else if (opts.force) {
		console.log(chalk.yellow("Forcing source relink"));
	} else {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		printForkDivergence(status);
		return;
	}

	printForkDivergence(status);
	if (opts.check) return;

	if (behind > 0) {
		await fastForwardSourceCheckout(target.root, status);
	}
	await installSourceLinks(target.root);
	const updatedStatus = await readSourceCheckoutStatus(target.root, { fetchRemotes: false });
	console.log(
		chalk.green(
			`\n${theme.status.success} Updated source checkout ${updatedStatus.branch ?? DEFAULT_SOURCE_BRANCH}@${updatedStatus.head ?? "HEAD"}`,
		),
	);
}

/**
 * Build a fork release asset URL.
 */
function getReleaseAssetUrl(version: string, binaryName: string): string {
	const tag = version.startsWith("v") ? version : `v${version}`;
	return `https://github.com/${FORK_REPO}/releases/download/${tag}/${binaryName}`;
}

export function getReleaseAssetUrlForTest(version: string, binaryName: string): string {
	return getReleaseAssetUrl(version, binaryName);
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(targetPath: string, expectedVersion: string): Promise<void> {
	const binaryName = getBinaryName();
	const url = getReleaseAssetUrl(expectedVersion, binaryName);

	const tempPath = `${targetPath}.new`;
	const backupPath = `${targetPath}.bak`;
	console.log(chalk.dim(`Downloading ${binaryName}…`));

	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}
	const fileStream = fs.createWriteStream(tempPath, { mode: 0o755 });
	await pipeline(response.body, fileStream);

	console.log(chalk.dim("Installing update..."));
	await replaceBinaryForUpdate({
		targetPath,
		tempPath,
		backupPath,
		expectedVersion,
		verifyInstalledVersion,
	});
	printVerifiedVersion(expectedVersion);
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));

	let target: UpdateTarget;
	try {
		target = await resolveUpdateTarget();
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}

	if (target.method === "source") {
		try {
			await updateViaSource(target, opts);
		} catch (err) {
			console.error(chalk.red(`Update failed: ${err}`));
			process.exit(1);
		}
		return;
	}

	// Check for binary release updates
	let release: ReleaseInfo;
	try {
		release = await getLatestRelease();
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		process.exit(1);
	}

	const comparison = compareVersions(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		return;
	}

	try {
		await updateViaBinaryAt(target.path, release.version);
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check   Check for updates without installing
  -f, --force   Force reinstall even if up to date

${chalk.bold("Examples:")}
  ${APP_NAME} update           Update to latest version
  ${APP_NAME} update --check   Check if updates are available
  ${APP_NAME} update --force   Force reinstall
`);
}
