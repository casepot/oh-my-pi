/**
 * The job TUI renders structured TaskTool results from SingleResult while
 * preserving the existing text-only preview path for bash and /tan jobs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SingleResult, SubagentTermination } from "@oh-my-pi/pi-coding-agent/task/types";
import { isWaitingPollDetails, type JobSnapshot, jobToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/job";

const policy: SubagentTermination["policy"] = {
	request: { termination: "disabled", advisory: { mode: "advisory", afterAssistantTurns: 12 } },
	wallClock: { maxRuntimeMs: 90_000 },
	stall: { action: "pause", afterAssistantTurns: 3 },
	spawn: { remainingDepth: null },
	idle: { resumable: true, parkingTtlMs: null },
};

function taskResult(termination: SubagentTermination, output: string): SingleResult {
	return {
		index: 0,
		id: "SpawnProbe",
		agent: "task",
		agentSource: "bundled",
		task: "Probe async transport",
		exitCode: termination.status === "failed" ? 1 : 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 8_700,
		tokens: 120,
		requests: 4,
		termination,
	};
}

function renderJob(
	job: JobSnapshot,
	options: Partial<Parameters<typeof jobToolRenderer.renderResult>[1]> = {},
): string {
	const component = jobToolRenderer.renderResult(
		{
			content: [{ type: "text", text: "" }],
			details: { jobs: [job] },
		},
		{ expanded: true, ...options } as Parameters<typeof jobToolRenderer.renderResult>[1],
		theme,
	);
	return (component.render(120) as readonly string[]).join("\n");
}

describe("job renderer task-result preview", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("previews structured task output instead of its presentation envelope", () => {
		const result = taskResult(
			{
				status: "completed",
				code: "yielded",
				reason: "Agent yielded successfully.",
				resumable: false,
				historyUri: "history://SpawnProbe",
				outputUri: "agent://SpawnProbe",
				policy,
			},
			"Probe finished: spawned worker, ping ok.",
		);
		const output = renderJob({
			id: "SpawnProbe",
			type: "task",
			status: "completed",
			schedulerStatus: "completed",
			label: "SpawnProbe",
			durationMs: 8_700,
			result: {
				kind: "task",
				text: "<task-result><output>wrong presentation copy</output></task-result>",
				result,
			},
		});

		expect(output).toContain("Probe finished: spawned worker, ping ok.");
		expect(output).not.toContain("wrong presentation copy");
		expect(output).not.toContain("<task-result");
	});

	it("flattens pretty-printed structured task output instead of previewing a lone brace", () => {
		const result = taskResult(
			{
				status: "completed",
				code: "yielded",
				reason: "Agent yielded successfully.",
				resumable: false,
				historyUri: "history://SpawnProbe",
				outputUri: "agent://SpawnProbe",
				policy,
			},
			'{\n  "echo": "alpha",\n  "ok": true\n}',
		);
		const output = Bun.stripANSI(
			renderJob({
				id: "SpawnProbe",
				type: "task",
				status: "completed",
				schedulerStatus: "completed",
				label: "SpawnProbe",
				durationMs: 8_700,
				result: { kind: "task", text: "ignored", result },
			}),
		);

		expect(output).toContain('{ "echo": "alpha", "ok": true }');
		expect(output.split("\n").some(line => line.trim() === "{")).toBe(false);
	});

	it("renders paused termination reason and recovery fields exactly once", () => {
		const reason = "No measurable progress after three cycles.";
		const result = taskResult(
			{
				status: "paused",
				code: "no_progress",
				reason,
				resumable: true,
				historyUri: "history://SpawnProbe",
				outputUri: "agent://SpawnProbe",
				policy,
			},
			reason,
		);
		const output = Bun.stripANSI(
			renderJob({
				id: "SpawnProbe",
				type: "task",
				status: "paused",
				schedulerStatus: "completed",
				label: "SpawnProbe",
				durationMs: 8_700,
				result: { kind: "task", text: `paused: ${reason}`, result },
			}),
		);

		expect(output).toContain("1 paused");
		expect(output).toContain("no_progress");
		expect(output.match(new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
		expect(output).toContain("resumable · history://SpawnProbe · agent://SpawnProbe");
		expect(output).toContain(
			"request termination disabled; advisory/12 turns · OMP cap/90000ms · stall pause/3 turns",
		);
	});

	it("passes bash result text through unchanged", () => {
		const output = renderJob({
			id: "bg_1",
			type: "bash",
			status: "completed",
			schedulerStatus: "completed",
			label: "bun test",
			durationMs: 18_400,
			result: { kind: "text", text: "42 pass, 0 fail (18.4s)" },
			resultText: "42 pass, 0 fail (18.4s)",
		});
		expect(output).toContain("42 pass, 0 fail (18.4s)");
	});

	it("drops the id column when the label repeats it", () => {
		const output = Bun.stripANSI(
			renderJob({
				id: "SpawnProbe",
				type: "task",
				status: "completed",
				schedulerStatus: "completed",
				label: "SpawnProbe",
				durationMs: 8_700,
			}),
		);
		const header = output.split("\n").find(line => line.includes("SpawnProbe"));
		expect(header).toBeDefined();
		expect(header!.match(/SpawnProbe/g)).toHaveLength(1);
	});

	it("renders task agent state, activity age, and current gist on one diagnostic line", () => {
		const now = 1_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const output = Bun.stripANSI(
			renderJob(
				{
					id: "ActivityProbe",
					type: "task",
					status: "running",
					schedulerStatus: "running",
					label: "Inspect job diagnostics",
					durationMs: 12_000,
					agent: {
						status: "waiting",
						lastActivity: now - 65_000,
						activity: "Reading queue diagnostics",
					},
				},
				{ isPartial: true },
			),
		);
		const diagnostic = output.split("\n").find(line => line.includes("Reading queue diagnostics"));

		expect(output).toContain("waiting on 1 job");
		expect(diagnostic).toBeDefined();
		expect(diagnostic).toContain("agent");
		expect(diagnostic).toContain("waiting");
		expect(diagnostic).toContain("active 1m5s ago");
		expect(diagnostic).toContain("Reading queue diagnostics");
	});

	describe("collapse and filter when turned into a result", () => {
		const jobsData = [
			{
				id: "Job1",
				type: "task" as const,
				status: "running" as const,
				schedulerStatus: "running" as const,
				label: "Job1 running",
				durationMs: 1200,
			},
			{
				id: "Job2",
				type: "task" as const,
				status: "completed" as const,
				schedulerStatus: "completed" as const,
				label: "Job2 completed",
				durationMs: 3400,
				resultText: "Job2 result",
			},
			{
				id: "Job3",
				type: "task" as const,
				status: "running" as const,
				schedulerStatus: "running" as const,
				label: "Job3 running",
				durationMs: 500,
			},
		];

		it("shows all jobs when isPartial is true", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { jobs: jobsData },
			};
			const component = jobToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: true } as Parameters<typeof jobToolRenderer.renderResult>[1],
				theme,
				{ poll: [] },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).toContain("Job3 running");
			expect(output).toContain("waiting on 2 of 3 jobs");
		});

		it("renders a recovery hint for live polls where every job is still running", () => {
			const runningJobsOnly = [
				{
					id: "Job1",
					type: "task" as const,
					status: "running" as const,
					schedulerStatus: "running" as const,
					label: "Job1 running",
					durationMs: 1200,
				},
			];
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { jobs: runningJobsOnly },
			};
			const component = jobToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: true } as Parameters<typeof jobToolRenderer.renderResult>[1],
				theme,
				{ poll: [] },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(isWaitingPollDetails(result.details)).toBe(true);
			expect(output).toContain("waiting on 1 job");
			expect(output).toContain("still running; poll later or cancel by id");
		});

		it("does not render the live poll hint when cancel outcomes are present", () => {
			const runningJobsOnly = [
				{
					id: "Job1",
					type: "task" as const,
					status: "running" as const,
					schedulerStatus: "running" as const,
					label: "Job1 running",
					durationMs: 1200,
				},
			];
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { jobs: runningJobsOnly, cancelled: [{ id: "missing", status: "not_found" as const }] },
			};
			const component = jobToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: true } as Parameters<typeof jobToolRenderer.renderResult>[1],
				theme,
				{ poll: [], cancel: ["missing"] },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(isWaitingPollDetails(result.details)).toBe(false);
			expect(output).toContain("waiting on 1 job");
			expect(output).not.toContain("still running; poll later or cancel by id");
		});

		it("shows only finished jobs when isPartial is false and it is a poll call", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { jobs: jobsData },
			};
			const component = jobToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof jobToolRenderer.renderResult>[1],
				theme,
				{ poll: [] },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).not.toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).not.toContain("Job3 running");
			expect(output).toContain("1 job settled");
		});

		it("shows nothing when isPartial is false and all jobs are running and it is a poll call", () => {
			const runningJobsOnly = [
				{
					id: "Job1",
					type: "task" as const,
					status: "running" as const,
					schedulerStatus: "running" as const,
					label: "Job1 running",
					durationMs: 1200,
				},
			];
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { jobs: runningJobsOnly },
			};
			const component = jobToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof jobToolRenderer.renderResult>[1],
				theme,
				{ poll: [] },
			);
			const lines = component.render(120) as readonly string[];
			expect(lines).toHaveLength(0);
		});

		it("does not collapse running jobs when isPartial is false and list is true", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { jobs: jobsData },
			};
			const component = jobToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof jobToolRenderer.renderResult>[1],
				theme,
				{ list: true },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).toContain("Job3 running");
			expect(output).toContain("waiting on 2 of 3 jobs");
		});

		it("does not collapse running jobs when isPartial is false and cancel-only is true", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { jobs: jobsData },
			};
			const component = jobToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof jobToolRenderer.renderResult>[1],
				theme,
				{ cancel: ["Job1"] },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).toContain("Job3 running");
			expect(output).toContain("waiting on 2 of 3 jobs");
		});

		it("renders agent rows for running agents outside job control", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {
					jobs: [],
					agents: [{ id: "Worker", parentId: "Main", activity: "grepping the tree", ageMs: 65_000 }],
				},
			};
			const component = jobToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof jobToolRenderer.renderResult>[1],
				theme,
				{ list: true },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("1 running agent — no jobs");
			expect(output).toContain("Worker");
			expect(output).toContain("grepping the tree");
		});

		it("keeps a sealed bare-poll result visible when it carries an agent roster", () => {
			const result = {
				content: [{ type: "text" as const, text: "No running background jobs to wait for." }],
				details: { jobs: [], agents: [{ id: "Worker", ageMs: 1_000 }] },
			};
			const component = jobToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof jobToolRenderer.renderResult>[1],
				theme,
				{ poll: [] },
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Worker");
		});
	});
});
