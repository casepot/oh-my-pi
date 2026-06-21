# Goal Mode Boundary, Target-Shape, and Throughput Execution Plan

## Objective

Make goal mode safer and faster at context boundaries.

The Screen Observer session showed two separate failure classes:

1. controller state drift at compaction boundaries;
2. excessive target-planning ceremony around undersized, same-signal target branches.

The P0 work in this plan fixes correctness first: stale compaction state, boundary auditability, full-plan prompt bloat, and contradictory todo retry guidance. Later phases add target matrices, compact target cards, repairable planning schemas, real implementation fanout, plan-depth modes, and a pinned UI target panel.

## Session Evidence

Investigated session:

- `/Users/case/.omp/agent/sessions/-projects-screen-observer/2026-06-21T07-14-16-510Z_019ee907-b33e-7000-bddc-5bbf87b2cca2.jsonl`

Observed facts:

- 5006 JSONL events.
- 55 `goal_state_snapshot` entries.
- Latest goal state: `stateVersion: 55`, `runMode: planning-target`.
- 14 compactions.
- First compaction preserve data matched `stateVersion: 8`.
- Every later compaction still carried `preserveData.goalMode.stateVersion: 8` and `goalContinuationPacket.stateVersion: 8`.
- Latest prior state before later compactions advanced through `12`, `14`, `17`, `23`, `34`, `40`, `44`, `50`, and `52`.
- Max stale preserve-data delta: `44` state versions.
- Goal usage by run mode:
  - `planning-target`: 6.77M tokens, 209.6 minutes.
  - `working-target`: 4.96M tokens, 316.1 minutes.
- 9 targets closed; target 10 was still drafting when interrupted.
- Live-scope denial work split into serial adjacent rows: revocation, expiry, unknown/mismatch, scope-client mismatch, visible revoke control.
- Two `todo-error-reminder` messages told the agent to retry `todo` while `planning-target` disallowed `todo`.

Screen Observer project rules said targets should prefer a complete acceptance slice, scenario matrix, or gate prerequisite. They also required capability/trust claims, workstreams, shared contract, review plan, verification, and commit boundary for load-bearing targets. Current goal-mode runtime and prompt surfaces did not encode those rules.

## Current Code Map

### Goal state and runtime

- `packages/coding-agent/src/goals/state.ts`
  - `GoalModeState`
  - `GoalTargetPlanRecord`
  - `GoalTargetPlanApprovedDetails`
  - `serializeGoalModeState`
  - `parseGoalModeState`

- `packages/coding-agent/src/goals/runtime.ts`
  - `GoalRuntime.#commitState`
  - `buildGoalContinuationPacket`
  - `buildGoalContextSurface`
  - `validateTargetPlanSubmissionGraph`
  - target-plan review/approval/recovery transitions

### Compaction and continuation

- `packages/coding-agent/src/goals/compaction-continuation.ts`
  - `buildGoalCompactionContext`
  - `buildGoalPostCompactionContinuation`
  - `consumeGoalPostCompactionContinuation`

- `packages/coding-agent/src/session/agent-session.ts`
  - `compact`
  - `#runAutoCompaction`
  - `#prepareCompactionFromHooks`
  - `#buildGoalCompactionContext`
  - `prepareGoalContinuationDispatch`
  - `handoff`

- `packages/agent/src/compaction/compaction.ts`
  - carries `previousPreserveData` into later compactions.

- `packages/snapcompact/src/snapcompact.ts`
  - preserves previous opaque preserveData keys while adding snapcompact archive data.

### Plan prompt/reference injection

- `packages/coding-agent/src/prompts/goals/goal-target-plan-approved.md`
- `packages/coding-agent/src/prompts/goals/goal-target-plan-reference.md`
- `packages/coding-agent/src/prompts/goals/goal-target-planning.md`
- `packages/coding-agent/src/session/agent-session.ts`
  - `renderGoalTargetPlanApprovedPrompt`
  - `#buildGoalTargetPlanReferenceMessage`
  - `requestGoalTargetPlanApproval`

### Todo/tool-policy conflict

- `packages/coding-agent/src/tools/index.ts`
  - planning-target allowlist excludes `todo`.

- `packages/coding-agent/src/session/agent-session.ts`
  - `#checkTodoCompletion` suppresses ordinary todo reminders outside working/repair modes.
  - tool-result handling still injects `todo-error-reminder` for any todo error.

## Design Principles

### Goal state has one authority

Authoritative live state is `AgentSession.#goalModeState`, mutated only through `GoalRuntime.#commitState`.

Authoritative persisted state is the latest goal `mode_change` marker plus its referenced `goal_state_snapshot`, with later `goal_usage_delta` entries applied by `session-context.ts`.

Compaction preserveData, continuation packets, handoff text, approved-plan prompts, UI cards, and todo reminders are derived boundary surfaces. They MUST never override fresher goal state.

### Boundary surfaces carry refs, not authority

Every derived boundary surface should carry a compact state ref:

```ts
interface GoalBoundaryStateRef {
	schemaVersion: 1;
	purpose: "compaction" | "handoff" | "checkpoint" | "target-plan" | "error" | "approved-plan";
	goalId: string;
	stateVersion: number;
	runMode: GoalRunMode;
	parentFrameVersion: number;
	currentTargetId?: string;
	currentTargetPlanId?: string;
	targetPlanRevision?: number;
	pendingCheckpointId?: string;
	snapshotEntryId?: string;
	capturedAt: number;
}
```

Mismatch means regenerate, skip, or fail closed. Do not continue with contradictory prose.

### Audit out of context

Boundary entropy audit is for diagnostics and future analysis. It MUST NOT inflate the LLM prompt.

Persist audit as a non-context custom entry or display-only artifact with `includeInContext: false`.

### Plans are addressable artifacts

The target plan file is the execution authority after approval. Runtime should inject plan id, revision, path, hash, byte count, target card, open blockers, and required verification signals by default. Full plan text should be read only when recovery or execution needs exact details.

### Process depth follows risk

Small local bugfixes need light plans. Trust/privacy/security/deletion/live-E2E work needs target cards, matrices, and stronger review. Same primary-signal scenario rows belong in one target unless a branch truly unblocks the larger matrix.

## Completed-State Claims

After the P0 implementation is complete:

1. Compaction preserveData for an active goal always reflects the latest live goal state at append time.
2. Stale goal-owned preserveData returned by snapcompact, default compaction, or extension hooks cannot overwrite current goal state.
3. Active-goal compaction fails closed if fresh goal preserveData cannot be produced or fails freshness checks.
4. Compaction, checkpoint, target-plan approval/rejection, and goal-related error boundaries produce non-context audit records.
5. Approved target-plan prompts and fallback reference prompts no longer inject full plan text by default.
6. Plan reference prompts carry path, hash, byte count, target id, plan id, and revision.
7. A todo error while `todo` is disallowed by goal run mode does not inject a retry reminder telling the agent to call `todo` again.
8. Post-compaction continuation is reachable during `planning-target` instead of being shadowed by the normal planning prompt.

## Implementation Plan

## P0: Correctness and boundary safety

### P0.1 Protect goal-owned compaction preserveData

**Problem**

`buildGoalCompactionContext` builds fresh `goalMode` and `goalContinuationPacket`, but compaction result preserveData can carry old goal keys forward. Current merge order lets stale result keys overwrite fresh goal keys.

**Change**

- Define goal-owned preserve keys:
  - `goalMode`
  - `goalContinuationPacket`
  - `goalBoundaryRef`
- Strip those keys from compactor/extension preserveData before merge.
- Overlay freshly generated goal preserveData last.
- Add append-time freshness validation.

**Acceptance criteria**

- Repeated compactions after target transitions preserve the latest stateVersion.
- Snapcompact/default compaction result with stale prior goal keys cannot win.
- Terminal/inactive goals do not keep stale goal keys in new compactions.
- Mismatch before append throws instead of persisting contradictory state.

**Focused tests**

- `refreshes goal preserveData after multiple target transitions`.
- `strips stale goal preserveData after terminal goal`.
- `rejects stale active-goal preserveData before append`.

### P0.2 Make post-compaction continuation reachable in planning mode

**Problem**

`prepareGoalContinuationDispatch` handles `planning-target` before consuming post-compaction continuation. A compaction during planning emits the normal target-planning prompt first and can leave the post-compaction continuation unused.

**Change**

- Consume `#goalPostCompactionContinuation` before the `planning-target` branch.
- Keep stale packet discard behavior by stateVersion.

**Acceptance criteria**

- Compaction during `planning-target` produces `kind: "post-compaction"` once.
- Stale continuation packet is discarded.

### P0.3 Add boundary entropy audit

**Problem**

The session had multiple independent state surfaces: snapshots, compaction preserveData, continuation packets, prompt injections, plan references, and reminders. There was no compact audit of preserved/stale/omitted fields.

**Change**

Add `goal_boundary_audit` custom entries with:

- `stateVersion` before/after
- `runMode` before/after
- current target id
- current plan id/revision
- preserved fields
- stale fields
- omitted fields
- recovery instruction
- action taken

**Acceptance criteria**

- Audits are stored as `type: "custom"`, not prompt context.
- Compaction success records preserved/stale/omitted fields.
- Checkpoint commit/rejection records before/after refs.
- Target-plan approval/rejection/stale records before/after refs.
- Goal-related tool/error conflict records recovery instruction.

### P0.4 Stop full-plan injection by default

**Problem**

Approved-plan and fallback-reference prompts inject the full plan body. Plans are already local artifacts. Full text duplicates state, increases compaction pressure, and can compete with fresher state after transitions.

**Change**

- Extend `GoalTargetPlanApprovedDetails` with optional revision/hash/bytes/stateVersion fields.
- Render approved prompt with plan reference metadata, not full plan content.
- Render fallback reference with the same metadata.
- Instruct: read the plan file only if recovery/execution needs exact details.

**Acceptance criteria**

- Approved prompt contains plan path/hash/bytes/id/revision.
- Approved prompt does not contain full plan body.
- Fallback reference prompt does not contain full plan body.
- Stale plan reference is skipped and audited.

### P0.5 Fix todo retry conflict

**Problem**

Planning mode blocks `todo`, but a failed todo call injects a hidden retry reminder requiring `todo` again.

**Change**

- If active goal run mode disallows todo, suppress `todo-error-reminder`.
- Log a boundary audit with action `skipped` and recovery `follow goal run-mode policy`.
- Keep retry reminder for real todo payload errors in `working-target`.

**Acceptance criteria**

- `todo` error in `planning-target` produces no retry custom message.
- `todo` error in `working-target` still produces retry custom message.

## P1: Target shape and repairable planning

### Add target-unit rules

Store structured project/domain target-unit rules on the goal. Checkpoint guidance should actively extract them from repo/project context and controller history.

Target selection and plan submission should carry target-unit rule ids or an explicit exemption.

### Add signal groups and scenario matrix

Add `primary_signal_group_id` and `scenario_matrix` to target plan submissions.

Matrix-required targets must list:

- primary product signal;
- rows in scope;
- rows left open;
- why splitting is safe;
- next larger target when this branch is a blocker.

### Add compact target card

Persist a small target card with:

- capability claim;
- trust/privacy claim when relevant;
- confidence earned;
- known limits;
- authority boundary;
- policy/deletion implications when relevant;
- user-visible surface;
- rows closed/open;
- workstreams;
- shared contract;
- review lenses;
- verification scenarios;
- checkpoint evidence;
- rollback/cutover when relevant.

Fields are conditional by plan depth and risk axes.

### Add `goal({ op: "lint_target_plan" })`

Static planning preflight:

- schema/enums;
- signal/concern references;
- excluded work;
- matrix rows;
- target card fields;
- target-unit rules;
- repair lineage.

No side agents. No state transition. No revision advancement.

### Return actionable repairs

Diagnostics should include:

- offending item;
- matched same-signal concern or acceptance row;
- suggested action;
- JSON pointer path;
- optional structured repair patch.

Static lint failures should not burn reviewer/rejection cap.

## P1: Throughput changes

After target-plan approval, default to implementation fanout for multi-subsystem targets:

- Main owns shared contract and final integration.
- Backend/Rust workstream.
- App/UI workstream.
- E2E harness/probe workstream.
- Docs/changelog only after behavior works.
- Main runs final verification and checkpoint.

Review should be bundled by matrix, not branch.

For live-inspection denial matrix:

- one behavior/security reviewer across all rows;
- one harness maintainability reviewer;
- convergence reviewer only if fixes were significant.

## P2: Planning-depth and UI tuning

### Plan depth modes

- `light`: single-file/docs/test-only; target card + commands.
- `standard`: multi-file feature; target card + implementation steps.
- `trust-heavy`: privacy/security/policy/deletion/live E2E; full target card + matrix + reviewers.

### Process imbalance detection

Warn when:

- planning spans multiple compactions;
- plan/review tokens exceed implementation on a one-row target;
- same primary signal repeats across serial targets;
- review churn repeats the same finding;
- approved plan has independent workstreams but no implementation fanout.

### Pinned UI target panel

Always visible:

- runMode;
- target id;
- target plan id;
- revision;
- plan path;
- allowed tools;
- next legal actions;
- pending checkpoint id;
- stateVersion;
- plan depth;
- matrix row counts;
- unresolved diagnostics;
- compaction freshness.

## Migration Strategy

- Keep v4 goal-state parsing.
- Introduce new fields as optional first.
- Serialize new state with bumped schema only when structural fields are added.
- For legacy target plans, synthesize implicit target card and primary signal group for display.
- Do not invalidate historical approved/closed targets.
- Roll out lint in non-mutating mode before enforcing new matrix/card rules.

## Verification Plan

P0 focused verification:

- `bun test packages/coding-agent/test/goals/goal-mode-integration.test.ts`
- `bun test packages/coding-agent/test/agent-session-todo-reminder-loop.test.ts`
- `bun check`

P1/P2 later verification:

- goal runtime unit tests for schema normalization and lint diagnostics;
- goal tool tests for `lint_target_plan`;
- integration tests for target-unit rule enforcement;
- UI renderer tests for pinned target panel;
- manual Screen Observer-style live-denial matrix run.

## Rollout Order

1. P0 compaction freshness and audit.
2. P0 todo conflict and full-plan reference reduction.
3. Plan hash/card metadata.
4. `lint_target_plan` diagnostics collector.
5. Target-unit rules and scenario matrix.
6. Workstream fanout prompt and review bundling.
7. Plan-depth modes.
8. Pinned target panel and process-imbalance warnings.

## Open Design Decisions

1. Whether boundary audit deserves a dedicated entry type or remains `CustomEntry`.
2. Whether full approved-plan injection should remain behind a temporary setting for one release.
3. Whether target-unit rules should be extracted only by rubric/checkpoint side-agents or also by a deterministic context scanner.
4. Whether target-plan review should become one bundled matrix reviewer or keep two reviewers with a shared matrix input.
5. Whether process-imbalance warnings should become hard lint failures for trust-heavy targets.
