import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

const FILE_CONTENT = "bridge write content\n";

function createSession(cwd: string, bridge?: ClientBridge): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getClientBridge: bridge ? () => bridge : undefined,
	};
}

describe("write tool ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-acp-fs-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("routes plain text writes through the bridge and does not call Bun.write", async () => {
		const filePath = path.join(tmpDir, "output.txt");

		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => undefined,
		};

		const bridgeSpy = spyOn(bridge, "writeTextFile");
		const bunWriteSpy = spyOn(Bun, "write");

		try {
			const session = createSession(tmpDir, bridge);
			const tool = new WriteTool(session);

			const result = await tool.execute("call-1", { path: filePath, content: FILE_CONTENT });

			// Bridge was called with the exact path and content
			expect(bridgeSpy).toHaveBeenCalledTimes(1);
			expect(bridgeSpy).toHaveBeenCalledWith({ path: filePath, content: FILE_CONTENT });
			// Disk write must not have been called — bridge is the destination
			expect(bunWriteSpy).not.toHaveBeenCalled();
			expect(result.details?.bridge).toEqual({ readBack: "unavailable", diagnostics: "skipped" });
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
				"filesystem read-back unavailable",
			);
		} finally {
			bunWriteSpy.mockRestore();
		}
	});

	it("records verified bridge writes when filesystem read-back matches", async () => {
		const filePath = path.join(tmpDir, "output.txt");

		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async ({ path: writePath, content }) => {
				await fs.writeFile(writePath, content);
			},
		};

		const bunWriteSpy = spyOn(Bun, "write");

		try {
			const session = createSession(tmpDir, bridge);
			const tool = new WriteTool(session);

			const result = await tool.execute("call-2", { path: filePath, content: FILE_CONTENT });

			expect(await fs.readFile(filePath, "utf8")).toBe(FILE_CONTENT);
			expect(bunWriteSpy).not.toHaveBeenCalled();
			expect(result.details?.bridge).toEqual({ readBack: "verified", diagnostics: "skipped" });
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("LSP diagnostics skipped");
		} finally {
			bunWriteSpy.mockRestore();
		}
	});
});
