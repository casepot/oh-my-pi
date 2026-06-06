# OMP background lanes and goal-mode spine progress

## Purpose

This note captures the intended design for an OMP background-lane primitive and how it relates to OMP goal mode, OMP tasks, and release-shaped development skills.

It is not release authority, not a release record, and not evidence for any product or parent claim. It is a process and harness design note.

The central distinction:

> A task is delegated work for current fan-in. A background lane is a durable divergent branch with an attached agent and an explicit parent-disposition obligation.

The goal is to let the main operator continue from a stable accepted checkpoint while useful background work proceeds on separate worktrees, without allowing that background work to silently become authority or be forgotten before parent completion.

## Scope and boundaries

This note is about OMP, the agent harness.

It is not about `agent-gateway` implementation. `agent-gateway` is currently the proving ground for release-shaped development cadence and skills, but the OMP background-lane primitive should not know about gateway releases, atoms, version labels, residual classes, or release records.

The boundaries should stay clear:

```text
OMP task
  delegated work for current fan-in

OMP background lane
  durable divergent worktree branch with attached agent

OMP goal mode
  parent/target/checkpoint lifecycle and parent-completion enforcement

Release-flow skills
  policy guidance for when to spawn lanes, what they mean, and how to reduce their output
```

The skills may say, for example, that a residual should become a background lane and must be dispositioned before a parent gate. OMP should provide the generic lane mechanics and goal-mode enforcement. The skills decide the meaning of lane output in a domain-specific process.

## Why `task` is not enough

OMP tasks are the correct primitive for parallel help that must fan back into the current target before the main operator proceeds.

Use `task` when:

```text
main operator delegates work
  -> waits for result
  -> reduces result now
  -> closes or repairs current target
```

This includes:

- read-only scouting;
- adversarial review of the current target;
- implementation slices for current fan-in;
- evidence mapping required before current checkpoint;
- isolated patches that should be applied or rejected now.

Current OMP task isolation reinforces this interpretation. An isolated task captures a baseline, materializes temporary isolation, runs a subagent, captures a patch or branch, applies/cherry-picks or returns the result according to task settings, and cleans up temporary isolation. That is current fan-in behavior.

A background lane needs different semantics:

```text
accepted checkpoint exists
  -> branch from that exact source base
  -> agent works independently in persistent worktree
  -> main spine may continue
  -> lane output is reduced later
  -> parent completion is blocked until required lanes are dispositioned
```

That is not “task, but async.” It is a separate line of development. Extending `task` with `background: true` would blur the model and create unsafe defaults around cleanup, auto-merge, and parent-gate obligations.

Tasks may remain an internal helper for short-lived sub-work inside a lane agent, but a lane should not be represented as a task result.

## The core invariant

The OMP primitive exists to preserve one invariant:

> The main spine may continue from accepted bounded truth while background lanes run, unless a lane reports a finding matching its `blocks_if`; parent completion may not succeed while required background lanes remain undispositioned.

This is the safety/throughput trade:

- intermediate target progress should not wait for every useful review or residual repair;
- parent completion must not forget parent-relevant divergent work;
- background work must not become authority merely because it exists, runs, passes checks, or produces a patch.

## The background lane object

A lane is a durable OMP object. It should be small and explicit.

```yaml
background_lane:
  id:
  from:
    checkpoint_id:     # OMP goal checkpoint when goal mode is active
    source_ref:        # materialized source base; git commit in v1
  branch:
    name:
    worktree_path:
  agent:
    session_ref:
    status: starting | running | idle | stopped | failed
  contract:
    question:
    blocks_if:
    required_before_parent: true | false
  status: open | blocked | closed | spawn_failed
  outcome: merged | dropped | stale | superseded | no_release | deferred | null
  latest_report_ref:
  latest_patch_ref:
```

The fields mean:

- `checkpoint_id`: the semantic OMP goal checkpoint the lane descends from. In non-goal contexts this may be absent, but in goal mode it is what lets parent completion enforce lane disposition.
- `source_ref`: the exact source base. In v1 this should be a git commit. Dirty working tree snapshots can wait.
- `branch` and `worktree_path`: execution handles, not authority.
- `agent.session_ref`: the child OMP session attached to the lane.
- `question`: what the lane is trying to answer.
- `blocks_if`: the precise condition under which the lane interrupts the main spine.
- `required_before_parent`: whether parent completion requires the lane to be closed.
- `latest_report_ref` and `latest_patch_ref`: artifacts for reducer/operator inspection. Their presence is not acceptance.

## Model-facing operation surface

OMP should expose one model-facing tool, likely hidden/controller-scoped:

```yaml
background_lane
```

The v1 operation set should be complete enough to run real lanes without exposing unnecessary mechanics.

### `spawn`

Create a lane, materialize its worktree/branch, attach a child OMP agent, and start the assignment.

```yaml
op: spawn
from:
  checkpoint_id:
  source_ref:
contract:
  question:
  blocks_if:
  required_before_parent: true
assignment:
agent:
```

Required behavior:

1. Validate goal state when goal mode is active.
2. Validate `checkpoint_id` is an accepted checkpoint if provided.
3. Validate `source_ref` is a materialized, branchable source ref.
4. Persist the lane record before side effects.
5. Create a persistent git worktree and branch.
6. Start or create a child OMP RPC session in that worktree.
7. Register the child-only lane reporting tool.
8. Inject the lane contract and assignment.
9. Update the lane record with branch/session state.

If materialization fails after the lane is persisted, the lane becomes:

```yaml
status: spawn_failed
retryable: true
```

The accepted checkpoint is not rolled back.

### `list`

Show the lane ledger.

```yaml
op: list
```

The result should be compact and operator-friendly:

```yaml
lanes:
  - id:
    question:
    agent_status:
    status:
    outcome:
    required_before_parent:
    blocks_if_fired:
    branch:
```

### `message`

Send follow-up/context to the lane agent.

```yaml
op: message
lane_id:
message:
```

This should route through the child OMP RPC session. If the child process has stopped but the worktree and session still exist, OMP should restart or reattach first.

This is deliberately not IRC. IRC is useful for live peer coordination. Lane messaging is durable operator control over a persistent branch/session.

### `snapshot`

Observe current lane source and agent state.

```yaml
op: snapshot
lane_id:
```

The result should include:

```yaml
lane_id:
agent_status:
branch:
worktree_path:
head_source_ref:
changed_files: []
patch_ref:
latest_report_ref:
blocks_if_fired:
```

Snapshot is observation only. It does not merge, close, or accept anything.

### `close`

Dispose the OMP lane obligation.

```yaml
op: close
lane_id:
outcome: merged | dropped | stale | superseded | no_release | deferred
reason:
```

Closing a lane updates OMP lane state. It does not accept a release claim or parent claim. Higher-level process guidance decides whether the close reason is adequate.

For `outcome: merged`, v1 should require enough evidence to avoid a false close, such as a merged source ref or explicit operator statement. The runtime should verify what it can, but OMP should not pretend source merge equals semantic acceptance.

## Child lane reporting

The lane agent should have a dedicated host tool:

```yaml
lane_report:
  lane_id:
  summary:
  blocks_if_fired: true | false
  changed_files: []
  evidence_refs: []
  non_claims: []
  stale_if: []
```

The report handler should:

1. validate the lane id;
2. store the report as an artifact/session message;
3. update the lane record;
4. if `blocks_if_fired` is true, mark the lane blocked and trigger goal-mode interruption.

Do not parse the child agent’s final prose to infer whether a blocker fired. The child must report that explicitly.

## Worktree and source mechanics

V1 should require `source_ref` to be a git commit.

Worktree creation:

```text
git worktree add -b omp/lane/<lane_id> <worktree_path> <source_ref>
```

Rules:

- Do not branch from dirty local state in v1.
- Do not remove the lane worktree while the lane is open.
- Use existing OMP git/worktree helpers where possible.
- Use per-repository locking discipline because git worktrees share repository metadata.
- Branch/worktree existence is execution state, not accepted truth.

A lane spawned from a source ref older than the current spine may still be valid for its own question, but its patch/evidence must be treated as candidate output until current-state review or reducer admission happens at the relevant process layer.

## Child OMP RPC session

OMP main branch RPC is the canonical control foundation.

Relevant RPC facts:

- `omp --mode rpc` is a local stdio NDJSON control plane.
- `ready` advertises capabilities.
- long-running commands return ACK plus `operationId`.
- completion is observed only through terminal operation frames.
- RPC supports host tools, session graph, observable sessions, typed errors, operation cancellation, and state changes.

The lane manager should use this foundation by starting a child OMP process/session with:

```yaml
cwd: lane worktree
mode: rpc
parent_session: current session
host_tools:
  - lane_report
```

The lane handoff prompt should make the authority boundary explicit:

```text
You are working in background lane <id>.
Origin checkpoint: <checkpoint_id>
Source ref: <source_ref>
Question: <question>
Blocks if: <blocks_if>
Required before parent: <true|false>

You may produce findings, candidate patches, evidence refs, and non-claims.
You may not claim parent completion, release acceptance, or accepted residual risk.
Use lane_report to report findings and whether blocks_if fired.
```

## Goal-mode integration

Goal mode keeps parent lifecycle separate from target lifecycle. A checkpoint can close a target, but cannot complete the parent. Background lanes should fit this model.

Checkpoint resolution may request lane spawns:

```yaml
resolve_checkpoint:
  decision: next_target
  parent_delta:
    background_lanes_to_spawn:
      - from:
          checkpoint_id:
          source_ref:
        contract:
          question:
          blocks_if:
          required_before_parent:
        assignment:
  next_target:
```

AgentSession should commit the checkpoint resolution first, then spawn lanes as side effects. Spawn failure creates a lane failure state; it does not erase the checkpoint.

Parent completion rule:

```text
If any required_before_parent lane is open, blocked, or spawn_failed,
parent completion is rejected.
```

A lane that reports `blocks_if_fired: true` should interrupt ordinary continuation. The cleanest run mode is:

```text
awaiting-background-lane-intake
```

If adding a new run mode is too invasive initially, an equivalent blocker list can suppress ordinary target continuation until the main operator handles the lane.

The goal system should not interpret the semantic meaning of the lane’s patch. It only enforces lifecycle obligations:

- required lanes cannot be forgotten before parent completion;
- blocking reports cannot be silently ignored;
- lane state survives restart/compaction/handoff.

## RPC exposure

The same primitive should be visible over RPC.

Capability:

```json
"backgroundLanes": true
```

Command family:

```json
{ "type": "background_lane", "op": "spawn", ... }
{ "type": "background_lane", "op": "list" }
{ "type": "background_lane", "op": "message", ... }
{ "type": "background_lane", "op": "snapshot", ... }
{ "type": "background_lane", "op": "close", ... }
```

Long-running operations such as `spawn` and `message` should return ACK plus `operationId`; completion is terminal operation frames only.

Event frame:

```json
{
  "type": "background_lane_update",
  "laneId": "...",
  "status": "...",
  "blocksIfFired": false,
  "summary": {}
}
```

Hosts and dashboards may build richer topology displays later, but v1 only needs a reliable lane ledger and update stream.

## Persistence and recovery

The durable lane ledger belongs in OMP goal/session state, not live job memory alone.

A restarted parent session should be able to answer:

- which lanes exist;
- which checkpoint/source each lane branched from;
- which lanes are required before parent completion;
- which lanes have blocking reports;
- which worktree/branch/session belongs to each lane;
- which lanes are closed and why.

If a child process is gone after restart, the lane is still open unless it was explicitly closed. A later `message` or resume operation can restart/reattach the child OMP session in the same worktree.

Custom session messages should also be emitted for user-visible recovery:

- `background-lane-created`
- `background-lane-updated`
- `background-lane-report`
- `background-lane-closed`

These messages are artifacts of durable state, not the sole source of truth.

## Release-shaped development skills

Release-flow skills should use OMP lanes without depending on OMP internals.

A skill can schedule a lane like this:

```yaml
background_lane:
  question: Check whether this residual refutes the accepted checkpoint.
  blocks_if: Finds the accepted checkpoint claim false or stales evidence the active target relies on.
  required_before_parent: true
```

The skill then interprets output:

- a report may become candidate evidence;
- a patch may be merged through ordinary review;
- a finding may become no-release input;
- a residual may be deferred;
- a blocker may force repair or pivot.

OMP should not know those categories. OMP should only preserve and enforce lane lifecycle.

Long term, the release-flow skills should generalize this development process beyond `agent-gateway`. The OMP primitive should therefore stay domain-neutral.

## Discrete goals by concern

The boundaries above imply separate goals for separate concerns. Keeping these goals distinct prevents OMP mechanics, goal lifecycle, and development-policy skills from collapsing into one another.

### OMP task goal

Desired future state:

> `task` remains the primitive for delegated work whose result is consumed before the current target or checkpoint closes.

Claims to preserve:

- A task does not create durable parent obligations.
- A task does not outlive the current fan-in boundary as a tracked line of development.
- `task(isolated=true)` keeps current fan-in semantics: isolated execution, patch/branch capture, immediate apply/return according to settings, and temporary cleanup.
- No task result can satisfy or close a background-lane parent obligation.

### OMP background lane goal

Desired future state:

> OMP can spawn and track durable divergent work from a materialized source base, with a persistent worktree branch, attached child OMP session, explicit blocking condition, and explicit parent-disposition obligation.

Claims to make true:

- A lane has an immutable origin: `checkpoint_id` when goal mode is active, and `source_ref` as the materialized source base.
- A lane owns a persistent branch/worktree until closed.
- A lane owns or can reattach to a child OMP session.
- A lane can be listed, messaged, snapshotted, and closed.
- Lane existence, branch existence, child completion, and patch existence are not authority.

### OMP lane execution goal

Desired future state:

> A spawned lane can run a child OMP RPC agent in the lane worktree and receive structured reports from that agent.

Claims to make true:

- The child session starts with `cwd` set to the lane worktree.
- The child receives lane id, source ref, question, `blocks_if`, parent-required flag, and authority limits.
- The child has a dedicated `lane_report` host tool.
- `lane_report` updates parent lane state.
- RPC ACK is not treated as lane completion.

### OMP goal-mode integration goal

Desired future state:

> Goal mode can spawn lanes after checkpoint resolution, continue ordinary target work while non-blocking lanes run, interrupt on blocking lane reports, and reject parent completion while required lanes remain open.

Claims to make true:

- Checkpoint resolution may request lane spawns.
- Lane spawn happens after checkpoint/resolution state is committed.
- Spawn failure records retryable lane failure and does not roll back checkpoint acceptance.
- `required_before_parent: true` blocks parent completion until the lane is closed.
- `blocks_if_fired: true` suppresses ordinary continuation until the main operator performs intake.
- Lane state survives compaction, handoff, restore, and restart as goal/session state.

### OMP RPC goal

Desired future state:

> Hosts can inspect and control background lanes through the same OMP RPC discipline used for other long-running operations.

Claims to make true:

- `get_protocol_info` advertises `backgroundLanes`.
- RPC exposes `background_lane` commands for `spawn`, `list`, `message`, `snapshot`, and `close`.
- Long-running lane commands return ACK plus `operationId`.
- Completion is observed only through terminal operation frames.
- Lane state changes emit observable update frames.

### OMP persistence and recovery goal

Desired future state:

> A lane remains visible, resumable, and enforceable after ordinary OMP recovery boundaries.

Claims to make true:

- The lane ledger is serialized in durable goal/session state.
- User-visible lane messages are emitted for restore and auditability.
- Open lanes remain open after parent process restart.
- A stopped child can be reattached or restarted in the same worktree/session.
- Parent completion guards continue to work after restore.

### Release-shaped skill goal

Desired future state:

> Development-policy skills can schedule and reason about OMP lanes generically, without being tied to `agent-gateway` or OMP internals.

Claims to make true:

- Skills distinguish active authority spine, background lane, task fan-in, and parent-required disposition.
- Skills describe lane use through `question`, `blocks_if`, `required_before_parent`, and authority limits.
- Skills treat lane output as candidate evidence until reduced by the relevant process.
- Skills do not imply worktree paths, RPC operation ids, child process management, or OMP-specific mechanics.
- Gateway-flavored examples remain examples, not semantics.

### Proving-ground project goal

Desired future state:

> A project such as `agent-gateway` may exercise OMP lanes and release-shaped skills without coupling OMP lane semantics to that project.

Claims to preserve:

- Project records may cite lane outputs only after normal review/reduction.
- Project release success is not implied by OMP lane success.
- Project-specific version cadence, residual taxonomy, and release records are not encoded into OMP.

### Future supervisor-provider goal

Desired future state:

> If OMP later adds an external lane supervisor, it manages execution mechanics while OMP goal/session state remains able to enforce parent-required lane disposition locally.

Claims to preserve:

- External supervisor state may mirror or augment lane state, but is not the sole authority for local goal mode.
- Loss of supervisor state cannot falsely unblock parent completion.
- The local provider remains sufficient for the core lane lifecycle.


## Anti-laundering rules

Background lanes are powerful because they decouple work from the main spine. They must not become hidden authority.

Rules:

1. Lane output is candidate output, not accepted truth.
2. Branch existence is not accepted truth.
3. Patch existence is not accepted truth.
4. Passing checks inside a lane are evidence only for what they exercised.
5. RPC ACK is not completion.
6. Child-agent prose is not a blocker unless reported through `lane_report` or explicitly reduced by the main operator.
7. Closing a lane is not parent completion.
8. A lane the active spine relies on is no longer background; it is a dependency or predecessor.
9. Parent completion requires all required lanes closed, deferred, or otherwise dispositioned by the appropriate higher-level process.

## Testing requirements

A complete v1 should include tests for these behaviors:

1. `task` behavior remains unchanged.
   - Isolated tasks still perform current fan-in behavior.
   - Tasks do not create lane ledger entries.
2. Lane spawn rejects invalid source refs.
3. Lane spawn in goal mode requires an accepted checkpoint.
4. Lane record is persisted before worktree/session side effects.
5. Worktree and branch persist after child completion.
6. `lane_report` updates lane state.
7. `blocks_if_fired: true` suppresses ordinary goal continuation.
8. Parent completion rejects required open lanes.
9. `snapshot` captures diff/patch from lane worktree against `source_ref`.
10. Restart reloads lane ledger and can message/reconnect child session.
11. RPC command ACK is not treated as lane completion.
12. Closing a lane records disposition but does not mutate parent completion state directly.

## Recommended implementation sequence

### P0: complete first version

Build the generic primitive end to end:

- background lane types and persisted ledger;
- `background_lane` model-facing tool with `spawn`, `list`, `message`, `snapshot`, and `close`;
- child-only `lane_report` host tool;
- persistent git worktree/branch creation from commit source ref;
- child OMP RPC session in lane worktree;
- lane report artifacts/session messages;
- goal-mode parent-completion guard;
- goal-mode blocking report guard;
- RPC capability, command family, and update frame;
- restart/recovery of lane ledger and reattachable child sessions.

This is not a partial implementation. It is the complete core lifecycle: spawn, work, report, observe, interrupt, and close.

### P1: integration assistance

Add helpers once the core lifecycle is reliable:

- merge/rebase preview;
- stale source/head detection;
- lane cleanup policy;
- richer topology display;
- lane-specific tool/permission profiles.

These are useful, but they should not be required to prove the primitive.

### P2: external supervisor provider

If local process ownership becomes insufficient, add an external supervisor provider.

The supervisor may manage worktrees, processes, retries, and remote execution, but OMP goal/session state should still own the lane ledger needed for parent-completion enforcement. External supervisor state may mirror or augment; it should not be the sole authority for local goal mode.

## Summary

The background-lane primitive should be precise and durable:

```text
accepted checkpoint + source ref
  -> persistent worktree branch
  -> attached child OMP agent
  -> explicit blocks_if
  -> explicit required-before-parent obligation
  -> durable close disposition
```

That gives the main operator a safe way to continue from a stable base while important background work proceeds, without collapsing background execution into accepted truth or losing required work before parent completion.
