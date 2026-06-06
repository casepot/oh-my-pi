# Goal Mode Checkpoint Handoff Plan

## Goal

Goal mode should support a safe checkpoint after the agent finishes one bounded target inside a larger objective.

The checkpoint is not parent-goal completion. It is a control boundary:

1. The current target is closed with evidence.
2. The result is recorded in a structured packet.
3. Ordinary “keep working” continuation stops.
4. Context can be compressed.
5. A fresh controller turn decides what should happen next.

That controller turn may choose the next target, request user input, ask for CI or external review, preserve lessons, update guidance, or decide the parent goal is ready for the existing completion verifier.

A goal should also carry a compact parent-state surface: what future reality is desired, what current truth the work descends from, which claims are accepted or only candidate, which gates remain open, which non-claims and residuals must not be laundered, and who has authority to move the parent state forward. Checkpoints and controller turns then update that state explicitly instead of leaving it implicit in transcript prose.

## Why this is needed

Current goal mode has one main loop:

```text
active goal -> hidden continuation -> more work -> goal complete/drop/pause
```

That loop is good for persistence, but it has a bad failure mode on long goals. After the agent completes a meaningful chunk, it is usually in the worst state to decide the next strategic chunk:

- it is locally anchored to the implementation it just finished;
- it may overvalue the patch it just made;
- it may confuse “this target is stable” with “the larger goal is done”;
- it may continue mechanically from the old frame instead of stepping back;
- it may miss that external input, CI, release checks, or a different target would now be more valuable.

The desired seam is:

```text
work target closed -> checkpoint -> fresh controller guidance -> next target
```

This lets the product use the yield/compaction hook for more than summarization. The hook becomes a place where OMP can:

- compress and stabilize context;
- ask a separate agent for continuation guidance;
- allow the operator to intervene;
- run or request broader checks;
- distill lessons into future guidance;
- choose a better next target than the saturated worker would choose.

## First-principles rules

### 1. Parent goal and current target are different objects

A parent goal is the whole user objective. A current target is one bounded piece of work that helps move toward it.

Example:

```text
Parent goal: Improve release reliability.
Current target: Make the installer smoke probe prove the stats worker starts in compiled binaries.
```

Finishing the target does not finish the parent goal. It only creates evidence that one bounded part is stable.

### 2. A goal carries parent state, not only prose

A parent goal should be more than an objective string plus a rubric. For claim-gated work it should be able to carry:

- desired future: the reality the goal is trying to make true;
- current truth or baseline: the accepted state this work descends from;
- accepted claims: facts future work may rely on;
- candidate claims: facts produced by local work but not yet accepted at the parent level;
- gates: checks, evidence classes, or authority decisions required before claims can advance;
- boundaries: non-claims, forbidden inferences, stale paths, and things not to inherit;
- residuals: unresolved risks, blockers, deferred work, and future-frontier items;
- authority: who or what may accept parent-state deltas, risk, or external records;
- external refs: documents, artifacts, issues, release records, or other durable records that own domain-specific truth.

Release workflows can map this to release targets, patch targets, gates, residual schedules, and release records. OMP goal mode should not hardcode release cadence concepts. It should preserve the generic claim/evidence/boundary/authority state so project skills can interpret it.

### 3. A checkpoint is earned, not requested

The agent may checkpoint only after the current target is stable enough to hand off. “I am tired,” “budget is low,” “this phase ended,” or “I need to think” is not enough.

A valid checkpoint must say:

- what target was closed;
- what changed;
- what evidence supports closure;
- what checks were run;
- what remains unproven;
- what should not be inferred;
- what broader decisions are now needed.

### 4. The checkpoint packet must carry negative information

A useful handoff does not only say what succeeded. It must also say what did not become true.

For example:

```text
Closed: stats worker smoke probe now passes locally.
Not claimed: release is ready.
Not claimed: CI is green.
Not claimed: update/install flow is fully proven.
Remaining: run CI, verify tarball install, decide whether release goal can advance.
```

This prevents the next turn from inheriting a cleaner state than reality supports.

### 5. The same worker should not immediately choose the next strategic target

After closing a target, the worker should hand off. The next target should be selected by a fresh controller turn with compressed context and explicit guidance.

That controller turn may still be the main agent, but it should be prompted differently. It is no longer “continue local implementation.” It is “look at the closed target, the parent goal, and the available evidence; decide the next best move.”

### 6. Parent completion remains separately verified

The existing `goal({ op: "complete" })` path stays strict. It remains the only path to mark the parent goal complete, and it still runs the independent completion verifier.

Checkpointing must never bypass that verifier.

## Desired user-visible flow

### Starting a goal

User starts goal mode as today:

```text
/goal Improve release reliability
```

Goal mode creates a parent goal and rubric as it does now.

For ordinary goals, the parent state can remain sparse. For claim-gated goals, the goal should initialize a compact parent frame before substantial work. A release-shaped project can populate that frame from its own release records or skills, but OMP stores only generic goal state and external refs:

```text
goal({
  op: "create",
  objective: "Improve release reliability",
  parent_frame: {
    kind: "claim-gated",
    desired_future: "Release work advances through explicit claims, evidence, non-claims, and controller-approved next targets.",
    current_truth: "Installer smoke coverage exists but release readiness is not established.",
    baseline_refs: [{ id: "release-plan", kind: "doc", uri: "docs/..." }],
    gates: [{ id: "install-smoke", name: "Install smoke evidence", status: "unknown", required_evidence: ["install smoke output"] }],
    boundaries: [{ id: "local-smoke-not-release", kind: "forbidden-inference", statement: "Local smoke success does not imply CI, tarball install, or release readiness." }]
  }
})
```

The first goal-mode turn should choose a bounded current target before doing substantial work. The target can be explicit in tool state:

```text
goal({
  op: "start_target",
  title: "Prove stats worker starts in compiled installer smoke test",
  desired_future_claim: "Compiled installs exercise the stats worker startup path instead of silently skipping it.",
  expected_parent_contribution: "Closes one release-reliability evidence gap without claiming the release is ready.",
  closure_standard: "A focused smoke command runs and fails if the worker cannot start.",
  baseline_refs: [{ id: "checkpoint-plan", kind: "doc", uri: "docs/execution-plans/..." }],
  gate_refs: ["install-smoke"],
  evidence_expectation: ["smoke command output", "changed test/install script references"],
  non_goals: ["full release readiness", "all installer platforms"],
  forbidden_claims: ["CI is green", "release is ready", "tarball install path is verified"],
  stale_if: ["installer script changes", "compiled worker spawn path changes"]
})
```

### Working a target

While a target is active, hidden goal continuation behaves like today: keep working until the target is closed, blocked, or the parent goal is actually ready for completion verification.

### Closing a target

When the target is stable, the agent calls:

```text
goal({
  op: "checkpoint",
  status: "closed_with_evidence",
  summary: "The compiled installer smoke path now exercises stats worker startup.",
  local_claims: [
    "The smoke probe fails if stats worker startup is broken."
  ],
  evidence: [
    {
      claim: "The smoke probe exercises stats worker startup.",
      evidence: "scripts/install-tests/run-ci.sh invokes omp --smoke-test after install.",
      current: true
    },
    {
      claim: "The smoke probe passes in the focused local run.",
      evidence: "Observed bun test ... / smoke command output ...",
      current: true
    }
  ],
  checks_run: ["bun test packages/coding-agent/test/goals/..."],
  artifacts_touched: ["scripts/install-tests/run-ci.sh", "packages/coding-agent/src/..."],
  not_claimed: [
    "Parent goal is complete",
    "Release is ready",
    "CI is green on every platform",
    "Tarball install path is verified"
  ],
  remaining_questions: [
    "Should the next target be CI coverage, tarball install verification, or release metadata?"
  ]
})
```

Runtime response should make the state explicit:

```text
Target checkpoint recorded. Parent goal remains active. Ordinary continuation is paused while checkpoint guidance is prepared.
```

### After checkpoint

Runtime does not submit the old continuation prompt. Instead it prepares a controller prompt from:

- parent goal/rubric;
- parent-state frame;
- current target definition;
- checkpoint packet;
- recent transcript summary;
- unresolved verification feedback;
- current mode/settings;
- optional operator/project hooks.

The controller prompt asks the next turn to choose one of these outcomes:

1. start the next target;
2. update the parent-state frame through `resolve_checkpoint.parent_delta`;
3. request external input;
4. request broader checks such as CI;
5. preserve lessons or propose guidance updates;
6. attempt parent completion through `goal({ op: "complete" })` only if the parent goal is genuinely ready.

### Resolving a checkpoint

The controller turn records its decision:

```text
goal({
  op: "resolve_checkpoint",
  decision: "next_target",
  checkpoint_id: "...",
  parent_reading: "The smoke path target is locally closed, but release reliability still needs end-to-end installer evidence.",
  parent_delta: {
    admitted_claims: [
      {
        id: "compiled-installer-smoke-starts-worker",
        claim: "Compiled installer smoke path now has local evidence for stats worker startup.",
        status: "accepted",
        evidence_refs: [{ id: "checkpoint:...", kind: "artifact" }],
        non_implications: ["Release is ready", "Tarball install path is verified"]
      }
    ],
    candidate_claims_added: [],
    rejected_claims: [],
    boundaries_added: [
      {
        id: "source-link-not-tarball",
        kind: "forbidden-inference",
        statement: "Local source-link smoke success does not prove tarball install success."
      }
    ],
    residuals_added_or_updated: [
      {
        id: "tarball-smoke-evidence",
        statement: "Tarball install path still needs equivalent smoke evidence.",
        classification: "current-parent-blocker",
        required_evidence: ["tarball install smoke output"]
      }
    ],
    gate_deltas: [
      {
        gate_id: "install-smoke",
        status: "passed",
        evidence_refs: [{ id: "checkpoint:...", kind: "artifact" }]
      }
    ],
    frontier_deltas: [
      {
        id: "tarball-install-smoke-frontier",
        statement: "Tarball install verification is now the next most concrete release-reliability frontier.",
        evidence_required: ["tarball install smoke output"]
      }
    ],
    external_record_refs: []
  },
  next_target: {
    title: "Prove tarball install exercises the same smoke path",
    desired_future_claim: "Tarball installs run the smoke path that catches stats worker startup failure.",
    expected_parent_contribution: "Extends the accepted local smoke claim to the distribution path users actually install.",
    closure_standard: "Tarball install test runs omp --smoke-test and fails on worker startup errors.",
    baseline_refs: [{ id: "checkpoint:...", kind: "artifact" }],
    gate_refs: ["tarball-install-smoke"],
    evidence_expectation: ["tarball install test output"],
    non_goals: ["full release publication"],
    forbidden_claims: ["full release readiness", "CI is green on every platform"],
    stale_if: ["tarball install script changes", "smoke-test command changes"]
  },
  not_propagated: [
    "Local source-link smoke success does not prove tarball install success."
  ],
  broader_checks_or_inputs: ["Run install test matrix when target closes."],
  lessons_for_future: [
    "Worker smoke probes should be included in every install surface that can ship compiled binaries."
  ]
})
```

Then ordinary hidden continuation resumes against the new target.

## OMP architecture seams

The implementation should follow the existing goal-mode architecture instead of turning this into a parallel subsystem.

### Goal runtime owns durable state

`packages/coding-agent/src/goals/runtime.ts` is the right place for deterministic state transitions:

- create, pause, resume, drop, and complete mutate goal state through `GoalRuntime`;
- `#commitState()` updates in-memory state, persists a `mode_change`, and emits `goal_updated`;
- accounting and retry reset logic already live here;
- prompts are rendered from goal state through `renderGoalPrompt()`.

New target/checkpoint/resolution/verification-repair state should be mutated through runtime methods, not directly from `InteractiveMode` or the tool.

The runtime should stay mostly side-agent-free. It should prepare or commit state. `AgentSession` should orchestrate side agents and call runtime after review/guidance succeeds.

### Goal tool is the agent-facing write API

`packages/coding-agent/src/goals/tools/goal-tool.ts` is the only tool the agent should use to mutate goal mode.

The existing pattern is:

- simple ops call runtime directly (`get`, `resume`, `drop`);
- ops requiring side agents route through `AgentSession` (`create` generates rubric, `complete` runs verifier);
- tool output hides internal continuation prompts and surfaces only audited details.

Use the same pattern:

- `start_target` can call runtime directly;
- `checkpoint` should route through `AgentSession.requestGoalCheckpoint()` because review and checkpoint artifacts are session responsibilities;
- `resolve_checkpoint` should route through `AgentSession` when publishing resolution artifacts or preparing follow-up guidance; runtime performs only the deterministic commit.
- `complete` remains parent-scoped and still uses the existing verifier, with new precondition gates for unresolved checkpoint/repair state.

Do not let `checkpoint` return a hidden prompt in the visible tool result. Persist the packet and let the scheduler deliver the next hidden prompt.

### AgentSession owns side agents and continuation prompt construction

`packages/coding-agent/src/session/agent-session.ts` is already the orchestration seam for:

- rubric generation;
- completion verification;
- verifier-feedback artifact publication;
- continuation compactor fallback;
- serialized goal side-agent execution via `#withSerializedGoalSideAgent()`;
- transcript files for side agents;
- strict read-only tool whitelists declared in `side-agents.ts`.

Keep new review/guidance here:

- `requestGoalCheckpoint()` builds a candidate packet, optionally runs the checkpoint reviewer, then commits or rejects it through runtime;
- `prepareGoalCheckpointGuidancePrompt()` builds the controller continuation prompt from accepted checkpoint state;
- `prepareGoalVerificationRepairPrompt()` builds repair continuation from verifier structured feedback;
- `prepareGoalContinuationPrompt()` should become mode-aware rather than assuming every active goal wants ordinary local continuation.

The verifier already returns `continuationFocus`; use that directly for post-verification continuation before invoking any compactor.

### InteractiveMode owns scheduling and operator UI

`packages/coding-agent/src/modes/interactive-mode.ts` currently auto-submits hidden goal continuation when:

```text
goal mode enabled + not paused + no pending user input + goal.status == active
```

That is too coarse for checkpoints. Replace it with a run-mode dispatcher:

```text
working-target -> ordinary local continuation
awaiting-checkpoint-resolution -> controller continuation
awaiting-verification-repair -> verifier-repair continuation
awaiting-user-input -> no auto continuation
outer mode `exiting` -> exit goal mode
```

This is the idiomatic place to decide whether a hidden prompt is submitted, because it already guards against streaming, compaction, pending editor text, queued user input, plan mode, and loop mode.

Status line and `/goal` menu changes also belong here. The status should distinguish “checkpoint pending” and “verifier repair pending” from ordinary pause.

### Session persistence is mode-change based

Goal state is currently persisted by `sessionManager.appendModeChange("goal", { goal })` and restored by `#goalFromModeData()`.

That is workable but brittle. Adding nested target/checkpoint/repair structures will make the current hand-written parser easy to get wrong.

Better implementation:

- move `serializeGoalModeState()` / `parseGoalModeState()` into `packages/coding-agent/src/goals/state.ts` or a sibling module;
- use those helpers both when persisting and when restoring;
- version the stored goal-mode data;
- preserve unknown future fields only if doing so is deliberate and safe.

This also prevents `InteractiveMode` from becoming the owner of goal-state schema.

### Compaction has two existing seams

Context compaction already has good extension points in `AgentSession`:

- `session_before_compact` may cancel or provide a full compaction;
- `session.compacting` may add prompt/context/preserve data;
- `#collectMemoryBackendContext()` appends memory backend context;
- `compact()` accepts `extraContext`, `promptOverride`, and `preserveData`;
- `session_compact` fires after the compaction entry is saved.

Goal mode should plug into this inside `AgentSession`, not inside the generic `packages/agent/src/compaction` package.

Add a native goal-mode compaction context provider that contributes:

- active parent goal and parent-state frame;
- current target;
- pending checkpoint, if any;
- latest verifier rejection/repair state;
- explicit non-claims, residuals, stale conditions, and gate status;
- exact next local action when known.

Then pass that as compaction `extraContext` / `preserveData` alongside extension and memory-backend context.

### Handoff compaction needs explicit goal carry-forward

The `handoff` compaction strategy starts a new session, injects a handoff custom message, and rebuilds agent messages. That path can drop persisted mode state unless goal mode is explicitly carried forward.

For active goal mode, handoff should:

1. include goal parent frame, target, checkpoint, and verification state in the handoff document;
2. append a goal `mode_change` in the new session with serialized goal mode state;
3. restore active tools including `goal`;
4. schedule the correct post-handoff continuation by run mode.

Without this, context handoff can preserve narrative guidance while losing the authoritative goal tool state.

### Better shape: one continuation dispatcher

The current code has several separate continuation paths:

- interactive goal continuation;
- auto-continue after compaction;
- retry after overflow/incomplete output;
- verifier rejection continuation;
- future checkpoint guidance.

These should converge through one small dispatcher in `AgentSession`, e.g.:

```ts
type GoalContinuationKind =
	| "ordinary"
	| "checkpoint-resolution"
	| "verification-repair"
	| "post-compaction";

interface PreparedGoalContinuation {
	kind: GoalContinuationKind;
	customType: string;
	prompt: string;
}
```

`InteractiveMode` should ask for a prepared continuation and submit it. `AgentSession` should decide which prompt applies based on goal run mode, latest verification state, and compaction reason.

This avoids spreading policy across `#canConsiderGoalContinuation()`, `prepareGoalContinuationPrompt()`, auto-compaction, verifier rejection handling, and checkpoint handling.

### Domain-specific flows bind through generic state

Goal mode should not import project-specific release cadence, skill names, residual taxonomies, or record formats into the runtime. The interface is generic:

1. Project skills or operator prompts may populate `GoalParentFrame` from their domain records.
2. The worker starts and closes bounded targets against that frame.
3. Checkpoint guidance may call or reference domain skills.
4. The controller records the result as a `GoalParentStateDelta` plus external refs.
5. Runtime persists the reduced parent-state delta; domain records remain authoritative for domain-specific truth.

For gateway-style release work, this means release target, patch target, evidence packet, target closure, parent recomposition, residual schedule, and release records can all map onto generic goal fields. OMP carries the compact state and refs; the gateway skills keep authority over release meaning.

## State model

Update `packages/coding-agent/src/goals/state.ts`.

Keep parent-goal lifecycle separate:

```ts
export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";
```

Add run mode for what the session is doing inside an active parent goal. Keep it separate from the existing outer mode:

```ts
export type GoalModeLifecycle = "active" | "exiting";

export type GoalRunMode =
	| "working-target"
	| "awaiting-checkpoint-resolution"
	| "awaiting-verification-repair"
	| "awaiting-user-input";

export interface GoalModeState {
	enabled: boolean;
	mode: GoalModeLifecycle;
	runMode: GoalRunMode;
	reason?: "completed";
	stateVersion: number;
	parentFrameVersion: number;
	goal: Goal;
}
```

The key rule: `Goal.status` says whether the parent goal is active/paused/budget-limited/complete/dropped. `GoalModeState.runMode` says whether goal mode should continue local work, resolve a checkpoint, or repair a rejected parent-completion attempt.

`stateVersion` belongs to the full goal-mode state, not only `Goal`. Increment it for semantic workflow mutations: target start/supersession, checkpoint commit/reject, checkpoint resolution, verifier-repair state, parent completion, drop, pause/resume, and budget-limited transitions. Do not increment it for token/wall-clock accounting-only updates, or side-agent usage accounting will self-stale its own result. `parentFrameVersion` increments only when `Goal.parentFrame` changes; targets and checkpoints copy it so stale parent assumptions are visible without diffing the full frame.

### State transition table

| Event | Parent `Goal.status` | `GoalModeState.runMode` | Notes |
|---|---|---|---|
| Goal created | `active` | `working-target` | Normalizes optional parent frame; if no target exists, first continuation should start one before substantial work. |
| `start_target` | unchanged | `working-target` | Rejected if checkpoint resolution is pending. |
| Checkpoint accepted | `active` | `awaiting-checkpoint-resolution` | Current target is closed; ordinary work is blocked. |
| Checkpoint rejected | `active` | `working-target` | Current target remains active with reviewer feedback. |
| `resolve_checkpoint(next_target)` | `active` | `working-target` | Applies any `parentDelta`, then installs next target atomically. |
| `resolve_checkpoint(parent_completion_candidate)` | `active` | `working-target` | Allows a parent `complete` attempt; does not complete parent. |
| `resolve_checkpoint(needs_user_input/checks/external_control)` | `active` | `awaiting-user-input` | Auto-continuation suppressed until operator/check result resumes resolution. |
| Parent `complete` verified | `complete` | `working-target` | Runtime then uses outer `mode: "exiting"` to leave goal mode. |
| Parent `complete` rejected | `active` | `awaiting-verification-repair` or `working-target` | Only `working-target` when an active target is explicitly linked to blockers. |
| User `/goal pause` | `paused` | preserved | Resume must preserve and dispatch the prior run mode. |
| Budget limit reached | `budget-limited` | preserved | Budget mutation/resume must not clear pending checkpoint/repair state. |
| Drop | `dropped` | preserved | Goal exits; state retained only as history. |

### Parent frame

Add a compact parent-state frame for goals that need more than objective prose. The frame is generic enough for ordinary product, infrastructure, release, research, or refactor goals; release-specific records can be referenced without being embedded wholesale.

```ts
export type GoalParentFrameKind = "plain" | "claim-gated";

export type GoalRefKind =
	| "doc"
	| "issue"
	| "artifact"
	| "test"
	| "commit"
	| "external-record"
	| "other";

export interface GoalRef {
	id: string;
	kind: GoalRefKind;
	label?: string;
	uri?: string;
}

export type GoalClaimStatus = "accepted" | "candidate" | "rejected" | "stale";

export interface GoalClaim {
	id: string;
	claim: string;
	status: GoalClaimStatus;
	scope?: string;
	evidenceRefs?: GoalRef[];
	nonImplications?: string[];
	acceptedBy?: string;
	acceptedAt?: number;
}

export type GoalBoundaryKind =
	| "non-claim"
	| "forbidden-inference"
	| "unsupported"
	| "local-only"
	| "mock-only"
	| "unavailable"
	| "stale-path";

export interface GoalBoundary {
	id: string;
	kind: GoalBoundaryKind;
	statement: string;
	refs?: GoalRef[];
}

export type GoalResidualClassification =
	| "current-parent-blocker"
	| "accepted-risk"
	| "future-frontier"
	| "decision-needed"
	| "architecture-debt"
	| "anti-laundering-non-claim"
	| "local-shortcut"
	| "capability-gap"
	| "rejected-or-stale-path"
	| "unspecified";

export interface GoalResidual {
	id: string;
	statement: string;
	classification: GoalResidualClassification;
	whyItMatters?: string;
	requiredEvidence?: string[];
	targetHorizon?: string;
	authorityRequired?: string;
	nonImplications?: string[];
	refs?: GoalRef[];
}

export type GoalGateStatus = "unknown" | "passed" | "failed" | "stale" | "not-applicable";

export interface GoalGate {
	id: string;
	name: string;
	status: GoalGateStatus;
	requiredEvidence: string[];
	evidenceRefs?: GoalRef[];
	nonClaims?: string[];
	staleIf?: string[];
}

export interface GoalAuthorityState {
	parentStateAuthority?: string;
	riskAcceptanceAuthority?: string;
	externalRecordAuthority?: string;
	workerMayOnlyPropose?: boolean;
}

export interface GoalFrontierItem {
	id: string;
	statement: string;
	evidenceRequired?: string[];
	activationTrigger?: string;
	refs?: GoalRef[];
}

export interface GoalParentFrame {
	kind: GoalParentFrameKind;
	desiredFuture: string;
	currentTruth?: string;
	baselineRefs: GoalRef[];
	acceptedClaims: GoalClaim[];
	candidateClaims: GoalClaim[];
	rejectedOrStaleClaims: GoalClaim[];
	boundaries: GoalBoundary[];
	residuals: GoalResidual[];
	gates: GoalGate[];
	frontier: GoalFrontierItem[];
	staleIf: string[];
	authority?: GoalAuthorityState;
	externalRefs: GoalRef[];
	lastParentDeltaId?: string;
}
```

The parent frame is not a backlog. It is the compact truth surface the next controller turn should inherit: what may be relied on, what is only candidate, what must not be inferred, and what authority is still missing.

### Target

Use “target” in user-facing prompts and UI. If internal naming prefers “atom,” keep that internal; do not expose ontology jargon in normal goal-mode copy.

```ts
export interface GoalTarget {
	id: string;
	sequence: number;
	status: "active" | "closed" | "superseded";
	title: string;
	desiredFutureClaim: string;
	closureStandard: string;
	expectedParentContribution?: string;
	parentFrameVersion?: number;
	baselineRefs: GoalRef[];
	gateRefs: string[];
	evidenceExpectation: string[];
	nonGoals: string[];
	forbiddenClaims: string[];
	staleIf: string[];
	createdAt: number;
	closedAt?: number;
	createdBy: "initial" | "checkpoint-resolution" | "verification-repair" | "retrospective" | "operator";
	createdFromCheckpointId?: string;
	createdFromVerificationAttemptId?: string;
	linkedVerifierBlockerIds?: string[];
}
```

### Checkpoint packet

```ts
export interface GoalCheckpointEvidenceItem {
	claim: string;
	evidence: string;
	current: boolean;
}

export type GoalCheckpointStatus = "closed_with_evidence";

export interface GoalCheckpointPacket {
	id: string;
	sequence: number;
	goalId: string;
	targetId: string;
	targetSnapshot: GoalTarget;
	parentFrameVersion: number;
	baselineRefs: GoalRef[];
	gateRefs: string[];
	workEpoch: number;
	status: GoalCheckpointStatus;
	summary: string;
	localClaims: string[];
	evidence: GoalCheckpointEvidenceItem[];
	checksRun: string[];
	artifactsTouched: string[];
	notClaimed: string[];
	remainingQuestions: string[];
	risksOrCaveats: string[];
	staleIf: string[];
	suggestedControllerQuestions: string[];
	createdAt: number;
	review?: GoalCheckpointReview;
}
```

P0 checkpoint means the target is closed with evidence. Blocked, partial, invalid, or superseded work should stay as active-target repair/control state until a separate future `request_control`/`supersede_target` operation exists. Do not call those states “closed checkpoints.”

Runtime should always add these default `notClaimed` entries unless the packet already includes stricter versions:

- parent goal complete;
- external checks verified;
- future target selected;
- durable project memory or guidance updated;
- external/user authority granted.

### Checkpoint review

```ts
export interface GoalCheckpointReview {
	status: "accepted" | "rejected";
	feedback: string;
	evidenceChecked: GoalCheckpointEvidenceItem[];
	blockers: GoalVerificationGap[];
	continuationFocus?: GoalContinuationFocus;
	reviewedAt: number;
	sideAgentTokensUsed?: number;
}


export interface GoalCheckpointRejection {
	candidateSummary: string;
	review: GoalCheckpointReview;
	createdAt: number;
}
```

The review only decides whether the target closure packet is good enough to hand off. It does not decide parent completion.

### Checkpoint resolution

```ts
export type GoalCheckpointResolutionDecision =
	| "next_target"
	| "parent_completion_candidate"
	| "needs_user_input"
	| "needs_broader_checks"
	| "pause_for_external_control"
	| "drop_or_replace_recommended";

export interface GoalGateDelta {
	gateId: string;
	status: GoalGateStatus;
	evidenceRefs?: GoalRef[];
	rationale?: string;
}

export interface GoalParentStateDelta {
	admittedClaims: GoalClaim[];
	candidateClaimsAdded: GoalClaim[];
	rejectedClaims: GoalClaim[];
	boundariesAdded: GoalBoundary[];
	residualsAddedOrUpdated: GoalResidual[];
	gateDeltas: GoalGateDelta[];
	frontierDeltas: GoalFrontierItem[];
	staleRefs: GoalRef[];
	externalRecordRefs: GoalRef[];
	authorityDecisionRefs?: GoalRef[];
}

export interface GoalCheckpointResolution {
	id: string;
	sequence: number;
	goalId: string;
	checkpointId: string;
	decision: GoalCheckpointResolutionDecision;
	parentReading: string;
	parentDelta?: GoalParentStateDelta;
	notPropagated: string[];
	remainingParentWork: string[];
	broaderChecksOrInputs: string[];
	lessonsForFuture: string[];
	nextTarget?: GoalTarget;
	createdAt: number;
}
```

### Verification repair state

```ts
export interface GoalVerificationRepairState {
	verificationAttemptId: string;
	feedback: string;
	blockers: GoalVerificationGap[];
	evidenceToCollect: string[];
	avoidRepeating: string[];
	createdAt: number;
}
```

This state is created only after parent completion is rejected. It is not a checkpoint and not parent completion history replacement; it is the current repair focus derived from the latest failed completion attempt.


### Goal additions

```ts
export interface Goal {
	// existing fields remain
	parentFrame?: GoalParentFrame;
	currentTarget?: GoalTarget;
	targets?: GoalTarget[];
	checkpoints?: GoalCheckpointPacket[];
	pendingCheckpointId?: string;
	checkpointResolutions?: GoalCheckpointResolution[];
	lastCheckpointResolutionId?: string;
	lastCheckpointRejection?: GoalCheckpointRejection;
	verificationRepair?: GoalVerificationRepairState;
}
```

Store all closed/superseded targets in `targets` and copy the closed target into `GoalCheckpointPacket.targetSnapshot`. A later target must not make old checkpoint records depend on whatever `currentTarget` happens to be now.

## Goal tool changes

Update:

- `packages/coding-agent/src/goals/tools/goal-tool.ts`
- `packages/coding-agent/src/prompts/tools/goal.md`

Existing operations stay:

| Operation | Meaning |
|---|---|
| `create` | Start or replace parent goal and optional parent-state frame. |
| `get` | Inspect current parent frame, parent goal, target, checkpoint, and resolution state. |
| `resume` | Resume a paused parent goal. |
| `complete` | Attempt verified parent-goal completion. |
| `drop` | Drop parent goal. |

Implement the schema as a discriminated union by `op`, not one broad object with many optional fields. The current tool is strict; op-specific schemas keep invalid combinations out before runtime.

Add operations:

### `start_target`

Installs the current bounded target.

Required fields:

- `title`
- `desired_future_claim`
- `closure_standard`

Optional fields:

- `expected_parent_contribution`
- `baseline_refs`
- `gate_refs`
- `evidence_expectation`
- `non_goals`
- `forbidden_claims`
- `stale_if`

Rules:

- Allowed at initial goal start if no active target exists.
- Runtime normalizes omitted optional arrays to empty arrays or derived parent-frame refs before persisting `GoalTarget`.
- Installed atomically by `resolve_checkpoint({ decision: "next_target", next_target })` after a checkpoint; the agent should not need a separate `start_target` call in that path.
- Allowed after rejected completion verification only when the target is scoped to verifier blockers.
- Rejected if a target is already active unless the op explicitly supersedes it under a verifier-repair/controller decision.
- Rejected while a checkpoint is pending resolution.

### `checkpoint`

Closes the current target and asks runtime to prepare checkpoint guidance.

Required fields:

- `status` (`"closed_with_evidence"` in P0)
- `summary`
- `local_claims`
- `evidence`
- `not_claimed`
- `remaining_questions`

Optional fields:

- `checks_run`
- `artifacts_touched`
- `risks_or_caveats`
- `stale_if`
- `suggested_controller_questions`
- `retrospective_target` for migration-only legacy sessions that had no target.

Rules:

- Rejected if no target exists unless retrospective target is explicitly allowed for a legacy session.
- Rejected unless positive, current evidence supports the local target claim.
- Rejected if `not_claimed` is missing or empty.
- Keeps parent goal active.
- Sets `runMode = "awaiting-checkpoint-resolution"` after acceptance.
- Suppresses ordinary continuation.
- Blocks further ordinary tool work in the same goal turn. After accepted checkpoint, the only valid next model act is to end the turn or use a context-appropriate yield/submit tool if one is available.

### `resolve_checkpoint`

Records what the fresh controller turn decided after reading the checkpoint packet.

Required fields:

- `checkpoint_id`
- `decision`
- `parent_reading`
- `not_propagated`
- `remaining_parent_work`

Optional fields:
- `parent_delta`
- `broader_checks_or_inputs`
- `lessons_for_future`
- `next_target`

Rules:

- Required before local implementation resumes after checkpoint.
- `parent_delta`, when present, is the only goal-tool path that mutates the parent frame after checkpoint closure.
- Domain-specific records, such as release records, should appear as `externalRecordRefs`; do not inline whole domain documents into goal state.
- `next_target` is required for `decision: "next_target"` and is installed atomically by the resolution.
- `decision: "needs_user_input"`, `"needs_broader_checks"`, and `"pause_for_external_control"` keep ordinary continuation suppressed and must record what later event/action can resume resolution.
- `decision: "parent_completion_candidate"` clears the checkpoint only enough to allow the next `complete` attempt; it does not complete the parent goal.
- `complete` is still required for parent completion; `resolve_checkpoint` cannot complete the parent goal.
- Direct `complete` is rejected while `pendingCheckpointId` exists unless a resolution explicitly chose `parent_completion_candidate`.

## Runtime changes

Update `packages/coding-agent/src/goals/runtime.ts`.

Add methods:

```ts
startTarget(input): Promise<GoalModeState>;
buildCheckpointCandidate(input): GoalCheckpointPacket;
commitCheckpoint(packet, review): Promise<GoalModeState>;
rejectCheckpoint(candidate, review): Promise<GoalModeState>;
recordCheckpointResolution(input): Promise<GoalModeState>;
applyParentStateDelta(delta): GoalParentFrame;
recordVerificationRepairState(input): Promise<GoalModeState>;
clearVerificationRepairAfterFreshEvidence(input): Promise<GoalModeState>;
canCommitSideAgentResult(expected): boolean;
```

Important runtime behavior:

1. `checkpoint` should not always commit immediately.
   - `GoalTool` routes it through `AgentSession.requestGoalCheckpoint()`.
   - Runtime builds a candidate packet.
   - If checkpoint review is enabled, `AgentSession` runs review first.
   - Runtime commits only accepted packets.

2. Committed checkpoint state:
   - mark current target closed;
   - copy the target into `targets` and `packet.targetSnapshot`;
   - record `parentFrameVersion`, target baseline refs, and target gate refs in the packet;
   - append checkpoint packet;
   - set `pendingCheckpointId`;
   - set run mode `awaiting-checkpoint-resolution`;
   - keep `Goal.status = "active"`;
   - suppress ordinary local continuation.

3. Rejected checkpoint state:
   - keep current target active;
   - persist `lastCheckpointRejection` with reviewer focus;
   - set run mode `working-target`;
   - schedule normal continuation focused on missing closure evidence.

4. Checkpoint resolution state:
   - append resolution;
   - apply `parentDelta` to `Goal.parentFrame` when present;
   - set `parentFrame.lastParentDeltaId` after applying an accepted delta;
   - clear `pendingCheckpointId` only for `next_target` or `parent_completion_candidate`;
   - install next target atomically for `decision: "next_target"`;
   - set run mode `working-target` only when local work may resume;
   - set run mode `awaiting-user-input` for user/check/external-control decisions;
   - keep parent `Goal.status = "active"` unless the operator explicitly pauses/drops it.

5. Parent completion verification state:
   - still flows through `requestGoalCompletion()` and the independent verifier;
   - verified result completes the parent goal through the existing path;
   - rejected result records structured verifier feedback and `verificationRepair`;
   - rejected result sets run mode `awaiting-verification-repair` unless a current target is explicitly linked to the blockers;
   - post-verification continuation uses verifier `continuationFocus` directly when available;
   - another `complete` call should be rejected until blockers have been fixed, directly evidenced, or explicitly cleared by a verifier-repair resolution.

6. Side-agent stale checks:
   - capture `goalId`, `stateVersion`, `currentTarget.id`, `pendingCheckpointId`, and relevant attempt IDs before launching any reviewer/guidance/verifier side agent;
   - include `parentFrameVersion` in that expectation when side-agent output can mutate or rely on parent-frame state;
   - commit outputs only if those values still match;
   - reject stale output without mutating state.

## Side-agent changes

Update `packages/coding-agent/src/goals/side-agents.ts` and add prompt files under `packages/coding-agent/src/prompts/goals/`.

Every checkpoint/review/guidance assignment must receive a structured goal-mode state snapshot in addition to a transcript file. Mode-change state is not guaranteed to be visible as ordinary LLM context after compaction/handoff.

### Checkpoint reviewer

New side agent: `goal-checkpoint-reviewer`.

Purpose: decide whether the checkpoint packet is a valid local target closure.

It must be read-only. It may use `read`, `search`, `find`, and `yield`. It must not run tests or edit files.

It checks:

- target claim is clear;
- target baseline/gate refs match current parent-frame state;
- evidence matches the target claim and its closure standard;
- evidence is current enough for the claim and not stale under target or parent-frame rules;
- `not_claimed` and target `forbiddenClaims` prevent parent-goal/external-check/authority overclaim;
- remaining questions are explicit;
- closure is not being used as a fatigue or budget escape.

Output:

```ts
{
	status: "accepted" | "rejected";
	feedback: string;
	evidenceChecked: GoalCheckpointEvidenceItem[];
	blockers: GoalVerificationGap[];
	continuationFocus?: GoalContinuationFocus;
}
```

Recommended default: required review for every checkpoint. This is safer than letting the main worker self-certify the handoff.

### Checkpoint guidance writer

New side agent: `goal-checkpoint-guidance`.

Purpose: write the continuation prompt for the fresh controller turn.

It consumes:

- parent goal and parent-state frame;
- current target;
- accepted checkpoint packet;
- recent transcript summary;
- unresolved verification feedback;
- configured goal behavior;
- external refs and domain-specific hook hints when available.

It outputs:

```ts
{
	continuationMessage: string;
	checkpointSummary: string;
	controllerQuestions: string[];
	possibleNextTargets: string[];
	broaderChecksOrInputs: string[];
	parentDeltaConsiderations: string[];
	lessonsForFuture: string[];
	avoidRepeating: string[];
}
```

The guidance must tell the next turn:

- the parent goal is still active;
- the previous target is closed only under the recorded evidence boundary;
- ordinary local work must not resume until `resolve_checkpoint` is called;
- parent-state changes require `resolve_checkpoint.parent_delta`; ordinary prose does not mutate the parent frame;
- domain-specific records should be referenced as external refs, not copied into goal state;
- next targets should be desired future claims, not cleanup checklist items;
- parent completion requires `goal({ op: "complete" })` and verifier-worthy evidence.

### Post-verification continuation builder

This should not be a new verifier. The verifier already produced the authoritative negative result. `AgentSession` should build continuation from that structured output and commit repair state through runtime.

Preferred order:

1. Runtime records `verificationRepair` state from structured verifier output.
2. Use verifier `continuationFocus` directly when present.
3. If `continuationFocus` is missing, run the existing continuation compactor as fallback.
4. If both are missing, use a conservative prompt that lists failed/unknown deliverables and forbids another completion attempt until evidence is gathered.

The builder should choose run mode from explicit state, not inference:

- active target explicitly linked to blocker -> `working-target`;
- no target linked to blocker -> `awaiting-verification-repair`, then prompt requires a focused `start_target`;
- pending checkpoint exists -> resolve checkpoint first unless verifier rejection invalidated the checkpoint premise.

## Prompt changes

### System prompt

Modify the global “never yield at sub-step boundaries” rule without weakening it:

```text
A phase boundary, todo flip, or arbitrary sub-step is NEVER a yield point.
Goal mode exception: after the current target is closed under its closure standard, call `goal({op:"checkpoint"})` and stop ordinary work. This records a checkpoint, keeps the parent goal active, and lets the next turn receive fresh checkpoint guidance. It is not parent completion. If a yield/submit tool is available in that context, use it only after the checkpoint succeeds; the checkpoint state, not the yield itself, authorizes the controller continuation.
```

### Active goal prompt

Update `packages/coding-agent/src/prompts/goals/goal-mode-active.md`:

- Show parent goal/rubric.
- Show parent-state frame when present: current truth, accepted/candidate claims, gates, boundaries, residuals, and authority limits.
- Show current target if present.
- If no target exists, choose a bounded target with `start_target` before substantial work.
- If target is open, keep working.
- If target is stable, call `checkpoint` and stop local work.
- Never use checkpoint for fatigue, low budget, or partial work.
- Use `complete` only for parent-goal completion.

### Continuation prompt

Update `packages/coding-agent/src/prompts/goals/goal-continuation.md`:

- If run mode is `working-target`, continue local work.
- If run mode is `awaiting-verification-repair`, address verifier blockers; start a focused repair/evidence target if no active target is explicitly linked to them.
- If completion verifier rejected parent completion, do not retry `complete` until the rejected blockers have been fixed or directly evidenced.
- If run mode is `awaiting-checkpoint-resolution`, do not continue implementation. Act as controller: read checkpoint guidance and call `resolve_checkpoint`.
- In checkpoint-resolution mode, update parent state only by calling `resolve_checkpoint` with `parent_delta`; do not treat narrative guidance as accepted parent truth.
- If run mode is `awaiting-user-input`, do not auto-continue.
- If `pendingCheckpointId` exists, do not call `complete` unless a resolution explicitly selected `parent_completion_candidate`.

### Goal tool prompt

Update `packages/coding-agent/src/prompts/tools/goal.md` with examples for:

- creating a parent goal with a parent-state frame;
- starting a target;
- checkpointing a closed target;
- resolving a checkpoint to next target;
- resolving a checkpoint with a parent-state delta and external refs;
- resolving a checkpoint to broader checks or user input;
- attempting parent completion only via `complete`.

Use direct names: “parent goal,” “current target,” “checkpoint,” and “controller turn.” Avoid ontology terms in the user-facing prompt.

## Session, UI, and scheduling changes

### Session artifacts

Update `packages/coding-agent/src/session/messages.ts`:

```ts
export const GOAL_CHECKPOINT_MESSAGE_TYPE = "goal-checkpoint";
export const GOAL_CHECKPOINT_RESOLUTION_MESSAGE_TYPE = "goal-checkpoint-resolution";
```

Add detail types for checkpoint and resolution records.

Add TUI components:

- `goal-checkpoint-message.ts`
- `goal-checkpoint-resolution-message.ts`

Artifact labels:

```text
[goal-checkpoint] Target closed; parent goal still active
[goal-checkpoint-resolution] Next target / controller decision
```

Publish these artifacts from `AgentSession` after runtime commit/reject succeeds, not from `GoalRuntime`. If a checkpoint is committed while the assistant is still streaming, either flush the queued custom message before the tool returns or make the artifact reconstructable from serialized checkpoint state on restore.

### Interactive scheduling

Update `packages/coding-agent/src/modes/interactive-mode.ts`.

Current scheduling checks only active goal status. It needs to check run mode:

```text
working-target -> prepareGoalContinuationDispatch() returns ordinary continuation
awaiting-checkpoint-resolution -> prepareGoalContinuationDispatch() returns controller continuation
awaiting-verification-repair -> prepareGoalContinuationDispatch() returns verifier-repair continuation
awaiting-user-input -> no hidden continuation
complete/dropped -> exit goal mode
```

`awaiting-checkpoint-resolution` and `awaiting-verification-repair` are not ordinary pause. Footer/status should say something like:

```text
goal: checkpoint pending
goal: resolving checkpoint
goal: verifier repair pending
goal: repairing verifier blockers
```

### Restore from session

Replace `#goalFromModeData()` with shared `parseGoalModeState()` / `serializeGoalModeState()` helpers from the goal state module. Session restore must preserve:

- `runMode`;
- `stateVersion`;
- `parentFrameVersion`;
- parent-state frame;
- current target;
- target history;
- checkpoints;
- pending checkpoint id;
- checkpoint resolutions;
- verification repair state;
- last checkpoint rejection.

Current OMP conservatively pauses restored active goals via `onThreadResumed()`. That safety behavior may remain, but it must not erase `runMode`: a checkpoint-pending goal resumed by the operator must resume controller guidance, and a verifier-repair goal must resume blocker repair, not ordinary local work.

### Goal menu

Add inspection actions:

- Show current target.
- Show parent-state frame.
- Show gates, residuals, and non-claim boundaries.
- Show latest checkpoint.
- Show latest checkpoint resolution.
- Resume checkpoint resolution.

Keep pause/resume/drop as parent-goal actions.

## Hook extensibility

The checkpoint hook should be designed as a stable seam, not merely as a prompt-compaction implementation detail.

At first, OMP should use the seam for:

- checkpoint review;
- context compression;
- checkpoint guidance prompt;
- controller continuation.

The seam should leave room for later hooks:

- run CI or request CI;
- ask operator for authority;
- ask a product/design/security/release reviewer;
- propose skill or process-rule updates;
- preserve rejected routes or warnings;
- create notes that help future work avoid rediscovering the same lesson;
- delay continuation until external state changes.

Important guardrail: these hooks may create candidates or requests. They should not silently edit skills, mark releases ready, accept risk, or install durable project memory unless a separate authority path exists.

## Relation to context compaction and post-verification continuation

Checkpoint handoff, context compaction, and post-verification continuation are related, but they are distinct hooks.

They share one product idea: after an important transition, OMP can preserve state and influence the next continuation with better guidance than “blindly keep going.”

They differ in why the transition happened and what authority the next turn has.

| Transition | Trigger | Default policy | May choose next target? |
|---|---|---|---|
| Target checkpoint | The agent closed a bounded target with evidence. | Stop local continuation and run controller guidance. | Yes, through `resolve_checkpoint`. |
| Context compaction | Context is too large, output was incomplete, overflow happened, idle maintenance ran, or user called `/compact`. | Preserve continuity and resume the same live work. | No, unless a checkpoint is already pending or the user explicitly asked. |
| Completion verification rejected | The agent claimed the parent goal was complete, and the read-only verifier rejected that claim. | Convert verifier blockers into focused repair/evidence work before another completion attempt. | Only to create a repair target scoped to verifier blockers. |
| Completion verification accepted | The verifier accepted parent completion. | Exit goal mode and surface the done report. | No; the parent goal is complete. |

### Why post-verification continuation is distinct

Failed completion verification is not a normal continuation and not a checkpoint.

It means the agent made a load-bearing parent-completion claim, and an independent verifier found that claim unsupported. The next turn should be shaped by that critique. It should not go back to broad autonomous work, and it should not let the agent retry `complete` by rephrasing the same evidence.

Post-verification continuation should:

- preserve the verifier's exact blockers and evidence gaps;
- distinguish missing work from missing evidence;
- identify what must be fixed or inspected before the next completion attempt;
- avoid repeating actions the verifier already judged insufficient;
- create a focused repair target when the gap is substantial;
- require fresh current-state evidence before retrying `complete`.

Post-verification continuation should not:

- choose an unrelated next strategic target;
- treat verifier rejection as a context-management event;
- close a target merely because the verifier named a gap;
- suppress the verifier's negative findings during compaction;
- keep retrying completion after cosmetic changes.

### Why compaction is weaker

Compaction can happen at unsafe times:

- midway through a target;
- after a failed or truncated model response;
- after an ordinary successful turn that merely crossed the threshold;
- while queued messages are waiting;
- during manual operator maintenance.

Those moments are useful for trajectory guidance, but they do not by themselves prove that any target closed or that parent completion was attempted. Therefore compaction guidance should be conservative:

- preserve the parent goal;
- preserve the parent-state frame, including accepted/candidate claims, gates, residuals, and non-claims;
- preserve the current target;
- preserve the exact next local action if one is known;
- preserve warnings, unresolved questions, failed attempts, and evidence boundaries;
- identify possible drift or stale context;
- avoid selecting a new target unless goal state says a checkpoint is pending or verifier rejection requires a repair target.

Checkpoint guidance is allowed to be more strategic:

- inspect the closed target packet;
- decide what broader checks or input are needed;
- update the parent-state frame only through `resolve_checkpoint.parent_delta`;
- choose the next desired-future target;
- preserve lessons for future work;
- decide the parent goal is a completion candidate.

Post-verification guidance is more constrained than checkpoint guidance:

- it starts from the verifier's blockers;
- it must repair or gather evidence for those blockers;
- it may start a repair target;
- it should not broaden the goal unless the verifier exposed a real scope mismatch.

### Shared continuation packet

All three non-terminal transitions should feed the next turn through a common internal continuation packet shape:

```ts
export type GoalContinuationTransition =
	| "target-checkpoint"
	| "context-compaction"
	| "verification-rejected";

export interface GoalContinuationPacket {
	transition: GoalContinuationTransition;
	reason: string;
	stateVersion: number;
	runMode: GoalRunMode;
	parentGoalId?: string;
	parentFrameVersion?: number;
	parentFrameKind?: GoalParentFrameKind;
	currentTargetId?: string;
	pendingCheckpointId?: string;
	verificationAttemptId?: string;
	parentGoalStillActive: boolean;
	currentTargetStillOpen: boolean;
	allowedNextActs: string[];
	disallowedNextActs: string[];
	continuationGuidance: string;
	nonClaims: string[];
	parentBoundaries: string[];
	parentResiduals: string[];
	parentGateStatuses: string[];
}
```

The packet keeps common policy in one place while preserving different behavior by transition kind.

### Compaction-specific prompt policy

Update compaction and auto-continue prompts so context compression does not masquerade as a checkpoint or verifier rejection.

For ordinary compaction, the summary should include:

- parent goal, parent-state frame, and current target, if goal mode is active;
- whether a checkpoint is pending;
- whether parent completion was recently rejected;
- exact in-progress work;
- last verified evidence;
- unresolved failures/blockers;
- next local action;
- things not to infer from the summary.

For auto-continue after compaction:

```text
If goal mode has a pending checkpoint, follow checkpoint guidance and resolve it.
If parent completion was rejected, follow verifier feedback and repair/gather evidence before retrying completion.
Otherwise resume the current target exactly. Do not choose a new target merely because compaction happened.
```

For overflow or incomplete-output recovery:

```text
Retry or repair the interrupted turn. Do not reinterpret the interruption as progress, closure, or a strategic checkpoint.
```

For threshold or manual compaction:

```text
Use the compressed context to continue more cleanly. You may notice drift or missing evidence, but you may not close or replace the current target without the goal tool state supporting that move.
```

### Post-verification prompt policy

When the verifier rejects parent completion, `AgentSession` should prepare a post-verification continuation from the structured verifier result and commit any repair-state changes through runtime.

The prompt should include:

- verifier score and summary;
- failed/unknown deliverables;
- evidence the verifier checked;
- blockers grouped by severity;
- continuation focus: open gaps, next actions, evidence to collect, avoid-repeating notes;
- current parent frame, target, and checkpoint state;
- retry limit and attempt count.

The prompt should instruct the agent:

```text
The parent goal is not complete. Do not call `complete` again until the verifier blockers have been fixed or directly evidenced. If no current target is explicitly linked to the blocker, start a focused repair target. If a current target is still open and explicitly covers the blocker, continue that target. Do not choose unrelated work.
```

### Existing compaction hooks

OMP already has session compaction hooks:

- `session_before_compact`
- `session.compacting`
- `session_compact`
- `auto_compaction_start`
- `auto_compaction_end`

The checkpoint feature should not replace those hooks. Instead:

1. `AgentSession` should inject goal parent frame, target, checkpoint, and verification state into compaction context when goal mode is active.
2. Compaction summaries should preserve that state and its boundaries.
3. Auto-continue after compaction should choose among ordinary target continuation, checkpoint resolution, and verifier-repair continuation based on goal run mode and latest verification state.
4. The checkpoint hook should remain the only path that authorizes next-target selection from a closed target.
5. The verification hook should remain the only path that authorizes retry-focused repair after rejected parent completion.

This makes context compaction a continuity hook, target checkpoint a control hook, and post-verification continuation a repair/evidence hook.

## Implementation phases

### Phase 1: State and tool surface

1. Add parent-frame, parent-delta, target, checkpoint, resolution, and verification-repair types in `state.ts`.
2. Add `GoalModeState.runMode`, `GoalModeState.stateVersion`, and `GoalModeState.parentFrameVersion`.
3. Add clone/normalization helpers for nested fields.
4. Add goal-mode serialization/parsing helpers so persistence and restore share one schema path.
5. Implement runtime methods for parent-delta application, target start, checkpoint candidate/commit/reject, checkpoint resolution, verification-repair state, and side-agent stale checks.
6. Persist and restore new state fields.
7. Add `start_target`, `checkpoint`, and `resolve_checkpoint` discriminated-union schemas, but do not expose checkpoint behavior before scheduling/artifact/dispatcher support is wired.
8. Keep `complete` parent-scoped, with new precondition gates for unresolved checkpoints and unresolved verifier-repair blockers.

### Phase 2: Checkpoint review, checkpoint guidance, and verification repair

1. Add checkpoint reviewer side agent and prompts.
2. Add checkpoint guidance side agent and prompts.
3. Add structured goal-state snapshots, including parent frame and external refs, to verifier/reviewer/guidance/continuation assignments.
4. Add `AgentSession.requestGoalCheckpoint()`.
5. Add `AgentSession.prepareGoalCheckpointGuidancePrompt()`.
6. Add `AgentSession.prepareGoalVerificationRepairPrompt()`.
7. Use verifier `continuationFocus` directly for rejected completion attempts; keep compactor as fallback.
8. Add parse helpers and stale-state checks based on `stateVersion`, `targetId`, `pendingCheckpointId`, and verifier attempt id.
9. Keep side-agent tools read-only.

### Phase 3: Scheduling and UI

1. Add a single `AgentSession` prepared-continuation dispatcher.
2. Split ordinary continuation from checkpoint-resolution and verification-repair continuation through that dispatcher.
3. Suppress ordinary continuation after committed checkpoints.
4. Route rejected completion attempts to verifier-repair continuation.
5. Surface checkpoint and resolution artifacts from `AgentSession`.
6. Update footer/status/menu behavior from derived goal display state.
7. Restore checkpoint-pending and verifier-repair sessions correctly without converting them to ordinary work.

### Phase 4: Prompt alignment

1. Update global yield guidance with the narrow goal-mode checkpoint exception.
2. Update active goal prompt for parent-frame-vs-target behavior.
3. Update continuation prompt for checkpoint-pending and verifier-repair behavior.
4. Update goal tool prompt with examples and invalid uses.
5. Update completion verifier prompt so checkpoint artifacts are treated as pointers, not parent-completion evidence by themselves.
6. Update post-verification repair prompt/policy so rejected attempts cannot immediately retry `complete` without new evidence.

### Phase 5: Context compaction alignment

1. Add an AgentSession-native goal compaction context provider.
2. Inject active parent frame, target, checkpoint, and verification-repair state into compaction extra context.
3. Update compaction summary prompts to preserve parent state, target state, pending checkpoints, verifier rejections, non-claims, residuals, gates, and exact next local action.
4. Update auto-continue after compaction so checkpoint-pending mode routes to checkpoint resolution, verifier-repair mode routes to blocker repair, and ordinary compaction resumes the same current target.
5. Ensure overflow and incomplete-output recovery retry or repair the interrupted turn instead of treating recovery as a checkpoint.
6. Store any goal-mode compaction metadata in compaction `preserveData` or `details` for future debugging.
7. Carry serialized goal mode state across handoff compaction into the new session with a goal `mode_change`.

### Phase 6: Gateway/release-flow scenario

Add a focused scenario in tests or prompt examples:

1. Parent goal: improve release reliability.
2. Parent frame: current release truth, accepted claims, gates, non-claims, residuals, and external release-record refs.
3. Current target: close one installer/update/release-flow patch.
4. Checkpoint packet records evidence, non-claims, baseline refs, and gate refs.
5. Ordinary continuation stops.
6. Controller guidance asks whether to run CI, request operator input, choose next release target, update parent state, or attempt parent completion.
7. `resolve_checkpoint(next_target, parent_delta)` records the accepted parent-state delta and resumes local work.
8. Context compaction during an open target preserves the parent frame and resumes that same target, not a new release target.
9. `complete` remains required for final parent-goal acceptance.

## Verification plan

### Unit tests

Update `packages/coding-agent/test/goals/goal-runtime.test.ts`:

- `startTarget` records an active target without changing parent status.
- parent-frame creation normalizes claims, gates, residuals, boundaries, and refs.
- `checkpoint` with valid evidence commits packet and keeps parent goal active.
- `checkpoint` without evidence for positive closure is rejected.
- rejected checkpoint keeps current target active.
- committed checkpoint sets run mode `awaiting-checkpoint-resolution`.
- checkpoint resolution with next target clears pending checkpoint and resumes work mode.
- checkpoint resolution with `parent_delta` updates only the intended parent-frame fields.
- checkpoint resolution with user input/checks suppresses auto-continuation.
- `completeGoalFromTool` remains parent-completion only.
- rejected parent completion records structured verifier feedback and sets run mode `awaiting-verification-repair` when no active target is explicitly linked to the blocker.
- stale side-agent output is rejected when `stateVersion` changes.
- stale side-agent output is rejected when parent frame version changes.

Update `packages/coding-agent/test/goals/goal-tool.test.ts`:

- schema accepts new ops and rejects invalid combinations;
- `checkpoint` renderer says parent goal remains active;
- `get` returns parent-frame, target, checkpoint, and resolution state;
- `complete` response shape remains backward-compatible.

### Integration tests

Update `packages/coding-agent/test/goals/goal-mode-integration.test.ts`:

- active goal starts target, checkpoints it, and surfaces checkpoint artifact;
- checkpoint reviewer accepts/rejects as expected using strict read-only tools;
- ordinary hidden continuation is not scheduled after checkpoint;
- checkpoint guidance prompt is scheduled instead;
- controller turn must call `resolve_checkpoint` before local work resumes;
- controller turn records parent-state delta through `resolve_checkpoint`, not ordinary prose;
- `resolve_checkpoint(next_target)` installs target and resumes ordinary continuation;
- `resolve_checkpoint(needs_user_input)` suppresses auto-continuation;
- parent completion verifier does not accept checkpoint artifact alone as parent completion;
- rejected parent completion schedules verifier-repair continuation, not ordinary broad continuation;
- verifier `continuationFocus` is used directly before compactor fallback;
- verifier-repair continuation starts a focused repair target when no active target is explicitly linked to the blocker;
- session restore preserves pending checkpoint state;
- compaction during `working-target` preserves parent frame, current target, and resumes it;
- handoff compaction carries serialized goal state into the new session and schedules the correct continuation;
- compaction during `awaiting-checkpoint-resolution` routes to checkpoint guidance, not local work;
- overflow/incomplete recovery does not create or resolve checkpoints;
- compaction summary includes parent frame, target state, non-claims, residuals, and gates without selecting a new target.

### Prompt assertions

Add focused tests or snapshots only where useful:
- system prompt has checkpoint exception but still forbids arbitrary sub-step yielding;
- active goal prompt distinguishes parent frame, parent goal, and current target;
- continuation prompt distinguishes working-target, checkpoint-pending, and verifier-repair modes;
- post-verification prompt forbids retrying `complete` without new repair/evidence;
- tool prompt shows `checkpoint` versus `complete` examples.

### Manual scenario

Run a Gateway-like manual flow:

1. Start a release reliability goal.
2. Start with a parent frame that names current truth, gates, boundaries, residuals, and external refs.
3. Start a concrete target against the parent frame.
4. Make and verify a small patch.
5. Call `checkpoint` with evidence and non-claims.
6. Confirm normal continuation stops.
7. Confirm checkpoint guidance asks broader release questions and requests a `parent_delta`.
8. Resolve checkpoint to the next target with a parent-state delta.
9. Confirm work resumes on the next target.
10. Attempt parent completion too early and confirm verifier rejects.
11. Confirm verifier-repair continuation focuses on the rejected blockers and does not choose unrelated release work.
12. Repair/gather the missing parent-level evidence.
13. Confirm verifier accepts only then.

### Commands

Focused tests:

```sh
bun test packages/coding-agent/test/goals/goal-runtime.test.ts packages/coding-agent/test/goals/goal-tool.test.ts packages/coding-agent/test/goals/goal-mode-integration.test.ts
```

Package check:

```sh
bun --cwd=packages/coding-agent run check
```

Prompt formatting if prompt files change:

```sh
bun --cwd=packages/coding-agent run format-prompts
```

## Migration

Existing sessions without targets remain valid.

- If no target exists, active prompt asks the agent to start one.
- If no parent frame exists, treat the objective/rubric as the parent frame and lazily create a sparse `plain` frame only when target/checkpoint/resolution state needs one.
- During migration, `checkpoint` may accept a `retrospective_target` if the agent already completed a bounded piece before target support existed.
- Completed/dropped goals remain unchanged.
- Existing verification attempts remain parent-goal attempts, not checkpoint reviews.
- `/goal pause`, `/goal resume`, and `/goal drop` keep parent-goal semantics.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Agent uses checkpoint to punt unfinished work. | Require target, closure standard, evidence, not-claimed list, and reviewer acceptance. |
| Agent shrinks the target after doing easy work. | Prefer `start_target` before work; allow retrospective target only for migration or explicit rationale. |
| Checkpoint is mistaken for parent completion. | Keep parent `complete` parent-scoped; UI says parent goal remains active; runtime injects default non-claims. |
| Same worker immediately continues old plan. | Suppress ordinary continuation; block ordinary tool work after accepted checkpoint; use checkpoint guidance prompt for controller turn. |
| Pending checkpoint is bypassed by `complete`. | Reject direct `complete` while `pendingCheckpointId` exists unless resolution selected `parent_completion_candidate`. |
| Controller turn overclaims broader state. | Resolution records `not_propagated`, broader checks, remaining parent work, and authority/input requirements. |
| Parent-state delta launders domain-specific release truth. | Store only generic claim/gate/boundary/residual deltas plus external refs; keep domain records authoritative. |
| Compaction drops parent-frame boundaries. | Include parent frame in compaction context and handoff mode-change state. |
| Checkpoint packet is lost during compression. | Persist packet in goal state and make visible artifact reconstructable from serialized state. |
| Handoff preserves narrative but loses authoritative state. | Carry serialized goal mode state into the new session with a goal `mode_change`. |
| Verifier treats checkpoint as enough for parent completion. | Completion verifier must inspect current parent evidence and treat checkpoints as bounded pointers. |
| UI conflates checkpoint with pause. | Render derived goal display state from `GoalModeState.runMode`, separate from parent status. |
| Verifier rejection becomes generic churn. | Route to verifier-repair continuation with blockers, avoid-repeating guidance, and fresh-evidence requirements. |
| Agent retries `complete` without new evidence. | Store rejected attempt state and reject retry until blockers are fixed, evidenced, or explicitly cleared. |

## Acceptance criteria

The feature is complete when:

1. Goal state represents parent frame, parent goal, current target, target history, checkpoint packets, checkpoint resolutions, run mode, state version, and rejected verification repair state separately.
2. Parent frame can carry desired future, current truth, accepted/candidate claims, gates, non-claims/boundaries, residuals, authority limits, stale conditions, and external refs.
3. `checkpoint` can close a target while keeping parent goal active.
4. Checkpoint packets persist evidence, non-claims, remaining questions, touched artifacts, baseline refs, gate refs, and a target snapshot.
5. Ordinary hidden continuation and ordinary tool work stop after an accepted checkpoint.
6. Checkpoint guidance is generated for the next controller turn.
7. Controller turn records a checkpoint resolution, including any parent-state delta, before local work resumes.
8. Rejected parent completion produces verifier-repair continuation focused on blockers and fresh evidence.
9. Parent completion still requires `goal({ op: "complete" })` and independent verifier acceptance.
10. Shared serialization/parsing preserves parent frame, run mode, target/checkpoint/repair state, and state version across restore and handoff.
11. Checkpoint and resolution artifacts are visible and survive session restore.
12. Tests cover parent-frame persistence, target start, checkpoint commit/reject, continuation suppression, checkpoint guidance, parent-delta resolution, verification repair, compaction-mode routing, handoff carry-forward, resolution to next target, parent-completion separation, and stale side-agent rejection.
