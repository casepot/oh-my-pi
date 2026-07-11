import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("IRC observer settings", () => {
	it("ignores runtime overrides in getGlobal", () => {
		const settings = Settings.isolated({
			"irc.observer.enabled": true,
			"irc.observer.endpoint": "ircs://127.0.0.1:7000",
		});
		expect(settings.get("irc.observer.enabled")).toBe(true);
		expect(settings.getGlobal("irc.observer.enabled")).toBe(false);
		expect(settings.getGlobal("irc.observer.endpoint")).toBe("ircs://127.0.0.1:6697");
	});

	it("reads observer values from the global config layer", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-irc-settings-"));
		temporaryDirectories.push(root);
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "project");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"irc:\n  observer:\n    enabled: true\n    endpoint: ircs://127.0.0.1:7443\n",
		);
		const settings = await Settings.loadIsolated({ agentDir, cwd });
		expect(settings.getGlobal("irc.observer.enabled")).toBe(true);
		expect(settings.getGlobal("irc.observer.endpoint")).toBe("ircs://127.0.0.1:7443");
	});
});
