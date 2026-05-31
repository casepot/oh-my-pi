import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, getProjectDir } from "@oh-my-pi/pi-utils";
import type {
	ProjectMatcher,
	ResolvedSkillsetEffects,
	SkillsetActivation,
	SkillsetActivationPlan,
	SkillsetDefinition,
	SkillsetGlobalMode,
} from "../capability/skillset";
import { skillsetCapability } from "../capability/skillset";
import type { SkillsetsSettings, SkillsSettings } from "../config/settings";
import { type Skill as CapabilitySkill, loadCapability } from "../discovery";
import { compareSkillOrder, scanSkillsFromDir } from "../discovery/helpers";
import { loadSkillsetDefinitionDirectory, loadSkillsetDefinitionFile } from "../discovery/skillsets";
import {
	detectFileGlobEvidence,
	detectRootMarkerEvidence,
	type ProjectFacet,
	type ProjectFacetConfidence,
	type ProjectFacetEvidence,
} from "../project-detection";
import { expandTilde } from "../tools/path-utils";
import type { Skill, SkillWarning } from "./skills";

interface MatchResult {
	root: string;
	confidence: ProjectFacetConfidence;
	evidence: ProjectFacetEvidence[];
}

export interface LoadSkillsetDefinitionsOptions extends Partial<SkillsetsSettings> {
	cwd?: string;
	disabledExtensions?: string[];
}

export interface CompileSkillsetActivationOptions {
	cwd: string;
	facets: ProjectFacet[];
	definitions: SkillsetDefinition[];
	settings: SkillsetsSettings;
	baseSkills: readonly Skill[];
	baseWarnings?: readonly SkillWarning[];
	disabledExtensions?: readonly string[];
	skillsSettings?: SkillsSettings;
}

export interface CompileSkillsetActivationResult extends SkillsetActivationPlan {
	skills: Skill[];
	skillWarnings: SkillWarning[];
	alwaysApplyRuleNames: Set<string>;
	ruleNames: Set<string>;
}

function confidenceRank(confidence: ProjectFacetConfidence): number {
	switch (confidence) {
		case "explicit":
			return 3;
		case "strong":
			return 2;
		case "weak":
			return 1;
	}
}

function weakestConfidence(values: ProjectFacetConfidence[]): ProjectFacetConfidence {
	let weakest: ProjectFacetConfidence = "explicit";
	for (const value of values) {
		if (confidenceRank(value) < confidenceRank(weakest)) weakest = value;
	}
	return weakest;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
	return Array.from(new Set((values ?? []).filter(value => value.length > 0)));
}

function truncate(value: string, maxChars: number | undefined): string {
	const limit = maxChars ?? 3000;
	if (limit <= 0 || value.length <= limit) return value;
	return value.slice(0, limit);
}

function candidateRoots(cwd: string, facets: readonly ProjectFacet[]): string[] {
	const roots = new Set<string>([path.resolve(cwd)]);
	for (const facet of facets) roots.add(path.resolve(facet.root));
	return Array.from(roots);
}

function isSafeRootRelative(root: string, value: string): boolean {
	if (!value || path.isAbsolute(value)) return false;
	const resolved = path.resolve(root, value);
	const relative = path.relative(root, resolved);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function dependencyFileMatches(
	root: string,
	matcher: NonNullable<ProjectMatcher["dependencyFiles"]>[number],
): Promise<ProjectFacetEvidence | null> {
	if (!isSafeRootRelative(root, matcher.path)) return null;
	const filePath = path.resolve(root, matcher.path);
	let content: string;
	try {
		content = await Bun.file(filePath).text();
	} catch {
		return null;
	}
	const required = matcher.contains ?? [];
	if (required.length > 0 && !required.every(value => content.includes(value))) return null;
	return { kind: "dependency", path: filePath, value: required.length > 0 ? required.join(", ") : matcher.path };
}

function binaryMatches(binary: string): ProjectFacetEvidence | null {
	const resolved = $which(binary);
	return resolved ? { kind: "binary", path: resolved, value: binary } : null;
}

function combineMatches(matches: MatchResult[]): MatchResult {
	return {
		root: matches[0]?.root ?? getProjectDir(),
		confidence: weakestConfidence(matches.map(match => match.confidence)),
		evidence: matches.flatMap(match => match.evidence),
	};
}

async function evaluateMatcher(
	matcher: ProjectMatcher,
	ctx: { cwd: string; facets: ProjectFacet[] },
): Promise<MatchResult | null> {
	const matches: MatchResult[] = [];
	const roots = candidateRoots(ctx.cwd, ctx.facets);

	if (matcher.any) {
		let anyMatch: MatchResult | null = null;
		for (const nested of matcher.any) {
			anyMatch = await evaluateMatcher(nested, ctx);
			if (anyMatch) break;
		}
		if (!anyMatch) return null;
		matches.push(anyMatch);
	}

	if (matcher.all) {
		const nestedMatches: MatchResult[] = [];
		for (const nested of matcher.all) {
			const nestedMatch = await evaluateMatcher(nested, ctx);
			if (!nestedMatch) return null;
			nestedMatches.push(nestedMatch);
		}
		if (nestedMatches.length > 0) matches.push(combineMatches(nestedMatches));
	}

	if (matcher.not) {
		for (const nested of matcher.not) {
			if (await evaluateMatcher(nested, ctx)) return null;
		}
	}

	if (matcher.facets && matcher.facets.length > 0) {
		const facet = ctx.facets.find(candidate => matcher.facets?.includes(candidate.id));
		if (!facet) return null;
		matches.push({ root: facet.root, confidence: facet.confidence, evidence: facet.evidence });
	}

	if (matcher.rootMarkers && matcher.rootMarkers.length > 0) {
		let markerMatch: MatchResult | null = null;
		for (const root of roots) {
			const evidence = await detectRootMarkerEvidence(root, matcher.rootMarkers);
			if (evidence.length > 0) {
				markerMatch = { root, confidence: "strong", evidence };
				break;
			}
		}
		if (!markerMatch) return null;
		matches.push(markerMatch);
	}

	if (matcher.fileGlobs && matcher.fileGlobs.length > 0) {
		let fileMatch: MatchResult | null = null;
		for (const root of roots) {
			const evidence = await detectFileGlobEvidence(root, matcher.fileGlobs);
			if (evidence.length > 0) {
				fileMatch = { root, confidence: "weak", evidence };
				break;
			}
		}
		if (!fileMatch) return null;
		matches.push(fileMatch);
	}

	if (matcher.dependencyFiles && matcher.dependencyFiles.length > 0) {
		const dependencyMatches: MatchResult[] = [];
		for (const dependency of matcher.dependencyFiles) {
			let dependencyMatch: MatchResult | null = null;
			for (const root of roots) {
				const evidence = await dependencyFileMatches(root, dependency);
				if (evidence) {
					dependencyMatch = { root, confidence: "strong", evidence: [evidence] };
					break;
				}
			}
			if (!dependencyMatch) return null;
			dependencyMatches.push(dependencyMatch);
		}
		matches.push(combineMatches(dependencyMatches));
	}

	if (matcher.binaries && matcher.binaries.length > 0) {
		const binaryEvidence: ProjectFacetEvidence[] = [];
		for (const binary of matcher.binaries) {
			const evidence = binaryMatches(binary);
			if (!evidence) return null;
			binaryEvidence.push(evidence);
		}
		matches.push({ root: path.resolve(ctx.cwd), confidence: "weak", evidence: binaryEvidence });
	}

	if (matches.length === 0 && matcher.not && matcher.not.length > 0) {
		return { root: path.resolve(ctx.cwd), confidence: "weak", evidence: [] };
	}
	if (matches.length === 0) return null;
	return combineMatches(matches);
}

function resolveSkillsetMode(settings: SkillsetsSettings): SkillsetGlobalMode {
	if (settings.enabled === false) return "off";
	return settings.mode ?? "auto";
}

function isDefinitionAllowed(definition: SkillsetDefinition, settings: SkillsetsSettings): boolean {
	const include = settings.include ?? [];
	if (include.length > 0 && !include.includes(definition.id)) return false;
	return !(settings.disabled ?? []).includes(definition.id);
}

function emptyEffects(definition: SkillsetDefinition, settings: SkillsetsSettings): ResolvedSkillsetEffects {
	return {
		skills: [],
		skillDirectories: uniqueStrings(definition.provides.skillDirectories),
		rules: uniqueStrings(definition.provides.rules),
		ruleDirectories: uniqueStrings(definition.provides.ruleDirectories),
		alwaysApplyRules: uniqueStrings(definition.provides.alwaysApplyRules),
		...(definition.provides.promptSummary
			? { promptSummary: truncate(definition.provides.promptSummary, settings.maxPromptSummaryChars) }
			: {}),
		toolHints: uniqueStrings(definition.provides.toolHints),
	};
}

async function existingDirectory(dir: string): Promise<boolean> {
	try {
		return (await fs.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

function pathIsWithinOrEqual(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realPathOrSelf(filePath: string): Promise<string> {
	try {
		return await fs.realpath(filePath);
	} catch {
		return filePath;
	}
}

interface SkillNameFilter {
	canUse(name: string): boolean;
}

function createSkillNameFilter(
	skillsSettings: SkillsSettings | undefined,
	disabledExtensions: readonly string[] | undefined,
): SkillNameFilter {
	const disabledSkillNames = new Set(
		(disabledExtensions ?? []).filter(id => id.startsWith("skill:")).map(id => id.slice(6)),
	);
	const ignoredSkills = skillsSettings?.ignoredSkills ?? [];
	const includeSkills = skillsSettings?.includeSkills ?? [];
	return {
		canUse(name: string): boolean {
			if (skillsSettings?.enabled === false) return false;
			if (disabledSkillNames.has(name)) return false;
			if (ignoredSkills.some(pattern => new Bun.Glob(pattern).match(name))) return false;
			if (includeSkills.length > 0 && !includeSkills.some(pattern => new Bun.Glob(pattern).match(name)))
				return false;
			return true;
		},
	};
}

function capabilitySkillToPromptSkill(skill: CapabilitySkill, source: string): Skill {
	return {
		name: skill.name,
		description: typeof skill.frontmatter?.description === "string" ? skill.frontmatter.description : "",
		filePath: skill.path,
		baseDir: skill.path.replace(/[\\/]SKILL\.md$/, ""),
		source,
		hide: skill.frontmatter?.hide === true,
		_source: { ...skill._source, providerName: "Skillset" },
	};
}

async function addSkillIfNew(
	skill: Skill,
	skillMap: Map<string, Skill>,
	realPathSet: Set<string>,
	warnings: SkillWarning[],
): Promise<void> {
	let resolvedPath = skill.filePath;
	try {
		resolvedPath = await fs.realpath(skill.filePath);
	} catch {}
	if (realPathSet.has(resolvedPath)) return;
	const existing = skillMap.get(skill.name);
	if (existing) {
		warnings.push({
			skillPath: skill.filePath,
			message: `name collision: "${skill.name}" already loaded from ${existing.filePath}, skipping this one`,
		});
		return;
	}
	skillMap.set(skill.name, skill);
	realPathSet.add(resolvedPath);
}

async function buildBaseSkillState(
	baseSkills: readonly Skill[],
): Promise<{ skillMap: Map<string, Skill>; realPathSet: Set<string> }> {
	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	for (const skill of baseSkills) {
		let resolvedPath = skill.filePath;
		try {
			resolvedPath = await fs.realpath(skill.filePath);
		} catch {}
		skillMap.set(skill.name, skill);
		realPathSet.add(resolvedPath);
	}
	return { skillMap, realPathSet };
}

async function scanSkillsetSkillDirectories(
	activation: SkillsetActivation,
	skillMap: Map<string, Skill>,
	realPathSet: Set<string>,
	warnings: SkillWarning[],
	skillFilter: SkillNameFilter,
): Promise<string[]> {
	const loadedNames: string[] = [];
	const sourceLevel = activation.skillset._source.level === "user" ? "user" : "project";
	const projectRealRoot =
		activation.skillset._source.level === "project" ? await realPathOrSelf(activation.root) : null;
	for (const rawDir of activation.effects.skillDirectories) {
		if (activation.skillset._source.level === "project" && (rawDir.startsWith("~") || path.isAbsolute(rawDir))) {
			warnings.push({
				skillPath: rawDir,
				message: `project skillset "${activation.skillset.id}" skill directory must be relative to the project root`,
			});
			continue;
		}
		const dir =
			activation.skillset._source.level === "project"
				? path.resolve(activation.root, rawDir)
				: path.resolve(expandTilde(rawDir));
		if (!(await existingDirectory(dir))) {
			warnings.push({
				skillPath: dir,
				message: `skillset "${activation.skillset.id}" skill directory does not exist`,
			});
			continue;
		}
		if (activation.skillset._source.level === "project") {
			const realDir = await realPathOrSelf(dir);
			if (!pathIsWithinOrEqual(projectRealRoot ?? activation.root, realDir)) {
				warnings.push({
					skillPath: dir,
					message: `project skillset "${activation.skillset.id}" skill directory escapes the project root`,
				});
				continue;
			}
		}
		const result = await scanSkillsFromDir(
			{ cwd: activation.root, home: os.homedir(), repoRoot: null },
			{
				dir,
				providerId: `skillset:${activation.skillset.id}`,
				level: sourceLevel,
				requireDescription: true,
			},
		);
		for (const message of result.warnings ?? []) warnings.push({ skillPath: dir, message });
		for (const capSkill of result.items) {
			if (projectRealRoot) {
				const realSkillPath = await realPathOrSelf(capSkill.path);
				if (!pathIsWithinOrEqual(projectRealRoot, realSkillPath)) {
					warnings.push({
						skillPath: capSkill.path,
						message: `project skillset "${activation.skillset.id}" skill file escapes the project root`,
					});
					continue;
				}
			}
			if (!skillFilter.canUse(capSkill.name)) continue;
			const skill = capabilitySkillToPromptSkill(capSkill, `skillset:${activation.skillset.id}`);
			await addSkillIfNew(skill, skillMap, realPathSet, warnings);
			if (skillMap.get(skill.name)?.filePath === skill.filePath) loadedNames.push(skill.name);
		}
	}
	return loadedNames;
}

async function resolveActivationEffects(
	activation: SkillsetActivation,
	skillMap: Map<string, Skill>,
	realPathSet: Set<string>,
	warnings: SkillWarning[],
	skillFilter: SkillNameFilter,
): Promise<void> {
	const loadedFromDirectories = await scanSkillsetSkillDirectories(
		activation,
		skillMap,
		realPathSet,
		warnings,
		skillFilter,
	);
	const requestedSkills = uniqueStrings(activation.skillset.provides.skills);
	const resolvedSkills = new Set<string>();
	for (const name of requestedSkills) {
		if (!skillFilter.canUse(name)) continue;
		if (skillMap.has(name)) {
			resolvedSkills.add(name);
		} else {
			warnings.push({
				skillPath: activation.skillset._source.path,
				message: `skillset "${activation.skillset.id}" references missing skill "${name}"`,
			});
		}
	}
	if (requestedSkills.length === 0) {
		for (const name of loadedFromDirectories) resolvedSkills.add(name);
	}
	activation.effects.skills = Array.from(resolvedSkills).sort((left, right) => left.localeCompare(right));
}

export async function loadSkillsetDefinitions(
	options: LoadSkillsetDefinitionsOptions = {},
): Promise<{ definitions: SkillsetDefinition[]; warnings: string[] }> {
	const cwd = options.cwd ?? getProjectDir();
	const result = await loadCapability<SkillsetDefinition>(skillsetCapability.id, {
		cwd,
		includeUserSources: true,
		disabledExtensions: options.disabledExtensions,
	});
	const customFiles = options.customFiles ?? [];
	const customDirectories = options.customDirectories ?? [];
	const customFileResults = await Promise.all(
		customFiles.map(filePath =>
			loadSkillsetDefinitionFile(path.resolve(expandTilde(filePath)), "custom-skillset", "project"),
		),
	);
	const customDirectoryResults = await Promise.all(
		customDirectories.map(dir =>
			loadSkillsetDefinitionDirectory(path.resolve(expandTilde(dir)), "custom-skillset", "project"),
		),
	);
	const definitions = [
		...customFileResults.flatMap(custom => custom.items),
		...customDirectoryResults.flatMap(custom => custom.items),
		...result.items,
	];
	const seen = new Set<string>();
	const deduped: SkillsetDefinition[] = [];
	for (const definition of definitions) {
		if (seen.has(definition.id)) continue;
		seen.add(definition.id);
		deduped.push(definition);
	}
	return {
		definitions: deduped.sort(
			(left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id),
		),
		warnings: [
			...(result.warnings ?? []),
			...customFileResults.flatMap(custom => custom.warnings ?? []),
			...customDirectoryResults.flatMap(custom => custom.warnings ?? []),
		],
	};
}

export async function compileSkillsetActivationPlan(
	options: CompileSkillsetActivationOptions,
): Promise<CompileSkillsetActivationResult> {
	const mode = resolveSkillsetMode(options.settings);
	const warnings: SkillWarning[] = [...(options.baseWarnings ?? [])];
	const planWarnings: string[] = [];
	if (mode === "off") {
		return {
			facets: options.facets,
			activations: [],
			suggestions: [],
			warnings: [],
			skills: [...options.baseSkills],
			skillWarnings: warnings,
			alwaysApplyRuleNames: new Set<string>(),
			ruleNames: new Set<string>(),
		};
	}

	const activations: SkillsetActivation[] = [];
	const suggestions: SkillsetActivation[] = [];
	for (const definition of options.definitions) {
		if (!isDefinitionAllowed(definition, options.settings)) continue;
		if (options.disabledExtensions?.includes(`skillset:${definition.id}`)) continue;
		const match = await evaluateMatcher(definition.match, { cwd: options.cwd, facets: options.facets });
		if (!match) continue;
		const activation: SkillsetActivation = {
			skillset: definition,
			root: match.root,
			confidence: match.confidence,
			evidence: match.evidence,
			effects: emptyEffects(definition, options.settings),
		};
		const definitionMode = definition.mode ?? "auto";
		if (mode === "suggest" || definitionMode === "suggest") {
			suggestions.push(activation);
			continue;
		}
		if (definitionMode === "manual") continue;
		activations.push(activation);
	}

	const { skillMap, realPathSet } = await buildBaseSkillState(options.baseSkills);
	const skillFilter = createSkillNameFilter(options.skillsSettings, options.disabledExtensions);
	for (const activation of activations) {
		await resolveActivationEffects(activation, skillMap, realPathSet, warnings, skillFilter);
	}
	const alwaysApplyRuleNames = new Set<string>();
	const ruleNames = new Set<string>();
	for (const activation of activations) {
		for (const name of activation.effects.alwaysApplyRules) alwaysApplyRuleNames.add(name);
		for (const name of activation.effects.rules) ruleNames.add(name);
	}
	const skills = Array.from(skillMap.values()).sort((left, right) =>
		compareSkillOrder(left.name, left.filePath, right.name, right.filePath),
	);
	for (const warning of warnings) planWarnings.push(warning.message);
	return {
		facets: options.facets,
		activations,
		suggestions,
		warnings: planWarnings,
		skills,
		skillWarnings: warnings,
		alwaysApplyRuleNames,
		ruleNames,
	};
}
