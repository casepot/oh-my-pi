/**
 * Update CLI command handler.
 *
 * Handles `omp update` to check for and install updates.
 * Uses fork source checkouts when possible, otherwise downloads fork release binaries.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { $which, APP_NAME, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import chalk from "chalk";
import { FORK_REPO } from "../fork-policy";
import { theme } from "../modes/theme/theme";
import { getBunGlobalBinDir, getDefaultSourceCheckoutDir, resolveSourceRootFromOmpPath } from "../update/source-status";
import { updateViaSource } from "../update/source-updater";

export { ensureSourceCheckoutCleanForUpdate } from "../update/source-updater";

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
type UpdateMethod = "brew" | "mise" | "bun" | "binary";

const MISE_TOOL = `github:${FORK_REPO}`;

interface UpdateTargetResolutionInput {
	ompPath?: string;
	bunGlobalBinDir?: string;
	defaultSourceRoot?: string;
	homebrewPrefix?: string;
	miseBinDirs?: readonly string[];
	miseDataDir?: string;
}

type UpdateMethodResolutionOptions = Pick<
	UpdateTargetResolutionInput,
	"homebrewPrefix" | "miseBinDirs" | "miseDataDir"
>;

async function getHomebrewFormulaPrefix(): Promise<string | undefined> {
	if (!$which("brew")) return undefined;
	try {
		const result = await $`brew --prefix ${APP_NAME}`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

async function getMiseBinDirs(): Promise<string[]> {
	if (!$which("mise")) return [];
	try {
		const result = await $`mise bin-paths ${MISE_TOOL}`.quiet().nothrow();
		if (result.exitCode !== 0) return [];
		return result
			.text()
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);
	} catch {
		return [];
	}
}

function getMiseDataDir(): string {
	const override = process.env.MISE_DATA_DIR;
	if (override && override.length > 0) return override;
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData && localAppData.length > 0) return path.join(localAppData, "mise");
	}
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && xdgDataHome.length > 0) return path.join(xdgDataHome, "mise");
	return path.join(os.homedir(), ".local", "share", "mise");
}

function normalizePathForComparison(filePath: string): string {
	const normalized = path.normalize(filePath);
	if (process.platform === "win32") return normalized.toLowerCase();
	return normalized;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;
	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!dirReal) return false;
	const fileReal = tryRealpath(path.resolve(filePath));
	if (fileReal && isPathInDirectoryLexical(fileReal, dirReal)) return true;
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	if (!fileDir) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

function resolveUpdateMethod(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	const { homebrewPrefix, miseBinDirs = [], miseDataDir } = options;
	if (homebrewPrefix && isPathInDirectory(ompPath, path.join(homebrewPrefix, "bin"))) return "brew";
	if (miseBinDirs.some(dir => isPathInDirectory(ompPath, dir))) return "mise";
	if (miseDataDir && isPathInDirectory(ompPath, path.join(miseDataDir, "shims"))) return "mise";
	if (bunBinDir && isPathInDirectory(ompPath, bunBinDir)) return "bun";
	return "binary";
}

export function resolveUpdateMethodForTest(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	return resolveUpdateMethod(ompPath, bunBinDir, options);
}

function resolveUpdateTargetFromPaths(input: UpdateTargetResolutionInput): UpdateTarget | undefined {
	const sourceRoot = resolveSourceRootFromOmpPath(input.ompPath);
	if (sourceRoot) return { method: "source", root: sourceRoot, mode: "linked" };

	const method = input.ompPath
		? resolveUpdateMethod(input.ompPath, input.bunGlobalBinDir, {
				homebrewPrefix: input.homebrewPrefix,
				miseBinDirs: input.miseBinDirs,
				miseDataDir: input.miseDataDir,
			})
		: undefined;

	if (method === "binary" && input.ompPath) {
		return { method: "binary", path: input.ompPath };
	}

	if (method || input.bunGlobalBinDir) {
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
	const homebrewPrefix = await getHomebrewFormulaPrefix();
	const miseAvailable = $which("mise") !== undefined;
	const miseBinDirs = miseAvailable ? await getMiseBinDirs() : [];
	const miseDataDir = miseAvailable ? getMiseDataDir() : undefined;
	const ompPath = resolveOmpPath();
	const target = resolveUpdateTargetFromPaths({ ompPath, bunGlobalBinDir, homebrewPrefix, miseBinDirs, miseDataDir });
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
