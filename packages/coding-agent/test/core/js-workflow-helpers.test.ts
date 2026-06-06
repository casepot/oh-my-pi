import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs, type JsResult } from "../../src/eval/js/executor";

function statusEvents(result: JsResult) {
	return result.displayOutputs.filter(
		(output): output is Extract<JsResult["displayOutputs"][number], { type: "status" }> => output.type === "status",
	);
}

function baseSession(cwd: string, sessionFile: string, extra?: Partial<ToolSession>): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		...extra,
	} as ToolSession;
}

describe("executeJs workflow helpers", () => {
	let tempDir: TempDir;
	let sessionFile: string;

	beforeAll(() => {
		tempDir = TempDir.createSync("@js-workflow-helpers-");
		sessionFile = path.join(tempDir.path(), "session.jsonl");
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		tempDir.removeSync();
	});

	it("emits log and phase status events", async () => {
		const session = baseSession(tempDir.path(), sessionFile);
		const result = await executeJs('log("hello"); phase("Scan");', {
			sessionId: `js-logphase:${tempDir.path()}`,
			session,
			sessionFile,
		});
		expect(result.exitCode).toBe(0);
		const events = statusEvents(result);
		const log = events.find(e => e.event.op === "log");
		const phase = events.find(e => e.event.op === "phase");
		expect(log?.event.message).toBe("hello");
		expect(phase?.event.title).toBe("Scan");
	});

	it("reads the turn budget from Goal Mode via the __budget__ bridge", async () => {
		const session = baseSession(tempDir.path(), sessionFile, {
			getGoalModeState: () => ({
				enabled: true,
				mode: "active",
				runMode: "working-target",
				stateVersion: 1,
				parentFrameVersion: 0,
				goal: {
					id: "g1",
					objective: "x",
					status: "active",
					tokenBudget: 100_000,
					tokensUsed: 4_200,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			}),
		});
		const result = await executeJs(
			"return JSON.stringify([await budget.total(), await budget.spent(), await budget.remaining()]);",
			{ sessionId: `js-budget-goal:${tempDir.path()}`, session, sessionFile },
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("[100000,4200,95800]");
	});

	it("falls back to session output tokens with no ceiling when Goal Mode is inactive", async () => {
		const session = baseSession(tempDir.path(), sessionFile, {
			getUsageStatistics: () => ({
				input: 10,
				output: 777,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		});
		const result = await executeJs(
			"return JSON.stringify([await budget.total(), await budget.spent(), (await budget.remaining()) === Infinity]);",
			{ sessionId: `js-budget-usage:${tempDir.path()}`, session, sessionFile },
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("[null,777,true]");
	});
	it("supports positional read offsets and local line selectors", async () => {
		const filePath = path.join(tempDir.path(), "lines.txt");
		await Bun.write(filePath, "a\nb\nc\nd\n");
		const session = baseSession(tempDir.path(), sessionFile);

		const result = await executeJs(
			'const positional = await read("lines.txt", 2, 2); const selector = await read("lines.txt:3-4"); return JSON.stringify([positional, selector]);',
			{ sessionId: `js-read:${tempDir.path()}`, session, sessionFile, cwd: tempDir.path() },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual(["b\nc", "c\nd"]);
	});

	it("parallel_settled preserves sibling successes and failure order", async () => {
		const session = baseSession(tempDir.path(), sessionFile);
		const result = await executeJs(
			'const r = await parallel_settled([async () => "a", async () => { throw new Error("boom"); }, async () => "c"]); return JSON.stringify(r);',
			{ sessionId: `js-settled:${tempDir.path()}`, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual([
			{ status: "fulfilled", value: "a" },
			{ status: "rejected", reason: "boom", error_type: "Error" },
			{ status: "fulfilled", value: "c" },
		]);
	});

	it("parallel throws after siblings settle so side effects are not dropped mid-flight", async () => {
		const session = baseSession(tempDir.path(), sessionFile);
		const result = await executeJs(
			[
				"const seen = [];",
				"try {",
				"  await parallel([",
				"    async () => { throw new Error('boom'); },",
				"    async () => { await Bun.sleep(20); seen.push('sibling'); },",
				"  ], { concurrency: 2 });",
				"} catch (error) { seen.push(error.message); }",
				"return JSON.stringify(seen);",
			].join("\n"),
			{ sessionId: `js-parallel-error-settles:${tempDir.path()}`, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual(["sibling", "boom"]);
	});

	it("normalizes null optional tool fields only when omission validates", async () => {
		const seen: unknown[] = [];
		const captureSchema = z
			.object({
				_i: z.string().optional(),
				skip: z.number().optional(),
				intentional: z.null().optional(),
			})
			.strict();
		const captureTool: AgentTool<typeof captureSchema> = {
			name: "capture",
			label: "Capture",
			description: "Capture arguments",
			parameters: captureSchema,
			strict: true,
			execute: async (_id, params) => {
				seen.push(params);
				return { content: [{ type: "text", text: JSON.stringify(params) }] };
			},
		};
		const session = baseSession(tempDir.path(), sessionFile, {
			getToolByName: name => (name === "capture" ? captureTool : undefined),
		});

		const result = await executeJs("return await tool.capture({ skip: null, intentional: null });", {
			sessionId: `js-tool-null:${tempDir.path()}`,
			session,
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual({ _i: "js prelude", intentional: null });
		expect(seen).toEqual([{ _i: "js prelude", intentional: null }]);
	});
});
