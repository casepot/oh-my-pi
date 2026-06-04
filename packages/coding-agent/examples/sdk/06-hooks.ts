/**
 * Legacy-Named Extension Example
 *
 * Extensions intercept agent events for logging, blocking, or modification.
 * This file keeps its historical name, but the SDK API is `extensions`.
 */
import { createAgentSession, type ExtensionFactory, SessionManager } from "@oh-my-pi/pi-coding-agent";

// Logging extension
const loggingExtension: ExtensionFactory = api => {
	api.on("agent_start", async () => {
		console.log("[Extension] Agent starting");
	});

	api.on("tool_call", async event => {
		console.log(`[Extension] Tool: ${event.toolName}`);
		return undefined; // Don't block
	});

	api.on("agent_end", async event => {
		console.log(`[Extension] Done, ${event.messages.length} messages`);
	});
};

// Blocking extension (returns { block: true, reason: "..." })
const safetyExtension: ExtensionFactory = api => {
	api.on("tool_call", async event => {
		if (event.toolName === "bash") {
			const cmd = (event.input as { command?: string }).command ?? "";
			if (cmd.includes("rm -rf")) {
				return { block: true, reason: "Dangerous command blocked" };
			}
		}
		return undefined;
	});
};

// Use inline extensions
const { session } = await createAgentSession({
	extensions: [loggingExtension, safetyExtension],
	sessionManager: SessionManager.inMemory(),
});

session.subscribe(event => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await session.prompt("List files in the current directory.");
console.log();

// Inline extensions are merged with discovery by default. For isolation:
// disableExtensionDiscovery: true
// extensions: []

// Add paths without replacing discovery:
// additionalExtensionPaths: ["/extra/extensions"]
