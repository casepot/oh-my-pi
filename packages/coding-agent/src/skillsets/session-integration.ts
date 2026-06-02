import { logger } from "@oh-my-pi/pi-utils";
import { loadCapability } from "../capability";
import { type Rule, ruleCapability } from "../capability/rule";
import { bucketRules, ruleNamesFromDisabledExtensions } from "../capability/rule-buckets";
import type { SkillsetDefinition } from "../capability/skillset";
import type { Settings, SkillsetsSettings, SkillsSettings } from "../config/settings";
import { TtsrManager } from "../export/ttsr";
import { loadSkills, type Skill, type SkillWarning } from "../extensibility/skills";
import {
	type CompileSkillsetActivationResult,
	compileSkillsetActivationPlan,
	loadSkillsetDefinitions,
} from "../extensibility/skillsets";
import { detectProjectFacets } from "../project-detection";

interface RuleMergeResult {
	rules: Rule[];
	warnings: string[];
}

interface SkillsetDefinitionLoadResult {
	definitions: SkillsetDefinition[];
	warnings: string[];
}

type StartupDeadline = <T>(name: string, work: Promise<T>, fallback: T) => Promise<T>;

export interface SkillsetSessionIntegrationInput {
	cwd: string;
	settings: Settings;
	skillsSettings: SkillsSettings;
	skillsetsSettings: SkillsetsSettings;
	disabledExtensionIds: string[];
	optionsSkills?: Skill[];
	withStartupDeadline: StartupDeadline;
}

export interface ResolveSkillsetSessionInput {
	optionsRules?: Rule[];
	injectedTtsrRules: readonly string[];
}

export interface SkillsetSessionIntegrationResult {
	skills: Skill[];
	skillWarnings: SkillWarning[];
	activeSkillsets: CompileSkillsetActivationResult["activations"];
	suggestedSkillsets: CompileSkillsetActivationResult["suggestions"];
	ttsrManager: TtsrManager;
	rulebookRules: Rule[];
	alwaysApplyRules: Rule[];
}

export interface SkillsetSessionIntegrationWork {
	resolve(input: ResolveSkillsetSessionInput): Promise<SkillsetSessionIntegrationResult>;
}

function ruleSourceLabel(rule: Rule): string {
	const provider = rule._source.providerName || rule._source.provider;
	return `${provider}:${rule._source.path}`;
}

function mergeRulesFirstWins(
	baseRules: readonly Rule[],
	providedRules: readonly Rule[],
	disabledRuleNames: ReadonlySet<string>,
): RuleMergeResult {
	const rules: Rule[] = [];
	const warnings: string[] = [];
	const byName = new Map<string, Rule>();
	for (const rule of baseRules) {
		if (disabledRuleNames.has(rule.name)) continue;
		if (byName.has(rule.name)) continue;
		byName.set(rule.name, rule);
		rules.push(rule);
	}
	for (const rule of providedRules) {
		if (disabledRuleNames.has(rule.name)) continue;
		const existing = byName.get(rule.name);
		if (existing) {
			warnings.push(
				`Skillset-provided rule "${rule.name}" from ${ruleSourceLabel(rule)} skipped; existing rule from ${ruleSourceLabel(existing)} wins`,
			);
			continue;
		}
		byName.set(rule.name, rule);
		rules.push(rule);
	}
	return { rules, warnings };
}

export function startSkillsetSessionIntegration(
	input: SkillsetSessionIntegrationInput,
): SkillsetSessionIntegrationWork {
	const skillsetsEnabled = input.skillsetsSettings.enabled !== false && input.skillsetsSettings.mode !== "off";
	const projectFacetsPromise = skillsetsEnabled
		? input.withStartupDeadline(
				"detectProjectFacets",
				logger.time("detectProjectFacets", detectProjectFacets, { cwd: input.cwd }),
				[],
			)
		: Promise.resolve([]);
	projectFacetsPromise.catch(() => {});

	const skillsetDefinitionsPromise: Promise<SkillsetDefinitionLoadResult> = skillsetsEnabled
		? input.withStartupDeadline(
				"loadSkillsetDefinitions",
				logger.time("loadSkillsetDefinitions", loadSkillsetDefinitions, {
					...input.skillsetsSettings,
					cwd: input.cwd,
					disabledExtensions: input.disabledExtensionIds,
				}),
				{ definitions: [], warnings: [] },
			)
		: Promise.resolve({ definitions: [], warnings: [] });
	skillsetDefinitionsPromise.catch(() => {});

	const discoveredSkillsPromise = input.optionsSkills
		? undefined
		: logger.time("discoverSkills", loadSkills, {
				...input.skillsSettings,
				cwd: input.cwd,
				disabledExtensions: input.disabledExtensionIds,
				includeUserSources: input.settings.get("discovery.enableUserSources") === true,
			});
	discoveredSkillsPromise?.catch(() => {});

	return {
		async resolve(resolveInput): Promise<SkillsetSessionIntegrationResult> {
			const [discovered, facets, definitionResult] = await Promise.all([
				discoveredSkillsPromise ?? Promise.resolve({ skills: [], warnings: [] }),
				projectFacetsPromise,
				skillsetDefinitionsPromise,
			]);
			const activationPlan = await logger.time("compileSkillsetActivationPlan", compileSkillsetActivationPlan, {
				cwd: input.cwd,
				facets,
				definitions: definitionResult.definitions,
				settings: input.skillsetsSettings,
				baseSkills: input.optionsSkills ?? discovered.skills,
				baseWarnings: [
					...(input.optionsSkills === undefined ? discovered.warnings : []),
					...definitionResult.warnings.map(message => ({ skillPath: "skillsets", message })),
				],
				disabledExtensions: input.disabledExtensionIds,
				skillsSettings: input.skillsSettings,
				resolveSkills: input.optionsSkills === undefined,
			});

			const skillWarnings = activationPlan.skillWarnings;
			const ttsrSettings = input.settings.getGroup("ttsr");
			const ttsrManager = new TtsrManager(ttsrSettings);
			const disabledRuleNames = new Set<string>(ruleNamesFromDisabledExtensions(input.disabledExtensionIds));
			for (const raw of ttsrSettings.disabledRules ?? []) {
				const name = raw.trim();
				if (name.length > 0) disabledRuleNames.add(name);
			}
			const rulesResult = resolveInput.optionsRules
				? { items: resolveInput.optionsRules, warnings: [] as string[] }
				: await loadCapability<Rule>(ruleCapability.id, {
						cwd: input.cwd,
						disabledExtensions: input.disabledExtensionIds,
					});
			const mergeResult = resolveInput.optionsRules
				? { rules: rulesResult.items, warnings: [] }
				: mergeRulesFirstWins(rulesResult.items, activationPlan.providedRules, disabledRuleNames);
			const bucketed = bucketRules(mergeResult.rules, ttsrManager, {
				builtinRules: ttsrSettings.builtinRules,
				disabledRules: disabledRuleNames,
				forceRulebookNames: activationPlan.ruleNames,
				forceAlwaysApplyNames: activationPlan.alwaysApplyRuleNames,
			});
			for (const message of [...(rulesResult.warnings ?? []), ...mergeResult.warnings, ...bucketed.warnings]) {
				skillWarnings.push({ skillPath: "rules", message });
			}
			if (resolveInput.injectedTtsrRules.length > 0) {
				ttsrManager.restoreInjected([...resolveInput.injectedTtsrRules]);
			}

			return {
				skills: input.optionsSkills ?? activationPlan.skills,
				skillWarnings,
				activeSkillsets: activationPlan.activations,
				suggestedSkillsets: activationPlan.suggestions,
				ttsrManager,
				rulebookRules: bucketed.rulebookRules,
				alwaysApplyRules: bucketed.alwaysApplyRules,
			};
		},
	};
}
