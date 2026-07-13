import { describe, expect, it } from "bun:test";
import { toolWireSchema, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createTools } from "@oh-my-pi/pi-coding-agent/tools";
import {
	CheckpointTool,
	KeepCheckpointTool,
	RewindTool,
	type SealReport,
	SealTool,
} from "@oh-my-pi/pi-coding-agent/tools/checkpoint";

const activeCheckpoint = {
	checkpointMessageCount: 1,
	checkpointEntryId: "checkpoint-entry",
	startedAt: "2026-07-11T00:00:00.000Z",
};

function makeSession(options: { enabled?: boolean; depth?: number; active?: boolean } = {}): ToolSession {
	return {
		cwd: "/tmp/checkpoint-surface-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "checkpoint.enabled": options.enabled ?? true }),
		taskDepth: options.depth,
		getCheckpointState: () => (options.active === false ? undefined : activeCheckpoint),
	};
}

const report: SealReport = {
	outcome: "Implemented checkpoint closure tools.",
	durableContext: ["Lifecycle handling consumes typed tool details."],
	decisions: [{ decision: "Keep closure verbs separate.", reason: "Avoid invalid argument combinations." }],
	verification: [{ contract: "Surface is gated.", evidence: "Focused factory test passed." }],
	remaining: [],
	next: "Apply lifecycle handling.",
};

describe("checkpoint lifecycle tool surface", () => {
	it("keeps legacy checkpoint and rewind inputs wire compatible", () => {
		const session = makeSession();
		expect(
			validateJsonSchemaValue(toolWireSchema(new CheckpointTool(session)), { goal: "Investigate" }).success,
		).toBe(true);
		expect(validateJsonSchemaValue(toolWireSchema(new RewindTool(session)), { report: "Findings" }).success).toBe(
			true,
		);
	});

	it("returns stable seal and keep disposition details without mutating checkpoint state", async () => {
		const session = makeSession();
		const summary = await new SealTool(session).execute("seal-summary", { strategy: "summary", report });
		const shake = await new SealTool(session).execute("seal-shake", { strategy: "shake" });
		const keep = await new KeepCheckpointTool(session).execute("keep", { reason: " Need exact chronology. " });

		expect(summary.details).toEqual({ disposition: "seal", strategy: "summary", report });
		expect(shake.details).toEqual({ disposition: "seal", strategy: "shake" });
		expect(keep.details).toEqual({ disposition: "keep", reason: "Need exact chronology." });
		expect(session.getCheckpointState?.()).toEqual(activeCheckpoint);
	});

	it("requires an active checkpoint and a report for summary sealing", async () => {
		await expect(new SealTool(makeSession()).execute("missing-report", { strategy: "summary" })).rejects.toThrow(
			"Summary seal requires a structured report.",
		);
		await expect(
			new SealTool(makeSession()).execute("blank-report", {
				strategy: "summary",
				report: { ...report, outcome: "   " },
			}),
		).rejects.toThrow("cannot contain blank text");
		await expect(
			new SealTool(makeSession({ active: false })).execute("no-checkpoint", { strategy: "shake" }),
		).rejects.toThrow("No active checkpoint");
		await expect(
			new KeepCheckpointTool(makeSession({ active: false })).execute("no-checkpoint", { reason: "Retain detail" }),
		).rejects.toThrow("No active checkpoint");
	});

	it("gates both tools and excludes them from subagents", async () => {
		const disabled = await createTools(makeSession({ enabled: false }), ["seal", "keep_checkpoint"]);
		const enabled = await createTools(makeSession(), ["seal", "keep_checkpoint"]);
		const subagent = await createTools(makeSession({ depth: 1 }), ["seal", "keep_checkpoint"]);

		expect(disabled.map(tool => tool.name)).not.toContain("seal");
		expect(disabled.map(tool => tool.name)).not.toContain("keep_checkpoint");
		expect(enabled.map(tool => tool.name)).toEqual(expect.arrayContaining(["seal", "keep_checkpoint"]));
		expect(subagent.map(tool => tool.name)).not.toContain("seal");
		expect(subagent.map(tool => tool.name)).not.toContain("keep_checkpoint");
	});

	it("publishes strict discoverable read-approved definitions", () => {
		for (const tool of [new SealTool(makeSession()), new KeepCheckpointTool(makeSession())]) {
			expect(tool.strict).toBe(true);
			expect(tool.loadMode).toBe("discoverable");
			expect(tool.approval).toBe("read");
		}
		expect(
			validateJsonSchemaValue(toolWireSchema(new SealTool(makeSession())), { strategy: "shake", extra: true })
				.success,
		).toBe(false);
	});
});
