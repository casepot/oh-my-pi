import { Box, replaceTabs, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { goalRunModePolicy } from "../../goals/runtime";
import type { GoalModeState } from "../../goals/state";
import { implementationFanoutRequired, matrixRowCounts } from "../../goals/tool-details";
import { theme } from "../../modes/theme/theme";

const PANEL_WIDTH = 120;
const ACTION_LIMIT = 3;

export interface GoalTargetPanelDetails {
	runMode: GoalModeState["runMode"];
	stateVersion: number;
	parentFrameVersion: number;
	targetTitle?: string;
	targetId?: string;
	targetStatus?: string;
	targetPlanId?: string;
	targetPlanRevision?: number;
	targetPlanStatus?: string;
	planFilePath?: string;
	planDepth?: string;
	primarySignalGroupId?: string;
	matrixRowCounts?: { inScope: number; leftOpen: number };
	implementationFanoutRequired?: boolean;
	pendingCheckpointId?: string;
	allowedNextActs: string[];
}

function compactLine(value: string | undefined): string {
	return truncateToWidth(replaceTabs((value ?? "").replace(/\s+/g, " ").trim()), PANEL_WIDTH);
}

export function buildGoalTargetPanelDetails(state: GoalModeState | undefined): GoalTargetPanelDetails | undefined {
	if (!state?.enabled || state.goal.status !== "active") return undefined;
	const target = state.goal.currentTarget;
	const plan = state.goal.currentTargetPlan;
	const policy = goalRunModePolicy(state.runMode);
	return {
		runMode: state.runMode,
		stateVersion: state.stateVersion,
		parentFrameVersion: state.parentFrameVersion,
		targetTitle: target?.title,
		targetId: target?.id,
		targetStatus: target?.status,
		targetPlanId: plan?.id,
		targetPlanRevision: plan?.revision,
		targetPlanStatus: plan?.status,
		planFilePath: plan?.planFilePath,
		planDepth: plan?.planDepth,
		primarySignalGroupId: plan?.primarySignalGroupId ?? plan?.verificationAperture?.primarySignalId,
		matrixRowCounts: matrixRowCounts(plan),
		implementationFanoutRequired: implementationFanoutRequired(plan),
		pendingCheckpointId: state.goal.pendingCheckpointId,
		allowedNextActs: policy.allowedNextActs.slice(0, ACTION_LIMIT),
	};
}

export class GoalTargetPanelComponent extends Box {
	#details: GoalTargetPanelDetails | undefined;

	constructor() {
		super(1, 0);
	}

	setDetails(details: GoalTargetPanelDetails | undefined): void {
		this.#details = details;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		this.clear();
		const details = this.#details;
		if (!details) return;
		const target = details.targetTitle
			? `${compactLine(details.targetTitle)}${details.targetStatus ? ` (${details.targetStatus})` : ""}`
			: "(no active target)";
		const plan = details.targetPlanId
			? `plan ${details.targetPlanStatus ?? "unknown"}${
					details.targetPlanRevision === undefined ? "" : ` r${details.targetPlanRevision}`
				} · ${details.targetPlanId}`
			: "plan (none)";
		const metadata: string[] = [];
		if (details.planDepth) metadata.push(`depth ${details.planDepth}`);
		if (details.primarySignalGroupId) metadata.push(`signal ${details.primarySignalGroupId}`);
		if (details.matrixRowCounts)
			metadata.push(`matrix ${details.matrixRowCounts.inScope}/${details.matrixRowCounts.leftOpen}`);
		if (details.implementationFanoutRequired === true) metadata.push("fanout recommended");
		if (details.pendingCheckpointId) metadata.push(`checkpoint ${details.pendingCheckpointId}`);
		metadata.push(`state ${details.stateVersion}/${details.parentFrameVersion}`);
		const rows = [
			theme.fg("accent", theme.bold(`Goal target · ${details.runMode} · ${target}`)),
			theme.fg("muted", compactLine(`${plan} · ${metadata.join(" · ")}`)),
		];
		const actionFlow = compactActionFlow(details.allowedNextActs);
		if (actionFlow) rows.push(theme.fg("dim", `next: ${actionFlow}`));
		this.addChild(new Text(rows.join("\n"), 0, 0));
	}
}

function compactActionFlow(actions: readonly string[]): string | undefined {
	if (actions.length === 0) return undefined;
	return compactLine(
		actions
			.slice(0, ACTION_LIMIT)
			.map(action => {
				if (action.includes('op:"lint_target_plan"')) return "lint_target_plan";
				if (action.includes('op:"submit_target_plan"') && action.includes('op:"fail_target_plan"')) {
					return "submit_target_plan/fail_target_plan";
				}
				if (action === "Draft/revise the current target plan") return "edit target plan";
				return action;
			})
			.join(" → "),
	);
}
