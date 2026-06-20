# Goal Mode Load-Bearing Context Surface Execution Plan

## Objective

Reduce goal-mode prompt/context growth by rendering a load-bearing controller surface instead of an archive-shaped state snapshot.

The goal context should answer four questions:

1. What is the parent goal?
2. What may the agent do now?
3. What parent truth has been accepted?
4. Which target/evidence boundary is active?

It should not be a full checkpoint archive, repeated goal-tool manual, or historical resolution log. Full state remains available through structured tool details, side-agent artifacts, and verifier inputs.

## Source Evidence

Session analyzed:

- `/Users/case/.omp/agent/sessions/-projects-external-oh-my-pi/2026-06-08T00-41-53-137Z_019ea4ad-c8f1-7000-bd9b-a805aaca9510.jsonl`

Observed goal-mode context growth:

| Context line | JSON tokens | YAML no-wrap tokens | Main content |
| ---: | ---: | ---: | --- |
| 6 | 2,111 | 1,946 | initial deliverable map |
| 238 | 2,538 | 2,329 | current target added |
| 277 | 3,799 | 3,444 | pending checkpoint packet added |
| 851 | 5,679 | 5,071 | parent claims + latest resolution |
| 1110 | 6,420 | 5,776 | more accepted claims |
| 1270 | 6,642 | 5,989 | larger checkpoint packet |
| 1554 | 7,319 | 6,346 | D7 checkpoint packet + accepted claims |

Latest line `1554` breakdown:

| Section | Tokens | Notes |
| --- | ---: | --- |
| Preamble | 32 | fixed |
| Full objective | 220 | small, load-bearing |
| State header | 24 | fixed |
| Structured snapshot | 6,123 | main bloat |
| Fixed footer/policy | 905 | repeated tutorial text |

Latest structured snapshot breakdown:

| Snapshot part | Tokens | Cause |
| --- | ---: | --- |
| `parentFrame` | 1,678 | cumulative accepted claims |
| `deliverableMap` | 1,103 | full 9-item map every turn |
| `currentTarget` | 497 | active target aperture |
| `pendingCheckpoint` | 1,555 | full latest checkpoint packet |
| `latestCheckpointResolution` | 1,198 | includes duplicate `nextTarget` |

YAML alone saves about 10%. Structural changes save much more. Simulated conservative structural cuts on the latest context reduce about `7,319 -> 5,096` tokens before footer compaction.

## Load-Bearing Contract

A context field is load-bearing if removing it increases risk that the agent will:

- work on the wrong parent objective;
- continue local implementation while a controller action is required;
- confuse target closure with parent completion;
- mutate parent truth through prose instead of `goal.resolve_checkpoint.parent_delta`;
- forget the active target's closure standard, non-goals, or stale-if conditions;
- lose accepted parent truth needed for subsequent targets;
- choose a next target outside unresolved deliverables;
- retry parent completion without fresh verifier-blocker repair evidence.

Everything else is audit detail and should be fetchable, not always-on.

### Cannot remove

- Parent goal id/status and exact objective.
- Run mode, state version, parent-frame version, allowed action, blocked actions.
- Current target desired claim, closure standard, parent deliverable ids, evidence expectation, non-goals, forbidden claims, stale-if.
- Deliverable ids/statuses and enough summary/hint to choose future work.
- Accepted parent truth: claim ids, claim statements or compact truth labels, evidence refs, active boundaries/non-implications.
- Pending checkpoint id, target, summary, bounded local claims, not-claimed, remaining questions, and required controller action while awaiting resolution.
- Verifier repair blockers when `awaiting-verification-repair`.
- Explicit invariant: target closure is not parent completion.

### Can definitely remove or compact

- Empty arrays/objects/nulls.
- `latestCheckpointResolution.nextTarget` when it equals `currentTarget`.
- Full checkpoint evidence strings in always-on context when checkpoint guidance/tool details can provide the audit packet.
- Full `evidenceChecked` review lists in always-on context.
- Full summaries/next hints for satisfied deliverables not related to current work.
- Generic goal-tool tutorial repeated in every prompt.
- Resolution fields that duplicate already-applied parent frame/deliverable map truth.

### Think carefully before compacting

- Accepted claim text.
- Deliverable summaries.
- Current target closure standard.
- Checkpoint `notClaimed` and remaining work.
- Parent boundaries/residuals.

These are the fields that prevent goal drift and overclaim.

## Desired Prompt Surface

Render a role-specific controller surface, not the serialized state object.

```yaml
<goal_context>
goal:
  id: 150079f2a227e106
  status: active
  objective: |
    implement this plan @docs/execution-plans/context-maintenance-provider-call-barrier.md
    Make compaction resilient when a long-running agent turn crosses the provider context limit between tool calls.
  invariant: Target closure is not parent completion; parent completion requires verifier acceptance.

run:
  mode: working-target
  stateVersion: 15
  parentFrameVersion: 4
  allowed:
    - continue current target
    - checkpoint only after closure evidence
  blocked:
    - checkpoint partial work
    - treat target closure as parent completion

deliverables:
  active_or_partial:
    - id: D7
      status: partial
      summary: Single-flight priority-aware auto-compaction scheduling.
      evidenceRefs: [checkpoint:...]
      next: Implement coalescing priorities.
  pending:
    - id: D8
      summary: Remote compaction abort/timeout classification.
      next: Thread timeout/signal composition.
  satisfied:
    - id: D2
      label: Agent event acknowledgement barrier.
      evidenceRefs: [checkpoint:...]

parent_truth:
  accepted:
    - id: coding-agent-materialized-provider-context-estimator
      claim: Provider-call and pre-prompt maintenance share the materialized-context estimator with provider usage floor.
      evidenceRefs: [checkpoint:...]
  boundaries:
    - Target evidence is not parent completion.
  residuals: []

current_target:
  id: ...
  title: ...
  parentDeliverableIds: [D7]
  desiredFutureClaim: ...
  closureStandard: ...
  evidenceExpectation: [...]
  nonGoals: [...]
  forbiddenClaims: [...]
  staleIf: [...]

checkpoint:
  # only when awaiting-checkpoint-resolution
  id: ...
  targetTitle: ...
  reviewStatus: accepted
  summary: ...
  localClaims: [...]
  notClaimed: [...]
  remainingQuestions: [...]
  requiredAction: resolve_checkpoint

latest_resolution:
  id: ...
  decision: next_target
  parentReading: ...
  admittedClaimIds: [...]
  deliverableDeltas: [...]
  notPropagated: [...]
  remainingParentWork: [...]
  nextTargetId: currentTarget.id

verifier_repair:
  # only when awaiting-verification-repair
  attempt: ...
  blockers:
    - id: ...
      deliverableId: ...
      problem: ...
      requiredEvidenceOrFix: ...

refs:
  fullState: goal({op:"get"})
  checkpointDetails: goal({op:"get"}) by checkpoint id
</goal_context>
```

## Implementation Plan

### P0: Split audit snapshot from prompt surface

**Seams**

- `packages/coding-agent/src/goals/runtime.ts`
  - `renderGoalStateSnapshot`
  - `renderGoalPrompt`
  - `compactParentFrame`
  - `compactDeliverableMap`
  - `compactTarget`
  - `compactCheckpoint`
  - `compactResolution`
- `packages/coding-agent/src/prompts/goals/goal-mode-active.md`
- `packages/coding-agent/src/prompts/goals/goal-continuation.md`
- `packages/coding-agent/src/prompts/goals/goal-post-compaction-continuation.md`

**Problem**

`renderGoalStateSnapshot` currently serves two different jobs:

1. audit/fetch state for tools and side agents;
2. always-on prompt context for the main agent.

The prompt path should not inherit every audit field.

**Change**

- Keep a full/audit renderer for side-agent artifacts and `goal get` details.
- Add a prompt-specific renderer, for example:
  - `renderGoalPromptSurface(state, goal)`;
  - `buildGoalContextSurface(state, goal)`;
  - `GoalContextSurface` type local to `runtime.ts` or exported for tests.
- `renderGoalPrompt` should use the prompt surface, not the audit snapshot.
- Keep side-agent `goalStateFile` and verifier paths on full state unless separately compacted for their own contracts.

**Acceptance criteria**

- Main-agent `goal-mode-context` no longer contains full checkpoint evidence packets by default.
- Side-agent/verifier artifacts still have enough state to review/verify.
- `goal({op:"get"})` details remain the full machine-readable state.

**Tests**

- Extend `packages/coding-agent/test/goals/goal-runtime.test.ts`:
  - prompt surface omits rubric;
  - prompt surface omits `targetSnapshot`;
  - prompt surface omits full checkpoint evidence when awaiting resolution;
  - full/audit state path still contains checkpoint details where expected.

### P0: Render by run mode

**Seams**

- `runtime.ts`
  - new prompt-surface builder;
  - `allowedActsForRunMode`;
  - `disallowedActsForRunMode`.
- goal prompt templates listed above.

**Problem**

The current context renders the same broad snapshot and generic policy for every run mode.

**Change**

Build one prompt surface with a common header plus exactly one active action surface:

- `working-target`: full current target; compact deliverables; compact parent truth; no full latest checkpoint packet.
- `awaiting-checkpoint-resolution`: checkpoint summary, bounded local claims, not-claimed, remaining questions, required action; no implementation tutorial.
- `awaiting-parent-completion`: parent completion audit surface; no implementation target.
- `awaiting-verification-repair`: verifier blockers and linked repair/evidence target hints.
- `awaiting-user-input` / `awaiting-background-lane-intake`: only blocked reason, required input/lane state, and allowed next actions.

**Acceptance criteria**

- `awaiting-checkpoint-resolution` context contains `requiredAction: resolve_checkpoint` and no broad `working-target` instruction.
- `working-target` context contains the full active target closure standard and no full checkpoint packet.
- `awaiting-verification-repair` context contains verifier blockers and does not invite unrelated work.

### P0: Remove duplicate and empty prompt fields

**Seams**

- `runtime.ts`
  - `compactResolution`
  - `compactTarget`
  - prompt-surface serializer.

**Problem**

The latest resolution repeats the full `nextTarget` while the same object is also `currentTarget`. Many empty arrays/objects are emitted.

**Change**

- In prompt surface, replace duplicate `latest_resolution.nextTarget` with `nextTargetId` and maybe `nextTargetTitle` only when no `currentTarget` is present.
- Omit empty arrays, empty objects, `undefined`, and `null` from the prompt surface.
- Keep full values in machine state/tool details.

**Acceptance criteria**

- If `latestResolution.nextTarget.id === currentTarget.id`, the prompt surface contains no duplicated full target object.
- Prompt snapshot does not render empty arrays like `baselineRefs: []` or `candidateClaimIds: []`.

### P0: Compact pending checkpoint surface

**Seams**

- `runtime.ts`
  - `compactCheckpoint` or new `compactCheckpointForPrompt`.
- `packages/coding-agent/src/session/agent-session.ts`
  - checkpoint guidance dispatch uses full packet separately.

**Problem**

`pendingCheckpoint` in the always-on prompt includes the full audit packet. Latest observed packet cost was about `1,555` tokens.

**Change**

For prompt context, render:

```ts
{
  id,
  sequence,
  targetId,
  targetTitle,
  reviewStatus,
  summary,
  localClaims,
  notClaimed,
  remainingQuestions,
  risksOrCaveats?: summarized,
  staleIf?: idsOrShortList,
}
```

Do not render in always-on prompt:

- full `evidence` strings;
- full `checksRun` list unless no guidance exists;
- full `artifactsTouched` list unless needed for immediate controller action;
- `review.evidenceChecked` list;
- full `targetSnapshot`.

**Acceptance criteria**

- Checkpoint-resolution prompt has enough information to preserve bounded truth and call `resolve_checkpoint`.
- Full evidence remains available to checkpoint guidance and `goal get` details.
- Prompt token cost drops by roughly 1k tokens in a synthetic multi-checkpoint test.

### P1: Compact deliverables by status

**Seams**

- `runtime.ts`
  - `compactDeliverableMap` or new `compactDeliverablesForPrompt`.

**Problem**

All deliverables render full summaries and next hints forever. Latest observed map cost was about `1,103` tokens.

**Change**

Render grouped deliverables:

- `active_or_partial`: full summary, evidence refs, blockers, next hint.
- `pending`: id, summary, next hint.
- `satisfied`: id, short label, evidence refs; no stale `nextRelevantTarget` unless it contains a real caveat.
- `blocked/stale`: full summary, blockedBy/stale reason, next hint.

Keep `parentDeliverableIds` from current target as the high-priority expansion selector.

**Acceptance criteria**

- Current/partial deliverables stay semantically rich.
- Satisfied deliverables no longer carry full old next-target hints.
- Verifier rubric remains private; compact deliverable map still orients the main agent.

### P1: Compact accepted parent truth without losing safety

**Seams**

- `runtime.ts`
  - `compactParentFrame` or new `compactParentTruthForPrompt`.

**Problem**

Accepted claims are cumulative. Latest observed parent frame cost was about `1,678` tokens, mostly `acceptedClaims`.

**Change**

Prompt surface should distinguish recent/current-relevant accepted truth from older truth:

```yaml
parent_truth:
  accepted_recent:
    - id:
      claim:
      evidenceRefs:
  accepted_compact:
    - id:
      label:
      evidenceRefs:
  boundaries:
    - ...
```

Rules:

- Keep full claim text for claims admitted by the latest resolution.
- Keep full claim text for claims tied to current target deliverables.
- Compact older claims to id + short label + evidence refs.
- Preserve active boundaries/non-implications even if claim-local `nonImplications` are omitted.

**Acceptance criteria**

- Prompt context still tells the agent what truth is accepted, not just checkpoint ids.
- Active forbidden inferences remain visible.
- Older accepted claim details are retrievable through `goal get` details.

### P1: Replace generic footer with run-mode policy

**Seams**

- `goal-mode-active.md`
- `goal-continuation.md`
- `goal-post-compaction-continuation.md`
- `runtime.ts` if policy is generated dynamically.

**Problem**

The current footer repeats about `905` tokens of generic tool/run-mode policy every time.

**Change**

Generate a short policy block from `runMode`:

```yaml
policy:
  invariant:
    - target closure is not parent completion
    - parent truth changes only through goal.resolve_checkpoint.parent_delta
  now:
    - continue current target until closure evidence
  blocked:
    - checkpoint partial work
    - parent completion without verifier path
```

For `awaiting-checkpoint-resolution`, prefer:

```yaml
policy:
  now: call goal.resolve_checkpoint before ordinary tools
  blocked:
    - implementation
    - complete
    - prose parent-frame mutation
```

**Acceptance criteria**

- Critical run-mode barriers remain in the prompt.
- Generic goal-tool operation tutorial is not repeated in every goal context.
- Context size falls without increasing invalid goal tool calls in existing tests.

### P1: Compact visible goal tool text

**Seams**

- `packages/coding-agent/src/goals/tools/goal-tool.ts`
  - `renderGoalToolText`.

**Problem**

Every visible goal tool result starts with the full objective. In long objectives this repeats user text in the visible transcript and model context.

**Change**

- Render a short objective title/first line in normal tool text.
- Keep full objective in structured `details`.
- Include full objective only for `create`, `replace`, or explicit `get` if needed.

**Acceptance criteria**

- Goal tool text remains understandable.
- Full objective is still preserved in details/state.
- Visible transcript repetition drops for frequent checkpoint/resolution calls.

### P2: Evaluate YAML after structural cuts

**Seams**

- prompt-surface serializer in `runtime.ts`.

**Problem**

YAML saved about 10% in the observed context, but structural changes save more and carry more behavioral value.

**Change**

After prompt surface compaction lands, compare:

- pretty JSON;
- no-wrap YAML;
- compact custom bullet/YAML hybrid.

Choose based on:

- token count;
- model readability;
- parse-like stability for examples/tests;
- minimal dependencies and predictable escaping.

**Acceptance criteria**

- Do not switch formats solely for small token wins.
- If switching, tests assert key text appears and forbidden full audit fields do not.

## Verification Plan

### Unit tests

Update or add tests in `packages/coding-agent/test/goals/goal-runtime.test.ts`:

- prompt surface excludes full rubric/objective duplication where intended;
- prompt surface keeps full current target closure details;
- prompt surface omits duplicate `latestResolution.nextTarget` when it equals `currentTarget`;
- prompt surface omits empty arrays/objects;
- pending checkpoint surface includes summary/local claims/notClaimed/remaining questions but omits full evidence/review lists;
- deliverable grouping keeps current/partial full and satisfied compact;
- verifier repair mode includes blockers.

### Integration tests

Update or add tests in `packages/coding-agent/test/goals/goal-mode-integration.test.ts`:

- checkpoint guidance still receives enough full state/artifacts to produce controller JSON;
- non-verifier side-agent context still does not leak full rubric;
- post-compaction goal continuation remains able to resume correct run-mode action;
- `awaiting-checkpoint-resolution` continuation blocks ordinary implementation until `resolve_checkpoint`.

### Size regression tests

Use `countTokens` from `@oh-my-pi/pi-natives` or a character-budget fallback in focused tests:

- create synthetic goal with multiple deliverables, checkpoints, resolutions, accepted claims;
- assert prompt context is below a conservative token/char ceiling;
- assert full/audit state remains available through `goal get` details.

Avoid brittle exact token counts; assert broad ceilings and absence/presence of load-bearing fields.

### Manual scenario

Run a goal-mode smoke scenario with at least two checkpoints:

1. create goal with deliverable map;
2. start target;
3. checkpoint;
4. resolve to next target;
5. inspect generated goal context.

Confirm visually:

- no duplicate full target;
- no full checkpoint evidence in always-on context;
- run-mode policy is short and exact;
- target/non-goal/stale-if remains visible.

## Rollout Order

1. Add prompt-surface builder alongside existing audit snapshot.
2. Wire `renderGoalPrompt` to prompt surface.
3. Compact duplicate/empty fields and pending checkpoint.
4. Add tests for load-bearing presence and audit-field absence.
5. Compact deliverables and parent truth.
6. Replace footer with run-mode policy.
7. Compact visible goal tool text.
8. Re-measure session-derived synthetic context and decide whether YAML is still worthwhile.

## Non-Goals

- Do not remove full goal state from persisted session entries.
- Do not reduce verifier or checkpoint side-agent access to evidence needed for their jobs.
- Do not hide full objective from durable state.
- Do not make goal context impossible to inspect by humans.
- Do not introduce a process target for context cleanup during ordinary goal work.

## Expected Outcome

For the observed multi-checkpoint OMP goal:

- ordinary goal contexts should drop from about `7.3k` tokens to roughly `4.0k-5.0k` tokens;
- checkpoint-resolution turns should avoid a second copy of full checkpoint/target audit detail;
- model-facing context remains oriented around objective, run mode, accepted truth, deliverables, and the active target/controller action;
- full audit details remain accessible through tool details and side-agent artifacts.
