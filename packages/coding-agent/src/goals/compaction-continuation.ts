import { prompt } from "@oh-my-pi/pi-utils";
import goalCompactionContextTemplate from "../prompts/goals/goal-compaction-context.md" with { type: "text" };
import goalPostCompactionContinuationTemplate from "../prompts/goals/goal-post-compaction-continuation.md" with {
	type: "text",
};
import {
	buildGoalContinuationPacket,
	escapeXmlText,
	type GoalContinuationPacket,
	renderGoalPromptSurface,
} from "./runtime";
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

function buildGoalContinuationPacketForCompaction(state: GoalModeState): GoalContinuationPacket {
	let transition: GoalContinuationPacket["transition"] = "context-compaction";
	let reason =
		"Context compaction must preserve the active goal state without changing checkpoint or target authority.";
	let guidance = "Resume the same open target after compaction.";
	if (state.runMode === "awaiting-checkpoint-resolution") {
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
	} else if (state.runMode === "awaiting-background-lane-intake") {
		transition = "background-lane-blocked";
		reason = "Context compaction occurred while a structured background-lane blocker requires intake.";
		guidance =
			"Use background_lane list/snapshot/message/close for lane intake before ordinary implementation resumes.";
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
	if (!state?.goal) return undefined;
	if (state.goal.status === "complete" || state.goal.status === "dropped") return undefined;
	const continuationPacket = buildGoalContinuationPacketForCompaction(state);
	const serializedState = serializeGoalModeState(state);
	const context = prompt.render(goalCompactionContextTemplate, {
		transition: continuationPacket.transition,
		reason: continuationPacket.reason,
		stateSnapshot: renderGoalPromptSurface(state, state.goal),
		continuationPacket: escapeXmlText(JSON.stringify(continuationPacket, null, 2)),
	});
	return {
		context,
		preserveData: {
			goalMode: serializedState,
			goalContinuationPacket: continuationPacket,
		},
	};
}
