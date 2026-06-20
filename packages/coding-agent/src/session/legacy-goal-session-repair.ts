import { isEnoent, readLines } from "@oh-my-pi/pi-utils";
import { parseGoalModeState, serializeGoalModeState } from "../goals/state";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type GoalStateSnapshotEntry,
	type SessionHeader,
} from "./session-entries";
import { compactLegacyGoalPersistence, generateId } from "./session-migrations";
import { FileSessionStorage, type SessionStorage } from "./session-storage";

interface CompactGoalModeData {
	goalId: string;
	stateVersion: number;
	snapshotEntryId: string;
}

interface MigratedLegacyGoalMarker {
	markerId: string;
	serializedStateSignature: string;
	snapshotEntryId: string;
}

const HEADER_READ_BYTES = 64 * 1024;
const utf8Decoder = new TextDecoder("utf-8");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCompactGoalModeData(data: unknown): CompactGoalModeData | undefined {
	if (!isRecord(data)) return undefined;
	if (
		typeof data.goalId !== "string" ||
		typeof data.stateVersion !== "number" ||
		typeof data.snapshotEntryId !== "string"
	) {
		return undefined;
	}
	return {
		goalId: data.goalId,
		stateVersion: data.stateVersion,
		snapshotEntryId: data.snapshotEntryId,
	};
}

function parseHeaderFromWindow(window: string): SessionHeader | undefined {
	if (window.length === 0) return undefined;
	const newline = window.indexOf("\n");
	const line = newline === -1 ? window : window.slice(0, newline);
	if (line.trim().length === 0) return undefined;
	try {
		const parsed = JSON.parse(line) as unknown;
		if (!isRecord(parsed) || parsed.type !== "session" || typeof parsed.id !== "string") return undefined;
		return parsed as unknown as SessionHeader;
	} catch {
		return undefined;
	}
}

function isGoalModeChangeEntry(entry: FileEntry): entry is Extract<FileEntry, { type: "mode_change" }> {
	return entry.type === "mode_change" && (entry.mode === "goal" || entry.mode === "goal_paused");
}

function isGoalToolResultEntry(entry: FileEntry): entry is Extract<FileEntry, { type: "message" }> {
	return entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "goal";
}

function compactGoalToolResultLine(entry: FileEntry): string | undefined {
	if (!isGoalToolResultEntry(entry)) return undefined;
	if (!compactLegacyGoalPersistence([entry])) return undefined;
	return `${JSON.stringify(entry)}\n`;
}

function compactLegacyModeLine(
	entry: FileEntry,
	ids: Set<string>,
	previousMigratedMarker: MigratedLegacyGoalMarker | undefined,
): { chunk: string; previousMigratedMarker: MigratedLegacyGoalMarker | undefined } | undefined {
	if (!isGoalModeChangeEntry(entry)) return undefined;
	if (readCompactGoalModeData(entry.data)) {
		return { chunk: `${JSON.stringify(entry)}\n`, previousMigratedMarker: undefined };
	}
	const state = parseGoalModeState(entry.data, entry.mode === "goal");
	if (!state) return { chunk: `${JSON.stringify(entry)}\n`, previousMigratedMarker: undefined };
	const serialized = serializeGoalModeState(state);
	const serializedStateSignature = JSON.stringify(serialized);
	const previous = previousMigratedMarker;
	const duplicateOfPrevious =
		previous !== undefined &&
		entry.parentId === previous.markerId &&
		serializedStateSignature === previous.serializedStateSignature;
	const snapshotEntryId = duplicateOfPrevious ? previous.snapshotEntryId : generateId({ has: id => ids.has(id) });
	let prefix = "";
	if (!duplicateOfPrevious) {
		ids.add(snapshotEntryId);
		const snapshot: GoalStateSnapshotEntry = {
			type: "goal_state_snapshot",
			id: snapshotEntryId,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			goalId: state.goal.id,
			stateVersion: serialized.stateVersion,
			schemaVersion: serialized.schemaVersion,
			reason: "recovery",
			state: serialized,
		};
		entry.parentId = snapshotEntryId;
		prefix = `${JSON.stringify(snapshot)}\n`;
	}
	entry.data = {
		goalId: state.goal.id,
		stateVersion: serialized.stateVersion,
		snapshotEntryId,
	};
	return {
		chunk: `${prefix}${JSON.stringify(entry)}\n`,
		previousMigratedMarker: {
			markerId: entry.id,
			serializedStateSignature,
			snapshotEntryId,
		},
	};
}

async function* repairLegacyGoalSessionLines(filePath: string): AsyncIterable<string> {
	const ids = new Set<string>();
	let firstLine = true;
	let previousMigratedMarker: MigratedLegacyGoalMarker | undefined;
	for await (const bytes of readLines(Bun.file(filePath).stream())) {
		const line = utf8Decoder.decode(bytes);
		let entry: FileEntry;
		try {
			entry = JSON.parse(line) as FileEntry;
		} catch {
			yield `${line}\n`;
			continue;
		}
		if (isRecord(entry) && typeof entry.id === "string") ids.add(entry.id);
		if (firstLine) {
			firstLine = false;
			if (isRecord(entry) && entry.type === "session" && typeof entry.id === "string") {
				(entry as SessionHeader).version = CURRENT_SESSION_VERSION;
				yield `${JSON.stringify(entry)}\n`;
				continue;
			}
		}
		const compactToolResult = compactGoalToolResultLine(entry);
		if (compactToolResult) {
			yield compactToolResult;
			continue;
		}
		const compactMode = compactLegacyModeLine(entry, ids, previousMigratedMarker);
		if (compactMode) {
			previousMigratedMarker = compactMode.previousMigratedMarker;
			yield compactMode.chunk;
			continue;
		}
		yield `${line}\n`;
	}
}

export async function repairLegacyGoalSessionFileBeforeLoad(
	filePath: string,
	storage: SessionStorage,
): Promise<boolean> {
	let head: string;
	try {
		[head] = await storage.readTextSlices(filePath, HEADER_READ_BYTES, 0);
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
	const header = parseHeaderFromWindow(head);
	if (!header) return false;
	const version = typeof header.version === "number" ? header.version : 1;
	if (version >= CURRENT_SESSION_VERSION || version !== 3) return false;
	if (!(storage instanceof FileSessionStorage)) return false;
	await storage.writeChunksAtomic(filePath, repairLegacyGoalSessionLines(filePath));
	return true;
}
