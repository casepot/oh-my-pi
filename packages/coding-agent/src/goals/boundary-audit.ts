import type { GoalModeState, GoalRunMode } from "./state";

export const GOAL_BOUNDARY_AUDIT_CUSTOM_TYPE = "goal_boundary_audit";

export const GOAL_OWNED_COMPACTION_PRESERVE_KEYS = [
	"goalMode",
	"goalStateRef",
	"goalContinuationPacket",
	"goalRoutingCapsule",
	"goalBoundaryRef",
] as const;

export type GoalBoundaryPurpose = "compaction" | "handoff" | "checkpoint" | "target-plan" | "error" | "approved-plan";

export type GoalBoundaryKind =
	| "compaction"
	| "checkpoint"
	| "target-plan-approval"
	| "target-plan-reference"
	| "goal-error";

export type GoalBoundaryAuditAction = "accepted" | "regenerated" | "stripped" | "skipped" | "aborted";

export interface GoalBoundaryStateRef {
	schemaVersion: 1;
	purpose: GoalBoundaryPurpose;
	goalId: string;
	stateVersion: number;
	runMode: GoalRunMode;
	parentFrameVersion: number;
	currentTargetId?: string;
	currentTargetPlanId?: string;
	targetPlanRevision?: number;
	pendingCheckpointId?: string;
	capturedAt: number;
}

export interface GoalBoundaryCarrierAudit {
	name: string;
	stateVersion?: number;
	runMode?: GoalRunMode;
	currentTargetId?: string;
	currentTargetPlanId?: string;
	targetPlanRevision?: number;
	bytes?: number;
}

export interface GoalBoundaryAuditRecord {
	schemaVersion: 1;
	kind: GoalBoundaryKind;
	boundaryId: string;
	before?: GoalBoundaryStateRef;
	after?: GoalBoundaryStateRef;
	carriers: GoalBoundaryCarrierAudit[];
	preservedFields: string[];
	staleFields: string[];
	omittedFields: string[];
	recoveryInstruction?: string;
	action: GoalBoundaryAuditAction;
	recordedAt: number;
}

const goalOwnedPreserveKeys: Record<string, true> = {
	goalMode: true,
	goalStateRef: true,
	goalRoutingCapsule: true,
	goalContinuationPacket: true,
	goalBoundaryRef: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRunMode(record: Record<string, unknown> | undefined, key: string): GoalRunMode | undefined {
	const value = record?.[key];
	return typeof value === "string" ? (value as GoalRunMode) : undefined;
}

function nestedRecord(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
	const value = record?.[key];
	return isRecord(value) ? value : undefined;
}

export function buildGoalBoundaryStateRef(
	state: GoalModeState | undefined,
	purpose: GoalBoundaryPurpose,
	capturedAt = Date.now(),
): GoalBoundaryStateRef | undefined {
	if (!state?.enabled) return undefined;
	const goal = state.goal;
	const plan = goal.currentTargetPlan;
	return {
		schemaVersion: 1,
		purpose,
		goalId: goal.id,
		stateVersion: state.stateVersion,
		runMode: state.runMode,
		parentFrameVersion: state.parentFrameVersion,
		...(goal.currentTarget?.id ? { currentTargetId: goal.currentTarget.id } : {}),
		...(plan?.id ? { currentTargetPlanId: plan.id } : {}),
		...(plan?.revision !== undefined ? { targetPlanRevision: plan.revision } : {}),
		...(goal.pendingCheckpointId ? { pendingCheckpointId: goal.pendingCheckpointId } : {}),
		capturedAt,
	};
}

export function stripGoalOwnedCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!preserveData) return undefined;
	const stripped: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(preserveData)) {
		if (!goalOwnedPreserveKeys[key]) stripped[key] = value;
	}
	return Object.keys(stripped).length > 0 ? stripped : undefined;
}

export function mergeGoalCompactionPreserveData(
	compactorPreserveData: Record<string, unknown> | undefined,
	currentGoalPreserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const strippedCompactorPreserveData = stripGoalOwnedCompactionPreserveData(compactorPreserveData);
	const merged = { ...(strippedCompactorPreserveData ?? {}), ...(currentGoalPreserveData ?? {}) };
	return Object.keys(merged).length > 0 ? merged : undefined;
}

export function collectGoalCompactionPreserveMismatches(
	preserveData: Record<string, unknown> | undefined,
	state: GoalModeState | undefined,
): string[] {
	const mismatches: string[] = [];
	const goalMode = isRecord(preserveData?.goalMode) ? preserveData.goalMode : undefined;
	const goalStateRef = isRecord(preserveData?.goalStateRef) ? preserveData.goalStateRef : undefined;
	const routingCapsule = isRecord(preserveData?.goalRoutingCapsule) ? preserveData.goalRoutingCapsule : undefined;
	const boundaryRef = isRecord(preserveData?.goalBoundaryRef) ? preserveData.goalBoundaryRef : undefined;
	const activeState =
		state?.enabled && state.goal.status !== "complete" && state.goal.status !== "dropped" ? state : undefined;

	if (!activeState) {
		for (const key of GOAL_OWNED_COMPACTION_PRESERVE_KEYS) {
			if (preserveData && key in preserveData) mismatches.push(`${key}:present-without-active-goal`);
		}
		return mismatches;
	}

	if (!goalMode && !goalStateRef) mismatches.push("goalStateRef:missing");
	if (!boundaryRef) mismatches.push("goalBoundaryRef:missing");
	if (!routingCapsule) mismatches.push("goalRoutingCapsule:missing");

	const plan = activeState.goal.currentTargetPlan;
	if (goalStateRef) {
		compareNumber(
			mismatches,
			"goalStateRef.stateVersion",
			readNumber(goalStateRef, "stateVersion"),
			activeState.stateVersion,
		);
		compareString(mismatches, "goalStateRef.goalId", readString(goalStateRef, "goalId"), activeState.goal.id);
	}
	if (routingCapsule) {
		compareNumber(
			mismatches,
			"goalRoutingCapsule.stateVersion",
			readNumber(routingCapsule, "stateVersion"),
			activeState.stateVersion,
		);
		compareRunMode(
			mismatches,
			"goalRoutingCapsule.runMode",
			readRunMode(routingCapsule, "runMode"),
			activeState.runMode,
		);
		compareString(mismatches, "goalRoutingCapsule.goalId", readString(routingCapsule, "goalId"), activeState.goal.id);
		compareNumber(
			mismatches,
			"goalRoutingCapsule.parentFrameVersion",
			readNumber(routingCapsule, "parentFrameVersion"),
			activeState.parentFrameVersion,
		);
	}

	if (goalMode) {
		const serializedGoal = nestedRecord(goalMode, "goal");
		const serializedTarget = nestedRecord(serializedGoal, "currentTarget");
		const serializedPlan = nestedRecord(serializedGoal, "currentTargetPlan");

		compareNumber(
			mismatches,
			"goalMode.stateVersion",
			readNumber(goalMode, "stateVersion"),
			activeState.stateVersion,
		);
		compareRunMode(mismatches, "goalMode.runMode", readRunMode(goalMode, "runMode"), activeState.runMode);
		compareNumber(
			mismatches,
			"goalMode.parentFrameVersion",
			readNumber(goalMode, "parentFrameVersion"),
			activeState.parentFrameVersion,
		);
		compareString(mismatches, "goalMode.goal.id", readString(serializedGoal, "id"), activeState.goal.id);
		compareString(
			mismatches,
			"goalMode.goal.currentTarget.id",
			readString(serializedTarget, "id"),
			activeState.goal.currentTarget?.id,
		);
		compareString(mismatches, "goalMode.goal.currentTargetPlan.id", readString(serializedPlan, "id"), plan?.id);
		compareNumber(
			mismatches,
			"goalMode.goal.currentTargetPlan.revision",
			readNumber(serializedPlan, "revision"),
			plan?.revision,
		);
	}

	compareNumber(
		mismatches,
		"goalBoundaryRef.stateVersion",
		readNumber(boundaryRef, "stateVersion"),
		activeState.stateVersion,
	);
	compareRunMode(mismatches, "goalBoundaryRef.runMode", readRunMode(boundaryRef, "runMode"), activeState.runMode);
	compareString(mismatches, "goalBoundaryRef.goalId", readString(boundaryRef, "goalId"), activeState.goal.id);
	compareNumber(
		mismatches,
		"goalBoundaryRef.parentFrameVersion",
		readNumber(boundaryRef, "parentFrameVersion"),
		activeState.parentFrameVersion,
	);
	compareString(
		mismatches,
		"goalBoundaryRef.currentTargetId",
		readString(boundaryRef, "currentTargetId"),
		activeState.goal.currentTarget?.id,
	);
	compareString(
		mismatches,
		"goalBoundaryRef.currentTargetPlanId",
		readString(boundaryRef, "currentTargetPlanId"),
		plan?.id,
	);
	compareNumber(
		mismatches,
		"goalBoundaryRef.targetPlanRevision",
		readNumber(boundaryRef, "targetPlanRevision"),
		plan?.revision,
	);
	compareString(
		mismatches,
		"goalBoundaryRef.pendingCheckpointId",
		readString(boundaryRef, "pendingCheckpointId"),
		activeState.goal.pendingCheckpointId,
	);

	return mismatches;
}

export function goalCompactionOmittedFields(
	preserveData: Record<string, unknown> | undefined,
	state: GoalModeState | undefined,
): string[] {
	if (!state?.enabled || state.goal.status === "complete" || state.goal.status === "dropped") return [];
	const omitted: string[] = [];
	if (!preserveData || (!("goalMode" in preserveData) && !("goalStateRef" in preserveData)))
		omitted.push("goalStateRef");
	if (!preserveData || !("goalRoutingCapsule" in preserveData)) omitted.push("goalRoutingCapsule");
	if (!preserveData || !("goalBoundaryRef" in preserveData)) omitted.push("goalBoundaryRef");
	return omitted;
}

export function goalCompactionPreservedFields(preserveData: Record<string, unknown> | undefined): string[] {
	return preserveData ? Object.keys(preserveData).sort() : [];
}

export function buildGoalBoundaryCarrierAudit(name: string, value: unknown, bytes?: number): GoalBoundaryCarrierAudit {
	const record = isRecord(value) ? value : undefined;
	const carrier: GoalBoundaryCarrierAudit = { name };
	const stateVersion = readNumber(record, "stateVersion");
	if (stateVersion !== undefined) carrier.stateVersion = stateVersion;
	const runMode = readRunMode(record, "runMode");
	if (runMode !== undefined) carrier.runMode = runMode;
	const currentTargetId = readString(record, "currentTargetId");
	if (currentTargetId) carrier.currentTargetId = currentTargetId;
	const currentTargetPlanId = readString(record, "currentTargetPlanId");
	if (currentTargetPlanId) carrier.currentTargetPlanId = currentTargetPlanId;
	const targetPlanRevision = readNumber(record, "targetPlanRevision");
	if (targetPlanRevision !== undefined) carrier.targetPlanRevision = targetPlanRevision;
	if (bytes !== undefined) carrier.bytes = bytes;
	return carrier;
}

function compareString(
	mismatches: string[],
	label: string,
	actual: string | undefined,
	expected: string | undefined,
): void {
	if (actual !== expected) mismatches.push(`${label}:${actual ?? "missing"}->${expected ?? "missing"}`);
}

function compareNumber(
	mismatches: string[],
	label: string,
	actual: number | undefined,
	expected: number | undefined,
): void {
	if (actual !== expected) mismatches.push(`${label}:${actual ?? "missing"}->${expected ?? "missing"}`);
}

function compareRunMode(
	mismatches: string[],
	label: string,
	actual: GoalRunMode | undefined,
	expected: GoalRunMode | undefined,
): void {
	if (actual !== expected) mismatches.push(`${label}:${actual ?? "missing"}->${expected ?? "missing"}`);
}
