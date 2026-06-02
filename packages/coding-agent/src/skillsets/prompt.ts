import type { SkillsetActivation } from "../capability/skillset";
import { shortenPath } from "../tools/render-utils";

export interface ActiveSkillsetPromptSummary {
	id: string;
	description: string;
	root: string;
	detectedFrom: string;
	skills: string[];
	promptSummary?: string;
	toolHints: string[];
}

function summarizeSkillsetEvidence(activeSkillset: SkillsetActivation): string {
	const evidence = activeSkillset.evidence[0];
	if (!evidence) return activeSkillset.confidence;
	const value = evidence.value ?? evidence.kind;
	if (evidence.path) return `${value} at ${shortenPath(evidence.path.replace(/\\/g, "/"))}`;
	return value;
}

export function buildActiveSkillsetPromptSummaries(
	activeSkillsets: readonly SkillsetActivation[] | undefined,
	visibleSkillNames: ReadonlySet<string>,
): ActiveSkillsetPromptSummary[] {
	if (!activeSkillsets || activeSkillsets.length === 0) return [];
	return activeSkillsets
		.map(activeSkillset => {
			const skills = activeSkillset.effects.skills.filter(name => visibleSkillNames.has(name));
			const hasConfiguredSkillEffects =
				(activeSkillset.skillset.provides.skills?.length ?? 0) > 0 ||
				(activeSkillset.skillset.provides.skillDirectories?.length ?? 0) > 0;
			const promptSummary =
				skills.length > 0 || !hasConfiguredSkillEffects ? activeSkillset.effects.promptSummary : undefined;
			return {
				id: activeSkillset.skillset.id,
				description: activeSkillset.skillset.description,
				root: shortenPath(activeSkillset.root.replace(/\\/g, "/")),
				detectedFrom: summarizeSkillsetEvidence(activeSkillset),
				skills,
				...(promptSummary ? { promptSummary } : {}),
				toolHints: activeSkillset.effects.toolHints,
			};
		})
		.filter(summary => summary.skills.length > 0 || summary.promptSummary);
}
