import { Box, Markdown, replaceTabs, Spacer, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { CustomMessage, GoalCheckpointResolutionMessageDetails } from "../../session/messages";

const COLLAPSED_PREVIEW_WIDTH = 72;

function previewLine(value: string | undefined): string {
	const normalized = replaceTabs((value ?? "").replace(/\s+/g, " ").trim());
	return truncateToWidth(normalized, COLLAPSED_PREVIEW_WIDTH);
}

export class GoalCheckpointResolutionMessageComponent extends Box {
	#expanded = false;

	constructor(private readonly message: CustomMessage<GoalCheckpointResolutionMessageDetails>) {
		super(1, 1, t => theme.bg("customMessageBg", t));
		this.#updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		this.clear();
		const label = theme.fg("customMessageLabel", theme.bold("[goal-checkpoint-resolution]"));
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));
		const details = this.message.details;
		if (this.#expanded) {
			this.addChild(
				new Markdown(this.#expandedMarkdown(details), 0, 0, getMarkdownTheme(), {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
			return;
		}
		const decision = details?.resolution.decision ?? "controller decision";
		const next = previewLine(details?.resolution.nextTarget?.title);
		this.addChild(
			new Text(
				theme.fg("customMessageText", `Next target / controller decision: ${decision} (ctrl+o to expand)`),
				0,
				0,
			),
		);
		if (next) this.addChild(new Text(theme.fg("customMessageText", next), 0, 1));
	}

	#expandedMarkdown(details: GoalCheckpointResolutionMessageDetails | undefined): string {
		const resolution = details?.resolution;
		if (!resolution) return "**Goal checkpoint resolution**\n\n(no resolution details)";
		const notPropagated = resolution.notPropagated.map(item => `- ${item}`).join("\n");
		const remaining = resolution.remainingParentWork.map(item => `- ${item}`).join("\n");
		const checks = resolution.broaderChecksOrInputs.map(item => `- ${item}`).join("\n");
		return [
			"**Checkpoint resolution**",
			`**Decision**\n\n${resolution.decision}`,
			`**Parent reading**\n\n${replaceTabs(resolution.parentReading)}`,
			`**Next target**\n\n${replaceTabs(resolution.nextTarget?.title ?? "(none)")}`,
			`**Not propagated**\n\n${replaceTabs(notPropagated || "(none)")}`,
			`**Remaining parent work**\n\n${replaceTabs(remaining || "(none)")}`,
			`**Broader checks or inputs**\n\n${replaceTabs(checks || "(none)")}`,
		].join("\n\n");
	}
}
