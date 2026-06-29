import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { targetPlanPayloadFilePath } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import {
	type GoalContinuationFocus,
	parseGoalModeState,
	serializeGoalModeState,
} from "@oh-my-pi/pi-coding-agent/goals/state";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	GOAL_CHECKPOINT_GUIDANCE_MESSAGE_TYPE,
	GOAL_CHECKPOINT_MESSAGE_TYPE,
	GOAL_CHECKPOINT_RESOLUTION_MESSAGE_TYPE,
	GOAL_POST_COMPACTION_MESSAGE_TYPE,
	GOAL_RUBRIC_MESSAGE_TYPE,
	GOAL_TARGET_PLAN_MESSAGE_TYPE,
	GOAL_VERIFICATION_FEEDBACK_MESSAGE_TYPE,
	type GoalCheckpointMessageDetails,
	type GoalCheckpointResolutionMessageDetails,
	type GoalTargetPlanMessageDetails,
	type GoalVerificationFeedbackMessageDetails,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import {
	createTools,
	type TodoPhase,
	type Tool,
	type ToolSession,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

function createToolSession(cwd: string, settings: Settings, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		...overrides,
	};
}

type GoalHarness = {
	tempDir: TempDir;
	settings: Settings;
	authStorage: AuthStorage;
	session: AgentSession;
	mode: InteractiveMode;
	toolSession: ToolSession;
	cleanup: () => Promise<void>;
};

type GoalSideAgentMock = {
	completionStatus: "verified" | "rejected";
	feedback: string;
	compactorFails: boolean;
	compactorMemo: string;
	continuationFocus: GoalContinuationFocus | undefined;
	checkpointReviewStatus: "accepted" | "rejected";
	checkpointReviewFeedback: string;
	checkpointGuidance: string;
};
let goalSideAgentMock: GoalSideAgentMock;
let goalSideAgentCalls: ExecutorOptions[];

function createSideAgentResult(options: ExecutorOptions, data: unknown): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: JSON.stringify(data, null, 2),
		stderr: "",
		truncated: false,
		durationMs: 25,
		tokens: 7,
		requests: 1,
		modelOverride: options.modelOverride,
	};
}

function installGoalSideAgentMock(): void {
	goalSideAgentMock = {
		completionStatus: "verified",
		feedback: "Verifier accepted the test goal.",
		compactorFails: false,
		compactorMemo: "Continue with the highest-value missing evidence.",
		continuationFocus: {
			openGaps: ["Missing end-to-end verification evidence."],
			nextActions: ["Continue with the highest-value missing evidence."],
			evidenceToCollect: ["Current focused integration proof."],
			avoidRepeating: ["Do not redo accepted setup work."],
		},
		checkpointReviewStatus: "accepted",
		checkpointReviewFeedback: "Checkpoint target is locally closed and bounded.",
		checkpointGuidance: "Controller must resolve the checkpoint before local work resumes.",
	};
	goalSideAgentCalls = [];
	vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
		goalSideAgentCalls.push(options);
		if (options.agent.name === "goal-rubric") {
			return createSideAgentResult(options, {
				rubric: "Strict test rubric with labeled score levels.",
				deliverableMap: [{ id: "D1", summary: "Ship release behavior.", status: "pending" }],
			});
		}
		if (options.agent.name === "goal-completion-verifier") {
			return createSideAgentResult(options, {
				status: goalSideAgentMock.completionStatus,
				feedback: goalSideAgentMock.feedback,
				summary: goalSideAgentMock.feedback,
				score: goalSideAgentMock.completionStatus === "verified" ? 4 : 2,
				deliverableResults: [
					{
						id: "D1",
						status: goalSideAgentMock.completionStatus === "verified" ? "passed" : "failed",
						rationale: goalSideAgentMock.feedback,
					},
				],
				evidenceChecked: [{ claim: "Goal state", evidence: "Mock verifier inspected state", current: true }],
				completionBlockers:
					goalSideAgentMock.completionStatus === "verified"
						? []
						: [
								{
									id: "B1",
									deliverableId: "D1",
									severity: "blocking",
									problem: goalSideAgentMock.feedback,
									requiredEvidenceOrFix: goalSideAgentMock.compactorMemo,
								},
							],
				continuationFocus: goalSideAgentMock.continuationFocus,
				continuationMessage:
					"<goal_continuation_compaction>Hidden prepared verifier hint.</goal_continuation_compaction>",
			});
		}
		if (options.agent.name === "goal-continuation-compactor") {
			if (goalSideAgentMock.compactorFails) {
				return {
					...createSideAgentResult(options, {}),
					exitCode: 1,
					error: "compactor failed",
					output: "",
				};
			}
			return createSideAgentResult(options, {
				compactorMemo: goalSideAgentMock.compactorMemo,
				continuationMessage: goalSideAgentMock.compactorMemo,
			});
		}
		if (options.agent.name === "goal-checkpoint-reviewer") {
			return createSideAgentResult(options, {
				status: goalSideAgentMock.checkpointReviewStatus,
				feedback: goalSideAgentMock.checkpointReviewFeedback,
				evidenceChecked: [
					{ claim: "Checkpoint claim", evidence: "Mock reviewer inspected evidence", current: true },
				],
				blockers:
					goalSideAgentMock.checkpointReviewStatus === "accepted"
						? []
						: [
								{
									id: "checkpoint-evidence",
									severity: "blocking",
									problem: goalSideAgentMock.checkpointReviewFeedback,
									requiredEvidenceOrFix: "Gather current target-closure evidence.",
								},
							],
				continuationFocus:
					goalSideAgentMock.checkpointReviewStatus === "accepted"
						? undefined
						: goalSideAgentMock.continuationFocus,
			});
		}
		if (options.agent.name === "goal-checkpoint-guidance") {
			return createSideAgentResult(options, {
				continuationMessage: goalSideAgentMock.checkpointGuidance,
				checkpointSummary: "Checkpoint accepted in mock guidance.",
				controllerQuestions: ["Which target or external check should happen next?"],
				possibleNextTargets: ["Prove tarball smoke path"],
				broaderChecksOrInputs: ["Ask operator whether CI is required now."],
				parentDeltaConsiderations: ["Admit only the bounded checkpoint claim."],
				lessonsForFuture: ["Keep checkpoint claims bounded."],
				avoidRepeating: ["Do not treat checkpoint as parent completion."],
			});
		}
		throw new Error(`unexpected side agent ${options.agent.name}`);
	});
}

// Immutable, expensive fixtures shared across every test. `new ModelRegistry`
// alone is ~110ms (loads + parses the bundled model catalog), which dominated
// this file's wall time when rebuilt per test. The registry, its auth storage,
// and the resolved model are never mutated by goal-mode flows, and
// AgentSession.dispose() never closes authStorage — so a single shared instance
// is safe and drops repeated pure setup overhead.
type SharedFixture = {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model;
	baseDir: TempDir;
};

async function createSharedFixture(): Promise<SharedFixture> {
	const baseDir = TempDir.createSync("@pi-goal-mode-shared-");
	const authStorage = await AuthStorage.create(path.join(baseDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}
	return { authStorage, modelRegistry, model, baseDir };
}

async function createGoalHarness(
	shared: SharedFixture,
	options: { extensionRunner?: ExtensionRunner } = {},
): Promise<GoalHarness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-goal-mode-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const { modelRegistry, model } = shared;

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
		"plan.enabled": true,
	});
	const bootstrapToolSession = createToolSession(tempDir.path(), settings);
	const initialTools = await createTools(bootstrapToolSession, ["read"]);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));

	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
		extensionRunner: options.extensionRunner,
	});
	const mode = new InteractiveMode(session, "test");
	const localProtocolOptions = {
		getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
		getSessionId: () => session.sessionManager.getSessionId(),
	};
	const toolSession = createToolSession(tempDir.path(), settings, {
		localProtocolOptions,
		getGoalModeState: () => session.getGoalModeState(),
		getGoalRuntime: () => session.goalRuntime,
		createGoalWithRubric: (input, signal) => session.createGoalWithRubric(input, signal),
		requestGoalCheckpoint: (input, signal) => session.requestGoalCheckpoint(input, signal),
		requestGoalCheckpointResolution: (input, signal) => session.requestGoalCheckpointResolution(input, signal),
		replaceGoalWithRubric: (input, signal) => session.replaceGoalWithRubric(input, signal),
		requestGoalCompletion: signal => session.requestGoalCompletion(signal),
		requestGoalTargetPlanApproval: (input, signal) => session.requestGoalTargetPlanApproval(input, signal),
		requestGoalTargetPlanFailure: (input, signal) => session.requestGoalTargetPlanFailure(input, signal),
		getGoalTargetPlanReference: () => session.getGoalTargetPlanReference(),
	});
	toolRegistry.set("goal", new GoalTool(toolSession) as unknown as Tool);

	return {
		tempDir,
		authStorage: shared.authStorage,
		settings,
		session,
		mode,
		toolSession,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
			tempDir.removeSync();
			resetSettingsForTest();
		},
	};
}

async function toolNamesFor(harness: GoalHarness): Promise<string[]> {
	return (await createTools(harness.toolSession, harness.session.getActiveToolNames())).map(tool => tool.name);
}

async function activeGoalTool(harness: GoalHarness): Promise<Tool> {
	const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
		tool => tool.name === "goal",
	);
	if (!goalTool) throw new Error("Expected goal tool to be active");
	return goalTool;
}

async function writeAndSubmitApprovedTargetPlan(
	harness: GoalHarness,
	goalTool: Tool,
	options: {
		planSentinel?: string;
		executionReviewStatus?: "accepted" | "rejected";
		executionReviewFeedback?: string;
		executionReviewFindings?: Array<{
			id: string;
			severity: "blocking" | "important" | "polish";
			problem: string;
			requiredRevision: string;
		}>;
		parallelWorkstreams?: boolean;
	} = {},
): Promise<AgentToolResult> {
	const state = harness.session.getGoalModeState();
	const target = state?.goal.currentTarget;
	const plan = state?.goal.currentTargetPlan;
	if (!state?.enabled || !target || !plan) throw new Error("expected active target plan");
	const primarySignalId = `signal-${target.id}`;
	const executionReviewStatus = options.executionReviewStatus ?? "accepted";
	const executionReviewFindings = options.executionReviewFindings ?? [
		{
			id: "verification-command",
			severity: "polish" as const,
			problem: "Verification command could be more explicit.",
			requiredRevision: "Name the behavior proved by the command.",
		},
	];
	const localProtocolOptions = {
		getArtifactsDir: () => harness.session.sessionManager.getArtifactsDir(),
		getSessionId: () => harness.session.sessionManager.getSessionId(),
	};
	const resolvedPlanPath = resolveLocalUrlToPath(plan.planFilePath, localProtocolOptions);
	await Bun.write(
		resolvedPlanPath,
		[
			"# Approved target plan",
			options.planSentinel ? options.planSentinel : "",
			"",
			"## Target Claim",
			"",
			"Target behavior is directly verified. Parent completion remains outside this target.",
			"",
			"## Implementation",
			"",
			"- Execute the bounded happy path target work.",
			...(options.parallelWorkstreams
				? ["- Backend API workstream owns src/api.ts.", "- UI state workstream owns src/ui.ts."]
				: []),
			"",
			"## Verification",
			"",
			`- ${primarySignalId}: Run the focused check.`,
			"- happy path",
		].join("\n"),
	);
	const payloadFilePath = targetPlanPayloadFilePath(plan.planFilePath);
	const payload = {
		target_id: target.id,
		target_plan_id: plan.id,
		plan_file_path: plan.planFilePath,
		revision: plan.revision,
		primary_signal_group_id: primarySignalId,
		plan_depth: "light",
		target_card: {
			capability_claim: "Target behavior is directly verified.",
			known_limits: ["Parent completion remains outside this target."],
			user_visible_surface: "Target behavior",
			acceptance_rows: { closed: ["happy path"], open: [] },
			verification_scenarios: [`happy path ${primarySignalId}`],
			review_lenses: ["implementation code review lens"],
			checkpoint_evidence: ["Focused check passes."],
			...(options.parallelWorkstreams
				? {
						shared_contract: "Backend and UI agree on the saved preference shape.",
						workstreams: [
							{
								id: "backend-api",
								label: "Backend API",
								kind: "main",
								role: "Backend contract specialist",
								files: ["src/api.ts"],
								contract_inputs: ["Existing preference request"],
								contract_outputs: ["Saved preference response"],
							},
							{
								id: "ui-state",
								label: "UI state",
								kind: "app-ui",
								role: "UI state specialist",
								files: ["src/ui.ts"],
								contract_inputs: ["Saved preference response"],
								contract_outputs: ["Rendered preference state"],
							},
						],
					}
				: {}),
		},
		verification_aperture: {
			product_intention: "Prove the target behavior with direct evidence.",
			primary_signal_id: primarySignalId,
			blast_radius: "local",
			blast_radius_scope: "Single target behavior surface.",
			confidence_target: "high",
			confidence_rationale: "High only for the focused target behavior.",
			layer_rationale: "The target is local and directly observable.",
			residual_uncertainty: ["Parent completion remains outside this target."],
			omitted_layers: [{ layer: "e2e", reason: "Parent-level e2e belongs to a later target." }],
		},
		verification_signals: [
			{
				id: primarySignalId,
				role: "primary",
				layer: "integration",
				concern_ids: ["concern-behavior"],
				claim: "Target behavior is verified.",
				observation: "Focused evidence is observed.",
				method: "Run the focused check.",
				expected_outcome: "The focused check passes.",
				required: true,
				confidence_if_satisfied: "high",
				confidence_rationale: "Focused verification earns target confidence only.",
				stale_if: ["Relevant code changes."],
			},
		],
		concern_checks: [
			{
				id: "concern-behavior",
				kind: "behavior",
				lens: "focused behavior",
				why_independent: "Behavior can fail independently of parent completion.",
				covered_by_signal_ids: [primarySignalId],
			},
		],
		scope_calibration: {
			right_sizing_basis: "product-signal",
			right_sizing_rationale: "One product signal closes without claiming parent completion.",
			why_not_smaller: ["Smaller work would not produce an observable signal."],
			why_not_larger: ["Larger work would claim parent-level completion."],
			included_related_work: [
				{ item: "Focused target work", reason: "Needed for primary signal.", signal_ids: [primarySignalId] },
			],
			deferred_related_work: [
				{
					item: "Parent completion verification",
					reason: "different-primary-signal",
					follow_up_hint: "Checkpoint first.",
					rationale: "Parent verification needs broader evidence.",
				},
			],
			...(options.parallelWorkstreams ? { target_unit_rule_ids: ["parallel-workstreams-required"] } : {}),
		},
		branch_evidence: [
			{ branch: "happy path", required: true, planned_signal_ids: [primarySignalId], rationale: "Primary signal." },
		],
		excluded_work_review: [
			{ item: "Parent completion", classification: "parent-non-claim", rationale: "Checkpoint is bounded." },
		],
		target_plan_reviews: [
			{
				id: "review-aperture",
				lens: "aperture",
				status: "accepted",
				feedback: "Target aperture is right-sized.",
				reviewed_target_plan_id: plan.id,
				reviewed_revision: plan.revision,
				revised_after_review: false,
				source: {
					kind: "subagent",
					reviewer_id: "aperture-reviewer",
					artifact_uri: "agent://aperture-reviewer",
					validation_uri: "agent://aperture-reviewer/validation",
				},
				aperture_classification: "right-sized",
				revision_decision: "keep",
				scores: {
					product_signal: 4,
					related_work_bundling: 4,
					concern_cohesion: 4,
					verification_aperture: 4,
					blast_radius_coverage: 4,
					parent_uncertainty_reduction: 4,
					anti_gaming: 4,
				},
				findings: [],
			},
			{
				id: "review-execution-readiness",
				lens: "execution-readiness",
				status: executionReviewStatus,
				feedback: options.executionReviewFeedback ?? "Execution plan is complete.",
				reviewed_target_plan_id: plan.id,
				reviewed_revision: plan.revision,
				revised_after_review: false,
				source: {
					kind: "subagent",
					reviewer_id: "execution-reviewer",
					artifact_uri: "agent://execution-reviewer",
					validation_uri: "agent://execution-reviewer/validation",
				},
				findings: executionReviewFindings.map(finding => ({
					id: finding.id,
					severity: finding.severity,
					problem: finding.problem,
					required_revision: finding.requiredRevision,
				})),
			},
		],
		dry_run: { status: "passed", checks: [{ id: "dry-run", passed: true, rationale: "Plan steps are executable." }] },
	};
	await Bun.write(
		resolveLocalUrlToPath(payloadFilePath, localProtocolOptions),
		`${JSON.stringify(payload, null, 2)}\n`,
	);
	return await goalTool.execute(`submit-${plan.id}`, {
		op: "submit_target_plan",
		payload_file_path: payloadFilePath,
	});
}

function appendCompactableHistory(harness: GoalHarness): void {
	const model = harness.session.model;
	if (!model) throw new Error("Expected model to be selected");
	const now = Date.now();
	const usage = {
		input: 120,
		output: 40,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 160,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	harness.session.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "first compactable turn" }],
		timestamp: now - 4,
	});
	harness.session.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "first compactable response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage,
		timestamp: now - 3,
	});
	harness.session.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "second compactable turn" }],
		timestamp: now - 2,
	});
	harness.session.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "second compactable response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage,
		timestamp: now - 1,
	});
}

function installCompactionMock(preserveData: Record<string, unknown> = { compactMock: "preserved" }) {
	return vi
		.spyOn(compactionModule, "compact")
		.mockImplementation(async (preparation, _model, _apiKey, _instructions, _signal, options) => ({
			summary: "goal-aware compacted summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: { extraContext: options?.extraContext },
			preserveData,
		}));
}

function createRestoredSession(
	harness: GoalHarness,
	sessionManager: SessionManager,
): {
	session: AgentSession;
	mode: InteractiveMode;
	cleanup: () => Promise<void>;
} {
	const model = harness.session.model;
	if (!model) throw new Error("Expected model to be selected");
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
		}),
		sessionManager,
		settings: harness.settings,
		modelRegistry: new ModelRegistry(harness.authStorage),
		toolRegistry: new Map<string, Tool>(),
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const mode = new InteractiveMode(session, "test-restore");
	return {
		session,
		mode,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
		},
	};
}

async function waitForMicrotasks(): Promise<void> {
	// Pure microtask flush — deterministic and fake-timer-safe (no macrotask /
	// real-clock dependency). Lets queued `.then` callbacks settle so a fired
	// continuation tick would be observed before we assert it was dropped.
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

async function armInputWaiter(mode: InteractiveMode): Promise<{
	inputPromise: Promise<void>;
	getResolvedText: () => string | undefined;
}> {
	let resolvedText: string | undefined;
	const inputPromise = mode.getUserInput().then(input => {
		resolvedText = input.text;
	});
	await waitForMicrotasks();
	return {
		inputPromise,
		getResolvedText: () => resolvedText,
	};
}

describe("InteractiveMode goal mode integration", () => {
	let harness: GoalHarness;
	let shared: SharedFixture;

	beforeAll(async () => {
		initTheme();
		shared = await createSharedFixture();
	});

	afterAll(() => {
		shared.authStorage.close();
		shared.baseDir.removeSync();
	});

	beforeEach(async () => {
		installGoalSideAgentMock();
		harness = await createGoalHarness(shared);
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await harness.cleanup();
	});

	it("toggles goal tool exposure when goal mode enters and pauses", async () => {
		expect(await toolNamesFor(harness)).not.toContain("goal");

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(await toolNamesFor(harness)).toContain("goal");

		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.handleGoalModeCommand();

		expect(harness.mode.goalModeEnabled).toBe(false);
		expect(harness.mode.goalModePaused).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
		expect(await toolNamesFor(harness)).not.toContain("goal");
	});

	it("generates a verifier-only rubric before goal work starts", async () => {
		const showStatus = vi.spyOn(harness.mode, "showStatus");

		await harness.mode.handleGoalModeCommand("Ship the release");

		const state = harness.session.getGoalModeState();
		const rubricCall = goalSideAgentCalls.find(call => call.agent.name === "goal-rubric");
		expect(state?.goal.rubric).toContain("Strict test rubric");
		expect(state?.goal.deliverableMap).toEqual([{ id: "D1", summary: "Ship release behavior.", status: "pending" }]);
		expect(state?.stateVersion).toBe(2);
		const entries = harness.session.sessionManager.getEntries();
		const stateVersions = entries.flatMap(entry =>
			entry.type === "mode_change" && entry.mode === "goal" && typeof entry.data?.stateVersion === "number"
				? [entry.data.stateVersion]
				: [],
		);
		const modeChangeSignatures = entries.flatMap(entry =>
			entry.type === "mode_change" ? [`${entry.mode}\0${JSON.stringify(entry.data ?? null)}`] : [],
		);
		expect(stateVersions).toEqual([...stateVersions].sort((a, b) => a - b));
		expect(stateVersions.at(-1)).toBe(state?.stateVersion);
		for (let index = 1; index < modeChangeSignatures.length; index++) {
			expect(modeChangeSignatures[index]).not.toBe(modeChangeSignatures[index - 1]);
		}
		expect(showStatus).toHaveBeenCalledWith("Generating goal rubric…");
		expect(showStatus).toHaveBeenCalledWith("Goal rubric generated.");
		const rubricEntries = entries.filter(
			entry => entry.type === "custom_message" && entry.customType === GOAL_RUBRIC_MESSAGE_TYPE,
		);
		expect(rubricEntries).toHaveLength(1);
		const artifact = rubricEntries[0];
		if (artifact?.type !== "custom_message") throw new Error("expected rubric artifact");
		expect(artifact.includeInContext).toBe(false);
		expect(artifact.details).toMatchObject({
			goalId: state?.goal.id,
			rubric: "Strict test rubric with labeled score levels.",
		});
		const renderedChat = Bun.stripANSI(harness.mode.chatContainer.render(120).join("\n"));
		expect(renderedChat).toContain("[goal-rubric]");
		expect(renderedChat).toContain("ctrl+o to expand");
		expect(showStatus.mock.calls.map(call => String(call[0])).join("\n")).not.toContain("Strict test rubric");
		expect(rubricCall?.agent.tools).toEqual(["read", "search", "find", "yield"]);
		expect(rubricCall?.task).toContain("<full_transcript_file>");
		expect(rubricCall?.task).toContain("Ship the release");
		if (!rubricCall?.contextFile) throw new Error("expected rubric side agent context file");
		const transcript = await Bun.file(rubricCall.contextFile).text();
		expect(transcript).toContain("Test");
	});

	it("surfaces rubric generation status when replacing the active goal", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const showStatus = vi.spyOn(harness.mode, "showStatus");
		const beforeRubricCount = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === GOAL_RUBRIC_MESSAGE_TYPE).length;

		await harness.mode.handleGoalModeCommand("set Replace the objective");
		const state = harness.session.getGoalModeState();

		expect(showStatus).toHaveBeenCalledWith("Generating goal rubric…");
		expect(showStatus).toHaveBeenCalledWith("Goal rubric generated.");
		const rubricEntries = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === GOAL_RUBRIC_MESSAGE_TYPE);
		expect(rubricEntries.length).toBe(beforeRubricCount + 1);
		expect(state?.goal.rubric).toContain("Strict test rubric");
		expect(state?.goal.deliverableMap?.[0]?.id).toBe("D1");
		const renderedChat = Bun.stripANSI(harness.mode.chatContainer.render(120).join("\n"));
		expect(renderedChat).toContain("[goal-rubric]");
		expect(showStatus.mock.calls.map(call => String(call[0])).join("\n")).not.toContain("Strict test rubric");
	});

	it("replaces the active goal via /goal set", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const originalGoal = harness.session.getGoalModeState()?.goal;
		if (!originalGoal) throw new Error("expected active goal");

		await harness.mode.handleGoalModeCommand("set Replace the objective");

		const state = harness.session.getGoalModeState();
		expect(state?.enabled).toBe(true);
		expect(state?.goal.objective).toBe("Replace the objective");
		expect(state?.stateVersion).toBe(2);
		expect(state?.goal.status).toBe("active");
		expect(state?.goal.id).not.toBe(originalGoal.id);
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(await toolNamesFor(harness)).toContain("goal");
	});

	it("defers initial goal objective submission while streaming", async () => {
		let streaming = true;
		Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => streaming });
		const sendGoalModeContext = vi.spyOn(harness.session, "sendGoalModeContext").mockResolvedValue();
		const waiter = await armInputWaiter(harness.mode);

		await harness.mode.handleGoalModeCommand("Ship the release");
		await waitForMicrotasks();

		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		expect(sendGoalModeContext).toHaveBeenCalledWith({ deliverAs: "steer" });
		expect(waiter.getResolvedText()).toBeUndefined();

		streaming = false;
		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "cleanup" }));
		await waiter.inputPromise;
	});

	it("defers replacement goal objective submission while streaming", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		let streaming = true;
		Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => streaming });
		const sendGoalModeContext = vi.spyOn(harness.session, "sendGoalModeContext").mockResolvedValue();
		const waiter = await armInputWaiter(harness.mode);

		await harness.mode.handleGoalModeCommand("set Replace the objective");
		await waitForMicrotasks();

		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Replace the objective");
		expect(sendGoalModeContext).toHaveBeenCalledWith({ deliverAs: "steer" });
		expect(waiter.getResolvedText()).toBeUndefined();

		streaming = false;
		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "cleanup" }));
		await waiter.inputPromise;
	});

	it("drops a goal continuation tick while the agent is streaming", async () => {
		// Repro for the race the streaming guard on /goal set X exposed: the
		// 800ms continuation timer armed by getUserInput() can outlive the idle
		// window when streaming starts between schedule and fire (e.g. /goal set
		// taking the streaming branch, or any extension that triggers a turn).
		// Without the streaming-aware guard the timer fires onInputCallback
		// with a `goal-continuation` and submitInteractiveInput resurfaces
		// AgentBusyError via promptCustomMessage. Driven with fake timers so the
		// 800ms window is exercised deterministically without a real wall-clock wait.
		await harness.mode.handleGoalModeCommand("Ship the release");

		vi.useFakeTimers();
		const waiter = await armInputWaiter(harness.mode);

		let streaming = true;
		Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => streaming });

		// Fire the armed 800ms continuation timer while streaming is true.
		vi.advanceTimersByTime(800);
		await waitForMicrotasks();

		expect(waiter.getResolvedText()).toBeUndefined();

		streaming = false;
		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "cleanup" }));
		await waiter.inputPromise;
	});

	it("keeps goals active when target-plan approval aborts a streaming turn", async () => {
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target", {
			op: "start_target",
			title: "Prove source-link smoke",
			desired_future_claim: "Source-link install exercises smoke path.",
			closure_standard: "Current smoke output exists.",
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool);
		const approval = harness.session.getGoalTargetPlanReference();
		if (!approval) throw new Error("expected target-plan approval details");
		const targetPlanApprovalAudits = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === "goal_boundary_audit")
			.filter(entry => entry.type === "custom" && JSON.stringify(entry.data).includes('"target-plan-approval"'));
		const targetPlanApprovalAudit = targetPlanApprovalAudits[targetPlanApprovalAudits.length - 1];
		if (targetPlanApprovalAudit?.type !== "custom") throw new Error("expected target-plan approval audit");
		expect(targetPlanApprovalAudit.data).toMatchObject({
			kind: "target-plan-approval",
			action: "accepted",
			omittedFields: ["fullPlanContent"],
		});

		Object.defineProperty(harness.session, "isStreaming", { configurable: true, get: () => true });
		const abort = vi.spyOn(harness.session, "abort");
		const prompt = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);

		await harness.mode.handleGoalTargetPlanApproved(approval);

		expect(abort).toHaveBeenCalledWith({ goalReason: "internal" });
		expect(prompt).toHaveBeenCalledWith(expect.stringContaining("Goal target plan approved."), {
			synthetic: true,
			skipGoalModeContext: true,
		});
		const abortOrder = abort.mock.invocationCallOrder[0];
		const promptOrder = prompt.mock.invocationCallOrder[0];
		if (abortOrder === undefined || promptOrder === undefined) throw new Error("expected abort and prompt calls");
		expect(abortOrder).toBeLessThan(promptOrder);
		const approvedPrompt = prompt.mock.calls[0]?.[0];
		if (typeof approvedPrompt !== "string") throw new Error("expected approved target plan prompt");
		if (!approval.planHash) throw new Error("expected target plan hash");
		expect(approvedPrompt).toContain("Goal target plan approved. Execute this approved current-target plan.");
		expect(approvedPrompt).toContain("<approved_target_plan_ref");
		expect(approvedPrompt).toContain(approval.planFilePath);
		expect(approval.payloadFilePath).toBe(targetPlanPayloadFilePath(approval.planFilePath));
		expect(approvedPrompt).toContain(approval.payloadFilePath);
		expect(approvedPrompt).toContain(`payload_path="${approval.payloadFilePath}"`);
		expect(approvedPrompt).toContain(approval.planHash);
		expect(approvedPrompt).toContain("<approved_target_plan_markdown");
		expect(approvedPrompt).toContain("# Approved target plan");
		const planBlockIndex = approvedPrompt.indexOf("<approved_target_plan_markdown");
		const refIndex = approvedPrompt.indexOf("<approved_target_plan_ref");
		const guardrailsIndex = approvedPrompt.indexOf("<approved_target_execution_guardrails>");
		expect(planBlockIndex).toBeGreaterThan(-1);
		expect(refIndex).toBeGreaterThan(-1);
		expect(guardrailsIndex).toBeGreaterThan(-1);
		expect(planBlockIndex).toBeLessThan(refIndex);
		expect(planBlockIndex).toBeLessThan(guardrailsIndex);
		expect(approvedPrompt).toContain("<approved_target_execution_guardrails>");
		expect(approvedPrompt).not.toContain("<approved_target_execution_summary>");
		expect(approvedPrompt).toContain(
			"Fresh execution context: planning/reviewer transcript was removed from model context.",
		);
		expect(approvedPrompt).not.toContain("approved execution summary supersedes earlier drafts");
		expect(approvedPrompt).not.toContain("Context preserved. Use conversation history when useful");
		expect(approvedPrompt).toContain("Run the focused check.");
		expect(approvedPrompt).toContain('"confidenceIfSatisfied": "high"');
		expect(approvedPrompt).toContain("implementation code review lens");
		expect(approvedPrompt).toContain("Parent completion");
		expect(approvedPrompt).not.toContain('"verificationAperture"');
		expect(approvedPrompt).not.toContain('"scopeCalibration"');
		expect(approvedPrompt).not.toContain('"scenarioRowsInScope"');
		expect(approvedPrompt).not.toContain('"concernChecks"');
		expect(approvedPrompt).not.toContain('"concernIds"');
		expect(approvedPrompt).not.toContain("## Verification Signal Aperture");
		expect(approvedPrompt).not.toContain("Primary signal: focused target evidence.");
		const state = harness.session.getGoalModeState();
		expect(state?.enabled).toBe(true);
		expect(state?.runMode).toBe("working-target");
		expect(() =>
			harness.session.goalRuntime.buildCheckpointCandidate({
				status: "closed_with_evidence",
				summary: "Current smoke output exists.",
				localClaims: ["Source-link install exercises smoke path"],
				evidence: [
					{ claim: "Source-link install exercises smoke path", evidence: "Observed smoke output", current: true },
				],
				notClaimed: ["Release is ready"],
				remainingQuestions: [],
			}),
		).not.toThrow("no active parent");
	});

	it("surfaces approved parallel workstream scaffold in execution prompt", async () => {
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target-parallel", {
			op: "start_target",
			title: "Prove preference save",
			desired_future_claim: "Preference save path works.",
			closure_standard: "Backend and UI workstreams satisfy the shared preference contract.",
			parallel_workstream_requirement: {
				required: true,
				source: "operator",
				rationale: "Backend and UI changes can proceed independently.",
			},
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool, { parallelWorkstreams: true });
		const approval = harness.session.getGoalTargetPlanReference();
		if (!approval) throw new Error("expected target-plan approval details");
		const prompt = vi.spyOn(harness.session, "prompt").mockResolvedValue(true);

		await harness.mode.handleGoalTargetPlanApproved(approval);

		const approvedPrompt = prompt.mock.calls[0]?.[0];
		if (typeof approvedPrompt !== "string") throw new Error("expected approved target plan prompt");
		expect(approvedPrompt).toContain("- task_batch_scaffold:");
		expect(approvedPrompt).toContain('"batchId"');
		expect(approvedPrompt).toContain('"backend-api"');
		expect(approvedPrompt).toContain('"ui-state"');
		expect(approvedPrompt).toContain("First implementation action SHOULD be one `task` batch");
		expect(harness.session.getGoalModeState()?.goal.currentWorkstreamBatch?.status).toBe("pending-launch");
	});

	it("resets model-visible context after target-plan approval", async () => {
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target", {
			op: "start_target",
			title: "Prove source-link smoke",
			desired_future_claim: "Source-link install exercises smoke path.",
			closure_standard: "Current smoke output exists.",
		});
		harness.session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "PLANNING_SENTINEL_SHOULD_NOT_REACH_EXECUTION_CONTEXT" }],
			timestamp: Date.now(),
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool, {
			planSentinel: "APPROVED_PLAN_SENTINEL_REACHES_EXECUTION_CONTEXT",
		});
		const targetPlanArtifacts = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === GOAL_TARGET_PLAN_MESSAGE_TYPE);
		const targetPlanArtifact = targetPlanArtifacts[targetPlanArtifacts.length - 1];
		if (targetPlanArtifact?.type !== "custom_message") throw new Error("expected target-plan artifact");
		expect(targetPlanArtifact.includeInContext).toBe(false);
		const approval = harness.session.getGoalTargetPlanReference();
		if (!approval) throw new Error("expected target-plan approval details");

		let messagesBeforePrompt = "";
		const prompt = vi.spyOn(harness.session, "prompt").mockImplementation(async targetPlanPrompt => {
			messagesBeforePrompt = JSON.stringify(harness.session.state.messages);
			harness.session.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: String(targetPlanPrompt) }],
				timestamp: Date.now(),
			});
			return true;
		});

		await harness.mode.handleGoalTargetPlanApproved(approval);

		expect(prompt).toHaveBeenCalledWith(expect.stringContaining("Goal target plan approved."), {
			synthetic: true,
			skipGoalModeContext: true,
		});
		expect(messagesBeforePrompt).toContain("Target plan approved; execution context reset.");
		expect(messagesBeforePrompt).not.toContain("PLANNING_SENTINEL_SHOULD_NOT_REACH_EXECUTION_CONTEXT");
		const contextText = JSON.stringify(harness.session.buildDisplaySessionContext().messages);
		expect(contextText).toContain(
			"Goal target plan approved; planning and reviewer transcript intentionally removed from execution context.",
		);
		expect(contextText).toContain("<approved_target_plan_markdown");
		expect(contextText).toContain("<approved_target_execution_guardrails>");
		expect(contextText).toContain("APPROVED_PLAN_SENTINEL_REACHES_EXECUTION_CONTEXT");
		expect(contextText).toContain("implementation code review lens");
		expect(contextText).toContain("confidenceIfSatisfied");
		expect(contextText).not.toContain("<goal_context>");
		expect(contextText).not.toContain("PLANNING_SENTINEL_SHOULD_NOT_REACH_EXECUTION_CONTEXT");
		expect(harness.session.getGoalModeState()?.runMode).toBe("working-target");
	});

	it("restores pre-planning todos after target-plan approval", async () => {
		const originalPhases: TodoPhase[] = [
			{
				name: "Execution",
				tasks: [{ content: "Preserve existing execution todo", status: "in_progress" }],
			},
		];
		let todoAutoClearEvents = 0;
		const unsubscribe = harness.session.subscribe(event => {
			if (event.type === "todo_auto_clear") todoAutoClearEvents += 1;
		});
		try {
			await harness.mode.handleGoalModeCommand("Improve release reliability");
			const goalTool = await activeGoalTool(harness);
			harness.session.setTodoPhases(originalPhases);
			await goalTool.execute("target-planning-todos", {
				op: "start_target",
				title: "Prove source-link smoke",
				desired_future_claim: "Source-link install exercises smoke path.",
				closure_standard: "Current smoke output exists.",
			});
			await waitForMicrotasks();
			expect(harness.session.getTodoPhases()).toEqual([]);

			harness.session.setTodoPhases([
				{
					name: "Planning",
					tasks: [{ content: "Draft target plan", status: "in_progress" }],
				},
			]);
			await writeAndSubmitApprovedTargetPlan(harness, goalTool);
			await waitForMicrotasks();

			expect(harness.session.getTodoPhases()).toEqual(originalPhases);
			expect(todoAutoClearEvents).toBeGreaterThan(0);
			const todoEditEntries = harness.session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE);
			const latestTodoEdit = todoEditEntries[todoEditEntries.length - 1];
			if (latestTodoEdit?.type !== "custom") throw new Error("expected restored todo edit entry");
			expect(latestTodoEdit.data).toEqual({ phases: originalPhases });
		} finally {
			unsubscribe();
		}
	});

	it("returns the recovered draft after auto-consolidated target-plan submit caps", async () => {
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target", {
			op: "start_target",
			title: "Prove source-link smoke",
			desired_future_claim: "Source-link install exercises smoke path.",
			closure_standard: "Current smoke output exists.",
		});

		let result: AgentToolResult | undefined;
		for (let index = 0; index < 3; index += 1) {
			result = await writeAndSubmitApprovedTargetPlan(harness, goalTool, {
				executionReviewStatus: "rejected",
				executionReviewFeedback: "Execution plan is missing the verification command.",
				executionReviewFindings: [
					{
						id: "verification-command",
						severity: "blocking",
						problem: "Verification command is missing.",
						requiredRevision: "Name the exact command and behavior it proves.",
					},
				],
			});
		}

		expect(result?.details?.state?.runMode).toBe("planning-target");
		expect(result?.details?.targetPlan?.status).toBe("drafting");
		expect(result?.details?.targetPlan?.recoveredFrom?.reason).toBe("state-refresh");
		expect(result?.details?.targetPlan?.reviews).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					lens: "execution-readiness",
					status: "rejected",
					feedback: "Execution plan is missing the verification command.",
					blockingFindingCount: 1,
				}),
			]),
		);
	});

	it("approves from submitted planning review evidence without hidden target-plan reviewers", async () => {
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		harness.session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "UNRELATED_TRANSCRIPT_SENTINEL_DO_NOT_INCLUDE" }],
			timestamp: Date.now(),
		});
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target", {
			op: "start_target",
			title: "Prove source-link smoke",
			desired_future_claim: "Source-link install exercises smoke path.",
			closure_standard: "Current smoke output exists.",
		});
		const targetState = harness.session.getGoalModeState();
		const targetPlanId = targetState?.goal.currentTargetPlan?.id;
		if (!targetPlanId) throw new Error("expected target plan id");

		await writeAndSubmitApprovedTargetPlan(harness, goalTool);
		const storedExecutionReview = harness.session
			.getGoalModeState()
			?.goal.currentTargetPlan?.reviews.find(review => review.lens === "execution-readiness");
		expect(storedExecutionReview).toMatchObject({
			lens: "execution-readiness",
			status: "accepted",
			reviewedTargetPlanId: targetPlanId,
			revisedAfterReview: false,
			source: {
				kind: "subagent",
				reviewerId: "execution-reviewer",
				artifactUri: "agent://execution-reviewer",
				validationUri: "agent://execution-reviewer/validation",
			},
		});
		expect(storedExecutionReview?.findings.map(finding => finding.id)).toEqual(["verification-command"]);
		expect(storedExecutionReview?.findings.some(finding => finding.id.startsWith("MISSING_EXECUTION_DETAIL_"))).toBe(
			false,
		);

		const reviewerCalls = goalSideAgentCalls.filter(call =>
			["goal-target-aperture-reviewer", "goal-target-execution-reviewer"].includes(call.agent.name),
		);
		expect(reviewerCalls).toHaveLength(0);
	});

	it("rejects parent completion while a target plan is still drafting", async () => {
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target-draft", {
			op: "start_target",
			title: "Prove source-link smoke",
			desired_future_claim: "Source-link install exercises smoke path.",
			closure_standard: "Current smoke output exists.",
		});
		const verifierCallsBefore = goalSideAgentCalls.filter(
			call => call.agent.name === "goal-completion-verifier",
		).length;

		await expect(goalTool.execute("complete-during-plan", { op: "complete" })).rejects.toThrow(
			"cannot complete parent goal while target planning is pending",
		);

		const state = harness.session.getGoalModeState();
		expect(state?.runMode).toBe("planning-target");
		expect(state?.goal.currentTargetPlan?.status).toBe("drafting");
		expect(goalSideAgentCalls.filter(call => call.agent.name === "goal-completion-verifier")).toHaveLength(
			verifierCallsBefore,
		);
	});

	it("keeps blocked target-plan recovery manual until recover_blocked_state", async () => {
		await harness.mode.handleGoalModeCommand("Improve quest reliability");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target-failed-plan", {
			op: "start_target",
			title: "Complete Warden's Spark",
			desired_future_claim: "Warden's Spark completes with the chosen equipment.",
			closure_standard: "Current evidence proves the equipment choice completes the quest.",
		});
		const failedSetup = harness.session.getGoalModeState();
		const target = failedSetup?.goal.currentTarget;
		const plan = failedSetup?.goal.currentTargetPlan;
		if (!target || !plan) throw new Error("expected target plan");

		await goalTool.execute("fail-plan", {
			op: "fail_target_plan",
			target_id: target.id,
			target_plan_id: plan.id,
			revision: plan.revision,
			reason: "needs-user-input",
			message: "Operator must choose whether equipping Ember Charm completes the quest.",
			blockers: ["Missing equipment decision."],
			suggested_questions: ["Does equipping Ember Charm complete Warden's Spark?"],
		});
		const blocked = harness.session.getGoalModeState();
		const block = blocked?.goal.currentBlockedState;
		if (block?.kind !== "target-plan") throw new Error("expected target-plan blocked state");
		expect(blocked?.runMode).toBe("awaiting-user-input");
		expect(await harness.session.prepareGoalContinuationDispatch()).toBeUndefined();

		await goalTool.execute("recover-blocked-state", {
			op: "recover_blocked_state",
			kind: "target-plan",
			action: "restart_target_planning",
			blocked_state_id: block.id,
			state_version: blocked?.stateVersion ?? 0,
			parent_frame_version: blocked?.parentFrameVersion ?? 0,
			target_id: target.id,
			target_plan_id: plan.id,
			revision: plan.revision,
			source_status: "failed",
			reason: "user-input",
			guidance: "Operator chose equip-completes quest.",
		});

		const reopenedState = harness.session.getGoalModeState();
		const reopenedPlan = reopenedState?.goal.currentTargetPlan;
		expect(reopenedState?.runMode).toBe("planning-target");
		expect(reopenedPlan?.id).not.toBe(plan.id);
		const dispatch = await harness.session.prepareGoalContinuationDispatch();
		expect(dispatch?.kind).toBe("target-planning");
		expect(dispatch?.customType).toBe("goal-target-planning");
		expect(dispatch?.prompt).toContain("Operator chose equip-completes quest.");
		expect(dispatch?.prompt).toContain("recoveredFrom");
		expect(dispatch?.prompt).toContain(reopenedPlan?.id ?? "missing-recovered-plan");
		expect(dispatch?.prompt).toContain(targetPlanPayloadFilePath(reopenedPlan?.planFilePath ?? "missing-plan.md"));
		expect(dispatch?.prompt).toContain("`targetPlanSubmitIdentity.payloadFilePath` is the lint/submit authority");
		expect(dispatch?.prompt).toContain("Schema-only payload fixes NEVER cause Markdown churn");
	});
	it("refuses /goal while plan mode is active", async () => {
		const showWarning = vi.spyOn(harness.mode, "showWarning");
		harness.mode.planModeEnabled = true;

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(showWarning).toHaveBeenCalledWith("Exit plan mode first.");
		expect(harness.session.getGoalModeState()).toBeUndefined();
	});

	it("refuses /plan while goal mode is active", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.handlePlanModeCommand();

		expect(showWarning).toHaveBeenCalledWith("Exit goal mode first.");
		expect(harness.mode.planModeEnabled).toBe(false);
	});

	it("rejects a new /goal objective while paused", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.handleGoalModeCommand();
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.handleGoalModeCommand("Replace the objective");

		expect(showWarning).toHaveBeenCalledWith(
			"Resume the current goal first, or drop it before setting a new objective.",
		);
		expect(harness.session.getGoalModeState()?.enabled).toBe(false);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
	});

	it("resumes the paused goal via the bare /goal menu", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValueOnce("Pause");
		await harness.mode.handleGoalModeCommand();
		expect(harness.mode.goalModePaused).toBe(true);
		selector.mockResolvedValueOnce("Resume");
		const showStatus = vi.spyOn(harness.mode, "showStatus");

		await harness.mode.handleGoalModeCommand();

		expect(showStatus).toHaveBeenCalledWith("Goal mode resumed.");
		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.mode.goalModePaused).toBe(false);
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("active");
		expect(await toolNamesFor(harness)).toContain("goal");
	});

	it("mutates the goal token budget via /goal budget without resetting accumulated usage", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		// Seed accumulated usage by driving the runtime directly — equivalent to a turn's flush.
		const goal = harness.session.getGoalModeState()?.goal;
		if (!goal) throw new Error("expected active goal");
		goal.tokensUsed = 42;
		goal.timeUsedSeconds = 5;

		await harness.mode.handleGoalModeCommand("budget 123");

		const after = harness.session.getGoalModeState();
		expect(after?.goal.tokenBudget).toBe(123);
		// Accumulated counters are preserved across the mutation.
		expect(after?.goal.tokensUsed).toBe(42);
		expect(after?.goal.timeUsedSeconds).toBe(5);

		await harness.mode.handleGoalModeCommand("budget off");
		expect(harness.session.getGoalModeState()?.goal.tokenBudget).toBeUndefined();
		expect(harness.session.getGoalModeState()?.goal.tokensUsed).toBe(42);
	});

	it("refuses /goal budget while only a paused goal exists (fix #5)", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Pause");
		await harness.mode.handleGoalModeCommand();
		expect(harness.mode.goalModePaused).toBe(true);
		const showWarning = vi.spyOn(harness.mode, "showWarning");

		await harness.mode.handleGoalModeCommand("budget 99");

		expect(showWarning).toHaveBeenCalledWith("Resume the goal before adjusting the budget.");
		// Mutation must not have run while the goal is paused.
		expect(harness.session.getGoalModeState()?.goal.tokenBudget).toBeUndefined();
	});

	it("keeps the goal active and returns continuation guidance when verification rejects completion", async () => {
		goalSideAgentMock.completionStatus = "rejected";
		goalSideAgentMock.feedback = "Missing end-to-end verification evidence.";
		goalSideAgentMock.compactorMemo = "Run the focused integration proof before trying completion again.";
		goalSideAgentMock.continuationFocus = {
			openGaps: [goalSideAgentMock.feedback],
			nextActions: [goalSideAgentMock.compactorMemo],
			evidenceToCollect: ["Current focused integration proof."],
			avoidRepeating: ["Do not redo accepted setup work."],
		};
		await harness.mode.handleGoalModeCommand("Ship the release");
		const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
			tool => tool.name === "goal",
		);
		if (!goalTool) {
			throw new Error("Expected goal tool to be active");
		}

		const result = await goalTool.execute("call-verify-reject", { op: "complete" });
		const completionText = JSON.stringify(result.content);

		expect(result.details?.completionBudgetReport).toBeNull();
		expect(result.details?.completionVerification).toMatchObject({
			status: "rejected",
			attempt: 1,
			maxAttempts: 3,
			totalAttempts: 1,
			feedback: "Missing end-to-end verification evidence.",
			structuredFeedback: {
				score: 2,
			},
		});
		expect(result.details?.completionVerification?.compactorMemo).toContain(
			"Run the focused integration proof before trying completion again.",
		);
		expect(result.details?.completionVerification?.compactorMemo).not.toContain("<goal_continuation_compaction>");
		expect(result.details?.completionVerification?.continuationMessage).toBeUndefined();
		expect(completionText).toContain("Completion verification rejected");
		expect(completionText).toContain("Run the focused integration proof before trying completion again.");
		expect(completionText).not.toContain("<goal_continuation_compaction>");
		expect(completionText).not.toContain("<prepared_goal_continuation>");
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.mode).toBe("active");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("active");
		expect(harness.session.getGoalModeState()?.goal.failedCompletionAttempts).toBe(1);
		expect(harness.session.getGoalModeState()?.runMode).toBe("awaiting-verification-repair");
		const repairDispatch = await harness.session.prepareGoalContinuationDispatch();
		expect(repairDispatch?.kind).toBe("verification-repair");
		expect(repairDispatch?.customType).toBe("goal-verification-repair");
		expect(repairDispatch?.prompt).toContain("Run the focused integration proof before trying completion again.");
		expect(goalSideAgentCalls.map(call => call.agent.name)).toContain("goal-completion-verifier");
		expect(goalSideAgentCalls.map(call => call.agent.name)).not.toContain("goal-continuation-compactor");
		const verifierCall = goalSideAgentCalls.find(call => call.agent.name === "goal-completion-verifier");
		expect(verifierCall?.agent.tools).toEqual(["read", "search", "find", "yield"]);
		expect(verifierCall?.strictToolNames).toBe(true);
		expect(verifierCall?.task).toContain("<full_transcript_file>");
		expect(verifierCall?.task).toContain("Strict test rubric");
		const entries = harness.session.sessionManager.getEntries();
		const rubricEntries = entries.filter(
			entry => entry.type === "custom_message" && entry.customType === GOAL_RUBRIC_MESSAGE_TYPE,
		);
		const feedbackEntries = entries.filter(
			entry => entry.type === "custom_message" && entry.customType === GOAL_VERIFICATION_FEEDBACK_MESSAGE_TYPE,
		);
		expect(rubricEntries).toHaveLength(1);
		const latestRubricEntry = rubricEntries[0];
		if (latestRubricEntry?.type !== "custom_message") throw new Error("expected rubric artifact");
		expect(latestRubricEntry.includeInContext).toBe(false);
		expect(feedbackEntries.length).toBeGreaterThan(0);
		const latestFeedbackEntry = feedbackEntries[feedbackEntries.length - 1];
		if (latestFeedbackEntry?.type !== "custom_message") throw new Error("expected verification feedback artifact");
		expect(JSON.stringify(latestFeedbackEntry.content)).not.toContain("<goal_continuation_compaction>");
		expect(JSON.stringify(latestFeedbackEntry.content)).not.toContain("<prepared_goal_continuation>");
		expect(JSON.stringify(latestFeedbackEntry.details)).not.toContain("<goal_continuation_compaction>");
		expect(JSON.stringify(latestFeedbackEntry.details)).not.toContain("<prepared_goal_continuation>");
		expect(JSON.stringify(latestFeedbackEntry.content)).toContain(
			"Run the focused integration proof before trying completion again.",
		);
		expect((latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails).attempt).toBe(1);
		expect((latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails).maxAttempts).toBe(3);
		expect((latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails).totalAttempts).toBe(1);
		expect((latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails).feedback).toBe(
			"Missing end-to-end verification evidence.",
		);
		expect((latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails).structuredFeedback?.score).toBe(2);
		expect((latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails).compactorMemo).toContain(
			"Run the focused integration proof before trying completion again.",
		);
		const beforeMenuCount = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message").length;
		const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("Show verification feedback");
		await harness.mode.handleGoalModeCommand();
		expect(selector.mock.calls[0]?.[1]).toContain("Show rubric");
		expect(selector.mock.calls[0]?.[1]).toContain("Show verification feedback");
		const afterMenuEntries = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message");
		expect(afterMenuEntries.length).toBe(beforeMenuCount);
		const renderedAfterMenu = Bun.stripANSI(harness.mode.chatContainer.render(120).join("\n"));
		expect(renderedAfterMenu).toContain("[goal-verification-feedback]");
		const beforeSubcommandCount = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message").length;
		await harness.mode.handleGoalModeCommand("rubric");
		await harness.mode.handleGoalModeCommand("feedback");
		const afterSubcommandEntries = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message");
		expect(afterSubcommandEntries.length).toBe(beforeSubcommandCount);
		const rubricEntry = afterSubcommandEntries.find(
			entry => entry.type === "custom_message" && entry.customType === GOAL_RUBRIC_MESSAGE_TYPE,
		);
		expect(rubricEntry).toBeDefined();
		if (rubricEntry?.type !== "custom_message") throw new Error("expected rubric artifact");
		expect(rubricEntry.includeInContext).toBe(false);
		const renderedAfterSubcommands = Bun.stripANSI(harness.mode.chatContainer.render(120).join("\n"));
		expect(renderedAfterSubcommands).toContain("[goal-rubric]");
		expect(renderedAfterSubcommands).toContain("[goal-verification-feedback]");
		expect(renderedAfterSubcommands).toContain("ctrl+o to expand");
		expect(goalSideAgentCalls.map(call => call.agent.name)).toEqual(["goal-rubric", "goal-completion-verifier"]);
	});

	it("checkpoints a closed target, schedules controller guidance, and resolves to the next target", async () => {
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		await harness.mode.handleGoalModeCommand("rubric");
		const toolsForTurn = await createTools(harness.toolSession, harness.session.getActiveToolNames());
		const goalTool = toolsForTurn.find(tool => tool.name === "goal");
		const readTool = toolsForTurn.find(tool => tool.name === "read");
		if (!goalTool || !readTool) throw new Error("Expected goal and read tools to be active");

		await goalTool.execute("target", {
			op: "start_target",
			title: "Prove source-link smoke",
			desired_future_claim: "Source-link install exercises smoke path.",
			closure_standard: "Current smoke output exists.",
			forbidden_claims: ["Release is ready"],
			parent_deliverable_ids: ["D1"],
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool);
		const checkpoint = await goalTool.execute("checkpoint", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Source-link smoke passed.",
			local_claims: ["Source-link install exercises smoke path"],
			evidence: [
				{
					claim: "Source-link install exercises smoke path",
					evidence: "Observed smoke output",
					current: true,
				},
			],
			not_claimed: ["Release is ready"],
			remaining_questions: ["Should tarball smoke be next?"],
			checks_run: ["bun test focused-smoke"],
			artifacts_touched: ["scripts/install-tests/run-ci.sh"],
		});
		const checkpointId = checkpoint.details?.checkpoint?.id;
		if (!checkpointId) throw new Error("expected checkpoint id");

		expect(checkpoint.details?.state?.runMode).toBe("awaiting-checkpoint-resolution");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("active");
		expect(harness.session.getGoalModeState()?.goal.pendingCheckpointId).toBe(checkpointId);
		expect(JSON.stringify(checkpoint.content)).toContain("Parent goal remains active");
		const checkpointAudits = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === "goal_boundary_audit")
			.filter(entry => entry.type === "custom" && JSON.stringify(entry.data).includes('"checkpoint"'));
		const checkpointAudit = checkpointAudits[checkpointAudits.length - 1];
		if (checkpointAudit?.type !== "custom") throw new Error("expected checkpoint audit");
		expect(checkpointAudit.data).toMatchObject({
			kind: "checkpoint",
			action: "accepted",
			staleFields: [],
		});
		await expect(goalTool.execute("complete-while-pending", { op: "complete" })).rejects.toThrow(
			"checkpoint is pending resolution",
		);
		await expect(readTool.execute("read-after-checkpoint", { path: "package.json" })).rejects.toThrow(
			"checkpoint is pending resolution",
		);

		const checkpointEntry = harness.session.sessionManager
			.getEntries()
			.find(entry => entry.type === "custom_message" && entry.customType === GOAL_CHECKPOINT_MESSAGE_TYPE);
		if (checkpointEntry?.type !== "custom_message") throw new Error("expected checkpoint artifact");
		const checkpointDetails = checkpointEntry.details as GoalCheckpointMessageDetails;
		expect(checkpointDetails.parentGoalActive).toBe(true);
		expect(checkpointDetails.checkpoint.id).toBe(checkpointId);
		harness.mode.rebuildChatFromMessages();
		expect(Bun.stripANSI(harness.mode.chatContainer.render(120).join("\n"))).toContain("[goal-checkpoint]");

		const guidance = await harness.session.prepareGoalContinuationDispatch();
		expect(guidance?.kind).toBe("checkpoint-resolution");
		expect(guidance?.customType).toBe(GOAL_CHECKPOINT_GUIDANCE_MESSAGE_TYPE);
		expect(guidance?.prompt).toContain(goalSideAgentMock.checkpointGuidance);
		expect(guidance?.prompt).toContain("resolve_checkpoint");
		expect(guidance?.prompt).toMatch(/decision:\s*"next_target"/);
		expect(guidance?.prompt).toContain("NEVER use `pause_for_external_control` as a generic stop");
		const guidanceCall = goalSideAgentCalls.find(call => call.agent.name === "goal-checkpoint-guidance");
		expect(guidanceCall?.agent.tools).toEqual(["read", "search", "find", "yield"]);
		expect(guidanceCall?.task).toContain("<goal_state_snapshot>");
		const goalStateFile = /<goal_state_file>\n([^<]+)\n<\/goal_state_file>/.exec(guidanceCall?.task ?? "")?.[1];
		if (!goalStateFile) throw new Error("expected checkpoint guidance goal state file");
		const guidanceState = await Bun.file(goalStateFile).text();
		expect(guidanceState).not.toContain("Strict test rubric");
		expect(guidanceState).toContain("Ship release behavior.");
		expect(guidanceState).toContain("targetSnapshot");
		expect(guidanceState).toContain("Observed smoke output");
		expect(guidance?.prompt).not.toContain("Observed smoke output");
		const guidanceTranscriptFile = /<full_transcript_file>\n([^<]+)\n<\/full_transcript_file>/.exec(
			guidanceCall?.task ?? "",
		)?.[1];
		if (!guidanceTranscriptFile) throw new Error("expected checkpoint guidance transcript file");
		const guidanceTranscript = await Bun.file(guidanceTranscriptFile).text();
		expect(guidanceTranscript).not.toContain("Strict test rubric");
		expect(guidanceTranscript).toContain("Improve release reliability");

		const stateBeforeResolution = harness.session.getGoalModeState();
		const resolved = await goalTool.execute("resolve", {
			op: "resolve_checkpoint",
			checkpoint_id: checkpointId,
			state_version: stateBeforeResolution?.stateVersion ?? 0,
			parent_frame_version: stateBeforeResolution?.parentFrameVersion ?? 0,
			decision: "next_target",
			parent_reading: "Source-link smoke is bounded local evidence; tarball smoke remains open.",
			parent_delta: {
				admitted_claims: [
					{
						id: "source-link-smoke",
						claim: "Source-link smoke passed locally.",
						status: "accepted",
						non_implications: ["Release is ready"],
					},
				],
				residuals_added_or_updated: [
					{
						id: "tarball-smoke",
						statement: "Tarball smoke remains unproven.",
						classification: "current-parent-blocker",
					},
				],
				deliverable_deltas: [{ id: "D1", status: "partial", next_relevant_target: "Prove tarball smoke" }],
			},
			not_propagated: ["Release is ready"],
			remaining_parent_work: ["Tarball smoke evidence"],
			next_target: {
				title: "Prove tarball smoke",
				desired_future_claim: "Tarball install exercises smoke path.",
				closure_standard: "Current tarball smoke output exists.",
				forbidden_claims: ["Release is ready"],
				parent_deliverable_ids: ["D1"],
			},
		});

		expect(resolved.details?.state?.runMode).toBe("planning-target");
		const stateAfterResolution = harness.session.getGoalModeState();
		expect(stateAfterResolution?.goal.pendingCheckpointId).toBeUndefined();
		expect(stateAfterResolution?.goal.currentTarget?.title).toBe("Prove tarball smoke");
		expect(stateAfterResolution?.goal.parentFrame?.acceptedClaims[0]?.id).toBe("source-link-smoke");
		expect(stateAfterResolution?.goal.deliverableMap?.[0]?.status).toBe("partial");
		expect(stateAfterResolution?.goal.currentTarget?.parentDeliverableIds).toEqual(["D1"]);
		const resolutionEntry = harness.session.sessionManager
			.getEntries()
			.find(
				entry => entry.type === "custom_message" && entry.customType === GOAL_CHECKPOINT_RESOLUTION_MESSAGE_TYPE,
			);
		if (resolutionEntry?.type !== "custom_message") throw new Error("expected resolution artifact");
		const resolutionDetails = resolutionEntry.details as GoalCheckpointResolutionMessageDetails;
		expect(resolutionDetails.parentGoalActive).toBe(true);
		harness.mode.rebuildChatFromMessages();
		expect(resolutionDetails.resolution.decision).toBe("next_target");
		expect(Bun.stripANSI(harness.mode.chatContainer.render(120).join("\n"))).toContain(
			"[goal-checkpoint-resolution]",
		);

		await harness.session.sessionManager.ensureOnDisk();
		const sessionFile = harness.session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const reopenedManager = await SessionManager.open(sessionFile);
		const restored = createRestoredSession(harness, reopenedManager);
		try {
			const restoredContext = restored.session.buildDisplaySessionContext();
			const restoredCustomTypes = restoredContext.messages.flatMap(message =>
				message.role === "custom" ? [message.customType] : [],
			);
			expect(restoredCustomTypes).toContain(GOAL_CHECKPOINT_MESSAGE_TYPE);
			expect(restoredCustomTypes).toContain(GOAL_CHECKPOINT_RESOLUTION_MESSAGE_TYPE);
			restored.mode.renderSessionContext(restoredContext);
			const restoredRendered = Bun.stripANSI(restored.mode.chatContainer.render(120).join("\n"));
			expect(restoredRendered).toContain("[goal-checkpoint]");
			expect(restoredRendered).toContain("[goal-checkpoint-resolution]");
		} finally {
			await restored.cleanup();
		}
	});

	it("resolves explicit external-control pauses without leaving checkpoint pending", async () => {
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target-pause", {
			op: "start_target",
			title: "Prove source-link smoke",
			desired_future_claim: "Source-link install exercises smoke path.",
			closure_standard: "Current smoke output exists.",
			forbidden_claims: ["Release is ready"],
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool);
		const checkpoint = await goalTool.execute("checkpoint-pause", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Source-link smoke passed.",
			local_claims: ["Source-link install exercises smoke path"],
			evidence: [
				{
					claim: "Source-link install exercises smoke path",
					evidence: "Observed smoke output",
					current: true,
				},
			],
			not_claimed: ["Release is ready"],
			remaining_questions: ["Operator must choose a release gate."],
		});
		const checkpointId = checkpoint.details?.checkpoint?.id;
		if (!checkpointId) throw new Error("expected checkpoint id");

		const stateBeforePauseResolution = harness.session.getGoalModeState();
		const resolved = await goalTool.execute("resolve-pause", {
			op: "resolve_checkpoint",
			checkpoint_id: checkpointId,
			state_version: stateBeforePauseResolution?.stateVersion ?? 0,
			parent_frame_version: stateBeforePauseResolution?.parentFrameVersion ?? 0,
			decision: "pause_for_external_control",
			parent_reading: "External operator must choose a release gate.",
			not_propagated: ["Next target selected"],
			remaining_parent_work: ["Choose the next release gate"],
			broader_checks_or_inputs: ["Operator gate selection"],
		});
		const resolveText = JSON.stringify(resolved.content);

		expect(resolved.details?.state?.runMode).toBe("awaiting-user-input");
		expect(harness.session.getGoalModeState()?.goal.pendingCheckpointId).toBeUndefined();
		expect(resolveText).toContain("Checkpoint resolution recorded: pause_for_external_control");
		expect(resolveText).not.toContain("Pending checkpoint");
		const getResult = await goalTool.execute("get-pause", { op: "get" });
		expect(JSON.stringify(getResult.content)).not.toContain("Pending checkpoint");
		const verifierCallsBefore = goalSideAgentCalls.filter(
			call => call.agent.name === "goal-completion-verifier",
		).length;
		await expect(goalTool.execute("complete-after-pause", { op: "complete" })).rejects.toThrow(
			"cannot complete parent goal while awaiting user input or external authority",
		);
		expect(goalSideAgentCalls.filter(call => call.agent.name === "goal-completion-verifier")).toHaveLength(
			verifierCallsBefore,
		);
		expect(harness.session.getGoalModeState()?.goal.totalVerificationAttempts).toBe(0);
		const blockedGoalState = harness.session.getGoalModeState();
		const blockedState = blockedGoalState?.goal.currentBlockedState;
		if (blockedState?.kind !== "checkpoint-external-pause") {
			throw new Error("expected checkpoint external-pause blocked state");
		}
		const next = await goalTool.execute("recover-after-pause", {
			op: "recover_blocked_state",
			kind: "checkpoint-external-pause",
			action: "start_next_target",
			blocked_state_id: blockedState.id,
			state_version: blockedGoalState?.stateVersion ?? 0,
			parent_frame_version: blockedGoalState?.parentFrameVersion ?? 0,
			checkpoint_id: blockedState.source.checkpointId,
			checkpoint_resolution_id: blockedState.source.checkpointResolutionId,
			reason: "user-input",
			guidance: "Operator chose the next release gate.",
			next_target: {
				title: "Choose next release gate",
				desired_future_claim: "Next release gate has selected evidence.",
				closure_standard: "Current selected-gate evidence exists.",
			},
		});
		expect(next.details?.state?.runMode).toBe("planning-target");
	});

	it("recovers committed checkpoint and resolution artifacts from restored goal state when custom messages are missing", async () => {
		await harness.mode.handleGoalModeCommand("Recover committed checkpoint artifacts");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target-recovery", {
			op: "start_target",
			title: "Prove recoverable checkpoint",
			desired_future_claim: "Committed checkpoint artifacts are recoverable.",
			closure_standard: "Restored state can rebuild checkpoint and resolution artifacts.",
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool);
		const checkpoint = await goalTool.execute("checkpoint-recovery", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Recovery checkpoint committed.",
			local_claims: ["Committed checkpoint artifacts are recoverable"],
			evidence: [
				{
					claim: "Committed checkpoint artifacts are recoverable",
					evidence: "Runtime state stores the committed checkpoint packet.",
					current: true,
				},
			],
			not_claimed: ["Parent goal is complete"],
			remaining_questions: ["Which target follows recovery proof?"],
		});
		const checkpointId = checkpoint.details?.checkpoint?.id;
		if (!checkpointId) throw new Error("expected recovery checkpoint id");
		const stateBeforeRecoveryResolution = harness.session.getGoalModeState();
		const resolved = await goalTool.execute("resolve-recovery", {
			op: "resolve_checkpoint",
			checkpoint_id: checkpointId,
			state_version: stateBeforeRecoveryResolution?.stateVersion ?? 0,
			parent_frame_version: stateBeforeRecoveryResolution?.parentFrameVersion ?? 0,
			decision: "needs_broader_checks",
			parent_reading: "Recovery proof is local; broader restored-session checks remain relevant.",
			not_propagated: ["Parent goal is complete"],
			remaining_parent_work: ["Restore/handoff evidence"],
			broader_checks_or_inputs: ["Reload persisted session and rebuild UI."],
		});
		const resolutionId = resolved.details?.checkpointResolution?.id;
		if (!resolutionId) throw new Error("expected recovery resolution id");
		const committedState = harness.session.getGoalModeState();
		if (!committedState) throw new Error("expected committed goal state");

		const recoveryManager = SessionManager.create(
			harness.tempDir.path(),
			path.join(harness.tempDir.path(), "recovery-sessions"),
		);
		const serializedState = serializeGoalModeState(committedState);
		const snapshotEntryId = recoveryManager.appendGoalStateSnapshot({
			goalId: committedState.goal.id,
			stateVersion: committedState.stateVersion,
			schemaVersion: serializedState.schemaVersion,
			reason: "recovery",
			state: serializedState,
		});
		recoveryManager.appendModeChange("goal", {
			goalId: committedState.goal.id,
			stateVersion: committedState.stateVersion,
			snapshotEntryId,
		});
		await recoveryManager.ensureOnDisk();
		const recoveryFile = recoveryManager.getSessionFile();
		if (!recoveryFile) throw new Error("expected recovery session file");
		const reopenedManager = await SessionManager.open(recoveryFile);
		const recoveryModeEntry = reopenedManager
			.getEntries()
			.find(entry => entry.type === "mode_change" && entry.mode === "goal");
		if (recoveryModeEntry?.type !== "mode_change") throw new Error("expected recovery goal mode marker");
		expect(recoveryModeEntry.data).toMatchObject({
			goalId: committedState.goal.id,
			stateVersion: committedState.stateVersion,
			snapshotEntryId,
		});
		expect(recoveryModeEntry.data?.goal).toBeUndefined();
		expect(reopenedManager.getEntries().some(entry => entry.type === "custom_message")).toBe(false);
		const reopenedContext = reopenedManager.buildSessionContext();
		const restoredState = parseGoalModeState(reopenedContext.modeData, reopenedContext.mode === "goal");
		if (!restoredState) throw new Error("expected restored recovery goal state");
		const restored = createRestoredSession(harness, reopenedManager);
		try {
			restored.session.setGoalModeState(restoredState);
			restored.session.recoverGoalArtifactsFromState();
			restored.session.recoverGoalArtifactsFromState();
			const customEntries = reopenedManager.getEntries().filter(entry => entry.type === "custom_message");
			const rubricEntries = customEntries.filter(entry => entry.customType === GOAL_RUBRIC_MESSAGE_TYPE);
			const targetPlanEntries = customEntries.filter(entry => entry.customType === GOAL_TARGET_PLAN_MESSAGE_TYPE);
			const checkpointEntries = customEntries.filter(entry => entry.customType === GOAL_CHECKPOINT_MESSAGE_TYPE);
			const resolutionEntries = customEntries.filter(
				entry => entry.customType === GOAL_CHECKPOINT_RESOLUTION_MESSAGE_TYPE,
			);
			expect(rubricEntries).toHaveLength(1);
			expect(targetPlanEntries).toHaveLength(1);
			expect(checkpointEntries).toHaveLength(1);
			expect(resolutionEntries).toHaveLength(1);
			const rubricEntry = rubricEntries[0];
			if (rubricEntry?.type !== "custom_message") throw new Error("expected rubric artifact");
			const targetPlanEntry = targetPlanEntries[0];
			if (targetPlanEntry?.type !== "custom_message") throw new Error("expected target-plan artifact");
			const targetPlanDetails = targetPlanEntries[0]?.details as GoalTargetPlanMessageDetails | undefined;
			const checkpointDetails = checkpointEntries[0]?.details as GoalCheckpointMessageDetails | undefined;
			const resolutionDetails = resolutionEntries[0]?.details as GoalCheckpointResolutionMessageDetails | undefined;
			expect(rubricEntry.includeInContext).toBe(false);
			expect(targetPlanEntry.includeInContext).toBe(false);
			expect(targetPlanDetails?.status).toBe("approved");
			expect(targetPlanDetails?.targetPlanId).toBe(restoredState.goal.targetPlans?.[0]?.id);
			expect(targetPlanDetails?.revision).toBe(restoredState.goal.targetPlans?.[0]?.revision);
			expect(checkpointDetails?.checkpoint.id).toBe(checkpointId);
			expect(checkpointDetails?.parentGoalActive).toBe(true);
			expect(resolutionDetails?.resolution.id).toBe(resolutionId);
			expect(resolutionDetails?.parentGoalActive).toBe(true);
			restored.mode.rebuildChatFromMessages();
			const rendered = Bun.stripANSI(restored.mode.chatContainer.render(120).join("\n"));
			expect(rendered).toContain("[goal-rubric]");
			expect(rendered).toContain("[goal-target-plan]");
			expect(rendered).toContain("[goal-checkpoint]");
			expect(rendered).toContain("[goal-checkpoint-resolution]");
			expect(rendered).toContain("Target plan approved");
			expect(rendered).toContain(targetPlanDetails?.targetPlanId ?? "missing-target-plan-id");
			expect(rendered).toContain(targetPlanDetails?.planFilePath ?? "missing-plan-file-path");
			expect(rendered).toContain("Checkpoint boundary recorded; parent goal still active");
			expect(rendered).toContain("Checkpoint resolved: needs_broader_checks");
			expect(JSON.stringify(resolutionEntries[0]?.content)).toContain("Checkpoint resolution");
		} finally {
			await restored.cleanup();
		}
	});

	it("resumes a paused checkpoint-resolution goal from the goal menu action", async () => {
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target-menu", {
			op: "start_target",
			title: "Prove menu checkpoint",
			desired_future_claim: "Menu checkpoint has current evidence.",
			closure_standard: "Current evidence exists.",
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool);
		await goalTool.execute("checkpoint-menu", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Menu checkpoint is pending.",
			local_claims: ["Menu checkpoint has current evidence"],
			evidence: [{ claim: "Menu checkpoint has current evidence", evidence: "Observed output", current: true }],
			not_claimed: ["Parent goal is complete"],
			remaining_questions: ["Which target follows?"],
		});
		const selector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValueOnce("Pause");
		await harness.mode.handleGoalModeCommand();
		expect(harness.mode.goalModePaused).toBe(true);
		selector.mockResolvedValueOnce("Resume checkpoint resolution");
		const showStatus = vi.spyOn(harness.mode, "showStatus");

		await harness.mode.handleGoalModeCommand();

		expect(harness.mode.goalModeEnabled).toBe(true);
		expect(harness.mode.goalModePaused).toBe(false);
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.runMode).toBe("awaiting-checkpoint-resolution");
		expect(showStatus).toHaveBeenCalledWith("Checkpoint resolution continuation scheduled.");
	});

	it("refreshes compaction preserveData from the latest goal state after target transitions", async () => {
		harness.authStorage.setRuntimeApiKey("anthropic", "test-key");
		harness.settings.set("compaction.keepRecentTokens", 1);
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target-source-link", {
			op: "start_target",
			title: "Prove source-link smoke before compaction",
			desired_future_claim: "Source-link smoke has current bounded evidence.",
			closure_standard: "Current source-link smoke output exists.",
			forbidden_claims: ["Tarball smoke is verified"],
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool);
		const staleState = harness.session.getGoalModeState();
		const staleTarget = staleState?.goal.currentTarget;
		const stalePlan = staleState?.goal.currentTargetPlan;
		if (!staleState?.enabled || !staleTarget || !stalePlan) throw new Error("expected first approved target");
		installCompactionMock({
			compactMock: "preserved",
			goalMode: serializeGoalModeState(staleState),
			goalContinuationPacket: {
				stateVersion: staleState.stateVersion,
				runMode: staleState.runMode,
				parentGoalId: staleState.goal.id,
				parentFrameVersion: staleState.parentFrameVersion,
				currentTargetId: staleTarget.id,
			},
			goalBoundaryRef: {
				schemaVersion: 1,
				purpose: "compaction",
				goalId: staleState.goal.id,
				stateVersion: staleState.stateVersion,
				runMode: staleState.runMode,
				parentFrameVersion: staleState.parentFrameVersion,
				currentTargetId: staleTarget.id,
				currentTargetPlanId: stalePlan.id,
				targetPlanRevision: stalePlan.revision,
				capturedAt: Date.now(),
			},
		});

		const checkpoint = await goalTool.execute("checkpoint-source-link", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Source-link smoke passed.",
			local_claims: ["Source-link smoke has current bounded evidence"],
			evidence: [
				{ claim: "Source-link smoke has current bounded evidence", evidence: "Observed output", current: true },
			],
			not_claimed: ["Tarball smoke is verified"],
			remaining_questions: ["Should tarball smoke be next?"],
		});
		const checkpointId = checkpoint.details?.checkpoint?.id;
		if (!checkpointId) throw new Error("expected checkpoint id");
		const stateBeforeTarballResolution = harness.session.getGoalModeState();
		await goalTool.execute("resolve-to-tarball", {
			op: "resolve_checkpoint",
			checkpoint_id: checkpointId,
			state_version: stateBeforeTarballResolution?.stateVersion ?? 0,
			parent_frame_version: stateBeforeTarballResolution?.parentFrameVersion ?? 0,
			decision: "next_target",
			parent_reading: "Source-link smoke is accepted; tarball smoke remains open.",
			not_propagated: ["Tarball smoke is verified"],
			remaining_parent_work: ["Collect tarball smoke evidence"],
			next_target: {
				title: "Prove tarball smoke after stale compaction",
				desired_future_claim: "Tarball smoke has current bounded evidence.",
				closure_standard: "Current tarball smoke output exists.",
				forbidden_claims: ["Source-link smoke proves tarball smoke"],
			},
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool);
		const latestState = harness.session.getGoalModeState();
		const latestTarget = latestState?.goal.currentTarget;
		const latestPlan = latestState?.goal.currentTargetPlan;
		if (!latestState?.enabled || !latestTarget || !latestPlan) throw new Error("expected second approved target");

		appendCompactableHistory(harness);
		const compacted = await harness.session.compact();
		const preservedGoalMode = parseGoalModeState(compacted.preserveData?.goalMode);
		expect(preservedGoalMode?.stateVersion).toBe(latestState.stateVersion);
		expect(preservedGoalMode?.goal.currentTarget?.id).toBe(latestTarget.id);
		expect(preservedGoalMode?.goal.currentTargetPlan?.id).toBe(latestPlan.id);
		const packet = compacted.preserveData?.goalContinuationPacket;
		if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
			throw new Error("expected goal continuation packet");
		}
		const packetRecord = packet as Record<string, unknown>;
		expect(packetRecord.stateVersion).toBe(latestState.stateVersion);
		expect(packetRecord.currentTargetId).toBe(latestTarget.id);
		const boundaryRef = compacted.preserveData?.goalBoundaryRef;
		if (!boundaryRef || typeof boundaryRef !== "object" || Array.isArray(boundaryRef)) {
			throw new Error("expected goal boundary ref");
		}
		const boundaryRecord = boundaryRef as Record<string, unknown>;
		expect(boundaryRecord.stateVersion).toBe(latestState.stateVersion);
		expect(boundaryRecord.currentTargetId).toBe(latestTarget.id);
		expect(boundaryRecord.currentTargetPlanId).toBe(latestPlan.id);
		expect(compacted.preserveData?.compactMock).toBe("preserved");
		const auditEntries = harness.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === "goal_boundary_audit");
		const auditEntry = auditEntries[auditEntries.length - 1];
		if (auditEntry?.type !== "custom") throw new Error("expected compaction boundary audit");
		expect(auditEntry.data).toMatchObject({
			kind: "compaction",
			action: "regenerated",
			staleFields: [],
			omittedFields: [],
		});
	});

	it("exercises a Gateway-like release flow through checkpoint, compaction, verifier repair, and final completion", async () => {
		harness.authStorage.setRuntimeApiKey("anthropic", "test-key");
		harness.settings.set("compaction.keepRecentTokens", 1);
		const compactSpy = installCompactionMock();
		const goalTool = new GoalTool(harness.toolSession);

		await goalTool.execute("create-gateway", {
			op: "create",
			objective: "Improve release reliability",
			parent_frame: {
				kind: "claim-gated",
				desired_future:
					"Release reliability advances only through explicit claims, bounded evidence, gates, and controller-approved targets.",
				current_truth: "Installer smoke coverage exists, but release readiness is not established.",
				baseline_refs: [{ id: "release-plan", kind: "doc", uri: "docs/release-plan.md" }],
				gates: [
					{
						id: "installer-smoke",
						name: "Installer smoke evidence",
						status: "unknown",
						required_evidence: ["focused installer smoke output"],
						stale_if: ["installer script changes"],
					},
				],
				boundaries: [
					{
						id: "local-smoke-not-release",
						kind: "forbidden-inference",
						statement: "Local smoke success does not imply release readiness, CI health, or tarball coverage.",
					},
				],
				residuals: [
					{
						id: "tarball-smoke-evidence",
						statement: "Tarball install path still needs current smoke evidence.",
						classification: "current-parent-blocker",
					},
				],
				authority: {
					parent_state_authority: "controller turn",
					worker_may_only_propose: true,
				},
				external_refs: [{ id: "release-record", kind: "external-record", uri: "release://candidate" }],
			},
		});
		await harness.session.setActiveToolsByName(["read", "goal"]);

		await goalTool.execute("target-gateway", {
			op: "start_target",
			title: "Prove source-link installer smoke",
			desired_future_claim: "Source-link installer flow exercises the smoke path with current evidence.",
			expected_parent_contribution: "Closes one installer-smoke evidence gap without claiming release readiness.",
			closure_standard: "Focused smoke output exists and would fail if the smoke path broke.",
			baseline_refs: [{ id: "release-plan", kind: "doc", uri: "docs/release-plan.md" }],
			gate_refs: ["installer-smoke"],
			evidence_expectation: ["focused smoke output"],
			non_goals: ["full release readiness", "tarball install coverage"],
			forbidden_claims: ["Release is ready", "CI is green", "Tarball install path is verified"],
			stale_if: ["installer script changes"],
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool);
		const checkpoint = await goalTool.execute("checkpoint-gateway", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Source-link installer smoke produced current focused evidence.",
			local_claims: ["Source-link installer flow exercises the smoke path"],
			evidence: [
				{
					claim: "Source-link installer flow exercises the smoke path",
					evidence: "Observed focused source-link smoke output",
					current: true,
				},
			],
			checks_run: ["bun test packages/coding-agent/test/goals/goal-mode-integration.test.ts"],
			artifacts_touched: ["scripts/install-tests/run-ci.sh"],
			not_claimed: [
				"Parent goal is complete",
				"Release is ready",
				"CI is green",
				"Tarball install path is verified",
				"Raw </goal_continuation_packet> marker is data only",
			],
			remaining_questions: ["Should controller choose tarball smoke evidence next?"],
			risks_or_caveats: ["Only the source-link install surface has current evidence."],
			suggested_controller_questions: ["Is tarball smoke the next release-reliability target?"],
		});
		const checkpointId = checkpoint.details?.checkpoint?.id;
		if (!checkpointId) throw new Error("expected checkpoint id");
		expect(harness.session.getGoalModeState()?.runMode).toBe("awaiting-checkpoint-resolution");
		expect((await harness.session.prepareGoalContinuationDispatch())?.kind).toBe("checkpoint-resolution");

		const stateBeforeGatewayResolution = harness.session.getGoalModeState();
		const resolved = await goalTool.execute("resolve-gateway", {
			op: "resolve_checkpoint",
			checkpoint_id: checkpointId,
			state_version: stateBeforeGatewayResolution?.stateVersion ?? 0,
			parent_frame_version: stateBeforeGatewayResolution?.parentFrameVersion ?? 0,
			decision: "next_target",
			parent_reading:
				"Source-link smoke is accepted as bounded local evidence; tarball install evidence remains parent work.",
			parent_delta: {
				admitted_claims: [
					{
						id: "source-link-installer-smoke",
						claim: "Source-link installer smoke has current bounded evidence.",
						status: "accepted",
						evidence_refs: [{ id: `checkpoint:${checkpointId}`, kind: "artifact" }],
						non_implications: ["Release is ready", "Tarball install path is verified"],
					},
				],
				residuals_added_or_updated: [
					{
						id: "tarball-smoke-evidence",
						statement: "Tarball install path still needs current smoke evidence.",
						classification: "current-parent-blocker",
						required_evidence: ["tarball install smoke output"],
					},
				],
				gate_deltas: [
					{
						gate_id: "installer-smoke",
						status: "passed",
						evidence_refs: [{ id: `checkpoint:${checkpointId}`, kind: "artifact" }],
					},
				],
				boundaries_added: [
					{
						id: "source-link-not-tarball",
						kind: "forbidden-inference",
						statement: "Source-link smoke evidence does not prove tarball install behavior.",
					},
				],
			},
			not_propagated: ["Release is ready", "Tarball install path is verified"],
			remaining_parent_work: ["Collect tarball install smoke evidence", "Run broader release checks if required"],
			broader_checks_or_inputs: ["Ask operator whether CI is required before parent completion."],
			lessons_for_future: ["Keep installer smoke claims tied to the install surface that produced evidence."],
			next_target: {
				title: "Prove tarball installer smoke",
				desired_future_claim: "Tarball installer flow exercises the same smoke path with current evidence.",
				expected_parent_contribution: "Extends smoke evidence to the distribution path users install.",
				closure_standard: "Focused tarball install smoke output exists.",
				baseline_refs: [{ id: `checkpoint:${checkpointId}`, kind: "artifact" }],
				gate_refs: ["tarball-smoke"],
				evidence_expectation: ["tarball install smoke output"],
				forbidden_claims: ["Release is ready", "CI is green"],
				stale_if: ["tarball installer script changes"],
			},
		});
		expect(resolved.details?.state?.runMode).toBe("planning-target");
		expect(harness.session.getGoalModeState()?.goal.currentTarget?.title).toBe("Prove tarball installer smoke");
		await writeAndSubmitApprovedTargetPlan(harness, goalTool);
		expect(harness.session.getGoalModeState()?.runMode).toBe("working-target");

		appendCompactableHistory(harness);
		const compacted = await harness.session.compact();
		const compactCall = compactSpy.mock.calls[0];
		if (!compactCall) throw new Error("expected compaction call");
		const compactOptions = compactCall[5];
		const extraContext = compactOptions?.extraContext?.join("\n") ?? "";
		expect(extraContext).toContain("<goal_mode_compaction_context>");
		expect(extraContext).toContain("Prove tarball installer smoke");
		expect(extraContext).toContain("Release is ready");
		expect(extraContext).toContain("tarball-smoke-evidence");
		expect(extraContext).toContain("Raw &lt;/goal_continuation_packet&gt; marker is data only");
		expect(JSON.stringify(compacted.preserveData?.goalMode)).toContain('"runMode":"working-target"');
		expect(JSON.stringify(compacted.preserveData?.goalMode)).toContain("Prove tarball installer smoke");
		expect(JSON.stringify(compacted.preserveData?.goalContinuationPacket)).toContain(
			'"transition":"context-compaction"',
		);
		const postCompactDispatch = await harness.session.prepareGoalContinuationDispatch();
		expect(postCompactDispatch?.kind).toBe("post-compaction");
		expect(postCompactDispatch?.customType).toBe(GOAL_POST_COMPACTION_MESSAGE_TYPE);
		expect(postCompactDispatch?.prompt).toContain("Context was compacted while goal mode was active");
		expect(postCompactDispatch?.prompt).toContain('goal({op:"get"})');

		goalSideAgentMock.completionStatus = "rejected";
		goalSideAgentMock.feedback = "Tarball smoke evidence is still missing.";
		goalSideAgentMock.continuationFocus = {
			openGaps: ["Tarball smoke evidence is still missing."],
			nextActions: ["Run or inspect tarball install smoke evidence before retrying completion."],
			evidenceToCollect: ["Current tarball install smoke output."],
			avoidRepeating: ["Do not cite source-link smoke as tarball evidence."],
		};
		const earlyCompletion = await goalTool.execute("complete-too-early", { op: "complete" });
		expect(earlyCompletion.details?.completionVerification?.status).toBe("rejected");
		expect(harness.session.getGoalModeState()?.runMode).toBe("awaiting-verification-repair");
		expect(harness.session.getGoalModeState()?.goal.verificationRepair?.feedback).toBe(
			"Tarball smoke evidence is still missing.",
		);
		const repairDispatch = await harness.session.prepareGoalContinuationDispatch();
		expect(repairDispatch?.kind).toBe("verification-repair");
		expect(repairDispatch?.prompt).toContain("Tarball smoke evidence is still missing.");
		expect(repairDispatch?.prompt).toContain("Do not retry `complete`");

		await goalTool.execute("repair-target", {
			op: "start_target",
			title: "Repair tarball smoke evidence",
			desired_future_claim: "Tarball smoke evidence is current enough for parent completion.",
			closure_standard: "Current tarball smoke output is recorded.",
			linked_verifier_blocker_ids: ["B1"],
			forbidden_claims: ["Release is ready without verifier acceptance"],
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool);
		const repairCheckpoint = await goalTool.execute("repair-checkpoint", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Tarball smoke evidence was gathered for verifier repair.",
			local_claims: ["Tarball smoke evidence is current"],
			evidence: [
				{ claim: "Tarball smoke evidence is current", evidence: "Observed tarball smoke output", current: true },
			],
			not_claimed: ["Parent goal is complete"],
			remaining_questions: ["Can the parent verifier accept completion now?"],
		});
		const repairCheckpointId = repairCheckpoint.details?.checkpoint?.id;
		if (!repairCheckpointId) throw new Error("expected repair checkpoint id");
		expect(harness.session.getGoalModeState()?.goal.verificationRepair).toBeUndefined();
		const stateBeforeRepairResolution = harness.session.getGoalModeState();
		const repairResolution = await goalTool.execute("repair-resolution", {
			op: "resolve_checkpoint",
			checkpoint_id: repairCheckpointId,
			state_version: stateBeforeRepairResolution?.stateVersion ?? 0,
			parent_frame_version: stateBeforeRepairResolution?.parentFrameVersion ?? 0,
			decision: "parent_completion_candidate",
			parent_reading: "Verifier repair evidence is now recorded; parent completion may be retried.",
			not_propagated: ["Parent goal is complete without verifier acceptance"],
			remaining_parent_work: ["Run parent completion verifier."],
		});
		expect(repairResolution.details?.state?.runMode).toBe("awaiting-parent-completion");
		const parentCompletionDispatch = await harness.session.prepareGoalContinuationDispatch();
		expect(parentCompletionDispatch?.kind).toBe("parent-completion");
		expect(parentCompletionDispatch?.prompt).toContain('goal({op:"complete"})');
		goalSideAgentMock.completionStatus = "verified";
		goalSideAgentMock.feedback = "Verifier accepted the repaired release-reliability evidence.";
		const finalCompletion = await goalTool.execute("complete-after-repair", { op: "complete" });
		expect(finalCompletion.details?.completionVerification?.status).toBe("verified");
		expect(harness.session.getGoalModeState()?.goal.status).toBe("complete");
		expect(harness.session.getGoalModeState()?.mode).toBe("exiting");
	});

	it("carries pending checkpoint state and goal tools across handoff compaction", async () => {
		harness.authStorage.setRuntimeApiKey("anthropic", "test-key");
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const goalTool = await activeGoalTool(harness);
		await goalTool.execute("target-handoff", {
			op: "start_target",
			title: "Prove source-link smoke before handoff",
			desired_future_claim: "Source-link smoke has current evidence before handoff.",
			closure_standard: "Current smoke output exists before handoff.",
			forbidden_claims: ["Release is ready"],
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool);
		const checkpoint = await goalTool.execute("checkpoint-handoff", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Source-link smoke was closed before handoff.",
			local_claims: ["Source-link smoke has current evidence before handoff"],
			evidence: [
				{
					claim: "Source-link smoke has current evidence before handoff",
					evidence: "Observed output",
					current: true,
				},
			],
			not_claimed: ["Release is ready"],
			remaining_questions: ["Which target should follow handoff?"],
		});
		const checkpointId = checkpoint.details?.checkpoint?.id;
		if (!checkpointId) throw new Error("expected checkpoint id");
		appendCompactableHistory(harness);
		const handoffSpy = vi
			.spyOn(compactionModule, "generateHandoff")
			.mockResolvedValue("## Goal\nContinue from handoff");

		const result = await harness.session.handoff();
		expect(result?.document).toBe("## Goal\nContinue from handoff");
		const handoffCall = handoffSpy.mock.calls[0];
		if (!handoffCall) throw new Error("expected handoff call");
		expect(handoffCall[3].customInstructions).toContain("<goal_mode_compaction_context>");
		expect(handoffCall[3].customInstructions).toContain("awaiting-checkpoint-resolution");
		expect(harness.session.getGoalModeState()?.goal.pendingCheckpointId).toBe(checkpointId);
		expect(harness.session.getActiveToolNames()).toContain("goal");

		const sessionFile = harness.session.sessionFile;
		if (!sessionFile) throw new Error("expected handoff session file");
		const persistedEntries = (await Bun.file(sessionFile).text())
			.trim()
			.split("\n")
			.map(
				line =>
					JSON.parse(line) as {
						id?: string;
						type?: string;
						mode?: string;
						data?: Record<string, unknown>;
						customType?: string;
					},
			);
		const modeEntry = persistedEntries.find(entry => entry.type === "mode_change" && entry.mode === "goal");
		if (!modeEntry?.data) throw new Error("expected carried goal mode change");
		const snapshotEntryId = modeEntry.data.snapshotEntryId;
		expect(modeEntry.data).toMatchObject({
			goalId: harness.session.getGoalModeState()?.goal.id,
			stateVersion: harness.session.getGoalModeState()?.stateVersion,
		});
		expect(modeEntry.data.goal).toBeUndefined();
		expect(typeof snapshotEntryId).toBe("string");
		expect(persistedEntries.some(entry => entry.type === "goal_state_snapshot" && entry.id === snapshotEntryId)).toBe(
			true,
		);
		const persistedManager = await SessionManager.open(sessionFile);
		const restoredContext = persistedManager.buildSessionContext();
		const restored = parseGoalModeState(restoredContext.modeData, restoredContext.mode === "goal");
		if (!restored) throw new Error("expected restorable goal mode state");
		expect(restored.runMode).toBe("awaiting-checkpoint-resolution");
		expect(restored.goal.pendingCheckpointId).toBe(checkpointId);
		expect(restored.goal.checkpoints?.[0]?.id).toBe(checkpointId);

		const postHandoffDispatch = await harness.session.prepareGoalContinuationDispatch();
		expect(postHandoffDispatch?.kind).toBe("post-compaction");
		expect(postHandoffDispatch?.customType).toBe(GOAL_POST_COMPACTION_MESSAGE_TYPE);
		expect(postHandoffDispatch?.prompt).toContain("awaiting-checkpoint-resolution");

		const dispatch = await harness.session.prepareGoalContinuationDispatch();
		expect(dispatch?.kind).toBe("checkpoint-resolution");
		expect(dispatch?.customType).toBe(GOAL_CHECKPOINT_GUIDANCE_MESSAGE_TYPE);
		expect(dispatch?.prompt).toContain("resolve_checkpoint");
	});

	it("rejects checkpoint packets through the read-only reviewer without closing the target", async () => {
		goalSideAgentMock.checkpointReviewStatus = "rejected";
		goalSideAgentMock.checkpointReviewFeedback = "Smoke output is missing.";
		await harness.mode.handleGoalModeCommand("Improve release reliability");
		const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
			tool => tool.name === "goal",
		);
		if (!goalTool) throw new Error("Expected goal tool to be active");
		await goalTool.execute("target", {
			op: "start_target",
			title: "Prove source-link smoke",
			desired_future_claim: "Source-link install exercises smoke path.",
			closure_standard: "Current smoke output exists.",
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool);

		const checkpoint = await goalTool.execute("checkpoint", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Weak source-link smoke evidence.",
			local_claims: ["Source-link install exercises smoke path"],
			evidence: [{ claim: "Source-link install exercises smoke path", evidence: "File changed", current: true }],
			not_claimed: ["Release is ready"],
			remaining_questions: ["Need stronger evidence."],
		});

		const checkpointText = checkpoint.content[0]?.type === "text" ? checkpoint.content[0].text : "";
		expect(checkpointText).toContain("Checkpoint rejected. Target remains active");
		expect(checkpointText).not.toContain("Target checkpoint recorded");
		expect(checkpointText).not.toContain("Ordinary continuation is paused");
		expect(checkpoint.details?.checkpointReview?.status).toBe("rejected");
		expect(checkpoint.details?.state?.runMode).toBe("working-target");
		expect(harness.session.getGoalModeState()?.goal.currentTarget?.status).toBe("active");
		expect(harness.session.getGoalModeState()?.goal.lastCheckpointRejection?.review.feedback).toBe(
			"Smoke output is missing.",
		);
		const checkpointEntry = harness.session.sessionManager
			.getEntries()
			.find(entry => entry.type === "custom_message" && entry.customType === GOAL_CHECKPOINT_MESSAGE_TYPE);
		if (checkpointEntry?.type !== "custom_message") throw new Error("expected rejected checkpoint artifact");
		expect(JSON.stringify(checkpointEntry.content)).toContain("Checkpoint rejected; target remains active");
		expect(JSON.stringify(checkpointEntry.content)).not.toContain("Target closed; parent goal still active");
		const reviewerCall = goalSideAgentCalls.find(call => call.agent.name === "goal-checkpoint-reviewer");
		expect(reviewerCall?.agent.tools).toEqual(["read", "search", "find", "yield"]);
		expect(reviewerCall?.task).toContain("<goal_state_snapshot>");
	});

	it("persists verifier feedback when continuation compaction fails", async () => {
		goalSideAgentMock.completionStatus = "rejected";
		goalSideAgentMock.feedback = "Verifier found a blocking gap before compaction.";
		goalSideAgentMock.compactorFails = true;
		goalSideAgentMock.continuationFocus = undefined;
		await harness.mode.handleGoalModeCommand("Ship the release");
		const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
			tool => tool.name === "goal",
		);
		if (!goalTool) {
			throw new Error("Expected goal tool to be active");
		}

		const result = await goalTool.execute("call-verify-compactor-fail", { op: "complete" });
		expect(result.details?.completionVerification?.status).toBe("rejected");
		expect(result.details?.completionVerification?.compactorMemo).toBeUndefined();
		const repairDispatch = await harness.session.prepareGoalContinuationDispatch();
		expect(repairDispatch?.kind).toBe("verification-repair");
		expect(repairDispatch?.prompt).toContain("Verifier found a blocking gap before compaction.");

		const goal = harness.session.getGoalModeState()?.goal;
		expect(goal?.failedCompletionAttempts).toBe(1);
		expect(goal?.lastVerificationAttempt).toBe(1);
		expect(goal?.lastVerificationFeedback).toBe("Verifier found a blocking gap before compaction.");
		expect(goal?.lastVerificationCompactorMemo).toBeUndefined();
		const feedbackEntries = harness.session.sessionManager
			.getEntries()
			.filter(
				entry => entry.type === "custom_message" && entry.customType === GOAL_VERIFICATION_FEEDBACK_MESSAGE_TYPE,
			);
		expect(feedbackEntries.length).toBeGreaterThan(0);
		const latestFeedbackEntry = feedbackEntries[feedbackEntries.length - 1];
		if (latestFeedbackEntry?.type !== "custom_message") throw new Error("expected verification feedback artifact");
		const details = latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails;
		expect(details.attempt).toBe(1);
		expect(details.maxAttempts).toBe(3);
		expect(details.feedback).toBe("Verifier found a blocking gap before compaction.");
		expect(details.totalAttempts).toBe(1);
		expect(details.structuredFeedback?.completionBlockers[0]?.id).toBe("B1");
		expect(details.compactorMemo).toBeUndefined();
		expect(JSON.stringify(latestFeedbackEntry.content)).not.toContain("<goal_continuation_compaction>");
	});
	it("blocks repeated parent completion until verifier blockers get fresh repair evidence", async () => {
		goalSideAgentMock.completionStatus = "rejected";
		goalSideAgentMock.feedback = "Still missing verification evidence.";
		goalSideAgentMock.compactorMemo = "Keep gathering proof.";
		goalSideAgentMock.continuationFocus = undefined;
		await harness.mode.handleGoalModeCommand("Ship the release");
		const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
			tool => tool.name === "goal",
		);
		if (!goalTool) {
			throw new Error("Expected goal tool to be active");
		}

		await goalTool.execute("call-verify-reject-1", { op: "complete" });
		await expect(goalTool.execute("call-verify-reject-2", { op: "complete" })).rejects.toThrow("verifier blockers");
		expect(harness.session.getGoalModeState()?.runMode).toBe("awaiting-verification-repair");
		expect(harness.session.getGoalModeState()?.goal.failedCompletionAttempts).toBe(1);
		expect(harness.session.getGoalModeState()?.goal.verificationRepair?.feedback).toBe(
			"Still missing verification evidence.",
		);

		await harness.session.goalRuntime.onToolCompleted("read");
		await expect(goalTool.execute("call-verify-reject-3", { op: "complete" })).rejects.toThrow("verifier blockers");
		await goalTool.execute("repair-target-repeat", {
			op: "start_target",
			title: "Gather missing verifier evidence",
			desired_future_claim: "Missing verifier evidence is current.",
			closure_standard: "Current evidence is recorded for blocker B1.",
			linked_verifier_blocker_ids: ["B1"],
		});
		await writeAndSubmitApprovedTargetPlan(harness, goalTool);
		const checkpoint = await goalTool.execute("repair-checkpoint-repeat", {
			op: "checkpoint",
			status: "closed_with_evidence",
			summary: "Fresh verifier evidence was gathered.",
			local_claims: ["Missing verifier evidence is current"],
			evidence: [
				{ claim: "Missing verifier evidence is current", evidence: "Observed focused proof", current: true },
			],
			not_claimed: ["Parent goal is complete"],
			remaining_questions: ["Should completion be retried?"],
		});
		const checkpointId = checkpoint.details?.checkpoint?.id;
		if (!checkpointId) throw new Error("expected repair checkpoint id");
		const stateBeforeRepeatedRepairResolution = harness.session.getGoalModeState();
		await goalTool.execute("repair-resolution-repeat", {
			op: "resolve_checkpoint",
			checkpoint_id: checkpointId,
			state_version: stateBeforeRepeatedRepairResolution?.stateVersion ?? 0,
			parent_frame_version: stateBeforeRepeatedRepairResolution?.parentFrameVersion ?? 0,
			decision: "parent_completion_candidate",
			parent_reading: "Fresh verifier evidence is recorded.",
			not_propagated: ["Parent goal is complete without verifier acceptance"],
			remaining_parent_work: ["Retry parent completion verification."],
		});
		const second = await goalTool.execute("call-verify-reject-4", { op: "complete" });

		expect(second.details?.completionVerification?.attempt).toBe(1);
		expect(second.details?.completionVerification?.totalAttempts).toBe(2);
		expect(harness.session.getGoalModeState()?.goal.failedCompletionAttempts).toBe(1);
		const feedbackEntries = harness.session.sessionManager
			.getEntries()
			.filter(
				entry => entry.type === "custom_message" && entry.customType === GOAL_VERIFICATION_FEEDBACK_MESSAGE_TYPE,
			);
		const latestFeedbackEntry = feedbackEntries[feedbackEntries.length - 1];
		if (latestFeedbackEntry?.type !== "custom_message") throw new Error("expected verification feedback artifact");
		const details = latestFeedbackEntry.details as GoalVerificationFeedbackMessageDetails;
		expect(details.attempt).toBe(1);
		expect(details.totalAttempts).toBe(2);
		expect(details.feedback).toBe("Still missing verification evidence.");
		expect(harness.session.getGoalModeState()?.goal.verificationAttempts?.length).toBe(2);
	});

	it("returns the completion report from the goal tool and exits goal mode before the next turn rebuild", async () => {
		await harness.mode.handleGoalModeCommand("Ship the release");
		await harness.mode.handleGoalModeCommand("budget 50");
		const appendCustomEntry = vi.spyOn(harness.session.sessionManager, "appendCustomEntry");
		const goalTool = (await createTools(harness.toolSession, harness.session.getActiveToolNames())).find(
			tool => tool.name === "goal",
		);
		if (!goalTool) {
			throw new Error("Expected goal tool to be active");
		}

		const result = await goalTool.execute("call-1", { op: "complete" });
		const completionText = JSON.stringify(result.content);

		expect(result.details?.completionBudgetReport).toBe(
			"Goal achieved. Report final budget usage to the user: tokens used: 7 of 50.",
		);
		expect(completionText).toContain("Goal achieved. Report final budget usage to the user: tokens used: 7 of 50.");
		expect(harness.session.getGoalModeState()?.mode).toBe("exiting");
		// Per fix #1: completeGoalFromTool clears state.enabled so subsequent createTools
		// calls (e.g. mid-turn refreshes) no longer advertise the goal tool. The model's
		// existing toolset for the in-flight turn is unaffected — what we care about here
		// is that the next createTools observation reflects the deactivation.
		expect(harness.session.getGoalModeState()?.enabled).toBe(false);
		expect(await toolNamesFor(harness)).not.toContain("goal");

		const nextTurn = harness.mode.getUserInput();
		// getUserInput observes mode === "exiting" and awaits #exitGoalMode before
		// arming onInputCallback. Drain microtasks until that side-effect lands.
		for (let i = 0; i < 100 && harness.session.getGoalModeState() !== undefined; i++) {
			await Bun.sleep(0);
		}
		expect(harness.mode.goalModeEnabled).toBe(false);
		expect(harness.mode.goalModePaused).toBe(false);
		expect(harness.session.getGoalModeState()).toBeUndefined();
		expect(await toolNamesFor(harness)).not.toContain("goal");
		expect(appendCustomEntry).toHaveBeenCalledWith(
			"goal-completed",
			expect.objectContaining({
				objective: "Ship the release",
				tokenBudget: 50,
				tokensUsed: 7,
			}),
		);

		harness.mode.onInputCallback?.(harness.mode.startPendingSubmission({ text: "next turn" }));
		await nextTurn;
	});
});
