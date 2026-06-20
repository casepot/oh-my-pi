import { Snowflake } from "@oh-my-pi/pi-utils";
import {
	type Goal,
	type GoalCheckpointPacket,
	type GoalCheckpointResolution,
	type GoalCheckpointReview,
	type GoalCompletionVerificationDetails,
	type GoalModeState,
	type GoalToolDetails,
	normalizeGoal,
	normalizeGoalModeState,
	parseGoalModeState,
	serializeGoalModeState,
} from "../goals/state";
import { buildGoalToolDetails } from "../goals/tool-details";
import {
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type GoalStateSnapshotEntry,
	type SessionHeader,
} from "./session-entries";

/** Generate a unique short ID (8 hex chars, collision-checked) */
export function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = crypto.randomUUID().slice(-8);
		if (!byId.has(id)) return id;
	}
	return Snowflake.next(); // fallback to full snowflake id
}

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

const GOAL_TOOL_OPS = new Set<GoalToolDetails["op"]>([
	"create",
	"get",
	"complete",
	"resume",
	"drop",
	"start_target",
	"checkpoint",
	"resolve_checkpoint",
	"submit_target_plan",
	"fail_target_plan",
]);

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

function readGoalToolOp(value: unknown): GoalToolDetails["op"] | undefined {
	if (typeof value !== "string") return undefined;
	const op = value as GoalToolDetails["op"];
	return GOAL_TOOL_OPS.has(op) ? op : undefined;
}

function readNullableNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function goalToolDetailsNeedCompaction(details: Record<string, unknown>): boolean {
	if ("targetPlan" in details || "targetPlanReviews" in details) return true;
	const goal = details.goal;
	if (
		isRecord(goal) &&
		("createdAt" in goal ||
			"updatedAt" in goal ||
			"rubric" in goal ||
			"deliverableMap" in goal ||
			"parentFrame" in goal ||
			"targets" in goal ||
			"checkpoints" in goal ||
			"checkpointResolutions" in goal ||
			"currentTargetPlan" in goal ||
			"targetPlans" in goal)
	) {
		return true;
	}
	const state = details.state;
	if (isRecord(state) && ("goal" in state || "mode" in state || "reason" in state)) return true;
	const checkpoint = details.checkpoint;
	if (
		isRecord(checkpoint) &&
		("targetSnapshot" in checkpoint ||
			"parentFrameVersion" in checkpoint ||
			"baselineRefs" in checkpoint ||
			"gateRefs" in checkpoint ||
			"evidence" in checkpoint ||
			"checksRun" in checkpoint ||
			"artifactsTouched" in checkpoint ||
			"risksOrCaveats" in checkpoint ||
			"suggestedControllerQuestions" in checkpoint)
	) {
		return true;
	}
	const checkpointReview = details.checkpointReview;
	if (
		isRecord(checkpointReview) &&
		("evidenceChecked" in checkpointReview ||
			"blockers" in checkpointReview ||
			"continuationFocus" in checkpointReview ||
			"reviewedAt" in checkpointReview ||
			"sideAgentTokensUsed" in checkpointReview)
	) {
		return true;
	}
	const checkpointResolution = details.checkpointResolution;
	return (
		isRecord(checkpointResolution) &&
		("sequence" in checkpointResolution ||
			"goalId" in checkpointResolution ||
			"parentReading" in checkpointResolution ||
			"parentDelta" in checkpointResolution ||
			"notPropagated" in checkpointResolution ||
			"remainingParentWork" in checkpointResolution ||
			"broaderChecksOrInputs" in checkpointResolution ||
			"lessonsForFuture" in checkpointResolution ||
			"createdAt" in checkpointResolution)
	);
}

function readGoalFromDetails(details: Record<string, unknown>): Goal | null {
	const state = normalizeGoalModeState(details.state);
	return (
		normalizeGoal(details.goal) ?? state?.goal ?? (isRecord(details.goal) ? (details.goal as unknown as Goal) : null)
	);
}

function readStateFromDetails(details: Record<string, unknown>, goal: Goal | null): GoalModeState | null {
	const normalized = normalizeGoalModeState(details.state);
	if (normalized) return normalized;
	if (!isRecord(details.state)) return null;
	const runMode = typeof details.state.runMode === "string" ? details.state.runMode : undefined;
	const stateVersion = typeof details.state.stateVersion === "number" ? details.state.stateVersion : undefined;
	const parentFrameVersion =
		typeof details.state.parentFrameVersion === "number" ? details.state.parentFrameVersion : undefined;
	const goalId = typeof details.state.goalId === "string" ? details.state.goalId : goal?.id;
	if (!runMode || stateVersion === undefined || parentFrameVersion === undefined || !goalId) return null;
	return {
		enabled: details.state.enabled === true,
		mode: "active",
		runMode: runMode as GoalModeState["runMode"],
		stateVersion,
		parentFrameVersion,
		goal: (goal ?? { id: goalId }) as Goal,
	};
}

function readCheckpointFromDetails(details: Record<string, unknown>): GoalCheckpointPacket | undefined {
	const checkpoint = details.checkpoint;
	if (!isRecord(checkpoint)) return undefined;
	if (
		typeof checkpoint.id !== "string" ||
		typeof checkpoint.sequence !== "number" ||
		typeof checkpoint.targetId !== "string" ||
		typeof checkpoint.summary !== "string"
	) {
		return undefined;
	}
	return {
		...checkpoint,
		notClaimed: readStringArray(checkpoint.notClaimed),
		remainingQuestions: readStringArray(checkpoint.remainingQuestions),
	} as unknown as GoalCheckpointPacket;
}

function readCheckpointReviewFromDetails(details: Record<string, unknown>): GoalCheckpointReview | undefined {
	const review = details.checkpointReview;
	if (!isRecord(review)) return undefined;
	if (typeof review.status !== "string" || typeof review.feedback !== "string") return undefined;
	return review as unknown as GoalCheckpointReview;
}

function readCheckpointResolutionFromDetails(details: Record<string, unknown>): GoalCheckpointResolution | undefined {
	const resolution = details.checkpointResolution;
	if (!isRecord(resolution)) return undefined;
	if (
		typeof resolution.id !== "string" ||
		typeof resolution.checkpointId !== "string" ||
		typeof resolution.decision !== "string"
	) {
		return undefined;
	}
	return resolution as unknown as GoalCheckpointResolution;
}

function compactGoalToolDetails(details: unknown): GoalToolDetails | undefined {
	if (!isRecord(details) || !goalToolDetailsNeedCompaction(details)) return undefined;
	const op = readGoalToolOp(details.op);
	if (!op) return undefined;
	const goal = readGoalFromDetails(details);
	const state = readStateFromDetails(details, goal);
	return buildGoalToolDetails(op, {
		goal,
		state,
		remainingTokens: readNullableNumber(details.remainingTokens),
		completionBudgetReport: readNullableString(details.completionBudgetReport),
		completionVerification: isRecord(details.completionVerification)
			? (details.completionVerification as unknown as GoalCompletionVerificationDetails)
			: undefined,
		checkpoint: readCheckpointFromDetails(details),
		checkpointReview: readCheckpointReviewFromDetails(details),
		checkpointResolution: readCheckpointResolutionFromDetails(details),
		targetPlanApproval: isRecord(details.targetPlanApproval)
			? (details.targetPlanApproval as unknown as GoalToolDetails["targetPlanApproval"])
			: undefined,
	});
}

export function compactLegacyGoalPersistence(entries: FileEntry[]): boolean {
	let changed = false;
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "session") ids.add(entry.id);
	}
	let previousMigratedMarker: MigratedLegacyGoalMarker | undefined;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "goal") {
			const compactDetails = compactGoalToolDetails(entry.message.details);
			if (compactDetails) {
				entry.message.details = compactDetails;
				changed = true;
			}
			continue;
		}
		if (entry.type !== "mode_change" || (entry.mode !== "goal" && entry.mode !== "goal_paused")) continue;
		if (readCompactGoalModeData(entry.data)) {
			previousMigratedMarker = undefined;
			continue;
		}
		const state = parseGoalModeState(entry.data, entry.mode === "goal");
		if (!state) {
			previousMigratedMarker = undefined;
			continue;
		}
		const serialized = serializeGoalModeState(state);
		const serializedStateSignature = JSON.stringify(serialized);
		const previous = previousMigratedMarker;
		const duplicateOfPrevious =
			previous !== undefined &&
			entry.parentId === previous.markerId &&
			serializedStateSignature === previous.serializedStateSignature;
		const snapshotEntryId = duplicateOfPrevious ? previous.snapshotEntryId : generateId({ has: id => ids.has(id) });
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
			entries.splice(index, 0, snapshot);
			index++;
			entry.parentId = snapshotEntryId;
		}
		entry.data = {
			goalId: state.goal.id,
			stateVersion: serialized.stateVersion,
			snapshotEntryId,
		};
		previousMigratedMarker = {
			markerId: entry.id,
			serializedStateSignature,
			snapshotEntryId,
		};
		changed = true;
	}
	return changed;
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		if (entry.type === "message") {
			const msg = entry.message as { role?: string };
			if (msg.role === "hookMessage") {
				(entry.message as { role: string }).role = "custom";
			}
		}
	}
}

/** Migrate v3 → v4: register compact goal persistence entry taxonomy. Mutates in place. */
function migrateV3ToV4(entries: FileEntry[]): void {
	compactLegacyGoalPersistence(entries);
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 4;
			return;
		}
	}
}
/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
export function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find(e => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);
	if (version < 4) migrateV3ToV4(entries);

	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}
