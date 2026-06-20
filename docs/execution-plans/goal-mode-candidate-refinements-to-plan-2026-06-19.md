# Goal Mode Candidate Refinements To Plan

## Status

Candidate backlog. Not an approved implementation plan yet.

This document records small, high-leverage goal-mode refinements from a workflowz ideation pipeline:

1. code scout across goal runtime, tool, session, prompt, and TUI seams;
2. independent ideation passes for UX/continuation, verification/evidence, prompt surface, and target lifecycle;
3. adversarial review for correctness, simplicity, and behavior impact;
4. synthesis into candidate changes worth planning.

Consensus: prefer mechanical state-machine and validation guards over additional prompt prose. Prompt changes should expose authoritative runtime state, not create a second policy source.

## Candidate 1: Make `budget-limited` a hard stop for ordinary tools

### Problem

When a goal exhausts its budget, the runtime flips `goal.status` to `"budget-limited"` and sends a hidden budget-limit steer. After that one steer, ordinary goal context stops rendering because active/continuation prompts require `goal.status === "active"`.

The ordinary tool guard has the same active-only check, so normal tools are no longer blocked once the goal is budget-limited. That makes it possible for the agent to keep doing substantive work after the goal state says budget is exhausted.

### Candidate change

- Treat `budget-limited` as an accounting-active but work-blocking goal state.
- Block ordinary tools while `goal.status === "budget-limited"`.
- Keep goal-control exits available: `goal`, `yield`, and any explicit budget/drop/resume path.
- Render budget-limit guidance on later turns until the user changes budget, drops/replaces the goal, or parent completion is legitimately verified.
- Do not auto-resume budget-limited work through ordinary continuation.

### Affected seams

- `packages/coding-agent/src/goals/runtime.ts`
  - `buildActivePrompt`
  - `buildContinuationPrompt`
  - budget-limit status transitions and `#sendBudgetLimitSteer`
- `packages/coding-agent/src/tools/index.ts`
  - `goalRunModeBlockMessage`
  - `GOAL_CONTROL_ALLOWED_TOOLS`
- `packages/coding-agent/src/goals/tools/goal-tool.ts`
  - allowed goal operations while budget-limited

### Acceptance criteria

- A budget-limited goal cannot run ordinary tools by default.
- `goal({ op: "get" })`, budget adjustment, drop, and yield remain usable.
- Later turns still see explicit budget-limit context instead of falling back to ordinary non-goal behavior.
- Raising/removing the budget returns the goal to active accounting/work state through one explicit path.

### Focused tests

- Tool guard test: ordinary tool rejected when goal status is `budget-limited`.
- Goal tool test: `get`, budget mutation, and drop still work while budget-limited.
- Runtime/session test: budget-limit prompt/context remains available after the first steer.

### Planning risk

Blocking ordinary tools can block unrelated user work if a budget-limited goal remains enabled. The escape hatch must be visible and explicit.

## Candidate 2: Fail closed on inconsistent verifier and reviewer outputs

### Problem

The side-agent parsers preserve `status: "verified"` and `status: "accepted"` while normalizing missing or malformed evidence fields to empty arrays. Parent completion then completes on `verification.status === "verified"`. Checkpoint commit only checks `review.status === "accepted"`.

A malformed, lazy, or overconfident side-agent response can therefore close a parent goal or target without current evidence.

### Candidate change

Add semantic validation after parsing side-agent output and before committing state.

For parent completion, a `verified` result should require:

- at least one current evidence item;
- no blocking or important completion blockers;
- if a deliverable map exists, every known deliverable id is present and `passed`;
- evidence for passed deliverables when deliverable results are present.

For checkpoint review, an `accepted` result should require:

- at least one current evidence item in `evidenceChecked`;
- no blocking or important blockers.

Prefer converting inconsistent side-agent output into rejected feedback over throwing from the user-facing flow.

### Affected seams

- `packages/coding-agent/src/session/agent-session.ts`
  - `parseGoalCheckpointReviewerOutput`
  - `parseGoalCompletionVerifierOutput`
  - `requestGoalCompletion`
  - checkpoint request/commit path
- `packages/coding-agent/src/goals/runtime.ts`
  - `commitCheckpoint`
  - completion verification record paths
- `packages/coding-agent/src/goals/side-agents.ts`
  - output schemas remain permissive at JSON shape level but stricter semantically after parse

### Acceptance criteria

- `verified` with empty current evidence does not complete the parent goal.
- `verified` with failed/unknown/missing known deliverables does not complete the parent goal.
- `verified` with blocking/important blockers is treated as rejected.
- `accepted` checkpoint review with no current evidence does not commit.
- `accepted` checkpoint review with blocking/important blockers does not commit.
- Valid no-deliverable-map goals remain completable if current evidence exists and no blockers exist.

### Focused tests

- Completion verifier returns `verified` plus empty evidence: goal remains active and verifier feedback is surfaced.
- Completion verifier returns `verified` plus failed known deliverable: goal remains active.
- Checkpoint reviewer returns `accepted` plus no evidence: checkpoint is not committed.
- Existing happy-path verified completion still completes.

### Planning risk

Over-strict checks can false-reject simple goals without deliverable maps. Gate deliverable-id checks only when a deliverable map exists; keep the universal check to current evidence plus no blockers.

## Candidate 3: Validate checkpoint resolution before mutating parent truth

### Problem

`recordCheckpointResolution` applies `parentDelta` directly. Evidence refs are optional on admitted claims, passed gates, and deliverable deltas. A resolution can mark deliverables satisfied or move to `parent_completion_candidate` without proving the parent deliverable map is actually satisfied.

This is the main laundering seam between “target closed with evidence” and “parent goal complete enough to verify.”

### Candidate change

Add a small runtime validation helper before applying checkpoint-resolution deltas.

Require evidence refs for truth-advancing mutations:

- `admittedClaims`;
- `gateDeltas` whose status becomes `passed`;
- `deliverableDeltas` whose status becomes `satisfied`.

For `decision: "parent_completion_candidate"`:

- compute post-delta deliverable statuses;
- if a deliverable map exists, require every deliverable to be `satisfied`;
- keep the existing verifier-repair blocker check.

Evidence refs may point to checkpoint evidence, external records, or authority decisions. This path should validate that refs exist, not re-prove their content.

### Affected seams

- `packages/coding-agent/src/goals/runtime.ts`
  - `recordCheckpointResolution`
  - parent-delta application helpers
  - deliverable-delta application
- `packages/coding-agent/src/goals/state.ts`
  - `GoalParentStateDelta`
  - `GoalGateDelta`
  - `GoalDeliverableDelta`
- `packages/coding-agent/src/goals/tools/goal-tool.ts`
  - resolution schema/error text as needed

### Acceptance criteria

- Parent accepted claims cannot be admitted without evidence refs.
- Gates cannot be marked passed without evidence refs.
- Deliverables cannot be marked satisfied without evidence refs.
- Parent-completion candidate is rejected while any known deliverable remains pending, partial, blocked, or stale after applying the delta.
- Plain goals without deliverable maps are not blocked by deliverable-map gating.

### Focused tests

- `resolve_checkpoint` with admitted claim and no evidence ref fails.
- `resolve_checkpoint` with satisfied deliverable and no evidence ref fails.
- `parent_completion_candidate` fails when a known deliverable remains unsatisfied.
- Authority/external evidence refs satisfy the evidence-ref requirement.

### Planning risk

Some valid decisions are authority-driven rather than checkpoint-evidence-driven. The validation should accept authority/external refs and reject only unreferenced truth advancement.

## Candidate 4: Remove the parent-completion verifier bypass

### Problem

The public goal contract says parent completion goes through the independent verifier. `GoalTool.execute` falls back to `runtime.completeGoalFromTool()` when the session does not provide `requestGoalCompletion`, which directly marks the goal complete.

That fallback creates a completion path with no verifier.

### Candidate change

- Make `GoalTool.execute` throw `ToolError` when `requestGoalCompletion` is missing for `op: "complete"`.
- Keep `GoalRuntime.completeGoalFromTool()` as an internal post-verifier state transition used by `AgentSession.requestGoalCompletion` after successful verification.
- Update tests/custom harnesses to install a verifier-backed completion handler instead of relying on runtime-only completion.

### Affected seams

- `packages/coding-agent/src/goals/tools/goal-tool.ts`
  - `GoalTool.execute`
- `packages/coding-agent/src/goals/runtime.ts`
  - `completeGoalFromTool`
- `packages/coding-agent/src/session/agent-session.ts`
  - `requestGoalCompletion`

### Acceptance criteria

- `goal({ op: "complete" })` cannot complete without a completion-verification handler.
- AgentSession completion still runs verifier and only commits completion on `verified`.
- Tests that need completion either mock `requestGoalCompletion` or call runtime internals explicitly for state-machine unit coverage.

### Focused tests

- GoalTool without `requestGoalCompletion` returns/throws a `ToolError` on `complete`.
- GoalTool with AgentSession handler invokes verifier flow.
- Rejected verifier output leaves goal active and in repair flow.

### Planning risk

Runtime-level tests may currently depend on the fallback. That is test harness coupling, not desired product behavior.

## Candidate 5: Add authoritative controller surface to checkpoint continuation

### Problem

Normal active and continuation prompts include a rendered goal context surface. Checkpoint-resolution continuation uses `goal-checkpoint-controller.md` plus side-agent guidance and a continuation packet, but not the fresh rendered controller surface.

The exact legal next action can be buried in side-agent prose.

### Candidate change

- Include the current `renderGoalPromptSurface(state, goal)` in checkpoint-controller continuation.
- Place it before side-agent guidance.
- Optionally add a minimal runtime-derived `action_now` object to the surface.
- If `action_now` is added, make it replace or clarify `policy.now`/mode-specific `requiredAction`; do not let side-agent text author it.

Candidate `action_now` examples:

- working target with no active target: `goal.start_target`;
- active target: continue target work, checkpoint only after closure-standard evidence;
- awaiting checkpoint resolution: `goal.resolve_checkpoint` for pending checkpoint id;
- awaiting parent completion: `goal.complete`;
- awaiting verifier repair: repair current verifier blockers;
- awaiting user input: stop ordinary work and wait.

### Affected seams

- `packages/coding-agent/src/session/agent-session.ts`
  - `#prepareGoalCheckpointGuidancePrompt`
- `packages/coding-agent/src/goals/runtime.ts`
  - `buildGoalContextSurface`
  - `renderGoalPromptSurface`
- `packages/coding-agent/src/prompts/goals/goal-checkpoint-controller.md`

### Acceptance criteria

- Checkpoint-resolution continuation includes a fresh controller surface with the pending checkpoint id.
- The first required action is mechanically derived from runtime state.
- Side-agent guidance can explain tradeoffs but cannot override the runtime-derived legal action.
- Existing active/ordinary continuation prompts do not gain redundant conflicting action fields.

### Focused tests

- Checkpoint continuation dispatch contains controller surface and pending checkpoint id.
- Surface snapshots for each run mode include the correct legal next action.
- No full checkpoint evidence body is duplicated into prompt context beyond existing compact refs.

### Planning risk

Adding another action field can create prompt drift. Keep one authoritative runtime-derived representation and avoid parallel prose policies.

## Candidate 6: Validate target deliverable ids and avoid already-satisfied apertures

### Problem

`targetFromInput` copies `parentDeliverableIds` without validating that ids exist or that the selected aperture still needs work.

Agents can start targets tied to unknown deliverables or only already-satisfied deliverables while unsatisfied deliverables remain.

### Candidate change

When a deliverable map exists:

- reject unknown `parentDeliverableIds`;
- reject targets whose supplied deliverable ids are all already `satisfied` while other deliverables remain unsatisfied;
- allow no ids for genuinely cross-cutting targets;
- allow satisfied-id targets when explicitly linked to verifier repair, stale-evidence refresh, or blocked/regression-proofing semantics.

Prefer validation over more rubric prompt output. If guidance is needed, expose a compact generated hint from existing deliverable map data.

### Affected seams

- `packages/coding-agent/src/goals/runtime.ts`
  - `startTarget`
  - checkpoint-resolution next-target creation
  - `targetFromInput`
- `packages/coding-agent/src/goals/state.ts`
  - `GoalTarget.parentDeliverableIds`
  - deliverable status model
- `packages/coding-agent/src/goals/tools/goal-tool.ts`
  - start-target validation error messages

### Acceptance criteria

- Unknown parent deliverable ids are rejected.
- Already-satisfied-only target aperture is rejected when unsatisfied deliverables remain.
- Cross-cutting targets remain possible without deliverable ids.
- Verifier-repair targets can intentionally revisit satisfied deliverables when linked to current blockers.

### Focused tests

- `start_target` rejects unknown deliverable id.
- `start_target` rejects only-satisfied ids while another deliverable is pending.
- `resolve_checkpoint` next target gets the same validation.
- Verifier-repair target with blocker links remains allowed.

### Planning risk

Some goals are not cleanly decomposed by deliverable id. Keep id validation strict only when ids are supplied and map exists; do not require ids for every target.

## Candidate 7: Fast-path ordinary working-target continuation

### Problem

Plain working-target continuation falls through to `#buildGoalContinuationMessage`, which runs a continuation side agent. That is valuable for checkpoint, verifier, compaction, or stale-feedback handoffs, but routine working-target continuation already has the rendered goal continuation prompt and controller surface.

The side-agent call adds latency, timeout risk, usage, and another hidden failure that can suppress continuation.

### Candidate change

Use direct `renderGoalPrompt("continuation", goal, state)` for the boring path:

- run mode is `working-target`;
- no pending checkpoint;
- no verification repair;
- no verifier feedback/compactor memo needing handoff;
- no post-compaction packet.

Keep side-agent-backed preparation for semantically meaningful handoffs:

- checkpoint resolution;
- parent completion;
- verifier repair;
- post-compaction re-grounding;
- recent verifier feedback with continuation focus.

Do not add a state-version cache unless it also handles transcript/session-entry invalidation; ordinary side-agent output is transcript-derived, not solely goal-state-derived.

### Affected seams

- `packages/coding-agent/src/session/agent-session.ts`
  - `prepareGoalContinuationDispatch`
  - `#buildGoalContinuationMessage`
- `packages/coding-agent/src/goals/runtime.ts`
  - `renderGoalPrompt("continuation")`
- `packages/coding-agent/src/modes/interactive-mode.ts`
  - continuation scheduling/failure behavior only if status messaging changes

### Acceptance criteria

- Routine working-target auto-continuation does not invoke the continuation side agent.
- Checkpoint, verifier-repair, parent-completion, and post-compaction paths still use specialized handoff logic.
- No-tool/failed continuation suppression remains intact.

### Focused tests

- Ordinary working-target continuation returns direct continuation prompt and does not call side-agent runner.
- Verifier feedback path still calls/uses specialized continuation focus.
- Checkpoint-resolution continuation still calls checkpoint-guidance side agent.

### Planning risk

Long-running targets may benefit from transcript-aware coaching. Keep the fast path limited to ordinary, no-feedback continuation and leave richer handoffs side-agent-backed.

## Candidate 8: Add universal `/goal continue`

### Problem

Goal auto-continuation can be suppressed after preparation failure or no-tool continuation. Manual menu recovery exists for checkpoint-resolution and parent-completion modes, but not for ordinary working-target or verifier-repair continuation.

The operator needs one deterministic “continue this goal now” action.

### Candidate change

- Add `/goal continue`.
- Add one generic goal-menu item for active goals when run mode is not `awaiting-user-input` and status is not `budget-limited`.
- Implement through a shared helper:
  - resume paused goal if needed;
  - reset continuation suppression;
  - schedule continuation through existing guards;
  - refuse when editor is non-empty, streaming/busy, awaiting user input, or budget-limited.
- Avoid separate per-mode menu branches except for status wording.

### Affected seams

- `packages/coding-agent/src/modes/interactive-mode.ts`
  - `GoalSubcommand`
  - `GOAL_SUBCOMMANDS`
  - `#dispatchGoalSubcommand`
  - `#openGoalMenu`
  - `#resetGoalContinuationSuppression`
  - `#scheduleGoalContinuation`

### Acceptance criteria

- `/goal continue` exists and is listed/accepted as a subcommand.
- User can manually continue active working-target, checkpoint-resolution, parent-completion, and verifier-repair states.
- Command refuses `awaiting-user-input` and `budget-limited` states with clear status text.
- Command does not bypass in-flight, editor-nonempty, or busy guards.

### Focused tests

- `/goal continue` schedules continuation for working-target after suppression.
- `/goal continue` schedules verifier-repair continuation after rejected completion.
- Menu item schedules checkpoint and parent-completion continuations through the same helper.
- Awaiting-user-input and budget-limited states refuse continuation.

### Planning risk

Explicit continue could restart work the user meant to pause. Keep it user-invoked only and blocked in states where the correct next action is external input or budget adjustment.

## Suggested planning order

1. Plan and implement mechanical safety gates first:
   - budget-limited hard stop;
   - fail-closed verifier/reviewer validation;
   - checkpoint-resolution parent-delta validation;
   - completion verifier bypass removal.
2. Then plan state-surface and target-aperture refinements:
   - checkpoint controller surface;
   - target deliverable-id validation.
3. Then plan reliability/UX improvements:
   - ordinary continuation fast path;
   - universal `/goal continue`.

This order reduces wrong-work risk before improving convenience or latency.
