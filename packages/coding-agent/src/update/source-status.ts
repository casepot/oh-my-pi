import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, APP_NAME } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { DEFAULT_SOURCE_BRANCH, FORK_REPO, FORK_REPO_URL, UPSTREAM_REPO, UPSTREAM_REPO_URL } from "../fork-policy";

export { DEFAULT_SOURCE_BRANCH, FORK_REPO, FORK_REPO_URL, UPSTREAM_REPO, UPSTREAM_REPO_URL };

type Environment = Record<string, string | undefined>;

export type InstallKind = "fork-source" | "other-source" | "package" | "binary" | "unknown";

export interface GitDivergence {
	ahead: number;
	behind: number;
}

export interface GitCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface SourceCheckoutStatus {
	root: string;
	branch?: string;
	head?: string;
	dirty: boolean;
	originUrl?: string;
	originRepo?: string;
	upstreamUrl?: string;
	upstreamRepo?: string;
	localAheadOrigin?: number;
	localBehindOrigin?: number;
	forkAheadUpstream?: number;
	forkBehindUpstream?: number;
	fetchError?: string;
}

export interface InstallStatus {
	kind: InstallKind;
	ompPath?: string;
	bunGlobalBinDir?: string;
	source?: SourceCheckoutStatus;
	latestReleaseVersion?: string;
	latestReleaseError?: string;
}

export interface StartupUpdateNotification {
	title: string;
	lines: string[];
}

export interface InstallStatusOptions {
	checkRemotes: boolean;
	ompPath?: string;
	bunGlobalBinDir?: string;
	fetchLatestRelease?: boolean;
}

export interface SourceCheckoutDirOptions {
	env?: Environment;
	platform?: NodeJS.Platform;
	homeDir?: string;
}

function normalizePath(filePath: string): string {
	const normalized = path.normalize(filePath);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

function statOrUndefined(p: string): fs.Stats | undefined {
	try {
		return fs.statSync(p);
	} catch {
		return undefined;
	}
}

function pathExists(p: string): boolean {
	return statOrUndefined(p) !== undefined;
}

function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePath(path.resolve(filePath));
	const normalizedDirectory = normalizePath(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!fileDir || !dirReal) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

export async function getBunGlobalBinDir(): Promise<string | undefined> {
	if (!$which("bun")) return undefined;
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

export function normalizeGitRemoteUrl(remoteUrl: string | undefined): string | undefined {
	if (!remoteUrl) return undefined;
	let value = remoteUrl.trim();
	if (!value) return undefined;
	if (value.startsWith("git+")) value = value.slice(4);

	const scpPrefix = "git@github.com:";
	if (value.startsWith(scpPrefix)) {
		return value
			.slice(scpPrefix.length)
			.replace(/\.git$/u, "")
			.toLowerCase();
	}

	try {
		const parsed = new URL(value);
		if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
		const pathname = parsed.pathname.replace(/^\/+|\.git$/gu, "");
		return pathname ? pathname.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}

export function remoteMatchesRepo(remoteUrl: string | undefined, repo: string): boolean {
	return normalizeGitRemoteUrl(remoteUrl) === repo.toLowerCase();
}

export function getDefaultSourceCheckoutDir(options: SourceCheckoutDirOptions = {}): string {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const homeDir = options.homeDir ?? os.homedir();
	const override = env.OMP_SOURCE_DIR ?? env.PI_SOURCE_DIR;
	if (override) return override;

	if (platform === "win32") {
		const localAppData = env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local");
		return path.join(localAppData, "omp", "source", "oh-my-pi");
	}

	const dataHome = env.XDG_DATA_HOME ?? path.join(homeDir, ".local", "share");
	return path.join(dataHome, "omp", "source", "oh-my-pi");
}

function packageMarkerExists(root: string): boolean {
	return pathExists(path.join(root, "packages", "coding-agent", "package.json"));
}

export function findGitRootFromPath(startPath: string): string | undefined {
	const real = tryRealpath(startPath) ?? startPath;
	const stats = statOrUndefined(real);
	let current = stats?.isDirectory() ? real : path.dirname(real);

	while (true) {
		if (pathExists(path.join(current, ".git")) && packageMarkerExists(current)) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function resolveSourceRootFromOmpPath(ompPath: string | undefined): string | undefined {
	if (!ompPath) return undefined;
	const direct = findGitRootFromPath(ompPath);
	if (direct) return direct;
	const real = tryRealpath(ompPath);
	return real ? findGitRootFromPath(real) : undefined;
}

export async function runGit(root: string, args: string[]): Promise<GitCommandResult> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: root,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

async function readGitOutput(root: string, args: string[]): Promise<string | undefined> {
	try {
		const result = await runGit(root, args);
		if (result.exitCode !== 0) return undefined;
		const output = result.stdout.trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

async function fetchRemote(root: string, remote: string): Promise<string | undefined> {
	try {
		const result = await runGit(root, ["fetch", "--quiet", remote]);
		if (result.exitCode === 0) return undefined;
		return (result.stderr || result.stdout).trim() || `git fetch ${remote} failed with exit code ${result.exitCode}`;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

async function readDivergence(root: string, left: string, right: string): Promise<GitDivergence | undefined> {
	const output = await readGitOutput(root, ["rev-list", "--left-right", "--count", `${left}...${right}`]);
	if (!output) return undefined;
	const [aheadText, behindText] = output.split(/\s+/u);
	const ahead = Number(aheadText);
	const behind = Number(behindText);
	if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return undefined;
	return { ahead, behind };
}

export async function readSourceCheckoutStatus(
	root: string,
	options: { fetchRemotes: boolean },
): Promise<SourceCheckoutStatus> {
	const [branch, head, statusOutput, originUrl, upstreamUrl] = await Promise.all([
		readGitOutput(root, ["branch", "--show-current"]),
		readGitOutput(root, ["rev-parse", "--short", "HEAD"]),
		readGitOutput(root, ["status", "--porcelain"]),
		readGitOutput(root, ["remote", "get-url", "origin"]),
		readGitOutput(root, ["remote", "get-url", "upstream"]),
	]);

	let fetchError: string | undefined;
	if (options.fetchRemotes) {
		const remotes: string[] = [];
		if (originUrl) remotes.push("origin");
		if (upstreamUrl) remotes.push("upstream");
		const errors = await Promise.all(remotes.map(remote => fetchRemote(root, remote)));
		fetchError = errors.find((error): error is string => Boolean(error));
	}

	const status: SourceCheckoutStatus = {
		root,
		branch,
		head,
		dirty: statusOutput !== undefined && statusOutput.length > 0,
		originUrl,
		originRepo: normalizeGitRemoteUrl(originUrl),
		upstreamUrl,
		upstreamRepo: normalizeGitRemoteUrl(upstreamUrl),
		fetchError,
	};

	if (branch && originUrl) {
		const localDivergence = await readDivergence(root, "HEAD", `origin/${branch}`);
		status.localAheadOrigin = localDivergence?.ahead;
		status.localBehindOrigin = localDivergence?.behind;
	}

	if (branch && originUrl && upstreamUrl) {
		const forkDivergence = await readDivergence(root, `origin/${branch}`, `upstream/${branch}`);
		status.forkAheadUpstream = forkDivergence?.ahead;
		status.forkBehindUpstream = forkDivergence?.behind;
	}

	return status;
}

async function fetchLatestForkReleaseVersion(): Promise<{ version?: string; error?: string }> {
	try {
		const response = await fetch(`https://api.github.com/repos/${FORK_REPO}/releases/latest`);
		if (!response.ok) return { error: response.statusText };
		const data = (await response.json()) as { tag_name?: string };
		const tag = data.tag_name;
		if (!tag) return { error: "latest release has no tag" };
		return { version: tag.replace(/^v/u, "") };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export async function readInstallStatus(options: InstallStatusOptions): Promise<InstallStatus> {
	const ompPath = options.ompPath ?? $which(APP_NAME) ?? undefined;
	const bunGlobalBinDir = options.bunGlobalBinDir ?? (await getBunGlobalBinDir());
	const sourceRoot = resolveSourceRootFromOmpPath(ompPath);
	const source = sourceRoot
		? await readSourceCheckoutStatus(sourceRoot, { fetchRemotes: options.checkRemotes })
		: undefined;

	let kind: InstallKind;
	if (source) {
		kind = remoteMatchesRepo(source.originUrl, FORK_REPO) ? "fork-source" : "other-source";
	} else if (ompPath && bunGlobalBinDir && isPathInDirectory(ompPath, bunGlobalBinDir)) {
		kind = "package";
	} else if (ompPath) {
		kind = "binary";
	} else {
		kind = "unknown";
	}

	const result: InstallStatus = {
		kind,
		ompPath,
		bunGlobalBinDir,
		source,
	};

	if (options.fetchLatestRelease && (kind === "package" || kind === "binary")) {
		const release = await fetchLatestForkReleaseVersion();
		result.latestReleaseVersion = release.version;
		result.latestReleaseError = release.error;
	}

	return result;
}

function pushLine(lines: string[], line: string): void {
	if (lines.length < 4) lines.push(line);
}

export function buildStartupUpdateNotification(
	status: InstallStatus,
	currentVersion: string,
): StartupUpdateNotification | undefined {
	const lines: string[] = [];

	if (status.source) {
		const source = status.source;
		const branch = source.branch ?? DEFAULT_SOURCE_BRANCH;
		if (status.kind !== "fork-source") {
			const sourceRepo = source.originRepo ?? "unknown source";
			pushLine(lines, `Install source: ${sourceRepo}; expected ${FORK_REPO}`);
		}
		if (source.dirty) pushLine(lines, "Local changes: dirty checkout");
		if ((source.localBehindOrigin ?? 0) > 0) {
			pushLine(lines, `Update available: fork ${branch} +${source.localBehindOrigin} commits`);
		}
		if ((source.localAheadOrigin ?? 0) > 0) {
			pushLine(lines, `Local branch: ahead fork by ${source.localAheadOrigin} commits`);
		}
		if ((source.forkBehindUpstream ?? 0) > 0) {
			pushLine(
				lines,
				`Fork behind upstream by ${source.forkBehindUpstream} commits (/upstream-sync to get upstream changes)`,
			);
		}
	} else if (status.kind === "package" || status.kind === "binary") {
		if (status.latestReleaseVersion && Bun.semver.order(status.latestReleaseVersion, currentVersion) > 0) {
			pushLine(lines, `Update available: fork release ${status.latestReleaseVersion}`);
		}
		const installSource = status.kind === "package" ? "npm package" : "binary";
		const migrationCommand = status.kind === "package" ? `${APP_NAME} update` : "fork installer";
		pushLine(lines, `Install source: ${installSource}; run ${migrationCommand} to migrate`);
	}

	if (lines.length === 0) return undefined;
	return { title: "Update Status", lines };
}

export async function checkForInstallStatus(currentVersion: string): Promise<StartupUpdateNotification | undefined> {
	const status = await readInstallStatus({
		checkRemotes: true,
		fetchLatestRelease: true,
	});
	return buildStartupUpdateNotification(status, currentVersion);
}
