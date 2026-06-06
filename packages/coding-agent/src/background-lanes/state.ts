export type BackgroundLaneAgentStatus = "starting" | "running" | "idle" | "stopped" | "failed";
export type BackgroundLaneStatus = "open" | "blocked" | "closed" | "spawn_failed";
export type BackgroundLaneCloseOutcome = "merged" | "dropped" | "stale" | "superseded" | "no_release" | "deferred";
export type BackgroundLaneSpawnFailureStage = "worktree" | "session" | "assignment";

export interface BackgroundLaneOrigin {
	checkpointId?: string;
	sourceRef: string;
	/** Materialized immutable commit object used as the lane base. */
	sourceCommit: string;
}

export interface BackgroundLaneBranchHandle {
	name?: string;
	worktreePath?: string;
}

export interface BackgroundLaneAgentHandle {
	sessionRef?: string;
	sessionFile?: string;
	status: BackgroundLaneAgentStatus;
	lastOperationId?: string;
}

export interface BackgroundLaneContract {
	question: string;
	blocksIf: string;
	requiredBeforeParent: boolean;
}

export interface BackgroundLaneSpawnFailure {
	stage: BackgroundLaneSpawnFailureStage;
	message: string;
	retryable: true;
	failedAt: number;
}

export interface BackgroundLaneReport {
	id: string;
	laneId: string;
	summary: string;
	blocksIfFired: boolean;
	changedFiles: string[];
	evidenceRefs: string[];
	nonClaims: string[];
	staleIf: string[];
	artifactRef?: string;
	sessionMessageRef?: string;
	createdAt: number;
}

export interface BackgroundLanePatchSnapshot {
	laneId: string;
	headSourceRef: string | null;
	changedFiles: string[];
	patchRef?: string;
	capturedAt: number;
}

export interface BackgroundLaneCloseDisposition {
	outcome: BackgroundLaneCloseOutcome;
	reason: string;
	mergedSourceRef?: string;
	operatorStatement?: string;
	closedAt: number;
}

export interface BackgroundLane {
	id: string;
	goalId?: string;
	origin: BackgroundLaneOrigin;
	branch: BackgroundLaneBranchHandle;
	agent: BackgroundLaneAgentHandle;
	contract: BackgroundLaneContract;
	assignment: string;
	assignmentRef?: string;
	status: BackgroundLaneStatus;
	outcome?: BackgroundLaneCloseOutcome | null;
	closeDisposition?: BackgroundLaneCloseDisposition;
	latestReportRef?: string;
	latestPatchRef?: string;
	latestSnapshot?: BackgroundLanePatchSnapshot;
	blocksIfFired: boolean;
	changedFiles: string[];
	evidenceRefs: string[];
	nonClaims: string[];
	staleIf: string[];
	reports: BackgroundLaneReport[];
	spawnFailure?: BackgroundLaneSpawnFailure;
	retryable?: true;
	createdAt: number;
	updatedAt: number;
}

export interface BackgroundLaneSpawnRequest {
	from: {
		checkpointId?: string;
		sourceRef: string;
	};
	contract: BackgroundLaneContract;
	assignment: string;
	agent?: string;
}

export interface BackgroundLaneListItem {
	id: string;
	question: string;
	agentStatus: BackgroundLaneAgentStatus;
	status: BackgroundLaneStatus;
	outcome: BackgroundLaneCloseOutcome | null;
	requiredBeforeParent: boolean;
	blocksIfFired: boolean;
	branch?: string;
}

export function cloneBackgroundLaneReport(report: BackgroundLaneReport): BackgroundLaneReport {
	return {
		...report,
		changedFiles: [...report.changedFiles],
		evidenceRefs: [...report.evidenceRefs],
		nonClaims: [...report.nonClaims],
		staleIf: [...report.staleIf],
	};
}

export function cloneBackgroundLane(lane: BackgroundLane): BackgroundLane {
	return {
		...lane,
		origin: { ...lane.origin },
		branch: { ...lane.branch },
		agent: { ...lane.agent },
		contract: { ...lane.contract },
		closeDisposition: lane.closeDisposition ? { ...lane.closeDisposition } : undefined,
		latestSnapshot: lane.latestSnapshot
			? {
					...lane.latestSnapshot,
					changedFiles: [...lane.latestSnapshot.changedFiles],
				}
			: undefined,
		changedFiles: [...lane.changedFiles],
		evidenceRefs: [...lane.evidenceRefs],
		nonClaims: [...lane.nonClaims],
		staleIf: [...lane.staleIf],
		reports: lane.reports.map(cloneBackgroundLaneReport),
		spawnFailure: lane.spawnFailure ? { ...lane.spawnFailure } : undefined,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeAgentStatus(value: unknown): BackgroundLaneAgentStatus {
	switch (value) {
		case "starting":
		case "running":
		case "idle":
		case "stopped":
		case "failed":
			return value;
		default:
			return "stopped";
	}
}

export function normalizeBackgroundLaneStatus(value: unknown): BackgroundLaneStatus {
	switch (value) {
		case "open":
		case "blocked":
		case "closed":
		case "spawn_failed":
			return value;
		default:
			return "open";
	}
}

function normalizeCloseOutcome(value: unknown): BackgroundLaneCloseOutcome | undefined {
	switch (value) {
		case "merged":
		case "dropped":
		case "stale":
		case "superseded":
		case "no_release":
		case "deferred":
			return value;
		default:
			return undefined;
	}
}

function normalizeFailureStage(value: unknown): BackgroundLaneSpawnFailureStage {
	switch (value) {
		case "worktree":
		case "session":
		case "assignment":
			return value;
		default:
			return "session";
	}
}

function normalizeReport(value: unknown): BackgroundLaneReport | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || typeof value.laneId !== "string" || typeof value.summary !== "string") {
		return undefined;
	}
	return {
		id: value.id,
		laneId: value.laneId,
		summary: value.summary,
		blocksIfFired: value.blocksIfFired === true,
		changedFiles: stringArray(value.changedFiles),
		evidenceRefs: stringArray(value.evidenceRefs),
		nonClaims: stringArray(value.nonClaims),
		staleIf: stringArray(value.staleIf),
		artifactRef: optionalString(value.artifactRef),
		sessionMessageRef: optionalString(value.sessionMessageRef),
		createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
	};
}

function normalizeSnapshot(value: unknown): BackgroundLanePatchSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.laneId !== "string") return undefined;
	return {
		laneId: value.laneId,
		headSourceRef: typeof value.headSourceRef === "string" ? value.headSourceRef : null,
		changedFiles: stringArray(value.changedFiles),
		patchRef: optionalString(value.patchRef),
		capturedAt: typeof value.capturedAt === "number" ? value.capturedAt : 0,
	};
}

export function normalizeBackgroundLane(value: unknown): BackgroundLane | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || !isRecord(value.origin) || !isRecord(value.contract)) return undefined;
	const sourceRef = optionalString(value.origin.sourceRef);
	const sourceCommit = optionalString(value.origin.sourceCommit);
	const question = optionalString(value.contract.question);
	const blocksIf = optionalString(value.contract.blocksIf);
	if (!sourceRef || !sourceCommit || !question || !blocksIf) return undefined;
	const reports = Array.isArray(value.reports)
		? value.reports.flatMap(report => {
				const normalized = normalizeReport(report);
				return normalized ? [normalized] : [];
			})
		: [];
	const outcome = normalizeCloseOutcome(value.outcome);
	const closeDisposition = isRecord(value.closeDisposition)
		? {
				outcome: normalizeCloseOutcome(value.closeDisposition.outcome) ?? outcome ?? "dropped",
				reason: optionalString(value.closeDisposition.reason) ?? "restored without close reason",
				mergedSourceRef: optionalString(value.closeDisposition.mergedSourceRef),
				operatorStatement: optionalString(value.closeDisposition.operatorStatement),
				closedAt: typeof value.closeDisposition.closedAt === "number" ? value.closeDisposition.closedAt : 0,
			}
		: undefined;
	const spawnFailure = isRecord(value.spawnFailure)
		? {
				stage: normalizeFailureStage(value.spawnFailure.stage),
				message: optionalString(value.spawnFailure.message) ?? "spawn failed",
				retryable: true as const,
				failedAt: typeof value.spawnFailure.failedAt === "number" ? value.spawnFailure.failedAt : 0,
			}
		: undefined;
	return {
		id: value.id,
		goalId: optionalString(value.goalId),
		origin: {
			checkpointId: optionalString(value.origin.checkpointId),
			sourceRef,
			sourceCommit,
		},
		branch: isRecord(value.branch)
			? {
					name: optionalString(value.branch.name),
					worktreePath: optionalString(value.branch.worktreePath),
				}
			: {},
		agent: isRecord(value.agent)
			? {
					sessionRef: optionalString(value.agent.sessionRef),
					sessionFile: optionalString(value.agent.sessionFile),
					status: normalizeAgentStatus(value.agent.status),
					lastOperationId: optionalString(value.agent.lastOperationId),
				}
			: { status: "stopped" },
		contract: {
			question,
			blocksIf,
			requiredBeforeParent: value.contract.requiredBeforeParent === true,
		},
		assignment: optionalString(value.assignment) ?? "",
		assignmentRef: optionalString(value.assignmentRef),
		status: normalizeBackgroundLaneStatus(value.status),
		outcome: outcome ?? null,
		closeDisposition,
		latestReportRef: optionalString(value.latestReportRef),
		latestPatchRef: optionalString(value.latestPatchRef),
		latestSnapshot: normalizeSnapshot(value.latestSnapshot),
		blocksIfFired: value.blocksIfFired === true,
		changedFiles: stringArray(value.changedFiles),
		evidenceRefs: stringArray(value.evidenceRefs),
		nonClaims: stringArray(value.nonClaims),
		staleIf: stringArray(value.staleIf),
		reports,
		spawnFailure,
		retryable: value.retryable === true || spawnFailure ? true : undefined,
		createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
	};
}

export function normalizeBackgroundLanes(value: unknown): BackgroundLane[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap(item => {
		const lane = normalizeBackgroundLane(item);
		return lane ? [lane] : [];
	});
}

export function requiredBlockingBackgroundLanes(lanes: readonly BackgroundLane[] | undefined): BackgroundLane[] {
	return (lanes ?? []).filter(lane => lane.contract.requiredBeforeParent && lane.status !== "closed");
}

export function structuredBlockingBackgroundLanes(lanes: readonly BackgroundLane[] | undefined): BackgroundLane[] {
	return (lanes ?? []).filter(lane => lane.status === "blocked");
}

export function backgroundLaneListItem(lane: BackgroundLane): BackgroundLaneListItem {
	return {
		id: lane.id,
		question: lane.contract.question,
		agentStatus: lane.agent.status,
		status: lane.status,
		outcome: lane.outcome ?? null,
		requiredBeforeParent: lane.contract.requiredBeforeParent,
		blocksIfFired: lane.blocksIfFired,
		branch: lane.branch.name,
	};
}
