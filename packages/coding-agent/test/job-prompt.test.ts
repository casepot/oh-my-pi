import { describe, expect, it } from "bun:test";
import jobDescriptionTemplate from "../src/prompts/tools/job.md" with { type: "text" };

describe("job tool description", () => {
	it("states jobs are process-local and not restored", () => {
		expect(jobDescriptionTemplate).toMatch(/process-local scheduling records/i);
		expect(jobDescriptionTemplate).toMatch(/not restored after a restart or resume/i);
		expect(jobDescriptionTemplate).toContain("history://<id>");
	});
});
