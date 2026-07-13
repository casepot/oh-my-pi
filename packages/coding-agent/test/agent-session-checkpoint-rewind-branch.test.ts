import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ThinkingContent } from "@oh-my-pi/pi-ai";
import { z } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockContent, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { RewindTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const checkpointSchema = z.object({ goal: z.string() });
const rewindSchema = z.object({ report: z.string() });
const keepSchema = z.object({ reason: z.string() });
const sealSchema = z.object({ strategy: z.string(), report: z.any().optional() });

const keepTool: AgentTool<typeof keepSchema> = {
	name: "keep_checkpoint",
	label: "Keep checkpoint",
	description: "Keep the checkpoint",
	parameters: keepSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text" as const, text: "checkpoint kept" }],
			details: { disposition: "keep" as const, reason: params.reason },
		};
	},
};

const sealTool: AgentTool<typeof sealSchema> = {
	name: "seal",
	label: "Seal checkpoint",
	description: "Seal the checkpoint",
	parameters: sealSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text" as const, text: "checkpoint sealed" }],
			details: {
				disposition: "seal" as const,
				strategy: params.strategy,
				...(params.report ? { report: params.report } : {}),
			},
		};
	},
};

const checkpointTool: AgentTool<typeof checkpointSchema, { startedAt: string }> = {
	name: "checkpoint",
	label: "Checkpoint",
	description: "Create a checkpoint",
	parameters: checkpointSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text" as const, text: `checkpoint:${params.goal}` }],
			details: { startedAt: "2026-01-01T00:00:00.000Z" },
		};
	},
};

const rewindTool: AgentTool<typeof rewindSchema, { report: string; rewound: boolean }> = {
	name: "rewind",
	label: "Rewind",
	description: "Rewind to the checkpoint",
	parameters: rewindSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text" as const, text: "rewind requested" }],
			details: { report: params.report, rewound: true },
		};
	},
};

type Harness = {
	session: AgentSession;
	authStorage: AuthStorage;
	extraSessions: AgentSession[];
	tempDir: TempDir;
};

const activeHarnesses: Harness[] = [];

afterEach(async () => {
	while (activeHarnesses.length > 0) {
		const harness = activeHarnesses.pop();
		for (const extraSession of harness?.extraSessions ?? []) {
			await extraSession.dispose();
		}
		await harness?.session.dispose();
		harness?.authStorage.close();
		harness?.tempDir.removeSync();
	}
});

function signedThinking(thinking: string, thinkingSignature: string): MockContent {
	return { type: "thinking", thinking, thinkingSignature } as unknown as MockContent;
}

async function createHarness(
	responses: MockResponse[],
	extraTools: AgentTool[] = [],
): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-checkpoint-rewind-branch-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	const tools = [
		checkpointTool as AgentTool,
		rewindTool as AgentTool,
		keepTool as AgentTool,
		sealTool as AgentTool,
		...extraTools,
	];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	const harness = { session, authStorage, tempDir, extraSessions: [] };
	activeHarnesses.push(harness);
	return { ...harness, mock };
}

async function createReloadedSession(harness: Harness): Promise<AgentSession> {
	const mock = createMockModel({ responses: [] });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const tools = [checkpointTool as AgentTool, rewindTool as AgentTool, keepTool as AgentTool, sealTool as AgentTool];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Test"],
			tools,
			messages: harness.session.sessionManager.buildSessionContext().messages,
		},
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: harness.session.sessionManager,
		settings,
		modelRegistry: new ModelRegistry(
			harness.authStorage,
			path.join(harness.tempDir.path(), `models-${Date.now()}.yml`),
		),
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	harness.extraSessions.push(session);
	return session;
}

function messageText(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

function expectLastAssistant(messages: AgentMessage[]): AssistantMessage {
	const message = messages.at(-1);
	expect(message?.role).toBe("assistant");
	if (message?.role !== "assistant") throw new Error("Expected last message to be assistant");
	return message;
}
function createToolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function rewindToolForSession(session: AgentSession): RewindTool {
	return new RewindTool(
		createToolSession({
			getCheckpointState: () => session.getCheckpointState(),
			getLastCompletedRewind: () => session.getLastCompletedRewind(),
		}),
	);
}

async function expectNoActiveCheckpointError(session: AgentSession): Promise<void> {
	await expect(rewindToolForSession(session).execute("repeat_rewind", { report: "retry" })).rejects.toThrow(
		"No active checkpoint. Create a checkpoint before calling rewind.",
	);
}

describe("AgentSession checkpoint rewind branch context", () => {
	it("rebuilds active history through branch_summary before the post-rewind assistant turn", async () => {
		const report = "findings: kept checkpoint; risks: stale signed thinking";
		const { session, mock } = await createHarness([
			{
				content: [
					signedThinking("checkpoint before exploring", "sig_checkpoint"),
					{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } },
				],
				stopReason: "toolUse",
			},
			{
				content: [
					signedThinking("ready to rewind", "sig_rewind"),
					{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report } },
				],
				stopReason: "toolUse",
			},
			{
				content: [signedThinking("answer after rewind", "sig_after_rewind"), "DONE"],
				stopReason: "stop",
			},
		]);

		await session.prompt("investigate with a checkpoint");

		expect(mock.calls.length).toBe(3);
		const finalCall = mock.calls[2];
		if (!finalCall) throw new Error("Expected final post-rewind provider call");
		const summaryIndex = finalCall.context.messages.findIndex(
			message => message.role === "user" && messageText(message).includes("summary of a branch"),
		);
		const reportIndex = finalCall.context.messages.findIndex(
			message => message.role === "developer" && messageText(message).includes(report),
		);
		expect(summaryIndex).toBeGreaterThan(-1);
		expect(reportIndex).toBeGreaterThan(summaryIndex);
		const reportMessage = finalCall.context.messages[reportIndex];
		if (!reportMessage) throw new Error("Expected rewind report context");
		const reportText = messageText(reportMessage);
		expect(reportText).toContain("Checkpoint completed.");
		expect(reportText).toContain("Do not call `rewind` again");
		expect(reportText).toContain(report);

		expect(
			finalCall.context.messages.some(message => message.role === "toolResult" && message.toolName === "rewind"),
		).toBe(false);

		const activeRoles = session.messages.map(message => message.role);
		expect(activeRoles).toEqual(["user", "assistant", "toolResult", "branchSummary", "custom", "assistant"]);
		expect(activeRoles).toEqual(session.sessionManager.buildSessionContext().messages.map(message => message.role));

		const finalAssistant = expectLastAssistant(session.messages);
		const finalThinking = finalAssistant.content.find((block): block is ThinkingContent => block.type === "thinking");
		expect(finalThinking?.thinking).toBe("answer after rewind");
		expect(finalThinking?.thinkingSignature).toBe("sig_after_rewind");
	});

	it("rehydrates completed rewind state from the retained report on resume", async () => {
		const report = "findings: retained after resume";
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);

		await harness.session.prompt("investigate with a checkpoint");

		const reloadedMock = createMockModel({ responses: [] });
		const reloadedSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		reloadedSettings.setModelRole("default", `${reloadedMock.provider}/${reloadedMock.id}`);
		const reloadedTools = [checkpointTool as AgentTool, rewindTool as AgentTool];
		const reloadedAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: reloadedMock,
				systemPrompt: ["Test"],
				tools: reloadedTools,
				messages: harness.session.sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: reloadedMock.stream,
		});
		const reloadedSession = new AgentSession({
			agent: reloadedAgent,
			sessionManager: harness.session.sessionManager,
			settings: reloadedSettings,
			modelRegistry: new ModelRegistry(
				harness.authStorage,
				path.join(harness.tempDir.path(), "models-reloaded.yml"),
			),
			toolRegistry: new Map(reloadedTools.map(tool => [tool.name, tool])),
		});
		harness.extraSessions.push(reloadedSession);

		expect(reloadedSession.getLastCompletedRewind()).toEqual({
			report,
			startedAt: "2026-01-01T00:00:00.000Z",
			rewoundAt: expect.any(String),
		});
		const tool = new RewindTool(
			createToolSession({
				getLastCompletedRewind: () => reloadedSession.getLastCompletedRewind(),
			}),
		);
		await expect(tool.execute("repeat_rewind", { report: "retry" })).rejects.toThrow(
			"Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
		);
	});

	it("clears completed rewind state when starting a new session", async () => {
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report: "findings" } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);

		await harness.session.prompt("investigate with a checkpoint");
		expect(harness.session.getLastCompletedRewind()).toBeDefined();

		await harness.session.newSession();

		expect(harness.session.getLastCompletedRewind()).toBeUndefined();
		await expectNoActiveCheckpointError(harness.session);
	});

	it("rehydrates completed rewind state from the branched path", async () => {
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report: "findings" } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);

		await harness.session.prompt("investigate with a checkpoint");
		expect(harness.session.getLastCompletedRewind()).toBeDefined();
		const userEntry = harness.session.sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!userEntry) throw new Error("Expected user entry for branch");

		await harness.session.branch(userEntry.id);

		expect(harness.session.getLastCompletedRewind()).toBeUndefined();
		await expectNoActiveCheckpointError(harness.session);
	});
	it("tells the model to continue when rewind is repeated after completion", async () => {
		const tool = new RewindTool(
			createToolSession({
				getLastCompletedRewind: () => ({
					report: "findings retained",
					startedAt: "2026-01-01T00:00:00.000Z",
					rewoundAt: "2026-01-01T00:01:00.000Z",
				}),
			}),
		);

		await expect(tool.execute("repeat_rewind", { report: "retry" })).rejects.toThrow(
			"Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
		);
	});

	it("rehydrates active checkpoint state when resuming a session with no rewind yet", async () => {
		const startedAt = "2026-01-01T00:00:00.000Z";
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report: "findings" } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);
		await harness.session.prompt("investigate with a checkpoint");
		const originalCompleted = harness.session.getLastCompletedRewind();
		expect(originalCompleted).toBeDefined();

		// Simulate "run aborted between checkpoint and rewind" by branching to the
		// checkpoint entry itself — the rewind and its rewind-report entry drop off
		// the active branch, leaving the checkpoint tool result as the leaf.
		const branch = harness.session.sessionManager.getBranch();
		const checkpointEntry = branch.find(
			entry =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "checkpoint",
		);
		if (!checkpointEntry) throw new Error("Expected checkpoint tool result entry");
		harness.session.sessionManager.branch(checkpointEntry.id);

		const reloadedMock = createMockModel({ responses: [] });
		const reloadedSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		reloadedSettings.setModelRole("default", `${reloadedMock.provider}/${reloadedMock.id}`);
		const reloadedTools = [checkpointTool as AgentTool, rewindTool as AgentTool];
		const reloadedAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: reloadedMock,
				systemPrompt: ["Test"],
				tools: reloadedTools,
				messages: harness.session.sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: reloadedMock.stream,
		});
		const reloadedSession = new AgentSession({
			agent: reloadedAgent,
			sessionManager: harness.session.sessionManager,
			settings: reloadedSettings,
			modelRegistry: new ModelRegistry(
				harness.authStorage,
				path.join(harness.tempDir.path(), "models-reloaded.yml"),
			),
			toolRegistry: new Map(reloadedTools.map(tool => [tool.name, tool])),
		});
		harness.extraSessions.push(reloadedSession);

		const restored = reloadedSession.getCheckpointState();
		expect(restored).toBeDefined();
		expect(restored?.checkpointEntryId).toBe(checkpointEntry.id);
		expect(restored?.startedAt).toBe(startedAt);
		expect(reloadedSession.getLastCompletedRewind()).toBeUndefined();

		// The rewind tool must accept the request now that the active checkpoint
		// has been re-hydrated — previously this threw "No active checkpoint".
		const rewindResult = await rewindToolForSession(reloadedSession).execute("call_rewind_after_resume", {
			report: "post-resume findings",
		});
		expect(rewindResult.content.some(part => part.type === "text" && part.text.includes("Rewind requested"))).toBe(
			true,
		);
	});

	it("rewind restores historical todo filtering instead of carrying terminal checkpoint state", async () => {
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "checkpoint", name: "checkpoint", arguments: { goal: "discard" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "rewind", name: "rewind", arguments: { report: "discarded" } }],
				stopReason: "toolUse",
			},
			{ content: ["continued"], stopReason: "stop" },
		]);
		const terminalTodo = [{ name: "phase", tasks: [{ content: "discarded", status: "completed" as const }] }];
		harness.session.setTodoPhases(terminalTodo);
		harness.session.sessionManager.appendCustomEntry("user_todo_edit", { phases: terminalTodo });

		await harness.session.prompt("discard the span");

		expect(harness.session.getTodoPhases()).toEqual([]);
	});

	it("keeps the detailed branch, resumes closed, and permits a new checkpoint", async () => {
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "checkpoint_1", name: "checkpoint", arguments: { goal: "first" } }],
				stopReason: "toolUse",
			},
			{
				content: [
					{ type: "toolCall", id: "keep_1", name: "keep_checkpoint", arguments: { reason: "retain details" } },
				],
				stopReason: "toolUse",
			},
			{ content: ["first done"], stopReason: "stop" },
			{
				content: [{ type: "toolCall", id: "checkpoint_2", name: "checkpoint", arguments: { goal: "second" } }],
				stopReason: "toolUse",
			},
			{
				content: [
					{ type: "toolCall", id: "keep_2", name: "keep_checkpoint", arguments: { reason: "retain second" } },
				],
				stopReason: "toolUse",
			},
			{ content: ["second done"], stopReason: "stop" },
		]);

		const terminalTodo = [{ name: "phase", tasks: [{ content: "retained", status: "completed" as const }] }];
		harness.session.setTodoPhases(terminalTodo);
		harness.session.sessionManager.appendCustomEntry("user_todo_edit", { phases: terminalTodo });

		await harness.session.prompt("first span");
		await harness.session.prompt("second span");

		const branch = harness.session.sessionManager.getBranch();
		expect(branch.filter(entry => entry.type === "branch_summary")).toHaveLength(0);
		expect(
			branch.filter(entry => entry.type === "custom_message" && entry.customType === "checkpoint-keep"),
		).toHaveLength(2);
		expect(harness.session.getCheckpointState()).toBeUndefined();

		const reloaded = await createReloadedSession(harness);
		expect(reloaded.getCheckpointState()).toBeUndefined();
		expect(reloaded.getTodoPhases()).toEqual(terminalTodo);
	});

	it("shake-seals only the strict checkpoint suffix and persists recovery metadata", async () => {
		const blobSchema = z.object({ label: z.string() });
		const blobTool: AgentTool<typeof blobSchema> = {
			name: "blob",
			label: "Blob",
			description: "Return a heavy payload",
			parameters: blobSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text" as const, text: `${params.label}:${"x".repeat(12_000)}` }],
				};
			},
		};
		const harness = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "before", name: "blob", arguments: { label: "before" } }],
					stopReason: "toolUse",
				},
				{ content: ["before done"], stopReason: "stop" },
				{
					content: [{ type: "toolCall", id: "checkpoint", name: "checkpoint", arguments: { goal: "shake" } }],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "after", name: "blob", arguments: { label: "after" } }],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "seal", name: "seal", arguments: { strategy: "shake" } }],
					stopReason: "toolUse",
				},
				{ content: ["after done"], stopReason: "stop" },
			],
			[blobTool as AgentTool],
		);

		const terminalTodo = [{ name: "phase", tasks: [{ content: "shaken", status: "completed" as const }] }];
		harness.session.setTodoPhases(terminalTodo);
		harness.session.sessionManager.appendCustomEntry("user_todo_edit", { phases: terminalTodo });

		await harness.session.prompt("create prefix");
		await harness.session.prompt("shake suffix");

		const blobResults = harness.session.sessionManager
			.getBranch()
			.filter(
				entry =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "blob",
			);
		expect(blobResults).toHaveLength(2);
		const beforeText =
			blobResults[0]?.type === "message" && blobResults[0].message.role === "toolResult"
				? messageText(blobResults[0].message)
				: "";
		const afterText =
			blobResults[1]?.type === "message" && blobResults[1].message.role === "toolResult"
				? messageText(blobResults[1].message)
				: "";
		expect(beforeText).toStartWith("before:");
		expect(afterText).toContain("[shaken");
		const marker = harness.session.sessionManager
			.getBranch()
			.find(entry => entry.type === "custom_message" && entry.customType === "checkpoint-seal");
		expect(marker?.type).toBe("custom_message");
		if (marker?.type !== "custom_message") throw new Error("Expected checkpoint seal marker");
		expect(marker.details).toMatchObject({
			strategy: "shake",
			toolResultsDropped: 1,
			artifactId: expect.any(String),
		});
		expect(harness.session.getCheckpointState()).toBeUndefined();
		const reloaded = await createReloadedSession(harness);
		expect(reloaded.getCheckpointState()).toBeUndefined();
		expect(reloaded.getTodoPhases()).toEqual(terminalTodo);
	});

	it("summary-seals to report, manifest, raw evidence, and the exact close-time todo snapshot", async () => {
		let lifecycleSession: AgentSession | undefined;
		const completeSchema = z.object({});
		const closeTodo = [{ name: "phase", tasks: [{ content: "verified", status: "completed" as const }] }];
		const completeTool: AgentTool<typeof completeSchema> = {
			name: "complete_phase",
			label: "Complete phase",
			description: "Complete the todo phase",
			parameters: completeSchema,
			async execute() {
				if (!lifecycleSession) throw new Error("session unavailable");
				lifecycleSession.setTodoPhases(closeTodo);
				lifecycleSession.sessionManager.appendCustomEntry("user_todo_edit", { phases: closeTodo });
				return { content: [{ type: "text" as const, text: "phase completed" }] };
			},
		};
		const report = {
			outcome: "Implemented the phase",
			durableContext: ["Use the persisted contract"],
			decisions: [{ decision: "Keep API", reason: "Compatibility" }],
			verification: [{ contract: "Focused behavior", evidence: "targeted test passed" }],
			remaining: ["None known"],
			next: "Continue",
		};
		const harness = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "checkpoint", name: "checkpoint", arguments: { goal: "ship" } }],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "complete", name: "complete_phase", arguments: {} }],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "seal", name: "seal", arguments: { strategy: "summary", report } }],
					stopReason: "toolUse",
				},
				{ content: ["continued"], stopReason: "stop" },
			],
			[completeTool as AgentTool],
		);
		lifecycleSession = harness.session;
		const startTodo = [{ name: "phase", tasks: [{ content: "verified", status: "in_progress" as const }] }];
		harness.session.setTodoPhases(startTodo);
		harness.session.sessionManager.appendCustomEntry("user_todo_edit", { phases: startTodo });
		let rawEvidence = "";
		const originalSave = harness.session.sessionManager.saveArtifact.bind(harness.session.sessionManager);
		harness.session.sessionManager.saveArtifact = async (content, type) => {
			if (type === "checkpoint-span") rawEvidence = content;
			return originalSave(content, type);
		};

		await harness.session.prompt("complete the phase");

		const branch = harness.session.sessionManager.getBranch();
		const todoIndex = branch.findLastIndex(entry => entry.type === "custom" && entry.customType === "user_todo_edit");
		const reportIndex = branch.findIndex(
			entry => entry.type === "custom_message" && entry.customType === "checkpoint-seal-report",
		);
		const manifestIndex = branch.findIndex(
			entry => entry.type === "custom_message" && entry.customType === "checkpoint-seal-manifest",
		);
		const completionIndex = branch.findLastIndex(
			entry =>
				entry.type === "custom_message" &&
				entry.customType === "checkpoint-seal" &&
				(entry.details as { strategy?: unknown } | undefined)?.strategy === "summary",
		);
		expect(todoIndex).toBeGreaterThan(-1);
		expect(reportIndex).toBeGreaterThan(todoIndex);
		expect(manifestIndex).toBeGreaterThan(reportIndex);
		expect(completionIndex).toBeGreaterThan(manifestIndex);
		expect(rawEvidence).toContain("complete_phase");
		expect(rawEvidence).toContain('"toolName": "seal"');
		expect(
			harness.session.messages.some(message => message.role === "toolResult" && message.toolName === "seal"),
		).toBe(false);
		expect(
			harness.session.messages.some(
				message => message.role === "custom" && message.customType === "checkpoint-seal-report",
			),
		).toBe(true);
		expect(harness.session.getTodoPhases()).toEqual(closeTodo);
		expect(harness.session.getCheckpointState()).toBeUndefined();

		const reportEntry = branch[reportIndex];
		if (!reportEntry) throw new Error("Expected summary seal report entry");
		harness.session.sessionManager.branch(reportEntry.id);
		const partialReload = await createReloadedSession(harness);
		expect(
			partialReload.messages.some(
				message => message.role === "custom" && message.customType === "checkpoint-seal-manifest",
			),
		).toBe(false);
		expect(
			partialReload.messages.some(
				message => message.role === "custom" && message.customType === "checkpoint-seal-report",
			),
		).toBe(true);
		expect(partialReload.getTodoPhases()).toEqual(closeTodo);
		expect(partialReload.getCheckpointState()).toBeDefined();

		const completionEntry = branch[completionIndex];
		if (!completionEntry) throw new Error("Expected summary seal completion entry");
		harness.session.sessionManager.branch(completionEntry.id);
		const completedReload = await createReloadedSession(harness);
		expect(completedReload.getTodoPhases()).toEqual(closeTodo);
		expect(completedReload.getCheckpointState()).toBeUndefined();
	});

	it("leaves the detailed branch active when summary evidence persistence fails", async () => {
		const report = {
			outcome: "Outcome",
			durableContext: [],
			decisions: [],
			verification: [],
			remaining: [],
			next: "Retry",
		};
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "checkpoint", name: "checkpoint", arguments: { goal: "safe" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "seal", name: "seal", arguments: { strategy: "summary", report } }],
				stopReason: "toolUse",
			},
		]);
		harness.session.sessionManager.saveArtifact = async () => undefined;

		await harness.session.prompt("seal safely");
		expect(harness.session.getCheckpointState()).toBeDefined();
		expect(
			harness.session.sessionManager
				.getBranch()
				.some(
					entry =>
						entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "seal",
				),
		).toBe(true);
		expect(
			harness.session.sessionManager
				.getBranch()
				.some(entry => entry.type === "custom_message" && entry.customType === "checkpoint-seal-report"),
		).toBe(false);
	});

	it("fails a shake seal closed when its strict checkpoint boundary is missing", async () => {
		let lifecycleSession: AgentSession | undefined;
		const corruptSchema = z.object({});
		const corruptTool: AgentTool<typeof corruptSchema> = {
			name: "corrupt_boundary",
			label: "Corrupt boundary",
			description: "Test a missing persisted boundary",
			parameters: corruptSchema,
			async execute() {
				if (!lifecycleSession) throw new Error("session unavailable");
				lifecycleSession.setCheckpointState({
					checkpointEntryId: "missing-entry",
					checkpointMessageCount: 0,
					startedAt: "2026-01-01T00:00:00.000Z",
				});
				return { content: [{ type: "text" as const, text: "boundary removed" }] };
			},
		};
		const harness = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "checkpoint", name: "checkpoint", arguments: { goal: "safe shake" } }],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "corrupt", name: "corrupt_boundary", arguments: {} }],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "seal", name: "seal", arguments: { strategy: "shake" } }],
					stopReason: "toolUse",
				},
			],
			[corruptTool as AgentTool],
		);
		lifecycleSession = harness.session;

		await harness.session.prompt("shake safely");

		expect(harness.session.getCheckpointState()?.checkpointEntryId).toBe("missing-entry");
		expect(
			harness.session.sessionManager
				.getBranch()
				.some(entry => entry.type === "custom_message" && entry.customType === "checkpoint-seal"),
		).toBe(false);
		expect(
			harness.session.sessionManager
				.getBranch()
				.some(
					entry =>
						entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "seal",
				),
		).toBe(true);
	});
});
