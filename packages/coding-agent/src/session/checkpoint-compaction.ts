import { prompt } from "@oh-my-pi/pi-utils";
import checkpointCompactionContextTemplate from "../prompts/system/checkpoint-compaction-context.md" with {
	type: "text",
};
import checkpointCompactionSummaryTemplate from "../prompts/system/checkpoint-compaction-summary.md" with {
	type: "text",
};
import type { SessionEntry, SessionMessageEntry } from "./session-entries";

export const CHECKPOINT_COMPACTION_PRESERVE_KEY = "checkpointContinuation";

export interface CheckpointContinuationV1 {
	schemaVersion: 1;
	status: "active";
	checkpointEntryId: string;
	goal: string;
}

export interface CheckpointCompactionContext {
	context: string;
	preserveData: Record<string, unknown>;
}

type SuccessfulCheckpointEntry = SessionMessageEntry & {
	message: { role: "toolResult"; toolName: "checkpoint"; isError?: false; details?: unknown };
};

export function isSuccessfulCheckpointEntry(entry: SessionEntry): entry is SuccessfulCheckpointEntry {
	return (
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolName === "checkpoint" &&
		entry.message.isError !== true
	);
}

export function findActiveCheckpoint(entries: readonly SessionEntry[]): CheckpointContinuationV1 | undefined {
	let active: CheckpointContinuationV1 | undefined;
	for (const entry of entries) {
		if (isSuccessfulCheckpointEntry(entry)) {
			const details = entry.message.details;
			active = {
				schemaVersion: 1,
				status: "active",
				checkpointEntryId: entry.id,
				goal:
					details && typeof details === "object" && "goal" in details && typeof details.goal === "string"
						? details.goal
						: "",
			};
			continue;
		}
		if (
			entry.type === "custom_message" &&
			(entry.customType === "checkpoint-keep" ||
				entry.customType === "checkpoint-seal" ||
				entry.customType === "rewind-report")
		) {
			active = undefined;
		}
	}
	return active;
}

export function buildCheckpointContinuation(
	checkpointEntryId: string | null | undefined,
	entries: readonly SessionEntry[],
): CheckpointContinuationV1 | undefined {
	if (!checkpointEntryId) return undefined;
	const active = findActiveCheckpoint(entries);
	return active?.checkpointEntryId === checkpointEntryId ? active : undefined;
}

export function buildCheckpointCompactionContext(
	checkpointEntryId: string | null | undefined,
	entries: readonly SessionEntry[],
): CheckpointCompactionContext | undefined {
	const continuation = buildCheckpointContinuation(checkpointEntryId, entries);
	if (!continuation) return undefined;
	return {
		context: prompt.render(checkpointCompactionContextTemplate, { goal: JSON.stringify(continuation.goal) }),
		preserveData: { [CHECKPOINT_COMPACTION_PRESERVE_KEY]: continuation },
	};
}

export function parseCheckpointContinuation(value: unknown): CheckpointContinuationV1 | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<CheckpointContinuationV1>;
	if (
		candidate.schemaVersion !== 1 ||
		candidate.status !== "active" ||
		typeof candidate.checkpointEntryId !== "string" ||
		candidate.checkpointEntryId.length === 0 ||
		typeof candidate.goal !== "string"
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		status: "active",
		checkpointEntryId: candidate.checkpointEntryId,
		goal: candidate.goal,
	};
}

export function mergeCheckpointCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
	continuation: CheckpointContinuationV1 | undefined,
): Record<string, unknown> | undefined {
	const merged = { ...(preserveData ?? {}) };
	delete merged[CHECKPOINT_COMPACTION_PRESERVE_KEY];
	if (continuation) merged[CHECKPOINT_COMPACTION_PRESERVE_KEY] = continuation;
	return Object.keys(merged).length > 0 ? merged : undefined;
}

export function renderCheckpointCompactionSummary(
	summary: string,
	preserveData: Record<string, unknown> | undefined,
	entries: readonly SessionEntry[],
): string {
	const continuation = parseCheckpointContinuation(preserveData?.[CHECKPOINT_COMPACTION_PRESERVE_KEY]);
	if (!continuation) return summary;
	const active = findActiveCheckpoint(entries);
	if (active?.checkpointEntryId !== continuation.checkpointEntryId) return summary;
	return prompt.render(checkpointCompactionSummaryTemplate, {
		summary,
		goal: JSON.stringify(active.goal),
	});
}
