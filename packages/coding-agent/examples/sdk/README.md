# SDK Examples

Programmatic usage of `@oh-my-pi/pi-coding-agent` through `createAgentSession()`.

These examples are source-linked Bun/TypeScript examples. Source is the authority for the SDK surface; the most common current exports are `createAgentSession`, `SessionManager`, `Settings`, `AuthStorage`, `ModelRegistry`, `discoverAuthStorage`, and the discovery helpers listed below.

## Examples in this directory

| File | Description |
| --- | --- |
| `01-minimal.ts` | Simplest usage with SDK defaults |
| `02-custom-model.ts` | Explicit auth/model registry and thinking level |
| `03-custom-prompt.ts` | Replace or extend system prompt blocks |
| `04-skills.ts` | Discover, filter, or replace skills |
| `06-extensions.ts` | Extension discovery and `additionalExtensionPaths` |
| `06-hooks.ts` | Legacy-named inline `ExtensionFactory[]` example |
| `07-context-files.ts` | AGENTS.md/project context files |
| `08-prompt-templates.ts` | Prompt template discovery/replacement |
| `08-slash-commands.ts` | File-based slash commands |
| `09-api-keys-and-oauth.ts` | Auth storage, model registry, runtime API keys |
| `11-sessions.ts` | In-memory, persistent, continue, list sessions |
| `12-redis-sessions.ts` | Redis-backed session storage |
| `13-sql-sessions.ts` | SQL-backed session storage |

There are no `05-tools.ts`, `10-settings.ts`, or `12-full-control.ts` files in the current tree.

## Running

From the repo root:

```bash
bun packages/coding-agent/examples/sdk/01-minimal.ts
```

Most examples create real sessions and may require configured provider credentials. Use `SessionManager.inMemory()` in your own examples when you do not want file-backed persistence.

## Quick reference

```ts
import { getModel } from "@oh-my-pi/pi-ai";
import {
  AuthStorage,
  BUILTIN_TOOLS,
  createAgentSession,
  createTools,
  discoverAuthStorage,
  discoverContextFiles,
  discoverCustomTSCommands,
  discoverExtensions,
  discoverMCPServers,
  discoverPromptTemplates,
  discoverSkills,
  discoverSlashCommands,
  HIDDEN_TOOLS,
  ModelRegistry,
  ResolveTool,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";

// Auth and models.
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

// Minimal: omit options to let the SDK discover auth, model registry, settings,
// session manager, skills, context, prompt templates, slash commands,
// extensions, built-in tools, custom tools, MCP, and LSP.
const { session } = await createAgentSession();

// Explicit model.
const model = getModel("anthropic", "claude-opus-4-5");
const { session: modelSession } = await createAgentSession({
  model: model ?? undefined,
  thinkingLevel: "high",
  authStorage,
  modelRegistry,
});

// Extend the default system prompt. The callback receives and returns string[].
const { session: prompted } = await createAgentSession({
  systemPrompt: (defaults) => [...defaults, "## Host instruction\nBe concise."],
  authStorage,
  modelRegistry,
});

// Read-only active tool set.
const { session: readOnly } = await createAgentSession({
  toolNames: ["read", "search", "find"],
  authStorage,
  modelRegistry,
});

// In-memory persistence.
const { session: ephemeral } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

// More controlled session.
const customAuth = await AuthStorage.create("/my/app/agent.db");
customAuth.setRuntimeApiKey("anthropic", Bun.env.MY_KEY ?? "");
const customRegistry = new ModelRegistry(customAuth, "/my/app/models.json");
await customRegistry.refresh();

const { session: controlled } = await createAgentSession({
  authStorage: customAuth,
  modelRegistry: customRegistry,
  systemPrompt: ["You are helpful."],
  toolNames: ["read", "bash"],
  extensions: [],
  skills: [],
  contextFiles: [],
  promptTemplates: [],
  slashCommands: [],
  enableMCP: false,
  sessionManager: SessionManager.inMemory(),
});

const done = Promise.withResolvers<void>();
const unsubscribe = controlled.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
  if (event.type === "agent_end") done.resolve();
});

try {
  await controlled.prompt("Hello");
  await done.promise;
} finally {
  unsubscribe();
  await controlled.dispose();
}
```

There is no exported `discoverModels`, `discoverHooks`, `discoverCustomTools`, or `loadSettings` helper in the current SDK. Use `new ModelRegistry(authStorage)` for models and `Settings` for settings.

## Current option notes

| Option | Default / behavior |
| --- | --- |
| `authStorage` | Discovered with `discoverAuthStorage(agentDir)` when omitted |
| `modelRegistry` | `new ModelRegistry(authStorageOrDiscoveredAuthStorage)` when omitted |
| `cwd` | `getProjectDir()` |
| `agentDir` | `getAgentDir()` |
| `model` / `modelPattern` | Explicit model or deferred selector; otherwise session restore, settings default, then first authenticated model |
| `thinkingLevel` | Explicit option, restored setting, model default, or global default |
| `systemPrompt` | `string[]` replacement or `(defaultPrompt: string[]) => string[]` |
| `toolNames` | Requested active tools; use `strictToolNames: true` for an exact active allowlist |
| `customTools` | Additional explicit tools; does not replace discovered/extension tools |
| `extensions` | Inline extension factories |
| `additionalExtensionPaths` | Extra extension files/dirs |
| `disableExtensionDiscovery` | Disable automatic extension scanning |
| `skills`, `rules`, `contextFiles` | Explicit arrays replace those discovery branches |
| `promptTemplates` | Prompt templates; distinct from slash commands |
| `slashCommands` | File-based slash commands |
| `enableMCP` | Defaults true |
| `enableLsp` | Defaults true |
| `sessionManager` | File-backed `SessionManager.create(...)` by default |
| `settings` | `Settings.init({ cwd, agentDir })` by default |
| `hasUI` | Defaults false; set true only when the host supplies UI behavior |

Current terminology is **extensions**. Legacy hook examples and CLI aliases may still exist, but the SDK option names are `extensions`, `additionalExtensionPaths`, and `disableExtensionDiscovery`.

## Events

```ts
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      process.stderr.write(`Tool: ${event.toolName}\n`);
      break;
    case "tool_execution_end":
      process.stderr.write(`Tool result: ${JSON.stringify(event.result)}\n`);
      break;
    case "agent_end":
      process.stderr.write("Done\n");
      break;
  }
});
```

Call the returned unsubscribe function when the host no longer wants events, and call `await session.dispose()` before process shutdown.

## Resolve preview workflow

`ast_edit` returns a preview. To finalize it, call hidden `resolve` with a required reason.

- `action: "apply"` commits pending preview changes.
- `action: "discard"` drops pending preview changes.
- `reason: string` is required for both paths.

`createAgentSession()` / `createTools()` include `resolve` automatically when a deferrable tool or plan-mode flow needs it. If you compose tools manually, use `HIDDEN_TOOLS.resolve` or `ResolveTool` and wire the same pending-action store.

```ts
const tools = await createTools(toolSession, ["ast_edit"]);
const resolveTool = tools.find((tool) => tool.name === "resolve") as ResolveTool;

await resolveTool.execute("call-1", {
  action: "apply",
  reason: "Preview matches expected replacements.",
});
```
