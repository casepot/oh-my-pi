import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseGoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function legacyGoalState() {
	const target = {
		id: "target-1",
		sequence: 1,
		status: "closed",
		title: "Legacy target",
		desiredFutureClaim: "Legacy target is proven.",
		closureStandard: "Checkpoint accepted.",
		baselineRefs: [],
		gateRefs: [],
		evidenceExpectation: [],
		nonGoals: [],
		forbiddenClaims: [],
		staleIf: [],
		createdAt: 1,
		closedAt: 2,
		createdBy: "initial",
	};
	const checkpoint = {
		id: "checkpoint-1",
		sequence: 1,
		goalId: "goal-legacy",
		targetId: target.id,
		targetSnapshot: target,
		parentFrameVersion: 1,
		baselineRefs: [],
		gateRefs: [],
		workEpoch: 1,
		status: "closed_with_evidence",
		summary: "Legacy target closed.",
		localClaims: ["Legacy target is proven."],
		evidence: [{ claim: "Legacy target is proven.", evidence: "Observed legacy output", current: true }],
		checksRun: ["legacy-check"],
		artifactsTouched: ["legacy.log"],
		notClaimed: ["Parent complete"],
		remainingQuestions: ["Next target?"],
		risksOrCaveats: [],
		staleIf: [],
		suggestedControllerQuestions: [],
		createdAt: 3,
	};
	const goal = {
		id: "goal-legacy",
		objective: "Repair legacy goal persistence",
		status: "active",
		tokenBudget: 100,
		tokensUsed: 12,
		timeUsedSeconds: 34,
		createdAt: 1,
		updatedAt: 4,
		parentFrame: {
			kind: "claim-gated",
			desiredFuture: "Parent complete",
			baselineRefs: [],
			acceptedClaims: [],
			candidateClaims: [],
			rejectedOrStaleClaims: [],
			boundaries: [],
			residuals: [],
			gates: [],
			frontier: [],
			staleIf: [],
			externalRefs: [],
		},
		currentTarget: target,
		targets: [target],
		checkpoints: [checkpoint],
		pendingCheckpointId: checkpoint.id,
		checkpointResolutions: [],
	};
	return {
		enabled: true,
		mode: "active",
		runMode: "awaiting-checkpoint-resolution",
		stateVersion: 9,
		parentFrameVersion: 1,
		goal,
	};
}

function jsonl(entries: unknown[]): string {
	return `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
}

describe("legacy goal persistence repair", () => {
	it("repairs repeated full goal mode markers and tool details before resume", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-goal-repair-"));
		try {
			const sessionFile = path.join(root, "legacy.jsonl");
			const state = legacyGoalState();
			const goal = state.goal;
			const checkpoint = goal.checkpoints[0];
			await Bun.write(
				sessionFile,
				jsonl([
					{ type: "session", version: 3, id: "session-legacy", timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
					{
						type: "mode_change",
						id: "mode-1",
						parentId: null,
						timestamp: "2026-01-01T00:00:01.000Z",
						mode: "goal",
						data: state,
					},
					{
						type: "mode_change",
						id: "mode-2",
						parentId: "mode-1",
						timestamp: "2026-01-01T00:00:02.000Z",
						mode: "goal",
						data: state,
					},
					{
						type: "mode_change",
						id: "mode-3",
						parentId: "mode-2",
						timestamp: "2026-01-01T00:00:03.000Z",
						mode: "goal",
						data: state,
					},
					{
						type: "message",
						id: "goal-result",
						parentId: "mode-3",
						timestamp: "2026-01-01T00:00:04.000Z",
						message: {
							role: "toolResult",
							toolCallId: "call-goal",
							toolName: "goal",
							content: [{ type: "text", text: "ok" }],
							details: {
								op: "checkpoint",
								goal,
								state,
								remainingTokens: 88,
								completionBudgetReport: null,
								checkpoint,
							},
							isError: false,
						},
					},
				]),
			);

			const manager = await SessionManager.open(sessionFile, root);
			const rewritten = (await Bun.file(sessionFile).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));

			expect(rewritten[0].version).toBe(4);
			const modeMarkers = rewritten.filter(entry => entry.type === "mode_change" && entry.mode === "goal");
			expect(modeMarkers).toHaveLength(3);
			for (const marker of modeMarkers) {
				expect(marker.data.goalId).toBe("goal-legacy");
				expect(marker.data.stateVersion).toBe(9);
				expect(typeof marker.data.snapshotEntryId).toBe("string");
				expect(marker.data.goal).toBeUndefined();
				expect(marker.data.state).toBeUndefined();
			}
			const snapshots = rewritten.filter(entry => entry.type === "goal_state_snapshot");
			expect(snapshots).toHaveLength(1);
			expect(new Set(modeMarkers.map(marker => marker.data.snapshotEntryId)).size).toBe(1);

			const resultDetails = rewritten.find(entry => entry.id === "goal-result")?.message.details;
			expect(resultDetails.goal).toMatchObject({
				id: "goal-legacy",
				objective: "Repair legacy goal persistence",
				tokensUsed: 12,
			});
			expect(resultDetails.state).toMatchObject({
				runMode: "awaiting-checkpoint-resolution",
				goalId: "goal-legacy",
			});
			expect(resultDetails.state.goal).toBeUndefined();
			expect(JSON.stringify(resultDetails)).not.toContain("targetSnapshot");

			const ctx = manager.buildSessionContext();
			const restored = parseGoalModeState(ctx.modeData, ctx.mode === "goal");
			expect(restored?.goal.id).toBe("goal-legacy");
			expect(restored?.goal.status).toBe("active");
			expect(restored?.runMode).toBe("awaiting-checkpoint-resolution");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not rewrite legacy goal sessions through the read-only loader", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-goal-readonly-"));
		try {
			const sessionFile = path.join(root, "legacy-readonly.jsonl");
			const state = legacyGoalState();
			const before = jsonl([
				{ type: "session", version: 3, id: "session-readonly", timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
				{
					type: "mode_change",
					id: "mode-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					mode: "goal",
					data: state,
				},
				{
					type: "message",
					id: "message-1",
					parentId: "mode-1",
					timestamp: "2026-01-01T00:00:02.000Z",
					message: { role: "user", content: "Inspect only" },
				},
			]);
			await Bun.write(sessionFile, before);

			const messages = await loadSessionMessagesReadOnly(sessionFile);

			expect(messages.map(message => message.role)).toContain("user");
			expect(await Bun.file(sessionFile).text()).toBe(before);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
