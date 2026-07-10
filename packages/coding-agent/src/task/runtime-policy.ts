import { formatDuration } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type {
	RuntimePolicyPrompt,
	SubagentRuntimePolicy,
	SubagentTerminalStatus,
	SubagentTermination,
	SubagentTerminationCode,
} from "./types";

export interface RuntimePolicyInput {
	requestBudget: number;
	requestBudgetNotice: boolean;
	noProgressCycleLimit: number;
	maxRuntimeMs: number;
	maxRecursionDepth: number;
	taskDepth: number;
	idleTtlMs: number;
	resumable: boolean;
}

export interface ResolveRuntimePolicyInput {
	settings: Settings;
	childDepth: number;
	resumable: boolean;
	maxRuntimeMs?: number;
}

function nonNegativeInteger(value: unknown): number {
	return Math.max(0, Math.trunc(Number(value) || 0));
}

export function createSubagentRuntimePolicy(input: RuntimePolicyInput): SubagentRuntimePolicy {
	const requestBudget = nonNegativeInteger(input.requestBudget);
	const advisoryAfterAssistantTurns = requestBudget > 0 && input.requestBudgetNotice ? requestBudget : null;
	const stallAfterAssistantTurns = nonNegativeInteger(input.noProgressCycleLimit) || null;
	const maxRuntimeMs = nonNegativeInteger(input.maxRuntimeMs) || null;
	const maxRecursionDepth = Math.trunc(Number(input.maxRecursionDepth) || 0);
	const taskDepth = nonNegativeInteger(input.taskDepth);
	const remainingDepth = maxRecursionDepth < 0 ? null : Math.max(0, maxRecursionDepth - taskDepth);
	const parkingTtlMs = nonNegativeInteger(input.idleTtlMs) || null;
	return {
		request: {
			termination: "disabled",
			advisory:
				advisoryAfterAssistantTurns === null
					? { mode: "off", afterAssistantTurns: null }
					: { mode: "advisory", afterAssistantTurns: advisoryAfterAssistantTurns },
		},
		wallClock: { maxRuntimeMs },
		stall:
			stallAfterAssistantTurns === null
				? { action: "off", afterAssistantTurns: null }
				: {
						action: input.resumable ? "pause" : "fail",
						afterAssistantTurns: stallAfterAssistantTurns,
					},
		spawn: { remainingDepth },
		idle: input.resumable ? { resumable: true, parkingTtlMs } : { resumable: false, parkingTtlMs: null },
	};
}

export function resolveSubagentRuntimePolicy(input: ResolveRuntimePolicyInput): SubagentRuntimePolicy {
	const settings = input.settings;
	return createSubagentRuntimePolicy({
		requestBudget: settings.get("task.softRequestBudget") ?? 0,
		requestBudgetNotice: settings.get("task.softRequestBudgetNotice") ?? false,
		noProgressCycleLimit: settings.get("task.noProgressCycleLimit") ?? 10,
		maxRuntimeMs: input.maxRuntimeMs ?? settings.get("task.maxRuntimeMs") ?? 0,
		maxRecursionDepth: settings.get("task.maxRecursionDepth") ?? 2,
		taskDepth: input.childDepth,
		idleTtlMs: settings.get("task.agentIdleTtlMs") ?? 420_000,
		resumable: input.resumable,
	});
}

export function createSubagentTermination(input: {
	id: string;
	status: SubagentTerminalStatus;
	code: SubagentTerminationCode;
	reason: string;
	resumable: boolean;
	policy: SubagentRuntimePolicy;
}): SubagentTermination {
	const reason = input.reason.trim();
	if (!reason) throw new Error(`Subagent ${input.id} termination reason cannot be empty`);
	return {
		status: input.status,
		code: input.code,
		reason,
		resumable: input.resumable,
		historyUri: `history://${input.id}`,
		outputUri: `agent://${input.id}`,
		policy: input.policy,
	};
}

export function formatRuntimePolicyPrompt(policy: SubagentRuntimePolicy): RuntimePolicyPrompt {
	const advisory = policy.request.advisory;
	const request =
		advisory.mode === "advisory"
			? `No hidden request-count cap; request-count termination disabled; one advisory after ${advisory.afterAssistantTurns} completed assistant turns`
			: "No hidden request-count cap; request-count termination disabled; advisory off";
	const maxRuntimeMs = policy.wallClock.maxRuntimeMs;
	const wallClock =
		maxRuntimeMs === null
			? "OMP wall-clock cap disabled; provider, caller-cancellation, and executor failures still apply"
			: `OMP wall-clock cap ${formatDuration(maxRuntimeMs)}; expiry returns runtime_limit; earlier provider, caller-cancellation, and executor failures still apply`;
	const stallTurns = policy.stall.afterAssistantTurns;
	const stall =
		policy.stall.action === "off" || stallTurns === null
			? "off"
			: policy.stall.action === "pause"
				? `pause after ${stallTurns} consecutive completed assistant turns without a successful tool result or terminal yield; a successful tool resets the count, and waiting time does not increment it`
				: `fail with no_progress after ${stallTurns} consecutive completed assistant turns without a successful tool result or terminal yield; a successful tool resets the count, waiting time does not increment it, and this run retains no resumable session`;
	const remainingDepth = policy.spawn.remainingDepth;
	const spawn =
		remainingDepth === null
			? "unlimited"
			: remainingDepth === 0
				? "none"
				: `${remainingDepth} further ${remainingDepth === 1 ? "generation" : "generations"}`;
	const idle = !policy.idle.resumable
		? "non-resumable; no live session retained"
		: policy.idle.parkingTtlMs === null
			? "resumable; keep live indefinitely with no parking TTL"
			: `resumable; park idle or paused sessions after ${formatDuration(policy.idle.parkingTtlMs)}`;
	return { request, wallClock, stall, spawn, idle };
}

export function formatRuntimePolicySummary(policy: SubagentRuntimePolicy): string {
	const advisoryTurns = policy.request.advisory.afterAssistantTurns;
	const advisory = advisoryTurns === null ? "advisory off" : `advisory/${advisoryTurns} turns`;
	const wallClock =
		policy.wallClock.maxRuntimeMs === null ? "OMP cap off" : `OMP cap/${policy.wallClock.maxRuntimeMs}ms`;
	const stallTurns = policy.stall.afterAssistantTurns;
	const stall = stallTurns === null ? "stall off" : `stall ${policy.stall.action}/${stallTurns} turns`;
	const depth =
		policy.spawn.remainingDepth === null ? "spawn depth unlimited" : `spawn depth/${policy.spawn.remainingDepth}`;
	const retention = !policy.idle.resumable
		? "non-resumable"
		: policy.idle.parkingTtlMs === null
			? "resumable/parking off"
			: `resumable/parking ${policy.idle.parkingTtlMs}ms`;
	return `request termination disabled; ${advisory} · ${wallClock} · ${stall} · ${depth} · ${retention}`;
}
