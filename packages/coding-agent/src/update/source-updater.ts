import * as fs from "node:fs";
import * as path from "node:path";
import { APP_NAME, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import {
	DEFAULT_SOURCE_BRANCH,
	FORK_REPO,
	FORK_REPO_URL,
	readSourceCheckoutStatus,
	remoteMatchesRepo,
	runGit,
	type SourceCheckoutStatus,
	UPSTREAM_REPO_URL,
} from "./source-status";

export interface SourceUpdateTarget {
	method: "source";
	root: string;
	mode: "linked" | "migrate";
}

export interface SourceUpdateOptions {
	force: boolean;
	check: boolean;
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

interface ForkDefaultBranchDivergence {
	ahead: number;
	behind: number;
}

async function fetchForkDefaultBranch(root: string): Promise<void> {
	await runProcess(
		"git",
		["fetch", "origin", `+refs/heads/${DEFAULT_SOURCE_BRANCH}:refs/remotes/origin/${DEFAULT_SOURCE_BRANCH}`],
		root,
	);
}

async function hasGitCommit(root: string, ref: string): Promise<boolean> {
	const result = await runGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	return result.exitCode === 0;
}

async function hasLocalBranch(root: string, branch: string): Promise<boolean> {
	const result = await runGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
	return result.exitCode === 0;
}

async function readForkDefaultBranchDivergence(root: string, left: string): Promise<ForkDefaultBranchDivergence> {
	const right = `origin/${DEFAULT_SOURCE_BRANCH}`;
	const result = await runGit(root, ["rev-list", "--left-right", "--count", `${left}...${right}`]);
	if (result.exitCode !== 0) {
		const details = (result.stderr || result.stdout).trim();
		throw new Error(
			`Could not compare source checkout with fork ${DEFAULT_SOURCE_BRANCH}${details ? `: ${details}` : ""}`,
		);
	}
	const [aheadText, behindText] = result.stdout.trim().split(/\s+/u);
	const ahead = Number(aheadText);
	const behind = Number(behindText);
	if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
		throw new Error(`Could not parse source checkout divergence from fork ${DEFAULT_SOURCE_BRANCH}`);
	}
	return { ahead, behind };
}

async function assertNoLocalCommitsAgainstForkDefaultBranch(
	root: string,
	ref: string,
	description: string,
): Promise<ForkDefaultBranchDivergence | undefined> {
	if (!(await hasGitCommit(root, ref))) return undefined;

	const divergence = await readForkDefaultBranchDivergence(root, ref);
	if (divergence.ahead > 0) {
		const relation = divergence.behind > 0 ? "has diverged from" : "is ahead of";
		const commits = `${divergence.ahead} local commit${divergence.ahead === 1 ? "" : "s"}`;
		throw new Error(
			`Source checkout ${description} ${relation} fork ${DEFAULT_SOURCE_BRANCH} with ${commits} not on origin/${DEFAULT_SOURCE_BRANCH} at ${root}; push them, create a branch, back up the checkout, or choose another source directory before running ${APP_NAME} update.`,
		);
	}

	return divergence;
}

async function updateExistingForkSourceCheckout(root: string, status: SourceCheckoutStatus): Promise<void> {
	const currentDivergence = await assertNoLocalCommitsAgainstForkDefaultBranch(root, "HEAD", "HEAD");
	if (!currentDivergence) {
		await runProcess("git", ["checkout", "-B", DEFAULT_SOURCE_BRANCH, `origin/${DEFAULT_SOURCE_BRANCH}`], root);
		return;
	}

	if (status.branch === DEFAULT_SOURCE_BRANCH) {
		if (currentDivergence.behind > 0) {
			await runProcess("git", ["merge", "--ff-only", `origin/${DEFAULT_SOURCE_BRANCH}`], root);
		}
		return;
	}

	if (await hasLocalBranch(root, DEFAULT_SOURCE_BRANCH)) {
		const defaultBranchDivergence = await assertNoLocalCommitsAgainstForkDefaultBranch(
			root,
			`refs/heads/${DEFAULT_SOURCE_BRANCH}`,
			`${DEFAULT_SOURCE_BRANCH} branch`,
		);
		await runProcess("git", ["checkout", DEFAULT_SOURCE_BRANCH], root);
		if ((defaultBranchDivergence?.behind ?? 0) > 0) {
			await runProcess("git", ["merge", "--ff-only", `origin/${DEFAULT_SOURCE_BRANCH}`], root);
		}
		return;
	}

	await runProcess("git", ["checkout", "-b", DEFAULT_SOURCE_BRANCH, `origin/${DEFAULT_SOURCE_BRANCH}`], root);
}

async function prepareForkSourceCheckout(root: string): Promise<SourceCheckoutStatus> {
	const gitPath = path.join(root, ".git");
	let existingStatus: SourceCheckoutStatus | undefined;
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
		existingStatus = await ensureSourceCheckoutCleanForUpdate(root);
		await ensureRemoteUrl(root, "origin", existingStatus.originUrl, FORK_REPO_URL);
		await ensureRemoteUrl(root, "upstream", existingStatus.upstreamUrl, UPSTREAM_REPO_URL);
	}

	await fetchForkDefaultBranch(root);
	if (existingStatus) {
		await updateExistingForkSourceCheckout(root, existingStatus);
	} else {
		await runProcess("git", ["checkout", "-B", DEFAULT_SOURCE_BRANCH, `origin/${DEFAULT_SOURCE_BRANCH}`], root);
	}
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

export async function updateViaSource(target: SourceUpdateTarget, opts: SourceUpdateOptions): Promise<void> {
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

	let status = await readSourceCheckoutStatus(target.root, { fetchRemotes: true });
	if (status.dirty) {
		throw new Error(
			`Source checkout has uncommitted changes at ${target.root}; commit or stash them before running ${APP_NAME} update.`,
		);
	}
	if (!remoteMatchesRepo(status.originUrl, FORK_REPO)) {
		const repo = status.originRepo ?? status.originUrl ?? "unknown";
		throw new Error(`Source checkout tracks ${repo}; expected ${FORK_REPO}. Run the fork installer to migrate.`);
	}

	await ensureRemoteUrl(target.root, "upstream", status.upstreamUrl, UPSTREAM_REPO_URL);
	status = await readSourceCheckoutStatus(target.root, { fetchRemotes: true });

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
