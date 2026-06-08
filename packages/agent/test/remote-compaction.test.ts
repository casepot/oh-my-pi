import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	CompactionCancelledError,
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "@oh-my-pi/pi-agent-core/compaction";
import { buildOpenAiNativeHistory, requestOpenAiRemoteCompaction } from "@oh-my-pi/pi-agent-core/compaction/openai";
import * as ai from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { hookFetch, logger } from "@oh-my-pi/pi-utils";

function makeOpenAiModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	};
}

function makeAnthropicModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		...overrides,
	};
}

function makeUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function makeAssistantStop(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "openai",
		model: "gpt-5",
		api: "openai-responses",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	const settings = {
		...DEFAULT_COMPACTION_SETTINGS,
		remoteEnabled: true,
		remoteTimeoutMs: 5,
		...(overrides.settings ?? {}),
	};
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [makeUserMessage("history msg"), makeAssistantStop("history reply")],
		turnPrefixMessages: [],
		recentMessages: [makeUserMessage("recent msg")],
		isSplitTurn: false,
		tokensBefore: 12_345,
		fileOps: createFileOps(),
		...overrides,
		settings,
	};
}

function mockLocalSummaries() {
	return vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("local summary"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("buildOpenAiNativeHistory custom tool calls", () => {
	test("serializes customWireName tool calls as custom_tool_call + custom_tool_call_output", () => {
		const patch = "*** Begin Patch\n*** End Patch\n";
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_apply_1|ctc_apply_1",
					name: "edit",
					arguments: { input: patch },
					customWireName: "apply_patch",
				},
			],
			timestamp: Date.now(),
			provider: "openai",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_apply_1|ctc_apply_1",
			toolName: "edit",
			content: [{ type: "text", text: "patch applied" }],
			isError: false,
			timestamp: Date.now(),
		};

		const items = buildOpenAiNativeHistory([assistant, toolResult], makeOpenAiModel());

		const call = items.find(item => item.type === "custom_tool_call");
		expect(call).toBeDefined();
		expect(call?.name).toBe("apply_patch");
		expect(call?.input).toBe(patch);
		expect(call?.call_id).toBe("call_apply_1");

		const output = items.find(item => item.type === "custom_tool_call_output");
		expect(output).toBeDefined();
		expect(output?.call_id).toBe("call_apply_1");
		expect(output?.output).toBe("patch applied");

		// Did NOT emit the legacy function_call / function_call_output pair.
		expect(items.find(item => item.type === "function_call")).toBeUndefined();
		expect(items.find(item => item.type === "function_call_output")).toBeUndefined();
	});

	test("continues to emit function_call for regular JSON tools", () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_read_1|fc_read_1",
					name: "read_file",
					arguments: { path: "/tmp/x" },
				},
			],
			timestamp: Date.now(),
			provider: "openai",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		};
		const items = buildOpenAiNativeHistory([assistant], makeOpenAiModel());
		expect(items.find(item => item.type === "function_call")).toBeDefined();
		expect(items.find(item => item.type === "custom_tool_call")).toBeUndefined();
	});
});

describe("remote compaction input trimming", () => {
	test("trims custom tool outputs with their matching custom calls", async () => {
		let requestInput: Array<Record<string, unknown>> | undefined;
		using _hook = hookFetch(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { input: Array<Record<string, unknown>> };
			requestInput = body.input;
			return Response.json({
				output: [{ type: "compaction_summary", summary: "compact" }],
			});
		});

		await requestOpenAiRemoteCompaction(
			makeOpenAiModel({ contextWindow: 1 }),
			"test-key",
			[
				{ type: "custom_tool_call", call_id: "call_apply_1", name: "apply_patch", input: "x".repeat(10_000) },
				{ type: "custom_tool_call_output", call_id: "call_apply_1", output: "patch applied".repeat(1_000) },
			],
			"compact",
		);

		expect(requestInput?.some(item => item.type === "custom_tool_call")).toBe(false);
		expect(requestInput?.some(item => item.type === "custom_tool_call_output")).toBe(false);
	});
});

describe("requestOpenAiRemoteCompaction abort", () => {
	test("rejects when the abort signal is aborted mid-fetch", async () => {
		const controller = new AbortController();
		using _hook = hookFetch((_input, init) => {
			// Honor the provided abort signal: hang until aborted, then reject.
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			if (signal?.aborted) {
				reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
				return promise;
			}
			signal?.addEventListener("abort", () => {
				reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
			});
			return promise;
		});

		const promise = requestOpenAiRemoteCompaction(
			makeOpenAiModel(),
			"test-key",
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
			"compact",
			controller.signal,
		);

		queueMicrotask(() => controller.abort());

		const error = await promise.catch(err => err);
		expect(error).toBeInstanceOf(CompactionCancelledError);
	});
});

describe("compact remote fallback classification", () => {
	test("does not fall back to local summarization when caller aborts remote compaction", async () => {
		const controller = new AbortController();
		const completeSpy = mockLocalSummaries();
		using _hook = hookFetch((_input, init) => {
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			signal?.addEventListener(
				"abort",
				() => reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError")),
				{ once: true },
			);
			queueMicrotask(() => controller.abort());
			return promise;
		});

		const error = await compact(makePreparation(), makeOpenAiModel(), "test-key", undefined, controller.signal).catch(
			err => err,
		);

		expect(error).toBeInstanceOf(CompactionCancelledError);
		expect(completeSpy).not.toHaveBeenCalled();
	});

	test("falls back locally when remote compaction times out while caller is live", async () => {
		const completeSpy = mockLocalSummaries();
		let sawTimeoutAbort = false;
		using _hook = hookFetch((_input, init) => {
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			signal?.addEventListener(
				"abort",
				() => {
					sawTimeoutAbort = true;
					reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
				},
				{ once: true },
			);
			return promise;
		});

		const result = await compact(makePreparation(), makeOpenAiModel(), "test-key");

		expect(sawTimeoutAbort).toBe(true);
		expect(result.summary).toContain("local summary");
		expect(completeSpy).toHaveBeenCalled();
	});

	test("falls back locally and logs structured fields for non-OK remote responses", async () => {
		const completeSpy = mockLocalSummaries();
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		using _hook = hookFetch(() => new Response("remote broke", { status: 500, statusText: "Server Error" }));

		const result = await compact(makePreparation(), makeOpenAiModel(), "test-key");

		expect(result.summary).toContain("local summary");
		expect(completeSpy).toHaveBeenCalled();
		const fields = warnSpy.mock.calls.map(call => call[1]).find(isRecord);
		expect(fields?.status).toBe(500);
		expect(fields?.statusText).toBe("Server Error");
		expect(fields?.callerSignalAborted).toBe(false);
		expect(fields?.timedOut).toBe(false);
		expect(String(fields?.endpoint)).toContain("/responses/compact");
		expect(fields?.model).toBe("gpt-5");
		expect(fields?.provider).toBe("openai");
	});

	test("threads remote timeout through custom endpoint short-summary fallback", async () => {
		const completeSpy = mockLocalSummaries();
		let fetchCalls = 0;
		let timeoutAborts = 0;
		using _hook = hookFetch((_input, init) => {
			fetchCalls++;
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			signal?.addEventListener(
				"abort",
				() => {
					timeoutAborts++;
					reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
				},
				{ once: true },
			);
			return promise;
		});

		const result = await compact(
			makePreparation({
				settings: {
					...DEFAULT_COMPACTION_SETTINGS,
					remoteEnabled: true,
					remoteEndpoint: "https://compact.example.test/summarize",
					remoteTimeoutMs: 5,
				},
			}),
			makeAnthropicModel(),
			"test-key",
		);

		expect(result.summary).toContain("local summary");
		expect(result.shortSummary).toContain("local summary");
		expect(fetchCalls).toBe(2);
		expect(timeoutAborts).toBe(2);
		expect(completeSpy).toHaveBeenCalledTimes(2);
	});

	test("falls back locally and logs output types for malformed remote responses", async () => {
		const completeSpy = mockLocalSummaries();
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		using _hook = hookFetch(() => Response.json({ output: [{ type: "message", role: "assistant" }] }));

		const result = await compact(makePreparation(), makeOpenAiModel(), "test-key");

		expect(result.summary).toContain("local summary");
		expect(completeSpy).toHaveBeenCalled();
		const fields = warnSpy.mock.calls
			.map(call => call[1])
			.filter(isRecord)
			.find(candidate => candidate.kind === "malformed");
		expect(fields?.outputTypes).toEqual(["message"]);
		expect(String(fields?.endpoint)).toContain("/responses/compact");
	});
});
