# RPC Protocol Reference

OMP RPC is a local stdio NDJSON control plane for embedding the coding agent in dashboards, IDEs, gateway runtimes, supervisors, and other host processes. It is **not JSON-RPC**: every line is one JSON object whose top-level `type` names the frame.

Primary implementation:

- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — server dispatcher
- `packages/coding-agent/src/modes/rpc/rpc-protocol.ts` — protocol facts, typed errors, frame writer, limits
- `packages/coding-agent/src/modes/rpc/operation-manager.ts` — operation registry/cancellation/terminal frames
- `packages/coding-agent/src/modes/rpc/rpc-input.ts` — bounded stdin parser and validation
- `packages/coding-agent/src/modes/rpc/rpc-types.ts` — TypeScript protocol types
- `packages/coding-agent/src/modes/rpc/rpc.schema.json` — shipped JSON schema artifact
- `packages/coding-agent/src/modes/rpc/rpc-client.ts` — TypeScript helper client
- `python/omp-rpc/src/omp_rpc/` — Python helper client

## Launching

```bash
omp --mode rpc [session/model/tool/config options]
omp --mode rpc-ui [session/model/tool/config options]
```

`rpc` is a protocol-only embedding mode. `rpc-ui` also installs an RPC-backed extension/tool UI context. Both modes are keyless for protocol introspection commands such as `get_protocol_info`, `get_state`, `ping`, and `shutdown`.

Behavior notes:

- RPC mode disables automatic session title generation by default to avoid an extra model call.
- RPC mode resets workflow-altering `todo.*`, `task.*`, `memory.backend`/`memories.enabled`, `advisor.*`, `async.*`, and `bash.autoBackground.*` settings to their built-in defaults instead of inheriting user overrides.
- The process reads stdin as JSONL (`readJsonl(Bun.stdin.stream())`).

Deterministic one-shot probing:

```bash
omp --mode rpc --no-session --no-skills --no-rules --no-title --rpc-one-shot get_protocol_info
omp --mode rpc-ui --no-session --no-skills --no-rules --no-title --rpc-one-shot '{"id":"probe","type":"get_state"}'
```

A one-shot launch emits `ready`, executes one command, emits its response and a `shutdown` frame, then exits.

Startup behavior:

- stdout is protocol-only after `runRpcMode(...)` starts.
- The first successful stdout protocol frame is `ready`.
- `@file` CLI arguments are rejected in `rpc` and `rpc-ui` before ready.
- Startup failures before ready may write human diagnostics to stderr and exit.
- `PI_NOTIFICATIONS=off` is applied to prevent terminal control bytes on stdout.
- stdin close is treated as `peer_closed`: pending operations, host calls, URI requests, and UI requests receive typed terminal/rejection handling before shutdown.

## Transport and Framing

Each frame is a single JSON object followed by `\n`. There is no envelope beyond the object shape itself.

### Outbound frame categories (stdout)

1. Ready frame (`{ type: "ready" }`)
2. `RpcResponse` (`{ type: "response", ... }`)
3. `AgentSessionEvent` objects (`agent_start`, `message_update`, etc.)
4. `RpcExtensionUIRequest` (`{ type: "extension_ui_request", ... }`)
5. Host tool requests/cancellations (`host_tool_call`, `host_tool_cancel`)
6. Host URI requests/cancellations (`host_uri_request`, `host_uri_cancel`)
7. Extension errors (`{ type: "extension_error", extensionPath, event, error }`)
8. Available-commands updates (`{ type: "available_commands_update", commands }`), emitted at startup and whenever command metadata changes
9. Prompt lifecycle hints (`{ type: "prompt_result", id?, agentInvoked }`) for scheduled prompts that later resolve without invoking the agent
10. Subagent frames (`subagent_lifecycle`, `subagent_progress`, `subagent_event`), gated by `set_subagent_subscription`
11. Builtin slash-command side channels (`command_output`, `session_info_update`, `config_update`)

### Streams

- **stdin**: commands, extension UI responses, host-tool updates/results/cancel ACKs, host URI results/cancel ACKs.
- **stdout**: `ready`, command `response`, protocol/session/operation/task/subagent/state frames, host-tool requests/cancels, host URI requests/cancels, extension UI requests, extension errors, `pong` health responses, and `shutdown`.
- **stderr**: diagnostics only; never parse it as protocol.

### Inbound frame categories (stdin)

1. `RpcCommand`
2. `RpcExtensionUIResponse` (`{ type: "extension_ui_response", ... }`)
3. Host tool updates/results (`host_tool_update`, `host_tool_result`)
4. Host URI results (`host_uri_result`)

## Request/Response Correlation

All commands accept optional `id?: string`.

- If provided, normal command responses echo the same `id`.
- `RpcClient` relies on this for pending-request resolution.

Important edge behavior from runtime:

- Unknown command responses are emitted with `id: undefined` (even if the request had an `id`).
- Parse/handler exceptions in the input loop emit `command: "parse"` with `id: undefined`.
- `prompt` and `abort_and_prompt` return immediate success, then may emit a later error response with the **same** id if async prompt scheduling fails.
- `prompt` success responses may include `data.agentInvoked`. `false` means the prompt completed locally without an agent turn; `true` means the prompt produced agent lifecycle events; omitted means the host must rely on session events for completion.
- `abort_and_prompt` does not currently emit `data.agentInvoked` or `prompt_result`; hosts should treat it as the legacy abort-then-schedule path and rely on session events or same-id scheduling errors.

## Command Schema (canonical)

`RpcCommand` is defined in `src/modes/rpc/rpc-types.ts`:

### Prompting

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
- `{ id?, type: "steer", message: string, images?: ImageContent[] }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[] }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[] }`
- `{ id?, type: "new_session", parentSession?: string }`

### State

- `{ id?, type: "get_state" }`
- `{ id?, type: "get_available_commands" }`
- `{ id?, type: "set_todos", phases: TodoPhase[] }`
- `{ id?, type: "set_host_tools", tools: RpcHostToolDefinition[] }`
- `{ id?, type: "set_host_uri_schemes", schemes: RpcHostUriSchemeDefinition[] }`
- `{ id?, type: "set_subagent_subscription", level: "off" | "progress" | "events" }`
- `{ id?, type: "get_subagents" }`
- `{ id?, type: "get_subagent_messages", subagentId?: string, sessionFile?: string, fromByte?: number }`

### Model

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "cycle_model" }`
- `{ id?, type: "get_available_models" }`

### Thinking

- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`

### Queue modes

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`

### Compaction

- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`

### Retry

- `{ id?, type: "set_auto_retry", enabled: boolean }`
- `{ id?, type: "abort_retry" }`

### Bash

- `{ id?, type: "bash", command: string }`
- `{ id?, type: "abort_bash" }`

### Session

- `{ id?, type: "get_session_stats" }`
- `{ id?, type: "export_html", outputPath?: string }`
- `{ id?, type: "switch_session", sessionPath: string }`
- `{ id?, type: "branch", entryId: string }`
- `{ id?, type: "get_branch_messages" }`
- `{ id?, type: "get_last_assistant_text" }`
- `{ id?, type: "set_session_name", name: string }`
- `{ id?, type: "handoff", customInstructions?: string }`

### Messages

- `{ id?, type: "get_messages" }`

### Login

- `{ id?, type: "get_login_providers" }`
- `{ id?, type: "login", providerId: string }`

## Response Schema

All command results use `RpcResponse`:

- Success: `{ id?, type: "response", command: <command>, success: true, data?: ... }`
- Failure: `{ id?, type: "response", command: string, success: false, error: string }`

Data payloads are command-specific and defined in `rpc-types.ts`.

### `prompt` payload

`prompt` is acknowledged after the command is accepted, not after a model turn finishes:

```json
{
  "id": "req_1",
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": { "agentInvoked": false }
}
```

`data.agentInvoked: false` is a completion signal for local-only prompts, including slash commands that produce output without starting an agent turn. `data.agentInvoked: true` means the prompt produced agent lifecycle events; those events can be emitted before or after the prompt response depending on the command path. Older runtimes may omit `data`; hosts should then rely on `agent_end`, custom message completion, or `prompt_result`.

`prompt_result` is emitted when a prompt was accepted immediately but later resolves as local-only:

```json
{ "type": "prompt_result", "id": "req_1", "agentInvoked": false }
```

Local-only slash commands may emit `command_output` frames before completing via `data.agentInvoked: false` or a later `prompt_result`. They do not emit `agent_end`.

### `get_state` payload

```json
{
  "model": { "provider": "...", "id": "..." },
  "thinkingLevel": "off|minimal|low|medium|high|xhigh",
  "isStreaming": false,
  "isCompacting": false,
  "steeringMode": "all|one-at-a-time",
  "followUpMode": "all|one-at-a-time",
  "interruptMode": "immediate|wait",
  "sessionFile": "...",
  "sessionId": "...",
  "sessionName": "...",
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0,
  "todoPhases": [
    {
      "id": "phase-1",
      "name": "Todos",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the tool surface",
          "status": "in_progress"
        }
      ]
    }
  ],
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

### `set_todos` payload

Replaces the in-memory todo state for the current session and returns the normalized phase list:

```json
{
  "id": "req_2",
  "type": "set_todos",
  "phases": [
    {
      "id": "phase-1",
      "name": "Evaluation",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the read tool surface",
          "status": "in_progress"
        },
        {
          "id": "task-2",
          "content": "Exercise edit operations",
          "status": "pending"
        }
      ]
    }
  ]
}
```

This is useful for hosts that want to pre-seed a plan before the first prompt.

### `set_host_tools` payload

Replaces the current set of host-owned tools that the RPC server may call back
into over stdio:

```json
{
  "id": "req_3",
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
      }
    }
  ]
}
```

The response payload is:

```json
{
  "toolNames": ["echo_host"]
}
```

These tools are added to the active session tool registry before the next model
call. Re-sending `set_host_tools` replaces the previous host-owned set.

### `set_host_uri_schemes` payload

Replaces the current set of host-owned URL schemes the RPC server should
dispatch reads/writes through:

```json
{
  "id": "req_4",
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

The response payload is:

```json
{
  "schemes": ["db"]
}
```

Schemes are case-insensitive on the wire and normalized to lowercase before
the response is sent. Re-sending `set_host_uri_schemes` replaces the entire
previous set — schemes missing from the new list are unregistered.

## Frame metadata

Every stdout frame is written by `RpcFrameWriter` and includes:

```json
{
  "seq": 1,
  "timestamp": "2026-06-05T12:00:00.000Z",
  "sessionId": "019e..."
}
```

`seq` is monotonic per process. `timestamp` is ISO-8601. `sessionId` is stable for the current session identity and may be `null` before a session exists.

Inbound limits are enforced before dispatch:

- `maxFrameBytes`
- `maxPartialLineBytes`
- `maxOutboundFrameBytes`
- `maxHostToolResultBytes`
- `maxHostToolUpdateBytes`
- `maxHostUriContentBytes`
- default host-tool/URI/UI deadlines

Oversized inbound or outbound payloads produce typed protocol errors instead of unbounded buffering.

## Ready and protocol info

`ready` is authoritative. `get_protocol_info` returns matching durable facts.

```json
{
  "type": "ready",
  "seq": 1,
  "timestamp": "2026-06-05T12:00:00.000Z",
  "sessionId": "session_abc",
  "protocol": { "name": "omp-rpc", "version": "1.1.0", "schemaVersion": 1 },
  "server": { "packageName": "@oh-my-pi/pi-coding-agent", "packageVersion": "15.8.1", "pid": 12345 },
  "mode": "rpc-ui",
  "capabilities": {
    "commands": ["get_protocol_info", "get_state", "prompt", "bash", "background_lane", "cancel_operation"],
    "events": ["operation_start", "operation_end", "state_changed", "background_lane_update", "task_progress"],
    "frameMetadata": true,
    "operationEvents": true,
    "typedErrors": true,
    "stateChanges": true,
    "sessionGraph": true,
    "taskEvents": true,
    "extensionUi": true,
    "observableSessions": true,
    "hostTools": true,
    "hostUris": true,
    "chunkedPayloads": false,
    "oneShot": true,
    "heartbeat": true,
    "backgroundLanes": true
  },
  "limits": {
    "maxFrameBytes": 1048576,
    "maxPartialLineBytes": 1048576,
    "maxOutboundFrameBytes": 1048576,
    "maxHostToolResultBytes": 1032192,
    "maxHostToolUpdateBytes": 262144,
    "maxHostUriContentBytes": 1032192,
    "maxSessionEntryContentBytes": 262144,
    "maxUiPayloadBytes": 262144,
    "defaultHostToolTimeoutMs": null,
    "defaultHostUriTimeoutMs": null,
    "defaultOperationTimeoutMs": null,
    "defaultExtensionUiTimeoutMs": 30000
  },
  "resetProfile": {
    "name": "rpc-defaults",
    "ambientUserConfigApplied": true,
    "settingOverrides": []
  },
  "security": {
    "enabledCommandCategories": ["protocol", "prompting", "state", "model", "thinking", "queue", "compaction", "retry", "bash", "background_lanes", "session", "messages", "login"],
    "disabledTools": [],
    "hostToolPermissionMode": "host-owned",
    "hostUriAllowedSchemes": [],
    "hostUriReservedSchemes": ["omp", "agent", "artifact", "memory", "local", "vault", "skill", "rule", "mcp", "issue", "pr"],
    "bash": { "enabled": true, "cwd": "/work/repo", "rootPolicy": "session-cwd" },
    "sessionMutation": true,
    "loginProviders": [],
    "extensionsEnabled": true,
    "redactionPolicy": "host-owned local stdio; paths are not redacted in protocol frames"
  }
}
```

Hosts must make feature decisions from `ready.capabilities` or `get_protocol_info`, not source inference.

## Commands and responses

All commands accept `id?: string`; parseable ids are echoed on validation and unknown-command failures.

```json
{ "id": "req_1", "type": "get_state" }
```

Responses preserve legacy fields and add typed errors:

```json
{
  "id": "req_1",
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: provider/model",
  "errorInfo": {
    "code": "model_not_found",
    "message": "Model not found: provider/model",
    "details": { "provider": "provider", "modelId": "model" },
    "retryable": false
  }
}
```

Malformed JSON that cannot expose an id emits uncorrelated `protocol_error`:

```json
{
  "type": "protocol_error",
  "error": "Unexpected token ...",
  "errorInfo": { "code": "invalid_json", "message": "Unexpected token ...", "retryable": false }
}
```

Stable error-code family:

- `invalid_json`, `invalid_frame`, `invalid_command`, `unknown_command`, `invalid_arguments`
- `unsupported_capability`, `model_not_found`, `session_not_found`, `internal_error`
- `operation_not_found`, `operation_cancelled`, `operation_timeout`, `peer_closed`
- `host_tool_not_found`, `host_tool_timeout`, `host_tool_failed`, `host_tool_too_large`
- `host_uri_scheme_not_found`, `host_uri_denied`, `host_uri_too_large`
- `extension_ui_timeout`

## Operation lifecycle

Long-running commands return an ACK with `operationId`; completion is observed only through terminal operation frames.

Long-running commands include `prompt`, `follow_up`, `abort_and_prompt`, `compact`, `bash`, `handoff`, `login`, `background_lane` `spawn`, and `background_lane` `message`.

```json
{ "id": "bash_1", "type": "bash", "command": "sleep 10" }
```

```json
{
  "id": "bash_1",
  "type": "response",
  "command": "bash",
  "success": true,
  "data": { "ack": "accepted", "operationId": "op_123", "queued": false }
}
```

Operation frames:

```json
{ "type": "operation_start", "operationId": "op_123", "command": "bash", "requestId": "bash_1", "startedAt": "..." }
```

```json
{ "type": "operation_end", "operationId": "op_123", "command": "bash", "status": "completed", "data": { "exitCode": 0, "output": "" }, "startedAt": "...", "endedAt": "..." }
```

```json
{ "type": "operation_error", "operationId": "op_123", "command": "bash", "status": "cancelled", "error": "Operation cancelled: op_123", "errorInfo": { "code": "operation_cancelled", "message": "Operation cancelled: op_123", "retryable": false } }
```

Cancel an accepted operation:

```json
{ "id": "cancel_1", "type": "cancel_operation", "operationId": "op_123" }
```

Every accepted operation emits exactly one terminal `operation_end` or `operation_error` frame. Late async failures are terminal operation frames, not duplicate command responses.

## State and session graph

`get_state` returns a complete RPC-visible snapshot:

```json
{
  "stateSeq": 2,
  "protocol": { "name": "omp-rpc", "version": "1.1.0", "schemaVersion": 1 },
  "capabilities": {},
  "limits": {},
  "resetProfile": {},
  "security": {},
  "activeOperations": [],
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
  "autoRetryEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0,
  "todoPhases": [],
  "systemPrompt": ["..."],
  "dumpTools": [],
  "contextUsage": {},
  "hostTools": [],
  "hostUriSchemes": [],
  "backgroundLanes": []
}
```

`backgroundLanes` mirrors the durable goal/session lane ledger in compact form for hosts that need topology or blocker displays. It is observational: hosts must not infer accepted parent truth from lane, branch, patch, check, or child-session existence.

Material mutations emit `state_changed` with monotonic `stateSeq` and an embedded snapshot matching `get_state`.

Session hydration commands:

- `{ id?, type: "get_messages" }` — legacy/current-branch linear messages.
- `{ id?, type: "get_session_entries", offset?: number, limit?: number, entryTypes?: string[], includeContent?: boolean }` — paginated tree entries with ids, parent ids, labels, timestamps, previews, `currentLeafId`, and artifact refs for large serialized entries.
- `{ id?, type: "get_session_tree", includeEntries?: boolean }` — tree rooted at session entries plus `currentLeafId` for the current branch.
- `{ id?, type: "get_observable_sessions" }` — observable main/subagent session summaries.

Large entry content uses `contentRef` instead of unbounded inline payloads.

## Task, subagent, and observable-session frames

Task/subagent orchestration is first-class:

- `task_progress` — stable task/subagent ids, parent ids, status, current tool, token counters, bounded preview.
- `task_result` — final subagent results, bounded summary, output refs.
- `subagent_lifecycle` — started/completed/failed lifecycle for child sessions.
- `observable_session_update` — dashboard-friendly session list with labels, status, summary, and timestamps.

These frames are additive and do not replace existing `tool_execution_*` events or task tool details.

## Background lanes

`ready.capabilities.backgroundLanes === true` advertises the generic background-lane command family and update stream.

Immediate command:

```json
{ "id": "lanes", "type": "background_lane", "op": "list" }
```

Response data:

```json
{
  "lanes": [
    {
      "id": "lane_...",
      "question": "What condition is this lane checking?",
      "agentStatus": "running",
      "status": "open",
      "outcome": null,
      "requiredBeforeParent": true,
      "blocksIfFired": false,
      "branch": "omp/lane/lane_..."
    }
  ]
}
```

Long-running commands:

```json
{
  "id": "spawn_lane",
  "type": "background_lane",
  "op": "spawn",
  "from": { "checkpoint_id": "goal-1-checkpoint-1", "source_ref": "abc123..." },
  "contract": {
    "question": "What could invalidate this accepted checkpoint?",
    "blocks_if": "The checkpoint claim is false or stale.",
    "required_before_parent": true
  },
  "assignment": "Inspect independently and report through lane_report."
}
```

```json
{ "id": "message_lane", "type": "background_lane", "op": "message", "lane_id": "lane_...", "message": "Follow-up context." }
```

Both return `data.ack: "accepted"` plus `operationId`; success/failure is only the later terminal operation frame. ACK does not imply lane completion, child completion, evidence acceptance, or parent acceptance.

Observation and disposition:

```json
{ "id": "snapshot_lane", "type": "background_lane", "op": "snapshot", "lane_id": "lane_..." }
{ "id": "close_lane", "type": "background_lane", "op": "close", "lane_id": "lane_...", "outcome": "deferred", "reason": "Operator disposition." }
```

`snapshot` records diff/patch/report state against the lane source ref without accepting or closing anything. `close` records an explicit disposition only; it does not mutate parent truth except by satisfying the lane-obligation guard.

Lane state changes emit:

```json
{
  "type": "background_lane_update",
  "schemaVersion": 1,
  "laneId": "lane_...",
  "status": "blocked",
  "blocksIfFired": true,
  "summary": {
    "id": "lane_...",
    "question": "What condition is this lane checking?",
    "agentStatus": "running",
    "status": "blocked",
    "outcome": null,
    "requiredBeforeParent": true,
    "blocksIfFired": true,
    "branch": "omp/lane/lane_..."
  }
}
```

Hosts should surface `blocksIfFired`, required-before-parent, branch/worktree/session refs, latest reports, and close outcome as audit/control state. They must not parse child prose for blockers; blocker state comes from structured `lane_report` handling in the parent session.

## Event Stream Schema

RPC mode forwards `AgentSessionEvent` objects from `AgentSession.subscribe(...)`.

Common event types:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`
- `todo_auto_clear`

Extension runner errors are emitted separately as:

```json
{
  "type": "extension_error",
  "extensionPath": "...",
  "event": "...",
  "error": "..."
}
```

`message_update` includes streaming deltas in `assistantMessageEvent` (text/thinking/toolcall deltas).

## Prompt/Queue Concurrency and Ordering

This is the most important operational behavior.

### Immediate ack vs completion

`prompt` and `abort_and_prompt` are **acknowledged immediately**:

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
```

That means:

- command acceptance != run completion
- agent turns complete via `agent_end`
- local-only prompts complete via `data.agentInvoked: false` on the response or via a later `prompt_result`

### While streaming

`AgentSession.prompt()` requires `streamingBehavior` during active streaming:

- `"steer"` => queued steering message (interrupt path)
- `"followUp"` => queued follow-up message (post-turn path)

If omitted during streaming, prompt fails.

### Queue defaults

From `packages/agent/src/agent.ts` defaults:

- `steeringMode`: `"one-at-a-time"`
- `followUpMode`: `"one-at-a-time"`
- `interruptMode`: `"immediate"`

### Mode semantics

- `set_steering_mode` / `set_follow_up_mode`
  - `"one-at-a-time"`: dequeue one queued message per turn
  - `"all"`: dequeue entire queue at once
- `set_interrupt_mode`
  - `"immediate"`: tool execution checks steering between tool calls; pending steering can abort remaining tool calls in the turn
  - `"wait"`: defer steering until turn completion

## Host tools

Registration commands:

- `set_host_tools` — explicit replace-all for host-owned tools.
- `add_host_tools` — incremental add/update.
- `remove_host_tools` — incremental removal.

Definitions may include side-effect/trust/display/deadline/size metadata:

```json
{
  "name": "lookup",
  "description": "Lookup data in the host",
  "parameters": { "type": "object", "properties": {}, "additionalProperties": false },
  "sideEffectClass": "none",
  "trustClass": "untrusted",
  "display": { "kind": "inline" },
  "defaultTimeoutMs": 30000,
  "maxResultBytes": 1048576,
  "maxUpdateBytes": 65536
}
```

Execution request:

```json
{
  "type": "host_tool_call",
  "id": "host_1",
  "toolCallId": "tool_1",
  "toolName": "lookup",
  "arguments": {},
  "metadata": { "sideEffectClass": "none", "trustClass": "untrusted" },
  "deadlineMs": 30000,
  "maxResultBytes": 1048576,
  "maxUpdateBytes": 65536
}
```

Host responses:

- `host_tool_update` for bounded streaming updates.
- `host_tool_result` for terminal success/error.
- `host_tool_cancel_ack` for requested cancellation acknowledgement or NAK.

Oversized updates/results and deadlines produce typed terminal failures.

## Host URIs

Registration commands:

- `set_host_uri_schemes` — explicit replace-all for host-owned schemes.
- `add_host_uri_schemes` — incremental add/update.
- `remove_host_uri_schemes` — incremental removal.

Reserved OMP schemes cannot be shadowed or cleared by normal host registration: `omp`, `agent`, `artifact`, `memory`, `local`, `vault`, `skill`, `rule`, `mcp`, `issue`, and `pr`.

Scheme definition fields include `writable`, `immutable`, `trustClass`, `defaultTimeoutMs`, `maxContentBytes`, `contentTypes`, `binary`, and `range`.

Read request:

```json
{
  "type": "host_uri_request",
  "id": "uri_1",
  "operation": "read",
  "url": "docs://guide?range=0-99",
  "range": { "start": 0, "end": 99, "unit": "byte" },
  "deadlineMs": 30000,
  "maxContentBytes": 1032192,
  "acceptsBase64": false
}
```

Write request includes `content` and `contentLength`. Host results may return `content`, `bytesBase64`, `contentType`, `contentLength`, `notes`, and `immutable`. Reads and writes enforce deadline and content limits before resolving.

For read-tool line selectors on range-capable schemes, OMP sends `range.unit: "line"` and marks the resolved resource as range-applied so local post-processing does not fetch or slice the full resource a second time. Schemes that do not declare `range: true` reject ranged reads with `host_uri_denied`.

## Extension UI

Every UI frame declares whether it expects a response:

- Event-only: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, `open_url`, `cancel` with `expectsResponse: false`.
- Request/response: `select`, `confirm`, `input`, `editor` with `expectsResponse: true`, `timeout` (default 30000 ms), and `responseSchema`; aborts and timeouts emit a paired `cancel` event before clearing pending state.

Responses:

```json
{ "type": "extension_ui_response", "id": "ui_1", "confirmed": true }
{ "type": "extension_ui_response", "id": "ui_2", "value": "text" }
{ "type": "extension_ui_response", "id": "ui_3", "cancelled": true, "timedOut": true }
```

Event-only frames do not create pending UI state. Timeout, abort, close, and explicit cancel clean pending state.

Runtime note:

- Automatic session title generation is disabled in RPC mode, and `setTitle` UI
  requests are also suppressed by default because most hosts do not have a
  meaningful terminal-title surface. Set `PI_RPC_EMIT_TITLE=1` to opt back in to
  the UI event only.

## Clients

TypeScript `RpcClient` exposes:

- raw-frame, unknown-frame, protocol-error, session-event, extension-error, and extension UI hooks
- protocol info/state helpers
- operation tracking: `waitForOperation`, `waitForIdle`, `cancelOperation`
- host tool serving: set/add/remove custom tools
- host URI serving: set/add/remove schemes and serve read/write requests
- close-time rejection for pending requests and waiters

Python `omp_rpc.RpcClient` preserves enriched/future metadata through raw frame listeners and parsed `raw` fields, supports host tools/URIs/UI, and remains backward-compatible with older direct-result servers while understanding operation terminal frames.

Unknown future frames are surfaced through raw/unknown hooks rather than silently dropped.

## Schema, fixtures, and compatibility

Schema artifact: `packages/coding-agent/src/modes/rpc/rpc.schema.json` and package export `@oh-my-pi/pi-coding-agent/modes/rpc/rpc.schema.json`. The schema root validates stdout protocol frames; inbound command and host/UI response shapes are available under `$defs` for embedders that validate stdin before sending.

Golden fixture: `packages/coding-agent/test/fixtures/rpc-golden-frames.jsonl`.

Compatibility policy:

- Existing frame names and legacy string `error` fields remain.
- Additive fields are allowed on all protocol objects.
- New capabilities should be advertised in `ready.capabilities` and `get_protocol_info`.
- Breaking removals require a protocol version bump and migration notes.

## Gateway and dashboard integration

Gateway runtimes should:

1. Launch OMP with deterministic arguments, usually `--mode rpc --no-title` and host-chosen session/model flags.
2. Read `ready.protocol`, `ready.capabilities`, and `get_protocol_info` for descriptors.
3. Treat prompt/follow-up/bash/compact/login terminal evidence as observed only after correlated terminal operation frames.
4. Classify failures using `errorInfo.code`, not string parsing.
5. Fail closed on malformed JSON, contradictory metadata, decreasing `seq`, or missing terminal frames.
6. Tolerate additive fields under the protocol compatibility policy.

Dashboard browser/React code should not own OMP stdio. A local backend owns the child process, raw frame log, ready negotiation, request/operation table, normalized state/message/session/task/host/UI models, restart policy, redaction, and authorization. See `docs/rpc-dashboard-backend.md`.
