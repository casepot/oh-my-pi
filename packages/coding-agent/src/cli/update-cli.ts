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
import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";

export { ensureSourceCheckoutCleanForUpdate } from "../update/source-updater";

const PACKAGE = "@oh-my-pi/pi-coding-agent";
const HOMEBREW_FORMULA = "can1357/tap/omp";
const NPM_REGISTRY = "https://registry.npmjs.org/";
const RELEASE_METADATA_TIMEOUT_MS = 30_000;
const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/**
 * Core native addon package. Bumped in lock-step with {@link PACKAGE} so the
 * version sentinel the loader looks up at runtime matches the `.node` on
 * disk; see {@link buildBunInstallArgs} for why this must be installed
 * explicitly rather than inherited as a transitive dependency.
 */
const NATIVES_PACKAGE = "@oh-my-pi/pi-natives";
const SUPPORTED_NATIVE_TAGS: ReadonlySet<string> = new Set([
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
]);

function currentNativeTag(): string {
	return `${process.platform}-${process.arch}`;
}

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
export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean; plugins: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
		plugins: args.includes("--plugins") || args.includes("-l"),
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
	let response: Response;
	try {
		response = await fetch(`https://api.github.com/repos/${FORK_REPO}/releases/latest`, {
			signal: withTimeoutSignal(RELEASE_METADATA_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out fetching release info after 30s", { cause: err });
		}
		throw err;
	}
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

interface BunInstallCachePruneResult {
	scannedPackages: number;
	removedEntries: number;
}

interface BunCachePackageGroup {
	actualDirs: Map<string, string[]>;
	markerDir?: string;
	markerEntries: Map<string, string[]>;
}

function stripBunCacheVersionSuffix(name: string): string {
	const metadataIndex = name.indexOf("@@");
	return metadataIndex === -1 ? name : name.slice(0, metadataIndex);
}

function compareSemverIdentifier(a: string, b: string): number {
	const aNumber = /^\d+$/.test(a);
	const bNumber = /^\d+$/.test(b);
	if (aNumber && bNumber) return Number(a) - Number(b);
	if (aNumber) return -1;
	if (bNumber) return 1;
	return a.localeCompare(b);
}

function compareSemverLikeVersions(a: string, b: string): number {
	const [aCoreWithPrerelease] = a.split("+", 1);
	const [bCoreWithPrerelease] = b.split("+", 1);
	const [aCore, aPrerelease] = aCoreWithPrerelease.split("-", 2);
	const [bCore, bPrerelease] = bCoreWithPrerelease.split("-", 2);
	const aParts = aCore.split(".");
	const bParts = bCore.split(".");
	for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
		const diff = Number(aParts[i] ?? 0) - Number(bParts[i] ?? 0);
		if (diff !== 0 && Number.isFinite(diff)) return diff;
	}
	if (!aPrerelease && !bPrerelease) return 0;
	if (!aPrerelease) return 1;
	if (!bPrerelease) return -1;
	const aPrereleaseParts = aPrerelease.split(".");
	const bPrereleaseParts = bPrerelease.split(".");
	for (let i = 0; i < Math.max(aPrereleaseParts.length, bPrereleaseParts.length); i++) {
		const aPart = aPrereleaseParts[i];
		const bPart = bPrereleaseParts[i];
		if (aPart === undefined) return -1;
		if (bPart === undefined) return 1;
		const diff = compareSemverIdentifier(aPart, bPart);
		if (diff !== 0) return diff;
	}
	return 0;
}

async function readdirIfExists(dir: string): Promise<fs.Dirent[]> {
	try {
		return await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

function getBunCacheGroup(groups: Map<string, BunCachePackageGroup>, packageName: string): BunCachePackageGroup {
	let group = groups.get(packageName);
	if (!group) {
		group = { actualDirs: new Map(), markerEntries: new Map() };
		groups.set(packageName, group);
	}
	return group;
}

function addVersionPath(entries: Map<string, string[]>, version: string, entryPath: string): void {
	const paths = entries.get(version);
	if (paths) {
		paths.push(entryPath);
		return;
	}
	entries.set(version, [entryPath]);
}

async function addBunCacheActualDir(
	groups: Map<string, BunCachePackageGroup>,
	dirPath: string,
	packageNames: Set<string> | undefined,
): Promise<void> {
	try {
		const manifest = (await Bun.file(path.join(dirPath, "package.json")).json()) as Partial<
			Record<"name" | "version", unknown>
		>;
		if (typeof manifest.name !== "string" || typeof manifest.version !== "string") return;
		if (packageNames && !packageNames.has(manifest.name)) return;
		const group = getBunCacheGroup(groups, manifest.name);
		addVersionPath(group.actualDirs, manifest.version, dirPath);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
}

async function addBunCacheMarkerDir(
	groups: Map<string, BunCachePackageGroup>,
	packageName: string,
	markerDir: string,
	packageNames: Set<string> | undefined,
): Promise<void> {
	if (packageNames && !packageNames.has(packageName)) return;
	const markerEntries = await readdirIfExists(markerDir);
	const group = getBunCacheGroup(groups, packageName);
	group.markerDir = markerDir;
	for (const entry of markerEntries) {
		const cacheVersion = stripBunCacheVersionSuffix(entry.name);
		addVersionPath(group.markerEntries, cacheVersion, path.join(markerDir, entry.name));
	}
}

async function collectBunCacheGroups(
	cacheDir: string,
	packageNames: Set<string> | undefined,
): Promise<Map<string, BunCachePackageGroup>> {
	const groups = new Map<string, BunCachePackageGroup>();
	for (const entry of await readdirIfExists(cacheDir)) {
		if (!entry.isDirectory()) continue;
		const entryPath = path.join(cacheDir, entry.name);
		if (entry.name.startsWith("@")) {
			for (const scopedEntry of await readdirIfExists(entryPath)) {
				if (!scopedEntry.isDirectory()) continue;
				const scopedEntryPath = path.join(entryPath, scopedEntry.name);
				const versionSeparator = scopedEntry.name.lastIndexOf("@");
				if (versionSeparator === -1) {
					await addBunCacheMarkerDir(groups, `${entry.name}/${scopedEntry.name}`, scopedEntryPath, packageNames);
				} else {
					await addBunCacheActualDir(groups, scopedEntryPath, packageNames);
				}
			}
			continue;
		}
		const versionSeparator = entry.name.lastIndexOf("@");
		if (versionSeparator === -1) {
			await addBunCacheMarkerDir(groups, entry.name, entryPath, packageNames);
		} else {
			await addBunCacheActualDir(groups, entryPath, packageNames);
		}
	}
	return groups;
}

async function removeCacheEntries(paths: string[]): Promise<number> {
	for (const entryPath of paths) {
		await fs.promises.rm(entryPath, { recursive: true, force: true });
	}
	return paths.length;
}

/**
 * Prune Bun's package cache so each package keeps only its newest cached version.
 *
 * Bun stores package cache entries as both a package marker directory
 * (`react/19.2.6@@@1`) and a materialized package directory
 * (`react@19.2.6@@@1`). Global `omp` updates can leave one full copy per
 * release. The marker and materialized entries are removed together so the
 * cache stays internally consistent.
 */
export async function pruneBunInstallCache(
	cacheDir: string,
	packageNames?: Set<string>,
): Promise<BunInstallCachePruneResult> {
	const groups = await collectBunCacheGroups(cacheDir, packageNames);
	let scannedPackages = 0;
	let removedEntries = 0;
	for (const group of groups.values()) {
		if (group.actualDirs.size === 0) continue;
		scannedPackages++;
		let latestVersion: string | undefined;
		for (const version of group.actualDirs.keys()) {
			if (!latestVersion || compareSemverLikeVersions(version, latestVersion) > 0) latestVersion = version;
		}
		if (!latestVersion) continue;
		for (const [version, paths] of group.actualDirs) {
			if (version !== latestVersion) removedEntries += await removeCacheEntries(paths);
		}
		for (const [version, paths] of group.markerEntries) {
			if (version !== latestVersion) removedEntries += await removeCacheEntries(paths);
		}
	}
	return { scannedPackages, removedEntries };
}

export function resolveBunGlobalNodeModulesDirFromLocations(
	globalBinDir: string | undefined,
	cacheDir: string | undefined,
): string | undefined {
	if (globalBinDir && globalBinDir.length > 0) {
		return path.join(path.dirname(globalBinDir), "install", "global", "node_modules");
	}
	if (cacheDir && cacheDir.length > 0) {
		return path.join(path.dirname(cacheDir), "global", "node_modules");
	}
	return undefined;
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
	const pathEnv = process.env.PATH;
	return $which(APP_NAME, pathEnv ? { PATH: pathEnv } : undefined) ?? undefined;
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
 * Remove a backup binary without letting the removal abort a completed update.
 *
 * On Windows the executable that was just moved aside is still mapped as the
 * running process image, so unlinking it fails with EPERM/EACCES until this
 * process exits (issue #845). The replacement and verification already
 * succeeded by the time we get here, so every error is swallowed; the leftover
 * is reclaimed by {@link sweepStaleBackups} on the next update once it is no
 * longer in use. Returns whether the file is gone.
 */
async function removeBackupBestEffort(filePath: string): Promise<boolean> {
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

/**
 * Best-effort removal of binary-update backups left by earlier runs.
 *
 * Each self-update moves the previous executable to `<binary>.<timestamp>.<pid>.bak`
 * before swapping the new one in. On Windows that backup cannot be deleted
 * while the updating process is alive, so it is left for a later run to reclaim
 * once its owning process has exited. Also matches the legacy fixed
 * `<binary>.bak` name produced before backups were timestamped, so users
 * upgrading from a buggy release get the orphaned file cleaned up.
 */
export async function sweepStaleBackups(targetPath: string): Promise<void> {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(`${base}.`) || !entry.endsWith(".bak")) continue;
		// Legacy "<base>.bak" → empty middle; new "<base>.<timestamp>.<pid>.bak"
		// → dot-separated numeric run. Anything else is an unrelated *.bak file.
		const middle = entry.slice(base.length + 1, entry.length - ".bak".length);
		if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
		await removeBackupBestEffort(path.join(dir, entry));
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		// `backupPath` is unique per attempt (see updateViaBinaryAt), so this rename
		// never has to overwrite — or unlink — a possibly-locked leftover from an
		// earlier run. Renaming the running executable itself is permitted on
		// Windows; only deleting its still-mapped image is not.
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
		// Swap done and verified. On Windows the backup is still the running
		// process image and cannot be unlinked until this process exits, so a
		// failure here must NOT fail an otherwise-successful update.
		await removeBackupBestEffort(options.backupPath);
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

export function buildBunInstallArgs(expectedVersion: string, nativeTag: string = currentNativeTag()): string[] {
	const args = [
		"install",
		"-g",
		"--no-cache",
		`--registry=${NPM_REGISTRY}`,
		`${PACKAGE}@${expectedVersion}`,
		`${NATIVES_PACKAGE}@${expectedVersion}`,
	];
	if (SUPPORTED_NATIVE_TAGS.has(nativeTag)) {
		args.push(`${NATIVES_PACKAGE}-${nativeTag}@${expectedVersion}`);
	}
	return args;
}

export function buildHomebrewUpdateArgs(force: boolean): string[] {
	return [force ? "reinstall" : "upgrade", HOMEBREW_FORMULA];
}

export function buildMiseUpgradeArgs(): string[] {
	return ["upgrade", MISE_TOOL, "--bump"];
}

export function buildMiseForceInstallArgs(expectedVersion: string): string[] {
	return ["install", "--force", `${MISE_TOOL}@${expectedVersion}`];
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(targetPath: string, expectedVersion: string): Promise<void> {
	const binaryName = getBinaryName();
	const url = getReleaseAssetUrl(expectedVersion, binaryName);

	const tempPath = `${targetPath}.new`;
	// Unique per attempt: a stale backup from an earlier update may still be
	// locked (it is the previous process image on Windows), and a fixed name
	// would force the move-aside rename to overwrite it. pid + timestamp keeps
	// two forced updates in the same millisecond from colliding.
	const backupPath = `${targetPath}.${Date.now()}.${process.pid}.bak`;
	console.log(chalk.dim(`Downloading ${binaryName}…`));

	let response: Response;
	try {
		response = await fetch(url, {
			redirect: "follow",
			signal: withTimeoutSignal(BINARY_DOWNLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		throw err;
	}
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
	// Reclaim backups from earlier updates whose owning process has since exited.
	await sweepStaleBackups(targetPath);
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
  -c, --check     Check for updates without installing
  -f, --force     Force reinstall even if up to date
  -l, --plugins   Update installed plugins

${chalk.bold("Examples:")}
  ${APP_NAME} update              Update to latest version
  ${APP_NAME} update --check      Check if updates are available
  ${APP_NAME} update --force      Force reinstall
  ${APP_NAME} update -l           Update installed plugins
`);
}
