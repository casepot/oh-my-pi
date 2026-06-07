# Goal Mode Seams Hardening Execution Plan

## Objective

Harden goal mode at the seams exposed by the recent goal-mode session reviews:

- keep targets bounded instead of letting one target silently become the whole parent goal;
- make goal state auditable without flooding the transcript with repeated full snapshots;
- make lifecycle/run-state transitions monotonic and easy to reason about;
- make compaction resume from an authoritative goal-state frame instead of stale transcript inference;
- make checkpoint boundaries unmistakable to the agent, UI, and transcript reader.

This plan intentionally does not cover background-lane dogfooding. Background lanes may later consume the same checkpoint and audit surfaces, but they should not be required to fix these core goal-mode correctness issues.

## Source Evidence

This plan comes from comparing the recent goal-mode session analysis in:

- `docs/goal-mode-observations/session-019e9e5e-goal-mode-analysis.md`
- `docs/goal-mode-observations/session-019e9eda-goal-mode-analysis.md`

Observed patterns to address:

1. A single broad target often covered nearly the entire parent goal, so goal mode became a final evidence gate rather than a decomposition controller.
2. Goal state was persisted repeatedly as full `mode_change` snapshots, mostly for usage/accounting updates.
3. A goal state version appeared to move backward after rubric generation and state reinstallation.
4. A completed goal still surfaced `runMode: "working-target"` in terminal state.
5. Early visible `goal(get)` and `goal(start_target)` outputs were pruned, making audit harder even though those summaries are compact and high-value.
6. Checkpoint guidance and checkpoint resolution used the same hidden/custom message type, making transcript semantics ambiguous.
7. Compaction produced preserved context, but there is no distinct post-compaction re-grounding dispatch even though the type surface already anticipates one.
8. Checkpoint-pending state blocked ordinary tools correctly, but the valid next action was not visible enough in UX/status text.

## Design Principles

### Parent goal and current target are separate state objects

A parent goal is the whole user objective. A current target is one bounded, evidence-closable slice that advances it.

The system should treat a target as suspiciously broad when its closure standard is effectively the same as the parent completion rubric. In that case the agent needs decomposition guidance, not a wider target.

### Semantic transitions and accounting updates are different things

Goal state changes such as create, rubric set, start target, checkpoint, resolve checkpoint, pause, complete, and drop are semantic transitions. Token usage and budget accounting are not.

The transcript should preserve enough accounting data to restore correct state, but accounting deltas should not require repeated full state snapshots.

### Compaction is a state boundary

After compaction, the next goal continuation must re-ground from explicit goal state. It must not infer the active target, checkpoint, or completion status from old transcript prose.

### Checkpoints pause continuation until the boundary is resolved

A checkpoint is not parent completion. While a checkpoint is pending, ordinary tools should remain blocked and the UI/tool text should make the only valid next step explicit.

## Implementation Plan

### P0: State-machine correctness fixes

These are correctness fixes and should land before prompt or UX refinements.

#### 1. Preserve monotonic `stateVersion` after rubric generation

**Seams**

- `packages/coding-agent/src/session/agent-session.ts`
  - `createGoalWithRubric`
  - `replaceGoalWithRubric`
- `packages/coding-agent/src/modes/interactive-mode.ts`
  - goal-mode entry path that receives the created/replaced state and installs it
- `packages/coding-agent/src/goals/runtime.ts`
  - rubric state mutation path

**Problem**

Goal creation/replacement creates an initial goal state, then rubric generation mutates runtime state again. The caller can receive and reinstall a stale pre-rubric state snapshot, which can make `stateVersion` appear to move backward in persisted/rendered state.

**Change**

- Make the rubric-setting path return the fresh `GoalModeState`, or make `createGoalWithRubric` / `replaceGoalWithRubric` re-read the runtime state after rubric mutation before returning.
- Do not call `setGoalModeState` with a snapshot older than the runtime's current state.
- Keep state-version ownership in one place. A helper that mutates goal state should either return the post-mutation state or not expose a state value at all.

**Acceptance criteria**

- Creating a goal with a generated rubric cannot produce a later persisted state whose `stateVersion` is lower than the immediately previous goal state.
- Replacing a goal with a generated rubric has the same monotonic property.
- Existing session restoration still sees the latest rubric fields.

**Tests**

- Add or extend goal-mode integration tests to create/replace a goal with rubric generation and assert persisted `mode_change` state versions are monotonic.
- Add a focused runtime/session test for the returned state from `createGoalWithRubric` and `replaceGoalWithRubric`.

#### 2. Add a terminal run mode for completed goals

**Seams**

- `packages/coding-agent/src/goals/state.ts`
  - `GoalRunMode`
  - state normalization/serialization
- `packages/coding-agent/src/goals/runtime.ts`
  - `completeGoalFromTool`
  - allowed-action checks around terminal/exiting state
- UI/status renderers that display run mode:
  - `packages/coding-agent/src/modes/interactive-mode.ts`
  - `packages/coding-agent/src/modes/components/status-line/segments.ts`

**Problem**

`completeGoalFromTool` marks the lifecycle as exiting/completed while leaving `runMode` as `"working-target"`. That is internally confusing and leaks a false action state into logs/UI.

**Change**

- Add a terminal run mode such as `"completed"` to `GoalRunMode`.
- Set `runMode: "completed"` when parent goal completion succeeds.
- Update state normalization to accept the new value and safely map unknown old values.
- Update any guard/switch logic that assumes `working-target` and `checkpoint-pending` are the only non-idle active modes.
- Update renderers to display completed terminal state without implying more target work is in progress.

**Acceptance criteria**

- Completed goal state never renders or persists as `runMode: "working-target"`.
- Ordinary tool gating remains terminal-safe after completion.
- Old sessions without the new run mode still restore safely.

**Tests**

- Extend `packages/coding-agent/test/goals/goal-runtime.test.ts` around successful completion.
- Add a restore/normalization regression for old states if normalization currently has coverage.

#### 3. Record explicit pause reasons

**Seams**

- `packages/coding-agent/src/goals/runtime.ts`
  - `onTaskAborted`
- `packages/coding-agent/src/goals/state.ts`
  - `GoalModeState`
- `packages/coding-agent/src/session/agent-session.ts`
  - abort paths for interrupt, compaction, and internal maintenance

**Problem**

The transcript can record `goal_paused` without enough machine-readable reason to distinguish user interruption, compaction, internal handoff, or other maintenance.

**Change**

- Add an optional `pauseReason` field with a small enum, for example:
  - `"interrupted"`
  - `"compaction"`
  - `"handoff"`
  - `"internal-maintenance"`
- Pass the reason through abort paths instead of only persisting a generic pause.
- Render the pause reason in compact goal-state summaries where useful.

**Acceptance criteria**

- A compaction-induced pause is distinguishable from user interruption in persisted state.
- Existing paused states without `pauseReason` still restore.

### P1: Auditability and transcript-size fixes

#### 4. Split semantic goal-state persistence from usage accounting

**Seams**

- `packages/coding-agent/src/goals/runtime.ts`
  - `#flushUsageLocked`
  - semantic transition paths that call the host persistence callback
- `packages/coding-agent/src/session/agent-session.ts`
  - goal runtime host callback wiring
- `packages/coding-agent/src/session/session-manager.ts`
  - `appendModeChange`
  - session context restore logic that reads latest goal state from transcript

**Problem**

Usage/accounting flushes currently persist full serialized goal state. In reviewed logs, this created many `mode_change` entries where the meaningful lifecycle state did not change. That makes audit harder and increases transcript size.

**Change**

Implement a two-channel persistence model:

1. Full semantic snapshots for meaningful state transitions.
2. Compact accounting updates for usage-only changes.

Conservative shape:

- Keep full `mode_change` snapshots for create, replace, rubric set, start target, checkpoint, resolve checkpoint, pause, resume, complete, and drop.
- Add a compact persisted entry for usage deltas if crash/session-restore-accurate goal budget accounting must survive between semantic transitions.
- Update restore/session-context building to reconstruct latest semantic goal state and fold any later usage deltas into that state.
- If crash-perfect accounting is explicitly not required, keep usage deltas in memory and persist them at the next semantic transition. The default should favor correctness of restored accounting unless implementation cost is disproportionate.

**Acceptance criteria**

- Ordinary side-agent usage flushes do not append repeated full goal-state `mode_change` snapshots.
- Restoring a session after usage-only updates preserves correct total goal usage according to the selected accounting policy.
- Audit readers can distinguish semantic lifecycle transitions from accounting noise.

**Tests**

- Add a session-manager persistence/restore test that records one semantic state, multiple usage-only updates, then restores and checks both latest semantic state and usage totals.
- Add a regression that the number of full `mode_change` entries does not grow for pure accounting updates.

#### 5. Protect visible `goal` tool outputs from compaction pruning

**Seams**

- `packages/agent/src/compaction/pruning.ts`
- Nearest existing compaction/tool-protection tests in `packages/agent`

**Problem**

Goal tool outputs are compact, high-value audit artifacts. Current pruning protects skill reads, but not goal tool results, so early `goal(get)` and `goal(start_target)` summaries can become `[Output truncated ...]`.

**Change**

- Add `goal` to the default protected tool list, or add a matcher that protects goal tool results by tool name.
- Keep protection narrow to goal tool outputs; do not accidentally protect every hidden goal-mode prompt or side-agent transcript.

**Acceptance criteria**

- Visible goal tool outputs survive compaction/pruning.
- Large non-goal tool outputs remain pruneable.

**Tests**

- Add a pruning test with one `goal` tool result and one ordinary large result; assert only the goal result is protected by default.

#### 6. Add one compact goal-state renderer and reuse it

**Seams**

- `packages/coding-agent/src/goals/tools/goal-tool.ts`
  - goal tool result text rendering
- `packages/coding-agent/src/goals/runtime.ts`
  - existing goal state snapshot rendering
- `packages/coding-agent/src/session/agent-session.ts`
  - compaction and continuation context builders
- Checkpoint and status UI render paths

**Problem**

Goal status is spread across several render paths. That invites inconsistent wording and makes it easier for compaction/checkpoint states to omit the next valid action.

**Change**

Create a shared renderer such as `renderCompactGoalStatus(state, goal)` that emits a short, stable text block containing:

- parent goal id/title/status;
- lifecycle mode and run mode;
- `stateVersion` and parent frame version if present;
- current target id/title/status;
- pending checkpoint id/status if present;
- allowed next goal action;
- whether ordinary tools are blocked and why;
- latest pause reason when paused.

Use it in:

- `goal({ op: "get" })` output;
- checkpoint result output;
- compaction context;
- post-compaction continuation packet;
- UI/status text where a compact multiline block is appropriate.

**Acceptance criteria**

- Goal state summaries use the same terminology across tool output and compaction context.
- Checkpoint-pending summaries always identify the pending checkpoint id and valid next action.
- Completed summaries never imply work is still in progress.

### P2: Compaction re-grounding

#### 7. Implement the existing post-compaction continuation seam

**Seams**

- `packages/coding-agent/src/session/agent-session.ts`
  - `prepareGoalContinuationDispatch`
  - `#buildGoalCompactionContext`
  - compaction completion/handoff path
- `packages/coding-agent/src/prompts/goals/goal-continuation-compactor-assignment.md`
- `packages/coding-agent/src/prompts/goals/goal-compaction-context.md`

**Problem**

`prepareGoalContinuationDispatch` has a return type that includes `"post-compaction"`, but no branch currently returns it. Compaction already builds goal context, but the next continuation does not have a distinct re-grounding mode.

**Change**

- After compaction that preserves an active goal, enqueue or mark a one-shot post-compaction continuation.
- Make `prepareGoalContinuationDispatch` return `kind: "post-compaction"` for that one-shot state.
- The post-compaction packet should include the compact goal-state renderer output and explicit instructions:
  - Treat this packet as authoritative over stale transcript prose.
  - Call `goal({ op: "get" })` before ordinary work unless the state requires an immediate checkpoint-resolution action.
  - If checkpoint is pending, do not run ordinary tools; wait for/apply checkpoint guidance and resolve the checkpoint.
  - Do not infer parent completion from a closed target/checkpoint.
- Clear the one-shot marker after dispatch so normal continuation resumes.

**Acceptance criteria**

- After compaction, the next hidden goal-mode prompt is distinguishable as post-compaction re-grounding.
- The agent is directed to refresh goal state before continuing ordinary target work.
- A pending checkpoint after compaction remains a checkpoint boundary, not an ordinary continuation.

**Tests**

- Add an integration test that simulates active goal compaction and asserts the next continuation dispatch kind is `post-compaction`.
- Add a checkpoint-pending variant to assert the post-compaction guidance does not allow ordinary tool continuation.

### P3: Checkpoint-boundary UX clarity

#### 8. Separate checkpoint guidance from checkpoint resolution message types

**Seams**

- `packages/coding-agent/src/session/messages.ts`
  - checkpoint-related message type constants
- `packages/coding-agent/src/session/agent-session.ts`
  - hidden checkpoint guidance dispatch
  - visible checkpoint resolution artifact creation
- `packages/coding-agent/src/modes/interactive-mode.ts`
  - handling for checkpoint-resolution message type

**Problem**

Hidden checkpoint guidance currently uses the same custom type string as visible checkpoint resolution artifacts. That makes transcript semantics ambiguous: a guidance prompt can look like a resolution event.

**Change**

- Add a distinct constant such as `GOAL_CHECKPOINT_GUIDANCE_MESSAGE_TYPE = "goal-checkpoint-guidance"`.
- Use it only for hidden checkpoint guidance/steering prompts.
- Keep `GOAL_CHECKPOINT_RESOLUTION_MESSAGE_TYPE = "goal-checkpoint-resolution"` for actual resolution artifacts.
- Update any UI filtering/rendering logic that currently relies on the old overloaded type.

**Acceptance criteria**

- Transcript readers can tell guidance from resolution by message type alone.
- Existing visible resolution artifacts keep their current type unless migration is intentionally added.

**Tests**

- Add a session/message test that checkpoint guidance and checkpoint resolution produce distinct custom types.
- Add a UI/render-path regression if interactive mode filters either type specially.

#### 9. Make checkpoint-pending state actionability explicit

**Seams**

- `packages/coding-agent/src/tools/index.ts`
  - ordinary tool guard while goal checkpoint is pending
- `packages/coding-agent/src/goals/tools/goal-tool.ts`
  - checkpoint result text and `goal(get)` text
- `packages/coding-agent/src/modes/interactive-mode.ts`
  - goal status text
- `packages/coding-agent/src/modes/components/status-line/segments.ts`
  - compact status-line segment

**Problem**

The guard blocks ordinary tools while checkpoint is pending, but the user-visible/status text should state the only valid path forward more explicitly.

**Change**

- When `goal({ op: "checkpoint" })` succeeds, include:
  - checkpoint id;
  - parent goal remains active;
  - ordinary tools are blocked until checkpoint resolution;
  - next valid goal action is `goal({ op: "resolve_checkpoint", checkpoint_id: "..." })` after checkpoint guidance is prepared.
- When `goal({ op: "get" })` is called in checkpoint-pending state, show the same next-action line.
- Make status-line wording short but unambiguous, for example `Goal checkpoint pending: resolve <id>`.

**Acceptance criteria**

- The checkpoint result and current status both show the pending checkpoint id.
- The next valid action is visible without reading hidden guidance.
- Existing ordinary tool guard behavior remains strict.

### P4: Target aperture and decomposition

#### 10. Strengthen target-aperture prompts

**Seams**

- `packages/coding-agent/src/prompts/goals/goal-mode-active.md`
- `packages/coding-agent/src/prompts/goals/goal-continuation.md`
- `packages/coding-agent/src/prompts/tools/goal.md`
- `packages/coding-agent/src/prompts/goals/goal-rubric-assignment.md`
- `packages/coding-agent/src/prompts/goals/goal-checkpoint-guidance-assignment.md`

**Problem**

Existing instructions say targets should be bounded, but they do not strongly prevent a target whose closure standard is the whole parent goal.

**Change**

Add explicit aperture rules to static prompts:

- If the parent rubric has multiple deliverables, subsystems, or verification classes, the first target should cover one coherent deliverable cluster, not the entire rubric.
- A target is too broad when its closure standard would satisfy nearly all parent completion criteria.
- Prefer `next_target` at checkpoint resolution until every parent deliverable has accepted evidence.
- Use `parent_completion_candidate` only when remaining work is genuinely verification/closure, not when unresolved deliverables remain.
- Each target should include non-goals and forbidden parent-level claims.

Update examples in `prompts/tools/goal.md` to show a narrow target under a larger parent objective.

**Acceptance criteria**

- Goal-mode active/continuation guidance tells the model how to recognize an over-broad target.
- Tool docs show decomposition by example.
- Checkpoint guidance favors next-target selection unless parent completion is actually supported.

**Tests**

- Prompt changes do not need brittle text-snapshot tests unless existing prompt tests require updates.
- Prefer behavioral/integration coverage if goal-mode tests can assert the generated guidance contains an aperture warning in a broad-target setup.

#### 11. Add rubric-derived target slices only if prompt-only changes are insufficient

**Seams**

- `packages/coding-agent/src/goals/side-agents.ts`
  - rubric-generation schema
- Goal state shape if recommended target slices are persisted
- Goal-mode active prompt/context rendering

**Problem**

Prompt-only decomposition may still let the main agent choose one broad target. A side-agent-generated target slice list would give the controller a stronger scaffold.

**Change**

Defer this until after prompt-only changes are dogfooded. If needed:

- Extend rubric generation to return `recommendedTargetSlices` with small objects:
  - `id`
  - `title`
  - `parentContribution`
  - `closureStandard`
  - `nonGoals`
  - `evidenceExpectation`
- Store the slices in goal state or rubric metadata.
- On the first `start_target`, surface the recommended slices and require choosing or explicitly justifying a different bounded slice.

**Acceptance criteria**

- The main agent sees concrete target slices before starting work.
- Target slice metadata does not become a second rubric that can drift from the canonical parent rubric.

## Implementation Order

1. Fix `stateVersion` monotonicity.
2. Add terminal completed run mode.
3. Protect visible `goal` tool outputs from pruning.
4. Separate checkpoint guidance/resolution message types.
5. Add explicit checkpoint-pending next-action UX.
6. Split semantic snapshots from usage accounting.
7. Add compact goal-state renderer and wire it into goal output/compaction/status surfaces.
8. Implement post-compaction re-grounding.
9. Strengthen target-aperture prompts.
10. Dogfood before adding rubric-derived target slices.

This order front-loads deterministic state correctness and transcript interpretability before changing model behavior.

## Verification Plan

Run focused tests after each implementation cluster, then one package-level check.

Focused test areas:

- `packages/coding-agent/test/goals/goal-runtime.test.ts`
  - terminal run mode;
  - pause reason;
  - checkpoint pending state;
  - semantic vs accounting persistence hooks if runtime-level.
- `packages/coding-agent/test/goals/goal-tool.test.ts`
  - compact goal state output;
  - checkpoint result/get next-action text.
- `packages/coding-agent/test/goals/goal-mode-integration.test.ts`
  - create/replace with rubric state-version monotonicity;
  - post-compaction dispatch;
  - guidance/resolution message type separation.
- `packages/coding-agent/test/tools/index.test.ts`
  - ordinary tool guard remains strict while checkpoint is pending.
- Nearest `packages/agent` compaction/pruning tests
  - default protection includes visible `goal` tool output.

Commands:

```bash
bun test packages/coding-agent/test/goals/goal-runtime.test.ts \
  packages/coding-agent/test/goals/goal-tool.test.ts \
  packages/coding-agent/test/goals/goal-mode-integration.test.ts \
  packages/coding-agent/test/tools/index.test.ts
```

Run the nearest compaction/pruning test file in `packages/agent` after adding goal-output protection.

Finish with the project-standard package check for the changed package(s):

```bash
bun check
```

## Rollout and Review Strategy

- Land state-machine fixes before prompt changes so later dogfooding has reliable state surfaces.
- Keep transcript-entry schema additions backward-compatible. Restore paths must tolerate sessions without new fields or new run modes.
- Avoid adding hard semantic validation for target breadth until prompt-only changes have been observed. Breadth is model-semantic and brittle to validate in deterministic code.
- Prefer compact, explicit state surfaces over more hidden prose. If a future reader cannot tell what state the goal was in from the transcript, the implementation is not auditable enough.

## Risks and Mitigations

### Risk: usage accounting becomes less crash-accurate

Mitigation: persist compact usage deltas and fold them into restored state, or explicitly accept in-memory-only accounting only if product requirements allow it.

### Risk: new `completed` run mode breaks switch exhaustiveness

Mitigation: update all `GoalRunMode` switches and add focused tests around completion, restoration, and UI/status rendering.

### Risk: protecting goal outputs increases compacted transcript size

Mitigation: goal outputs are intentionally compact. Protect only the `goal` tool result, not side-agent transcripts or hidden prompts.

### Risk: post-compaction re-grounding creates redundant `goal(get)` calls

Mitigation: make it one-shot and conditional. Require `goal(get)` before ordinary work, but do not require it when the next mandatory action is resolving a pending checkpoint.

### Risk: prompt aperture rules over-constrain small goals

Mitigation: phrase aperture rules as conditional: if the parent goal is already one atomic deliverable, one target may cover it. The warning applies when the closure standard mirrors a multi-deliverable parent rubric.
