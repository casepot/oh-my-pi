import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentRegistry, type AgentStatus } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { ArtifactManager } from "../../session/artifacts";
import { AgentProtocolHandler } from "../agent-protocol";
import { resetRegisteredArtifactDirsForTests } from "../registry-helpers";

const tempDir = TempDir.createSync("omp-nested-agent-repro-");
beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});
afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});
afterAll(() => {
	tempDir.removeSync();
});

async function registerAgentWithArtifacts(
	id: string,
	status: AgentStatus,
	kind: "sub" | "advisor" = "sub",
): Promise<string> {
	const artifactsDir = path.join(tempDir.path(), id);
	await fs.mkdir(artifactsDir, { recursive: true });
	const artifactManager = new ArtifactManager(artifactsDir);
	const session =
		status === "parked" || status === "aborted"
			? null
			: ({
					sessionManager: { getArtifactsDir: () => artifactManager.dir },
				} as unknown as AgentSession);
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind,
		session,
		sessionFile: `${artifactsDir}.jsonl`,
		status,
	});
	return artifactsDir;
}

async function resolveErrorMessage(id: string): Promise<string> {
	let thrown: unknown;
	try {
		await new AgentProtocolHandler().resolve(new URL(`agent://${id}`) as never);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(Error);
	return (thrown as Error).message;
}

it("agent:// resolves a depth-2 subagent's .md output while its session is live and artifact-manager-adopted", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	// Every subagent adopts the root ArtifactManager and reports its dir.
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);

	// A depth-1 subagent's OWN children are written under its own
	// sessionFile.slice(0, -6) (task/index.ts), i.e. one level deeper.
	const midSessionFile = path.join(rootArtifactsDir, "CodexDeepDive.jsonl");
	const midOwnArtifactsDir = midSessionFile.slice(0, -6);
	await fs.mkdir(midOwnArtifactsDir, { recursive: true });

	const grandchildId = "CodexDeepDive.GraphStore";
	const grandchildSessionFile = path.join(midOwnArtifactsDir, `${grandchildId}.jsonl`);
	await fs.writeFile(path.join(midOwnArtifactsDir, `${grandchildId}.md`), "full report content");

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "CodexDeepDive",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		sessionFile: midSessionFile,
	});
	registry.register({
		id: grandchildId,
		displayName: "sub",
		kind: "sub",
		parentId: "CodexDeepDive",
		session: fakeSession,
		sessionFile: grandchildSessionFile,
	});

	const resource = await new AgentProtocolHandler().resolve(new URL(`agent://${grandchildId}`) as never);
	expect(resource.content).toBe("full report content");
});

const missingOutputCases: Array<{
	id: string;
	status: AgentStatus;
	headline: string;
}> = [
	{
		id: "running-agent",
		status: "running",
		headline: "Agent running-agent is still running and has not yielded output yet.",
	},
	{
		id: "aborted-agent",
		status: "aborted",
		headline: "Agent aborted-agent ended before yielding output (status: aborted).",
	},
	{
		id: "idle-agent",
		status: "idle",
		headline: "Agent idle-agent is idle; no yielded artifact is available.",
	},
	{
		id: "parked-agent",
		status: "parked",
		headline: "Agent parked-agent is parked; no yielded artifact is available.",
	},
];

for (const { id, status, headline } of missingOutputCases) {
	it(`agent:// explains missing output for a known ${status} agent`, async () => {
		await registerAgentWithArtifacts(id, status);

		expect(await resolveErrorMessage(id)).toBe(
			`${headline}\nRead the transcript at history://${id}.\nUse job({ list: true }) to inspect task completion state.`,
		);
	});
}

it("agent:// resolves a real artifact before applying known-agent lifecycle guidance", async () => {
	const id = "aborted-agent-with-output";
	const artifactsDir = await registerAgentWithArtifacts(id, "aborted");
	const artifactPath = path.join(artifactsDir, `${id}.md`);
	await fs.writeFile(artifactPath, "yielded before termination");

	const resource = await new AgentProtocolHandler().resolve(new URL(`agent://${id}`) as never);

	expect(resource.content).toBe("yielded before termination");
	expect(resource.sourcePath).toBe(artifactPath);
});

it("agent:// uses the available-output not-found path for a non-exact registry id", async () => {
	const artifactsDir = await registerAgentWithArtifacts("exact-agent", "running");
	await fs.writeFile(path.join(artifactsDir, "available-output.md"), "available");

	expect(await resolveErrorMessage("exact-agent-child")).toBe(
		"Not found: exact-agent-child\nAvailable: available-output",
	);
});

it("agent:// uses the available-output not-found path for advisor refs", async () => {
	const artifactsDir = await registerAgentWithArtifacts("observer-agent", "running", "advisor");
	await fs.writeFile(path.join(artifactsDir, "available-output.md"), "available");

	expect(await resolveErrorMessage("observer-agent")).toBe("Not found: observer-agent\nAvailable: available-output");
});
