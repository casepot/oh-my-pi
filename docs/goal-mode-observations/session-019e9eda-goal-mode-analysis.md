# Goal-mode observations: session 019e9eda-c08a-7000-91ea-380877fbb400

Source transcript:

`/Users/case/.omp/agent/sessions/-projects-agent-gateway/2026-06-06T21-33-16-810Z_019e9eda-c08a-7000-91ea-380877fbb400.jsonl`

Analyzed session objective:

> `@docs/releases/0.6.1-toward-0.7.0-omp-rpc-v1.1-orchestration-contract.yaml ~/projects/external/oh-my-pi/`
>
> Implement and prove 0.6.1 toward 0.7.0: OMP RPC v1.1 orchestration contract alignment.

## Executive read

The goal lifecycle was formally correct: the agent inspected the goal, started one target, checkpointed only after implementation and verification, resolved the checkpoint as a parent-completion candidate, then invoked a separate parent-completion verifier. The checkpoint and completion verifier both preserved the critical non-claims: no 0.7.0 source-family acceptance, production readiness, broad OMP parity, stable public API, package-version authority, or ACK-as-terminal-success laundering.

The main qualitative weakness is the same aperture issue as the previous observation, but sharper here: one target covered the entire D1-D10 runtime-evidence atom. That kept the workflow coherent, but goal mode mostly functioned as a final evidence gate rather than an incremental parent-frame program with smaller accepted deltas.

The most concrete goal-tool weirdness is telemetry and rendering overhead. The transcript contains 279 `mode_change` records for only 5 actual `goal` tool calls, and the repeated goal-state snapshots account for about 46% of the parsed JSON bytes. Several state/rendering details are confusing for auditors: early `goal` results are visibly pruned to `[Output truncated ...]` while full details live only in JSON metadata, `stateVersion` briefly goes backward early in the run, compaction emits a `goal_paused`/disabled state after an aborted empty `read`, a hidden pre-resolution steer uses the same `goal-checkpoint-resolution` custom type as the later visible resolution, and the terminal completed state reports `runMode: working-target`.

## Transcript shape

Parsed session structure:

- 827 JSONL records.
- 533 `message` records.
- 279 `mode_change` records:
  - 277 with `mode: goal`.
  - 1 with `mode: goal_paused` during compaction/abort handling.
  - 1 final `mode: none` after completion.
- 8 `custom_message` records.
- 2 compactions.
- 5 `goal` tool calls.
- 1 parent goal.
- 1 target.
- 1 checkpoint.
- 1 checkpoint resolution.
- 1 parent completion attempt.
- Completion verifier accepted on the first attempt.

Goal-related custom messages recorded:

- `goal-rubric`
- `goal-mode-context` at session start and after compaction/continuation points
- `goal-checkpoint`
- `goal-checkpoint-resolution` twice:
  - one hidden continuation steer before actual resolution
  - one visible checkpoint-resolution record after `resolve_checkpoint`
- final `goal-completed` custom event

Observed run-mode progression:

```text
working-target
  -> goal_paused/disabled during compaction boundary, while inner runMode remained working-target
  -> working-target
  -> awaiting-checkpoint-resolution
  -> awaiting-parent-completion
  -> completed/exiting, but final goal payload still says runMode: working-target
  -> none
```

## Goal-tool timeline

### 1. Initial goal state

Goal mode was injected before visible work. The first records establish the active parent goal and rubric, then the agent called:

```json
{ "op": "get" }
```

This was appropriate. However, the visible tool-result content for this call is only:

```text
[Output truncated - 326 tokens]
```

The full goal state exists in the JSON `details`, but a human reading the visible transcript does not get useful `goal(get)` output without parsing metadata.

### 2. Target start

The agent called `start_target` with:

- title: `Implement 0.6.1 OMP RPC v1.1 runtime evidence seam`
- desired future claim: selected local OMP runtime capability/lifecycle evidence derives from OMP RPC v1.1 facts; ACK remains nonterminal; terminal/error frames classify runtime evidence; malformed/contradictory streams fail closed; operator replay/explain preserves source/delivery separation.
- closure standard: D1-D10 runtime seam proof across protocol-info validation, descriptor derivation, executable boundary, operation lifecycle, ACK behavior, typed error handling, operator seams, facade/guard/census, and evidence packet.
- non-goals: 0.7.0 parent acceptance, webhook/schedule/watcher/source resources, production delivery/storage/HA/migrations, dashboard/backend support, broad OMP parity, stable API, package-version authority.
- forbidden claims: ACK-only terminal success, static/package/executable facts as v1.1 support, workstation-local defaults as live support, runtime evidence as source/delivery success, fixture malformed streams as live support, and 0.7.0 parent completion.

This was well scoped relative to the requested 0.6.1 runtime-evidence atom, but it was still a broad single target. It packed the whole D1-D10 proof into one target, so there was no opportunity for goal mode to admit smaller parent-frame deltas as implementation progressed.

The visible `start_target` result was also pruned to:

```text
[Output truncated - 350 tokens]
```

Again, the structured details are present in JSON, but the visible transcript is weak for audit.

### 3. Work under one target

The implementation work ran almost entirely under one active target. Tool-call counts during the work interval were roughly:

- 134 `read`
- 48 `edit`
- 27 `search`
- 22 `bash`
- 14 `lsp`
- 6 `todo_write`
- 2 `write`
- 1 `task`
- 1 `find`

There were no additional agent-initiated `goal(get)` calls after the initial one. Goal context was re-injected by the harness after compaction, but the agent did not explicitly refresh goal state with the tool. This differs from the prior observed session, where repeated `goal(get)` calls after compaction were a healthy sign.

### 4. Compaction and pause boundary

Two compactions occurred. Around the first compaction, the transcript shows an empty-argument `read` call, an aborted tool result, then a `mode_change` with:

```text
mode: goal_paused
enabled: false
inner goal mode: active
runMode: working-target
stateVersion: 3
```

The run recovered and goal mode resumed at `stateVersion: 4`, but the telemetry is odd. It is difficult to tell from the log whether this was an intentional compaction pause, a side effect of the aborted empty `read`, or both. For auditability, `goal_paused` would be clearer if it carried an explicit reason such as `compaction` instead of looking like a tool-failure side effect.

### 5. Checkpoint

After implementation and focused verification, the agent called `checkpoint` with `status: closed_with_evidence`.

The checkpoint payload was strong. It included:

- summary
- local claims
- concrete evidence entries
- checks run
- artifacts touched
- risks/caveats
- not-claimed items
- remaining questions

The checkpoint reviewer accepted local target closure:

> Accepted for local target closure. The checkpoint names a clear 0.6.1-candidate runtime-evidence atom, matches the parent/current target baseline refs, supplies current source/test/artifact evidence for D1-D10, preserves fixture/local-real proof scopes, and explicitly blocks parent/production/source/delivery/stable-API overclaims.

The goal result moved to:

```text
Status: active
Run mode: awaiting-checkpoint-resolution
Current target: Implement 0.6.1 OMP RPC v1.1 runtime evidence seam (closed)
Pending checkpoint: 14ff04693006a0dc-checkpoint-1
```

This was correct: target closed, parent still active.

Cleaner than the previous observed session: after the checkpoint result, there were no ordinary tool calls before checkpoint resolution. The transcript therefore did not demonstrate the ordinary-tool blocking guard by rejection, but it also did not violate the boundary.

### 6. Hidden checkpoint-resolution steer

Before the visible `resolve_checkpoint` call, the transcript records a hidden custom message with custom type `goal-checkpoint-resolution` and content beginning:

```text
<!-- Hidden goal continuation steer. role=user, suppressed from visible transcript. -->

Continue according to the active goal run mode.
```

This is useful controller guidance, but the custom type is confusing. It appears before any checkpoint has actually been resolved, then the later visible resolution uses the same `goal-checkpoint-resolution` type. A distinct type such as `goal-continuation-steer` would make log analysis less ambiguous.

### 7. Checkpoint resolution

The agent called `resolve_checkpoint` with decision:

```text
parent_completion_candidate
```

The parent reading admitted the bounded 0.6.1 runtime-evidence seam and explicitly did not propagate:

- parent goal complete before verifier acceptance
- 0.7.0 parent release acceptance
- source-family implementation or production-readiness claims
- package-version/tag/commit/green-test release authority

The parent delta added accepted claims, boundaries, residuals, frontier deltas, stale refs, and external record refs. This was a correct use of checkpoint resolution.

### 8. Parent completion

The agent called:

```json
{ "op": "complete" }
```

The completion verifier accepted on attempt 1 with score 3. Verifier feedback:

> Parent completion is acceptable for the narrowed 0.6.1 runtime-evidence objective. I rechecked current source anchors, release evidence packet, external OMP RPC contract anchors, session/artifact test outputs, and parent-frame resolution; the work satisfies D1-D10 without claiming 0.7.0 source-family, production, delivery, broad parity, or stable API completion.

This is a good parent-level completion boundary: the verifier accepted the narrowed 0.6.1 runtime-evidence objective, not the broader future 0.7.0 source-family program.

The visible final assistant message was also correctly scoped:

```text
Parent goal verified complete.

Accepted scope: 0.6.1 OMP RPC v1.1 runtime-evidence seam only.
Preserved non-claims: 0.7.0 acceptance, source resources, production readiness, broad OMP parity, stable public API, and package-version authority.
```

There is an overstatement trap only if someone quotes the first sentence without the second paragraph.

## What goal mode contributed

Goal mode materially helped in these ways:

1. **Explicit target definition**

   The target included desired claim, parent contribution, baseline refs, evidence expectations, non-goals, forbidden claims, and stale-if refs.

2. **Evidence pressure**

   The checkpoint required a detailed evidence packet rather than a vague “done” claim.

3. **Local checkpoint review**

   The checkpoint reviewer accepted target closure only, and did so with explicit proof-scope caveats.

4. **Parent-frame reduction**

   `resolve_checkpoint` converted local target evidence into parent-frame claims, boundaries, residuals, frontier deltas, and stale refs.

5. **Separate completion verifier**

   Parent completion required a distinct verifier pass after checkpoint resolution.

6. **Non-claim preservation**

   The run repeatedly carried the anti-laundering boundaries around ACKs, fixture evidence, local real-adapter evidence, source/delivery success, production readiness, and release authority.

7. **Compaction continuity**

   Harness-injected goal contexts after compaction preserved the objective and rubric, even though the agent did not explicitly call `goal(get)` again.

## Inefficiencies and weirdness

### Broad target aperture

The single target covered all D1-D10. It was coherent, but goal mode had little chance to do incremental closure. Better target decomposition for a similar session would be:

1. protocol-info probe and contract validation
2. descriptor derivation and host-selected executable boundary
3. operation lifecycle, ACK, and typed-error classification
4. operator dispatch/finalization/replay/explain integration
5. facade/guard/census and release evidence packet
6. final verification and parent reduction

That would make checkpoint resolution and parent-frame evolution much clearer.

### Mode-change transcript bloat

The transcript has 279 `mode_change` records for 5 `goal` calls. Parsed JSON sizes show roughly:

- full transcript JSON: about 9.1 MB
- `mode_change` JSON: about 4.2 MB
- `mode_change` share: about 46%
- `goal` tool-result `details`: about 419 KB across 5 calls

Most `mode_change` events repeat the full objective/rubric/goal state while the actual state is unchanged. `stateVersion: 4` alone appears 182 times. This is good for durable reconstruction, but poor for human audit and expensive for transcript storage.

### Duplicate and stale-looking state emissions

Several state emissions are confusing:

- The early sequence goes `stateVersion: 1`, `stateVersion: 2`, then later back to `stateVersion: 1` before target start. That looks like a stale snapshot emission or replay artifact.
- Checkpoint acceptance emits adjacent, near-identical `awaiting-checkpoint-resolution` snapshots.
- Completion emits multiple large snapshots, then the terminal completed payload still says `runMode: working-target`.

None of these broke the workflow, but they make the state machine harder to audit from logs.

### Visible `goal` outputs are not self-contained

The first two goal results are visibly replaced with truncation placeholders, while their full data exists in JSON `details`. Later goal results show readable summaries, but their details are huge.

For goal mode, the visible transcript should probably keep a compact canonical summary for every call:

- goal status
- run mode
- current target id/title/status
- pending checkpoint id
- next allowed action
- verifier/checkpoint status

That would avoid making auditors parse `details` for basic lifecycle facts.

### Hidden continuation type collision

The hidden pre-resolution steer uses `customType: goal-checkpoint-resolution` before the checkpoint has been resolved. The visible resolution uses the same custom type later. That naming collision is weird and makes event streams harder to classify.

### `goal_paused` after aborted empty read

The compaction boundary shows an empty `read` call, an aborted result, then `goal_paused`. This may be normal compaction control, but the log makes it look coupled to a tool failure. A reasoned pause event would be cleaner.

### Todo list is not authoritative

The agent marked the todo item for checkpointing complete before the `goal(checkpoint)` result had been recorded. Harmless in this run, but it reinforces that `todo_write` is only a scratch workflow aid. The durable lifecycle source is the goal tool state.

### Final budget/time instruction is noisy

The final `goal` result says:

```text
Goal achieved. Report final budget usage to the user: time used: 3393 seconds.
```

The final assistant did not repeat it, which was good. This instruction is not helpful goal evidence and risks pulling final user communication toward budget/time ceremony instead of accepted scope and non-claims.

## What goal mode did not exercise

This session did not exercise:

- multiple targets
- `next_target` checkpoint resolution
- `needs_user_input`
- `needs_broader_checks`
- verification repair after a failed completion attempt
- ordinary-tool rejection while checkpoint resolution is pending
- pause/drop/resume as intentional user-visible operations
- background-lane spawning or intake
- `awaiting-background-lane-intake`
- required background-lane disposition before parent completion

The absence is not automatically a flaw. The objective was a bounded 0.6.1 runtime-evidence implementation and the verifier accepted that scope. Analytically, though, the transcript mostly demonstrates classic single-spine goal mode, not multi-target or background-lane goal mode.

## Comparison with the previous observation

Compared with `session-019e9e5e-goal-mode-analysis.md`:

- Both sessions used one broad target and therefore underused goal mode’s incremental parent-frame strengths.
- This session had fewer goal calls: 5 vs. 9.
- This session had fewer mode changes: 279 vs. 572, but mode-change bloat is still severe.
- The previous session showed repeated agent-initiated `goal(get)` refreshes; this one did not after the initial call.
- The previous session collided with checkpoint blocking by attempting `todo_write`; this one did not attempt ordinary tools after checkpoint acceptance.
- Both sessions preserved parent/target/checkpoint/completion boundaries and avoided laundering candidate evidence into parent truth.
- Neither session exercised live background-lane intake or multi-target checkpoint resolution.

## Qualitative conclusion

This was a successful goal-mode run with strong verifier discipline and a clean parent-completion boundary. The agent did not treat checkpoint acceptance as parent completion, and the final accepted scope was narrow and explicit.

The main improvement opportunity is not correctness of the lifecycle; it is operability and auditability. Goal mode should make long work easier to understand. In this transcript, repeated full-state `mode_change` payloads, truncated visible goal results, hidden-message type collisions, stale-looking state versions, and terminal `runMode: working-target` all make the logs harder to reason about than the underlying state machine appears to be.
