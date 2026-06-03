import { Box, Markdown, replaceTabs, Spacer, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { CustomMessage, GoalVerificationFeedbackMessageDetails } from "../../session/messages";

const COLLAPSED_PREVIEW_WIDTH = 72;

function previewLine(value: string | undefined): string {
	const normalized = replaceTabs((value ?? "").replace(/\s+/g, " ").trim());
	return truncateToWidth(normalized, COLLAPSED_PREVIEW_WIDTH);
}

function attemptLabel(details: GoalVerificationFeedbackMessageDetails | undefined): string {
	if (!details) {
		return "attempt ?/?";
	}
	return `attempt ${details.attempt}/${details.maxAttempts}`;
}

export class GoalVerificationFeedbackMessageComponent extends Box {
	#expanded = false;

	constructor(private readonly message: CustomMessage<GoalVerificationFeedbackMessageDetails>) {
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

		const label = theme.fg("customMessageLabel", theme.bold("[goal-verification-feedback]"));
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

		const objective = previewLine(details?.objective);
		const prefix = objective ? `Verification rejected for ${objective}` : "Goal verification rejected";
		const collapsedText = `${theme.status.warning} ${prefix} (${attemptLabel(details)}, ctrl+o to expand)`;
		this.addChild(new Text(theme.fg("customMessageText", collapsedText), 0, 0));
		const feedbackPreview = previewLine(details?.feedback);
		if (feedbackPreview) {
			this.addChild(new Text(theme.fg("customMessageText", feedbackPreview), 0, 1));
		}
	}

	#expandedMarkdown(details: GoalVerificationFeedbackMessageDetails | undefined): string {
		const objective = replaceTabs(details?.objective?.trim() || "(unknown objective)");
		const feedback = replaceTabs(details?.feedback?.trim() || "(no verifier feedback provided)");
		const memo = details?.compactorMemo?.trim();
		const memoSection = memo ? `\n\n**Compactor Memo**\n\n${replaceTabs(memo)}` : "";
		return [
			`**Objective**\n\n${objective}`,
			`**Attempt**\n\n${attemptLabel(details)}`,
			`**Verifier Feedback**\n\n${feedback}${memoSection}`,
		].join("\n\n");
	}
}
