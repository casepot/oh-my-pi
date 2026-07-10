import type { AgentSession } from "../session/agent-session";
import type { SessionEntry } from "../session/session-entries";
import type { AgentLifecycleManager, AgentReviver } from "./agent-lifecycle";
import { type AgentRegistry, type AgentStatus, type AgentStatusDetail, MAIN_AGENT_ID } from "./agent-registry";

export const AGENT_REF_CUSTOM_TYPE = "agent-ref";
export const AGENT_REF_SCHEMA_VERSION = 1;

export interface PersistedAgentRefRecord {
	schemaVersion: 1;
	id: string;
	displayName: string;
	kind: "sub";
	parentId?: string;
	status: AgentStatus;
	statusDetail?: AgentStatusDetail;
	sessionFile: string | null;
	agentName?: string;
	role?: string;
	cwd?: string;
	spawns?: string | null;
	taskDepth?: number;
	resumable?: boolean;
	updatedAt: number;
}

export interface RestorePersistedAgentRefsInput {
	entries: readonly SessionEntry[];
	registry: AgentRegistry;
	lifecycle: AgentLifecycleManager;
	idleTtlMs: number;
	makeReviver?: (record: PersistedAgentRefRecord) => AgentReviver | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}
function parseStatusDetail(value: unknown): AgentStatusDetail | undefined {
	if (!isRecord(value)) return undefined;
	const { code, reason, since, consecutive, limit } = value;
	if (code !== "no_progress" && code !== "provider_retry" && code !== "external_wait") return undefined;
	if (typeof reason !== "string" || reason.length === 0) return undefined;
	if (typeof since !== "number" || !Number.isFinite(since)) return undefined;
	if (consecutive !== undefined && (typeof consecutive !== "number" || !Number.isFinite(consecutive)))
		return undefined;
	if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) return undefined;
	return { code, reason, since, consecutive, limit };
}

function parsePersistedAgentRef(entry: SessionEntry): PersistedAgentRefRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== AGENT_REF_CUSTOM_TYPE || !isRecord(entry.data)) return undefined;
	const data = entry.data;
	if (data.schemaVersion !== AGENT_REF_SCHEMA_VERSION) return undefined;
	const rawId = data.id;
	if (typeof rawId !== "string" || rawId.length === 0 || rawId === MAIN_AGENT_ID) return undefined;
	if (data.kind !== "sub") return undefined;
	const rawDisplayName = data.displayName;
	const rawAgentName = data.agentName;
	const displayName =
		typeof rawDisplayName === "string" && rawDisplayName.length > 0
			? rawDisplayName
			: typeof rawAgentName === "string" && rawAgentName.length > 0
				? rawAgentName
				: "sub";
	const timestamp = Date.parse(entry.timestamp);
	const rawSessionFile = data.sessionFile;
	const rawSpawns = data.spawns;
	const rawStatus = data.status;
	const status =
		rawStatus === "running" ||
		rawStatus === "waiting" ||
		rawStatus === "paused" ||
		rawStatus === "idle" ||
		rawStatus === "parked" ||
		rawStatus === "aborted"
			? rawStatus
			: "parked";
	const rawUpdatedAt = data.updatedAt;
	const updatedAt =
		typeof rawUpdatedAt === "number" && Number.isFinite(rawUpdatedAt)
			? rawUpdatedAt
			: Number.isFinite(timestamp)
				? timestamp
				: 0;
	return {
		schemaVersion: AGENT_REF_SCHEMA_VERSION,
		id: rawId,
		displayName,
		kind: "sub",
		parentId: typeof data.parentId === "string" && data.parentId.length > 0 ? data.parentId : undefined,
		status,
		statusDetail: parseStatusDetail(data.statusDetail),
		sessionFile: typeof rawSessionFile === "string" && rawSessionFile.length > 0 ? rawSessionFile : null,
		agentName: typeof rawAgentName === "string" && rawAgentName.length > 0 ? rawAgentName : undefined,
		role: typeof data.role === "string" && data.role.length > 0 ? data.role : undefined,
		cwd: typeof data.cwd === "string" && data.cwd.length > 0 ? data.cwd : undefined,
		spawns: rawSpawns === null ? null : typeof rawSpawns === "string" && rawSpawns.length > 0 ? rawSpawns : undefined,
		taskDepth: typeof data.taskDepth === "number" && Number.isFinite(data.taskDepth) ? data.taskDepth : undefined,
		resumable: typeof data.resumable === "boolean" ? data.resumable : undefined,
		updatedAt,
	};
}

export function collectLatestPersistedAgentRefs(entries: readonly SessionEntry[]): PersistedAgentRefRecord[] {
	const latest: Record<string, PersistedAgentRefRecord> = {};
	for (const entry of entries) {
		const record = parsePersistedAgentRef(entry);
		if (!record) continue;
		latest[record.id] = record;
	}
	return Object.values(latest);
}

export function restorePersistedAgentRefs(input: RestorePersistedAgentRefsInput): number {
	let restored = 0;
	for (const record of collectLatestPersistedAgentRefs(input.entries)) {
		if (input.registry.get(record.id)) continue;
		const status = record.status === "aborted" ? "aborted" : "parked";
		input.registry.register({
			id: record.id,
			displayName: record.displayName,
			kind: "sub",
			parentId: record.parentId,
			session: null,
			sessionFile: record.sessionFile,
			status,
			statusDetail: status === record.status ? record.statusDetail : undefined,
		});
		if (status !== "aborted") {
			input.lifecycle.adopt(record.id, {
				idleTtlMs: input.idleTtlMs,
				revive: record.resumable === false ? undefined : input.makeReviver?.(record),
			});
		}
		restored++;
	}
	return restored;
}

export function installRegistryStatusSync(agentId: string, session: AgentSession, registry: AgentRegistry): () => void {
	return session.subscribe(event => {
		if (event.type === "agent_start") {
			registry.setStatus(agentId, "running");
		} else if (event.type === "agent_end") {
			const status = registry.get(agentId)?.status;
			if (status === "running" || status === "waiting") registry.setStatus(agentId, "idle");
		}
	});
}
