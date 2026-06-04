# RPC Protocol Reference

OMP RPC mode runs the coding agent as a newline-delimited JSON protocol over stdio.

This is **not JSON-RPC**: frames do not contain `jsonrpc`, `method`, or `params`. Each line is one JSON object whose own `type` field defines the frame.

- **stdin**: commands (`RpcCommand`), extension UI responses, host-tool updates/results, and host URI results
- **stdout**: the ready frame, command responses (`RpcResponse`), session/agent events, extension UI requests, host-tool requests/cancellations, host URI requests/cancellations, and extension errors
- **stderr**: human diagnostics, startup errors, and logging; do not parse it as protocol

Primary implementation:

- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`
- `packages/coding-agent/src/modes/rpc/host-tools.ts`
- `packages/coding-agent/src/modes/rpc/host-uris.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/cli/args.ts`
- `packages/coding-agent/src/main.ts`

## Launching RPC mode

```bash
omp --mode rpc [session/model/tool/config options]
```

Common embedder launches:

```bash
# Isolated, no persisted session file
omp --mode rpc --no-session --model anthropic/claude-sonnet-4-5

# Persist sessions under a host-controlled directory
omp --mode rpc --session-dir /var/lib/my-host/omp-sessions --model openrouter/anthropic/claude-sonnet-4.6

# Narrow ambient surfaces for a deterministic worker
omp --mode rpc --no-session --no-skills --no-rules --no-extensions --tools read,search,find
```

Accepted mode values include `rpc` and `rpc-ui`. Plain `rpc` does not install a tool UI context; `rpc-ui` passes the RPC UI context to tools and also sets `PI_NO_PTY=1`.

Startup behavior:

- `@file` CLI arguments are rejected in `rpc` and `rpc-ui` before the ready frame.
- `PI_NO_TITLE=1` is set in RPC modes.
- RPC mode applies built-in defaults for host-sensitive settings: `todo.*`, `task.*`, memory settings, `async.*`, and `bash.autoBackground.*` instead of inheriting user overrides.
- Startup/session/model failures can write human-readable errors to stderr and exit before any JSON frame is emitted. One-shot CLI flags that bypass agent startup, such as `--version`, `--list-models`, and `--export`, are not protocol launches and may write ordinary CLI output to stdout instead of a ready frame.
- Once `runRpcMode(...)` starts, stdout is protocol-only. Terminal notifications are disabled because BEL/OSC bytes on stdout would corrupt JSONL.
- The first successful protocol frame is exactly `{"type":"ready"}` followed by `\n`.
- When stdin closes, pending host-tool calls are rejected, host URI schemes are unregistered, pending host URI requests are rejected, and the process exits with code `0`.

## Transport and framing

Each frame is one JSON object followed by a newline:

```text
{"type":"ready"}\n
{"id":"req_1","type":"get_state"}\n
```

There is no batching and no outer envelope.

### Stdout frame categories

1. Ready frame: `{ "type": "ready" }`
2. Command response: `{ "type": "response", ... }`
3. `AgentSessionEvent`: `agent_start`, `message_update`, `tool_execution_end`, etc.
4. Extension UI request: `{ "type": "extension_ui_request", ... }`
5. Host tool request/cancel: `host_tool_call`, `host_tool_cancel`
6. Host URI request/cancel: `host_uri_request`, `host_uri_cancel`
7. Extension error: `{ "type": "extension_error", "extensionPath": "...", "event": "...", "error": "..." }`

### Stdin frame categories

1. `RpcCommand`
2. Extension UI response: `{ "type": "extension_ui_response", ... }`
3. Host tool update/result: `host_tool_update`, `host_tool_result`
4. Host URI result: `host_uri_result`

### Minimal raw client example

```ts
import { spawn } from "bun";

const child = spawn(["omp", "--mode", "rpc", "--no-session"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const stdin = child.stdin as Bun.FileSink;

async function* frames(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
}

for await (const frame of frames(child.stdout)) {
  if (frame.type === "ready") {
    stdin.write(`${JSON.stringify({ id: "state_1", type: "get_state" })}\n`);
    await stdin.flush();
    continue;
  }

  if (frame.type === "response" && frame.id === "state_1") {
    process.stdout.write(`${JSON.stringify(frame.data, null, 2)}\n`);
    break;
  }
}

child.kill();
```

## Request/response correlation

All commands accept optional `id?: string`.

Normal command responses echo the same `id`:

```json
{ "id": "req_1", "type": "response", "command": "get_state", "success": true, "data": {} }
```

Failures use the same response shape:

```json
{ "id": "req_2", "type": "response", "command": "set_model", "success": false, "error": "Model not found: provider/model" }
```

Runtime edge behavior:

- Unknown-command responses are emitted with `id: undefined`, even when the request included an id.
- Parse/input-loop exceptions emit `{ type: "response", command: "parse", success: false, error }` with `id: undefined`.
- Extension UI responses with unknown ids are ignored.
- Host tool/URI results with unknown ids are ignored by the bridge.
- `prompt` and `abort_and_prompt` return an immediate success ACK, then may emit a later failure response with the same id if asynchronous prompt scheduling fails. A helper that resolves pending requests on the first ACK may surface that later error through a separate protocol-error path, not through the original request promise.

## Command schema

`RpcCommand` is defined in `packages/coding-agent/src/modes/rpc/rpc-types.ts`.

### Prompting

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
- `{ id?, type: "steer", message: string, images?: ImageContent[] }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[] }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[] }`
- `{ id?, type: "new_session", parentSession?: string }`

### State and host registration

- `{ id?, type: "get_state" }`
- `{ id?, type: "set_todos", phases: TodoPhase[] }`
- `{ id?, type: "set_host_tools", tools: RpcHostToolDefinition[] }`
- `{ id?, type: "set_host_uri_schemes", schemes: RpcHostUriSchemeDefinition[] }`

### Model and thinking

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "cycle_model" }`
- `{ id?, type: "get_available_models" }`
- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`

### Queue modes

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`

### Compaction, retry, bash

- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`
- `{ id?, type: "set_auto_retry", enabled: boolean }`
- `{ id?, type: "abort_retry" }`
- `{ id?, type: "bash", command: string }`
- `{ id?, type: "abort_bash" }`

### Session, messages, login

- `{ id?, type: "get_session_stats" }`
- `{ id?, type: "export_html", outputPath?: string }`
- `{ id?, type: "switch_session", sessionPath: string }`
- `{ id?, type: "branch", entryId: string }`
- `{ id?, type: "get_branch_messages" }`
- `{ id?, type: "get_last_assistant_text" }`
- `{ id?, type: "set_session_name", name: string }`
- `{ id?, type: "handoff", customInstructions?: string }`
- `{ id?, type: "get_messages" }`
- `{ id?, type: "get_login_providers" }`
- `{ id?, type: "login", providerId: string }`

## Response schema

All command results use `RpcResponse`:

- Success: `{ id?, type: "response", command: <command>, success: true, data?: ... }`
- Failure: `{ id?, type: "response", command: string, success: false, error: string }`

### `get_state` response data

```json
{
  "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
  "thinkingLevel": "medium",
  "isStreaming": false,
  "isCompacting": false,
  "steeringMode": "one-at-a-time",
  "followUpMode": "one-at-a-time",
  "interruptMode": "immediate",
  "sessionFile": "/abs/path/session.jsonl",
  "sessionId": "01J...",
  "sessionName": "optional name",
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0,
  "todoPhases": [],
  "systemPrompt": ["..."],
  "dumpTools": [
    {
      "name": "read",
      "description": "Read files and URLs",
      "parameters": {}
    }
  ],
  "contextUsage": {
    "tokens": 1100,
    "contextWindow": 200000,
    "percent": 0.55
  }
}
```

`contextUsage` is part of the raw TypeScript RPC state. The Python `omp-rpc` helper currently parses a narrower `SessionState` and does not expose that field.

### `set_todos`

`set_todos` replaces the in-memory todo state for the current session and returns `{ "todoPhases": TodoPhase[] }`.

```json
{
  "id": "todo_1",
  "type": "set_todos",
  "phases": [
    {
      "id": "phase-1",
      "name": "Evaluation",
      "tasks": [
        { "id": "task-1", "content": "Map the read tool surface", "status": "in_progress" },
        { "id": "task-2", "content": "Exercise edit operations", "status": "pending" }
      ]
    }
  ]
}
```

## Event stream

RPC mode forwards `AgentSessionEvent` objects from `AgentSession.subscribe(...)`.

Core event types include:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`

Session-level events include:

- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `retry_fallback_applied`, `retry_fallback_succeeded`
- `ttsr_triggered`
- `todo_reminder`, `todo_auto_clear`
- `irc_message`
- `notice`
- `thinking_level_changed`
- `goal_updated`

`message_update` carries streaming deltas in `assistantMessageEvent`.

Extension runner errors are emitted separately:

```json
{
  "type": "extension_error",
  "extensionPath": "...",
  "event": "...",
  "error": "..."
}
```

## Prompt, queueing, and completion

### Immediate ACK vs completion

`prompt` and `abort_and_prompt` are accepted asynchronously:

stdin:

```json
{ "id": "req_1", "type": "prompt", "message": "Summarize this repo" }
```

stdout ACK:

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
```

That ACK means the command was accepted/scheduled. It does **not** mean the model turn is complete.

Completion is observed through later events, normally ending with `agent_end`:

```json
{ "type": "agent_start" }
{ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "..." }, "message": { "role": "assistant", "content": [] } }
{ "type": "agent_end", "messages": [] }
```

### Prompt while streaming

During active streaming, `AgentSession.prompt()` requires `streamingBehavior`:

```json
{
  "id": "req_2",
  "type": "prompt",
  "message": "Also include risks",
  "streamingBehavior": "followUp"
}
```

- `"steer"` queues an interrupting steering message.
- `"followUp"` queues a post-turn follow-up.

If `streamingBehavior` is omitted during active streaming, prompt scheduling fails. For `prompt` and `abort_and_prompt`, that failure can appear after the immediate ACK as a later error response.

### Queue mode commands

- `set_steering_mode`
  - `"one-at-a-time"`: dequeue one steering message per turn.
  - `"all"`: dequeue all queued steering messages.
- `set_follow_up_mode`
  - `"one-at-a-time"`: dequeue one follow-up per continuation.
  - `"all"`: dequeue all queued follow-ups.
- `set_interrupt_mode`
  - `"immediate"`: steering can interrupt between tool calls.
  - `"wait"`: steering waits for turn completion.

## Extension UI sub-protocol

Extensions in RPC mode use request/response UI frames.

Outbound `extension_ui_request` methods from TypeScript source:

- `select`, `confirm`, `input`, `editor`, `cancel`
- `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`
- `open_url` from RPC login/OAuth flows

Most methods are fire-and-forget except interactive dialogs, which expect an `extension_ui_response`.

Request example:

```json
{
  "type": "extension_ui_request",
  "id": "ui_7",
  "method": "confirm",
  "title": "Confirm",
  "message": "Continue?",
  "timeout": 30000
}
```

Response shapes:

```json
{ "type": "extension_ui_response", "id": "ui_7", "confirmed": true }
```

```json
{ "type": "extension_ui_response", "id": "ui_8", "value": "feature/rpc-host" }
```

```json
{ "type": "extension_ui_response", "id": "ui_9", "cancelled": true, "timedOut": true }
```

Timeouts and aborts resolve to default values in the runtime. `setTitle` UI events are suppressed unless `PI_RPC_EMIT_TITLE=1` is set.

RPC UI limitations in source:

- raw terminal input is unsupported
- working-message, footer, header, custom UI, custom editor components, tool expansion, and theme switching are unsupported/no-op or return a failure
- `getEditorText()` returns an empty string
- `pasteToEditor(text)` falls back to `set_editor_text`

## Host tool sub-protocol

RPC hosts can expose custom tools by sending `set_host_tools`, then serving execution requests over the same stdio channel.

### Register tools

stdin:

```json
{
  "id": "tools_1",
  "type": "set_host_tools",
  "tools": [
    {
      "name": "echo_host",
      "label": "Echo Host",
      "description": "Echo a value from the embedding host",
      "parameters": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"],
        "additionalProperties": false
      },
      "hidden": false
    }
  ]
}
```

stdout:

```json
{
  "id": "tools_1",
  "type": "response",
  "command": "set_host_tools",
  "success": true,
  "data": { "toolNames": ["echo_host"] }
}
```

Definition normalization/validation:

- `name` and `description` are trimmed and must be non-empty.
- `parameters` must be a JSON Schema object, not an array.
- `label` defaults to the normalized name.
- `hidden` is true only when the input is exactly `true`.
- Re-sending `set_host_tools` replaces the whole host-owned tool set.

### Execute a host tool

When the model calls the tool, stdout emits:

```json
{
  "type": "host_tool_call",
  "id": "host_1",
  "toolCallId": "toolu_123",
  "toolName": "echo_host",
  "arguments": { "message": "hello" }
}
```

The host may stream zero or more updates on stdin:

```json
{
  "type": "host_tool_update",
  "id": "host_1",
  "partialResult": {
    "content": [{ "type": "text", "text": "working" }]
  }
}
```

The host completes with:

```json
{
  "type": "host_tool_result",
  "id": "host_1",
  "result": {
    "content": [{ "type": "text", "text": "done" }]
  }
}
```

To reject the call, set top-level `isError: true`. The bridge joins returned text content and surfaces it as the tool error:

```json
{
  "type": "host_tool_result",
  "id": "host_1",
  "isError": true,
  "result": {
    "content": [{ "type": "text", "text": "host-side failure" }]
  }
}
```

### Host tool cancellation

If the agent-side tool execution aborts, stdout emits:

```json
{
  "type": "host_tool_cancel",
  "id": "host_cancel_1",
  "targetId": "host_1"
}
```

`targetId` is the original `host_tool_call.id`. The host should stop work and avoid sending late updates/results. Late frames for unknown ids are ignored.

## Host URI sub-protocol

RPC hosts can own virtual URL schemes. After registration, the agent's `read` tool resolves `<scheme>://...` through the host, and the `write` tool dispatches full replacement content when the scheme is registered as writable.

The `edit` tool does not target host URIs.

### Register schemes

stdin:

```json
{
  "id": "uris_1",
  "type": "set_host_uri_schemes",
  "schemes": [
    {
      "scheme": "db",
      "description": "Virtual db row files",
      "writable": true,
      "immutable": false
    }
  ]
}
```

stdout:

```json
{
  "id": "uris_1",
  "type": "response",
  "command": "set_host_uri_schemes",
  "success": true,
  "data": { "schemes": ["db"] }
}
```

Registration behavior:

- scheme names are trimmed, lowercased, and must match `^[a-z][a-z0-9+.-]*$`
- schemes are registered in the process-global internal URL router
- re-sending `set_host_uri_schemes` replaces the whole host-owned scheme set and unregisters dropped schemes
- stdin close clears registered host URI schemes

### Host URI read

When the agent reads `db://users/42`, stdout emits:

```json
{
  "type": "host_uri_request",
  "id": "uri_1",
  "operation": "read",
  "url": "db://users/42"
}
```

The host returns:

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "content": "id=42\nname=Alice\n",
  "contentType": "text/plain",
  "notes": ["fresh from cache"],
  "immutable": false
}
```

Read defaults:

- missing `content` becomes `""`
- missing `contentType` becomes `"text/plain"`
- `notes` are propagated only when non-empty
- result-level `immutable` overrides scheme-level `immutable`

### Host URI write

When the agent writes replacement content to a writable scheme, stdout emits:

```json
{
  "type": "host_uri_request",
  "id": "uri_2",
  "operation": "write",
  "url": "db://users/42",
  "content": "id=42\nname=Bob\n"
}
```

Successful writes return no content:

```json
{ "type": "host_uri_result", "id": "uri_2" }
```

To reject a read or write, set `isError: true` and provide `error` or fallback text in `content`:

```json
{
  "type": "host_uri_result",
  "id": "uri_2",
  "isError": true,
  "error": "row 42 not found"
}
```

### Host URI cancellation

If a pending read/write aborts, stdout emits:

```json
{
  "type": "host_uri_cancel",
  "id": "uri_cancel_1",
  "targetId": "uri_2"
}
```

`targetId` is the original `host_uri_request.id`. Late results for unknown ids are ignored.

## Error model and process lifetime

- Command failures are `success: false` with string `error`.
- Most command failures are recoverable; the process keeps reading stdin.
- Malformed JSONL is a transport failure from the JSONL reader; do not rely on a recoverable `parse` response for invalid JSON. Exceptions while handling an already parsed frame emit a `parse` error response and keep reading subsequent frames.
- Empty `set_session_name` is rejected with `Session name cannot be empty`.
- Process termination conditions are stdin close or extension-triggered shutdown after the current command.
- Pre-ready startup failure is not recoverable through protocol frames; inspect stderr and process exit.

## `RpcClient` helper notes

`packages/coding-agent/src/modes/rpc/rpc-client.ts` is a TypeScript convenience wrapper, not the protocol definition.

Current helper behavior:

- spawns `bun <cliPath> --mode rpc`
- waits for the ready frame and rejects startup failures with captured stderr
- generates request ids as `req_<n>`
- correlates matching `response` frames by id
- dispatches only recognized core `AgentEvent` types to `onEvent` listeners: `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- supports host-owned custom tools through `setCustomTools()` and automatic `host_tool_call` / `host_tool_cancel` handling
- wraps common protocol commands including OAuth `getLoginProviders()` / `login(...)`

Helper limitations:

- It is not a complete raw-frame API.
- It drops unrecognized session-level events such as auto-compaction, auto-retry, TTSR, todo, notice, thinking-level, goal, and extension-error frames unless another helper path handles them.
- It has no typed host URI registration/serving helper; use raw frames for `set_host_uri_schemes` and `host_uri_request`.
- `prompt()`, `abortAndPrompt()`, and `waitForIdle()` inherit the protocol's async ACK semantics; completion is still `agent_end`.

## Known non-claims and limitations

- OMP RPC is stdio NDJSON, not JSON-RPC, MCP, or HTTP.
- The protocol does not guarantee ordered pairing between command responses and agent events beyond the line order emitted on stdout.
- A `prompt` ACK is not completion.
- Host URI writes are full replacement writes, not patches.
- Host tools and host URI schemes are process/session transport registrations; re-registration replaces host-owned definitions.
- OAuth login in raw TypeScript RPC can emit `open_url` UI requests. Language clients may expose a narrower typed UI surface; check the client package docs.