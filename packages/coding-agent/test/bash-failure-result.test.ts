import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

function makeSession(options: { artifactDir?: string } = {}): ToolSession {
	let artifactCounter = 0;
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "bash.stripTrailingHeadTail") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "search.enabled") return false;
				if (key === "find.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		allocateOutputArtifact: options.artifactDir
			? async (toolType: string) => {
					await fs.mkdir(options.artifactDir!, { recursive: true });
					const id = `bash-failure-${++artifactCounter}`;
					return { id, path: path.join(options.artifactDir!, `${id}.${toolType}.log`) };
				}
			: undefined,
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

describe("BashTool non-zero exit", () => {
	it("resolves with an error result carrying execution details instead of throwing", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-fail", { command: "exit 3" });

		// A completed command that failed is a non-throwing error result so the
		// renderer keeps the wall time / timeout / exit-code footer.
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(3);
		expect(result.details?.timeoutSeconds).toBe(300);
		expect(typeof result.details?.wallTimeMs).toBe("number");

		// The LLM-facing text still states the exit code verbatim.
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("Command exited with code 3");
	});

	it("compacts oversized failing output while preserving the raw artifact", async () => {
		const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-failure-"));
		try {
			const tool = new BashTool(makeSession({ artifactDir }));
			const result = await tool.execute("call-large-fail", {
				command:
					'for i in {1..2500}; do printf "failure-marker-%04d repeated diagnostic detail line\\n" "$i"; done; exit 7',
			});

			expect(result.isError).toBe(true);
			expect(result.details?.exitCode).toBe(7);
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(14 * 1024);
			expect(text).toContain("failure-marker-0001");
			expect(text).toContain("failure-marker-2500");
			expect(text).toContain("Command exited with code 7");
			const artifactMatch = text.match(/\[raw output: artifact:\/\/(bash-failure-\d+)\]$/);
			expect(artifactMatch).not.toBeNull();
			expect(text).toMatch(/\[… elided \d+ bytes of bash failure output …\]/);

			const artifactId = artifactMatch?.[1];
			if (!artifactId) throw new Error("expected raw output artifact footer");
			const artifactText = await Bun.file(path.join(artifactDir, `${artifactId}.bash-original.log`)).text();
			expect(artifactText).toContain("failure-marker-0001");
			expect(artifactText).toContain("failure-marker-2500");
			expect(artifactText).toContain("Command exited with code 7");
		} finally {
			await fs.rm(artifactDir, { recursive: true, force: true });
		}
	});

	it("returns a success result with no exit-code detail for a zero exit", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-ok", { command: "printf hi" });

		expect(result.isError).toBeUndefined();
		expect(result.details?.exitCode).toBeUndefined();
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("hi");
		expect(text).not.toContain("Command exited with code");
	});
});
