import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import type { CustomMessage } from "../../session/messages";
import type { SubagentTermination } from "../../task/types";
import { initTheme } from "../theme/theme";
import { assistantUsageIsBilled, buildAsyncResultBlock } from "./transcript-render-helpers";

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function asyncMessage(termination?: SubagentTermination): CustomMessage {
	return {
		role: "custom",
		customType: "async-result",
		content: "result",
		display: true,
		attribution: "agent",
		details: {
			jobs: [{ jobId: "Worker", type: "task", label: "worker", durationMs: 1000, termination }],
		},
		timestamp: 0,
	};
}

function settled(status: "paused" | "failed" | "aborted"): SubagentTermination {
	return {
		status,
		code: status === "paused" ? "no_progress" : status === "aborted" ? "caller_cancelled" : "provider_error",
		reason: `${status} reason`,
		resumable: status === "paused",
		historyUri: "history://Worker",
		outputUri: "agent://Worker",
		policy: {
			request: { termination: "disabled", advisory: { mode: "advisory", afterAssistantTurns: 24 } },
			wallClock: { maxRuntimeMs: 60_000 },
			stall: { action: "pause", afterAssistantTurns: 3 },
			spawn: { remainingDepth: null },
			idle: { resumable: true, parkingTtlMs: null },
		},
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("assistantUsageIsBilled", () => {
	it("suppresses the token badge only for turns that consumed nothing", () => {
		expect(assistantUsageIsBilled(usage())).toBe(false);
	});

	it("preserves cost transparency for empty replies whose prompt still cost input tokens", () => {
		expect(assistantUsageIsBilled(usage({ input: 321 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ output: 0, cacheRead: 512 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ cacheWrite: 128 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ premiumRequests: 1 }))).toBe(true);
	});

	// Documents the live/resume parity contract for #4532: both paths ask
	// `assistantUsageIsBilled` about `message.usage`, so an empty automated
	// reply that still cost input tokens renders identically on both surfaces.
	it("matches whether the assistant carrier renders visible content", () => {
		const emptyBilledMessage: Pick<AssistantMessage, "usage"> = { usage: usage({ input: 321 }) };
		const emptyFreeMessage: Pick<AssistantMessage, "usage"> = { usage: usage() };
		expect(assistantUsageIsBilled(emptyBilledMessage.usage)).toBe(true);
		expect(assistantUsageIsBilled(emptyFreeMessage.usage)).toBe(false);
	});
});

describe("buildAsyncResultBlock", () => {
	it("renders paused, failed, and aborted task outcomes distinctly with one exact reason", () => {
		for (const status of ["paused", "failed", "aborted"] as const) {
			const rendered = Bun.stripANSI(
				buildAsyncResultBlock(asyncMessage(settled(status)))
					.render(180)
					.join("\n"),
			);
			expect(rendered).toContain(`Background task ${status}`);
			expect(rendered.split(`${status} reason`)).toHaveLength(2);
			expect(rendered).toContain(status === "paused" ? "resumable" : "not resumable");
			expect(rendered).toContain("history://Worker");
			expect(rendered).toContain("agent://Worker");
			expect(rendered).toContain(
				"policy request termination disabled; advisory/24 turns · OMP cap/60000ms · stall pause/3",
			);
			expect(rendered).toContain("spawn depth unlimited");
		}
	});

	it("keeps completed text-only bash transcript rows unchanged", () => {
		const rendered = Bun.stripANSI(buildAsyncResultBlock(asyncMessage()).render(120).join("\n"));
		expect(rendered).toContain("Background job completed");
		expect(rendered).not.toContain("policy request=");
	});
});
