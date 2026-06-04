# Eval Runtime Orchestrator Execution Plan

## Objective

Build an eval runtime orchestrator and session manager that lets agents pass useful parent eval state into recursive subagents without sharing live interpreter ownership.

The desired user/agent experience:

```python
records = load("artifact://session-records")
summary = summarize(records)
packet = handoff(vars=["records", "summary"])

results = parallel_settled([
    lambda: agent("Review evidence sufficiency", state=packet, agent_type="reviewer"),
    lambda: agent("Find ceremony and bloat risks", state=packet, agent_type="reviewer"),
])
```

Child agents should be able to write:

```python
records = state.records
summary = state.summary
```

But child `eval(reset=True)`, timeout, crash, or shutdown must never kill or corrupt the parent eval kernel that is orchestrating the fanout.

## Problem Statement

The current failure mode is caused by inherited live eval session identity:

1. Parent Python eval cell runs `parallel_settled([... agent(...) ...])`.
2. Eval-spawned subagents inherit the parent's eval session id.
3. A child calls `eval(reset=True)`.
4. Reset shuts down the shared Python kernel.
5. Parent orchestration frame dies before it can return settled results.

The root issue is not eval, recursive spawning, or state transfer. The root issue is treating a live interpreter process as shared cross-agent state.

## Design Principle

Parent state should cross into children as explicit handoff data, not as shared live kernel ownership.

- Parent and child may share data.
- Parent and child must not share interpreter process authority by default.
- State handoff is a snapshot plus URI-backed references and grants.
- Reset/shutdown/cancellation operate on owned runtimes only.

This follows the useful lesson from `~/projects/subagents`: each agent has an isolated V8 sandbox/session, while coordination crosses runtime-owned primitives such as spawn, channels, outputs, services, signals, and explicit access grants.

## Definitions

### RuntimeOrchestrator

Host-owned subsystem responsible for:

- agent runtime ownership;
- eval kernel lifecycle;
- spawn-tree cancellation;
- state export/import;
- artifact and URI access grants;
- active-run and reset guards;
- structured event/diagnostic logging.

### AgentSession

A reasoning actor in the spawn tree. Owns:

- transcript/session file;
- tool capabilities;
- child sessions;
- cancellation scope;
- artifact/output grants;
- an `EvalSessionGroup`.

### EvalSessionGroup

Per-agent container for language runtimes:

```text
EvalSessionGroup(agentSessionId)
  ├─ RuntimeSession(language="py", generation=N)
  └─ RuntimeSession(language="js", generation=N)
```

### RuntimeSession

A concrete executable state container:

- Python kernel process, or
- JS VM/runtime context.

It is owned by exactly one `AgentSession` and one language.

### RuntimeGeneration

Monotonic counter incremented on reset. Each run binds to a generation. Late completions from older generations are stale and ignored/reported.

### EvalRun

One eval tool execution or backend cell execution. Carries:

- `runId`;
- `cellIndex` / `cellTitle`;
- `agentSessionId`;
- `runtimeSessionId`;
- `language`;
- `generation`;
- `abortSignal`;
- output/artifact sinks;
- status and failure metadata.

### HandoffPacket

Immutable manifest describing state exported from one agent and granted to another.

### StateEntry

One named value/ref inside a packet: JSON, text, URI ref, artifact blob, dataframe, module ref, etc.

### AccessGrant

Capability allowing a child agent/session to read, hydrate, or forward a packet/entry/ref.

## Required Invariants

1. **One runtime owner**
   - A runtime session belongs to exactly one agent session.

2. **No implicit live kernel inheritance**
   - Subagents do not inherit parent eval session id by default.

3. **Explicit cross-agent state**
   - State crosses agents through handoff packets, artifacts, URI refs, context, task results, or future channels.

4. **Owner-local reset**
   - `reset=True` affects only the caller agent's runtime session.

5. **Active-run guard**
   - Reset/shutdown must reject or queue when the target runtime has an active run. Default: reject with actionable error.

6. **One active run per runtime session**
   - No interleaved mutable eval executions within the same runtime session by default.

7. **Snapshot semantics**
   - Handoffs are snapshots at spawn/export time. Parent mutations after spawn are invisible unless explicitly exported again.

8. **URI access is grant-checked**
   - A URI identifies data. It does not by itself grant authority.

9. **Large data is URI-backed**
   - Small values copy inline. Large or typed data becomes immutable artifact-backed state.

10. **Everything is inspectable**
    - Eval output should show what state was passed, how it was stored, and how a child can hydrate it.

## User-Facing API

### Python Parent

```python
packet = handoff(
    vars=["records", "summary"],
    refs={"rules": "skill://gateway-prove-durable-evidence"},
)

result = agent(
    "Analyze the records and rules",
    state=packet,
    agent_type="reviewer",
)
```

Convenience shorthand:

```python
result = agent("Analyze df and summary", state=["df", "summary"])
```

Explicit value/ref form:

```python
result = agent(
    "Review this release",
    state={
        "summary": summary,
        "records": export_state("records", records),
        "plan": "local://docs/execution-plans/eval-runtime-orchestrator.md",
    },
)
```

### Python Child

```python
state.keys()
state.info("records")
records = state.records          # lazy hydration
summary = state.summary
rules = state.read("rules")
path = state.materialize("records", as_path=True)
```

Forwarding to grandchildren:

```python
grandchild_state = state.forward("records", "summary")
agent("Check edge cases", state=grandchild_state)
```

### JS Parent

```ts
const packet = await handoff({
  vars: ["records", "summary"],
  refs: { rules: "skill://gateway-prove-durable-evidence" },
});

const result = await agent("Analyze the records and rules", {
  state: packet,
  agentType: "reviewer",
});
```

### JS Child

```ts
const records = await state.get("records");
const summary = await state.get("summary");
const rules = await state.read("rules");
const path = await state.materialize("records", { asPath: true });
```

### URI Helpers

Provide parity in Python and JS:

```text
read(uri)        -> text
load(uri)        -> typed/object load using metadata
as_path(uri)     -> materialized local path
output(value)    -> stored value URI/ref
handoff(...)     -> handoff packet
hydrate(uri)     -> hydrated packet/state object
```

## Handoff Packet Data Model

Packet URI:

```text
eval-handoff://<packetId>
```

Entry URI:

```text
eval-state://<packetId>/<entryId>
```

Manifest shape:

```json
{
  "schemaVersion": "1.0",
  "packetId": "handoff_abc",
  "createdAt": "2026-06-03T00:00:00.000Z",
  "createdBy": {
    "agentSessionId": "agent_parent",
    "evalRunId": "py_run_123",
    "language": "py",
    "cellIndex": 0,
    "cellTitle": "Design fanout",
    "cwd": "/repo"
  },
  "policy": {
    "defaultHydration": "lazy",
    "copyInlineMaxBytes": 65536,
    "preferReferenceAboveBytes": 1048576,
    "gcClass": "session"
  },
  "entries": {
    "summary": {
      "kind": "json",
      "serializer": "omp.json.v1",
      "storage": { "mode": "inline", "inline": "..." },
      "contentHash": "sha256:...",
      "sizeBytes": 2048,
      "bindings": { "py": "summary", "js": "summary" },
      "hydration": { "lazy": true, "mutable": false }
    },
    "records": {
      "kind": "dataframe",
      "serializer": "omp.parquet.v1",
      "storage": { "mode": "blob", "blobUri": "artifact://..." },
      "contentHash": "sha256:...",
      "sizeBytes": 1234567,
      "preview": { "rowCount": 12000, "columns": ["id", "status"] },
      "bindings": { "py": "records", "js": "records" },
      "hydration": { "lazy": true, "mutable": false, "materializeAs": "native" }
    },
    "rules": {
      "kind": "uri",
      "serializer": "omp.uri.v1",
      "storage": { "mode": "reference", "refUri": "skill://gateway-prove-durable-evidence" },
      "bindings": { "py": "rules_uri", "js": "rulesUri" },
      "hydration": { "lazy": true, "materializeAs": "text" }
    }
  },
  "grants": [
    {
      "subjectAgentSessionId": "agent_child",
      "scope": "packet",
      "capabilities": ["readManifest", "readEntry", "hydrate"],
      "createdAt": "2026-06-03T00:00:00.000Z"
    }
  ],
  "index": {
    "entryCount": 3,
    "totalBytes": 1236615
  },
  "manifestHash": "sha256:..."
}
```

## Serialization Rules

| Value kind | Default transfer |
|---|---|
| small JSON-safe value | inline copy |
| large JSON-safe value | artifact JSON / JSONL |
| text | inline if small; artifact if large |
| bytes | artifact |
| pandas dataframe | parquet/arrow artifact if available |
| table-like data | parquet/arrow/JSONL fallback |
| file path | URI/path ref unless copy requested |
| URI | grant and pass ref |
| simple module helper | module/file URI |
| simple function | later phase only, source-based if safe |
| open file/socket/process/db connection | not transferable |

Unsafe escape hatches such as pickle must require explicit opt-in:

```python
handoff(vars=["model"], serializers={"model": "pickle"}, unsafe=True)
```

Pickle is never automatic.

## Function and Helper Handoff

### Phase 1

Only file/module references:

```python
packet = handoff(refs={"helpers": "local://analysis_helpers.py"})
```

### Phase 2

Allow simple source-exported functions only when all conditions hold:

- `inspect.getsource()` works;
- no hidden non-serializable closure state;
- imports/dependencies are declared or discoverable;
- child bootstrap can execute the source safely.

Failure example:

```text
Cannot hand off function score_candidate: it closes over non-serializable value db_conn.
Move it to a module or pass db_conn-derived data explicitly.
```

## Lifecycle

### Spawn With State

1. Parent eval calls `agent(..., state=spec)`.
2. Runtime resolves `spec` into a `HandoffPacket`:
   - selected variables;
   - explicit values;
   - URI refs;
   - artifacts;
   - serializers.
3. Runtime stores packet manifest and blobs.
4. Runtime grants child access to packet entries.
5. Runtime creates child `AgentSession`.
6. Child receives isolated `EvalSessionGroup`.
7. Child prelude exposes `state` object.
8. Child hydrates entries lazily on access.

### Child Reset

1. Child calls eval with `reset=True`.
2. Session manager verifies caller owns child runtime.
3. If child runtime idle, generation increments and child runtime resets.
4. Parent runtime is untouched.
5. Handoff packet remains available and can be rehydrated.

### Active Run Reset Conflict

If runtime has an active run:

```text
Python reset refused: runtime py:<id> has active run py-run-...
owner: agent-session <id>
recovery: wait for active eval, cancel it, or start a fresh isolated runtime
```

### Parent Cancellation

1. Parent cancellation aborts descendant cancellation scopes.
2. Child runtimes receive abort.
3. Child artifacts/grants are cleaned according to lifetime policy.
4. Parent runtime is cancelled only by parent-owned cancellation.

### Child Failure

1. Child failure returns structured failure to parent.
2. Parent `parallel_settled()` receives a rejected entry.
3. Parent runtime remains alive.

## Failure Taxonomy

### `StateExportError`

Raised when parent cannot export selected state.

Fields:

- key;
- runtime;
- value type;
- serializer attempted;
- reason;
- recovery.

### `StateHydrationError`

Raised when child cannot hydrate state.

Fields:

- key;
- packet URI;
- entry URI;
- missing dependency/grant/hash mismatch;
- recovery.

### `RuntimeOwnershipError`

Raised when reset/shutdown targets a runtime owned by another agent.

### `ActiveRunError`

Raised when reset/shutdown conflicts with an active run.

### `StateGrantError`

Raised when child lacks permission to read a packet/entry/ref.

## Observability

Parent eval output should include a compact handoff summary:

```text
State handoff eval-handoff://handoff_abc granted to reviewer:
- records: dataframe, 12k rows, artifact://..., lazy
- summary: json, 2KB, inline
- rules: skill://gateway-prove-durable-evidence, text ref
```

Child eval output should show hydration failures with actionable detail:

```text
Failed to hydrate state.records:
- packet: eval-handoff://handoff_abc
- entry: records
- serializer: parquet
- artifact: artifact://...
- cause: missing pyarrow
- recovery: install pyarrow, export as JSONL, or call state.materialize('records', as_path=True)
```

Every event should carry:

- `agentSessionId`;
- `runtimeSessionId`;
- `generation`;
- `runId`;
- `cellIndex` / `cellTitle`;
- parent/child causal ids;
- packet/grant ids where applicable.

## Performance Strategy

Do not optimize by sharing live kernels. Use safer optimizations:

1. Lazy hydration.
2. Content-addressed artifact dedupe.
3. Warm exclusive kernel pools.
4. Prelude/import cache per fresh runtime image.
5. Serializer cache based on content hash.
6. Materialize-as-path for large data.
7. Handoff previews instead of full transcript payloads.

## Implementation Plan

### P0: Stop unsafe kernel inheritance

1. Remove default `parentEvalSessionId` inheritance into subagents.
2. Give each `AgentSession` its own eval session group.
3. Keep artifact/context/session-file sharing unchanged.
4. Add owner-local reset/shutdown checks.
5. Add active-run reset guard.
6. Add regression:
   - parent Python eval runs `parallel_settled([agent(...)])`;
   - child uses `eval(reset=True)`;
   - parent does not return Python kernel shutdown;
   - parent receives fulfilled/rejected settled result;
   - parent kernel remains usable afterward.

Expected touchpoints:

- `packages/coding-agent/src/eval/agent-bridge.ts`
- `packages/coding-agent/src/task/executor.ts`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/eval/py/executor.ts`
- `packages/coding-agent/src/eval/py/kernel.ts`
- `packages/coding-agent/src/tools/eval.ts`

### P1: Minimal state handoff

1. Add `state` parameter to eval `agent()` in Python and JS.
2. Support inline JSON-safe values.
3. Support URI refs with child read grants.
4. Add `state` object in child preludes.
5. Add `read/load/as_path/hydrate` helpers for URI-backed entries.
6. Add handoff summary to eval result/status events.

Expected touchpoints:

- `packages/coding-agent/src/eval/py/prelude.py`
- `packages/coding-agent/src/eval/js/shared/prelude.txt`
- `packages/coding-agent/src/eval/js/shared/helpers.ts`
- `packages/coding-agent/src/eval/agent-bridge.ts`
- new handoff manager module under `packages/coding-agent/src/eval/state/`
- internal URL router for `eval-handoff://` and `eval-state://`

### P2: Artifact-backed serializers

1. Add content-addressed blob storage for handoff entries.
2. Add JSON/JSONL/text/bytes serializers.
3. Add dataframe serializer:
   - parquet/arrow when available;
   - JSONL fallback;
   - no pickle by default.
4. Add manifest previews.
5. Add hash verification on hydrate.
6. Add access grant table.

### P3: Ergonomics

1. Add `handoff(vars=[...], refs={...}, values={...})` helper.
2. Add shorthand `agent(..., state=["df", "summary"])`.
3. Add `state.forward(...)` for recursive spawning.
4. Add `state.info(...)`, `state.keys()`, `state.ref(...)`.
5. Add clear prompt/tool docs with examples.

### P4: Function/module handoff

1. Support module/file refs first.
2. Add simple source-based function export only with strict safety checks.
3. Reject closures/native handles with actionable errors.

### P5: Optional explicit shared sessions

Only if a real workflow requires it:

```python
agent(..., eval_session="shared:name")
```

Constraints:

- explicit opt-in;
- reset disabled;
- serialized execution;
- transcript-visible shared session id;
- strong owner/run diagnostics.

Do not implement this before isolated handoff works.

## Tests

### Safety tests

- Child `eval(reset=True)` cannot kill parent eval fanout.
- Child Python timeout/crash cannot kill parent runtime.
- Child JS reset cannot mutate parent JS state.
- Reset while same-agent run is active returns `ActiveRunError`.
- Runtime ownership mismatch returns `RuntimeOwnershipError`.

### Handoff tests

- Small JSON value copies into child.
- URI ref grants child read access.
- Child without grant cannot hydrate packet.
- Parent mutation after spawn is not visible to child.
- Child reset can rehydrate state after reset.
- `state.forward(...)` grants grandchild only selected entries.

### Serializer tests

- Text/JSON/JSONL round-trip.
- Large object becomes artifact, not prompt payload.
- Hash mismatch fails closed.
- Missing dependency gives actionable `StateHydrationError`.

### Integration tests

- Parent eval exports dataframe-like records and spawns multiple review agents with `parallel_settled()`.
- One child fails hydration; siblings succeed; parent receives settled results.
- Parent cancellation aborts descendants without leaked sessions.
- Recursive child forwards state to grandchild.

### Verification commands

Run focused changed tests, then:

```bash
bun --cwd=packages/coding-agent run check
```

If Python runtime changes:

```bash
PI_PYTHON_INTEGRATION=1 bun --cwd=packages/coding-agent test test/core/eval-workflow-helpers.integration.test.ts
```

## Migration

1. Keep existing `agent(prompt, ...)` behavior except eval session inheritance.
2. Add warning if a child attempts to access inherited parent runtime state.
3. Update workflow notice:
   - subagents have isolated eval state;
   - pass state via `state=` / `handoff()` / URI refs;
   - eval file edits remain allowed.
4. Provide examples replacing implicit shared globals with `handoff(vars=[...])`.

## Non-goals

- Do not ban eval file edits.
- Do not disable recursive spawning.
- Do not share live parent kernels by default.
- Do not auto-capture every global.
- Do not pickle automatically.
- Do not create mutable cross-agent object proxies.
- Do not make URI strings sufficient authority without grants.
- Do not build explicit shared eval sessions until isolated handoff is proven.

## Success Criteria

Agents should love the system because:

- parent state is easy to pass;
- child state access is simple and named;
- large data does not bloat prompts;
- failures name the exact state key and recovery;
- recursive forwarding is easy;
- parent orchestration survives child reset/shutdown/failure.

Maintainers should trust the system because:

- runtime ownership is explicit;
- resets are local;
- every handoff is inspectable;
- access is grant-scoped;
- large data is URI-backed;
- tests cover the original kernel-shutdown incident and recursive state transfer.
