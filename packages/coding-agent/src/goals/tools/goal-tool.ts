import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { replaceTabs, Text } from "@oh-my-pi/pi-tui";
import { formatNumber, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme, ThemeColor } from "../../modes/theme/theme";
import goalDescription from "../../prompts/tools/goal.md" with { type: "text" };
import { formatDuration } from "../../slash-commands/helpers/format";
import type { ToolSession } from "../../tools";
import { formatErrorDetail, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { ToolError } from "../../tools/tool-errors";
import { renderStatusLine, truncateToWidth } from "../../tui";
import {
	completionBudgetReport,
	type GoalCheckpointInput,
	type GoalCheckpointResolutionInput,
	type GoalStartTargetInput,
	remainingTokens,
} from "../runtime";
import type {
	Goal,
	GoalBoundaryKind,
	GoalCheckpointPacket,
	GoalCheckpointResolution,
	GoalCheckpointReview,
	GoalCompletionVerificationDetails,
	GoalGateStatus,
	GoalModeState,
	GoalParentFrame,
	GoalParentStateDelta,
	GoalRefKind,
	GoalResidualClassification,
	GoalStatus,
	GoalToolDetails,
} from "../state";
import { normalizeParentFrame } from "../state";

const deliverableStatusSchema = z.enum(["pending", "partial", "satisfied", "blocked", "stale"]);

const refKindSchema = z.enum(["doc", "issue", "artifact", "test", "commit", "external-record", "other"]);
const refSchema = z
	.object({
		id: z.string(),
		kind: refKindSchema,
		label: z.string().optional(),
		uri: z.string().optional(),
	})
	.strict();
const deliverableDeltaSchema = z
	.object({
		id: z.string(),
		summary: z.string().optional(),
		status: deliverableStatusSchema.optional(),
		evidence_refs: z.array(refSchema).optional(),
		blocked_by: z.array(z.string()).optional(),
		next_relevant_target: z.string().optional(),
	})
	.strict();

const claimSchema = z
	.object({
		id: z.string(),
		claim: z.string(),
		status: z.enum(["accepted", "candidate", "rejected", "stale"]),
		scope: z.string().optional(),
		evidence_refs: z.array(refSchema).optional(),
		non_implications: z.array(z.string()).optional(),
		accepted_by: z.string().optional(),
		accepted_at: z.number().optional(),
	})
	.strict();

const boundarySchema = z
	.object({
		id: z.string(),
		kind: z.enum([
			"non-claim",
			"forbidden-inference",
			"unsupported",
			"local-only",
			"mock-only",
			"unavailable",
			"stale-path",
		]),
		statement: z.string(),
		refs: z.array(refSchema).optional(),
	})
	.strict();

const residualSchema = z
	.object({
		id: z.string(),
		statement: z.string(),
		classification: z.enum([
			"current-parent-blocker",
			"accepted-risk",
			"future-frontier",
			"decision-needed",
			"architecture-debt",
			"anti-laundering-non-claim",
			"local-shortcut",
			"capability-gap",
			"rejected-or-stale-path",
			"unspecified",
		]),
		why_it_matters: z.string().optional(),
		required_evidence: z.array(z.string()).optional(),
		target_horizon: z.string().optional(),
		authority_required: z.string().optional(),
		non_implications: z.array(z.string()).optional(),
		refs: z.array(refSchema).optional(),
	})
	.strict();

const gateSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		status: z.enum(["unknown", "passed", "failed", "stale", "not-applicable"]),
		required_evidence: z.array(z.string()),
		evidence_refs: z.array(refSchema).optional(),
		non_claims: z.array(z.string()).optional(),
		stale_if: z.array(z.string()).optional(),
	})
	.strict();

const frontierSchema = z
	.object({
		id: z.string(),
		statement: z.string(),
		evidence_required: z.array(z.string()).optional(),
		activation_trigger: z.string().optional(),
		refs: z.array(refSchema).optional(),
	})
	.strict();

const parentFrameSchema = z
	.object({
		kind: z.enum(["plain", "claim-gated"]).optional(),
		desired_future: z.string().optional(),
		current_truth: z.string().optional(),
		baseline_refs: z.array(refSchema).optional(),
		accepted_claims: z.array(claimSchema).optional(),
		candidate_claims: z.array(claimSchema).optional(),
		rejected_or_stale_claims: z.array(claimSchema).optional(),
		boundaries: z.array(boundarySchema).optional(),
		residuals: z.array(residualSchema).optional(),
		gates: z.array(gateSchema).optional(),
		frontier: z.array(frontierSchema).optional(),
		stale_if: z.array(z.string()).optional(),
		authority: z
			.object({
				parent_state_authority: z.string().optional(),
				risk_acceptance_authority: z.string().optional(),
				external_record_authority: z.string().optional(),
				worker_may_only_propose: z.boolean().optional(),
			})
			.strict()
			.optional(),
		external_refs: z.array(refSchema).optional(),
		last_parent_delta_id: z.string().optional(),
	})
	.strict();

const evidenceSchema = z
	.object({
		claim: z.string(),
		evidence: z.string(),
		current: z.boolean(),
	})
	.strict();

const targetFields = {
	title: z.string(),
	desired_future_claim: z.string(),
	closure_standard: z.string(),
	expected_parent_contribution: z.string().optional(),
	baseline_refs: z.array(refSchema).optional(),
	gate_refs: z.array(z.string()).optional(),
	evidence_expectation: z.array(z.string()).optional(),
	non_goals: z.array(z.string()).optional(),
	forbidden_claims: z.array(z.string()).optional(),
	stale_if: z.array(z.string()).optional(),
	linked_verifier_blocker_ids: z.array(z.string()).optional(),
	parent_deliverable_ids: z.array(z.string()).optional(),
};
const targetSchema = z.object(targetFields).strict();
const resolveTargetSchema = z.object(targetFields);
const emptyTargetSchema = z.record(z.string(), z.never());
const maybeTargetSchema = z.union([resolveTargetSchema, emptyTargetSchema]);
type TargetParams = z.infer<typeof targetSchema>;
type MaybeTargetParams = z.infer<typeof maybeTargetSchema>;

function hasNonWhitespace(value: string | undefined): boolean {
	if (!value) return false;
	for (let index = 0; index < value.length; index++) {
		const char = value.charCodeAt(index);
		if (char !== 9 && char !== 10 && char !== 11 && char !== 12 && char !== 13 && char !== 32) return true;
	}
	return false;
}

function hasArrayEntries(value: readonly unknown[] | undefined): boolean {
	return value !== undefined && value.length > 0;
}

function isTargetParams(value: MaybeTargetParams): value is TargetParams {
	return "title" in value && "desired_future_claim" in value && "closure_standard" in value;
}

function isEffectivelyEmptyTarget(value: MaybeTargetParams): boolean {
	if (!isTargetParams(value)) return true;
	return (
		!hasNonWhitespace(value.title) &&
		!hasNonWhitespace(value.desired_future_claim) &&
		!hasNonWhitespace(value.closure_standard) &&
		!hasNonWhitespace(value.expected_parent_contribution) &&
		!hasArrayEntries(value.baseline_refs) &&
		!hasArrayEntries(value.gate_refs) &&
		!hasArrayEntries(value.evidence_expectation) &&
		!hasArrayEntries(value.non_goals) &&
		!hasArrayEntries(value.forbidden_claims) &&
		!hasArrayEntries(value.stale_if) &&
		!hasArrayEntries(value.linked_verifier_blocker_ids) &&
		!hasArrayEntries(value.parent_deliverable_ids)
	);
}

const gateDeltaSchema = z
	.object({
		gate_id: z.string(),
		status: z.enum(["unknown", "passed", "failed", "stale", "not-applicable"]),
		evidence_refs: z.array(refSchema).optional(),
		rationale: z.string().optional(),
	})
	.strict();

const backgroundLaneSpawnRequestSchema = z
	.object({
		from: z
			.object({
				checkpoint_id: z.string().optional(),
				source_ref: z.string(),
			})
			.strict(),
		contract: z
			.object({
				question: z.string(),
				blocks_if: z.string(),
				required_before_parent: z.boolean(),
			})
			.strict(),
		assignment: z.string(),
		agent: z.string().optional(),
	})
	.strict();

const parentDeltaSchema = z
	.object({
		admitted_claims: z.array(claimSchema).optional(),
		candidate_claims_added: z.array(claimSchema).optional(),
		rejected_claims: z.array(claimSchema).optional(),
		boundaries_added: z.array(boundarySchema).optional(),
		residuals_added_or_updated: z.array(residualSchema).optional(),
		gate_deltas: z.array(gateDeltaSchema).optional(),
		frontier_deltas: z.array(frontierSchema).optional(),
		stale_refs: z.array(refSchema).optional(),
		external_record_refs: z.array(refSchema).optional(),
		authority_decision_refs: z.array(refSchema).optional(),
		background_lanes_to_spawn: z.array(backgroundLaneSpawnRequestSchema).optional(),
		deliverable_deltas: z.array(deliverableDeltaSchema).optional(),
	})
	.strict();

const createSchema = z
	.object({
		op: z.literal("create"),
		objective: z.string().describe("parent goal objective"),
		token_budget: z.number().int().describe("token budget").optional(),
		parent_frame: parentFrameSchema.optional(),
	})
	.strict();
const getSchema = z.object({ op: z.literal("get") }).strict();
const resumeSchema = z.object({ op: z.literal("resume") }).strict();
const dropSchema = z.object({ op: z.literal("drop") }).strict();
const completeSchema = z.object({ op: z.literal("complete") }).strict();
const startTargetSchema = targetSchema.extend({ op: z.literal("start_target") }).strict();
const checkpointSchema = z
	.object({
		op: z.literal("checkpoint"),
		status: z.literal("closed_with_evidence"),
		summary: z.string(),
		local_claims: z.array(z.string()).min(1),
		evidence: z.array(evidenceSchema).min(1),
		not_claimed: z.array(z.string()).min(1),
		remaining_questions: z.array(z.string()).min(1),
		checks_run: z.array(z.string()).optional(),
		artifacts_touched: z.array(z.string()).optional(),
		risks_or_caveats: z.array(z.string()).optional(),
		stale_if: z.array(z.string()).optional(),
		suggested_controller_questions: z.array(z.string()).optional(),
		retrospective_target: targetSchema.optional(),
	})
	.strict();
const resolveCheckpointSchema = z
	.object({
		op: z.literal("resolve_checkpoint"),
		checkpoint_id: z.string(),
		decision: z.enum([
			"next_target",
			"parent_completion_candidate",
			"needs_user_input",
			"needs_broader_checks",
			"pause_for_external_control",
			"drop_or_replace_recommended",
		]),
		parent_reading: z.string(),
		parent_delta: parentDeltaSchema.optional(),
		not_propagated: z.array(z.string()),
		remaining_parent_work: z.array(z.string()),
		broader_checks_or_inputs: z.array(z.string()).optional(),
		lessons_for_future: z.array(z.string()).optional(),
		next_target: maybeTargetSchema.optional(),
	})
	.strict()
	.refine(
		value =>
			value.decision !== "next_target" || (value.next_target !== undefined && isTargetParams(value.next_target)),
		{
			message: "next_target is required when decision is next_target",
			path: ["next_target"],
		},
	)
	.refine(
		value =>
			value.decision === "next_target" ||
			value.next_target === undefined ||
			isEffectivelyEmptyTarget(value.next_target),
		{
			message: "next_target is only allowed when decision is next_target",
			path: ["next_target"],
		},
	);

const goalDiscriminatedSchema = z.discriminatedUnion("op", [
	createSchema,
	getSchema,
	resumeSchema,
	dropSchema,
	completeSchema,
	startTargetSchema,
	checkpointSchema,
	resolveCheckpointSchema,
]);

const goalSchema = goalDiscriminatedSchema;

export type GoalToolInput = z.infer<typeof goalSchema>;

interface GoalSessionSupport {
	createGoalWithRubric?(
		input: { objective: string; tokenBudget?: number; parentFrame?: GoalParentFrame },
		signal?: AbortSignal,
	): Promise<GoalModeState>;
	requestGoalCompletion?(signal?: AbortSignal): Promise<GoalToolResponse>;
	requestGoalCheckpoint?(input: GoalCheckpointInput, signal?: AbortSignal): Promise<GoalToolResponse>;
	requestGoalCheckpointResolution?(
		input: GoalCheckpointResolutionInput,
		signal?: AbortSignal,
	): Promise<GoalToolResponse>;
}

export interface GoalToolResponse {
	goal: Goal | null;
	state?: GoalModeState | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
	completionVerification?: GoalCompletionVerificationDetails;
	checkpoint?: GoalCheckpointPacket;
	checkpointReview?: GoalCheckpointReview;
	checkpointResolution?: GoalCheckpointResolution;
}

export function buildGoalToolResponse(
	goal: Goal | null | undefined,
	options?: {
		state?: GoalModeState | null;
		includeCompletionReport?: boolean;
		completionVerification?: GoalCompletionVerificationDetails;
		checkpoint?: GoalCheckpointPacket;
		checkpointReview?: GoalCheckpointReview;
		checkpointResolution?: GoalCheckpointResolution;
	},
): GoalToolResponse {
	const resolvedGoal = goal ?? null;
	const completionVerification = normalizeCompletionVerification(resolvedGoal, options?.completionVerification);
	const completionBudget =
		completionVerification?.status === "rejected"
			? null
			: options?.includeCompletionReport && resolvedGoal?.status === "complete"
				? completionBudgetReport(resolvedGoal)
				: null;
	return {
		goal: resolvedGoal,
		state: options?.state,
		remainingTokens: remainingTokens(resolvedGoal),
		completionBudgetReport: completionBudget,
		completionVerification,
		checkpoint: options?.checkpoint,
		checkpointReview: options?.checkpointReview,
		checkpointResolution: options?.checkpointResolution,
	};
}

function normalizeCompletionVerification(
	goal: Goal | null,
	completionVerification: GoalCompletionVerificationDetails | undefined,
): GoalCompletionVerificationDetails | undefined {
	if (!completionVerification) return undefined;
	const { continuationMessage: _continuationMessage, ...visibleVerification } = completionVerification;
	if (
		visibleVerification.status === "rejected" &&
		!visibleVerification.compactorMemo &&
		goal?.lastVerificationCompactorMemo
	) {
		return { ...visibleVerification, compactorMemo: goal.lastVerificationCompactorMemo };
	}
	return visibleVerification;
}

function validateCreateParams(params: z.infer<typeof createSchema>): {
	objective: string;
	tokenBudget?: number;
	parentFrame?: GoalParentFrame;
} {
	const objective = params.objective?.trim();
	if (!objective) throw new ToolError("objective is required when op=create");
	const tokenBudget = params.token_budget;
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new ToolError("token_budget must be a positive integer when provided");
	}
	return { objective, tokenBudget, parentFrame: normalizeParentFrame(params.parent_frame, objective) };
}

function mapTargetInput(params: z.infer<typeof targetSchema>): GoalStartTargetInput {
	return {
		title: params.title,
		desiredFutureClaim: params.desired_future_claim,
		closureStandard: params.closure_standard,
		expectedParentContribution: params.expected_parent_contribution,
		baselineRefs: params.baseline_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		gateRefs: params.gate_refs,
		evidenceExpectation: params.evidence_expectation,
		nonGoals: params.non_goals,
		forbiddenClaims: params.forbidden_claims,
		staleIf: params.stale_if,
		linkedVerifierBlockerIds: params.linked_verifier_blocker_ids,
		parentDeliverableIds: params.parent_deliverable_ids,
	};
}

function mapCheckpointInput(params: z.infer<typeof checkpointSchema>): GoalCheckpointInput {
	return {
		status: params.status,
		summary: params.summary,
		localClaims: params.local_claims,
		evidence: params.evidence.map(item => ({ ...item })),
		notClaimed: params.not_claimed,
		remainingQuestions: params.remaining_questions,
		checksRun: params.checks_run,
		artifactsTouched: params.artifacts_touched,
		risksOrCaveats: params.risks_or_caveats,
		staleIf: params.stale_if,
		suggestedControllerQuestions: params.suggested_controller_questions,
		retrospectiveTarget: params.retrospective_target ? mapTargetInput(params.retrospective_target) : undefined,
	};
}

function mapParentDelta(input: z.infer<typeof parentDeltaSchema> | undefined): GoalParentStateDelta | undefined {
	if (!input) return undefined;
	return {
		admittedClaims: (input.admitted_claims ?? []).map(claim => ({
			id: claim.id,
			claim: claim.claim,
			status: claim.status,
			scope: claim.scope,
			evidenceRefs: claim.evidence_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
			nonImplications: claim.non_implications,
			acceptedBy: claim.accepted_by,
			acceptedAt: claim.accepted_at,
		})),
		candidateClaimsAdded: (input.candidate_claims_added ?? []).map(claim => ({
			id: claim.id,
			claim: claim.claim,
			status: claim.status,
			scope: claim.scope,
			evidenceRefs: claim.evidence_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
			nonImplications: claim.non_implications,
		})),
		rejectedClaims: (input.rejected_claims ?? []).map(claim => ({
			id: claim.id,
			claim: claim.claim,
			status: claim.status,
			scope: claim.scope,
			evidenceRefs: claim.evidence_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
			nonImplications: claim.non_implications,
		})),
		boundariesAdded: (input.boundaries_added ?? []).map(boundary => ({
			id: boundary.id,
			kind: boundary.kind as GoalBoundaryKind,
			statement: boundary.statement,
			refs: boundary.refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		})),
		residualsAddedOrUpdated: (input.residuals_added_or_updated ?? []).map(residual => ({
			id: residual.id,
			statement: residual.statement,
			classification: residual.classification as GoalResidualClassification,
			whyItMatters: residual.why_it_matters,
			requiredEvidence: residual.required_evidence,
			targetHorizon: residual.target_horizon,
			authorityRequired: residual.authority_required,
			nonImplications: residual.non_implications,
			refs: residual.refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		})),
		gateDeltas: (input.gate_deltas ?? []).map(gate => ({
			gateId: gate.gate_id,
			status: gate.status as GoalGateStatus,
			evidenceRefs: gate.evidence_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
			rationale: gate.rationale,
		})),
		frontierDeltas: (input.frontier_deltas ?? []).map(item => ({
			id: item.id,
			statement: item.statement,
			evidenceRequired: item.evidence_required,
			activationTrigger: item.activation_trigger,
			refs: item.refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		})),
		staleRefs: (input.stale_refs ?? []).map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		externalRecordRefs: (input.external_record_refs ?? []).map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		authorityDecisionRefs: input.authority_decision_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
		backgroundLanesToSpawn: input.background_lanes_to_spawn?.map(lane => ({
			from: {
				checkpointId: lane.from.checkpoint_id,
				sourceRef: lane.from.source_ref,
			},
			contract: {
				question: lane.contract.question,
				blocksIf: lane.contract.blocks_if,
				requiredBeforeParent: lane.contract.required_before_parent,
			},
			assignment: lane.assignment,
			agent: lane.agent,
		})),
		deliverableDeltas: input.deliverable_deltas?.map(item => ({
			id: item.id,
			summary: item.summary,
			status: item.status,
			evidenceRefs: item.evidence_refs?.map(ref => ({ ...ref, kind: ref.kind as GoalRefKind })),
			blockedBy: item.blocked_by,
			nextRelevantTarget: item.next_relevant_target,
		})),
	};
}

function mapResolutionInput(params: z.infer<typeof resolveCheckpointSchema>): GoalCheckpointResolutionInput {
	return {
		checkpointId: params.checkpoint_id,
		decision: params.decision,
		parentReading: params.parent_reading,
		parentDelta: mapParentDelta(params.parent_delta),
		notPropagated: params.not_propagated,
		remainingParentWork: params.remaining_parent_work,
		broaderChecksOrInputs: params.broader_checks_or_inputs,
		lessonsForFuture: params.lessons_for_future,
		nextTarget:
			params.decision === "next_target" && params.next_target && isTargetParams(params.next_target)
				? mapTargetInput(params.next_target)
				: undefined,
	};
}

export class GoalTool implements AgentTool<typeof goalSchema, GoalToolDetails> {
	readonly concurrency = "exclusive";
	readonly name = "goal";
	readonly label = "Goal";
	readonly description = prompt.render(goalDescription);
	readonly parameters = goalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: GoalToolInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const runtime = this.#session.getGoalRuntime?.();
		if (!runtime) throw new ToolError("Goal mode is not active.");

		const goalSession: ToolSession & GoalSessionSupport = this.#session;
		let response: GoalToolResponse;
		if (params.op === "create") {
			const createInput = validateCreateParams(createSchema.parse(params));
			const created = goalSession.createGoalWithRubric
				? await goalSession.createGoalWithRubric(createInput, signal)
				: await runtime.createGoal(createInput);
			response = buildGoalToolResponse(created.goal, { state: created });
		} else if (params.op === "get") {
			const state = this.#session.getGoalModeState?.();
			response = buildGoalToolResponse(state?.goal ?? null, { state: state ?? null });
		} else if (params.op === "resume") {
			const resumed = await runtime.resumeGoal();
			response = buildGoalToolResponse(resumed.goal, { state: resumed });
		} else if (params.op === "drop") {
			const dropped = await runtime.dropGoal();
			response = buildGoalToolResponse(dropped ?? null, { state: null });
		} else if (params.op === "start_target") {
			const state = await runtime.startTarget(mapTargetInput(startTargetSchema.parse(params)));
			response = buildGoalToolResponse(state.goal, { state });
		} else if (params.op === "checkpoint") {
			const input = mapCheckpointInput(checkpointSchema.parse(params));
			if (!goalSession.requestGoalCheckpoint) {
				throw new ToolError("checkpoint requires an AgentSession checkpoint review handler");
			}
			response = await goalSession.requestGoalCheckpoint(input, signal);
		} else if (params.op === "resolve_checkpoint") {
			const input = mapResolutionInput(resolveCheckpointSchema.parse(params));
			response = goalSession.requestGoalCheckpointResolution
				? await goalSession.requestGoalCheckpointResolution(input, signal)
				: (() => {
						throw new ToolError("resolve_checkpoint requires an AgentSession checkpoint resolution handler");
					})();
		} else {
			response = goalSession.requestGoalCompletion
				? await goalSession.requestGoalCompletion(signal)
				: buildGoalToolResponse(await runtime.completeGoalFromTool(), { includeCompletionReport: true });
		}
		const completionVerification = normalizeCompletionVerification(response.goal, response.completionVerification);
		if (completionVerification !== response.completionVerification)
			response = { ...response, completionVerification };
		return {
			content: [{ type: "text", text: renderGoalToolText(response, params.op) }],
			details: {
				op: params.op,
				goal: response.goal,
				state: response.state ?? null,
				remainingTokens: response.remainingTokens,
				completionBudgetReport:
					response.completionVerification?.status === "rejected" ? null : response.completionBudgetReport,
				completionVerification: response.completionVerification,
				checkpoint: response.checkpoint,
				checkpointReview: response.checkpointReview,
				checkpointResolution: response.checkpointResolution,
			},
		};
	}
}

function visibleGoalObjective(goal: Goal, op: GoalToolInput["op"]): string {
	if (op === "create" || op === "get") return goal.objective;
	const firstLine = goal.objective
		.split("\n")
		.find(line => line.trim().length > 0)
		?.trim();
	const title = firstLine || goal.objective.trim();
	return title.length <= TRUNCATE_LENGTHS.TITLE ? title : `${title.slice(0, TRUNCATE_LENGTHS.TITLE - 1)}…`;
}

function renderGoalToolText(response: GoalToolResponse, op: GoalToolInput["op"]): string {
	const goal = response.goal;
	if (!goal) return "No active goal.";
	let text = `Goal: ${visibleGoalObjective(goal, op)}\nStatus: ${goal.status}`;
	const runMode = response.state?.runMode;
	if (runMode) text += `\nRun mode: ${runMode}`;
	text += `\nTokens: ${goal.tokensUsed} used`;
	if (goal.tokenBudget !== undefined) text += ` / ${goal.tokenBudget} budget`;
	if (response.remainingTokens !== null) text += `\nRemaining tokens: ${response.remainingTokens}`;
	if (goal.parentFrame)
		text += `\nParent frame: ${goal.parentFrame.kind} (version ${response.state?.parentFrameVersion ?? 0})`;
	if (goal.deliverableMap?.length) {
		const counts = goal.deliverableMap.reduce<Record<string, number>>((acc, item) => {
			acc[item.status] = (acc[item.status] ?? 0) + 1;
			return acc;
		}, {});
		text += `\nDeliverables: ${goal.deliverableMap.length}`;
		const summary = ["satisfied", "partial", "blocked", "stale", "pending"]
			.filter(status => counts[status])
			.map(status => `${status}:${counts[status]}`)
			.join(", ");
		if (summary) text += ` (${summary})`;
		const relevant = goal.currentTarget?.parentDeliverableIds?.length
			? goal.currentTarget.parentDeliverableIds
			: goal.deliverableMap.slice(0, 5).map(item => item.id);
		if (relevant.length) text += `\nRelevant deliverables: ${relevant.join(", ")}`;
	}
	if (goal.currentTarget) text += `\nCurrent target: ${goal.currentTarget.title} (${goal.currentTarget.status})`;
	if (goal.pendingCheckpointId) {
		text += `\nPending checkpoint: ${goal.pendingCheckpointId}`;
		if (response.state?.runMode === "awaiting-checkpoint-resolution") {
			text += `\nNext action: inspect checkpoint guidance, then call goal({op:"resolve_checkpoint", checkpoint_id:"${goal.pendingCheckpointId}"}) before ordinary tools.`;
		}
	}
	if (goal.verificationRepair) text += `\nVerifier repair: ${goal.verificationRepair.verificationAttemptId}`;
	if (goal.backgroundLanes?.length) {
		const requiredOpen = goal.backgroundLanes.filter(
			lane => lane.contract.requiredBeforeParent && lane.status !== "closed",
		);
		const blocked = goal.backgroundLanes.filter(lane => lane.status === "blocked");
		text += `\nBackground lanes: ${goal.backgroundLanes.length}`;
		if (requiredOpen.length) text += ` (${requiredOpen.length} required undispositioned)`;
		if (blocked.length) text += ` (${blocked.length} blocked)`;
	}
	if (op === "checkpoint" && response.checkpoint) {
		if (response.checkpointReview?.status === "rejected") {
			text += `\n\nCheckpoint rejected. Target remains active; no checkpoint is pending resolution. Continue repairing the current target closure evidence.\n\nReviewer feedback:\n${response.checkpointReview.feedback}`;
		} else {
			const checkpointId = response.checkpoint.id;
			text += `\n\nTarget checkpoint recorded: ${checkpointId}. Parent goal remains active. Ordinary tools are blocked until checkpoint guidance is inspected and goal({op:"resolve_checkpoint", checkpoint_id:"${checkpointId}"}) records the controller decision.`;
		}
	}
	if (op === "resolve_checkpoint" && response.checkpointResolution) {
		text += `\n\nCheckpoint resolution recorded: ${response.checkpointResolution.decision}.`;
		if (response.checkpointResolution.nextTarget) {
			text += `\nNext target: ${response.checkpointResolution.nextTarget.title}`;
		} else if (response.checkpointResolution.decision === "parent_completion_candidate") {
			text += `\nNext action: call goal({op:"complete"}) for parent completion verification.`;
		}
	}
	if (response.completionVerification?.status === "rejected") {
		const totalAttemptText =
			response.completionVerification.totalAttempts === undefined
				? ""
				: `, total ${response.completionVerification.totalAttempts}`;
		text += `\n\nCompletion verification rejected (attempt ${response.completionVerification.attempt}/${response.completionVerification.maxAttempts}${totalAttemptText}):\n${response.completionVerification.feedback}`;
		if (response.completionVerification.compactorMemo)
			text += `\n\nCompactor memo:\n${response.completionVerification.compactorMemo}`;
	} else if (response.completionBudgetReport) {
		text += `\n\n${response.completionBudgetReport}`;
	}
	return text;
}

function describeOp(op: string | undefined): string {
	switch (op) {
		case "create":
			return "set";
		case "complete":
			return "verify completion";
		case "get":
			return "check";
		case "resume":
			return "resume";
		case "drop":
			return "drop";
		case "start_target":
			return "start target";
		case "checkpoint":
			return "checkpoint target";
		case "resolve_checkpoint":
			return "resolve checkpoint";
		default:
			return op ?? "?";
	}
}

function goalBadgeColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "complete":
			return "success";
		case "budget-limited":
			return "warning";
		case "paused":
		case "dropped":
			return "muted";
		default:
			return "accent";
	}
}

function humanPreview(text: string): string {
	return truncateToWidth(replaceTabs(sanitizeText(text).trim()), TRUNCATE_LENGTHS.LONG);
}

interface GoalRenderArgs {
	op?: GoalToolInput["op"];
	objective?: string;
	token_budget?: number;
	title?: string;
	checkpoint_id?: string;
	decision?: string;
}

export const goalToolRenderer = {
	renderCall(args: GoalRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const description = describeOp(args.op);
		const meta: string[] = [];
		const trimmedObjective = args.objective?.trim();
		if (args.op === "create" && trimmedObjective) {
			const objective = truncateToWidth(trimmedObjective, TRUNCATE_LENGTHS.TITLE);
			meta.push(uiTheme.italic(uiTheme.fg("muted", `"${objective}"`)));
		}
		if (args.op === "start_target" && args.title)
			meta.push(uiTheme.italic(uiTheme.fg("muted", `"${humanPreview(args.title)}"`)));
		if (args.op === "resolve_checkpoint" && args.decision) meta.push(args.decision);
		if (args.op === "create" && args.token_budget !== undefined)
			meta.push(`budget ${formatNumber(args.token_budget)}`);
		const text = renderStatusLine({ icon: "pending", title: "Goal", description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GoalToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: GoalRenderArgs,
	): Component {
		const fallbackText = result.content?.find(c => c.type === "text")?.text ?? "";
		const details = result.details;
		const op = details?.op ?? args?.op;
		const description = describeOp(op);

		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Goal", description }, uiTheme);
			const body = formatErrorDetail(fallbackText || "Goal tool failed", uiTheme);
			return new Text([header, body].join("\n"), 0, 0);
		}

		const goal = details?.goal ?? null;
		if (!goal) {
			const header = renderStatusLine({ icon: "warning", title: "Goal", description }, uiTheme);
			const body = uiTheme.fg("muted", "No active goal.");
			return new Text([header, body].join("\n"), 0, 0);
		}

		const verification = details?.completionVerification;
		const verificationRejected = verification?.status === "rejected";
		const checkpointRejected = details?.checkpointReview?.status === "rejected";
		const lines: string[] = [];
		lines.push(
			renderStatusLine(
				{
					icon: verificationRejected || checkpointRejected ? "warning" : "success",
					title: "Goal",
					description,
					badge: {
						label: verificationRejected
							? "verification rejected"
							: checkpointRejected
								? "checkpoint rejected"
								: goal.status,
						color: verificationRejected || checkpointRejected ? "warning" : goalBadgeColor(goal.status),
					},
					meta: verificationRejected
						? [
								verification.totalAttempts === undefined
									? `attempt ${verification.attempt}/${verification.maxAttempts}`
									: `attempt ${verification.attempt}/${verification.maxAttempts}, total ${verification.totalAttempts}`,
							]
						: details?.state?.runMode
							? [details.state.runMode]
							: undefined,
				},
				uiTheme,
			),
		);

		const objectiveText = humanPreview(goal.objective);
		lines.push(`  ${uiTheme.italic(uiTheme.fg("muted", `"${objectiveText}"`))}`);
		if (goal.currentTarget)
			lines.push(`  ${uiTheme.fg("muted", `target: ${humanPreview(goal.currentTarget.title)}`)}`);
		if (goal.pendingCheckpointId) {
			lines.push(`  ${uiTheme.fg("warning", `checkpoint pending: resolve ${goal.pendingCheckpointId}`)}`);
			lines.push(`  ${uiTheme.fg("muted", "ordinary tools blocked until resolve_checkpoint")}`);
		}

		const used = formatNumber(goal.tokensUsed);
		const tokensLine =
			goal.tokenBudget !== undefined
				? `${used} / ${formatNumber(goal.tokenBudget)} tokens (${formatNumber(Math.max(0, goal.tokenBudget - goal.tokensUsed))} left)`
				: `${used} tokens`;
		lines.push(`  ${uiTheme.fg("dim", tokensLine)}`);

		if (goal.timeUsedSeconds > 0)
			lines.push(`  ${uiTheme.fg("dim", `${formatDuration(goal.timeUsedSeconds * 1000)} elapsed`)}`);
		if (details?.checkpoint && !checkpointRejected) {
			lines.push(`  ${uiTheme.fg("muted", "Target closed; parent goal still active")}`);
			lines.push(`  ${uiTheme.fg("muted", "Next: resolve_checkpoint after checkpoint guidance")}`);
		}
		if (details?.checkpointResolution)
			lines.push(`  ${uiTheme.fg("muted", `checkpoint resolution: ${details.checkpointResolution.decision}`)}`);
		if (verificationRejected) {
			lines.push(`  ${uiTheme.fg("warning", humanPreview(verification.feedback))}`);
			if (verification.compactorMemo)
				lines.push(`  ${uiTheme.fg("muted", humanPreview(verification.compactorMemo))}`);
		}
		if (checkpointRejected && details?.checkpointReview)
			lines.push(`  ${uiTheme.fg("warning", humanPreview(details.checkpointReview.feedback))}`);

		const report = details?.completionBudgetReport;
		if (report) {
			lines.push("");
			lines.push(uiTheme.italic(uiTheme.fg("muted", report)));
		}

		return new Text(lines.join("\n"), 0, 0);
	},

	mergeCallAndResult: true,
};
