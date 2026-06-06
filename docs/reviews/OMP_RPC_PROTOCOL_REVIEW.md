# OMP RPC Protocol Review for Dashboard and Agent Gateway

## Position

OMP RPC is already a useful embedding boundary: it is process-isolated, simple NDJSON over stdio, has a real event stream, exposes host tools and host URI schemes, and can drive sessions, models, thinking, compaction, bash, login, and task/subagent workflows.

The main weakness is not that it is stdio or not JSON-RPC. The main weakness is that the protocol has too few explicit guarantees. Embedders currently infer semantics from source shape, line order, and ad hoc frame contents. That is workable for one TypeScript helper, but it is fragile for two serious consumers:

1. A standalone dashboard that needs full-fidelity live UI, task/subagent rendering, session hydration, extension UI, host tools, and host URI handling.
2. `gateway-runtime-omp`, which needs source-verifiable capability evidence and must not over-claim runtime authority.

The right direction is an incremental `rpc v1.1` style hardening: keep NDJSON, keep existing frame names, but add protocol identity, capability negotiation, monotonic frame metadata, operation correlation, terminal operation events, first-class task/subagent frames, stronger error objects, and complete raw-frame client hooks.

## Sources reviewed

- `/Users/case/projects/external/oh-my-pi/docs/rpc.md`
- `/Users/case/projects/external/oh-my-pi/docs/sdk.md`
- `/Users/case/projects/external/oh-my-pi/docs/session.md`
- `/Users/case/projects/external/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `/Users/case/projects/external/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `/Users/case/projects/external/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-client.ts`
- `/Users/case/projects/external/oh-my-pi/packages/coding-agent/src/modes/rpc/host-tools.ts`
- `/Users/case/projects/external/oh-my-pi/packages/coding-agent/src/modes/rpc/host-uris.ts`
- `/Users/case/projects/external/oh-my-pi/packages/coding-agent/src/session/agent-session.ts`
- `/Users/case/projects/external/oh-my-pi/packages/agent/src/types.ts`
- `/Users/case/projects/external/oh-my-pi/packages/coding-agent/src/task/types.ts`
- `/Users/case/projects/agent-gateway/crates/gateway-runtime-omp/src/lib.rs`
- `/Users/case/projects/agent-gateway/crates/gateway-runtime-omp/src/rpc_lifecycle.rs`
- `/Users/case/projects/agent-gateway/crates/gateway-runtime-omp/tests/omp_rpc_lifecycle.rs`

## Current OMP RPC capability inventory

### Transport and launch

Facts:

- RPC mode is newline-delimited JSON over stdio, not JSON-RPC (`docs/rpc.md:1-9`).
- Accepted modes include `rpc` and `rpc-ui`; `rpc-ui` passes a UI context to tools and sets `PI_NO_PTY=1` (`docs/rpc.md:41-42`, `main.ts:809-810`, `main.ts:964-1065`).
- The first successful frame is exactly `{ "type": "ready" }` (`docs/rpc.md:49-50`, `rpc-mode.ts:173-181`).
- When stdin closes, pending host-tool and host-URI requests are rejected and the process exits 0 (`docs/rpc.md:51`, `rpc-mode.ts:858-861`).
- RPC modes apply built-in host-sensitive default overrides for todo, task, memory, async, and bash auto-background settings (`docs/rpc.md:47`, `main.ts:86-121`).

### Commands

The `RpcCommand` union supports:

- Prompt/control: `prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `new_session` (`rpc-types.ts:19-26`).
- State/host registration: `get_state`, `set_todos`, `set_host_tools`, `set_host_uri_schemes` (`rpc-types.ts:28-33`).
- Model/thinking: `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level` (`rpc-types.ts:34-41`).
- Queue modes: `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode` (`rpc-types.ts:43-46`).
- Compaction/retry/bash: `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash` (`rpc-types.ts:48-58`).
- Session/messages/login: session stats/export/switch/branch/handoff/messages/login (`rpc-types.ts:60-75`).

### Responses

- All command responses share `{ id?, type: "response", command, success, data? | error? }` (`docs/rpc.md:206-212`).
- `get_state` returns model, thinking, streaming, queue modes, session file/id/name, compaction, message counts, todos, system prompt, tools, and context usage (`docs/rpc.md:213-247`, `rpc-types.ts:81-101`, `rpc-mode.ts:519-543`).
- `prompt` and `abort_and_prompt` return immediate ACKs, not completion (`docs/rpc.md:306-332`, `rpc-mode.ts:473-507`).

### Events

Core events are from `AgentEvent`:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`

The source shape is in `packages/agent/src/types.ts:475-496`.

Session events extend the core event stream with compaction, retry, TTSR, todo, IRC, notice, thinking-level, and goal updates (`agent-session.ts:271-306`). RPC forwards session events directly via `session.subscribe(event => output(event))` (`rpc-mode.ts:459-462`).

### Extension UI

RPC has a UI sub-protocol with `extension_ui_request` and `extension_ui_response` for select, confirm, input, editor, cancel, notify, status, widget, title, editor text, and open URL (`docs/rpc.md:364-411`, `rpc-types.ts:219-264`, `rpc-mode.ts:211-437`).

Limitations in source are real and should be treated as protocol limitations:

- Raw terminal input unsupported.
- Working message, footer, header, custom UI, custom editor components, tool expansion, and theme switching unsupported or no-op.
- `getEditorText()` returns an empty string.
- Title emission is opt-in with `PI_RPC_EMIT_TITLE=1`.

### Host tools

RPC hosts can register tools with `set_host_tools`, receive `host_tool_call`, send `host_tool_update`, send `host_tool_result`, and handle `host_tool_cancel` (`docs/rpc.md:412-527`, `host-tools.ts:74-186`).

Useful qualities:

- Tool definitions are normalized and validated.
- Updates stream through `AgentToolUpdateCallback`.
- Cancellation is explicit.

Limitations:

- Re-registration replaces the entire host-owned tool set.
- No host-tool timeout/deadline in request frames.
- No backpressure/windowing.
- No explicit permission or trust boundary metadata.
- No binary/chunked result framing beyond JSON payloads.

### Host URI

RPC hosts can register virtual URI schemes, resolve reads, and handle full replacement writes (`docs/rpc.md:528-648`, `host-uris.ts:67-235`).

Limitations:

- `edit` does not target host URIs (`docs/rpc.md:530-532`).
- Writes are full replacement writes, not patches.
- Content is string-only with a small content-type union (`rpc-types.ts:343-362`).
- Re-registration replaces all host-owned schemes.
- No read/write deadlines or explicit max payload metadata.

### Task/subagent activity

Subagent activity is currently visible through ordinary tool execution frames for the `task` tool. The useful live shape is nested under `tool_execution_update.partialResult.details.progress[]` and final results under `tool_execution_end.result.details.results[]` (`task/types.ts:181-320`).

That is enough for a dashboard adapter, but it is not yet a first-class RPC concept.

## What `gateway-runtime-omp` currently does

`gateway-runtime-omp` is an evidence boundary, not a general OMP RPC client.

It currently:

- Defines source-verified descriptor facts for `get_state`, `prompt`, `follow_up`, and `abort` (`src/lib.rs:107-126`, `src/lib.rs:349-644`).
- Marks the OMP RPC protocol version as `0.0.0` because the ready frame exposes no protocol version (`src/lib.rs:92-105`).
- Declares prompt/follow-up/abort descriptors as `AckOnly` and `NoTerminalObservation` because RPC ACKs are not terminal completion (`src/lib.rs:389-456`, `src/lib.rs:458-644`).
- Uses a launch posture of `--mode rpc --no-session --no-title --no-extensions --no-skills --no-rules --no-lsp` with `PI_NOTIFICATIONS=off` (`rpc_lifecycle.rs:48-69`).
- Waits for `ready`, writes exactly one command, closes stdin by dropping the writer, waits for process exit, and classifies stdout/stderr into a report (`rpc_lifecycle.rs:2564-2812`, `rpc_lifecycle.rs:2883-3171`).
- Classifies frames with a fail-closed scanner rather than trusting typed DTOs (`rpc_lifecycle.rs:2161-2187`, `rpc_lifecycle.rs:3173-3231`).
- Treats unknown, malformed, and command-error frames as rejected evidence even if a later success appears (`tests/omp_rpc_lifecycle.rs:939-1004`, `tests/omp_rpc_lifecycle.rs:2070-2146`).

This is conservative and appropriate for a gateway. The gateway is not over-claiming terminal authority; it correctly treats current prompt/follow-up/abort RPC behavior as ACK-only.

The protocol, however, forces the gateway to be more brittle than it should be. Because there is no protocol version, feature advertisement, operation id, terminal event correlation, or schema contract, the gateway must anchor on parser-profile facts and raw frame classification instead of protocol-native authority.

## Shared pain points for dashboard and gateway

### 1. Ready frame has no protocol identity or capabilities

Current ready frame:

```json
{ "type": "ready" }
```

For the dashboard this means the backend must learn capabilities by source knowledge or follow-up commands.

For the gateway this forces `OMP_RPC_PROFILE_VERSION = 0.0.0` and descriptor matching based on source refs plus a parser profile (`gateway-runtime-omp/src/lib.rs:92-105`).

### 2. Command ACKs are not correlated to terminal outcomes

Current behavior is well documented: `prompt` and `abort_and_prompt` ACK scheduling, not completion (`docs/rpc.md:306-332`). Later scheduling failure can appear as another response with the same id (`docs/rpc.md:141-148`, `rpc-mode.ts:473-507`).

This is a major integration footgun:

- A dashboard cannot attach an ACK to a specific turn except by watching later uncorrelated event order.
- A gateway cannot claim terminal prompt/cancellation authority.
- A generic client promise resolves on ACK and has nowhere principled to send late failure except an ad hoc protocol-error path.

### 3. Events lack stable correlation metadata

Current agent events are line-ordered but do not consistently carry:

- stdout frame sequence number
- timestamp
- session id
- run id
- turn id
- operation id
- originating command id

The docs explicitly do not guarantee more than stdout line order (`docs/rpc.md:680-684`). That is not enough for a dashboard with reconnect/replay needs or a gateway that wants durable evidence.

### 4. Error frames are too stringly typed

Current failures use `success: false` plus string `error` (`docs/rpc.md:206-212`). Unknown-command responses intentionally use `id: undefined` even when the request included an id (`docs/rpc.md:141-144`, `rpc-mode.ts:797-800`). Parse/input-loop errors also use `id: undefined` (`rpc-mode.ts:853-855`).

This weakens both contexts:

- The dashboard cannot reliably associate errors to UI actions.
- The gateway must treat generic command errors as poison rather than typed evidence.
- Clients cannot branch on stable error codes.

### 5. The TypeScript `RpcClient` is not a complete protocol client

The docs already state this (`docs/rpc.md:659-678`). Source confirms:

- It dispatches only core `AgentEvent` types (`rpc-client.ts:82-112`, `rpc-client.ts:682-687`).
- It handles extension UI requests only through listeners (`rpc-client.ts:156`, `rpc-client.ts:670-674`).
- It supports host tools but not host URI serving (`rpc-client.ts:565-583`, `rpc-client.ts:733-800`).
- It drops unrecognized frames silently (`rpc-client.ts:653-687`).

For the dashboard, do not build on this helper as the central transport. For gateway-style evidence, it is also unsuitable because it hides raw frame evidence.

### 6. Task/subagent events are not first-class

The current task progress shape is rich and useful (`task/types.ts:181-320`), but it is embedded inside tool update/result details. A UI can parse it, but the protocol does not declare:

- a task run id
- parent/child subagent ids
- recursive tree relationships as first-class frame fields
- a stable task progress schema version
- whether child stdout/messages are available elsewhere

This is the most important UI-specific gap.

### 7. Session hydration is linear-message oriented

`get_messages` returns `AgentMessage[]` (`rpc-types.ts:199-200`, `rpc-mode.ts:727-729`). Session storage is actually a JSONL tree with entry ids, parent ids, branch summaries, compaction, labels, custom entries, and a mutable leaf pointer (`docs/session.md:50-89`, `docs/session.md:359-399`).

The dashboard can show a linear branch view, but it should not lose tree semantics. Current RPC does not expose enough structured session graph data.

### 8. Launch/reset posture is implicit

RPC mode applies host-sensitive default overrides (`main.ts:86-121`), but embedders learn this from docs/source, not from the protocol. Gateway hardcodes its own reset posture and limitations (`rpc_lifecycle.rs:48-69`, `src/lib.rs:374-376`, `src/lib.rs:439-443`).

A protocol-native reset profile would let the gateway claim exactly what the runtime reports and let the dashboard display what ambient features were disabled.

## Recommended OMP RPC refinements

### P0 — Add protocol identity and capability advertisement

Keep the first frame as `ready`, but enrich it:

```json
{
  "type": "ready",
  "protocol": {
    "name": "omp-rpc",
    "version": "1.1.0",
    "schemaVersion": 1
  },
  "server": {
    "packageName": "@oh-my-pi/pi-coding-agent",
    "packageVersion": "15.8.1",
    "pid": 12345
  },
  "mode": "rpc-ui",
  "capabilities": {
    "commands": ["get_state", "prompt", "follow_up", "abort"],
    "events": ["agent_start", "agent_end", "task_progress"],
    "extensionUi": true,
    "hostTools": true,
    "hostUris": true,
    "operationEvents": true,
    "frameMetadata": true
  },
  "resetProfile": {
    "name": "rpc-defaults",
    "settingOverrides": ["todo.enabled", "task.maxConcurrency", "async.enabled"]
  }
}
```

Also add `get_protocol_info` returning the same shape for clients that want to probe after ready.

Why it matters:

- Dashboard can feature-detect instead of source-detect.
- Gateway can replace `0.0.0` protocol identity with real protocol authority.
- Both can distinguish `rpc` from `rpc-ui` without launch-side inference.

Backward compatibility:

- Existing clients ignore extra ready fields.
- New clients can prefer enriched ready, fallback to `get_state`/source assumptions.

### P0 — Add frame metadata: `seq`, `timestamp`, `sessionId`

Every stdout frame should optionally include:

```json
{
  "seq": 42,
  "timestamp": "2026-06-05T12:00:00.000Z",
  "sessionId": "..."
}
```

For command responses, also include the original request id as today. For events, include whichever of `operationId`, `runId`, `turnId`, `messageId`, and `toolCallId` apply.

Why it matters:

- Dashboard can order, dedupe, and reconnect/replay more safely.
- Gateway can retain deterministic evidence with native sequence facts instead of only line ordinal.
- Future HTTP/WebSocket bridges can preserve OMP ordering explicitly.

Backward compatibility:

- Additive fields only.

### P0 — Introduce operation ids and terminal operation events

Prompt/control commands should ACK with an operation id:

```json
{
  "id": "req_1",
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": {
    "ack": "accepted",
    "operationId": "op_123",
    "turnId": "turn_456",
    "queued": false
  }
}
```

Then emit terminal frames:

```json
{ "type": "operation_start", "operationId": "op_123", "command": "prompt", "turnId": "turn_456" }
{ "type": "operation_end", "operationId": "op_123", "status": "completed", "turnId": "turn_456" }
```

Failure:

```json
{
  "type": "operation_error",
  "operationId": "op_123",
  "command": "prompt",
  "error": { "code": "streaming_behavior_required", "message": "streamingBehavior is required while streaming" }
}
```

Why it matters:

- Dashboard can show per-prompt lifecycle without guessing from global `agent_end`.
- Gateway can add a terminal-observation capability when it sees `operation_end`.
- Late scheduling failures stop being ambiguous duplicate command responses.

Backward compatibility:

- Keep the existing ACK response.
- Add `data.operationId` and emit operation events only when supported.
- Existing clients still complete by `agent_end`.

### P0 — Make error responses typed and correlated

Change response errors from string-only to a typed object while preserving `error` string for compatibility:

```json
{
  "id": "req_2",
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: provider/model",
  "errorInfo": {
    "code": "model_not_found",
    "message": "Model not found: provider/model",
    "details": { "provider": "provider", "modelId": "model" }
  }
}
```

Also improve correlation:

- Unknown command should echo `id` when the parsed object had an `id`.
- Parse errors should echo `id` when the line parsed to an object with a string `id` but failed command validation.
- Truly malformed JSON can remain an uncorrelated protocol error.

Why it matters:

- Dashboard can put the error on the initiating button/message.
- Gateway can classify failure modes precisely.
- Clients can implement recoverable behavior without string parsing.

Backward compatibility:

- Keep existing `error` string.
- Add `errorInfo`.
- Echoing ids is a behavior improvement; clients that ignored ids are unaffected.

### P1 — Add first-class task/subagent progress frames

Keep current `task` tool `partialResult.details.progress[]` for existing renderers, but also emit dedicated frames:

```json
{
  "type": "task_progress",
  "toolCallId": "toolu_...",
  "taskRunId": "taskrun_...",
  "parentAgentId": "root",
  "agents": [
    {
      "id": "child-a",
      "parentId": "root",
      "index": 0,
      "agent": "explore",
      "status": "running",
      "description": "Map source files",
      "currentTool": "read",
      "recentOutput": ["..."],
      "tokens": 42,
      "contextTokens": 1000,
      "contextWindow": 200000
    }
  ]
}
```

And terminal:

```json
{
  "type": "task_result",
  "toolCallId": "toolu_...",
  "taskRunId": "taskrun_...",
  "results": []
}
```

Why it matters:

- Dashboard gets stable subagent rendering without spelunking arbitrary tool details.
- Gateway can declare task/subagent observation as a separate capability.
- External clients can react to subagents without knowing the `task` tool internals.

Backward compatibility:

- Continue emitting current tool update/result frames.
- Add new frames under a capability flag.

### P1 — Add raw-frame complete client hooks

The TypeScript `RpcClient` should not remain a lossy helper. Add:

```ts
onFrame(listener: (frame: unknown) => void): () => void;
onProtocolError(listener: (error: RpcProtocolError) => void): () => void;
onSessionEvent(listener: (event: AgentSessionEvent) => void): () => void;
setHostUriSchemes(...): Promise<string[]>;
serveHostUri(...): Promise<void>;
```

Do not remove `onEvent`; keep it as the core-agent-event convenience path.

Why it matters:

- Dashboard backend could use the package helper without losing session-level events.
- Gateway-style clients can retain raw evidence.
- Extension errors, host URI requests, notice/todo/goal events, and future frames stop disappearing.

### P1 — Expose a protocol schema artifact

Generate and ship one or both:

- `rpc.schema.json` for command/response/frame unions.
- `rpc-protocol.d.ts` / package export dedicated to protocol-only types.

This should include schema versions for:

- command frames
- response frames
- event frames
- task progress/result frames
- extension UI requests/responses
- host tool/URI frames

Why it matters:

- Rust gateway can generate or validate typed protocol bindings.
- Dashboard backend can validate raw frames without importing all OMP runtime internals.
- Protocol changes become visible contract changes.

### P1 — Add state-change frames and stronger session hydration

Add `state_changed` frames after stateful commands and significant session changes:

```json
{
  "type": "state_changed",
  "stateSeq": 12,
  "changed": ["model", "thinkingLevel", "todoPhases", "queuedMessageCount"],
  "state": { "...": "same shape as get_state or a patch" }
}
```

Add session graph commands:

```json
{ "id": "entries_1", "type": "get_session_entries", "range": { "limit": 500 } }
{ "id": "tree_1", "type": "get_session_tree" }
```

Return entry ids, parent ids, leaf id, entry type, timestamps, message summaries, compaction markers, branch summaries, labels, and custom entries.

Why it matters:

- Dashboard can render branch/session state honestly.
- Gateway can observe session state and branch mutations explicitly.
- `get_messages` remains the simple linear branch view.

### P1 — Add launch/reset profile introspection

Expose effective reset/default posture in `ready` and `get_state`:

```json
{
  "resetProfile": {
    "name": "rpc-defaults",
    "ambientUserConfigApplied": false,
    "overrides": [
      { "path": "memory.backend", "source": "rpc-default", "valueKind": "default" }
    ]
  }
}
```

Why it matters:

- Gateway descriptors can stop hardcoding `OmpRpcDefaultResets` from source-only facts.
- Dashboard can show why memory/task/todo/async behavior differs from terminal UI.

### P2 — Add one-shot probe mode for capability evidence

Gateway currently launches a full process, waits for ready, writes one command, closes stdin, and waits for exit (`rpc_lifecycle.rs:2564-2812`). That is correct but unnecessarily complex.

Add one of:

```bash
omp --mode rpc --rpc-one-shot get_state
```

or

```json
{ "id": "req", "type": "shutdown_after", "command": { "type": "get_state" } }
```

The output should be:

```json
{ "type": "ready", ... }
{ "id": "req", "type": "response", "command": "get_state", "success": true, "data": {} }
{ "type": "shutdown", "reason": "one_shot_complete" }
```

Why it matters:

- Gateway probes become shorter, less race-prone, and easier to prove.
- The ordinary persistent RPC mode stays unchanged.

### P2 — Strengthen host tool and host URI contracts

Host tool refinements:

- Add `deadlineMs` or `timeoutMs` to `host_tool_call`.
- Add optional `metadata` to registered tools: trust level, side-effect class, display hints.
- Add incremental registration commands: `add_host_tools`, `remove_host_tools`.
- Add explicit cancellation ACK from host or server.
- Add chunked/binary result support for large payloads.

Host URI refinements:

- Add content length/max size expectations.
- Support binary/base64 content explicitly.
- Support partial reads or range requests.
- Support patch/edit operations only if OMP can enforce safe semantics.
- Add incremental scheme registration.

### P2 — Clarify extension UI expectations per method

Add `expectsResponse` or split fire-and-forget frames from request/response frames:

```json
{ "type": "extension_ui_request", "id": "ui_1", "method": "confirm", "expectsResponse": true }
{ "type": "extension_ui_event", "method": "notify", "message": "..." }
```

This avoids treating status/notify/title frames like pending requests.

## Interface guidance for the standalone dashboard

Use a local backend as the OMP owner:

```text
React/Tauri UI
  <-> HTTP command API + SSE/WebSocket event stream
local backend
  <-> OMP NDJSON stdio RPC
omp --mode rpc-ui
```

Do not make React own stdio. Do not use the current `RpcClient` helper as the central transport unless it gains raw-frame/session-event/host-URI support.

Backend responsibilities:

1. Spawn `omp --mode rpc-ui`.
2. Wait for `ready`; parse enriched ready if available, otherwise fallback to current assumptions.
3. Maintain a raw frame router that never silently drops unknown frames.
4. Maintain a command table keyed by request id.
5. Treat prompt ACK as accepted/scheduled, never as completion.
6. Track operation/turn ids if available; otherwise infer current turn from event order.
7. Register and serve host tools/URIs explicitly.
8. Normalize OMP frames into dashboard-owned events.
9. Preserve raw frames in metadata for unsupported renderers.
10. Hydrate state with `get_state` and messages with `get_messages`; add session tree support when OMP exposes it.

Frontend responsibilities:

1. Consume dashboard-owned normalized parts, not raw OMP frames.
2. Render task/subagent activity from first-class `task_progress` when available, fallback to `tool_execution_update.partialResult.details.progress[]`.
3. Render final task results from `task_result` when available, fallback to `tool_execution_end.result.details.results[]`.
4. Keep extension UI, host tool, host URI, and state panels separate from message rendering.
5. Keep operation state distinct from message state.

## Interface guidance for `gateway-runtime-omp`

The current gateway posture is correct: conservative, fail-closed, ACK-only where the protocol only ACKs.

Recommended changes after RPC hardening:

1. Use enriched `ready.protocol.version` instead of `0.0.0` when available.
2. Use `ready.capabilities` / `get_protocol_info` to build descriptors instead of source-only command facts.
3. Add terminal prompt capability descriptors only when `operation_end` is present and correlated to prompt operations.
4. Add `RuntimeObservation` evidence for `operation_error` / typed error codes.
5. Add task/subagent observation descriptors when first-class `task_progress` frames are present.
6. Stop treating all unknown frames as poison only when protocol capability negotiation says frame metadata is present and unknown frames are namespaced/ignorable. Until then, keep fail-closed behavior.
7. Prefer one-shot probe mode if OMP adds it; otherwise keep the ready-gated one-command process probe.

Non-protocol gateway note: `DEFAULT_OMP_RPC_EXECUTABLE` is currently an absolute workstation path (`rpc_lifecycle.rs:11-12`). That may be acceptable as local evidence, but production gateway configuration should accept/discover the executable path rather than baking one user path into a reusable runtime crate.

## Compatibility plan

### Step 1: Additive metadata

- Enrich `ready`.
- Add `seq`, `timestamp`, `sessionId` to frames.
- Add `errorInfo` while preserving `error`.
- Echo ids for unknown parsed commands.

No existing client should break.

### Step 2: Add operation lifecycle

- Add operation ids to prompt/control ACK response data.
- Emit `operation_start`, `operation_end`, and `operation_error`.
- Keep `agent_end` as the traditional completion event.

Dashboard can use operation events immediately. Gateway can add new descriptors guarded by capability detection.

### Step 3: Add first-class task/subagent frames

- Emit `task_progress` and `task_result` in addition to existing tool update/result details.
- Add schema/version field for task progress.

Dashboard migrates renderers to the first-class frames. Existing clients continue parsing tool details.

### Step 4: Add session graph and state changes

- Add `state_changed`.
- Add `get_session_entries` and/or `get_session_tree`.

Dashboard can stop flattening session history. Gateway can observe branch/session mutation facts.

### Step 5: Upgrade helper clients

- Add `onFrame`, `onSessionEvent`, `onProtocolError`, and host URI helpers to TypeScript `RpcClient`.
- Consider a Rust protocol crate or generated schema bindings for gateway use.

## What not to change

- Do not replace NDJSON stdio just to look standard. It is good for process isolation and cross-language embedding.
- Do not switch to JSON-RPC unless there is a concrete interop requirement. The current frame model is fine if it gets metadata and schemas.
- Do not remove immediate ACK semantics. ACK is useful; it just needs an operation id and terminal events.
- Do not make task/subagent rendering depend on full child transcript streaming. Task progress is a good summary channel; make it first-class.

## Ranked request list

1. Enriched `ready` with protocol version, server version, capabilities, mode, and reset profile.
2. Frame metadata: `seq`, `timestamp`, `sessionId`, plus operation/turn ids where applicable.
3. Operation lifecycle events for prompt/control commands.
4. Typed, correlated errors with `errorInfo` and better id echoing.
5. First-class `task_progress` / `task_result` frames.
6. Complete raw-frame `RpcClient` hooks and host URI helper support.
7. `state_changed` plus session graph hydration commands.
8. Launch/reset profile introspection in `get_state`.
9. One-shot probe mode for gateway capability evidence.
10. Host tool/URI deadline, incremental registration, chunking, and cancellation ACK refinements.
