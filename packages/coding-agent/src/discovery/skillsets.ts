import * as path from "node:path";
import { getPluginsDir, isRecord, pathIsWithin } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { isProviderEnabled, registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type ProjectMatcher, type SkillsetDefinition, skillsetCapability } from "../capability/skillset";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { getProjectAncestorDirs } from "../project-detection";
import { type ClaudePluginRoot, createSourceMeta, expandEnvVarsDeep, listClaudePluginRoots } from "./helpers";

const PROVIDER_ID = "native";
const DISPLAY_NAME = "OMP";
const DESCRIPTION = "Native OMP skillset configs from ~/.omp and .omp/";
const PRIORITY = 100;

const FILENAMES = [
	"skillsets.json",
	".skillsets.json",
	"skillsets.yaml",
	".skillsets.yaml",
	"skillsets.yml",
	".skillsets.yml",
] as const;

function parseSkillsetContent(content: string, filePath: string): unknown {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml") {
		return YAML.parse(content) as unknown;
	}
	return JSON.parse(content) as unknown;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return items.length > 0 ? items : undefined;
}

function normalizeDependencyFiles(value: unknown): Array<{ path: string; contains?: string[] }> | undefined {
	if (!Array.isArray(value)) return undefined;
	const result: Array<{ path: string; contains?: string[] }> = [];
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.path !== "string" || entry.path.length === 0) continue;
		const contains = stringArray(entry.contains);
		result.push({ path: entry.path, ...(contains ? { contains } : {}) });
	}
	return result.length > 0 ? result : undefined;
}

function normalizeMatcher(value: unknown): ProjectMatcher | null {
	if (!isRecord(value)) return null;
	const matcher: ProjectMatcher = {};
	const facets = stringArray(value.facets);
	const rootMarkers = stringArray(value.rootMarkers);
	const fileGlobs = stringArray(value.fileGlobs);
	const dependencyFiles = normalizeDependencyFiles(value.dependencyFiles);
	const binaries = stringArray(value.binaries);
	if (facets) matcher.facets = facets;
	if (rootMarkers) matcher.rootMarkers = rootMarkers;
	if (fileGlobs) matcher.fileGlobs = fileGlobs;
	if (dependencyFiles) matcher.dependencyFiles = dependencyFiles;
	if (binaries) matcher.binaries = binaries;
	for (const key of ["all", "any", "not"] as const) {
		const raw = value[key];
		if (!Array.isArray(raw)) continue;
		const nested = raw.map(normalizeMatcher).filter((entry): entry is ProjectMatcher => entry !== null);
		if (nested.length > 0) matcher[key] = nested;
	}
	return Object.keys(matcher).length > 0 ? matcher : null;
}

function normalizeProvides(value: unknown): SkillsetDefinition["provides"] | null {
	if (!isRecord(value)) return null;
	const provides: SkillsetDefinition["provides"] = {};
	const skills = stringArray(value.skills);
	const skillDirectories = stringArray(value.skillDirectories);
	const rules = stringArray(value.rules);
	const ruleDirectories = stringArray(value.ruleDirectories);
	const alwaysApplyRules = stringArray(value.alwaysApplyRules);
	const toolHints = stringArray(value.toolHints);
	if (skills) provides.skills = skills;
	if (skillDirectories) provides.skillDirectories = skillDirectories;
	if (rules) provides.rules = rules;
	if (ruleDirectories) provides.ruleDirectories = ruleDirectories;
	if (alwaysApplyRules) provides.alwaysApplyRules = alwaysApplyRules;
	if (typeof value.promptSummary === "string" && value.promptSummary.trim().length > 0) {
		provides.promptSummary = value.promptSummary.trim();
	}
	if (toolHints) provides.toolHints = toolHints;
	return Object.keys(provides).length > 0 ? provides : null;
}

function normalizeMode(value: unknown): SkillsetDefinition["mode"] | undefined {
	return value === "auto" || value === "suggest" || value === "manual" ? value : undefined;
}

function normalizePriority(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getDefinitionEntries(value: unknown): Array<{ id: string | undefined; value: unknown }> {
	const root = isRecord(value) && value.skillsets !== undefined ? value.skillsets : value;
	if (Array.isArray(root)) {
		return root.map(entry => ({
			id: isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined,
			value: entry,
		}));
	}
	if (isRecord(root)) {
		return Object.entries(root).map(([id, entry]) => ({ id, value: entry }));
	}
	return [];
}

export function normalizeSkillsetDefinitions(
	value: unknown,
	filePath: string,
	source: SourceMeta,
): LoadResult<SkillsetDefinition> {
	const items: SkillsetDefinition[] = [];
	const warnings: string[] = [];
	const expanded = expandEnvVarsDeep(value);
	for (const entry of getDefinitionEntries(expanded)) {
		if (!isRecord(entry.value)) {
			warnings.push(`Invalid skillset definition in ${filePath}: expected object`);
			continue;
		}
		const id = typeof entry.value.id === "string" && entry.value.id.length > 0 ? entry.value.id : entry.id;
		const description = typeof entry.value.description === "string" ? entry.value.description.trim() : "";
		const match = normalizeMatcher(entry.value.match);
		const provides = normalizeProvides(entry.value.provides);
		if (!id || !description || !match || !provides) {
			warnings.push(
				`Invalid skillset definition in ${filePath}: ${id ?? "<unknown>"} missing id, description, match, or provides`,
			);
			continue;
		}
		const mode = normalizeMode(entry.value.mode);
		const priority = normalizePriority(entry.value.priority);
		items.push({
			id,
			description,
			match,
			provides,
			...(mode ? { mode } : {}),
			...(priority !== undefined ? { priority } : {}),
			source,
			_source: source,
		});
	}
	items.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id));
	return { items, warnings };
}

export async function loadSkillsetDefinitionFile(
	filePath: string,
	providerId: string,
	level: "user" | "project",
): Promise<LoadResult<SkillsetDefinition>> {
	const content = await readFile(filePath);
	if (!content) return { items: [], warnings: [] };
	const source = createSourceMeta(providerId, filePath, level);
	try {
		const parsed = parseSkillsetContent(content, filePath);
		return normalizeSkillsetDefinitions(parsed, filePath, source);
	} catch (error) {
		return { items: [], warnings: [`Failed to parse skillset config ${filePath}: ${String(error)}`] };
	}
}

export async function loadSkillsetDefinitionDirectory(
	dir: string,
	providerId: string,
	level: "user" | "project",
): Promise<LoadResult<SkillsetDefinition>> {
	const results = await Promise.all(
		FILENAMES.map(filename => loadSkillsetDefinitionFile(path.join(dir, filename), providerId, level)),
	);
	return {
		items: results.flatMap(result => result.items),
		warnings: results.flatMap(result => result.warnings ?? []),
	};
}

async function loadFromPaths(
	paths: Array<{ filePath: string; level: "user" | "project"; providerId?: string }>,
): Promise<LoadResult<SkillsetDefinition>> {
	const results = await Promise.all(
		paths.map(entry => loadSkillsetDefinitionFile(entry.filePath, entry.providerId ?? PROVIDER_ID, entry.level)),
	);
	return {
		items: results.flatMap(result => result.items),
		warnings: results.flatMap(result => result.warnings ?? []),
	};
}

function projectConfigFilePaths(ctx: LoadContext): Array<{ filePath: string; level: "project" }> {
	const paths: Array<{ filePath: string; level: "project" }> = [];
	for (const dir of getProjectAncestorDirs(ctx.cwd, ctx.repoRoot ?? ctx.cwd)) {
		for (const filename of FILENAMES) {
			paths.push({ filePath: path.join(dir, filename), level: "project" });
			paths.push({ filePath: path.join(dir, ".omp", filename), level: "project" });
		}
	}
	return paths;
}

function userConfigFilePaths(ctx: LoadContext): Array<{ filePath: string; level: "user" }> {
	return FILENAMES.map(filename => ({ filePath: path.join(ctx.home, ".omp", "agent", filename), level: "user" }));
}

function pluginConfigFilePaths(
	pluginRoots: readonly ClaudePluginRoot[],
): Array<{ filePath: string; level: "user" | "project"; providerId: string }> {
	const paths: Array<{ filePath: string; level: "user" | "project"; providerId: string }> = [];
	for (const root of pluginRoots) {
		for (const filename of FILENAMES) {
			paths.push({ filePath: path.join(root.path, filename), level: root.scope, providerId: `plugin:${root.id}` });
		}
	}
	return paths;
}

async function readMarketplaceSkillsetConfig(root: ClaudePluginRoot): Promise<LoadResult<SkillsetDefinition>> {
	const catalogPaths = [
		path.join(getPluginsDir(), "cache", "marketplaces", root.marketplace, "marketplace.json"),
		path.resolve(root.path, "..", "..", "marketplace.json"),
		path.resolve(root.path, "..", "..", ".claude-plugin", "marketplace.json"),
	];
	for (const catalogPath of catalogPaths) {
		const content = await readFile(catalogPath);
		if (!content) continue;
		try {
			const catalog = JSON.parse(content) as unknown;
			if (!isRecord(catalog) || !Array.isArray(catalog.plugins)) continue;
			for (const plugin of catalog.plugins) {
				if (!isRecord(plugin) || plugin.name !== root.plugin) continue;
				if (typeof plugin.skillsets === "string") {
					const configPath = path.resolve(root.path, plugin.skillsets);
					if (!pathIsWithin(root.path, configPath)) return { items: [], warnings: [] };
					return loadSkillsetDefinitionFile(configPath, `plugin:${root.id}`, root.scope);
				}
				if (isRecord(plugin.skillsets) || Array.isArray(plugin.skillsets)) {
					const source = createSourceMeta(`plugin:${root.id}`, catalogPath, root.scope);
					return normalizeSkillsetDefinitions({ skillsets: plugin.skillsets }, catalogPath, source);
				}
				return { items: [], warnings: [] };
			}
		} catch (error) {
			return { items: [], warnings: [`Failed to parse marketplace skillsets ${catalogPath}: ${String(error)}`] };
		}
	}
	return { items: [], warnings: [] };
}

async function loadSkillsets(ctx: LoadContext): Promise<LoadResult<SkillsetDefinition>> {
	const pluginRootsResult: { roots: ClaudePluginRoot[]; warnings: string[] } = isProviderEnabled("claude-plugins")
		? await listClaudePluginRoots(ctx.home, ctx.cwd)
		: { roots: [], warnings: [] };
	const pathResult = await loadFromPaths([
		...projectConfigFilePaths(ctx),
		...userConfigFilePaths(ctx),
		...pluginConfigFilePaths(pluginRootsResult.roots),
	]);
	const marketplaceResults = await Promise.all(pluginRootsResult.roots.map(readMarketplaceSkillsetConfig));
	return {
		items: [...pathResult.items, ...marketplaceResults.flatMap(result => result.items)],
		warnings: [
			...(pathResult.warnings ?? []),
			...pluginRootsResult.warnings,
			...marketplaceResults.flatMap(result => result.warnings ?? []),
		],
	};
}

registerProvider<SkillsetDefinition>(skillsetCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSkillsets,
});
