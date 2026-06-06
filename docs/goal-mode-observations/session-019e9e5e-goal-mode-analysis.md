# Goal-mode observations: session 019e9e5e-c310-7000-8554-72a8f7c41e8b

Source transcript:

`/Users/case/.omp/agent/sessions/-projects-external-oh-my-pi/2026-06-06T19-17-50-992Z_019e9e5e-c310-7000-8554-72a8f7c41e8b.jsonl`

Analyzed session objective:

> `@docs/execution-plans/omp-background-lanes-goal-mode.md`
>
> Implement this plan end to end. Ensure high taste, use your best judgement, and review thoroughly for correctness, completeness, taste, and polish.

## Executive read

The agent used goal mode mostly correctly as a parent/target/checkpoint/verifier state machine. It understood the main safety invariant: a checkpoint can close a target, but it cannot complete the parent goal. It also preserved the background-lane anti-laundering model throughout: lane output, branch existence, patch existence, checks, RPC ACKs, child prose, and lane closure are candidate signals only, not accepted parent truth.

The main qualitative weakness is that the agent made one very broad target covering the whole P0 implementation. That was defensible for the user's “implement this plan end to end” request, but it meant goal mode served more as a final evidence gate than as an incremental spine of smaller target closures.

The agent implemented the background-lane primitive; it did not use the newly implemented `background_lane` primitive as part of doing the session work. Tests exercised the APIs, but no live background lane was spawned through the agent-facing tool in the transcript.

## Transcript shape

Observed session structure:

- 1 parent goal.
- 1 target.
- 1 checkpoint.
- 1 checkpoint resolution.
- 1 parent completion attempt.
- Completion verifier accepted on the first attempt.
- 9 `goal` tool calls total.
- 572 goal `mode_change` entries, mostly token/run-state persistence.
- 3 compactions.
- Goal custom messages recorded:
  - `goal-rubric`
  - `goal-mode-context`
  - `goal-checkpoint`
  - `goal-checkpoint-resolution`
  - `goal-completed`

Run-mode progression:

```text
working-target
  -> awaiting-checkpoint-resolution
  -> awaiting-parent-completion
  -> complete
```

## Goal-tool timeline

### 1. Initial inspection

The agent first called:

```json
{ "op": "get" }
```

This was appropriate. It inspected the active generated rubric and visible goal state before starting work.

### 2. Target start

The agent called `start_target` with:

- title: `Implement generic background lanes end to end`
- desired future claim: OMP/coding-agent implements the documented background-lane primitive end to end.
- closure standard: code, tests, docs, and changelog demonstrate spawn/list/message/snapshot/close, durable ledger/recovery, git worktree branching, child lane report handling, goal completion guards, RPC exposure, task regression behavior, and anti-laundering boundaries.
- non-goals:
  - external supervisor provider
  - merge/rebase preview UI
  - lane cleanup policy
  - project-specific release semantics
- forbidden claims:
  - lane output is accepted parent truth
  - branch/worktree/patch/check existence implies semantic acceptance
  - RPC ACK or child prose completes a lane
  - task is a background-lane substitute

This target matched the P0 implementation scope in `docs/execution-plans/omp-background-lanes-goal-mode.md` and excluded P1/P2 concerns.

### 3. Mid-session goal refreshes

After large implementation segments and compactions, the agent called `goal(get)` multiple times. This was healthy: it re-grounded in the active target and avoided treating compaction summaries as authoritative state.

The compaction summaries preserved important goal constraints:

- current run mode: `working-target`
- active target id: `14fee5b2b11bf578-target-1`
- do not checkpoint until target closure evidence exists
- do not treat target closure as parent completion
- lane output is not accepted parent truth
- task is not a background-lane substitute

### 4. Checkpoint

The agent called `checkpoint` only after implementation, tests, docs, and final audit work.

The checkpoint summary claimed implementation of:

- durable lane ledger/model
- model-facing and RPC control surfaces
- persistent git worktree mechanics
- child RPC handoff/reporting
- goal-mode guards
- recovery/audit messages
- docs/changelog
- contract-level tests

Checkpoint local claims included the critical authority boundaries:

- durable background-lane object distinct from task fan-in
- typed `background_lane` and `lane_report` surfaces
- goal-mode enforcement of required lane obligations
- RPC ACK/terminal operation semantics
- generic docs without project-specific release semantics

The checkpoint reviewer accepted it. The review inspected D1-D12 evidence, current repo files, tests, and non-claims.

### 5. Checkpoint boundary enforcement

After checkpoint acceptance, ordinary tool work was blocked. The agent attempted `todo_write` before resolving the checkpoint, and the harness rejected it:

```text
Goal checkpoint is pending resolution; ordinary tool work is blocked until goal({ op: "resolve_checkpoint", ... }) records the controller decision.
```

This is an important positive signal: goal mode enforced the controller boundary rather than letting the agent continue ordinary work as if checkpointing were only a progress note.

### 6. Checkpoint resolution

The agent then called `resolve_checkpoint` with decision:

```text
parent_completion_candidate
```

The parent reading said the accepted target evidence covered the parent objective's concrete D1-D12 deliverables and that no smaller remaining implementation target was apparent. It explicitly did not propagate:

- parent goal complete without independent verifier acceptance
- external release/domain acceptance
- background-lane artifacts as parent truth by themselves

It added parent-frame boundaries for:

- lane anti-laundering
- task/lane separation

This was a correct use of checkpoint resolution: it promoted bounded implementation claims while preserving non-claims and requiring an independent completion verifier.

### 7. Parent completion

The agent called:

```json
{ "op": "complete" }
```

The completion verifier accepted on attempt 1.

Verifier feedback:

> Parent goal can close. Current repo inspection supports the D1–D12 contracts; no blocking gaps found. Verification strength is complete/coherent rather than exceptional because successful child execution is covered with a recording launcher plus inspected real RPC launcher path, not an end-to-end live model child session.

The caveat is meaningful: the implementation had strong focused tests and inspected real launcher code, but the transcript did not prove a live child model session end to end.

## What goal mode contributed

Goal mode materially improved the session in these ways:

1. **Explicit parent/target split**

   The agent did not treat the user's large objective as a single undifferentiated task. It created a target with a closure standard and non-goals.

2. **Evidence pressure**

   The target could not close until the agent assembled local claims, evidence, checks run, artifacts touched, not-claimed items, risks, and remaining questions.

3. **Checkpoint review**

   A separate checkpoint reviewer accepted only local target closure. It did not complete the parent.

4. **Controller boundary**

   After checkpoint acceptance, ordinary work was blocked until checkpoint resolution. The failed `todo_write` demonstrated this guard.

5. **Parent-completion verifier**

   Parent completion required `goal({ "op": "complete" })` and verifier acceptance, not just checkpoint acceptance or agent prose.

6. **Compaction continuity**

   Multiple compactions preserved the goal target, run mode, non-claims, and next action. This is exactly what long-running goal mode is supposed to protect.

7. **Anti-laundering discipline**

   The agent repeatedly carried the distinction between candidate evidence and accepted parent truth.

## What goal mode did not exercise

The session did not use several goal-mode paths:

- multiple targets
- `next_target` checkpoint resolutions
- `needs_user_input`
- `needs_broader_checks`
- pause/drop/resume
- verification-repair flow
- background-lane spawning through `parent_delta.background_lanes_to_spawn`
- `awaiting-background-lane-intake`
- actual agent-facing `background_lane` tool calls

This is not automatically a flaw. The objective was to implement the primitive, and the implementation passed verifier acceptance. But analytically, this means the transcript mainly demonstrates goal mode as a final-gated work spine, not as a multi-target parent program with live lane intake.

## How well the agent understood goal mode

### Strong signs

The agent showed good conceptual understanding:

- It recognized that a large user objective should become a parent goal plus bounded target.
- It delayed checkpointing until it believed the closure standard was met.
- It reloaded goal state after compaction boundaries.
- It treated checkpoint resolution as a separate controller act.
- It did not claim parent completion until after `complete` verifier acceptance.
- It preserved non-claims around release/domain acceptance and background-lane authority.
- It correctly answered later that `agent-gateway`-specific skills were not implemented.

### Weak signs

The agent's use was not maximally idiomatic:

- It chose one broad target for the whole P0 rather than decomposing into smaller target checkpoints.
- It used `todo_write` as a parallel progress tracker, then collided with checkpoint-resolution blocking. This was harmless but shows some workflow friction.
- It did not use goal mode to stage accepted claims incrementally through parent deltas across multiple targets.
- It did not use a real background lane after implementation to dogfood the primitive.

## Alignment with intended contract

The plan's core invariant was:

> The main spine may continue from accepted bounded truth while background lanes run, unless a lane reports a finding matching its `blocks_if`; parent completion may not succeed while required background lanes remain undispositioned.

The agent implemented and tested this invariant in code, and the goal verifier accepted it. During the session itself, however, no actual live lane was spawned, so the transcript does not show the operator experience of continuing while a lane runs.

The implementation scope aligned with P0:

- background lane types and persisted ledger
- `background_lane` model-facing tool
- child-only `lane_report`
- persistent git worktree/branch creation from commit source ref
- child OMP RPC session in lane worktree
- lane report artifacts/session messages
- goal-mode parent-completion guard
- goal-mode blocking report guard
- RPC capability, command family, and update frame
- restart/recovery of lane ledger and reattachable child sessions

It intentionally did not implement P1/P2:

- merge/rebase preview
- stale source/head detection beyond core mechanics
- lane cleanup policy
- richer topology display
- lane-specific tool/permission profiles
- external supervisor provider

## Verification observed

Final successful commands recorded in the transcript:

- Focused test set: 60 pass, 0 fail.
- `bun run check` in `packages/coding-agent`: pass.
- `bun run check` in `packages/ai`: pass.
- Full `packages/coding-agent` tests: 4562 pass, 361 skip, 0 fail.
- Full `packages/ai` tests: 1450 pass, 337 skip, 0 fail.
- LSP diagnostics eventually clean after reload.

There were earlier failing checks during implementation, including type/check/test failures. The agent repaired them before checkpointing. Final claims were based on observed passing outputs.

## Agent-gateway and skills layer

The user later asked about `agent-gateway` skills. The agent answered that it did not implement gateway-specific skill changes.

That was the right boundary for this OMP P0 change. The plan explicitly says the OMP primitive should stay domain-neutral and should not know about gateway releases, atoms, version cadence, residual taxonomy, or release records.

What was done for skill consumers:

- OMP docs explain active spine vs background lane vs task fan-in.
- Runtime prompts/tool docs express generic lane fields:
  - `question`
  - `blocks_if`
  - `required_before_parent`
  - candidate evidence / non-authority limits
- RPC docs expose generic host control and update frames.

What was not done:

- no external `agent-gateway` repo changes
- no release-flow skill pack changes outside OMP
- no gateway-specific examples/tests proving a release workflow uses lanes
- no gateway host/dashboard consumption of `backgroundLanes` or `background_lane_update`
- no policy saying when a gateway residual should spawn a lane

Remaining consumer-layer work, if desired:

1. Update release-flow skills to specify when to spawn a background lane.
2. Express lane requests using `question`, `blocks_if`, `required_before_parent`, and assignment.
3. Teach those skills that lane output is candidate evidence until reduced.
4. Require explicit lane disposition before parent/release completion.
5. Update gateway RPC hosts/dashboards to display lane ledger, blockers, required-before-parent flags, and close outcomes.
6. Add gateway-shaped integration scenarios using OMP's generic API.

## Qualitative conclusion

This was a successful goal-mode session with one important caveat.

Successful because the agent respected the parent/target/checkpoint/completion model, used evidence and verifier gates, handled compaction safely, and preserved anti-laundering boundaries. The goal tool was not decorative; it actively constrained the session and blocked ordinary work at the checkpoint boundary.

Caveat because the target was so broad that goal mode did not get to show its strongest multi-target behavior. The session closed one large target and then completed the parent. For future similarly large implementation plans, goal mode would provide more analytical value if the agent split the work into several independently checkpointed targets, such as:

1. durable lane state and session persistence
2. lane manager and git/worktree mechanics
3. child RPC launcher and `lane_report`
4. goal-mode guards and recovery
5. RPC exposure and docs
6. full verification and polish

That would make parent-frame evolution clearer and would expose more opportunities for checkpoint resolution, residual capture, and background-lane dogfooding.
