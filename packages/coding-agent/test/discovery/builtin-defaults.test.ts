/**
 * The bundled `builtin-defaults` rule provider ships global embedded rules.
 * Project-gated packs such as Rust live behind built-in skillsets instead.
 */
import { describe, expect, it } from "bun:test";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
// Register all discovery providers as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";

const EXPECTED_RULE_NAMES = [
	"ts-bare-catch",
	"ts-import-type",
	"ts-no-any",
	"ts-no-dynamic-import",
	"ts-no-return-type",
	"ts-no-tiny-functions",
	"ts-promise-with-resolvers",
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
		const names = rules.map(r => r.name).sort();
		expect(names).toEqual(EXPECTED_RULE_NAMES);
		expect(rules.every(r => r._source.provider === BUILTIN_DEFAULTS_PROVIDER_ID)).toBe(true);
		expect(rules.every(r => r._source.level === "native")).toBe(true);
		expect(rules.every(r => r._source.path.startsWith("builtin://rules/"))).toBe(true);
	});

	it("parses every global bundled rule as a valid TTSR rule", async () => {
		const rules = await loadBuiltinRules();
		for (const rule of rules) {
			expect(rule.condition?.length, `${rule.name} condition`).toBeGreaterThan(0);
			expect(rule.scope?.length, `${rule.name} scope`).toBeGreaterThan(0);
			expect(new TtsrManager({ enabled: true }).addRule(rule), `${rule.name} registers`).toBe(true);
		}
	});

	it("preserves a per-rule interruptMode override from frontmatter", async () => {
		const rules = await loadBuiltinRules();
		expect(rules.find(r => r.name === "ts-set-map")?.interruptMode).toBe("never");
	});

	it("is the lowest-priority rule provider so user/project rules override defaults", () => {
		const { cap, provider } = ruleProvider();
		const others = cap.providers.filter(p => p.id !== BUILTIN_DEFAULTS_PROVIDER_ID);
		expect(others.length).toBeGreaterThan(0);
		expect(others.every(p => p.priority > provider.priority)).toBe(true);
	});
});
