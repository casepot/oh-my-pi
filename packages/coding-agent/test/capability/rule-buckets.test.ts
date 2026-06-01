import { describe, expect, it } from "bun:test";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { bucketRules } from "@oh-my-pi/pi-coding-agent/capability/rule-buckets";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";

function source(
	provider: string,
	level: Rule["_source"]["level"] = "user",
	rulePath = "/tmp/rule.md",
): Rule["_source"] {
	return { provider, providerName: provider, path: rulePath, level };
}

function makeRule(partial: Partial<Rule>): Rule {
	return {
		name: partial.name ?? "rule",
		path: partial.path ?? "/tmp/rule.md",
		content: partial.content ?? "body",
		globs: partial.globs,
		alwaysApply: partial.alwaysApply,
		description: partial.description,
		condition: partial.condition,
		scope: partial.scope,
		interruptMode: partial.interruptMode,
		_source: partial._source ?? source("test"),
	};
}

describe("bucketRules", () => {
	it("registers a condition rule as TTSR and excludes it from rulebook/always buckets", () => {
		const mgr = new TtsrManager();
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"], description: "blocks foo" });

		const { rulebookRules, alwaysApplyRules } = bucketRules([ttsr], mgr);

		expect(rulebookRules).toHaveLength(0);
		expect(alwaysApplyRules).toHaveLength(0);
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual(["no-foo"]);
	});

	it("splits non-TTSR rules into always-apply and rulebook by metadata", () => {
		const mgr = new TtsrManager();
		const sticky = makeRule({ name: "sticky", alwaysApply: true, description: "sticky desc" });
		const book = makeRule({ name: "book", description: "rulebook desc" });
		const orphan = makeRule({ name: "orphan" });

		const { rulebookRules, alwaysApplyRules } = bucketRules([sticky, book, orphan], mgr);

		expect(alwaysApplyRules.map(r => r.name)).toEqual(["sticky"]);
		expect(rulebookRules.map(r => r.name)).toEqual(["book"]);
		expect(mgr.hasRules()).toBe(false);
	});

	it("disabledRules drops a rule from every bucket and from TTSR registration", () => {
		const mgr = new TtsrManager();
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"], description: "blocks foo" });
		const book = makeRule({ name: "book", description: "rulebook desc" });

		const { rulebookRules } = bucketRules([ttsr, book], mgr, { disabledRules: ["no-foo", "book"] });

		expect(rulebookRules).toHaveLength(0);
		expect(mgr.hasRules()).toBe(false);
		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" })).toHaveLength(0);
	});

	it("disabledRules trims entries and ignores blanks", () => {
		const mgr = new TtsrManager();
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"] });

		bucketRules([ttsr], mgr, { disabledRules: ["  no-foo  ", "", "   "] });

		expect(mgr.hasRules()).toBe(false);
	});

	it("builtinRules:false drops native builtin rules but keeps user/project rules", () => {
		const mgr = new TtsrManager();
		const builtin = makeRule({
			name: "builtin-foo",
			condition: ["FORBIDDEN"],
			_source: source("builtin-defaults", "native", "builtin://rules/builtin-foo.md"),
		});
		const userRule = makeRule({ name: "user-foo", condition: ["BANNED"], _source: source("user", "user") });

		bucketRules([builtin, userRule], mgr, { builtinRules: false });

		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" })).toHaveLength(0);
		mgr.resetBuffer();
		expect(mgr.checkDelta("contains BANNED token", { source: "text" }).map(r => r.name)).toEqual(["user-foo"]);
	});

	it("includes native builtin rules when builtinRules is unset (default on)", () => {
		const mgr = new TtsrManager();
		const builtin = makeRule({
			name: "builtin-foo",
			condition: ["FORBIDDEN"],
			_source: source("builtin-defaults", "native", "builtin://rules/builtin-foo.md"),
		});

		bucketRules([builtin], mgr);

		expect(mgr.checkDelta("contains FORBIDDEN token", { source: "text" }).map(r => r.name)).toEqual(["builtin-foo"]);
	});

	it("ttsr.enabled=false suppresses unforced condition rules without rulebook fallback", () => {
		const mgr = new TtsrManager({ enabled: false });
		const ttsr = makeRule({ name: "no-foo", condition: ["FORBIDDEN"], description: "blocks foo" });

		const { rulebookRules, alwaysApplyRules } = bucketRules([ttsr], mgr);

		expect(rulebookRules).toEqual([]);
		expect(alwaysApplyRules).toEqual([]);
		expect(mgr.hasRules()).toBe(false);
	});

	it("force names place condition rules even when TTSR is disabled", () => {
		const mgr = new TtsrManager({ enabled: false });
		const toBook = makeRule({ name: "book", condition: ["BOOK"], description: "book" });
		const toAlways = makeRule({ name: "always", condition: ["ALWAYS"], description: "always" });

		const { rulebookRules, alwaysApplyRules } = bucketRules([toBook, toAlways], mgr, {
			forceRulebookNames: ["book"],
			forceAlwaysApplyNames: ["always"],
		});

		expect(rulebookRules.map(rule => rule.name)).toEqual(["book"]);
		expect(alwaysApplyRules.map(rule => rule.name)).toEqual(["always"]);
		expect(mgr.hasRules()).toBe(false);
	});

	it("disabled names win over force lists", () => {
		const mgr = new TtsrManager();
		const rule = makeRule({ name: "blocked", condition: ["BLOCKED"], description: "blocked" });

		const { rulebookRules, alwaysApplyRules } = bucketRules([rule], mgr, {
			disabledRules: ["blocked"],
			forceRulebookNames: ["blocked"],
			forceAlwaysApplyNames: ["blocked"],
		});

		expect(rulebookRules).toEqual([]);
		expect(alwaysApplyRules).toEqual([]);
		expect(mgr.hasRules()).toBe(false);
	});

	it("keeps the first duplicate rule name and warns about later duplicates", () => {
		const mgr = new TtsrManager();
		const first = makeRule({
			name: "dupe",
			description: "first",
			path: "/tmp/first.md",
			_source: source("one", "project", "/tmp/first.md"),
		});
		const second = makeRule({
			name: "dupe",
			description: "second",
			path: "/tmp/second.md",
			_source: source("two", "project", "/tmp/second.md"),
		});

		const { rulebookRules, warnings } = bucketRules([first, second], mgr);

		expect(rulebookRules.map(rule => rule.content)).toEqual(["body"]);
		expect(rulebookRules[0]).toBe(first);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('Duplicate rule "dupe"');
	});
});
