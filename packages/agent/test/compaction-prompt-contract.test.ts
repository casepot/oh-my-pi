import { describe, expect, it } from "bun:test";

function promptFile(name: string): Bun.BunFile {
	return Bun.file(new URL(`../src/compaction/prompts/${name}`, import.meta.url));
}

describe("compaction prompt operational contract", () => {
	it("keeps upstream resume-oriented headings in summary prompts", async () => {
		const summary = await promptFile("compaction-summary.md").text();
		const update = await promptFile("compaction-update-summary.md").text();

		for (const text of [summary, update]) {
			expect(text).toContain("## Goal");
			expect(text).toContain("## Constraints & Preferences");
			expect(text).toContain("## Progress");
			expect(text).toContain("### Done");
			expect(text).toContain("### In Progress");
			expect(text).toContain("### Blocked");
			expect(text).toContain("## Key Decisions");
			expect(text).toContain("## Next Steps");
			expect(text).toContain("## Critical Context");
			expect(text).toContain("## Additional Notes");
		}
	});

	it("keeps upstream preservation and resume instructions", async () => {
		const summary = await promptFile("compaction-summary.md").text();
		const update = await promptFile("compaction-update-summary.md").text();

		expect(summary).toContain("If the conversation ends with an unanswered question");
		expect(summary).toContain("preserve exact file paths, function names, error messages");
		expect(update).toContain("MUST preserve all information from the previous summary");
		expect(update).toContain("MUST add new progress, decisions, and context from new messages");
	});
});
