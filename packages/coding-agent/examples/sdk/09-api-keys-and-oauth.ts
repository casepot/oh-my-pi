/**
 * API Keys and OAuth
 *
 * Configure API key resolution via AuthStorage and ModelRegistry.
 */
import {
	AuthStorage,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";

// Default: discoverAuthStorage() uses ~/.omp/agent/agent.db.
// ModelRegistry loads bundled/cached models immediately; refresh() updates provider catalogs.
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
console.log("Session with default auth storage and model registry");

// Custom auth storage location
const customAuthStorage = await AuthStorage.create("/tmp/my-app/agent.db");
const customModelRegistry = new ModelRegistry(customAuthStorage, "/tmp/my-app/models.json");
await customModelRegistry.refresh();

await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage: customAuthStorage,
	modelRegistry: customModelRegistry,
});
console.log("Session with custom auth storage location");

// Runtime API key override (not persisted to disk)
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");
await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
console.log("Session with runtime API key override");

// Registry without an explicit custom models path
const simpleRegistry = new ModelRegistry(authStorage);
await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry: simpleRegistry,
});
console.log("Session with only built-in models");
