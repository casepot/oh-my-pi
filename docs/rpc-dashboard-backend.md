# RPC Dashboard Backend Integration Guide

A dashboard must treat OMP RPC as a local child-process protocol owned by a backend service. Browser or React UI code must not spawn OMP or parse raw stdio directly.

## Ownership boundary

Backend owns:

- OMP child process lifecycle and cwd/env/session/model launch policy
- stdin writer, stdout NDJSON reader, stderr diagnostics
- raw frame log for replay/debugging/future renderers
- ready negotiation and protocol/capability capture
- request table and operation table
- normalized state, message, session graph, task/subagent, host tool, host URI, and extension UI models
- cancellation, shutdown, restart, heartbeat/ping health checks
- redaction of paths, secrets, prompts, tool output, and host payloads before browser delivery
- user authorization for all side-effecting actions

Browser/React UI owns:

- presentation
- user gestures routed to backend API calls
- incremental rendering of normalized models
- opt-in views of redacted raw frames

## Startup sequence

1. Spawn `omp --mode rpc-ui --no-title` plus host-selected session/model/tool arguments.
2. Read the first stdout frame and require `type === "ready"`, `protocol.name === "omp-rpc"`, and monotonic `seq === 1`.
3. Persist the raw ready frame.
4. Call `get_protocol_info`; compare protocol/server/mode/capabilities/limits/reset/security with ready.
5. Initialize backend models from `get_state`, `get_messages`, `get_session_entries`, `get_session_tree`, and `get_observable_sessions` when capabilities advertise them.
6. Start normal command dispatch.

If ready is missing, malformed, contradictory, or has a lower-than-expected protocol version, fail closed and expose stderr/raw-frame evidence to operators.

## Raw frame log

Store every stdout frame before normalization:

```ts
type RawFrameRecord = {
  receivedAt: string;
  seq: number;
  frame: unknown;
};
```

Use the raw log for support bundles, replay, forward-compatible renderers, and gateway evidence. Do not rely on raw frames as the browser state model.

## Normalized models

Recommended backend stores:

- `protocol`: ready/get_protocol_info facts and capability booleans
- `state`: latest `get_state`/`state_changed.state`, keyed by `stateSeq`
- `operations`: operation id, command, request id, status, started/ended timestamps, errorInfo, terminal data refs
- `messages`: current-branch linear messages from `get_messages`
- `sessionGraph`: entries/tree/leaf/current branch with refs for large content
- `tasks`: `task_progress`, `task_result`, `subagent_lifecycle`, `observable_session_update`
- `hostTools`: registered definitions, pending calls, deadlines, bounded update/result previews
- `hostUris`: registered schemes, pending reads/writes, deadlines, content refs
- `extensionUi`: pending response-required requests and event-only notification/status/widget/title/editor events

All normalized records should preserve `seq`, `timestamp`, and `sessionId` provenance.

## Operation table

Commands such as `prompt`, `follow_up`, `abort_and_prompt`, `compact`, `bash`, `handoff`, and `login` are complete only after terminal operation frames.

- Command response with `ack: "accepted"` creates or links an operation row.
- `operation_start` moves the row to running.
- Exactly one `operation_end` or `operation_error` closes the row.
- Missing terminal frames on process exit are backend-classified as `peer_closed`.
- UI "done" indicators must use terminal operation frames, not ACK responses.

## Extension UI

Event-only frames (`expectsResponse: false`) must not enter the pending request table. Response-required frames (`expectsResponse: true`) must include timeout and response schema; backend should reject/cancel pending UI on timeout, explicit cancel, operation cancel, or process close.

## Host tools and URIs

Backend may expose host tools and URI schemes to OMP, but must bound memory and authority:

- Use `add_*`/`remove_*` for incremental changes; use `set_*` only for explicit replace-all.
- Honor `deadlineMs`, max result/update/content sizes, and cancellation frames.
- Store large outputs as backend artifacts and return refs/chunks where available instead of pushing unbounded JSON to the browser.
- Never let users register OMP-reserved URI schemes (`artifact`, `skill`, `rule`, `mcp`, `issue`, `pr`, etc.) without an OMP-owned privileged path.

## Fallback for older OMP

Older OMP builds may lack operation/task/session graph frames. A backend may degrade as follows:

- If `ready.capabilities.operationEvents !== true`, treat ACK-only long commands as indeterminate and require a manual/timeout policy; do not claim terminal evidence.
- If `sessionGraph !== true`, use `get_messages` for the current branch only.
- If `taskEvents !== true`, render task tool output as ordinary tool events without nested subagent reconstruction.
- If typed errors are absent, classify as `internal_error` unless the host intentionally opts into legacy string parsing.

Fallbacks must be explicit in UI and logs.
