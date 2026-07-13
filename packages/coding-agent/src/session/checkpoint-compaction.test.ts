import { describe, expect, it } from "bun:test";
import {
	buildCheckpointCompactionContext,
	CHECKPOINT_COMPACTION_PRESERVE_KEY,
	findActiveCheckpoint,
	mergeCheckpointCompactionPreserveData,
	parseCheckpointContinuation,
	renderCheckpointCompactionSummary,
} from "./checkpoint-compaction";
import type { SessionEntry } from "./session-entries";

const timestamp = "2026-07-13T00:00:00.000Z";

function checkpointEntry(id = "checkpoint-entry"): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId: "checkpoint-call",
			toolName: "checkpoint",
			content: [{ type: "text", text: "Checkpoint created." }],
			isError: false,
			details: { goal: "Investigate the compaction boundary", startedAt: timestamp },
			timestamp: 1,
		},
	};
}

function completionEntry(parentId: string): SessionEntry {
	return {
		type: "custom_message",
		id: "checkpoint-complete",
		parentId,
		timestamp,
		customType: "checkpoint-seal",
		content: "",
		display: false,
	};
}

describe("checkpoint compaction continuation", () => {
	it("builds summarizer context and a versioned capsule for the active checkpoint", () => {
		const entries = [checkpointEntry()];
		const result = buildCheckpointCompactionContext("checkpoint-entry", entries);

		expect(result?.context).toContain("Investigate the compaction boundary");
		expect(result?.context).toContain("Describe progress neutrally");
		expect(result?.preserveData[CHECKPOINT_COMPACTION_PRESERVE_KEY]).toEqual({
			schemaVersion: 1,
			status: "active",
			checkpointEntryId: "checkpoint-entry",
			goal: "Investigate the compaction boundary",
		});
	});

	it("renders a neutral active-checkpoint surface only while the capsule matches branch state", () => {
		const checkpoint = checkpointEntry();
		const activeEntries = [checkpoint];
		const preserveData = buildCheckpointCompactionContext(checkpoint.id, activeEntries)?.preserveData;

		const activeSummary = renderCheckpointCompactionSummary("Compacted progress.", preserveData, activeEntries);
		expect(activeSummary).toContain("Compacted progress.");
		expect(activeSummary).toContain("## Active checkpoint");
		expect(activeSummary).toContain('Goal: "Investigate the compaction boundary"');
		expect(activeSummary).toContain("Status: active");
		expect(activeSummary).not.toContain("seal");
		expect(activeSummary).not.toContain("rewind");

		const mismatchedGoalSummary = renderCheckpointCompactionSummary(
			"Compacted progress.",
			{
				[CHECKPOINT_COMPACTION_PRESERVE_KEY]: {
					schemaVersion: 1,
					status: "active",
					checkpointEntryId: checkpoint.id,
					goal: "Stale capsule goal",
				},
			},
			activeEntries,
		);
		expect(mismatchedGoalSummary).toContain('Goal: "Investigate the compaction boundary"');
		expect(mismatchedGoalSummary).not.toContain("Stale capsule goal");

		const closedSummary = renderCheckpointCompactionSummary("Compacted progress.", preserveData, [
			checkpoint,
			completionEntry(checkpoint.id),
		]);
		expect(closedSummary).toBe("Compacted progress.");
	});

	it("ignores stale boundaries and unknown capsule versions", () => {
		const first = checkpointEntry("first");
		const second = checkpointEntry("second");
		const entries = [first, second];
		const stale = {
			schemaVersion: 1,
			status: "active",
			checkpointEntryId: "first",
			goal: "Old goal",
		};

		expect(findActiveCheckpoint(entries)?.checkpointEntryId).toBe("second");
		expect(
			renderCheckpointCompactionSummary("Summary", { [CHECKPOINT_COMPACTION_PRESERVE_KEY]: stale }, entries),
		).toBe("Summary");
		expect(parseCheckpointContinuation({ ...stale, schemaVersion: 2 })).toBeUndefined();
	});

	it("replaces stale checkpoint preserve data without disturbing other compaction state", () => {
		const continuation = findActiveCheckpoint([checkpointEntry()]);
		const merged = mergeCheckpointCompactionPreserveData(
			{ [CHECKPOINT_COMPACTION_PRESERVE_KEY]: { schemaVersion: 99 }, providerState: "kept" },
			continuation,
		);

		expect(merged?.providerState).toBe("kept");
		expect(merged?.[CHECKPOINT_COMPACTION_PRESERVE_KEY]).toEqual(continuation);
		expect(mergeCheckpointCompactionPreserveData(merged, undefined)).toEqual({ providerState: "kept" });
	});
});
