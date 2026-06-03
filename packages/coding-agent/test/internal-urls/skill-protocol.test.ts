import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetActiveSkillsForTests, type Skill, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";

async function createSkill(root: string, name: string, content: string): Promise<Skill> {
	const baseDir = path.join(root, name);
	const filePath = path.join(baseDir, "SKILL.md");
	await Bun.write(filePath, content);
	return {
		name,
		description: `${name} skill`,
		filePath,
		baseDir,
		source: filePath,
	};
}

describe("skill:// protocol", () => {
	let tempDir: string | undefined;

	afterEach(async () => {
		resetActiveSkillsForTests();
		InternalUrlRouter.resetForTests();
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("resolves against caller skills before stale process-global skills", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-url-context-"));
		const globalSkill = await createSkill(path.join(tempDir, "global"), "review", "global content\n");
		const sessionSkill = await createSkill(path.join(tempDir, "session"), "review", "session content\n");
		setActiveSkills([globalSkill]);

		const resource = await InternalUrlRouter.instance().resolve("skill://review", {
			skills: [sessionSkill],
		});

		expect(resource.content).toBe("session content\n");
		expect(resource.sourcePath).toBe(sessionSkill.filePath);
	});

	it("reports available caller skills when a session-scoped skill is missing", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-url-missing-"));
		const globalSkill = await createSkill(path.join(tempDir, "global"), "global-only", "global content\n");
		const sessionSkill = await createSkill(path.join(tempDir, "session"), "session-only", "session content\n");
		setActiveSkills([globalSkill]);

		await expect(
			InternalUrlRouter.instance().resolve("skill://missing", {
				skills: [sessionSkill],
			}),
		).rejects.toThrow("Available: session-only");
	});
});
