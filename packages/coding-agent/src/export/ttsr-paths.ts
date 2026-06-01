import * as path from "node:path";
import { HL_FILE_PREFIX } from "@oh-my-pi/hashline";

const HASHLINE_FILE_PREFIXES = new Set<string>([HL_FILE_PREFIX, "§", "@"]);
const APPLY_PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/;

export interface ExtractTtsrToolFilePathsOptions {
	cwd: string;
}

function normalizeHashlineHeaderPath(rawPath: string): string {
	const trimmed = rawPath.trim();
	const hashStart = /#[0-9a-fA-F]{4}$/u.exec(trimmed)?.index;
	const withoutHash = hashStart === undefined ? trimmed : trimmed.slice(0, hashStart).trimEnd();
	if (withoutHash.length < 2) return withoutHash;
	const first = withoutHash[0];
	const last = withoutHash[withoutHash.length - 1];
	if ((first === '"' || first === "'") && first === last) {
		return withoutHash.slice(1, -1);
	}
	return withoutHash;
}

export function extractHashlineInputPaths(input: string): string[] {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const paths: string[] = [];
	for (const rawLine of stripped.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.length === 0 || !HASHLINE_FILE_PREFIXES.has(line[0])) continue;
		let prefixEnd = 0;
		while (prefixEnd < line.length && line[prefixEnd] === line[0]) prefixEnd++;
		const normalized = normalizeHashlineHeaderPath(line.slice(prefixEnd));
		if (normalized.length > 0) paths.push(normalized);
	}
	return paths;
}

function extractApplyPatchPaths(input: string): string[] {
	const paths: string[] = [];
	for (const rawLine of input.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const match = APPLY_PATCH_FILE_RE.exec(line);
		if (match?.[1]) paths.push(match[1].trim());
	}
	return paths;
}

export function normalizeTtsrPathCandidates(rawPath: string, cwd: string): string[] {
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) return [];

	const normalizedInput = trimmed.replaceAll("\\", "/");
	const candidates = new Set<string>([normalizedInput]);
	if (normalizedInput.startsWith("./")) candidates.add(normalizedInput.slice(2));

	const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
	candidates.add(absolutePath.replaceAll("\\", "/"));

	const relativePath = path.relative(cwd, absolutePath).replaceAll("\\", "/");
	if (relativePath && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== "..") {
		candidates.add(relativePath);
	}

	return Array.from(candidates);
}

function collectRawPaths(args: Record<string, unknown>, rawPaths: string[]): void {
	for (const [key, value] of Object.entries(args)) {
		const normalizedKey = key.toLowerCase();
		if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
			rawPaths.push(value);
			continue;
		}
		if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
			for (const candidate of value) {
				if (typeof candidate === "string") rawPaths.push(candidate);
			}
			continue;
		}
		if (
			typeof value === "string" &&
			(normalizedKey === "input" || normalizedKey.endsWith("input") || normalizedKey === "patch")
		) {
			rawPaths.push(...extractHashlineInputPaths(value), ...extractApplyPatchPaths(value));
			continue;
		}
		if (Array.isArray(value) && (normalizedKey === "edits" || normalizedKey === "entries")) {
			for (const entry of value) {
				if (entry && typeof entry === "object" && !Array.isArray(entry)) {
					collectRawPaths(entry as Record<string, unknown>, rawPaths);
				}
			}
		}
	}
}

export function extractTtsrFilePathsFromToolArgs(
	args: unknown,
	options: ExtractTtsrToolFilePathsOptions,
): string[] | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;

	const rawPaths: string[] = [];
	collectRawPaths(args as Record<string, unknown>, rawPaths);
	const normalizedPaths = rawPaths.flatMap(pathValue => normalizeTtsrPathCandidates(pathValue, options.cwd));
	return normalizedPaths.length > 0 ? Array.from(new Set(normalizedPaths)) : undefined;
}
