import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import { FORK_POLICY_DEFAULTS, FORK_REMOVED_SETTING_PATHS, FORK_REPO, UPSTREAM_REPO } from "../src/fork-policy";

const repoRoot = path.join(import.meta.dir, "../../..");
const schema = SETTINGS_SCHEMA as Record<string, { default?: unknown }>;

describe("fork policy invariants", () => {
	test("keeps ambient user/home and model-substitution behavior opt-in", () => {
		expect(schema["discovery.enableUserSources"]?.default).toBe(FORK_POLICY_DEFAULTS.discoveryEnableUserSources);
		expect(schema["mcp.enableUserConfig"]?.default).toBe(FORK_POLICY_DEFAULTS.mcpEnableUserConfig);
		expect(schema["compaction.allowModelFallbacks"]?.default).toBe(
			FORK_POLICY_DEFAULTS.compactionAllowModelFallbacks,
		);
		expect(schema["task.fallbackToParentModelOnAuthFailure"]?.default).toBe(
			FORK_POLICY_DEFAULTS.taskFallbackToParentModelOnAuthFailure,
		);
		expect(schema["skills.enableCodexUser"]?.default).toBe(FORK_POLICY_DEFAULTS.skillsEnableCodexUser);
		expect(schema["skills.enableClaudeUser"]?.default).toBe(FORK_POLICY_DEFAULTS.skillsEnableClaudeUser);
		expect(schema["skills.enableClaudeProject"]?.default).toBe(FORK_POLICY_DEFAULTS.skillsEnableClaudeProject);
		expect(schema["skills.enablePiUser"]?.default).toBe(FORK_POLICY_DEFAULTS.skillsEnablePiUser);
		expect(schema["skills.enablePiProject"]?.default).toBe(FORK_POLICY_DEFAULTS.skillsEnablePiProject);
		expect(schema["commands.enableClaudeUser"]?.default).toBe(FORK_POLICY_DEFAULTS.commandsEnableClaudeUser);
		expect(schema["commands.enableOpencodeUser"]?.default).toBe(FORK_POLICY_DEFAULTS.commandsEnableOpencodeUser);
	});

	test("keeps context promotion settings removed", () => {
		for (const settingPath of FORK_REMOVED_SETTING_PATHS) {
			expect(Object.hasOwn(schema, settingPath)).toBe(false);
		}
	});

	test("keeps package scope upstream-compatible", async () => {
		const packagePaths = [
			"package.json",
			"packages/agent/package.json",
			"packages/ai/package.json",
			"packages/coding-agent/package.json",
			"packages/hashline/package.json",
			"packages/mnemopi/package.json",
			"packages/natives/package.json",
			"packages/stats/package.json",
			"packages/swarm-extension/package.json",
			"packages/tui/package.json",
			"packages/utils/package.json",
			"packages/typescript-edit-benchmark/package.json",
		];

		for (const packagePath of packagePaths) {
			const pkg = (await Bun.file(path.join(repoRoot, packagePath)).json()) as { name?: string };
			if (packagePath === "package.json") {
				expect(pkg.name).toBe("omp-monorepo");
			} else {
				expect(pkg.name?.startsWith("@oh-my-pi/")).toBe(true);
			}
		}
	});

	test("keeps release publishing guarded to upstream owner", async () => {
		const workflow = await Bun.file(path.join(repoRoot, ".github/workflows/ci.yml")).text();
		const unguardedPublishCondition = "if: $" + "{{ !inputs.skip_npm }}";

		expect(workflow).toContain("github.repository_owner == 'can1357'");
		expect(workflow).not.toContain(unguardedPublishCondition);
		expect(FORK_REPO).toBe("casepot/oh-my-pi");
		expect(UPSTREAM_REPO).toBe("can1357/oh-my-pi");
	});
});
