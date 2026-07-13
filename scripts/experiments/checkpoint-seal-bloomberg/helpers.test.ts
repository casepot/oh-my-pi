import { describe, expect, test } from "bun:test";
import type { RpcSessionEntryView } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	assertConditionContext,
	auditSharedCalls,
	CONDITIONS,
	countShakePlaceholders,
	equalTodoState,
	findFirstAssistantPromptUsage,
	providerFailureMessage,
	seededConditionOrder,
	type ToolCallRecord,
} from "./helpers";
import { parseCli } from "./orchestrate";

const verificationCalls: ToolCallRecord[] = [
	{ index: 0, name: "checkpoint", isError: false },
	{ index: 1, name: "read", isError: false },
	{ index: 2, name: "bash", arguments: { command: "uv run pytest -q tests/request" }, isError: false },
	{
		index: 3,
		name: "bash",
		arguments: {
			command:
				"uv run pytest -q --ignore=tests/blp/test_real_adapter_versions.py --ignore=tests/security/test_live_probe_stubs.py",
		},
		isError: false,
	},
	{ index: 4, name: "bash", arguments: { command: "uv run ruff check ." }, isError: false },
	{ index: 5, name: "bash", arguments: { command: "uv run basedpyright" }, isError: false },
	{ index: 6, name: "bash", arguments: { command: "uv run ty check src" }, isError: false },
	{ index: 7, name: "keep_checkpoint", isError: false },
];

describe("seededConditionOrder", () => {
	test("is deterministic and balances every replicate", () => {
		const first = seededConditionOrder(42, 3);
		expect(first).toEqual(seededConditionOrder(42, 3));
		expect(first).not.toEqual(seededConditionOrder(43, 3));
		for (let offset = 0; offset < first.length; offset += CONDITIONS.length) {
			expect([...first.slice(offset, offset + CONDITIONS.length)].sort()).toEqual([...CONDITIONS].sort());
		}
	});

	test("rejects invalid replicate counts", () => {
		expect(() => seededConditionOrder(1, 0)).toThrow("positive integer");
	});
});

describe("parseCli", () => {
	test("caps newly executed continuation runs", () => {
		expect(parseCli(["--model", "provider/model", "--max-new-runs", "4"], {}).maxNewRuns).toBe(4);
	});

	test("rejects a non-positive continuation cap", () => {
		expect(() => parseCli(["--model", "provider/model", "--max-new-runs", "0"], {})).toThrow("positive integer");
	});
});

test("provider stream failures are surfaced before a run is accepted", () => {
	expect(
		providerFailureMessage({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "OpenAI Codex SSE stream timed out while waiting for the first event",
			},
		}),
	).toBe("OpenAI Codex SSE stream timed out while waiting for the first event");
	expect(
		providerFailureMessage({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }),
	).toBeUndefined();
});

describe("auditSharedCalls", () => {
	test("accepts a checkpointed, fully verified sequence", () => {
		expect(auditSharedCalls(verificationCalls)).toMatchObject({
			checkpointIndex: 0,
			keepIndex: 7,
			verification: { focused: true, offline: true, ruff: true, basedpyright: true, ty: true },
		});
	});

	test("fails closed when verification is absent", () => {
		expect(() => auditSharedCalls(verificationCalls.filter(call => call.index !== 5))).toThrow("basedpyright");
	});

	test("fails closed when mutation precedes checkpoint", () => {
		const calls = [{ index: 0, name: "write", isError: false }, ...verificationCalls];
		expect(() => auditSharedCalls(calls)).toThrow("before checkpoint");
	});

	test("retains failed attempts when later verification succeeds", () => {
		const failedAttempt: ToolCallRecord = {
			index: 2,
			name: "bash",
			arguments: { command: "uv run pytest -q tests/request" },
			isError: true,
		};
		const calls = [verificationCalls[0]!, verificationCalls[1]!, failedAttempt, ...verificationCalls.slice(2)];
		expect(auditSharedCalls(calls).toolFailures).toBe(1);
	});

	test("fails closed when a required check never passes", () => {
		const calls = verificationCalls.map(call => (call.index === 2 ? { ...call, isError: true } : call));
		expect(() => auditSharedCalls(calls)).toThrow("focused");
	});
});

describe("condition context isolation", () => {
	const shaken = {
		content: "result [shaken ~1200 tokens — recover: artifact://22 (region 1)]",
		nested: ["untouched", "[shaken ~800 tokens — recover: artifact://22 (region 2)]"],
	};

	test("counts placeholders recursively", () => {
		expect(countShakePlaceholders(shaken)).toBe(2);
	});

	test("rejects contaminated control and semantic arms", () => {
		expect(() => assertConditionContext("raw", shaken)).toThrow("contaminated");
		expect(() => assertConditionContext("report+manifest", shaken)).toThrow("contaminated");
	});

	test("requires Shake treatment to contain placeholders", () => {
		expect(() => assertConditionContext("shake", { content: "raw result" })).toThrow("no artifact-backed");
		expect(() => assertConditionContext("shake", shaken)).not.toThrow();
	});
});

test("first assistant prompt usage is measured after the continuation boundary", () => {
	const entries = [
		{ id: "root", parentId: null, entry: { type: "message", message: { role: "assistant", usage: { input: 99 } } } },
		{ id: "boundary", parentId: "root", entry: { type: "custom", customType: "experiment" } },
		{ id: "user", parentId: "boundary", entry: { type: "message", message: { role: "user" } } },
		{
			id: "assistant",
			parentId: "user",
			entry: {
				type: "message",
				message: { role: "assistant", usage: { input: 1200, cacheRead: 3400, cacheWrite: 50, output: 20 } },
			},
		},
	] as unknown as RpcSessionEntryView[];

	expect(findFirstAssistantPromptUsage(entries, "assistant", "boundary")).toEqual({
		entryId: "assistant",
		promptTokens: 4650,
		input: 1200,
		cacheRead: 3400,
		cacheWrite: 50,
	});
});

test("todo equality is order-sensitive and exact", () => {
	expect(equalTodoState([{ text: "one", status: "done" }], [{ text: "one", status: "done" }])).toBe(true);
	expect(equalTodoState([{ text: "one", status: "done" }], [{ text: "one", status: "pending" }])).toBe(false);
});
