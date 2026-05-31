import type { ProjectFacet, ProjectFacetConfidence, ProjectFacetEvidence } from "../project-detection";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export type SkillsetMode = "auto" | "suggest" | "manual";
export type SkillsetGlobalMode = "off" | "suggest" | "auto";

export interface SkillsetDependencyFileMatcher {
	path: string;
	contains?: string[];
}

export interface ProjectMatcher {
	facets?: string[];
	rootMarkers?: string[];
	fileGlobs?: string[];
	dependencyFiles?: SkillsetDependencyFileMatcher[];
	binaries?: string[];
	all?: ProjectMatcher[];
	any?: ProjectMatcher[];
	not?: ProjectMatcher[];
}

export interface SkillsetProvides {
	skills?: string[];
	skillDirectories?: string[];
	rules?: string[];
	ruleDirectories?: string[];
	alwaysApplyRules?: string[];
	promptSummary?: string;
	toolHints?: string[];
}

export interface SkillsetDefinition {
	id: string;
	description: string;
	match: ProjectMatcher;
	provides: SkillsetProvides;
	mode?: SkillsetMode;
	priority?: number;
	source?: SourceMeta;
	_source: SourceMeta;
}

export interface ResolvedSkillsetEffects {
	skills: string[];
	skillDirectories: string[];
	rules: string[];
	ruleDirectories: string[];
	alwaysApplyRules: string[];
	promptSummary?: string;
	toolHints: string[];
}

export interface SkillsetActivation {
	skillset: SkillsetDefinition;
	root: string;
	confidence: ProjectFacetConfidence;
	evidence: ProjectFacetEvidence[];
	effects: ResolvedSkillsetEffects;
}

export interface SkillsetActivationPlan {
	facets: ProjectFacet[];
	activations: SkillsetActivation[];
	suggestions: SkillsetActivation[];
	warnings: string[];
}

export const skillsetCapability = defineCapability<SkillsetDefinition>({
	id: "skillsets",
	displayName: "Skillsets",
	description: "Project-aware activation recipes for skills, rules, and prompt affordances",
	key: skillset => skillset.id,
	toExtensionId: skillset => `skillset:${skillset.id}`,
	validate: skillset => {
		if (!skillset.id) return "Missing skillset id";
		if (!skillset.description) return "Missing skillset description";
		if (!skillset.match) return "Missing skillset match";
		if (!skillset.provides) return "Missing skillset provides";
		return undefined;
	},
});
