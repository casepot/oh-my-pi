import { describe, expect, it } from "bun:test";

function promptFile(name: string): Bun.BunFile {
	return Bun.file(new URL(`../src/compaction/prompts/${name}`, import.meta.url));
}

describe("compaction prompt operational contract", () => {
	it("keeps resume-oriented headings in summary prompts", async () => {
		const summary = await promptFile("compaction-summary.md").text();
		const update = await promptFile("compaction-update-summary.md").text();

		for (const text of [summary, update]) {
			expect(text).toContain("Active Objective");
			expect(text).toContain("Current State");
			expect(text).toContain("Working Set");
			expect(text).toContain("Verification State");
			expect(text).toContain("Next Action");
			expect(text).not.toContain("### Done");
			expect(text).not.toContain("## Additional Notes");
			expect(text).not.toContain("MUST preserve all information");
		}
	});

	it("keeps anti-bloat and uncertainty instructions", async () => {
		const summary = await promptFile("compaction-summary.md").text();
		const update = await promptFile("compaction-update-summary.md").text();

		expect(summary).toContain(
			"Operationally relevant means needed to choose, edit, verify, or explain the next step.",
		);
		expect(summary).toContain("NEVER present inferred or unverified work as completed.");
		expect(update).toContain(
			"Preserve only still-operational facts. Delete resolved Done items, stale investigations, superseded plans, read-only inventories, repeated tool logs, and historical ceremony.",
		);
		expect(update).toContain("New messages override stale <previous-summary> claims.");
	});
});
