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

## Transport

- **stdin**: commands, extension UI responses, host-tool updates/results/cancel ACKs, host URI results/cancel ACKs.
- **stdout**: `ready`, command `response`, protocol/session/operation/task/subagent/state frames, host-tool requests/cancels, host URI requests/cancels, extension UI requests, extension errors, `pong` health responses, and `shutdown`.
- **stderr**: diagnostics only; never parse it as protocol.

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
