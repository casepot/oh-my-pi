import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { RpcSessionEntryView } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { isRecord } from "@oh-my-pi/pi-utils";

export const CONDITIONS = ["raw", "shake", "report-only", "report+manifest"] as const;
export type Condition = (typeof CONDITIONS)[number];

export interface ToolCallRecord {
	index: number;
	name: string;
	arguments?: unknown;
	isError?: boolean;
}

export interface SharedAudit {
	checkpointIndex: number;
	keepIndex: number;
	firstMutationIndex: number | null;
	verification: Record<"focused" | "offline" | "ruff" | "basedpyright" | "ty", boolean>;
	toolFailures: number;
}

export interface SealLeaves {
	reportOnly: string;
	reportManifest: string;
	report: unknown;
	manifest: unknown;
	todoState: unknown;
}

export interface EntryBoundary {
	preKeep: string;
	keepEntry: string;
}

function stringField(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return typeof field === "string" ? field : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return typeof field === "boolean" ? field : undefined;
}

export function toolCalls(events: readonly AgentEvent[]): ToolCallRecord[] {
	const calls: ToolCallRecord[] = [];
	for (const event of events) {
		if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") continue;
		if (event.type === "tool_execution_start") {
			calls.push({ index: calls.length, name: event.toolName, arguments: event.args });
			continue;
		}
		const pending = [...calls].reverse().find(call => call.name === event.toolName && call.isError === undefined);
		if (pending) pending.isError = event.isError;
	}
	return calls;
}

export function commandText(call: ToolCallRecord): string {
	return stringField(call.arguments, "command") ?? "";
}

export function auditSharedCalls(calls: readonly ToolCallRecord[]): SharedAudit {
	const checkpointIndex = calls.findIndex(call => call.name === "checkpoint" && call.isError === false);
	const keepIndex = calls.findLastIndex(call => call.name === "keep_checkpoint" && call.isError === false);
	if (checkpointIndex < 0) throw new Error("shared phase did not complete checkpoint");
	if (keepIndex < 0) throw new Error("shared phase did not complete keep_checkpoint");
	if (checkpointIndex >= keepIndex) throw new Error("checkpoint must precede keep_checkpoint");
	if (calls.slice(keepIndex + 1).some(call => call.name !== "yield")) {
		throw new Error("shared phase called tools after keep_checkpoint");
	}
	const mutationNames: Record<string, true> = { edit: true, write: true, ast_edit: true, lsp: true, bash: true };
	const firstMutationIndex = calls.findIndex(call => mutationNames[call.name] === true);
	if (firstMutationIndex >= 0 && firstMutationIndex < checkpointIndex) {
		throw new Error("shared phase mutated or executed before checkpoint");
	}
	const toolFailures = calls.filter(call => call.isError === true).length;
	const commands = calls.filter(call => call.name === "bash" && call.isError === false).map(commandText);
	const verification = {
		focused: commands.some(
			command => /pytest/.test(command) && !/--ignore=tests\/blp\/test_real_adapter_versions\.py/.test(command),
		),
		offline: commands.some(
			command =>
				/pytest/.test(command) &&
				/--ignore=tests\/blp\/test_real_adapter_versions\.py/.test(command) &&
				/--ignore=tests\/security\/test_live_probe_stubs\.py/.test(command),
		),
		ruff: commands.some(command => /(^|\s)ruff(\s|$)/.test(command)),
		basedpyright: commands.some(command => /(^|\s)basedpyright(\s|$)/.test(command)),
		ty: commands.some(command => /(^|\s)ty\s+check\s+src(\s|$)/.test(command)),
	};
	const missing = Object.entries(verification)
		.filter(([, passed]) => !passed)
		.map(([name]) => name);
	if (missing.length > 0) throw new Error(`shared verification evidence missing: ${missing.join(", ")}`);
	return {
		checkpointIndex,
		keepIndex,
		firstMutationIndex: firstMutationIndex < 0 ? null : firstMutationIndex,
		verification,
		toolFailures,
	};
}

function containsToolCall(value: unknown, toolName: string): boolean {
	if (Array.isArray(value)) return value.some(item => containsToolCall(item, toolName));
	if (!isRecord(value)) return false;
	if (
		(value.type === "toolCall" || value.type === "tool_call") &&
		(value.name === toolName || value.toolName === toolName)
	) {
		return true;
	}
	return Object.values(value).some(item => containsToolCall(item, toolName));
}

function customType(entry: RpcSessionEntryView): string | undefined {
	if (!entry.entry || !isRecord(entry.entry)) return undefined;
	return stringField(entry.entry, "customType");
}

function customContent(entry: RpcSessionEntryView): unknown {
	if (!entry.entry || !isRecord(entry.entry)) return undefined;
	return entry.entry.content;
}
function customData(entry: RpcSessionEntryView): unknown {
	if (!entry.entry || !isRecord(entry.entry)) return undefined;
	return entry.entry.data;
}

export function findPreKeepBoundary(entries: readonly RpcSessionEntryView[]): EntryBoundary {
	const keepEntry = [...entries].reverse().find(entry => containsToolCall(entry.entry, "keep_checkpoint"));
	if (!keepEntry) throw new Error("session entries missing keep_checkpoint call");
	if (!keepEntry.parentId) throw new Error("keep_checkpoint entry has no pre-keep parent");
	return { preKeep: keepEntry.parentId, keepEntry: keepEntry.id };
}

export function findShakeSealLeaf(entries: readonly RpcSessionEntryView[]): string {
	const marker = [...entries].reverse().find(entry => {
		if (customType(entry) !== "checkpoint-seal" || !entry.entry || !isRecord(entry.entry)) return false;
		const details = entry.entry.details;
		return isRecord(details) && details.strategy === "shake";
	});
	if (!marker) throw new Error("Shake branch missing final completion marker");
	return marker.id;
}

export function findSealLeaves(entries: readonly RpcSessionEntryView[], currentLeafId: string | null): SealLeaves {
	const reportEntry = [...entries].reverse().find(entry => customType(entry) === "checkpoint-seal-report");
	if (!reportEntry) throw new Error("summary branch missing checkpoint-seal-report entry");
	const todoEntry = entries.find(entry => entry.id === reportEntry.parentId && customType(entry) === "user_todo_edit");
	if (!todoEntry) throw new Error("summary branch missing todo snapshot immediately before report");
	const manifestEntry = entries.find(
		entry => entry.parentId === reportEntry.id && customType(entry) === "checkpoint-seal-manifest",
	);
	if (!manifestEntry) throw new Error("summary branch missing manifest immediately after report");
	const completionEntry = entries.find(
		entry => entry.parentId === manifestEntry.id && customType(entry) === "checkpoint-seal",
	);
	if (!completionEntry) throw new Error("summary branch missing final completion marker");
	const todoData = customData(todoEntry);
	if (!currentLeafId) throw new Error("summary branch has no current leaf");
	return {
		reportOnly: reportEntry.id,
		reportManifest: completionEntry.id,
		report: customContent(reportEntry),
		manifest: customContent(manifestEntry),
		todoState: isRecord(todoData) ? todoData.phases : undefined,
	};
}

export interface PromptUsageMeasurement {
	entryId: string;
	promptTokens: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

export function countShakePlaceholders(value: unknown): number {
	if (typeof value === "string") return value.split("[shaken ~").length - 1;
	if (Array.isArray(value)) {
		let count = 0;
		for (const item of value) count += countShakePlaceholders(item);
		return count;
	}
	if (!isRecord(value)) return 0;
	let count = 0;
	for (const item of Object.values(value)) count += countShakePlaceholders(item);
	return count;
}

export function assertConditionContext(condition: Condition, value: unknown): void {
	const placeholders = countShakePlaceholders(value);
	if (condition === "shake") {
		if (placeholders === 0) throw new Error("Shake context contains no artifact-backed placeholders");
		return;
	}
	if (placeholders > 0) {
		throw new Error(`${condition} context is contaminated by ${placeholders} Shake placeholder(s)`);
	}
}

function numberField(value: Record<string, unknown>, key: string): number {
	const field = value[key];
	return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

export function findFirstAssistantPromptUsage(
	entries: readonly RpcSessionEntryView[],
	leafId: string,
	afterEntryId: string,
): PromptUsageMeasurement {
	const entriesById = new Map(entries.map(entry => [entry.id, entry]));
	const branch: RpcSessionEntryView[] = [];
	let cursor: RpcSessionEntryView | undefined = entriesById.get(leafId);
	while (cursor) {
		branch.unshift(cursor);
		cursor = cursor.parentId ? entriesById.get(cursor.parentId) : undefined;
	}
	const boundaryIndex = branch.findIndex(entry => entry.id === afterEntryId);
	if (boundaryIndex < 0) throw new Error(`continuation boundary is not an ancestor of leaf ${leafId}`);
	for (const entry of branch.slice(boundaryIndex + 1)) {
		if (!entry.entry || !isRecord(entry.entry) || entry.entry.type !== "message") continue;
		const message = entry.entry.message;
		if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) continue;
		const input = numberField(message.usage, "input");
		const cacheRead = numberField(message.usage, "cacheRead");
		const cacheWrite = numberField(message.usage, "cacheWrite");
		return {
			entryId: entry.id,
			promptTokens: input + cacheRead + cacheWrite,
			input,
			cacheRead,
			cacheWrite,
		};
	}
	throw new Error("continuation branch contains no assistant provider usage after its boundary");
}

export function seededConditionOrder(seed: number, replicates: number): Condition[] {
	if (!Number.isSafeInteger(seed)) throw new Error("seed must be a safe integer");
	if (!Number.isSafeInteger(replicates) || replicates < 1) throw new Error("replicates must be a positive integer");
	let state = seed >>> 0;
	const random = (): number => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
	const result: Condition[] = [];
	for (let replicate = 0; replicate < replicates; replicate++) {
		const block = [...CONDITIONS];
		for (let index = block.length - 1; index > 0; index--) {
			const swap = Math.floor(random() * (index + 1));
			[block[index], block[swap]] = [block[swap], block[index]];
		}
		result.push(...block);
	}
	return result;
}

export function equalTodoState(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function eventCompacted(event: unknown): boolean {
	return stringField(event, "type") === "auto_compaction_start";
}

export function providerFailureMessage(event: unknown): string | undefined {
	if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) return undefined;
	if (event.message.role !== "assistant" || event.message.stopReason !== "error") return undefined;
	const message = event.message.errorMessage;
	return typeof message === "string" && message.length > 0 ? message : "assistant provider turn failed";
}

export function eventFailed(event: unknown): boolean {
	return booleanField(event, "isError") === true;
}
