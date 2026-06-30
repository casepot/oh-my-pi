import type { GoalVerificationCommandKind, GoalVerificationCommandStatus } from "./state";

export interface ObservedToolResultForFreshness {
	toolName: string;
	args: Record<string, unknown>;
	result: unknown;
	isError: boolean;
}

export interface ClassifiedVerificationCommand {
	command: string;
	cwd?: string;
	kind: GoalVerificationCommandKind;
	status: GoalVerificationCommandStatus;
}

export interface ClassifiedTargetMutation {
	toolName: string;
	reason: string;
	paths?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length ? trimmed : undefined;
}

function resultDetails(result: unknown): Record<string, unknown> | undefined {
	if (!isRecord(result)) return undefined;
	return isRecord(result.details) ? result.details : undefined;
}

function resultHasRunningAsync(details: Record<string, unknown> | undefined): boolean {
	const asyncDetails = details?.async;
	return isRecord(asyncDetails) && asyncDetails.state === "running";
}

function dedupeStrings(values: Array<string | undefined>): string[] | undefined {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const value of values) {
		const trimmed = value?.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		output.push(trimmed);
	}
	return output.length ? output : undefined;
}

function detailString(details: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = details?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pathsFromPerFileResults(details: Record<string, unknown> | undefined): string[] {
	const perFileResults = details?.perFileResults;
	if (!Array.isArray(perFileResults)) return [];
	const paths: string[] = [];
	for (const result of perFileResults) {
		if (!isRecord(result)) continue;
		for (const key of ["path", "sourcePath"] as const) {
			const value = result[key];
			if (typeof value === "string") paths.push(value);
		}
		const move = result.move;
		if (isRecord(move)) {
			for (const key of ["from", "to", "source", "dest"] as const) {
				const value = move[key];
				if (typeof value === "string") paths.push(value);
			}
		}
	}
	return paths;
}

function detailsIndicateEdit(details: Record<string, unknown> | undefined): boolean {
	if (!details) return false;
	if (typeof details.diff === "string" && details.diff.length > 0) return true;
	if (typeof details.oldText === "string" || typeof details.newText === "string") return true;
	const perFileResults = details.perFileResults;
	return Array.isArray(perFileResults) && perFileResults.some(result => isRecord(result) && result.isError !== true);
}

function detailsIndicateAstEdit(details: Record<string, unknown> | undefined): boolean {
	if (!details) return false;
	if (typeof details.totalReplacements === "number" && details.totalReplacements > 0) return true;
	const filesTouched = details.filesTouched;
	if (Array.isArray(filesTouched) && filesTouched.length > 0) return true;
	const fileReplacements = details.fileReplacements;
	return Array.isArray(fileReplacements) && fileReplacements.length > 0;
}

function astEditPaths(details: Record<string, unknown> | undefined): string[] | undefined {
	if (!details) return undefined;
	const paths: string[] = [];
	for (const key of ["filesTouched", "filesSearched"] as const) {
		const value = details[key];
		if (!Array.isArray(value)) continue;
		for (const item of value) {
			if (typeof item === "string") paths.push(item);
		}
	}
	const fileReplacements = details.fileReplacements;
	if (Array.isArray(fileReplacements)) {
		for (const item of fileReplacements) {
			if (isRecord(item) && typeof item.path === "string") paths.push(item.path);
		}
	}
	return dedupeStrings(paths);
}

function normalizeSimpleCommand(rawCommand: string): string | undefined {
	const command = rawCommand.trim();
	if (!command) return undefined;
	if (/\n|;|\||>|</.test(command)) return undefined;
	if (/\|\|/.test(command)) return undefined;
	const cdPrefix = command.match(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s+&&\s+(.+)$/);
	if (cdPrefix) {
		const nested = cdPrefix[1]?.trim();
		if (!nested || /&&/.test(nested)) return undefined;
		return nested;
	}
	if (/&&/.test(command)) return undefined;
	return command;
}

function classifyBunCommand(command: string): GoalVerificationCommandKind | undefined {
	const match = command.match(/^bun(?:\s+--cwd(?:=|\s+)\S+)?\s+(.+)$/);
	const rest = match?.[1]?.trim();
	if (!rest) return undefined;
	if (rest === "check" || rest.startsWith("check ")) return "check";
	if (rest === "test" || rest.startsWith("test ")) return "test";
	const run = rest.match(/^run\s+(\S+)/);
	const script = run?.[1];
	if (!script) return undefined;
	if (script === "test" || script.startsWith("test:")) return "test";
	if (script === "check") return "check";
	if (script === "check:types" || script === "typecheck" || script.startsWith("typecheck:")) return "typecheck";
	if (script === "lint" || script.startsWith("lint:")) return "lint";
	return undefined;
}

function classifyCargoCommand(command: string): GoalVerificationCommandKind | undefined {
	const match = command.match(/^cargo\s+(\S+)/);
	const subcommand = match?.[1];
	if (subcommand === "check") return "check";
	if (subcommand === "test") return "test";
	if (subcommand === "clippy") return "lint";
	if (subcommand === "fmt" && /(?:^|\s)--(?:all\s+)?check(?:\s|$)/.test(command)) return "format-check";
	return undefined;
}

function classifyBiomeCommand(command: string): GoalVerificationCommandKind | undefined {
	return /^biome\s+check(?:\s|$)/.test(command) ? "lint" : undefined;
}

function verificationKindForCommand(command: string): GoalVerificationCommandKind | undefined {
	return classifyBunCommand(command) ?? classifyCargoCommand(command) ?? classifyBiomeCommand(command);
}

function bashStatus(
	input: ObservedToolResultForFreshness,
	details: Record<string, unknown> | undefined,
): GoalVerificationCommandStatus {
	const exitCode = details?.exitCode;
	if (input.isError || (typeof exitCode === "number" && exitCode !== 0)) return "failed";
	return "passed";
}

export function classifyVerificationCommand(
	input: ObservedToolResultForFreshness,
): ClassifiedVerificationCommand | undefined {
	if (input.toolName !== "bash") return undefined;
	const command = stringArg(input.args, "command");
	if (!command) return undefined;
	const details = resultDetails(input.result);
	if (input.args.async === true || resultHasRunningAsync(details)) return undefined;
	const normalized = normalizeSimpleCommand(command);
	if (!normalized) return undefined;
	const kind = verificationKindForCommand(normalized);
	if (!kind) return undefined;
	return {
		command,
		cwd: stringArg(input.args, "cwd"),
		kind,
		status: bashStatus(input, details),
	};
}

function isLspMutation(args: Record<string, unknown>, details: Record<string, unknown> | undefined): boolean {
	if (details?.success === false) return false;
	const action = stringArg(args, "action") ?? detailString(details, "action");
	if (action === "rename" || action === "rename_file") return true;
	return action === "code_actions" && args.apply === true;
}

function isTaskPossiblyMutating(args: Record<string, unknown>, details: Record<string, unknown> | undefined): boolean {
	if (resultHasRunningAsync(details)) return false;
	const agent = stringArg(args, "agent");
	if (agent === "explore") return false;
	const tasks = args.tasks;
	if (args.isolated === true) return false;
	if (Array.isArray(tasks) && tasks.length > 0) {
		return tasks.some(task => !isRecord(task) || task.isolated !== true);
	}
	return true;
}

function classifyBashMutation(command: string): string | undefined {
	const normalized = normalizeSimpleCommand(command);
	if (!normalized) return undefined;
	if (/^cargo\s+fmt(?:\s|$)/.test(normalized) && !/(?:^|\s)--(?:all\s+)?check(?:\s|$)/.test(normalized)) {
		return "cargo fmt may rewrite source files";
	}
	if (/^biome\s+format\b/.test(normalized) && /(?:^|\s)(?:--write|-w)(?:\s|$)/.test(normalized)) {
		return "biome format --write may rewrite files";
	}
	if (/^bun(?:\s+--cwd(?:=|\s+)\S+)?\s+run\s+gen(?::|\s|$)/.test(normalized)) {
		return "bun generation command may rewrite files";
	}
	if (/^(?:rm|mv|cp|touch|mkdir)\b/.test(normalized)) return "shell filesystem command may mutate workspace";
	if (/^git\s+(?:checkout|reset|apply|merge|rebase)\b/.test(normalized)) {
		return "git command may mutate workspace";
	}
	return undefined;
}

export function classifyTargetMutation(input: ObservedToolResultForFreshness): ClassifiedTargetMutation | undefined {
	const details = resultDetails(input.result);
	if (input.toolName === "write" && !input.isError) {
		return {
			toolName: input.toolName,
			reason: "write changed a workspace file",
			paths: dedupeStrings([detailString(details, "resolvedPath"), stringArg(input.args, "path")]),
		};
	}
	if (input.toolName === "edit" && !input.isError && detailsIndicateEdit(details)) {
		return {
			toolName: input.toolName,
			reason: "edit changed workspace files",
			paths: dedupeStrings([
				detailString(details, "path"),
				detailString(details, "sourcePath"),
				...pathsFromPerFileResults(details),
			]),
		};
	}
	if (input.toolName === "ast_edit" && !input.isError && detailsIndicateAstEdit(details)) {
		return {
			toolName: input.toolName,
			reason: "ast_edit changed workspace files",
			paths: astEditPaths(details),
		};
	}
	if (input.toolName === "lsp" && !input.isError && isLspMutation(input.args, details)) {
		return {
			toolName: input.toolName,
			reason: "lsp applied a workspace edit",
			paths: dedupeStrings([stringArg(input.args, "file"), stringArg(input.args, "new_name")]),
		};
	}
	if (input.toolName === "resolve" && !input.isError && input.args.action === "apply") {
		return {
			toolName: input.toolName,
			reason: "resolve applied a pending workspace change",
		};
	}
	if (input.toolName === "task" && !input.isError && isTaskPossiblyMutating(input.args, details)) {
		return {
			toolName: input.toolName,
			reason: "task result may include workspace changes",
		};
	}
	if (input.toolName === "bash" && !input.isError) {
		const command = stringArg(input.args, "command");
		const reason = command ? classifyBashMutation(command) : undefined;
		if (reason) {
			return {
				toolName: input.toolName,
				reason,
			};
		}
	}
	return undefined;
}
