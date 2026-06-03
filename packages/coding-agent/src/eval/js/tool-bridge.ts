import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "../../tools";
import { ToolError } from "../../tools/tool-errors";
import { EVAL_AGENT_BRIDGE_NAME, runEvalAgent } from "../agent-bridge";
import { EVAL_BUDGET_BRIDGE_NAME, type EvalBudgetResult, runEvalBudget } from "../budget-bridge";
import { EVAL_CONCURRENCY_BRIDGE_NAME, type EvalConcurrencyResult, runEvalConcurrency } from "../concurrency-bridge";
import { EVAL_LLM_BRIDGE_NAME, runEvalLlm } from "../llm-bridge";
import type { JsStatusEvent } from "./shared/types";

export type { JsStatusEvent } from "./shared/types";

interface ToolBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

type ToolValue =
	| string
	| EvalBudgetResult
	| EvalConcurrencyResult
	| {
			text: string;
			details?: unknown;
			images?: Array<{ mimeType: string; data: string }>;
			hasError?: boolean;
	  };
function toolResultHasError(result: AgentToolResult): boolean {
	if ((result as { isError?: unknown }).isError === true) {
		return true;
	}
	if (!(result.details && typeof result.details === "object")) {
		return false;
	}
	return (result.details as { isError?: unknown }).isError === true;
}

function getTool(session: ToolSession, name: string): AgentTool {
	const tool = session.getToolByName?.(name);
	if (!tool) {
		throw new ToolError(`Unknown tool from js runtime: ${name}`);
	}
	return tool;
}

type SafeParsable = {
	safeParse(input: unknown): { success: boolean };
};

function isSafeParsable(value: unknown): value is SafeParsable {
	return Boolean(value && typeof value === "object" && "safeParse" in value && typeof value.safeParse === "function");
}

function normalizeNullishProperties(record: Record<string, unknown>, schema: SafeParsable): Record<string, unknown> {
	const nullishKeys = Object.keys(record).filter(key => record[key] === null || record[key] === undefined);
	if (nullishKeys.length === 0) return record;
	const normalized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (value !== null && value !== undefined) normalized[key] = value;
	}
	for (const key of nullishKeys) {
		const candidate = { ...normalized, [key]: record[key] };
		if (schema.safeParse(candidate).success) {
			normalized[key] = record[key];
		}
	}
	return normalized;
}

function normalizeArgs(args: unknown, tool: AgentTool): unknown {
	if (args === null || args === undefined) {
		return { _i: "js prelude" };
	}
	if (typeof args !== "object" || Array.isArray(args)) {
		throw new ToolError(`tool.${tool.name}(...) expects an object of arguments or null/undefined`);
	}
	const record = { ...(args as Record<string, unknown>) };
	if (record._i === undefined) {
		record._i = "js prelude";
	}
	const schema = tool.parameters;
	if (!isSafeParsable(schema) || schema.safeParse(record).success) {
		return record;
	}
	const normalized = normalizeNullishProperties(record, schema);
	return schema.safeParse(normalized).success ? normalized : record;
}

function summarizeToolResult(
	name: string,
	args: unknown,
	result: AgentToolResult,
	text: string,
	hasError: boolean,
): JsStatusEvent {
	const record = (args && typeof args === "object" ? (args as Record<string, unknown>) : {}) as Record<
		string,
		unknown
	>;
	const details = (
		result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {}
	) as Record<string, unknown>;
	const withError = (event: JsStatusEvent): JsStatusEvent =>
		hasError ? { ...event, hasError: true, error: text.slice(0, 500) } : event;

	switch (name) {
		case "read":
			return withError({ op: "read", path: record.path, chars: text.length, preview: text.slice(0, 500) });
		case "write":
			return withError({
				op: "write",
				path: record.path,
				chars: typeof record.content === "string" ? record.content.length : 0,
			});
		case "grep":
			return withError({
				op: "grep",
				pattern: record.pattern,
				path: record.path,
				count: details.matchCount ?? undefined,
			});
		case "find":
			return withError({
				op: "find",
				pattern: record.pattern,
				count: details.fileCount ?? undefined,
				matches: Array.isArray(details.files) ? details.files.slice(0, 20) : undefined,
			});
		case "bash":
			return withError({
				op: "run",
				cmd: record.command,
				code: typeof details.exitCode === "number" ? details.exitCode : undefined,
				output: text.slice(0, 500),
			});
		default:
			return withError({ op: name, chars: text.length });
	}
}

export async function callSessionTool(name: string, args: unknown, options: ToolBridgeOptions): Promise<ToolValue> {
	if (name === EVAL_LLM_BRIDGE_NAME) {
		return await runEvalLlm(args, options);
	}
	if (name === EVAL_AGENT_BRIDGE_NAME) {
		return await runEvalAgent(args, options);
	}
	if (name === EVAL_BUDGET_BRIDGE_NAME) {
		return await runEvalBudget(args, options);
	}
	if (name === EVAL_CONCURRENCY_BRIDGE_NAME) {
		return runEvalConcurrency(args, options);
	}
	const tool = getTool(options.session, name);
	const normalizedArgs = normalizeArgs(args, tool);
	const toolCallId = `js-${name}-${crypto.randomUUID()}`;
	try {
		const result = await tool.execute(toolCallId, normalizedArgs, options.signal);
		const textBlocks = result.content.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text" && typeof content.text === "string",
		);
		const imageBlocks = result.content.filter(
			(content): content is { type: "image"; mimeType: string; data: string } =>
				content.type === "image" && typeof content.mimeType === "string" && typeof content.data === "string",
		);
		const text = textBlocks.map(block => block.text).join("");
		const hasError = toolResultHasError(result);
		options.emitStatus?.(summarizeToolResult(name, normalizedArgs, result, text, hasError));
		if (result.details === undefined && imageBlocks.length === 0 && !hasError) {
			return text;
		}
		const value: Exclude<ToolValue, string> = {
			text,
			details: result.details,
		};
		if (imageBlocks.length > 0) {
			value.images = imageBlocks.map(block => ({
				mimeType: block.mimeType,
				data: block.data,
			}));
		}
		if (hasError) {
			value.hasError = true;
		}
		return value;
	} catch (error) {
		options.emitStatus?.({
			op: name,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
