import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { AsyncJob, AsyncJobManager, AsyncTaskJobStatus } from "../async";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { shimmerEnabled, shimmerText } from "../modes/theme/shimmer";
import type { Theme } from "../modes/theme/theme";
import jobDescription from "../prompts/tools/job.md" with { type: "text" };
import type { AgentStatus } from "../registry/agent-registry";
import { formatRuntimePolicySummary } from "../task/runtime-policy";
import { oneLineLabel } from "../task/types";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from "./index";
import {
	formatBadge,
	formatDuration,
	formatEmptyMessage,
	formatStatusIcon,
	getPreviewLines,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
} from "./render-utils";
import { ToolError } from "./tool-errors";

const jobSchema = type({
	"poll?": type("string[]").describe("job ids to wait for; omit to wait on all running jobs"),
	"cancel?": type("string[]").describe("job ids to cancel"),
	"list?": type("boolean").describe("snapshot all jobs"),
});

type JobParams = typeof jobSchema.infer;

const WAIT_DURATION_MS: Record<string, number> = {
	"5s": 5_000,
	"10s": 10_000,
	"30s": 30_000,
	"1m": 60_000,
	"5m": 5 * 60_000,
};

function parseWaitDurationMs(value: string | undefined): number {
	return (value ? WAIT_DURATION_MS[value] : undefined) ?? WAIT_DURATION_MS["30s"];
}

interface JobAgentSnapshot {
	status: AgentStatus;
	lastActivity: number;
	activity?: string;
}

export type JobSnapshotStatus = AsyncTaskJobStatus | AsyncJob["status"];

export interface JobSnapshot {
	id: string;
	type: "bash" | "task";
	/** Task semantic state when available; otherwise the scheduler state. */
	status: JobSnapshotStatus;
	/** Scheduler state remains explicit and independent from task termination. */
	schedulerStatus: AsyncJob["status"];
	label: string;
	durationMs: number;
	/** Exact manager delivery; task results retain every SingleResult field. */
	result?: AsyncJob["result"];
	resultText?: string;
	errorText?: string;
	agent?: JobAgentSnapshot;
}

type CancelStatus = "cancelled" | "not_found" | "already_completed";

interface CancelOutcome {
	id: string;
	status: CancelStatus;
	message: string;
}

/**
 * A live subagent from the AgentRegistry that has no backing job in the
 * AsyncJobManager — e.g. an idle agent woken (or a parked agent revived) via
 * `irc`, or a spawn owned by another agent. Surfaced by `list` and empty-poll
 * snapshots so the job tool's picture matches the UI's running-agent count.
 */
interface AgentActivitySnapshot {
	id: string;
	parentId?: string;
	/** Latest activity gist recorded by the registry (display-only). */
	activity?: string;
	/** Time since the agent was registered. */
	ageMs: number;
}

export interface JobToolDetails {
	jobs: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
	/** Running subagents not represented by a job row in this result. */
	agents?: AgentActivitySnapshot[];
}

/**
 * A poll snapshot where every watched job is still running and nothing was
 * cancelled — pure "still waiting" noise once a newer poll exists. The TUI
 * keeps such a block un-finalized (displaceable) so a follow-up `job` call
 * replaces it instead of stacking another waiting frame in the transcript.
 */
function isPendingJob(job: JobSnapshot): boolean {
	return job.schedulerStatus === "running";
}

export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as JobToolDetails | undefined;
	if (!d || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.cancelled?.length) return false;
	return d.jobs.every(isPendingJob);
}

function formatAgentDiagnostic(agent: JobAgentSnapshot): string {
	const parts = [agent.status, `active ${formatDuration(Math.max(0, Date.now() - agent.lastActivity))} ago`];
	if (agent.activity) parts.push(oneLineLabel(agent.activity));
	return parts.join(" · ");
}

export class JobTool implements AgentTool<typeof jobSchema, JobToolDetails> {
	readonly name = "job";
	readonly approval = "read" as const;
	readonly label = "Job";
	readonly summary = "Manage long-running background jobs (async bash/python)";
	readonly description: string;
	readonly parameters = jobSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(jobDescription);
	}

	async execute(
		_toolCallId: string,
		params: JobParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<JobToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<JobToolDetails>> {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			return {
				content: [{ type: "text", text: "Async execution is disabled; no background jobs are available." }],
				details: { jobs: [] },
			};
		}

		// Scope every visible operation to the calling agent. Tests / SDK
		// consumers without an agent id see everything (legacy behavior).
		const ownerId = this.session.getAgentId?.() ?? undefined;
		const ownerFilter = ownerId ? { ownerId } : undefined;

		// `list` is a read-only snapshot mode. Replaces the legacy `jobs://` URL.
		if (params.list) {
			if (params.cancel?.length || params.poll?.length) {
				throw new ToolError("`list` cannot be combined with `poll` or `cancel`.");
			}
			const jobs = manager.getAllJobs(ownerFilter);
			const agents = this.#runningAgentsOutsideJobs();
			return this.#buildResult(manager, jobs, [], agents);
		}

		const cancelIds = params.cancel ?? [];
		const cancelOutcomes: CancelOutcome[] = [];
		for (const id of cancelIds) {
			const existing = manager.getJob(id);
			if (!existing || (ownerId && existing.ownerId !== ownerId)) {
				cancelOutcomes.push({ id, status: "not_found", message: `Background job not found: ${id}` });
				continue;
			}
			if (existing.status !== "running") {
				cancelOutcomes.push({
					id,
					status: "already_completed",
					message: `Background job ${id} is already ${existing.status}.`,
				});
				continue;
			}
			const cancelled = manager.cancel(id, ownerFilter);
			cancelOutcomes.push(
				cancelled
					? { id, status: "cancelled", message: `Cancelled background job ${id}.` }
					: { id, status: "already_completed", message: `Background job ${id} is already completed.` },
			);
		}

		const requestedPollIds = params.poll;
		// If only `cancel` was provided (no `poll`), don't wait \u2014 return immediately.
		const shouldPoll = requestedPollIds !== undefined || cancelIds.length === 0;

		if (!shouldPoll) {
			const cancelledJobs = this.#visibleJobs(manager, cancelIds, ownerId);
			return this.#buildResult(manager, cancelledJobs, cancelOutcomes);
		}

		// Resolve which jobs to watch.
		// - If `poll` was passed explicitly, watch exactly those (filtered to existing).
		// - If `poll` was omitted (and so was `cancel`), default to all running jobs.
		const jobsToWatch = requestedPollIds
			? this.#visibleJobs(manager, requestedPollIds, ownerId)
			: manager.getRunningJobs(ownerFilter);

		if (jobsToWatch.length === 0) {
			if (cancelOutcomes.length > 0) {
				const cancelledJobs = this.#visibleJobs(manager, cancelIds, ownerId);
				return this.#buildResult(manager, cancelledJobs, cancelOutcomes);
			}
			// Zero pollable jobs is not necessarily "nothing running": agents
			// woken via irc or owned by another agent run with no job entry.
			// Report them so the snapshot matches the UI's running-agent count
			// (task job ids are agent ids, so a stale poll id often names one).
			const agents = this.#runningAgentsOutsideJobs();
			const lines: string[] = [];
			if (requestedPollIds?.length) {
				lines.push(`No matching jobs found for IDs: ${requestedPollIds.join(", ")}`);
				const registry = this.session.agentRegistry;
				for (const id of requestedPollIds) {
					const ref = registry?.get(id);
					if (!ref) continue;
					lines.push(
						ref.status === "running"
							? `- \`${id}\` is a running agent with no job entry — coordinate via \`irc\`; transcript at history://${id}`
							: `- \`${id}\` is a ${ref.status} agent (its job is gone) — transcript at history://${id}`,
					);
				}
			} else {
				lines.push("No running background jobs to wait for.");
			}
			if (agents.length > 0) {
				lines.push("", ...this.#describeAgents(agents));
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { jobs: [], ...(agents.length ? { agents } : {}) },
				// Nothing found / nothing to wait for is noise once consumed —
				// the follow-up call has already corrected course. Running agents
				// are real state the model may act on, so keep those results.
				...(agents.length === 0 ? { useless: true } : {}),
			};
		}

		// If all watched jobs are already done, build immediate result.
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (runningJobs.length === 0) {
			const cancelledJobs = cancelIds.map(id => manager.getJob(id)).filter(j => j != null);
			return this.#buildResult(manager, [...cancelledJobs, ...jobsToWatch], cancelOutcomes);
		}

		// Wait until at least one running job finishes, the wait window elapses,
		// or the call is aborted. With `async.pollWaitDuration` set to `smart`,
		// the window adapts: it starts at the ladder floor and climbs as the agent
		// polls in a tight loop, then resets to the floor once the agent steps
		// away from polling (see AsyncJobManager.nextPollWaitMs). Any fixed value
		// waits that exact duration every time.
		const racePromises: Promise<unknown>[] = runningJobs.map(j => j.promise);
		const pollSetting = this.session.settings.get("async.pollWaitDuration");
		const smartPoll = pollSetting === "smart";
		const waitMs = smartPoll ? manager.nextPollWaitMs(ownerId) : parseWaitDurationMs(pollSetting);
		const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
		const timeoutHandle = setTimeout(() => timeoutResolve(), waitMs);
		racePromises.push(timeoutPromise);

		const watchedJobIds = runningJobs.map(job => job.id);
		manager.watchJobs(watchedJobIds);

		const cancelledJobs = this.#visibleJobs(manager, cancelIds, ownerId);
		const allTrackedJobs = [...cancelledJobs, ...jobsToWatch];

		const PROGRESS_INTERVAL_MS = 500;
		const emitProgress = () => {
			if (!onUpdate) return;
			const snapshot = this.#snapshotJobs(allTrackedJobs);
			onUpdate({
				content: [{ type: "text", text: "" }],
				details: {
					jobs: snapshot,
					...(cancelOutcomes.length
						? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) }
						: {}),
				},
			});
		};
		const progressTimer = onUpdate ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		emitProgress();

		try {
			if (signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
				const onAbort = () => abortResolve();
				signal.addEventListener("abort", onAbort, { once: true });
				racePromises.push(abortPromise);
				try {
					await Promise.race(racePromises);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} else {
				await Promise.race(racePromises);
			}
		} finally {
			manager.unwatchJobs(watchedJobIds);
			clearTimeout(timeoutHandle);
			if (progressTimer) clearInterval(progressTimer);
			if (smartPoll) {
				// Reset the idle-gap clock: escalate if the agent polls again soon,
				// drop back to the floor once it goes quiet for a while.
				manager.recordPollWaitEnd(ownerId);
			}
		}

		return this.#buildResult(manager, allTrackedJobs, cancelOutcomes);
	}

	/**
	 * Resolve a list of job ids to job records visible to the calling agent.
	 * Drops missing ids and ids owned by other agents, so cross-agent inspection
	 * via the `job` tool is impossible.
	 */
	#visibleJobs(manager: AsyncJobManager, ids: string[], ownerId: string | undefined): AsyncJob[] {
		const out: AsyncJob[] = [];
		for (const id of ids) {
			const job = manager.getJob(id);
			if (!job) continue;
			if (ownerId && job.ownerId !== ownerId) continue;
			out.push(job);
		}
		return out;
	}

	/**
	 * Running subagents from the registry that are not covered by one of the
	 * caller's running jobs. Agents woken via `irc` (idle wake / park revival)
	 * and spawns owned by another agent run with no AsyncJobManager entry, yet
	 * the UI's agent badge counts them — a snapshot must account for that
	 * activity instead of implying the system is quiet. Existence is already
	 * public via the `irc` roster, so listing ids here leaks nothing new; job
	 * *control* stays owner-scoped.
	 */
	#runningAgentsOutsideJobs(): AgentActivitySnapshot[] {
		const registry = this.session.agentRegistry;
		if (!registry) return [];
		const selfId = this.session.getAgentId?.() ?? undefined;
		const covered = new Set<string>();
		const manager = this.session.asyncJobManager;
		if (manager) {
			for (const job of manager.getRunningJobs(selfId ? { ownerId: selfId } : undefined)) {
				covered.add(job.id);
				if (job.agentId) covered.add(job.agentId);
			}
		}
		const now = Date.now();
		const out: AgentActivitySnapshot[] = [];
		for (const ref of registry.list()) {
			if (ref.kind !== "sub" || ref.status !== "running") continue;
			if (ref.id === selfId || covered.has(ref.id)) continue;
			out.push({
				id: ref.id,
				...(ref.parentId ? { parentId: ref.parentId } : {}),
				...(ref.activity ? { activity: ref.activity } : {}),
				ageMs: Math.max(0, now - ref.createdAt),
			});
		}
		return out;
	}

	/** Model-facing lines for the running-agents section shared by `list` and empty-poll results. */
	#describeAgents(agents: AgentActivitySnapshot[]): string[] {
		const lines = [`## Running Agents (${agents.length}) — not job-backed\n`];
		for (const agent of agents) {
			const parent = agent.parentId ? ` (spawned by \`${agent.parentId}\`)` : "";
			const activity = agent.activity ? ` — ${agent.activity}` : "";
			lines.push(`- \`${agent.id}\`${parent} — up ${formatDuration(agent.ageMs)}${activity}`);
		}
		lines.push("", "These agents have no job entry; coordinate via `irc`, transcripts at `history://<id>`.");
		return lines;
	}

	#snapshotJobs(jobs: AsyncJob[]): JobSnapshot[] {
		const now = Date.now();
		return jobs.map(job => {
			const current = this.session.asyncJobManager?.getJob(job.id);
			const latest = current ?? job;
			// A task's preferred job id is its agent id. If a collision suffixes
			// the job id, its label still carries the unsuffixed agent id.
			const agentRef =
				latest.type === "task"
					? (this.session.agentRegistry?.get(latest.label) ?? this.session.agentRegistry?.get(latest.id))
					: undefined;
			const activity = agentRef?.activity ? oneLineLabel(agentRef.activity) : "";
			const taskResult = latest.result?.kind === "task" ? latest.result.result : undefined;
			const status: JobSnapshotStatus = taskResult
				? taskResult.termination.status
				: latest.status === "cancelled"
					? "cancelled"
					: (latest.taskStatus ?? latest.status);
			return {
				id: latest.id,
				type: latest.type,
				status,
				schedulerStatus: latest.status,
				label: latest.label,
				durationMs: Math.max(0, now - latest.startTime),
				...(latest.result ? { result: latest.result } : {}),
				...(latest.resultText ? { resultText: latest.resultText } : {}),
				...(latest.errorText ? { errorText: latest.errorText } : {}),
				...(agentRef
					? {
							agent: {
								status: agentRef.status,
								lastActivity: agentRef.lastActivity,
								...(activity ? { activity } : {}),
							},
						}
					: {}),
			};
		});
	}

	#buildResult(
		manager: AsyncJobManager,
		jobs: AsyncJob[],
		cancelOutcomes: CancelOutcome[],
		agents: AgentActivitySnapshot[] = [],
	): AgentToolResult<JobToolDetails> {
		// Deduplicate by id (cancelled jobs may also appear in the watched set).
		const seen = new Set<string>();
		const uniqueJobs = jobs.filter(j => {
			if (seen.has(j.id)) return false;
			seen.add(j.id);
			return true;
		});
		const jobResults = this.#snapshotJobs(uniqueJobs);

		manager.acknowledgeDeliveries(jobResults.filter(job => !isPendingJob(job)).map(job => job.id));

		const settled = jobResults.filter(job => !isPendingJob(job));
		const pending = jobResults.filter(isPendingJob);

		const lines: string[] = [];

		if (cancelOutcomes.length > 0) {
			lines.push(`## Cancelled (${cancelOutcomes.length})\n`);
			for (const o of cancelOutcomes) lines.push(`- ${o.message}`);
			lines.push("");
		}

		if (settled.length > 0) {
			lines.push(`## Settled (${settled.length})\n`);
			for (const job of settled) {
				lines.push(`### ${job.id} [${job.type}] — ${job.status}`);
				lines.push(`Label: ${job.label}`);
				if (job.agent) lines.push(`Agent session: ${formatAgentDiagnostic(job.agent)}`);
				if (job.result?.kind === "task") {
					const { result } = job.result;
					const { termination } = result;
					lines.push(`Termination: ${termination.code} — ${termination.reason}`);
					lines.push(`Resumable: ${termination.resumable ? "yes" : "no"}`);
					lines.push(`History: ${termination.historyUri}`);
					lines.push(`Output: ${termination.outputUri}`);
					const output = result.output.trim();
					if (output && output !== termination.reason.trim()) lines.push("```", output, "```");
				} else {
					if (job.resultText) lines.push("```", job.resultText, "```");
					if (job.errorText) lines.push(`Error: ${job.errorText}`);
				}
				lines.push("");
			}
		}

		if (pending.length > 0) {
			lines.push(`## Still Running (${pending.length})\n`);
			for (const job of pending) {
				const agent = job.agent ? ` — agent ${formatAgentDiagnostic(job.agent)}` : "";
				lines.push(`- \`${job.id}\` [${job.type}] — ${job.status} — ${job.label}${agent}`);
			}
		}

		if (agents.length > 0) {
			if (lines.length > 0) lines.push("");
			lines.push(...this.#describeAgents(agents));
		}

		// A tool result must never be empty text — the model cannot tell "no
		// jobs" from a malfunction (reported exactly that way in QA).
		if (lines.length === 0) {
			lines.push("No background jobs.");
		}

		const details: JobToolDetails = {
			jobs: jobResults,
			...(cancelOutcomes.length ? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) } : {}),
			...(agents.length ? { agents } : {}),
		};
		return {
			content: [{ type: "text", text: lines.join("\n").trimEnd() }],
			details,
			// A poll where everything is still running carries no new information
			// once a later poll exists — same predicate the TUI uses to displace
			// stale waiting frames.
			...(isWaitingPollDetails(details) ? { useless: true } : {}),
		};
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface JobRenderArgs {
	poll?: string[];
	cancel?: string[];
	list?: boolean;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const LABEL_MAX_WIDTH = 60;
const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const LABEL_LINES_COLLAPSED = 1;
const LABEL_LINES_EXPANDED = 3;
const PREVIEW_LINE_WIDTH = 80;

function statusToIcon(status: JobSnapshot["status"]): ToolUIStatus {
	switch (status) {
		case "completed":
			return "done";
		case "failed":
		case "aborted":
			return "error";
		case "paused":
		case "cancelled":
			return "aborted";
		case "waiting":
		case "running":
			return "running";
	}
}

function statusToColor(status: JobSnapshot["status"]): ToolUIColor {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
		case "aborted":
			return "error";
		case "paused":
		case "cancelled":
			return "warning";
		case "waiting":
		case "running":
			return "accent";
	}
}

function agentStatusToColor(status: AgentStatus): ToolUIColor {
	switch (status) {
		case "running":
		case "waiting":
			return "accent";
		case "idle":
			return "success";
		case "paused":
			return "warning";
		case "parked":
			return "muted";
		case "aborted":
			return "error";
	}
}

/**
 * Pretty-printed JSON output wastes the collapsed one-line preview on a lone
 * "{" — flatten structured-looking bodies onto a single line. Slice first:
 * downstream truncation keeps at most a few hundred columns, so collapsing
 * whitespace across a multi-KB body would be pure waste.
 */
function flattenStructuredPreview(text: string): string {
	const first = text[0];
	if (first !== "{" && first !== "[") return text;
	return text.slice(0, PREVIEW_LINES_EXPANDED * PREVIEW_LINE_WIDTH * 2).replace(/\s+/g, " ");
}

function describeTarget(args: JobRenderArgs | undefined): string {
	if (args?.list) return "background jobs";
	const poll = args?.poll ?? [];
	const cancel = args?.cancel ?? [];
	const parts: string[] = [];
	if (cancel.length > 0) {
		parts.push(cancel.length === 1 ? `cancel ${cancel[0]}` : `cancel ${cancel.length} jobs`);
	}
	if (poll.length > 0) {
		parts.push(poll.length === 1 ? `poll ${poll[0]}` : `poll ${poll.length} jobs`);
	}
	if (parts.length === 0) return "all running jobs";
	return parts.join(", ");
}

export const jobToolRenderer = {
	inline: true,

	renderCall(args: JobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: describeTarget(args) || "Job" }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: JobToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: JobRenderArgs,
	): Component {
		let jobs = result.details?.jobs ?? [];
		const agents = result.details?.agents ?? [];

		if (jobs.length === 0 && agents.length === 0) {
			const fallback = result.content?.find(c => c.type === "text")?.text || "No jobs to process";
			const header = renderStatusLine({ icon: "warning", title: describeTarget(args) || "Job" }, uiTheme);
			return new Text([header, formatEmptyMessage(fallback, uiTheme)].join("\n"), 0, 0);
		}

		const isPollCall = args
			? !args.list && (!args.cancel || args.cancel.length === 0 || args.poll !== undefined)
			: true;

		// Agent-carrying results are real roster snapshots. Only agentless polls
		// collapse pending job rows once sealed.
		if (!options.isPartial && isPollCall && agents.length === 0) {
			jobs = jobs.filter(job => !isPendingJob(job));
			if (jobs.length === 0) {
				return new Text("", 0, 0);
			}
		}

		const counts: Record<JobSnapshotStatus, number> = {
			waiting: 0,
			running: 0,
			completed: 0,
			failed: 0,
			aborted: 0,
			paused: 0,
			cancelled: 0,
		};
		for (const job of jobs) counts[job.status]++;
		const pendingCount = jobs.filter(isPendingJob).length;

		// The title already carries the pending count, so meta lists only settled
		// categories — "waiting on 19 of 19 · 19 running" read awkward.
		const meta: string[] = [];
		if (counts.completed > 0) meta.push(uiTheme.fg("success", `${counts.completed} done`));
		if (counts.failed > 0) meta.push(uiTheme.fg("error", `${counts.failed} failed`));
		if (counts.aborted > 0) meta.push(uiTheme.fg("error", `${counts.aborted} aborted`));
		if (counts.paused > 0) meta.push(uiTheme.fg("warning", `${counts.paused} paused`));
		if (counts.cancelled > 0) meta.push(uiTheme.fg("warning", `${counts.cancelled} cancelled`));
		if (agents.length > 0 && jobs.length > 0) {
			meta.push(uiTheme.fg("accent", `${agents.length} agent${agents.length === 1 ? "" : "s"}`));
		}

		const headerIcon: ToolUIStatus =
			counts.failed + counts.aborted > 0 ? "warning" : pendingCount > 0 || agents.length > 0 ? "info" : "success";
		const jobsNoun = jobs.length === 1 ? "job" : "jobs";
		const description =
			jobs.length === 0
				? `${agents.length} running agent${agents.length === 1 ? "" : "s"} — no jobs`
				: pendingCount > 0
					? pendingCount === jobs.length
						? `waiting on ${jobs.length} ${jobsNoun}`
						: `waiting on ${pendingCount} of ${jobs.length} ${jobsNoun}`
					: `${jobs.length} ${jobsNoun} settled`;

		const header = renderStatusLine(
			{
				icon: headerIcon,
				spinnerFrame: pendingCount > 0 || agents.length > 0 ? options.spinnerFrame : undefined,
				title: description,
				meta,
			},
			uiTheme,
		);

		// Pending work first, then actionable non-success states, then completed.
		const statusOrder: Record<JobSnapshot["status"], number> = {
			waiting: 0,
			running: 1,
			failed: 2,
			aborted: 3,
			paused: 4,
			cancelled: 5,
			completed: 6,
		};
		const sortedJobs = [...jobs].sort((a, b) => {
			const diff = statusOrder[a.status] - statusOrder[b.status];
			if (diff !== 0) return diff;
			return b.durationMs - a.durationMs;
		});

		let cached: RenderCache | undefined;
		return {
			render(width: number): readonly string[] {
				const expanded = options.expanded;
				const spinnerFrame = options.spinnerFrame ?? 0;
				// Pending-job labels shimmer while the poll block is live; the band
				// phase is Date.now()-sampled at render time, so serving cached bytes
				// would pin it to the ~12.5fps spinner-glyph cadence instead of the
				// 30fps redraw. Bypass the cache while any row animates, and key on
				// the animation state so a sealed block never hits stale shimmered
				// bytes (spinnerFrame falls back to 0 on both sides of the seal).
				const shimmerActive = pendingCount > 0 && options.spinnerFrame !== undefined && shimmerEnabled();
				const key = new Hasher().bool(expanded).u32(width).u32(spinnerFrame).bool(shimmerActive).digest();
				if (!shimmerActive && cached?.key === key) return cached.lines;

				const itemLines = renderTreeList<JobSnapshot>(
					{
						items: sortedJobs,
						expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
						itemType: "job",
						renderItem: job => {
							const lines: string[] = [];
							const pending = isPendingJob(job);
							const icon = formatStatusIcon(
								statusToIcon(job.status),
								uiTheme,
								pending ? options.spinnerFrame : undefined,
							);
							const typeBadge = formatBadge(job.type, statusToColor(job.status), uiTheme);
							// Task jobs normally share their agent id. Keep the job id
							// visible when collision resolution gave it a suffix.
							const idPart = job.label.trim() === job.id ? "" : ` ${uiTheme.fg("muted", job.id)}`;
							const rawLabelLines = (job.label || "(no label)").split(/\r?\n/);
							const maxLabelLines = expanded ? LABEL_LINES_EXPANDED : LABEL_LINES_COLLAPSED;
							const visibleLabelLines = rawLabelLines
								.slice(0, maxLabelLines)
								.map(l => truncateToWidth(replaceTabs(l), LABEL_MAX_WIDTH, Ellipsis.Unicode));
							if (rawLabelLines.length > maxLabelLines && visibleLabelLines.length > 0) {
								const last = visibleLabelLines[visibleLabelLines.length - 1]!;
								visibleLabelLines[visibleLabelLines.length - 1] = `${last} …`;
							}
							const durationText = uiTheme.fg("dim", formatDuration(job.durationMs));
							// Pending rows in a live block shimmer their label; once the block
							// stops animating (sealed, or a settled snapshot — spinnerFrame
							// cleared) they render static so scrollback never keeps a mid-sweep
							// shimmer band.
							const live = pending && options.spinnerFrame !== undefined;
							const headRaw = visibleLabelLines[0] ?? "";
							const headLabel = live
								? shimmerEnabled()
									? shimmerText(headRaw, uiTheme)
									: uiTheme.fg("accent", headRaw)
								: uiTheme.fg("toolOutput", headRaw);
							lines.push(`${icon}${idPart} ${typeBadge} ${headLabel} ${durationText}`);
							for (let i = 1; i < visibleLabelLines.length; i++) {
								lines.push(`  ${uiTheme.fg("toolOutput", visibleLabelLines[i]!)}`);
							}

							if (job.agent) {
								const age = formatDuration(Math.max(0, Date.now() - job.agent.lastActivity));
								const activity = job.agent.activity
									? ` ${uiTheme.fg(
											"dim",
											`— ${truncateToWidth(replaceTabs(job.agent.activity), PREVIEW_LINE_WIDTH, Ellipsis.Unicode)}`,
										)}`
									: "";
								lines.push(
									`  ${uiTheme.fg("dim", "agent")} ${formatBadge(
										job.agent.status,
										agentStatusToColor(job.agent.status),
										uiTheme,
									)} ${uiTheme.fg("dim", `active ${age} ago`)}${activity}`,
								);
							}

							const taskResult = job.result?.kind === "task" ? job.result.result : undefined;
							const reason = taskResult?.termination.reason.trim() ?? "";
							if (taskResult) {
								const { termination } = taskResult;
								lines.push(
									`  ${formatBadge(termination.code, statusToColor(job.status), uiTheme)} ${uiTheme.fg(
										termination.status === "completed" ? "dim" : "toolOutput",
										reason,
									)}`,
								);
								if (expanded) {
									const recovery = termination.resumable ? "resumable" : "terminal";
									lines.push(
										`  ${uiTheme.fg("dim", `${recovery} · ${termination.historyUri} · ${termination.outputUri}`)}`,
									);
									lines.push(`  ${uiTheme.fg("dim", formatRuntimePolicySummary(termination.policy))}`);
								}
							}

							const previewSource = taskResult
								? taskResult.output.trim()
								: job.errorText?.trim() || job.resultText?.trim() || "";
							const preview = previewSource === reason ? "" : flattenStructuredPreview(previewSource);
							if (preview) {
								const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
								const previewLines = getPreviewLines(preview, maxLines, PREVIEW_LINE_WIDTH, Ellipsis.Unicode);
								const tone = job.status === "failed" || job.status === "aborted" ? "error" : "dim";
								for (const pl of previewLines) lines.push(`  ${uiTheme.fg(tone, pl)}`);
							}
							return lines;
						},
					},
					uiTheme,
				);

				// Agents run outside job control; render them as their own tree so
				// they never skew the job counts or the waiting title.
				const agentLines =
					agents.length === 0
						? []
						: renderTreeList<AgentActivitySnapshot>(
								{
									items: agents,
									expanded,
									maxCollapsed: COLLAPSED_LIST_LIMIT,
									itemType: "agent",
									renderItem: agent => {
										const icon = formatStatusIcon("running", uiTheme, options.spinnerFrame);
										const badge = formatBadge("agent", "accent", uiTheme);
										const gist = agent.activity
											? ` ${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(agent.activity), LABEL_MAX_WIDTH, Ellipsis.Unicode))}`
											: "";
										const parent = agent.parentId ? uiTheme.fg("dim", ` ← ${agent.parentId}`) : "";
										const age = uiTheme.fg("dim", formatDuration(agent.ageMs));
										return [`${icon} ${uiTheme.fg("muted", agent.id)} ${badge}${gist} ${age}${parent}`];
									},
								},
								uiTheme,
							);
				const runningHint =
					options.isPartial && isPollCall && isWaitingPollDetails(result.details) && pendingCount === jobs.length
						? [uiTheme.fg("dim", "still running; poll later or cancel by id")]
						: [];
				const all = [header, ...itemLines, ...agentLines, ...runningHint].map(l =>
					truncateToWidth(l, width, Ellipsis.Unicode),
				);
				cached = { key, lines: all };
				return all;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},

	mergeCallAndResult: true,
};
