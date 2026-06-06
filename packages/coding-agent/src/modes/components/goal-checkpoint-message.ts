import { Box, Markdown, replaceTabs, Spacer, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { CustomMessage, GoalCheckpointMessageDetails } from "../../session/messages";

const COLLAPSED_PREVIEW_WIDTH = 72;

function previewLine(value: string | undefined): string {
	const normalized = replaceTabs((value ?? "").replace(/\s+/g, " ").trim());
	return truncateToWidth(normalized, COLLAPSED_PREVIEW_WIDTH);
}

export class GoalCheckpointMessageComponent extends Box {
	#expanded = false;

	constructor(private readonly message: CustomMessage<GoalCheckpointMessageDetails>) {
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
		const label = theme.fg("customMessageLabel", theme.bold("[goal-checkpoint]"));
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
		const target = previewLine(details?.checkpoint.targetSnapshot.title);
		const summary = previewLine(details?.checkpoint.summary);
		const statusText =
			details?.review?.status === "rejected"
				? "Checkpoint rejected; target remains active"
				: "Target closed; parent goal still active";
		this.addChild(
			new Text(theme.fg("customMessageText", `${statusText} (${target || "checkpoint"}, ctrl+o to expand)`), 0, 0),
		);
		if (summary) this.addChild(new Text(theme.fg("customMessageText", summary), 0, 1));
	}

	#expandedMarkdown(details: GoalCheckpointMessageDetails | undefined): string {
		const checkpoint = details?.checkpoint;
		if (!checkpoint) return "**Goal checkpoint**\n\n(no checkpoint details)";
		const evidence = checkpoint.evidence
			.map(item => `- ${item.claim}: ${item.evidence} (current: ${item.current})`)
			.join("\n");
		const nonClaims = checkpoint.notClaimed.map(item => `- ${item}`).join("\n");
		const questions = checkpoint.remainingQuestions.map(item => `- ${item}`).join("\n");
		const heading =
			details?.review?.status === "rejected"
				? "**Checkpoint rejected; target remains active**"
				: "**Target closed; parent goal still active**";
		return [
			heading,
			`**Target**\n\n${replaceTabs(checkpoint.targetSnapshot.title)}`,
			`**Summary**\n\n${replaceTabs(checkpoint.summary)}`,
			`**Evidence**\n\n${replaceTabs(evidence || "(none)")}`,
			`**Not claimed**\n\n${replaceTabs(nonClaims || "(none)")}`,
			`**Remaining questions**\n\n${replaceTabs(questions || "(none)")}`,
			`**Review**\n\n${replaceTabs(details?.review?.feedback || checkpoint.review?.feedback || "accepted")}`,
		].join("\n\n");
	}
}
