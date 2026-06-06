import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import backgroundLaneDescription from "../prompts/tools/background-lane.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import type {
	BackgroundLaneCloseInput,
	BackgroundLaneCloseResult,
	BackgroundLaneMessageInput,
	BackgroundLaneMessageResult,
	BackgroundLaneSnapshotResult,
	BackgroundLaneSpawnInput,
	BackgroundLaneSpawnResult,
} from "./manager";
import type { BackgroundLaneListItem } from "./state";

const laneContractSchema = z
	.object({
		question: z.string(),
		blocks_if: z.string(),
		required_before_parent: z.boolean(),
	})
	.strict();

const spawnSchema = z
	.object({
		op: z.literal("spawn"),
		from: z
			.object({
				checkpoint_id: z.string().optional(),
				source_ref: z.string(),
			})
			.strict(),
		contract: laneContractSchema,
		assignment: z.string(),
		agent: z.string().optional(),
	})
	.strict();

const listSchema = z.object({ op: z.literal("list") }).strict();

const messageSchema = z
	.object({
		op: z.literal("message"),
		lane_id: z.string(),
		message: z.string(),
	})
	.strict();

const snapshotSchema = z
	.object({
		op: z.literal("snapshot"),
		lane_id: z.string(),
	})
	.strict();

const closeSchema = z
	.object({
		op: z.literal("close"),
		lane_id: z.string(),
		outcome: z.enum(["merged", "dropped", "stale", "superseded", "no_release", "deferred"]),
		reason: z.string(),
		merged_source_ref: z.string().optional(),
		operator_statement: z.string().optional(),
	})
	.strict();

const backgroundLaneSchema = z.discriminatedUnion("op", [
	spawnSchema,
	listSchema,
	messageSchema,
	snapshotSchema,
	closeSchema,
]);
export type BackgroundLaneToolInput = z.infer<typeof backgroundLaneSchema>;

export type BackgroundLaneToolDetails =
	| { op: "spawn"; result: BackgroundLaneSpawnResult }
	| { op: "list"; lanes: BackgroundLaneListItem[] }
	| { op: "message"; result: BackgroundLaneMessageResult }
	| { op: "snapshot"; result: BackgroundLaneSnapshotResult }
	| { op: "close"; result: BackgroundLaneCloseResult };

interface BackgroundLaneSessionSupport {
	backgroundLaneSpawn?(input: BackgroundLaneSpawnInput, signal?: AbortSignal): Promise<BackgroundLaneSpawnResult>;
	backgroundLaneList?(): BackgroundLaneListItem[];
	backgroundLaneMessage?(
		input: BackgroundLaneMessageInput,
		signal?: AbortSignal,
	): Promise<BackgroundLaneMessageResult>;
	backgroundLaneSnapshot?(laneId: string, signal?: AbortSignal): Promise<BackgroundLaneSnapshotResult>;
	backgroundLaneClose?(input: BackgroundLaneCloseInput): Promise<BackgroundLaneCloseResult>;
}

function mapSpawn(input: z.infer<typeof spawnSchema>): BackgroundLaneSpawnInput {
	return {
		from: {
			checkpointId: input.from.checkpoint_id,
			sourceRef: input.from.source_ref,
		},
		contract: {
			question: input.contract.question,
			blocksIf: input.contract.blocks_if,
			requiredBeforeParent: input.contract.required_before_parent,
		},
		assignment: input.assignment,
		agent: input.agent,
	};
}

function mapClose(input: z.infer<typeof closeSchema>): BackgroundLaneCloseInput {
	return {
		laneId: input.lane_id,
		outcome: input.outcome,
		reason: input.reason,
		mergedSourceRef: input.merged_source_ref,
		operatorStatement: input.operator_statement,
	};
}

export class BackgroundLaneTool implements AgentTool<typeof backgroundLaneSchema, BackgroundLaneToolDetails> {
	readonly concurrency = "exclusive";
	readonly name = "background_lane";
	readonly label = "Background lane";
	readonly description = prompt.render(backgroundLaneDescription);
	readonly parameters = backgroundLaneSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession & BackgroundLaneSessionSupport;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: BackgroundLaneToolInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BackgroundLaneToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<BackgroundLaneToolDetails>> {
		if (params.op === "spawn") {
			if (!this.#session.backgroundLaneSpawn) throw new ToolError("background_lane.spawn is unavailable");
			const result = await this.#session.backgroundLaneSpawn(mapSpawn(spawnSchema.parse(params)), signal);
			return { content: [{ type: "text", text: renderSpawn(result) }], details: { op: "spawn", result } };
		}
		if (params.op === "list") {
			if (!this.#session.backgroundLaneList) throw new ToolError("background_lane.list is unavailable");
			const lanes = this.#session.backgroundLaneList();
			return { content: [{ type: "text", text: renderList(lanes) }], details: { op: "list", lanes } };
		}
		if (params.op === "message") {
			if (!this.#session.backgroundLaneMessage) throw new ToolError("background_lane.message is unavailable");
			const result = await this.#session.backgroundLaneMessage(
				{ laneId: params.lane_id, message: params.message },
				signal,
			);
			return { content: [{ type: "text", text: renderMessage(result) }], details: { op: "message", result } };
		}
		if (params.op === "snapshot") {
			if (!this.#session.backgroundLaneSnapshot) throw new ToolError("background_lane.snapshot is unavailable");
			const result = await this.#session.backgroundLaneSnapshot(params.lane_id, signal);
			return { content: [{ type: "text", text: renderSnapshot(result) }], details: { op: "snapshot", result } };
		}
		if (!this.#session.backgroundLaneClose) throw new ToolError("background_lane.close is unavailable");
		const result = await this.#session.backgroundLaneClose(mapClose(closeSchema.parse(params)));
		return { content: [{ type: "text", text: renderClose(result) }], details: { op: "close", result } };
	}
}

function renderSpawn(result: BackgroundLaneSpawnResult): string {
	const lane = result.lane;
	const lines = [
		`Background lane: ${lane.id}`,
		`Status: ${lane.status}`,
		`Question: ${lane.contract.question}`,
		`Required before parent: ${lane.contract.requiredBeforeParent}`,
		`Blocks if fired: ${lane.blocksIfFired}`,
	];
	if (lane.branch.name) lines.push(`Branch: ${lane.branch.name}`);
	if (lane.branch.worktreePath) lines.push(`Worktree: ${lane.branch.worktreePath}`);
	if (result.operationId) lines.push(`Child operation: ${result.operationId}`);
	if (result.spawnFailed && lane.spawnFailure)
		lines.push(`Spawn failed (${lane.spawnFailure.stage}): ${lane.spawnFailure.message}`);
	return lines.join("\n");
}

function renderList(lanes: BackgroundLaneListItem[]): string {
	if (lanes.length === 0) return "No background lanes.";
	return lanes
		.map(lane =>
			[
				`${lane.id}: ${lane.status}${lane.outcome ? `/${lane.outcome}` : ""}`,
				`agent=${lane.agentStatus}`,
				`required=${lane.requiredBeforeParent}`,
				`blocked=${lane.blocksIfFired}`,
				lane.branch ? `branch=${lane.branch}` : undefined,
				`question=${lane.question}`,
			]
				.filter((part): part is string => part !== undefined)
				.join(" | "),
		)
		.join("\n");
}

function renderMessage(result: BackgroundLaneMessageResult): string {
	return `Message sent to background lane ${result.lane.id}. Child operation: ${result.operationId}`;
}

function renderSnapshot(result: BackgroundLaneSnapshotResult): string {
	const lines = [
		`Background lane: ${result.lane.id}`,
		`Agent: ${result.agentStatus}`,
		`Status: ${result.lane.status}`,
		`Head: ${result.headSourceRef ?? "unknown"}`,
		`Changed files: ${result.changedFiles.length}`,
		`Blocks if fired: ${result.blocksIfFired}`,
	];
	if (result.branch) lines.push(`Branch: ${result.branch}`);
	if (result.worktreePath) lines.push(`Worktree: ${result.worktreePath}`);
	if (result.patchRef) lines.push(`Patch: ${result.patchRef}`);
	if (result.latestReportRef) lines.push(`Latest report: ${result.latestReportRef}`);
	return lines.join("\n");
}

function renderClose(result: BackgroundLaneCloseResult): string {
	const disposition = result.lane.closeDisposition;
	return `Background lane ${result.lane.id} closed: ${disposition?.outcome ?? result.lane.outcome ?? "closed"}. Parent truth was not mutated.`;
}
