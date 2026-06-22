import { beforeAll, describe, expect, it } from "bun:test";
import { GoalTargetPlanMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/goal-target-plan-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CustomMessage, GoalTargetPlanMessageDetails } from "@oh-my-pi/pi-coding-agent/session/messages";

beforeAll(async () => {
	await initTheme(false);
});

function message(details: GoalTargetPlanMessageDetails): CustomMessage<GoalTargetPlanMessageDetails> {
	return {
		role: "custom",
		customType: "goal-target-plan",
		content: "Goal target plan approved.",
		display: true,
		attribution: "agent",
		timestamp: Date.now(),
		details,
	};
}

describe("GoalTargetPlanMessageComponent", () => {
	it("does not synthesize target-card content for legacy plan summaries", () => {
		const component = new GoalTargetPlanMessageComponent(
			message({
				goalId: "goal-1",
				targetId: "target-1",
				targetPlanId: "target-plan-1",
				planFilePath: "local://goal-goal-1-target-1-plan.md",
				status: "approved",
				revision: 1,
				planDepth: "light",
				primarySignalGroupId: "signal-primary",
				matrixRowCounts: { inScope: 1, leftOpen: 1 },
				implementationFanoutRequired: false,
				recordedAt: 1,
				reviews: [],
			}),
		);

		const collapsed = Bun.stripANSI(component.render(100).join("\n"));
		expect(collapsed).toContain("Target plan approved r1 · target-plan-1");
		expect(collapsed).not.toContain("approved target plan target-plan-1");

		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(100).join("\n"));
		expect(expanded).toContain("Target card");
		expect(expanded).toContain("(none)");
		expect(expanded).toContain("in_scope: 1");
		expect(expanded).not.toContain("capability: approved target plan target-plan-1");
	});
});
