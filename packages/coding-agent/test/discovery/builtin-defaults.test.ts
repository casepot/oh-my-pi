/**
 * The bundled `builtin-defaults` rule provider ships global embedded rules.
 * Project-gated packs such as Rust live behind built-in skillsets instead.
 */
import { describe, expect, it } from "bun:test";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { TtsrManager, type TtsrMatchContext } from "@oh-my-pi/pi-coding-agent/export/ttsr";
// Register all discovery providers as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";

const EXPECTED_RULE_NAMES = [
	"ts-bare-catch",
	"ts-import-type",
	"ts-no-any",
	"ts-no-deprecated-leftovers",
	"ts-no-dynamic-import",
	"ts-no-inline-cast-access",
	"ts-no-return-type",
	"ts-no-test-timers",
	"ts-no-tiny-functions",
	"ts-promise-with-resolvers",
	"ts-redundant-clear-guard",
	"ts-set-map",
].sort();

function ruleProvider() {
	const cap = getCapability(ruleCapability.id);
	if (!cap) throw new Error("rules capability missing");
	const provider = cap.providers.find(p => p.id === BUILTIN_DEFAULTS_PROVIDER_ID);
	if (!provider) throw new Error("builtin-defaults provider missing");
	return { cap, provider };
}

async function loadBuiltinRules(): Promise<Rule[]> {
	const { provider } = ruleProvider();
	const ctx: LoadContext = { cwd: "/tmp", home: "/tmp/home", repoRoot: null };
	const result = await (provider.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
	return result.items;
}

describe("builtin-defaults rule provider", () => {
	it("loads exactly the global bundled default rule set as native rules", async () => {
		const rules = await loadBuiltinRules();
		expect(rules.length).toBeGreaterThan(0);
		expect(rules.every(r => r._source.provider === BUILTIN_DEFAULTS_PROVIDER_ID)).toBe(true);
		expect(rules.every(r => r._source.level === "native")).toBe(true);
		expect(rules.every(r => r._source.path.startsWith("builtin://rules/"))).toBe(true);
		const names = rules.map(r => r.name).sort();
		expect(names).toEqual(EXPECTED_RULE_NAMES);
		expect(new Set(names).size).toBe(names.length);
	});

	it("parses every global bundled rule as a valid TTSR rule", async () => {
		const rules = await loadBuiltinRules();
		for (const rule of rules) {
			const conditionCount = (rule.condition?.length ?? 0) + (rule.astCondition?.length ?? 0);
			expect(conditionCount, `${rule.name} condition/astCondition`).toBeGreaterThan(0);
			expect(rule.scope?.length, `${rule.name} scope`).toBeGreaterThan(0);
			expect(new TtsrManager({ enabled: true }).addRule(rule), `${rule.name} registers`).toBe(true);
		}
	});

	it("bundles ast-grep conditions for the redundant-clear-guard rule", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-redundant-clear-guard");
		expect(rule?.condition).toBeUndefined();
		expect(rule?.astCondition?.length).toBeGreaterThan(0);
	});

	it("preserves a per-rule interruptMode override from frontmatter", async () => {
		const rules = await loadBuiltinRules();
		expect(rules.find(r => r.name === "ts-set-map")?.interruptMode).toBe("never");
	});

	it("fires the no-test-timers rule on real timers in *.test.ts but not plain *.ts", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-test-timers");
		if (!rule) throw new Error("ts-no-test-timers rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		for (const snippet of ["await Bun.sleep(10)", "setTimeout(fn, 0)", "setInterval(fn, 5)"]) {
			manager.resetBuffer();
			const matches = manager.checkDelta(snippet, {
				source: "tool",
				toolName: "write",
				filePaths: ["packages/x/test/foo.test.ts"],
			});
			expect(
				matches.map(r => r.name),
				snippet,
			).toEqual(["ts-no-test-timers"]);
		}

		// Same content in a non-test file is out of scope.
		manager.resetBuffer();
		expect(
			manager.checkDelta("await Bun.sleep(10)", {
				source: "tool",
				toolName: "write",
				filePaths: ["packages/x/src/foo.ts"],
			}),
		).toEqual([]);
	});

	it("fires ts-no-inline-cast-access on inline cast-and-access but not named-type casts", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-inline-cast-access");
		if (!rule) throw new Error("ts-no-inline-cast-access rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		// AST conditions only run on edit/write streams, with the language inferred from the path.
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["src/foo.ts"] };

		// Inline object-type assertion immediately read — every access form is flagged.
		const violations = [
			"const a = (value as { content: unknown }).content;",
			"const b = (value as { content: unknown })?.content;",
			'const c = (opts as { enabled: boolean })["enabled"];',
			"const d = (value as unknown as { content: unknown }).content;",
		];
		for (const snippet of violations) {
			manager.resetBuffer();
			const matches = await manager.checkAstSnapshot(snippet, ctx);
			expect(
				matches.map(r => r.name),
				snippet,
			).toEqual(["ts-no-inline-cast-access"]);
		}

		// A cast to a named type, plain member access, and a bare cast (no read) are all left alone.
		const allowed = [
			"const e = (value as Foo).bar;",
			"const f = obj.content;",
			"const g = value as { content: unknown };",
		];
		for (const snippet of allowed) {
			manager.resetBuffer();
			const matches = await manager.checkAstSnapshot(snippet, ctx);
			expect(matches, snippet).toEqual([]);
		}

		// Out of scope: the same violation in a non-TS file never reaches the matcher.
		manager.resetBuffer();
		expect(
			await manager.checkAstSnapshot("const h = (value as { content: unknown }).content;", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/foo.js"],
			}),
		).toEqual([]);
	});

	it("is the lowest-priority rule provider so user/project rules override defaults", () => {
		const { cap, provider } = ruleProvider();
		const others = cap.providers.filter(p => p.id !== BUILTIN_DEFAULTS_PROVIDER_ID);
		expect(others.length).toBeGreaterThan(0);
		expect(others.every(p => p.priority > provider.priority)).toBe(true);
	});
});
