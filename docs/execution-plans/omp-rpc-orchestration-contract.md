# OMP RPC Orchestration Contract Execution Plan

## Objective

Make OMP RPC an orchestration-grade local embedding protocol for serious external hosts: dashboards, gateway runtimes, IDEs, supervisors, and larger agent orchestration systems.

The target is not a generic internet RPC service. The target is a world-class, process-isolated, local stdio control plane for OMP that is explicit enough for other systems to build on without reading OMP source or reverse-engineering incidental frame order.

When this plan is complete, OMP RPC should be stable enough that an external runtime can launch OMP, inspect the protocol contract, drive agent work, observe terminal outcomes, render task/subagent state, serve host tools and virtual resources, persist evidence, and recover from malformed or slow peers without relying on undocumented behavior.

## Completed-State Claims

After completion, we should be able to claim all of the following without caveats beyond the stated scope boundaries:

1. **Versioned protocol contract**
   - OMP RPC advertises a protocol name, protocol version, schema version, server version, mode, effective reset profile, limits, and capabilities at startup.
   - A host can make feature decisions from `ready` or `get_protocol_info`, not from source-code knowledge.

2. **Deterministic frame stream**
   - Every stdout frame has monotonic sequence metadata, timestamp, and session identity.
   - Frames are ordered, deduplicable, and suitable for durable evidence logs and replay.
   - Unknown future frames are either explicitly ignorable by namespace/capability rules or surfaced as typed protocol warnings/errors.

3. **Correlated command lifecycle**
   - Commands always produce a correlated response when the input was parseable enough to contain an id.
   - Long-running commands return an acceptance ACK plus an `operationId` and then emit correlated terminal operation frames.
   - A host can distinguish "accepted for execution" from "completed", "cancelled", "failed", or "rejected".

4. **Interruptible control plane**
   - The RPC input loop remains responsive while prompts, bash commands, compaction, login, extension UI, host tools, or other long operations are running.
   - Cancellation, host-tool results, host-URI responses, and extension UI responses are processed promptly and are not blocked behind an awaited command handler.

5. **Typed errors and validation**
   - Failures expose stable error codes, human-readable messages, and structured details.
   - Clients no longer need string parsing for normal recovery or gateway evidence classification.
   - Malformed input, unknown commands, invalid arguments, timeout, cancellation, closed-peer, and internal errors have distinct codes.

6. **Session and state are first-class**
   - `get_state` is a complete snapshot of current RPC-visible state.
   - `state_changed` frames describe material state changes with a monotonic `stateSeq`.
   - Session hydration exposes both the simple linear message branch and the underlying session entry graph: entry ids, parent ids, leaf id, branch labels, compaction markers, summaries, and custom entries.

7. **Task/subagent orchestration is first-class**
   - Task and subagent activity is not only hidden inside tool-renderer details.
   - RPC emits versioned `task_progress`, `task_result`, and subagent lifecycle frames that preserve parent/child relationships, status, current tool activity, summaries, bounded previews, and result references.
   - Dashboards and supervisors can render nested agent work without depending on private `task` tool internals.

8. **Host tools and host URIs are robust extension surfaces**
   - Host tool calls and host URI requests carry correlation ids, deadlines, size expectations, cancellation semantics, and side-effect/trust metadata.
   - Registration can be incremental and does not accidentally remove unrelated registrations.
   - Built-in URI schemes cannot be overwritten or unregistered by a host unless an explicit privileged override is enabled.
   - Large payloads have bounded, chunked, or reference-based paths instead of unbounded JSON blobs.

9. **Extension UI is explicit and safe**
   - Fire-and-forget UI events are distinct from request/response UI interactions.
   - Every request that expects a response declares that expectation, timeout, and result schema.
   - Login, URL opening, status/notify/title, editor/input/select/confirm, and cancellation are typed consistently across TypeScript and Python clients.

10. **Client libraries are complete enough for production embedders**
    - The TypeScript client has raw-frame hooks, protocol-error hooks, session-event hooks, host-URI serving, extension UI responders, operation tracking, and close-time rejection of pending requests.
    - The Python client preserves future protocol metadata and stays schema-compatible with TypeScript.
    - Rust/gateway consumers can validate or generate protocol types from a shipped schema artifact.

11. **Gateway-runtime-OMP can make stronger evidence claims**
    - The gateway can report the OMP RPC protocol version and capabilities from OMP itself.
    - It can classify prompt/follow-up/abort as terminally observed only when correlated operation terminal frames are present.
    - It can retain fail-closed parsing while no longer treating ordinary additive metadata as protocol poison.

12. **Dashboard architecture has a clean ownership boundary**
    - A local backend owns the OMP child process and raw NDJSON stream.
    - UI clients consume backend-normalized operation, message, state, task, host, and extension-UI models.
    - Raw OMP frames remain available for debugging and unsupported future renderers.

13. **Resilience is engineered, not incidental**
    - Payload limits, line limits, partial-frame limits, stdout backpressure handling, graceful shutdown, heartbeat/health frames, deadline handling, and closed-peer behavior are specified and tested.
    - A slow, malicious, or buggy host cannot cause unbounded memory growth through partial lines or oversized frames.

14. **Conformance is testable across languages**
    - OMP ships keyless protocol tests, golden frame fixtures, schema validation tests, cross-language TypeScript/Python compatibility tests, and gateway-facing contract tests.
    - Protocol changes are visible in schema/version updates and are not hidden inside renderer or helper-client behavior.

## Scope and Ownership Boundaries

### In scope

- The OMP RPC protocol over stdio NDJSON.
- The `rpc` and `rpc-ui` modes in `packages/coding-agent`.
- The RPC type model, server dispatcher, frame writer, command handlers, host-tool bridge, host-URI bridge, extension UI bridge, and helper clients.
- Documentation, schema artifacts, examples, and compatibility guidance.
- External embedding expectations for dashboards and `gateway-runtime-omp`.
- Local process resilience: malformed input, slow peers, cancellation, backpressure, bounded memory, and graceful shutdown.

### Out of scope

- Replacing stdio NDJSON with JSON-RPC, HTTP, WebSocket, gRPC, or a remote service protocol.
- Treating OMP RPC as a multi-tenant internet-facing security boundary.
- A centralized distributed scheduler for multiple OMP processes.
- Full child transcript streaming for every subagent by default.
- Guaranteeing that every internal TUI affordance has an RPC equivalent.
- Making host-provided tools or URI schemes trusted by default.

### Ownership boundaries

- **OMP owns** protocol frames, command semantics, event semantics, local process lifecycle, schema artifacts, built-in capabilities, default reset profile reporting, and compatibility policy.
- **Host applications own** process spawning policy, user authorization, UI layout, durable host-side storage, host tool implementations, host URI backing stores, and any remote/network exposure layered above local RPC.
- **Gateway runtimes own** their evidence posture. OMP provides enough protocol facts to avoid source inference, but gateways still choose fail-open/fail-closed behavior.
- **Dashboards own** normalized UI models. OMP provides high-fidelity source frames; dashboards should not require React or browser code to parse raw stdio.

## Design Principles

1. **Keep the transport boring**
   - NDJSON over stdio is appropriate for local process isolation.
   - Improve guarantees before changing transports.

2. **Protocol over source inference**
   - Anything an embedder must rely on belongs in `ready`, `get_protocol_info`, schema, docs, or emitted frames.

3. **Additive compatibility first**
   - Existing frame names remain valid.
   - Existing response strings remain present where clients may depend on them.
   - New fields and frames are capability-gated where needed.

4. **ACK is not completion**
   - Immediate ACK semantics are useful and should remain.
   - Completion is represented by terminal operation frames.

5. **Every async thing has identity**
   - Operations, turns, messages, tools, host requests, UI requests, tasks, subagents, and session mutations have stable ids where external systems may observe or act on them.

6. **No silent drops**
   - Servers do not silently swallow parseable command ids.
   - Clients do not silently drop unknown frames, session events, extension UI errors, or protocol errors.

7. **Bounded previews, durable references**
   - Frames carry enough summary for live UI.
   - Large content moves through artifacts, host URI references, or chunking rather than unbounded JSON payloads.

8. **Trust is explicit**
   - Host tools, host URIs, bash, login, file paths, session mutation, and extension UI actions expose their authority and side-effect class.

9. **Conformance beats examples**
   - Examples are useful, but schema, golden frames, and cross-language tests define the contract.

## Target Protocol Shape

### Ready frame

The first successful stdout frame remains `ready`, but it becomes authoritative:

```json
{
  "type": "ready",
  "seq": 1,
  "timestamp": "2026-06-05T12:00:00.000Z",
  "sessionId": "session_abc",
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
    "commands": ["get_state", "prompt", "follow_up", "abort", "bash"],
    "events": ["operation_start", "operation_end", "state_changed", "task_progress"],
    "frameMetadata": true,
    "operationEvents": true,
    "typedErrors": true,
    "stateChanges": true,
    "sessionGraph": true,
    "taskEvents": true,
    "extensionUi": true,
    "hostTools": true,
    "hostUris": true,
    "chunkedPayloads": false
  },
  "limits": {
    "maxFrameBytes": 1048576,
    "maxPartialLineBytes": 1048576,
    "maxHostToolResultBytes": 4194304,
    "maxHostUriContentBytes": 4194304,
    "defaultOperationTimeoutMs": null
  },
  "resetProfile": {
    "name": "rpc-defaults",
    "ambientUserConfigApplied": true,
    "settingOverrides": [
      { "path": "todo.enabled", "source": "rpc-default", "valueKind": "boolean" },
      { "path": "task.maxConcurrency", "source": "rpc-default", "valueKind": "number" }
    ]
  }
}
```

Add `get_protocol_info` returning the same protocol/server/mode/capabilities/limits/reset-profile object for reconnecting clients and post-ready probes.

### Frame metadata

Every stdout frame includes these additive fields:

```ts
type RpcFrameMetadata = {
  seq: number;
  timestamp: string;
  sessionId: string | null;
};
```

Additional correlation fields appear when applicable:

```ts
type RpcCorrelation = {
  requestId?: string;
  operationId?: string;
  turnId?: string;
  messageId?: string;
  toolCallId?: string;
  taskRunId?: string;
  subagentId?: string;
  hostRequestId?: string;
  uiRequestId?: string;
  stateSeq?: number;
};
```

Keep top-level fields rather than wrapping every frame in a new envelope. That preserves existing frame readability and minimizes migration cost.

### Response and error model

A response remains:

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

Required error code families:

- `invalid_json`
- `invalid_frame`
- `invalid_command`
- `unknown_command`
- `invalid_arguments`
- `unsupported_capability`
- `operation_not_found`
- `operation_cancelled`
- `operation_timeout`
- `peer_closed`
- `host_tool_not_found`
- `host_tool_timeout`
- `host_tool_failed`
- `host_uri_scheme_not_found`
- `host_uri_denied`
- `host_uri_too_large`
- `extension_ui_timeout`
- `model_not_found`
- `session_not_found`
- `internal_error`

Correlation rules:

- If JSON parsing fails completely, emit an uncorrelated `protocol_error` frame or response with no id.
- If JSON parses to an object with a string `id`, echo that id even when command validation fails.
- Unknown commands echo parsed ids.
- Late async failures for accepted commands emit `operation_error`; they do not emit a second command response with the same id.

### Operation lifecycle

Commands that schedule or perform work with observable duration return ACK plus `operationId`:

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

Operation frames:

```json
{
  "type": "operation_start",
  "operationId": "op_123",
  "command": "prompt",
  "requestId": "req_1",
  "turnId": "turn_456"
}
```

```json
{
  "type": "operation_end",
  "operationId": "op_123",
  "command": "prompt",
  "status": "completed",
  "requestId": "req_1",
  "turnId": "turn_456"
}
```

```json
{
  "type": "operation_error",
  "operationId": "op_123",
  "command": "prompt",
  "requestId": "req_1",
  "turnId": "turn_456",
  "errorInfo": {
    "code": "streaming_behavior_required",
    "message": "streamingBehavior is required while streaming"
  }
}
```

Statuses:

- `completed`
- `failed`
- `cancelled`
- `rejected`
- `superseded`
- `peer_closed`

Commands that should become operations:

- `prompt`
- `follow_up`
- `abort_and_prompt`
- `compact`
- `bash`
- login flows that wait on provider/browser/user activity
- future long-running session import/export/handoff work

Add `cancel_operation` for operation-scoped cancellation. Keep legacy `abort` and `abort_bash` as convenience/global controls, but represent their effects through operation terminal frames where possible.

### Dispatcher architecture

The server should split parsing from command execution:

```text
stdin reader
  -> frame parser and validator
  -> dispatcher
       control lane: cancel_operation, abort, abort_bash, extension_ui_response, host_tool_result, host_uri_response
       command lane: prompt, follow_up, compact, bash, session commands
       registration lane: host tools, host URIs, settings
       query lane: get_state, get_protocol_info, messages/session queries
  -> operation manager
  -> frame writer with backpressure
```

Required invariants:

1. The stdin reader does not await long-running command bodies.
2. Control-lane frames are handled while any operation is running.
3. Host-tool results and host-URI responses are never blocked behind the original command that requested them.
4. Extension UI responses are never blocked behind a command waiting on extension UI.
5. Frame writes respect stdout backpressure.
6. Closed stdin triggers graceful shutdown: reject pending host/UI/operation promises with `peer_closed`, emit final shutdown frame when possible, then exit cleanly.

## Layer-by-Layer Work Plan

### P0: Protocol identity, framing, and lifecycle

#### 1. Add protocol metadata

Implementation:

- Introduce a single protocol-info builder in RPC mode.
- Include protocol/server/mode/capabilities/limits/resetProfile in `ready`.
- Add `get_protocol_info` command.
- Document that extra ready fields are additive and safe for old clients.

Acceptance criteria:

- A keyless test launches RPC and asserts enriched `ready` shape.
- A keyless test sends `get_protocol_info` and asserts it matches ready protocol/capability facts.
- Existing ready-only clients can still detect `type: "ready"`.

#### 2. Add frame writer metadata

Implementation:

- Centralize all RPC stdout writes behind one frame writer.
- Add monotonic `seq`, ISO timestamp, and current session id to every frame.
- Preserve existing fields and frame names.
- Ensure errors and extension/host frames also pass through the same writer.

Acceptance criteria:

- Golden frame tests prove `seq` is strictly increasing.
- No direct RPC stdout JSON writes bypass the writer.
- Tests cover ready, response, agent event, host-tool call, host-URI request, extension UI request, protocol error, and shutdown/warning frames.

#### 3. Add typed errors and correlated validation

Implementation:

- Define `RpcErrorInfo` and error-code enum/type.
- Convert command handlers to return/throw structured RPC errors.
- Preserve existing `error` string in failed responses.
- Echo parseable request ids for invalid or unknown commands.
- Emit `protocol_error` frames for malformed JSON and uncorrelated transport failures.

Acceptance criteria:

- Unknown-command test with id returns same id and `errorInfo.code = "unknown_command"`.
- Invalid-arguments test with id returns same id and `errorInfo.code = "invalid_arguments"`.
- Malformed JSON test emits uncorrelated `protocol_error` and does not crash.
- Gateway scanner fixtures classify typed errors without string parsing.

#### 4. Introduce operation manager

Implementation:

- Add an operation registry with `operationId`, command, request id, status, start/end timestamps, cancellation controller, and optional turn/tool/session ids.
- Return `operationId` from long-running command ACKs.
- Emit `operation_start`, `operation_end`, and `operation_error`.
- Move late scheduling failures out of duplicate command responses.
- Add `cancel_operation`.

Acceptance criteria:

- Prompt returns ACK plus operation id before terminal completion.
- Prompt emits exactly one terminal operation frame.
- A rejected prompt emits a failed response before operation creation, or an `operation_error` after accepted operation creation, never duplicate responses for the same request.
- Cancellation emits terminal `operation_end` or `operation_error` with cancellation code.

#### 5. Refactor dispatcher for responsiveness

Implementation:

- Make the input loop enqueue or dispatch without awaiting long operations.
- Give cancellation, host responses, URI responses, and UI responses a priority/control path.
- Ensure `bash` no longer blocks `abort_bash` from being read.
- Ensure extension UI response can arrive while a command awaits UI.

Acceptance criteria:

- Test starts a long bash operation, sends `abort_bash`, and observes cancellation without waiting for bash to finish naturally.
- Test starts a prompt or fake operation that requests extension UI, sends response, and observes completion.
- Test starts a host tool call and sends host result while the originating operation is pending.
- No command handler can deadlock waiting for a frame that the input loop cannot read.

### P1: State, session, and orchestration fidelity

#### 6. Add state sequence and state-change events

Implementation:

- Add `stateSeq` to `get_state`.
- Increment `stateSeq` on material state changes.
- Emit `state_changed` with changed keys and either a snapshot or compact patch.
- Include active operations and resetProfile in state.

Acceptance criteria:

- Changing model, thinking level, compaction settings, todos, queue modes, and session branch emits state changes.
- `get_state.stateSeq` matches the latest observed state change.
- Dashboard clients can rebuild current state from ready + get_state + state_changed.

#### 7. Expose session graph hydration

Implementation:

- Keep `get_messages` as linear current-branch compatibility API.
- Add `get_session_entries` with range/pagination/filter support.
- Add `get_session_tree` for entry relationships and current leaf.
- Include entry id, parent id, timestamp, role/type, summary/preview, branch label, compaction marker, and custom-entry metadata.
- Return large message content by reference when configured limits require it.

Acceptance criteria:

- A branched session can be reconstructed from RPC graph data.
- Linear `get_messages` still returns the current branch.
- Compacted or summarized entries remain visible as graph nodes instead of disappearing into a flat transcript.

#### 8. Add first-class task and subagent frames

Implementation:

- Continue existing `tool_execution_update.partialResult.details.progress[]` and final task details.
- Add versioned `task_progress` frames.
- Add `task_result` frames.
- Add subagent lifecycle frames if they are cleaner than overloading `task_progress` for births/deaths.
- Use stable `taskRunId`, `subagentId`, `parentSubagentId`, `toolCallId`, and `operationId` where available.
- Keep previews bounded and expose refs for larger child outputs/transcripts.

Example:

```json
{
  "type": "task_progress",
  "schemaVersion": 1,
  "operationId": "op_123",
  "toolCallId": "toolu_abc",
  "taskRunId": "taskrun_1",
  "agents": [
    {
      "id": "subagent_a",
      "parentId": null,
      "index": 0,
      "agentType": "explore",
      "description": "Map RPC files",
      "status": "running",
      "currentTool": "read",
      "preview": "Reading rpc-mode.ts",
      "tokens": 1234,
      "contextTokens": 5000,
      "contextWindow": 200000
    }
  ]
}
```

Acceptance criteria:

- Dashboard can render nested subagents without parsing task tool internals.
- Existing TUI/tool details remain unchanged.
- Recursive subagent relationships are represented explicitly.
- Final task results carry stable ids and bounded summaries with references for full output.

#### 9. Expose observable sessions for dashboards

Implementation:

- Connect existing observable-session/subagent registry concepts to RPC through explicit frames/queries.
- Add `get_observable_sessions` for current root/child session summaries.
- Emit `observable_session_update` when child sessions start, update status, complete, or become available for inspection.

Acceptance criteria:

- A dashboard can show active root and child sessions independent of message rendering.
- Child session identities line up with task/subagent ids where both exist.

### P1: Host extension surfaces

#### 10. Harden host tools

Implementation:

- Add incremental `add_host_tools` and `remove_host_tools`; keep `set_host_tools` as replace-all.
- Add registered metadata: side-effect class, trust class, display hints, input/output size hints, timeout defaults.
- Add `deadlineMs` or absolute deadline to `host_tool_call`.
- Add host cancellation ACK/NAK.
- Define result size handling: inline below limit, chunk/reference above limit.
- Ensure host tool updates are bounded and correlated.

Acceptance criteria:

- Re-registering one host tool does not accidentally remove another unless using `set_host_tools`.
- Deadline expiration produces typed terminal failure.
- Host cancellation outcome is observable.
- Oversized results are rejected with `host_tool_too_large` or moved through the configured large-payload path.

#### 11. Harden host URIs

Implementation:

- Reserve built-in schemes: `omp`, `agent`, `artifact`, `memory`, `local`, `vault`, `skill`, `rule`, `mcp`, `issue`, `pr`, and future OMP-owned schemes.
- Deny host override/unregister of reserved schemes by default.
- Track previous handlers if privileged override is ever allowed, and restore them on clear.
- Add incremental scheme registration/removal.
- Add read/write deadlines, max payloads, content length, content type, binary/base64 option, and range reads.
- Keep full replacement write as the default; add patch/edit only when safe semantics are enforceable.

Acceptance criteria:

- A host cannot shadow `artifact://` or `skill://` by accident.
- Clearing host schemes cannot remove built-in handlers.
- URI reads/writes respect size and deadline limits.
- Python and TypeScript host URI helpers are schema-compatible.

#### 12. Clarify extension UI protocol

Implementation:

- Split request/response interactions from fire-and-forget UI events, or add `expectsResponse` to every UI frame.
- Type all methods consistently across server, TypeScript client, and Python client, including `open_url` and login-related methods.
- Add UI request timeout and cancellation semantics.
- Expose public responder APIs in clients.

Acceptance criteria:

- Notify/status/title/open-url events do not create dangling pending request state.
- Select/confirm/input/editor requests declare response schema and timeout.
- Python and TypeScript clients accept the same UI method union.

### P1: Client and schema parity

#### 13. Publish protocol schema artifacts

Implementation:

- Generate or maintain `rpc.schema.json` for command, response, and notification/frame unions.
- Export protocol-only TypeScript types without requiring full runtime imports.
- Include schema version in the protocol info.
- Add a small compatibility guide for additive and breaking protocol changes.

Acceptance criteria:

- Golden fixtures validate against schema.
- TypeScript protocol types and JSON schema agree.
- Rust/gateway can consume the schema or generated bindings without importing OMP runtime internals.

#### 14. Upgrade TypeScript RpcClient

Implementation:

- Add raw `onFrame` hook.
- Add `onProtocolError`, `onSessionEvent`, `onUnknownFrame`, and `onExtensionError` hooks.
- Keep `onEvent` as a narrowed convenience for core agent events.
- Add host URI serving.
- Add extension UI responder API.
- Add operation tracking helpers.
- Reject all pending requests promptly on close, not only after timeouts.
- Fix idle tracking so callers can wait for already-active and future operations without edge-trigger races.

Acceptance criteria:

- Unknown frame is observable, not dropped.
- Session-level events are observable through client API.
- Host URI requests round-trip through the TypeScript client.
- Pending request promises reject immediately when child exits.
- Idle waiting is deterministic under concurrent operations.

#### 15. Upgrade Python client parity

Implementation:

- Preserve enriched ready metadata instead of narrowing it away.
- Add missing state fields such as context usage and reset profile.
- Add missing extension UI methods, including `open_url`.
- Keep enum handling future-compatible by preserving unknown values where safe.
- Add login helper parity where protocol commands exist.
- Add exact raw-frame callback for evidence consumers.

Acceptance criteria:

- Shared golden frames parse in both TypeScript and Python clients.
- Python does not crash or drop valid future metadata from enriched ready/state/UI frames.
- Python host tool and host URI helpers remain compatible with server schema.

### P2: Gateway and dashboard enablement

#### 16. Add one-shot probe mode

Implementation:

Support one of these forms:

```bash
omp --mode rpc --rpc-one-shot get_state
```

or:

```json
{ "id": "req", "type": "shutdown_after", "command": { "type": "get_state" } }
```

Required output:

```json
{ "type": "ready", "protocol": { "name": "omp-rpc", "version": "1.1.0" } }
{ "id": "req", "type": "response", "command": "get_state", "success": true, "data": {} }
{ "type": "shutdown", "reason": "one_shot_complete" }
```

Acceptance criteria:

- Gateway can probe protocol info and a single command without relying on stdin-close side effects.
- Persistent RPC mode remains unchanged.
- One-shot mode has deterministic shutdown status.

#### 17. Define dashboard backend contract

Implementation:

Document and provide example backend responsibilities:

```text
React/Tauri or web UI
  <-> dashboard-owned HTTP/SSE/WebSocket API
local dashboard backend
  <-> OMP NDJSON stdio RPC
omp --mode rpc-ui
```

Backend owns:

- process spawn/restart
- ready/capability negotiation
- raw frame log
- request/operation table
- normalized state cache
- normalized message/session graph cache
- normalized task/subagent cache
- host tool service
- host URI service
- extension UI routing
- authorization and redaction for any remote UI

Acceptance criteria:

- Docs make clear that React/browser code should not own raw stdio.
- Backend model separates operations, messages, state, tasks, host surfaces, and extension UI.
- Fallback behavior is specified for older OMP versions without operation/task/session graph frames.

#### 18. Update gateway-runtime-OMP integration guidance

Implementation:

- Gateway reads `ready.protocol.version` and capabilities.
- Gateway builds descriptors from protocol facts where available.
- Gateway only declares terminal prompt/follow-up/abort observation when operation terminal frames are present.
- Gateway keeps fail-closed parsing for malformed frames.
- Gateway treats unknown additive metadata according to protocol namespace/capability rules.
- Gateway executable path becomes configurable/discoverable rather than hardcoded to a workstation path.

Acceptance criteria:

- Gateway reports real OMP RPC version when available.
- Gateway can produce evidence for operation terminal outcomes.
- Gateway still refuses malformed or contradictory frame streams.

### P2: Resilience, limits, and observability

#### 19. Add stream and payload limits

Implementation:

- Enforce maximum frame bytes.
- Enforce maximum partial-line bytes while reading stdin.
- Enforce maximum outbound inline payload bytes per frame category.
- Add structured `transport_warning` and `protocol_error` frames where safe.
- Add chunk/reference mechanism for large payload categories selected in capabilities.

Acceptance criteria:

- Oversized inbound frames are rejected deterministically.
- Unterminated partial lines cannot grow memory without bound.
- Oversized outbound host/tool/session payloads use reference/chunk path or fail with typed error.

#### 20. Add heartbeat and graceful shutdown semantics

Implementation:

- Add optional `heartbeat` frames or `ping`/`pong` commands.
- Add `shutdown` frame with reason when OMP exits intentionally.
- On stdin close, reject pending operations with typed `peer_closed` where feasible.
- On child process termination, clients reject pending promises immediately.

Acceptance criteria:

- Clients can distinguish graceful one-shot completion, stdin close, cancellation, and crash.
- Dashboard can mark transport health without sending work commands.

#### 21. Add security profile reporting

Implementation:

Expose effective authority profile in ready/state:

- enabled command categories
- tool allowlist or disabled tools
- host tool permission mode
- host URI allowed schemes and reserved schemes
- bash availability and cwd/root policy
- session mutation availability
- login/provider availability
- extension enablement
- redaction policy summary

Acceptance criteria:

- A dashboard can display what authority the current OMP process has.
- Gateway evidence can include security/reset posture facts from the protocol.
- Disabling extensions, skills, rules, LSP, session persistence, or bash is visible without source inference.

## Compatibility and Migration Plan

### Stage 1: Additive metadata

- Enrich `ready`.
- Add `get_protocol_info`.
- Add frame `seq`, `timestamp`, and `sessionId`.
- Add `errorInfo` while preserving `error`.
- Echo ids for parseable invalid/unknown command frames.

Expected client impact: no breakage for clients that ignore unknown fields.

### Stage 2: Lifecycle and dispatcher

- Add operation ids and terminal operation frames.
- Refactor dispatcher for non-blocking control-plane responsiveness.
- Add `cancel_operation`.

Expected client impact: old clients keep ACK/event behavior; new clients use operation lifecycle.

### Stage 3: State and orchestration visibility

- Add `state_changed`.
- Add session graph queries.
- Add task/subagent frames.
- Add observable session frames/queries.

Expected client impact: dashboards can migrate from private tool details to first-class frames while preserving fallback parsing.

### Stage 4: Host and UI hardening

- Add host tool/URI deadlines, metadata, incremental registration, and size handling.
- Protect reserved URI schemes.
- Clarify extension UI request/event semantics.

Expected client impact: old `set_host_tools` and `set_host_uri_schemes` remain; new clients prefer incremental APIs and stronger metadata.

### Stage 5: Schemas, clients, gateway, dashboard

- Publish protocol schema artifacts.
- Upgrade TypeScript and Python clients.
- Add gateway integration support.
- Add dashboard backend guidance and examples.

Expected client impact: protocol consumers have stable generated/validated contracts.

## Verification Plan

### Keyless server protocol tests

Add tests that do not require provider credentials:

- launch emits enriched ready
- get_protocol_info matches ready
- frame sequence monotonicity
- typed error for malformed JSON
- typed error and id echo for invalid command
- typed error and id echo for unknown command
- get_state includes stateSeq, resetProfile, capabilities, limits
- state-changing commands emit state_changed
- one-shot probe emits ready/response/shutdown

### Operation lifecycle tests

- prompt/follow_up/abort_and_prompt ACK includes operation id
- operation_start precedes terminal frame
- operation_end emitted exactly once for success
- operation_error emitted exactly once for accepted async failure
- cancel_operation cancels the correct operation
- global abort maps to affected operation terminal state
- bash can be aborted while running
- extension UI response unblocks pending UI operation
- host tool result unblocks pending host call

Use fake or deterministic seams where provider calls would otherwise be required; do not add credential-dependent protocol tests for basic lifecycle semantics.

### Task/subagent tests

- task tool still emits existing details
- RPC emits task_progress/task_result for the same run
- nested subagent ids and parent ids are stable
- previews are bounded
- full outputs are available by reference where configured

### Host tool and host URI tests

- incremental host tool add/remove
- replace-all semantics remain explicit for set_host_tools
- host tool deadline failure
- host tool cancellation ACK/NAK
- oversized host tool result handling
- reserved URI scheme cannot be overridden
- clearing host schemes preserves built-ins
- host URI deadline and size failures
- host URI range read where supported

### Client conformance tests

- Shared golden frame fixtures parse in TypeScript and Python.
- Unknown future frames are surfaced, not silently dropped.
- Enriched ready metadata is preserved.
- Extension UI method unions match.
- TypeScript client rejects pending requests on close.
- TypeScript idle/operation waiters do not race.
- Python preserves unknown enum values where compatibility requires it.

### Gateway contract tests

- Gateway reads protocol version from ready.
- Gateway builds capabilities from ready/get_protocol_info.
- Gateway only claims terminal operations when operation terminal frames exist.
- Gateway classifies typed operation errors.
- Gateway keeps fail-closed behavior for malformed or contradictory streams.
- One-shot probe path works when available.

### Stream resilience tests

- maximum frame size enforced
- maximum partial line size enforced
- slow writer/reader does not deadlock normal shutdown
- stdout backpressure path does not reorder frames
- closed stdin rejects pending host/UI/operation promises
- shutdown frame reason is emitted for intentional shutdown

### Documentation and schema checks

- `docs/rpc.md` examples match schema.
- Schema fixtures validate.
- Changelog entries describe protocol-visible changes.
- Compatibility notes explain fallback behavior for old clients.

## Documentation Deliverables

Update or add:

- `docs/rpc.md`
  - versioned protocol contract
  - ready/get_protocol_info
  - metadata and ordering guarantees
  - operation lifecycle
  - typed errors
  - state/session/task frames
  - host tool/URI hardening
  - extension UI semantics
  - limits and shutdown behavior

- `docs/sdk.md`
  - client APIs for raw frames, operation tracking, session events, host URI serving, and extension UI responses

- `docs/session.md`
  - RPC session graph hydration mapping

- protocol schema artifact
  - `rpc.schema.json` or equivalent generated artifact
  - protocol-only TypeScript export

- dashboard integration guide
  - local backend ownership model
  - normalized event model
  - fallback strategy for older RPC versions

- gateway integration guide or notes
  - evidence claims by protocol version/capability
  - fail-closed parsing guidance
  - one-shot probe guidance

## Risks and Required Guardrails

1. **Accidental breaking changes**
   - Guardrail: additive fields first; golden fixtures for old and new frames; keep compatibility response strings.

2. **Protocol types drift from docs**
   - Guardrail: schema fixtures and docs examples validated in tests.

3. **Client helpers remain lossy**
   - Guardrail: raw-frame tests and unknown-frame tests for TypeScript and Python.

4. **Dispatcher refactor creates races**
   - Guardrail: targeted concurrency tests for bash abort, host tool result, host URI response, extension UI response, and close handling.

5. **Task frames duplicate too much internal detail**
   - Guardrail: expose stable orchestration facts and bounded previews; keep implementation-specific details behind refs.

6. **Host URI scheme override causes authority bugs**
   - Guardrail: reserved scheme registry and tests proving built-ins survive host registration/clear.

7. **Large frame handling regresses UX**
   - Guardrail: document limits, provide reference/chunk path, and test both inline and oversized behavior.

8. **Gateway over-claims new authority**
   - Guardrail: gateway descriptors must be capability-gated and terminal-observation claims require operation terminal frames.

## Definition of Done

This plan is complete when:

1. `omp --mode rpc` emits enriched `ready`, supports `get_protocol_info`, and writes metadata on every frame.
2. Parseable request failures are correlated and typed.
3. Long-running commands have operation ids and terminal operation frames.
4. The RPC input loop remains responsive during long-running operations.
5. `get_state`, `state_changed`, session graph queries, and reset/security profile reporting expose the state embedders need.
6. Task/subagent activity has first-class versioned frames in addition to existing tool details.
7. Host tools, host URIs, and extension UI have explicit deadlines/cancellation/size/authority semantics.
8. Built-in URI schemes cannot be accidentally shadowed or removed by host registration.
9. TypeScript and Python clients preserve raw frames and expose complete protocol surfaces needed by dashboards and evidence consumers.
10. A schema artifact and golden fixtures define the protocol contract.
11. Gateway-runtime-OMP can replace source-inferred protocol version/capability facts with OMP-reported facts and can claim terminal operation observation only when supported.
12. A dashboard backend can be built against documented ownership boundaries and fallback behavior.
13. Keyless protocol, client conformance, gateway contract, host extension, dispatcher responsiveness, and stream resilience tests pass.
14. `docs/rpc.md`, SDK docs, and integration guidance match the implemented schema and behavior.

## Final Intended Shape

OMP RPC remains a small local stdio protocol, but it becomes explicit enough to serve as the foundation for larger orchestration systems.

The final shape is:

```text
host application / dashboard / gateway
  owns policy, UI, persistence, authorization, process spawn
  talks NDJSON over stdio

OMP RPC server
  advertises protocol/capabilities/limits/reset profile
  validates commands and emits typed correlated responses
  manages operations with terminal lifecycle events
  streams ordered metadata-bearing events
  exposes state/session/task/subagent facts
  brokers host tools, host URIs, and extension UI safely
  enforces limits and graceful shutdown

OMP agent runtime
  remains the implementation owner for model turns, tools, sessions, tasks, compaction, login, bash, and internal events
```

That boundary is the point: OMP stays focused on being an excellent local agent runtime, while external systems get a complete, robust, evidence-friendly control plane for building orchestration above it.