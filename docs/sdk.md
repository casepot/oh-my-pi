# SDK

The SDK is the in-process integration surface for `@oh-my-pi/pi-coding-agent`.
Use it when your Bun/Node process owns the agent lifecycle and wants direct access to session state, event streaming, tool wiring, model/auth objects, and session persistence.

Use [`docs/rpc.md`](./rpc.md) instead when the host needs process isolation, cross-language embedding, or a stdio protocol boundary.

## Installation

```bash
bun add @oh-my-pi/pi-coding-agent
```

## Entry points and exported surface

The package root exports the SDK surface:

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
```

The `@oh-my-pi/pi-coding-agent/sdk` subpath resolves to `src/sdk.ts` through the package wildcard export. It exposes the helpers/types exported by that file. Import from the package root when you need root-only exports such as `SessionManager`, `AuthStorage`, `ModelRegistry`, or `Settings`.

## Cross-process RPC clients

For production embedders that need process isolation or cross-language control, use the RPC protocol instead of the in-process SDK. The TypeScript helper is exported from:

```ts
import { RpcClient, defineRpcClientTool } from "@oh-my-pi/pi-coding-agent/modes";
```

Protocol-only types are exported from `@oh-my-pi/pi-coding-agent/modes`, and the JSON schema artifact is exported as `@oh-my-pi/pi-coding-agent/modes/rpc/rpc.schema.json`.

`RpcClient` preserves raw/unknown frames, surfaces typed protocol errors, tracks long-running operations, rejects pending requests on close, serves host tools/URIs, and exposes extension UI responders. Long commands such as `bash`, `compact`, `handoff`, and `login` resolve after terminal operation frames; `prompt`, `followUp`, and `abortAndPrompt` return operation ACKs so callers can decide whether to wait for `agent_end` events or operation terminals.

Python embedders should use `python/omp-rpc` (`omp_rpc.RpcClient`). The Python client preserves enriched/future metadata in parsed `raw` fields and raw-frame listeners.

Core package-root exports for embedders include:

- `createAgentSession`
- `SessionManager`
- `Settings`
- `AuthStorage`
- `ModelRegistry`
- `discoverAuthStorage`
- Discovery helpers: `discoverExtensions`, `discoverSkills`, `discoverContextFiles`, `discoverPromptTemplates`, `discoverSlashCommands`, `discoverCustomTSCommands`, `discoverMCPServers`
- `buildSystemPrompt`
- Tool factory/classes: `createTools`, `BUILTIN_TOOLS`, `HIDDEN_TOOLS`, `ReadTool`, `SearchTool`, `WriteTool`, `ResolveTool`, etc.
- Extension and custom-tool types from `src/extensibility/extensions` and `src/extensibility/custom-tools`

There is no exported `discoverModels` helper. If you want explicit model/auth wiring, create a `ModelRegistry` from an `AuthStorage` instance:

```ts
import { discoverAuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
```

## Quick start with default discovery

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";

const { session, modelFallbackMessage } = await createAgentSession();

if (modelFallbackMessage) {
  process.stderr.write(`${modelFallbackMessage}\n`);
}

const done = Promise.withResolvers<void>();
const unsubscribe = session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
  if (event.type === "agent_end") {
    done.resolve();
  }
});

try {
  await session.prompt("Summarize this repository in 3 bullets.");
  await done.promise;
} finally {
  unsubscribe();
  await session.dispose();
}
```

`session.prompt(...)` is awaited in-process. Streaming events arrive through `session.subscribe(...)` while the turn is running; `agent_end` is the event-level completion signal.

## What `createAgentSession()` discovers by default

`createAgentSession()` follows “provide to override, omit to discover”.

If omitted, it resolves:

- `cwd`: `getProjectDir()`
- `agentDir`: `getAgentDir()` (`~/.omp/agent` by default)
- `authStorage`: `await discoverAuthStorage(agentDir)`
- `modelRegistry`: `new ModelRegistry(authStorage)` plus background `refreshInBackground()` when the registry was created by the SDK
- `settings`: `await Settings.init({ cwd, agentDir })`
- `sessionManager`: `SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))`
- skills, rules, context files, prompt templates, slash commands, extensions, and custom TypeScript commands
- built-in tools via `createTools(...)`
- custom tools discovered from configured custom-tool directories
- MCP tools when `enableMCP !== false`
- LSP integration when `enableLsp !== false`
- `eventBus`: a new `EventBus` unless supplied

Usually embedders only provide what they need to control:

- `sessionManager` for in-memory sessions or a custom session location/storage backend
- `authStorage` and `modelRegistry` when the host owns credential/model lifecycle
- `model` or `modelPattern` when deterministic selection matters
- `settings` for isolated/test configuration
- `extensions`, `customTools`, `skills`, `rules`, `contextFiles`, `promptTemplates`, or `slashCommands` when the host wants explicit capability input

## `CreateAgentSessionOptions`

Important options for embedders:

| Option | Actual behavior |
| --- | --- |
| `cwd?: string` | Working directory for project-local discovery. Defaults to `getProjectDir()`. |
| `agentDir?: string` | Global config directory. Defaults to `getAgentDir()`. |
| `authStorage?: AuthStorage` | Credential storage. Must be the same instance as `modelRegistry.authStorage` if both are supplied. |
| `modelRegistry?: ModelRegistry` | Model registry. Defaults to `new ModelRegistry(authStorageOrDiscoveredAuthStorage)`. |
| `model?: Model` | Explicit model object. |
| `modelPattern?: string` | Raw model selector resolved after extensions load, so extension-registered providers can participate. |
| `thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "auto"` | Initial thinking selector. |
| `scopedModels?: Array<{ model; thinkingLevel? }>` | Models available for cycling. |
| `systemPrompt?: string[] \| ((defaultPrompt: string[]) => string[])` | Array replaces all provider-facing prompt blocks; function receives the default block array and returns the final block array. |
| `providerSessionId?: string` | Provider-facing session ID for prompt caches/sticky auth. Does not merge persisted session files. |
| `customTools?: (CustomTool \| ToolDefinition)[]` | Additional SDK-owned tools. Does not disable discovered or extension tools. |
| `extensions?: ExtensionFactory[]` | Inline extensions. Current terminology is extensions, not hooks. |
| `additionalExtensionPaths?: string[]` | Extra extension files/dirs loaded with discovery. |
| `disableExtensionDiscovery?: boolean` | Disables automatic extension discovery; explicit paths still load. |
| `skills?: Skill[]`, `rules?: Rule[]`, `contextFiles?: ...[]` | Explicit inputs replace those discovery branches. |
| `promptTemplates?: PromptTemplate[]`, `slashCommands?: FileSlashCommand[]` | Explicit prompt-template or file-slash-command inputs. These are distinct systems. |
| `enableMCP?: boolean` | Defaults true. `false` skips `.mcp.json` discovery. |
| `mcpManager?: MCPManager` | Reuses an existing manager and skips new MCP discovery. |
| `enableLsp?: boolean` | Defaults true. `false` disables LSP tool/format/diagnostic integration. |
| `toolNames?: string[]` | Requested active tool names. Enables disabled-by-default tools when named. |
| `strictToolNames?: boolean` | When true and `toolNames` is set, treats `toolNames` as an exact active-tool allowlist. |
| `requireYieldTool?: boolean` | Ensures the hidden `yield` tool stays active for subagent-style sessions. |
| `sessionManager?: SessionManager` | Persistence backend/identity. Defaults to a file-backed session manager. |
| `settings?: Settings` | Settings instance. Defaults to `Settings.init({ cwd, agentDir })`. |
| `hasUI?: boolean` | Enables tools/extensions that require UI. Defaults false. |
| `telemetry?: AgentTelemetryConfig` | Enables OpenTelemetry instrumentation in the underlying agent loop. |
| `autoApprove?: boolean` | Runtime equivalent of CLI auto-approve/yolo behavior. |

Options not present in source include `discoverModels`, `hooks`, `additionalHookPaths`, `discoverCustomTools`, `additionalCustomToolPaths`, `loadSettings`, and `settingsManager`.

## System prompt blocks

The provider-facing system prompt is an array of blocks. OMP keeps stable harness text and dynamic project context as separate strings so providers can cache prompt prefixes.

```ts
const { session } = await createAgentSession({
  systemPrompt: (defaults) => [
    ...defaults,
    "## Host policy\nReturn concise answers and cite files you changed.",
  ],
});
```

Use a literal array only when replacing the full default prompt:

```ts
const { session } = await createAgentSession({
  systemPrompt: ["You are a repository summarizer. Do not modify files."],
});
```

Do not treat `systemPrompt` as a string concatenation callback; the callback input and output are both `string[]`.

## Session manager behavior

`AgentSession` always uses a `SessionManager`.

### File-backed sessions

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

process.stdout.write(`${session.sessionFile ?? "(no file)"}\n`);
```

File-backed sessions persist conversation entries and state deltas, support resume/open/list/fork workflows, and expose `session.sessionFile`.

### In-memory sessions

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

process.stdout.write(`${session.sessionFile ?? "(in memory)"}\n`);
```

In-memory sessions are useful for tests, ephemeral workers, and request-scoped agents. Persistence-specific operations are naturally limited.

### Resume/open/list helpers

```ts
import { SessionManager } from "@oh-my-pi/pi-coding-agent";

const recent = await SessionManager.continueRecent(process.cwd());
const listed = await SessionManager.list(process.cwd());
const opened = listed[0] ? await SessionManager.open(listed[0].path) : null;
```

## Model and auth wiring

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const model = modelRegistry.getAvailable()[0];
if (!model) throw new Error("No authenticated models available");

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  model,
  thinkingLevel: "medium",
  sessionManager: SessionManager.inMemory(),
});
```

When `model`/`modelPattern` is omitted, selection order is:

1. restored model from existing session, if restorable and authenticated
2. settings default model role (`default`)
3. first allowed model with usable auth

If restore falls back, `modelFallbackMessage` describes the fallback.

`AuthStorage.getApiKey(...)` resolves runtime overrides, config overrides, stored API keys, stored OAuth credentials, provider environment variables, and custom-provider fallback resolvers.

## Event subscription and prompt lifecycle

`session.subscribe(listener)` appends a listener and returns an unsubscribe function for that listener.

`AgentSessionEvent` includes core agent events:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`

It also includes session-level events:

- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `retry_fallback_applied`, `retry_fallback_succeeded`
- `ttsr_triggered`
- `todo_reminder`, `todo_auto_clear`
- `irc_message`
- `notice`
- `thinking_level_changed`
- `goal_updated`

`session.prompt(text, options?)` is the primary prompt API. It expands command/template syntax by default, validates model/API-key availability, appends the user message, and starts the turn.

```ts
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      process.stderr.write(`tool:${event.toolName}\n`);
      break;
  }
});

try {
  await session.prompt("Explain the current branch state.");
} finally {
  unsubscribe();
}
```

Prompt options from source:

| Option | Behavior |
| --- | --- |
| `expandPromptTemplates?: boolean` | Defaults true. Enables extension commands, custom TS commands, file slash commands, and prompt templates. |
| `images?: ImageContent[]` | Image attachments. |
| `streamingBehavior?: "steer" \| "followUp"` | Required if calling `prompt` while the session is already streaming. |
| `toolChoice?: ToolChoice` | Overrides tool choice for the next LLM call. |
| `synthetic?: boolean` | Sends a developer/system-style synthetic message where supported. |
| `attribution?: MessageAttribution` | Explicit billing/initiator attribution. |
| `skipCompactionCheck?: boolean` | Internal maintenance escape hatch. |

Related APIs:

- `steer(text, images?)`
- `followUp(text, images?)`
- `sendUserMessage(content, options?)`
- `sendCustomMessage(message, options?)`
- `abort()`
- `dispose()`

When the session is streaming, `prompt(...)` throws `AgentBusyError` unless `streamingBehavior` is provided. `steer(...)` and `followUp(...)` are explicit queueing APIs and reject extension command text that starts with `/`.

Always call `await session.dispose()` when the host is done. Disposal aborts active agent/retry/compaction work, cancels owned background jobs, disposes eval/provider/session resources, unregisters the session from the agent registry, and clears listeners.

## Tools and extensions

### Built-ins and filtering

Built-ins come from `createTools(...)` and `BUILTIN_TOOLS`.

```ts
const { session } = await createAgentSession({
  toolNames: ["read", "search", "find", "write"],
  requireYieldTool: true,
});
```

`toolNames` requests the active tool set. Disabled-by-default tools become active when named. Extension/custom tools are still considered unless `strictToolNames: true` is set. With `strictToolNames: true`, the requested names are treated as an exact active-tool allowlist, and matching discovered MCP/custom tools are filtered during loading.

### Extensions

Current source uses **extensions** terminology:

- `extensions`: inline `ExtensionFactory[]`
- `additionalExtensionPaths`: extra extension files/dirs
- `disableExtensionDiscovery`: skip automatic extension scanning
- `preloadedExtensions`: reuse an already loaded extension set

Legacy CLI `--hook` is handled as an alias for `--extension`, but the SDK option surface is extensions, not hooks.

### Runtime tool set changes

`AgentSession` supports runtime tool activation updates:

- `getActiveToolNames()`
- `getAllToolNames()`
- `setActiveToolsByName(names)`
- `refreshMCPTools(mcpTools)`

The system prompt is rebuilt to reflect active tool changes.

## Discovery helpers

Use these when you want partial control without recreating internal discovery logic:

- `discoverAuthStorage(agentDir?)`
- `discoverExtensions(cwd?)`
- `loadSessionExtensions(options, cwd, settings, eventBus)`
- `discoverSkills(cwd?, _agentDir?, settings?)`
- `discoverContextFiles(cwd?, _agentDir?)`
- `discoverPromptTemplates(cwd?, agentDir?)`
- `discoverSlashCommands(cwd?)`
- `discoverCustomTSCommands(cwd?, agentDir?)`
- `discoverMCPServers(cwd?)`
- `buildSystemPrompt(options?)`

## `CreateAgentSessionResult`

```ts
type CreateAgentSessionResult = {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
  mcpManager?: MCPManager;
  modelFallbackMessage?: string;
  lspServers?: LspStartupServerInfo[];
  eventBus: EventBus;
};
```

Use `setToolUIContext(...)` only if your embedder provides UI capabilities that tools/extensions should call into.

## Startup behavior and limitations

- `createAgentSession()` does substantial discovery work. For isolation from ambient project/user config, provide explicit `settings` and `sessionManager`, set explicit arrays for branches you want empty (`skills: []`, `rules: []`, `contextFiles: []`, `promptTemplates: []`, `slashCommands: []`), use `disableExtensionDiscovery: true` for extensions, and set `enableMCP: false` when MCP discovery should not run.
- The SDK runs in the same process as the host. Tool execution, extension code, and global singletons are not isolated from host process state.
- The SDK is not a JSON-RPC or stdio protocol; use RPC mode for cross-process embedding.
- `hasUI` defaults false. Interactive tools/extensions require a UI context supplied through the returned `setToolUIContext` callback.
- Startup LSP warmup only runs when `enableLsp !== false`, `hasUI === true`, and `lsp.diagnosticsOnWrite` is enabled. Non-UI SDK sessions can still start LSP servers on demand when an LSP tool needs one.
- Model-host preconnect is best-effort and silently skipped if `fetch.preconnect` is unavailable or throws.

## Minimal controlled embed example

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const settings = Settings.isolated({
  "compaction.enabled": true,
  "retry.enabled": true,
});

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  settings,
  sessionManager: SessionManager.inMemory(),
  toolNames: ["read", "search", "find", "edit", "write"],
  enableMCP: false,
  enableLsp: true,
});

const unsubscribe = session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await session.prompt("Find TODO comments in this repo and propose fixes.");
} finally {
  unsubscribe();
  await session.dispose();
}
```
