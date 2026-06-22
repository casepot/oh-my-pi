import { Box, Markdown, replaceTabs, Spacer, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { CustomMessage, GoalTargetPlanMessageDetails } from "../../session/messages";

const COLLAPSED_PREVIEW_WIDTH = 72;

function previewLine(value: string | undefined): string {
	const normalized = replaceTabs((value ?? "").replace(/\s+/g, " ").trim());
	return truncateToWidth(normalized, COLLAPSED_PREVIEW_WIDTH);
}

function listOrNone(items: readonly string[] | undefined): string {
	return items && items.length > 0 ? items.map(item => `- ${item}`).join("\n") : "(none)";
}

function workstreamSummaryMarkdown(details: GoalTargetPlanMessageDetails): string {
	const workstreams = details.workstreamSummary ?? details.targetCard?.workstreams ?? [];
	if (workstreams.length === 0) return "(none)";
	return workstreams
		.map(workstream => {
			const files = workstream.files.length > 0 ? ` files: ${workstream.files.join(", ")}` : "";
			const role = workstream.role ? ` role: ${workstream.role}` : "";
			return `- ${workstream.id} (${workstream.kind}${role}): ${workstream.label}${files}`;
		})
		.join("\n");
}

export class GoalTargetPlanMessageComponent extends Box {
	#expanded = false;

	constructor(private readonly message: CustomMessage<GoalTargetPlanMessageDetails>) {
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
		const label = theme.fg("customMessageLabel", theme.bold("[goal-target-plan]"));
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
		const status = details?.status ?? "unknown";
		const revision = details?.revision ?? 0;
		const targetPlanId = previewLine(details?.targetPlanId) || "target-plan";
		this.addChild(
			new Text(theme.fg("customMessageText", `Target plan ${status} r${revision} · ${targetPlanId}`), 0, 0),
		);
		const planFilePath = previewLine(details?.planFilePath);
		if (planFilePath) this.addChild(new Text(theme.fg("customMessageText", planFilePath), 0, 1));
		const claim = previewLine(details?.targetCard?.capabilityClaim);
		if (claim) this.addChild(new Text(theme.fg("customMessageText", claim), 0, 2));
		const blocked = this.#blockedPreview(details);
		if (blocked) this.addChild(new Text(theme.fg("warning", blocked), 0, claim ? 3 : 2));
	}

	#blockedPreview(details: GoalTargetPlanMessageDetails | undefined): string | undefined {
		const reviews = details?.reviews ?? [];
		for (const review of reviews) {
			const blockingProblem = review.findings.find(finding => finding.severity === "blocking")?.problem;
			if (review.status === "accepted" && !blockingProblem) continue;
			return previewLine(`blocked: ${review.lens}: ${review.feedback || blockingProblem || "review blocked"}`);
		}
		return undefined;
	}

	#expandedMarkdown(details: GoalTargetPlanMessageDetails | undefined): string {
		if (!details) return "**Goal target plan**\n\n(no target plan details)";
		const reviewerStatuses = details.reviews.map(review => `- ${review.lens}: ${review.status}`).join("\n");
		const blockingFindings = details.reviews
			.flatMap(review =>
				review.findings
					.filter(finding => finding.severity === "blocking")
					.map(finding => `- ${review.lens}/${finding.id}: ${finding.problem}`),
			)
			.join("\n");
		const feedback = details.reviews.map(review => `- ${review.lens}: ${review.feedback}`).join("\n");
		const card = details.targetCard;
		const matrix = details.matrixRowCounts
			? `in_scope: ${details.matrixRowCounts.inScope}\nleft_open: ${details.matrixRowCounts.leftOpen}`
			: "(none)";
		const fanout =
			details.implementationFanoutRequired === undefined
				? "(unknown)"
				: details.implementationFanoutRequired
					? "recommended by workstream/blast-radius metadata; not automatic"
					: "not required";
		const sections = [
			"**Goal target plan**",
			[
				"**Target identity**",
				`target_id: ${details.targetId}`,
				`target_plan_id: ${details.targetPlanId}`,
				`plan_file_path: ${details.planFilePath}`,
				`revision: ${details.revision}`,
				`plan_depth: ${details.planDepth ?? "(legacy)"}`,
				`primary_signal_group_id: ${details.primarySignalGroupId ?? "(unknown)"}`,
			].join("\n\n"),
			`**Status**\n\n${details.status}`,
			`**Target card**\n\n${card ? [`capability: ${card.capabilityClaim}`, `surface: ${card.userVisibleSurface}`, `known limits:\n${listOrNone(card.knownLimits)}`].join("\n\n") : "(none)"}`,
			`**Scenario matrix**\n\n${matrix}`,
			`**Workstreams**\n\n${workstreamSummaryMarkdown(details)}`,
			`**Implementation fanout**\n\n${fanout}`,
			`**Reviewer statuses**\n\n${reviewerStatuses || "(none)"}`,
			`**Blocking findings**\n\n${blockingFindings || "(none)"}`,
			`**Reviewer feedback**\n\n${feedback || "(none)"}`,
		];
		if (details.status === "failed" && details.failure) {
			sections.push(
				[
					"**Failure details**",
					`stage: ${details.failure.stage}`,
					`reason: ${details.failure.reason}`,
					`message: ${details.failure.message}`,
					`blockers:\n${details.failure.blockers.map(blocker => `- ${blocker}`).join("\n") || "(none)"}`,
				].join("\n\n"),
			);
		}
		return replaceTabs(sections.join("\n\n"));
	}
}
