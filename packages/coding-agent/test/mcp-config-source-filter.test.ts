import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("MCP config source filtering", () => {
	let tempDir: string;
	let projectDir: string;
	let homeDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-mcp-source-filter-${Snowflake.next()}`);
		projectDir = path.join(tempDir, "project");
		homeDir = path.join(tempDir, "home");
		fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
		fs.mkdirSync(path.join(homeDir, ".omp", "agent"), { recursive: true });
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeMcpConfig(filePath: string, serverName: string): void {
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				mcpServers: {
					[serverName]: {
						type: "stdio",
						command: "echo",
						args: [serverName],
					},
				},
			}),
		);
	}

	it("loads project MCP config by default but skips user/global MCP config", async () => {
		writeMcpConfig(path.join(projectDir, ".omp", "mcp.json"), "project-server");
		writeMcpConfig(path.join(homeDir, ".omp", "agent", "mcp.json"), "user-server");

		const result = await loadAllMCPConfigs(projectDir);

		expect(Object.keys(result.configs).sort()).toEqual(["project-server"]);
		expect(result.sources["project-server"]?.level).toBe("project");
	});

	it("loads user/global MCP config only when enabled", async () => {
		writeMcpConfig(path.join(projectDir, ".omp", "mcp.json"), "project-server");
		writeMcpConfig(path.join(homeDir, ".omp", "agent", "mcp.json"), "user-server");

		const result = await loadAllMCPConfigs(projectDir, { enableUserConfig: true });

		expect(Object.keys(result.configs).sort()).toEqual(["project-server", "user-server"]);
		expect(result.sources["user-server"]?.level).toBe("user");
	});
});
