import type * as fs from "node:fs";
import * as path from "node:path";
import { FileType, glob } from "@oh-my-pi/pi-natives";
import { findRepoRoot, readDirEntries } from "../capability/fs";
import { DEFAULT_PROJECT_DETECTORS } from "./defaults";
import type {
	DetectProjectFacetsOptions,
	ProjectDetectorDefinition,
	ProjectFacet,
	ProjectFacetEvidence,
} from "./types";

const DEFAULT_CACHE = new Map<string, ProjectFacet[]>();

function normalizeDir(dir: string): string {
	return path.resolve(dir);
}

export function getProjectAncestorDirs(cwd: string, stopAt?: string | null): string[] {
	const ancestors: string[] = [];
	let current = normalizeDir(cwd);
	const resolvedStop = stopAt ? normalizeDir(stopAt) : null;
	while (true) {
		ancestors.push(current);
		if (resolvedStop && current === resolvedStop) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return ancestors;
}

function markerPath(root: string, marker: string): string {
	return path.resolve(root, marker);
}

function isSafeRootRelative(root: string, value: string): boolean {
	if (path.isAbsolute(value)) return false;
	const resolved = path.resolve(root, value);
	const relative = path.relative(root, resolved);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function detectRootMarkerEvidence(
	root: string,
	markers: readonly string[] | undefined,
): Promise<ProjectFacetEvidence[]> {
	if (!markers || markers.length === 0) return [];
	const evidence: ProjectFacetEvidence[] = [];
	let entries: fs.Dirent[] | null = null;
	for (const marker of markers) {
		if (!marker) continue;
		if (!isSafeRootRelative(root, marker)) continue;
		if (marker.includes("*")) {
			entries ??= await readDirEntries(root);
			const markerGlob = new Bun.Glob(marker);
			const matched = entries.find(entry => markerGlob.match(entry.name));
			if (matched) {
				evidence.push({ kind: "rootMarker", path: path.join(root, matched.name), value: marker });
			}
			continue;
		}

		if (marker.includes("/") || marker.includes("\\")) {
			const nestedPath = markerPath(root, marker);
			if (await Bun.file(nestedPath).exists()) {
				evidence.push({ kind: "rootMarker", path: nestedPath, value: marker });
			}
			continue;
		}

		entries ??= await readDirEntries(root);
		if (entries.some(entry => entry.name === marker)) {
			evidence.push({ kind: "rootMarker", path: markerPath(root, marker), value: marker });
		}
	}
	return evidence;
}

export async function detectFileGlobEvidence(
	root: string,
	patterns: readonly string[] | undefined,
): Promise<ProjectFacetEvidence[]> {
	if (!patterns || patterns.length === 0) return [];
	for (const pattern of patterns) {
		if (!pattern || !isSafeRootRelative(root, pattern)) continue;
		try {
			const result = await glob({
				pattern,
				path: root,
				gitignore: true,
				hidden: false,
				fileType: FileType.File,
			});
			const match = result.matches[0];
			if (match) {
				return [{ kind: "fileGlob", path: path.join(root, match.path), value: pattern }];
			}
		} catch {
			// Missing or unreadable roots simply do not contribute weak file-glob evidence.
		}
	}
	return [];
}

function cacheKey(cwd: string, repoRoot: string | null): string {
	return `${normalizeDir(cwd)}\0${repoRoot ? normalizeDir(repoRoot) : ""}`;
}

function isDefaultDetection(detectors: readonly ProjectDetectorDefinition[], includeFileGlobs: boolean): boolean {
	return detectors === DEFAULT_PROJECT_DETECTORS && includeFileGlobs;
}

export async function detectProjectFacets(options: DetectProjectFacetsOptions): Promise<ProjectFacet[]> {
	const cwd = normalizeDir(options.cwd);
	const repoRoot = options.repoRoot === undefined ? await findRepoRoot(cwd) : options.repoRoot;
	const resolvedRepoRoot = repoRoot ? normalizeDir(repoRoot) : null;
	const detectors = options.detectors ?? DEFAULT_PROJECT_DETECTORS;
	const includeFileGlobs = options.includeFileGlobs !== false;
	const useCache = isDefaultDetection(detectors, includeFileGlobs);
	const key = cacheKey(cwd, resolvedRepoRoot);
	if (useCache) {
		const cached = DEFAULT_CACHE.get(key);
		if (cached) return cached.map(facet => ({ ...facet, evidence: [...facet.evidence] }));
	}

	const ancestors = getProjectAncestorDirs(cwd, resolvedRepoRoot ?? cwd);
	const facetById = new Map<string, ProjectFacet>();

	for (const detector of detectors) {
		for (const root of ancestors) {
			const evidence = await detectRootMarkerEvidence(root, detector.rootMarkers);
			if (evidence.length > 0) {
				facetById.set(detector.id, {
					id: detector.id,
					root,
					confidence: "strong",
					evidence,
				});
				break;
			}
		}

		if (!includeFileGlobs || facetById.has(detector.id)) continue;
		const evidence = await detectFileGlobEvidence(cwd, detector.fileGlobs);
		if (evidence.length > 0) {
			facetById.set(detector.id, {
				id: detector.id,
				root: cwd,
				confidence: "weak",
				evidence,
			});
		}
	}

	const order = new Map(ancestors.map((root, index) => [root, index]));
	const facets = Array.from(facetById.values()).sort((left, right) => {
		const leftOrder = order.get(left.root) ?? Number.MAX_SAFE_INTEGER;
		const rightOrder = order.get(right.root) ?? Number.MAX_SAFE_INTEGER;
		if (leftOrder !== rightOrder) return leftOrder - rightOrder;
		return left.id.localeCompare(right.id);
	});

	if (useCache) {
		DEFAULT_CACHE.set(
			key,
			facets.map(facet => ({ ...facet, evidence: [...facet.evidence] })),
		);
	}
	return facets;
}

export function clearProjectDetectionCacheForTests(): void {
	DEFAULT_CACHE.clear();
}
