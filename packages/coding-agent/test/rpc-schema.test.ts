import { describe, expect, test } from "bun:test";
import * as path from "node:path";

interface JsonSchemaObject {
	$ref?: string;
	type?: string | string[];
	anyOf?: JsonSchema[];
	not?: JsonSchema;
	allOf?: JsonSchema[];
	required?: string[];
	properties?: Record<string, JsonSchema>;
	enum?: unknown[];
	const?: unknown;
	minimum?: number;
	items?: JsonSchema;
	$defs?: Record<string, JsonSchema>;
}

type JsonSchema = boolean | JsonSchemaObject;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveRef(root: JsonSchemaObject, ref: string): JsonSchema {
	const prefix = "#/$defs/";
	if (!ref.startsWith(prefix)) throw new Error(`Unsupported schema ref: ${ref}`);
	const name = ref.slice(prefix.length);
	const target = root.$defs?.[name];
	if (target === undefined) throw new Error(`Missing schema ref target: ${ref}`);
	return target;
}

function typeMatches(value: unknown, expected: string): boolean {
	switch (expected) {
		case "object":
			return isObject(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "boolean":
			return typeof value === "boolean";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return Number.isInteger(value);
		case "null":
			return value === null;
		default:
			throw new Error(`Unsupported schema type: ${expected}`);
	}
}

function validate(
	value: unknown,
	schema: JsonSchema,
	root: JsonSchemaObject,
	location = "$",
	seenRefs: string[] = [],
): string[] {
	if (schema === true) return [];
	if (schema === false) return [`${location}: schema is false`];
	if (schema.$ref) {
		if (seenRefs.includes(schema.$ref)) return [];
		return validate(value, resolveRef(root, schema.$ref), root, location, [...seenRefs, schema.$ref]);
	}
	if (schema.anyOf) {
		const attempts = schema.anyOf.map(child => validate(value, child, root, location, seenRefs));
		if (attempts.some(errors => errors.length === 0)) return [];
		return [`${location}: did not match any schema branch`];
	}
	if (schema.allOf) {
		return schema.allOf.flatMap(child => validate(value, child, root, location, seenRefs));
	}
	if (schema.not) {
		const negatedErrors = validate(value, schema.not, root, location, seenRefs);
		if (negatedErrors.length === 0) return [`${location}: matched negated schema`];
	}
	const errors: string[] = [];
	if (schema.const !== undefined && value !== schema.const)
		errors.push(`${location}: expected const ${String(schema.const)}`);
	if (schema.enum && !schema.enum.includes(value))
		errors.push(`${location}: expected one of ${schema.enum.join(",")}`);
	if (schema.type) {
		const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!expectedTypes.some(expected => typeMatches(value, expected))) {
			errors.push(`${location}: expected type ${expectedTypes.join("|")}`);
		}
	}
	if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
		errors.push(`${location}: expected >= ${schema.minimum}`);
	}
	if (schema.required && isObject(value)) {
		for (const key of schema.required) {
			if (!(key in value)) errors.push(`${location}.${key}: missing required property`);
		}
	}
	if (schema.properties && isObject(value)) {
		for (const [key, child] of Object.entries(schema.properties)) {
			if (key in value) errors.push(...validate(value[key], child, root, `${location}.${key}`, seenRefs));
		}
	}
	if (schema.items && Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			errors.push(...validate(value[index], schema.items, root, `${location}[${index}]`, seenRefs));
		}
	}
	return errors;
}

async function readGoldenFrames(): Promise<JsonObject[]> {
	const text = await Bun.file(path.join(import.meta.dir, "fixtures", "rpc-golden-frames.jsonl")).text();
	return text
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => {
			const parsed = JSON.parse(line) as unknown;
			if (!isObject(parsed)) throw new Error("Golden frame was not an object");
			return parsed;
		});
}

describe("RPC schema artifact", () => {
	test("golden frames validate against the shipped JSON schema and preserve frame ordering", async () => {
		const schema = (await Bun.file(
			path.join(import.meta.dir, "..", "src", "modes", "rpc", "rpc.schema.json"),
		).json()) as JsonSchemaObject;
		const frames = await readGoldenFrames();
		let lastSeq = 0;
		for (const frame of frames) {
			const errors = validate(frame, schema, schema);
			expect(errors).toEqual([]);
			expect(typeof frame.seq).toBe("number");
			expect(frame.seq as number).toBeGreaterThan(lastSeq);
			lastSeq = frame.seq as number;
		}
	});

	test("golden frames can be normalized into dashboard backend models without private tool internals", async () => {
		const frames = await readGoldenFrames();
		const rawLog = [...frames];
		const operations = new Map<string, JsonObject>();
		const taskRuns = new Map<string, JsonObject>();
		const hostTools = new Map<string, JsonObject>();
		const pendingUi = new Map<string, JsonObject>();
		for (const frame of frames) {
			if (frame.type === "operation_start" && typeof frame.operationId === "string") {
				operations.set(frame.operationId, { command: frame.command, status: "running" });
			}
			if (
				(frame.type === "operation_end" || frame.type === "operation_error") &&
				typeof frame.operationId === "string"
			) {
				operations.set(frame.operationId, {
					command: frame.command,
					status: frame.status,
					errorInfo: frame.errorInfo,
				});
			}
			if (frame.type === "task_progress" && typeof frame.taskRunId === "string") {
				taskRuns.set(frame.taskRunId, {
					toolCallId: frame.toolCallId,
					parentTaskRunId: frame.parentTaskRunId,
					agents: frame.agents,
				});
			}
			if (frame.type === "task_result" && typeof frame.taskRunId === "string") {
				const existing = taskRuns.get(frame.taskRunId) ?? {};
				taskRuns.set(frame.taskRunId, { ...existing, results: frame.results });
			}
			if (frame.type === "host_tool_call" && typeof frame.id === "string") {
				hostTools.set(frame.id, { toolCallId: frame.toolCallId, metadata: frame.metadata });
			}
			if (frame.type === "extension_ui_request" && typeof frame.id === "string" && frame.expectsResponse === true) {
				pendingUi.set(frame.id, {
					method: frame.method,
					responseSchema: frame.responseSchema,
					timeout: frame.timeout,
				});
			}
		}
		expect(rawLog).toHaveLength(frames.length);
		expect(operations.get("op_1")).toMatchObject({ command: "bash", status: "cancelled" });
		expect(taskRuns.get("task_1")).toMatchObject({
			toolCallId: "tool_task",
			parentTaskRunId: "parent_task_0",
		});
		const taskResults = taskRuns.get("task_1")?.results;
		if (!Array.isArray(taskResults)) throw new Error("Expected task results");
		expect(taskResults[0]).toMatchObject({
			id: "agent_1",
			outputRef: { kind: "artifact", uri: "agent://agent_1" },
		});
		expect(hostTools.get("host_1")).toMatchObject({ toolCallId: "tool_1" });
		expect(pendingUi.get("ui_1")).toMatchObject({ method: "confirm", responseSchema: { kind: "boolean" } });
	});

	test("known stdout frame types cannot validate through the unknown-frame fallback", async () => {
		const schema = (await Bun.file(
			path.join(import.meta.dir, "..", "src", "modes", "rpc", "rpc.schema.json"),
		).json()) as JsonSchemaObject;
		const malformedReady = {
			type: "ready",
			seq: 1,
			timestamp: "2026-06-05T12:00:00.000Z",
			sessionId: "session_abc",
		};
		expect(validate(malformedReady, schema, schema)).not.toEqual([]);
	});

	test("inbound command and host/UI response schemas enforce required fields", async () => {
		const schema = (await Bun.file(
			path.join(import.meta.dir, "..", "src", "modes", "rpc", "rpc.schema.json"),
		).json()) as JsonSchemaObject;
		const inbound = schema.$defs?.inboundCommand;
		const hostOrUi = schema.$defs?.hostOrUiResponse;
		if (inbound === undefined) throw new Error("Missing inboundCommand schema");
		if (hostOrUi === undefined) throw new Error("Missing hostOrUiResponse schema");

		expect(validate({ type: "prompt", message: "hello" }, inbound, schema)).toEqual([]);
		expect(validate({ type: "prompt" }, inbound, schema)).not.toEqual([]);
		expect(validate({ type: "cancel_operation", operationId: "op_1" }, inbound, schema)).toEqual([]);
		expect(validate({ type: "cancel_operation" }, inbound, schema)).not.toEqual([]);
		expect(validate({ type: "host_tool_result", id: "host_1", result: {} }, hostOrUi, schema)).toEqual([]);
		expect(validate({ type: "host_tool_result", id: "host_1" }, hostOrUi, schema)).not.toEqual([]);
	});

	test("extension UI event and request method frames validate without creating ambiguous pending state", async () => {
		const schema = (await Bun.file(
			path.join(import.meta.dir, "..", "src", "modes", "rpc", "rpc.schema.json"),
		).json()) as JsonSchemaObject;
		const base = { seq: 100, timestamp: "2026-06-05T12:00:00.100Z", sessionId: "session_abc" };
		const frames: JsonObject[] = [
			{
				...base,
				type: "extension_ui_request",
				id: "ui_select",
				method: "select",
				expectsResponse: true,
				timeout: 30000,
				responseSchema: { kind: "string", nullable: true },
				title: "Pick",
				options: ["a"],
			},
			{
				...base,
				type: "extension_ui_request",
				id: "ui_confirm",
				method: "confirm",
				expectsResponse: true,
				timeout: 30000,
				responseSchema: { kind: "boolean" },
				title: "Confirm",
				message: "Continue?",
			},
			{
				...base,
				type: "extension_ui_request",
				id: "ui_input",
				method: "input",
				expectsResponse: true,
				timeout: 30000,
				responseSchema: { kind: "string", nullable: true },
				title: "Input",
			},
			{
				...base,
				type: "extension_ui_request",
				id: "ui_editor",
				method: "editor",
				expectsResponse: true,
				timeout: 30000,
				responseSchema: { kind: "string", nullable: true },
				title: "Editor",
			},
			{
				...base,
				type: "extension_ui_request",
				id: "ui_notify",
				method: "notify",
				expectsResponse: false,
				message: "ok",
			},
			{
				...base,
				type: "extension_ui_request",
				id: "ui_status",
				method: "setStatus",
				expectsResponse: false,
				statusKey: "auth",
				statusText: "waiting",
			},
			{
				...base,
				type: "extension_ui_request",
				id: "ui_title",
				method: "setTitle",
				expectsResponse: false,
				title: "T",
			},
			{
				...base,
				type: "extension_ui_request",
				id: "ui_text",
				method: "set_editor_text",
				expectsResponse: false,
				text: "prefill",
			},
			{
				...base,
				type: "extension_ui_request",
				id: "ui_open",
				method: "open_url",
				expectsResponse: false,
				url: "https://example.invalid/login",
			},
			{
				...base,
				type: "extension_ui_request",
				id: "ui_cancel",
				method: "cancel",
				expectsResponse: false,
				targetId: "ui_editor",
			},
		];
		for (const frame of frames) expect(validate(frame, schema, schema)).toEqual([]);
		const pendingIds = frames
			.filter(frame => frame.expectsResponse === true)
			.map(frame => frame.id)
			.sort();
		expect(pendingIds).toEqual(["ui_confirm", "ui_editor", "ui_input", "ui_select"]);
	});

	test("schema exposes the stable error-code family used by protocol errors", async () => {
		const schema = (await Bun.file(
			path.join(import.meta.dir, "..", "src", "modes", "rpc", "rpc.schema.json"),
		).json()) as JsonSchemaObject;
		const errorInfo = schema.$defs?.errorInfo;
		if (errorInfo === undefined || errorInfo === true || errorInfo === false)
			throw new Error("Missing errorInfo schema");
		const code = errorInfo.properties?.code;
		if (code === undefined || code === true || code === false) throw new Error("Missing errorInfo.code schema");
		expect(code.enum).toEqual([
			"invalid_json",
			"invalid_frame",
			"invalid_command",
			"unknown_command",
			"invalid_arguments",
			"unsupported_capability",
			"operation_not_found",
			"operation_cancelled",
			"operation_timeout",
			"peer_closed",
			"host_tool_not_found",
			"host_tool_timeout",
			"host_tool_failed",
			"host_tool_too_large",
			"host_uri_scheme_not_found",
			"host_uri_denied",
			"host_uri_too_large",
			"extension_ui_timeout",
			"model_not_found",
			"session_not_found",
			"internal_error",
		]);
	});
});
