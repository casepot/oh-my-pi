import { Box, Markdown, replaceTabs, Spacer, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { CustomMessage, GoalRubricMessageDetails } from "../../session/messages";

const COLLAPSED_PREVIEW_WIDTH = 72;

function previewLine(value: string | undefined): string {
	const normalized = replaceTabs((value ?? "").replace(/\s+/g, " ").trim());
	return truncateToWidth(normalized, COLLAPSED_PREVIEW_WIDTH);
}

export class GoalRubricMessageComponent extends Box {
	#expanded = false;

	constructor(private readonly message: CustomMessage<GoalRubricMessageDetails>) {
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

		const label = theme.fg("customMessageLabel", theme.bold("[goal-rubric]"));
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
		const prefix = objective ? `Rubric for ${objective}` : "Goal rubric";
		this.addChild(new Text(theme.fg("customMessageText", `${prefix} (ctrl+o to expand)`), 0, 0));
		const rubricPreview = previewLine(details?.rubric);
		if (rubricPreview) {
			this.addChild(new Text(theme.fg("customMessageText", rubricPreview), 0, 1));
		}
	}

	#expandedMarkdown(details: GoalRubricMessageDetails | undefined): string {
		const objective = replaceTabs(details?.objective?.trim() || "(unknown objective)");
		const rubric = replaceTabs(details?.rubric?.trim() || "(no rubric provided)");
		return `**Objective**\n\n${objective}\n\n**Rubric**\n\n${rubric}`;
	}
}
