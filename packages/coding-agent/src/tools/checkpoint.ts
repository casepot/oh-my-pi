import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import checkpointDescription from "../prompts/tools/checkpoint.md" with { type: "text" };
import keepCheckpointDescription from "../prompts/tools/keep-checkpoint.md" with { type: "text" };
import rewindDescription from "../prompts/tools/rewind.md" with { type: "text" };
import sealDescription from "../prompts/tools/seal.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

export interface CheckpointState {
	/** Number of in-memory messages at checkpoint (AFTER checkpoint tool result is appended) */
	checkpointMessageCount: number;
	/** Session entry ID at checkpoint (for session tree branching) */
	checkpointEntryId: string | null;
	/** Timestamp */
	startedAt: string;
}

export interface CompletedRewindState {
	/** Report retained after a successful rewind. */
	report: string;
	/** Timestamp for the checkpoint that was rewound. */
	startedAt: string;
	/** Timestamp when the rewind completed. */
	rewoundAt: string;
}

const checkpointSchema = type({
	goal: type("string").describe("investigation goal"),
});

type CheckpointParams = typeof checkpointSchema.infer;

const rewindSchema = type({
	report: type("string").describe("investigation findings"),
});

type RewindParams = typeof rewindSchema.infer;
const sealDecisionSchema = type({
	decision: type("string").describe("durable decision"),
	reason: type("string").describe("reason for the decision"),
});

const sealVerificationSchema = type({
	contract: type("string").describe("verified contract"),
	evidence: type("string").describe("observed evidence"),
});

export const sealReportSchema = type({
	outcome: type("string").describe("completed outcome"),
	durableContext: type("string[]").describe("context required for continuation"),
	decisions: sealDecisionSchema.array().describe("durable decisions and reasons"),
	verification: sealVerificationSchema.array().describe("verified contracts and evidence"),
	remaining: type("string[]").describe("unresolved work or risks"),
	next: type("string").describe("recommended next action"),
});

const sealSchema = type({
	report: sealReportSchema,
});

export type SealReport = typeof sealReportSchema.infer;
type SealParams = typeof sealSchema.infer;

const keepCheckpointSchema = type({
	reason: type("string").describe("reason detailed trajectory must remain available"),
});

type KeepCheckpointParams = typeof keepCheckpointSchema.infer;

export interface CheckpointToolDetails {
	goal: string;
	startedAt: string;
	meta?: OutputMeta;
}

export interface RewindToolDetails {
	report: string;
	rewound: boolean;
	meta?: OutputMeta;
}
export interface SealToolDetails {
	disposition: "seal";
	report: SealReport;
	meta?: OutputMeta;
}

export interface KeepCheckpointToolDetails {
	disposition: "keep";
	reason: string;
	meta?: OutputMeta;
}

function isTopLevelSession(session: ToolSession): boolean {
	const depth = session.taskDepth;
	return depth === undefined || depth === 0;
}

export class CheckpointTool implements AgentTool<typeof checkpointSchema, CheckpointToolDetails> {
	readonly name = "checkpoint";
	readonly approval = "read" as const;
	readonly label = "Checkpoint";
	readonly summary = "Open a neutral checkpoint span that must later be rewound, sealed, or kept";
	readonly description: string;
	readonly parameters = checkpointSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<CheckpointParams>) => (args.goal ? `checkpointing: ${args.goal}` : "checkpointing");

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(checkpointDescription);
	}

	static createIf(session: ToolSession): CheckpointTool | null {
		if (!isTopLevelSession(session)) return null;
		return new CheckpointTool(session);
	}

	async execute(
		_toolCallId: string,
		params: CheckpointParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CheckpointToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CheckpointToolDetails>> {
		if (!isTopLevelSession(this.session)) {
			throw new ToolError("Checkpoint not available in subagents.");
		}
		if (this.session.getCheckpointState?.()) {
			throw new ToolError("Checkpoint already active.");
		}
		const startedAt = new Date().toISOString();
		return toolResult<CheckpointToolDetails>({ goal: params.goal, startedAt })
			.text(
				[
					"Checkpoint created.",
					`Goal: ${params.goal}`,
					"Complete the span, then close it with rewind, seal, or keep_checkpoint.",
				].join("\n"),
			)
			.done();
	}
}

export class RewindTool implements AgentTool<typeof rewindSchema, RewindToolDetails> {
	readonly name = "rewind";
	readonly approval = "read" as const;
	readonly label = "Rewind";
	readonly summary = "Rewind to a previously created checkpoint";
	readonly description: string;
	readonly parameters = rewindSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (): string => "rewinding";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(rewindDescription);
	}

	static createIf(session: ToolSession): RewindTool | null {
		if (!isTopLevelSession(session)) return null;
		return new RewindTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RewindParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RewindToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<RewindToolDetails>> {
		if (!isTopLevelSession(this.session)) {
			throw new ToolError("Checkpoint not available in subagents.");
		}
		if (!this.session.getCheckpointState?.()) {
			if (this.session.getLastCompletedRewind?.()) {
				throw new ToolError(
					"Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
				);
			}
			throw new ToolError("No active checkpoint. Create a checkpoint before calling rewind.");
		}
		const report = params.report.trim();
		if (report.length === 0) {
			throw new ToolError("Report cannot be empty.");
		}
		return toolResult<RewindToolDetails>({ report, rewound: true })
			.text(["Rewind requested.", "Report captured for context replacement."].join("\n"))
			.done();
	}
}

function normalizeSealReport(report: SealReport): SealReport {
	const outcome = report.outcome.trim();
	const next = report.next.trim();
	const durableContext = report.durableContext.map(item => item.trim());
	const remaining = report.remaining.map(item => item.trim());
	const decisions = report.decisions.map(item => ({
		decision: item.decision.trim(),
		reason: item.reason.trim(),
	}));
	const verification = report.verification.map(item => ({
		contract: item.contract.trim(),
		evidence: item.evidence.trim(),
	}));
	if (
		!outcome ||
		!next ||
		durableContext.some(item => !item) ||
		remaining.some(item => !item) ||
		decisions.some(item => !item.decision || !item.reason) ||
		verification.some(item => !item.contract || !item.evidence)
	) {
		throw new ToolError("Summary seal report fields cannot contain blank text.");
	}
	return { outcome, durableContext, decisions, verification, remaining, next };
}

export class SealTool implements AgentTool<typeof sealSchema, SealToolDetails> {
	readonly name = "seal";
	readonly approval = "read" as const;
	readonly label = "Seal";
	readonly summary = "Accept and compact an active checkpoint span";
	readonly description: string;
	readonly parameters = sealSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (): string => "sealing checkpoint";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(sealDescription);
	}

	static createIf(session: ToolSession): SealTool | null {
		if (!isTopLevelSession(session)) return null;
		return new SealTool(session);
	}

	async execute(
		_toolCallId: string,
		params: SealParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SealToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SealToolDetails>> {
		if (!isTopLevelSession(this.session)) {
			throw new ToolError("Checkpoint not available in subagents.");
		}
		if (!this.session.getCheckpointState?.()) {
			throw new ToolError("No active checkpoint. Create a checkpoint before calling seal.");
		}
		const report = normalizeSealReport(params.report);
		return toolResult<SealToolDetails>({
			disposition: "seal",
			report,
		})
			.text("Seal requested. Structured continuation report captured.")
			.done();
	}
}

export class KeepCheckpointTool implements AgentTool<typeof keepCheckpointSchema, KeepCheckpointToolDetails> {
	readonly name = "keep_checkpoint";
	readonly approval = "read" as const;
	readonly label = "Keep Checkpoint";
	readonly summary = "Close an active checkpoint without compacting its trajectory";
	readonly description: string;
	readonly parameters = keepCheckpointSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (): string => "keeping checkpoint trajectory";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(keepCheckpointDescription);
	}

	static createIf(session: ToolSession): KeepCheckpointTool | null {
		if (!isTopLevelSession(session)) return null;
		return new KeepCheckpointTool(session);
	}

	async execute(
		_toolCallId: string,
		params: KeepCheckpointParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<KeepCheckpointToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<KeepCheckpointToolDetails>> {
		if (!isTopLevelSession(this.session)) {
			throw new ToolError("Checkpoint not available in subagents.");
		}
		if (!this.session.getCheckpointState?.()) {
			throw new ToolError("No active checkpoint. Create a checkpoint before calling keep_checkpoint.");
		}
		const reason = params.reason.trim();
		if (reason.length === 0) {
			throw new ToolError("Reason cannot be empty.");
		}
		return toolResult<KeepCheckpointToolDetails>({ disposition: "keep", reason })
			.text("Keep requested. Detailed checkpoint trajectory will remain active.")
			.done();
	}
}
