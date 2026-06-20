import { describe, expect, it } from "bun:test";
import { buildStartupUpdateNotification, type InstallStatus, normalizeGitRemoteUrl } from "../src/update/source-status";

describe("source-status remote normalization", () => {
	it("normalizes GitHub HTTPS and SSH remotes to owner/repo", () => {
		expect(normalizeGitRemoteUrl("https://github.com/casepot/oh-my-pi.git")).toBe("casepot/oh-my-pi");
		expect(normalizeGitRemoteUrl("git@github.com:can1357/oh-my-pi.git")).toBe("can1357/oh-my-pi");
	});
});

describe("source-status startup notifications", () => {
	it("stays hidden for a clean fork source checkout with no divergence", () => {
		const status: InstallStatus = {
			kind: "fork-source",
			source: {
				root: "/repo",
				branch: "main",
				dirty: false,
				originRepo: "casepot/oh-my-pi",
				upstreamRepo: "can1357/oh-my-pi",
				localAheadOrigin: 0,
				localBehindOrigin: 0,
				forkAheadUpstream: 0,
				forkBehindUpstream: 0,
			},
		};

		expect(buildStartupUpdateNotification(status, "15.6.0")).toBeUndefined();
	});

	it("summarizes local and upstream divergence compactly", () => {
		const status: InstallStatus = {
			kind: "fork-source",
			source: {
				root: "/repo",
				branch: "main",
				dirty: true,
				originRepo: "casepot/oh-my-pi",
				upstreamRepo: "can1357/oh-my-pi",
				localAheadOrigin: 1,
				localBehindOrigin: 2,
				forkBehindUpstream: 3,
			},
		};

		expect(buildStartupUpdateNotification(status, "15.6.0")).toEqual({
			title: "OMP Source Status",
			lines: [
				"OMP source checkout: dirty",
				"OMP fork main: 2 commits available",
				"OMP fork main: local branch ahead by 1 commit",
				"OMP fork main: 3 commits behind upstream (/upstream-sync to get upstream changes)",
			],
		});
	});

	it("caps source notifications at four prefixed lines", () => {
		const status: InstallStatus = {
			kind: "other-source",
			source: {
				root: "/repo",
				branch: "main",
				dirty: true,
				originRepo: "someone/oh-my-pi",
				upstreamRepo: "can1357/oh-my-pi",
				localAheadOrigin: 1,
				localBehindOrigin: 2,
				forkBehindUpstream: 3,
			},
		};

		expect(buildStartupUpdateNotification(status, "15.6.0")).toEqual({
			title: "OMP Source Status",
			lines: [
				"OMP source checkout: someone/oh-my-pi; expected casepot/oh-my-pi",
				"OMP source checkout: dirty",
				"OMP fork main: 2 commits available",
				"OMP fork main: local branch ahead by 1 commit",
			],
		});
	});

	it("marks package installs for migration to the fork source channel", () => {
		const status: InstallStatus = {
			kind: "package",
			latestReleaseVersion: "15.7.0",
		};

		expect(buildStartupUpdateNotification(status, "15.6.0")).toEqual({
			title: "OMP Install Status",
			lines: ["Update available: fork release 15.7.0", "Install source: npm package; run omp update to migrate"],
		});
	});
});
