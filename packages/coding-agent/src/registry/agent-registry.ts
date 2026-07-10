/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`irc`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
 */

import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";

export const MAIN_AGENT_ID = "Main";

/**
 * - `running`: a model turn is executing.
 * - `waiting`: a live turn is blocked on an external wait or retry.
 * - `paused`: autonomous work stopped by recoverable policy.
 * - `idle`: live AgentSession awaiting deliberate work.
 * - `parked`: session disposed; ref + sessionFile retained, revivable.
 * - `aborted`: hard-killed, terminal, transcript retained.
 */
export type AgentStatus = "running" | "waiting" | "paused" | "idle" | "parked" | "aborted";
export interface AgentStatusDetail {
	code: "no_progress" | "provider_retry" | "external_wait";
	reason: string;
	since: number;
	consecutive?: number;
	limit?: number;
}
/**
 * - `main`/`sub`: the user-facing agent tree (driving agent + task subagents).
 * - `advisor`: a passive review transcript persisted like a subagent for usage
 *   attribution and Agent Hub observability, but never a peer — hidden from
 *   agent-facing rosters (`irc`, `history://`) and not messageable/revivable.
 */
export type AgentKind = "main" | "sub" | "advisor";

export interface AgentRef {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	/** Null exactly when parked/aborted. */
	session: AgentSession | null;
	statusDetail?: AgentStatusDetail;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	/** Short gist of what the agent is currently doing (latest intent or tool), for the work-aware roster. Display-only. */
	activity?: string;
}

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	status?: AgentStatus;
	statusDetail?: AgentStatusDetail;
}

function sameStatusDetail(left: AgentStatusDetail | undefined, right: AgentStatusDetail | undefined): boolean {
	return (
		left === right ||
		(left !== undefined &&
			right !== undefined &&
			left.code === right.code &&
			left.reason === right.reason &&
			left.since === right.since &&
			left.consecutive === right.consecutive &&
			left.limit === right.limit)
	);
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #listeners = new Set<RegistryListener>();

	register(input: RegisterInput): AgentRef {
		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			createdAt: now,
			lastActivity: now,
			statusDetail: input.statusDetail,
		};
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	setStatus(id: string, status: AgentStatus, statusDetail?: AgentStatusDetail): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		if (ref.status === status && sameStatusDetail(ref.statusDetail, statusDetail)) return;
		ref.status = status;
		ref.statusDetail = statusDetail;
		// Waiting may retain the activity it is blocked on. Quiescent and
		// terminal states use statusDetail instead of stale work text.
		if (status !== "running" && status !== "waiting") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
	}

	/**
	 * Record a short activity gist for the work-aware roster. Display-only and
	 * read on demand (`irc list`, peer roster), so it emits no event — keeping
	 * the per-tool-call update rate off the registry listener path (same as
	 * `attachSession`, which also bumps `lastActivity` without emitting). A live
	 * running/waiting agent has current work; every heartbeat refreshes
	 * `lastActivity` even when the gist is unchanged.
	 */
	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		if (ref.status !== "running" && ref.status !== "waiting") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity === gist) return;
		ref.activity = gist;
	}

	attachSession(id: string, session: AgentSession, sessionFile?: string | null): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
	}

	detachSession(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = null;
	}

	unregister(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}

	/**
	 * Returns every live/messageable agent except the caller. Advisor refs are
	 * observability-only transcripts, never peers.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(
			ref =>
				ref.id !== id &&
				ref.kind !== "advisor" &&
				(ref.status === "running" || ref.status === "waiting" || ref.status === "paused" || ref.status === "idle"),
		);
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}
