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
