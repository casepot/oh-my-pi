import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { scanRulesFromDir } from "@oh-my-pi/pi-coding-agent/discovery/helpers";

let tempDir: string;
let rulesDir: string;
let ctx: LoadContext;

function writeRule(name: string, content: string): void {
	fs.writeFileSync(path.join(rulesDir, name), content);
}

describe("scanRulesFromDir", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rule-dir-"));
		rulesDir = path.join(tempDir, "rules");
		fs.mkdirSync(rulesDir, { recursive: true });
		ctx = { cwd: tempDir, home: path.join(tempDir, "home"), repoRoot: null };
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("loads md and mdc rules with parser-compatible metadata", async () => {
		writeRule(
			"alpha.md",
			"---\ndescription: Alpha rule\nglobs: ['*.ts']\ncondition: forbidden\nscope: tool:edit(*.ts)\ninterruptMode: tool-only\n---\nAlpha body\n",
		);
		writeRule("beta.mdc", "---\ndescription: Beta rule\nalwaysApply: true\nttsr_trigger: legacy\n---\nBeta body\n");

		const result = await scanRulesFromDir(ctx, { dir: rulesDir, providerId: "skillset:test", level: "project" });

		expect(result.warnings ?? []).toEqual([]);
		expect(result.items.map(rule => rule.name)).toEqual(["alpha", "beta"]);
		expect(result.items[0]?.description).toBe("Alpha rule");
		expect(result.items[0]?.globs).toEqual(["*.ts"]);
		expect(result.items[0]?.condition).toEqual(["forbidden"]);
		expect(result.items[0]?.scope).toEqual(["tool:edit(*.ts)"]);
		expect(result.items[0]?.interruptMode).toBe("tool-only");
		expect(result.items[1]?.alwaysApply).toBe(true);
		expect(result.items[1]?.condition).toEqual(["legacy"]);
	});

	test("orders rules deterministically by case-insensitive name, exact name, then path", async () => {
		writeRule("b.md", "# B\n");
		writeRule("A.mdc", "# A uppercase\n");
		writeRule("a.md", "# a lowercase\n");

		const first = await scanRulesFromDir(ctx, { dir: rulesDir, providerId: "skillset:test", level: "project" });
		const second = await scanRulesFromDir(ctx, { dir: rulesDir, providerId: "skillset:test", level: "project" });

		expect(first.items.map(rule => rule.name)).toEqual(["A", "a", "b"]);
		expect(second.items.map(rule => rule.name)).toEqual(first.items.map(rule => rule.name));
	});

	test("missing directories emit warnings", async () => {
		const missing = path.join(tempDir, "missing");

		const result = await scanRulesFromDir(ctx, { dir: missing, providerId: "skillset:test", level: "project" });

		expect(result.items).toEqual([]);
		expect(result.warnings?.[0]).toContain("Failed to read rules directory");
		expect(result.warnings?.[0]).toContain(missing);
	});

	test("invalid regex metadata does not fail directory scanning", async () => {
		writeRule("bad.md", "---\ndescription: Bad regex\ncondition: '('\n---\nBody\n");

		const result = await scanRulesFromDir(ctx, { dir: rulesDir, providerId: "skillset:test", level: "project" });

		expect(result.warnings ?? []).toEqual([]);
		expect(result.items[0]?.name).toBe("bad");
		expect(result.items[0]?.condition).toEqual(["("]);
	});
});
