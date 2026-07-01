import { escapeXmlText, prompt } from "@oh-my-pi/pi-utils";
import goalCompactionContextTemplate from "../prompts/goals/goal-compaction-context.md" with { type: "text" };
import goalPostCompactionContinuationTemplate from "../prompts/goals/goal-post-compaction-continuation.md" with {
	type: "text",
};
import { buildGoalBoundaryStateRef } from "./boundary-audit";
import { buildGoalContinuationPacket, type GoalContinuationPacket, renderGoalPromptSurface } from "./runtime";
import type { GoalModeState } from "./state";
import { serializeGoalModeState } from "./state";

export interface GoalPostCompactionContinuation {
	goalId: string;
	stateVersion: number;
	prompt: string;
}

export interface GoalCompactionContext {
	context: string;
	preserveData: Record<string, unknown>;
}

export interface GoalRoutingCapsule {
	schemaVersion: 1;
	goalId: string;
	objective: string;
	stateVersion: number;
	parentFrameVersion: number;
	runMode: GoalModeState["runMode"];
	transition: GoalContinuationPacket["transition"];
	reason: string;
	continuationGuidanceSummary: string;
	nextAction: string;
	currentTarget?: {
		id: string;
		title: string;
		desiredFutureClaim: string;
	};
	currentTargetPlan?: {
		id: string;
		targetId: string;
		revision: number;
		planFilePath: string;
		payloadFilePath?: string;
	};
	pendingCheckpointId?: string;
	workstreamBatch?: {
		id: string;
		status: string;
		workstreamCount: number;
		statusCounts: Record<string, number>;
	};
	blockedState?: {
		reason: string;
	};
	createdAt: number;
}

function countWorkstreamStatuses(state: GoalModeState): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const workstream of state.goal.currentWorkstreamBatch?.workstreams ?? []) {
		counts[workstream.status] = (counts[workstream.status] ?? 0) + 1;
	}
	return counts;
}

function nextActionForCompaction(state: GoalModeState, packet: GoalContinuationPacket): string {
	if (state.runMode === "planning-target") return "Continue target planning; do not implement before approval.";
	if (state.runMode === "awaiting-checkpoint-resolution")
		return "Prepare checkpoint guidance, then resolve_checkpoint.";
	if (state.runMode === "awaiting-parent-completion") return 'Call goal({ op: "complete" }).';
	if (state.runMode === "awaiting-verification-repair") return "Repair verifier blockers with fresh evidence.";
	if (state.runMode === "awaiting-user-input") return "Wait for user or recover blocked state explicitly.";
	if (packet.transition === "context-compaction") return "Resume the same open target.";
	return packet.continuationGuidanceSummary;
}

export function buildGoalRoutingCapsule(
	state: GoalModeState,
	continuationPacket: GoalContinuationPacket,
	createdAt = Date.now(),
): GoalRoutingCapsule {
	const target = state.goal.currentTarget;
	const plan = state.goal.currentTargetPlan;
	const batch = state.goal.currentWorkstreamBatch;
	return {
		schemaVersion: 1,
		goalId: state.goal.id,
		objective: state.goal.objective,
		stateVersion: state.stateVersion,
		parentFrameVersion: state.parentFrameVersion,
		runMode: state.runMode,
		transition: continuationPacket.transition,
		reason: continuationPacket.reason,
		continuationGuidanceSummary: continuationPacket.continuationGuidanceSummary,
		nextAction: nextActionForCompaction(state, continuationPacket),
		...(target
			? {
					currentTarget: {
						id: target.id,
						title: target.title,
						desiredFutureClaim: target.desiredFutureClaim,
					},
				}
			: {}),
		...(plan
			? {
					currentTargetPlan: {
						id: plan.id,
						targetId: plan.targetId,
						revision: plan.revision,
						planFilePath: plan.planFilePath,
						payloadFilePath: continuationPacket.currentTargetPlanPayloadFilePath,
					},
				}
			: {}),
		...(state.goal.pendingCheckpointId ? { pendingCheckpointId: state.goal.pendingCheckpointId } : {}),
		...(batch
			? {
					workstreamBatch: {
						id: batch.id,
						status: batch.status,
						workstreamCount: batch.workstreams.length,
						statusCounts: countWorkstreamStatuses(state),
					},
				}
			: {}),
		...(state.goal.currentBlockedState ? { blockedState: { reason: state.goal.currentBlockedState.message } } : {}),
		createdAt,
	};
}

function buildGoalContinuationPacketForCompaction(state: GoalModeState): GoalContinuationPacket {
	let transition: GoalContinuationPacket["transition"] = "context-compaction";
	let reason =
		"Context compaction must preserve the active goal state without changing checkpoint or target authority.";
	let guidance = "Resume the same open target after compaction.";
	if (state.runMode === "planning-target") {
		reason = "Context compaction occurred while a target plan is being drafted or reviewed.";
		guidance =
			'Resume target planning; recover plan_file_path and payload_file_path with goal({op:"get"}); do not implement or checkpoint until submit_target_plan is approved.';
	} else if (state.runMode === "awaiting-checkpoint-resolution") {
		transition = "target-checkpoint";
		reason = "Context compaction occurred while an accepted target checkpoint is awaiting controller resolution.";
		guidance = "Prepare checkpoint guidance and require resolve_checkpoint before local implementation resumes.";
	} else if (state.runMode === "awaiting-parent-completion") {
		transition = "parent-completion-candidate";
		reason = "Context compaction occurred after checkpoint resolution selected parent completion verification.";
		guidance = 'Call goal({ op: "complete" }) next; do not resume local implementation first.';
	} else if (state.runMode === "awaiting-verification-repair") {
		transition = "verification-rejected";
		reason = "Context compaction occurred while verifier blockers are awaiting repair.";
		guidance = "Repair verifier blockers or gather direct evidence before retrying parent completion.";
	} else if (state.runMode === "awaiting-user-input") {
		guidance = "Preserve the blocked state and wait for user, check, or external-control input.";
	}
	return buildGoalContinuationPacket(state, transition, reason, guidance);
}

function renderGoalPostCompactionPrompt(state: GoalModeState, continuationPacket: GoalContinuationPacket): string {
	return prompt.render(goalPostCompactionContinuationTemplate, {
		runMode: state.runMode,
		objective: escapeXmlText(state.goal.objective),
		goalContextSurface: renderGoalPromptSurface(state, state.goal),
		continuationPacket: escapeXmlText(JSON.stringify(continuationPacket, null, 2)),
	});
}

export function buildGoalPostCompactionContinuation(
	state: GoalModeState | undefined,
): GoalPostCompactionContinuation | undefined {
	if (!state?.enabled || state.goal.status !== "active" || state.runMode === "awaiting-user-input") {
		return undefined;
	}
	const continuationPacket = buildGoalContinuationPacketForCompaction(state);
	return {
		goalId: state.goal.id,
		stateVersion: state.stateVersion,
		prompt: renderGoalPostCompactionPrompt(state, continuationPacket),
	};
}

export function consumeGoalPostCompactionContinuation(
	continuation: GoalPostCompactionContinuation | undefined,
	state: GoalModeState,
): string | undefined {
	if (!continuation) return undefined;
	if (continuation.goalId !== state.goal.id || continuation.stateVersion !== state.stateVersion) return undefined;
	return continuation.prompt;
}

export function buildGoalCompactionContext(state: GoalModeState | undefined): GoalCompactionContext | undefined {
	if (!state?.enabled || !state.goal) return undefined;
	if (state.goal.status === "complete" || state.goal.status === "dropped") return undefined;
	const continuationPacket = buildGoalContinuationPacketForCompaction(state);
	const serializedState = serializeGoalModeState(state);
	const routingCapsule = buildGoalRoutingCapsule(state, continuationPacket);
	const context = prompt.render(goalCompactionContextTemplate, {
		transition: continuationPacket.transition,
		reason: continuationPacket.reason,
		routingCapsule: escapeXmlText(JSON.stringify(routingCapsule, null, 2)),
	});
	return {
		context,
		preserveData: {
			goalMode: serializedState,
			goalRoutingCapsule: routingCapsule,
			goalBoundaryRef: buildGoalBoundaryStateRef(state, "compaction"),
		},
	};
}
