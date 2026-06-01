import { registerProvider } from "../capability";
import type { Rule } from "../capability/rule";
import { type SkillsetDefinition, skillsetCapability } from "../capability/skillset";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { getBuiltinRuleSourcesForPack } from "./builtin-rules";
import { buildRuleFromMarkdown, createNativeSourceMeta } from "./helpers";

export const BUILTIN_SKILLSETS_PROVIDER_ID = "builtin-skillsets";
const DISPLAY_NAME = "Built-in Skillsets";
const PRIORITY = -100;

const RUST_ROOT_MARKERS = [
	"Cargo.toml",
	"Cargo.lock",
	"rust-toolchain",
	"rust-toolchain.toml",
	"rustfmt.toml",
	"clippy.toml",
] as const;

function builtinSource(path: string): SourceMeta {
	return createNativeSourceMeta(BUILTIN_SKILLSETS_PROVIDER_ID, path, DISPLAY_NAME);
}

function rustSkillsetDefinition(): SkillsetDefinition {
	const source = builtinSource("builtin://skillsets/rust");
	return {
		id: "rust",
		description: "Rust edit guardrails for async, error handling, APIs, and tests.",
		mode: "auto",
		priority: PRIORITY,
		match: {
			rootMarkers: [...RUST_ROOT_MARKERS],
		},
		provides: {
			promptSummary:
				"Rust project detected. Enabled Rust TTSR guardrails apply to generated .rs edits. Use configured Rust skills for deeper workflow guidance.",
		},
		source,
		_source: source,
	};
}

export function isBuiltinSkillsetDefinition(definition: SkillsetDefinition): boolean {
	return definition._source.level === "native" && definition._source.provider === BUILTIN_SKILLSETS_PROVIDER_ID;
}

export function getBuiltinSkillsetRules(skillsetId: string): Rule[] {
	if (skillsetId !== "rust") return [];
	return getBuiltinRuleSourcesForPack("skillset:rust").map(({ name, content }) => {
		const virtualPath = `builtin://skillsets/rust/rules/${name}.md`;
		const source = builtinSource(virtualPath);
		return buildRuleFromMarkdown(name, content, virtualPath, source, { ruleName: name });
	});
}

async function loadSkillsets(_ctx: LoadContext): Promise<LoadResult<SkillsetDefinition>> {
	return { items: [rustSkillsetDefinition()] };
}

registerProvider<SkillsetDefinition>(skillsetCapability.id, {
	id: BUILTIN_SKILLSETS_PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Project-gated skillsets shipped with the agent",
	priority: PRIORITY,
	load: loadSkillsets,
});
