/**
 * Rule bucketing
 *
 * Single funnel that every discovered or skillset-provided rule passes through
 * on its way into a session. It applies disable levers, registers TTSR rules,
 * and splits survivors into always-apply and rulebook buckets.
 *
 * Bucket precedence:
 *   1. disabled exact name / disabled builtin pack
 *   2. duplicate name (first wins)
 *   3. forced always-apply
 *   4. forced rulebook
 *   5. TTSR
 *   6. alwaysApply
 *   7. described rulebook rule
 */
import type { TtsrManager } from "../export/ttsr";
import { isBuiltinRule as defaultIsBuiltinRule, type Rule } from "./rule";

export interface RuleBuckets {
	rulebookRules: Rule[];
	alwaysApplyRules: Rule[];
	warnings: string[];
}

export interface BucketRulesOptions {
	/** Rule names to drop entirely (bundled defaults and user rules alike). */
	disabledRules?: Iterable<string>;
	/** When false, drop every embedded/native builtin rule. */
	builtinRules?: boolean;
	/** Rule names forced into the rulebook bucket before TTSR registration. */
	forceRulebookNames?: Iterable<string>;
	/** Rule names forced into the always-apply bucket before TTSR registration. */
	forceAlwaysApplyNames?: Iterable<string>;
	/** Test seam / future native-source predicate. Defaults to source level `native`. */
	isBuiltinRule?: (rule: Rule) => boolean;
}

export function ruleNamesFromDisabledExtensions(disabledExtensions: readonly string[] | undefined): string[] {
	const names: string[] = [];
	for (const id of disabledExtensions ?? []) {
		if (!id.startsWith("rule:")) continue;
		const name = id.slice(5).trim();
		if (name.length > 0) names.push(name);
	}
	return names;
}

function normalizedNameSet(values: Iterable<string> | undefined): Set<string> {
	const result = new Set<string>();
	for (const raw of values ?? []) {
		const name = raw.trim();
		if (name.length > 0) result.add(name);
	}
	return result;
}

function sourceLabel(rule: Rule): string {
	const provider = rule._source.providerName || rule._source.provider;
	return `${provider}:${rule._source.path}`;
}

/**
 * Filter and bucket rules, registering TTSR rules on `ttsrManager` as a side
 * effect. Disabled rules are dropped before any bucket assignment, so a
 * disabled rule is neither matched as TTSR nor surfaced via `rule://`.
 */
export function bucketRules(
	rules: readonly Rule[],
	ttsrManager: TtsrManager,
	options: BucketRulesOptions = {},
): RuleBuckets {
	const includeBuiltin = options.builtinRules !== false;
	const isBuiltinRule = options.isBuiltinRule ?? defaultIsBuiltinRule;
	const disabled = normalizedNameSet(options.disabledRules);
	const forceRulebook = normalizedNameSet(options.forceRulebookNames);
	const forceAlwaysApply = normalizedNameSet(options.forceAlwaysApplyNames);
	const ttsrEnabled = ttsrManager.getSettings().enabled !== false;

	const rulebookRules: Rule[] = [];
	const alwaysApplyRules: Rule[] = [];
	const warnings: string[] = [];
	const seenRules = new Map<string, Rule>();

	for (const rule of rules) {
		if (disabled.has(rule.name)) continue;
		if (!includeBuiltin && isBuiltinRule(rule)) continue;

		const existing = seenRules.get(rule.name);
		if (existing) {
			warnings.push(
				`Duplicate rule "${rule.name}" from ${sourceLabel(rule)} skipped; first definition from ${sourceLabel(existing)} wins`,
			);
			continue;
		}
		seenRules.set(rule.name, rule);

		if (forceAlwaysApply.has(rule.name)) {
			alwaysApplyRules.push(rule);
			continue;
		}
		if (forceRulebook.has(rule.name)) {
			rulebookRules.push(rule);
			continue;
		}

		if (rule.condition && rule.condition.length > 0) {
			if (!ttsrEnabled) {
				continue;
			}
			if (ttsrManager.addRule(rule)) {
				continue;
			}
		}

		if (rule.alwaysApply === true) {
			alwaysApplyRules.push(rule);
			continue;
		}
		if (rule.description) {
			rulebookRules.push(rule);
		}
	}

	return { rulebookRules, alwaysApplyRules, warnings };
}
