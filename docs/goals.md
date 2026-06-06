# Goal mode

Goal mode keeps a long-running objective moving without letting partial work masquerade as completion. It gives the agent a durable parent goal, one bounded current target at a time, evidence-backed checkpoints, explicit controller decisions, and an independent parent-completion verifier.

The central rule is simple: **a checkpoint can close a target, but it never completes the parent goal**. Parent completion still requires `goal({ "op": "complete" })` and verifier acceptance.

## When to use goal mode

Use goal mode for objectives that are too large or too reliability-sensitive to treat as one uninterrupted implementation pass:

- release or migration work with multiple evidence gates;
- broad refactors where different targets should close independently;
- high-stakes debugging where claims need current evidence;
- work that may compact, hand off, or resume across sessions;
- any task where “what is locally done” and “what is globally done” must stay separate.

Do not use checkpoints for fatigue, low budget, arbitrary phase boundaries, or incomplete work. A checkpoint is earned by evidence that the current target is closed.

## Starting and managing a goal

Interactive sessions start goal mode with `/goal`:

```text
/goal Improve release reliability
```

If no objective is supplied, the UI prompts for one. `/goal` with an active or paused goal opens the goal menu.

Useful subcommands:

| Command | Effect |
| --- | --- |
| `/goal set <objective>` | Start a new goal, or replace the active goal objective. |
| `/goal show` | Show parent goal details. |
| `/goal target` or `/goal show target` | Show the current target. |
| `/goal frame` or `/goal show frame` | Show the parent frame. |
| `/goal gates` or `/goal show gates` | Show gates, residuals, and boundaries. |
| `/goal checkpoint` or `/goal show checkpoint` | Show the latest checkpoint. |
| `/goal resolution` or `/goal show resolution` | Show the latest checkpoint resolution. |
| `/goal rubric` or `/goal show rubric` | Surface the generated rubric artifact. |
| `/goal feedback` or `/goal show feedback` | Surface verifier feedback. |
| `/goal budget <tokens>` | Set a positive token budget. |
| `/goal budget off` | Clear the token budget. |
| `/goal pause` | Pause goal mode. |
| `/goal resume` | Resume a paused goal. |
| `/goal drop` | Drop the parent goal without completing it. |

Goal mode is disabled when `goal.enabled` is false. It cannot run at the same time as plan mode.

## Vocabulary

### Parent goal

The parent goal is the user objective and its durable state. It owns lifecycle, budget accounting, rubric, parent frame, targets, checkpoints, checkpoint resolutions, verifier attempts, and repair state.

Parent status is one of:

- `active`
- `paused`
- `budget-limited`
- `complete`
- `dropped`

Parent status is deliberately separate from run mode.

### Run mode

Run mode says what kind of continuation, if any, is allowed while the parent remains active.

| Run mode | Meaning | Automatic continuation |
| --- | --- | --- |
| `working-target` | The agent may work on the current target or start one. | Ordinary target-work continuation. |
| `awaiting-checkpoint-resolution` | A checkpoint was accepted and needs a controller decision. | Controller guidance only; ordinary work is blocked. |
| `awaiting-verification-repair` | Parent completion was rejected and verifier blockers need repair. | Repair-focused continuation only. |
| `awaiting-user-input` | The next step needs user or external control. | Suppressed. |
| `awaiting-background-lane-intake` | A background lane reported `blocks_if_fired: true` and needs operator intake. | Suppressed until the structured lane blocker is dispositioned. |

### Background lane

A background lane is a durable divergent branch with an attached child OMP session and an explicit parent-disposition obligation. It is distinct from `task`: tasks fan into the current target; background lanes may continue while the main spine advances from an accepted checkpoint.

Each lane records a stable id, checkpoint/source origin, branch and worktree handles, child session handle/status, `question`, `blocks_if`, `required_before_parent`, lane status, latest report/patch refs, and close disposition. Branch existence, child prose, patch existence, checks, RPC ACKs, and lane closure are candidate signals only; none are accepted parent truth.

Required lanes in `open`, `blocked`, or `spawn_failed` state reject parent completion. A blocking lane report switches run mode to `awaiting-background-lane-intake`; ordinary target continuation is blocked until intake closes or otherwise dispositions the structured blocker.

### Parent frame

The parent frame is the durable truth model for the parent goal. It can be sparse for ordinary goals or detailed for claim-gated work.

It can record:

- desired future;
- current truth;
- accepted claims;
- candidate claims;
- rejected or stale claims;
- gates;
- boundaries and non-claims;
- residuals;
- authority state;
- stale conditions;
- external refs.

Runtime uses generic claim/evidence/boundary/authority fields. Project-specific release records, issue taxonomies, or skill formats stay outside runtime and can be represented through external refs.

### Target

A target is a bounded piece of work inside the parent goal. It has a title, desired future claim, closure standard, optional expected parent contribution, baseline refs, gate refs, evidence expectations, non-goals, forbidden claims, stale conditions, and optional verifier-blocker links.

Only one target is active at a time. A target must be closed by a checkpoint before its result can be promoted into parent state.

### Checkpoint

A checkpoint is a packet of current evidence saying the active target is locally closed. It contains the target snapshot, summary, local claims, evidence, checks run, artifacts touched, non-claims, remaining questions, risks/caveats, stale conditions, and reviewer result.

A checkpoint does not complete the parent goal. It creates a controller boundary.

### Checkpoint resolution

A checkpoint resolution is the controller decision after an accepted checkpoint. It decides what the checkpoint means for the parent frame and what happens next.

Parent-frame mutation is allowed only through structured `parent_delta`. Prose fields such as `parent_reading` explain the decision but do not mutate parent truth.

### Verification repair

Verification repair is created when parent completion is rejected. It records verifier blockers, evidence to collect, actions to avoid repeating, and the verifier attempt id. It blocks immediate cosmetic retries of `complete` until fresh repair evidence is gathered.

## Agent-facing tool API

The hidden `goal` tool is the only agent-facing mutation API for goal state. It uses a single `op` discriminator.

### `create`

Starts a parent goal.

Required:

- `objective`

Optional:

- `token_budget`
- `parent_frame`

Use only when no active or paused goal exists.

### `get`

Returns the complete visible goal state: parent goal, parent frame, run mode, current target, target history, checkpoints, checkpoint resolutions, verifier repair state, budget, and completion metadata.

### `resume`

Reactivates a paused parent goal without changing its run mode.

### `drop`

Drops the parent goal without completing it.

### `start_target`

Starts bounded target work.

Required:

- `title`
- `desired_future_claim`
- `closure_standard`

Optional:

- `expected_parent_contribution`
- `baseline_refs`
- `gate_refs`
- `evidence_expectation`
- `non_goals`
- `forbidden_claims`
- `stale_if`
- `linked_verifier_blocker_ids`

`start_target` is rejected while a checkpoint is pending resolution. During verifier repair, a new target must link to verifier blocker ids.

### `checkpoint`

Requests closure of the current target.

Required:

- `status: "closed_with_evidence"`
- `summary`
- non-empty `local_claims`
- non-empty `evidence`
- non-empty `not_claimed`
- non-empty `remaining_questions`

Optional:

- `checks_run`
- `artifacts_touched`
- `risks_or_caveats`
- `stale_if`
- `suggested_controller_questions`
- `retrospective_target` for legacy sessions only

At least one evidence item must be current and must have a claim and evidence string.

Runtime also injects default non-claims into checkpoint packets:

- parent goal complete;
- external checks verified;
- future target selected;
- durable project memory or guidance updated;
- external/user authority granted.

### `resolve_checkpoint`

Records the controller decision for the pending checkpoint.

Required:

- `checkpoint_id`
- `decision`
- `parent_reading`
- `not_propagated`
- `remaining_parent_work`

Optional:

- `parent_delta`
- `broader_checks_or_inputs`
- `lessons_for_future`
- `next_target`

`next_target` is valid only when `decision` is `next_target`; it is required for that decision and rejected for all other decisions.

`parent_delta.background_lanes_to_spawn` can request generic background lanes after an accepted checkpoint. AgentSession commits the checkpoint resolution before spawning those lanes as side effects; a side-effect failure records a retryable `spawn_failed` lane and does not roll back checkpoint acceptance. Lane requests use only generic fields: `from.checkpoint_id`, `from.source_ref`, `contract.question`, `contract.blocks_if`, `contract.required_before_parent`, and `assignment`.

Supported decisions:

| Decision | Effect |
| --- | --- |
| `next_target` | Applies `parent_delta`, clears the pending checkpoint, installs the next target, and returns to `working-target`. |
| `parent_completion_candidate` | Clears the pending checkpoint and allows a later parent `complete` attempt. It does not complete the parent. |
| `needs_user_input` | Records that user or external input is needed and suppresses automatic continuation. The checkpoint remains pending. |
| `needs_broader_checks` | Records that broader checks or inputs are required before more local work. The checkpoint remains pending. |
| `pause_for_external_control` | Suppresses automatic continuation for external control. The checkpoint remains pending. |
| `drop_or_replace_recommended` | Records that the parent may need to be dropped or replaced. The checkpoint remains pending. |

### `complete`

Attempts parent completion. It invokes the independent goal completion verifier. It is rejected if a checkpoint is pending, verifier repair is open, any required background lane remains undispositioned, or any structured background-lane blocker still requires intake.

Successful completion exits goal mode. Rejected completion records verifier repair state and schedules repair-focused continuation.

## Background lane tool API

Goal-mode sessions also expose a hidden `background_lane` tool for model/controller use. It is separate from `task`.

| Operation | Effect |
| --- | --- |
| `spawn` | Validates active goal state, accepted checkpoint, clean git source, and commit `source_ref`; persists the lane record; then creates a persistent branch/worktree and starts or reattaches a child OMP RPC session. |
| `list` | Returns compact lane ledger rows: id, question, agent status, lane status, outcome, required-before-parent, blocker flag, and branch. |
| `message` | Sends durable follow-up to the child lane session, restarting or reattaching in the same worktree/session when possible. |
| `snapshot` | Observes head, changed files, patch artifact, latest report, and blocker state against the immutable source commit. It does not accept, merge, or close anything. |
| `close` | Records explicit lane disposition and reason. `merged` requires a merge ref or operator statement, but still does not imply semantic parent acceptance. |

Child lane sessions receive a static handoff that includes lane id, checkpoint/source origin, question, `blocks_if`, required-before-parent, assignment, and authority limits. The child-only `lane_report` host tool records structured summaries, blocker status, changed files, evidence refs, non-claims, and stale-if data. Parent blocker state is derived from `lane_report.blocks_if_fired`, never from child prose.

## End-to-end lifecycle

### 1. Create parent goal

The user starts `/goal ...`. AgentSession runs the read-only goal rubric side agent, creates goal state, persists a goal mode-change entry, publishes a rubric artifact, and enables the hidden `goal` tool.

### 2. Start target

The agent calls `start_target` before substantial work when the parent needs bounded local progress. Runtime records the target and sets run mode to `working-target`.

### 3. Work locally

The ordinary hidden continuation dispatcher can resume target work while all normal interactive guards are clear:

- goal mode enabled and not paused;
- parent status active;
- run mode not `awaiting-user-input`;
- no queued user input;
- editor has no pending text/images;
- no plan/loop mode conflict;
- no streaming/compaction blocker.

### 4. Request checkpoint

When the target meets its closure standard, the agent calls `checkpoint` with concrete evidence and explicit non-claims.

AgentSession builds a candidate packet and runs the read-only checkpoint reviewer side agent. The reviewer receives structured goal state, the candidate checkpoint, and transcript/context. It can accept or reject only local target closure.

Side-agent output is stale if the goal id, state version, target id, pending checkpoint, verifier attempt, or parent frame version changed while the side agent ran. Stale output cannot mutate state.

### 5A. Accepted checkpoint

Runtime:

- closes the target;
- snapshots the target into the checkpoint packet;
- appends the checkpoint;
- sets `pendingCheckpointId`;
- keeps parent status active;
- sets run mode to `awaiting-checkpoint-resolution`;
- clears linked verifier repair when the target closed the relevant blockers;
- publishes a `goal-checkpoint` artifact.

Ordinary continuation stops. Tool execution is guarded so implementation tools cannot proceed as if the checkpoint were merely a pause. The controller continuation must resolve the checkpoint.

### 5B. Rejected checkpoint

Runtime:

- keeps the target active;
- records the rejection feedback;
- leaves run mode as `working-target`;
- publishes a rejected `goal-checkpoint` artifact.

Visible output says the checkpoint was rejected and the target remains active.

### 6. Resolve checkpoint

The checkpoint guidance side agent prepares a controller continuation from the structured goal snapshot, checkpoint packet, and transcript. The controller must call `resolve_checkpoint`.

If resolution installs a next target, work returns to `working-target`. If it selects user input or broader checks, automatic work is suppressed. If it selects `parent_completion_candidate`, the parent is still active; the agent may attempt `complete`, but verifier acceptance is still required.

When `parent_delta.background_lanes_to_spawn` is present, lane spawning happens after the resolution is durably recorded. Required lanes become parent-completion obligations immediately; non-blocking lanes do not stop ordinary target continuation. If a lane later reports `blocks_if_fired: true` through `lane_report`, run mode switches to `awaiting-background-lane-intake` and ordinary continuation is suppressed until intake.

### 7. Complete parent goal

The agent calls `complete` only when parent evidence is ready, no checkpoint is pending, verifier repair is clear, and every required background lane has an explicit close disposition.

AgentSession runs the read-only completion verifier side agent. If accepted, runtime marks the parent complete and exits goal mode. If rejected, runtime records verification repair, publishes verifier feedback, and routes continuation to blocker repair.

## Side agents

Bundled goal side agents are read-only. Their tool allowlist is:

- `read`
- `search`
- `find`
- `yield`

Goal side agents:

| Agent | Purpose |
| --- | --- |
| `goal-rubric` | Generates the initial evergreen rubric for the parent objective. |
| `goal-checkpoint-reviewer` | Accepts or rejects local target closure. |
| `goal-checkpoint-guidance` | Prepares the controller continuation after accepted checkpoint. |
| `goal-completion-verifier` | Accepts or rejects parent completion. |
| `goal-continuation-compactor` | Produces concise continuation focus when needed. |

They receive structured snapshots; they do not infer authority solely from transcript prose.

## Artifacts and restore

Goal mode writes custom session messages for durable user-visible state:

| Custom type | Meaning |
| --- | --- |
| `goal-rubric` | Generated completion rubric. |
| `goal-checkpoint` | Accepted or rejected target checkpoint. |
| `goal-checkpoint-resolution` | Controller decision for a checkpoint. |
| `goal-verification-feedback` | Parent completion verifier rejection details. |
| `background-lane-created` | Durable lane was created from checkpoint/source origin. |
| `background-lane-updated` | Lane branch/session/snapshot/spawn-failure state changed. |
| `background-lane-report` | Structured child `lane_report` was recorded. |
| `background-lane-closed` | Lane close outcome/reason was recorded. |

Checkpoint, resolution, and background-lane artifacts label parent-active/non-completion boundaries. If runtime state was committed while streaming but the custom message was not flushed before restore, AgentSession reconstructs missing checkpoint/resolution/lane artifacts from serialized goal state. The serialized lane ledger remains the source of truth; custom messages are audit surfaces only.

## Compaction, handoff, and recovery

Goal mode contributes explicit context to compaction and handoff:

- parent frame;
- current target;
- pending checkpoint;
- checkpoint resolution state;
- verification repair state;
- background lane ledger, branch/worktree/session refs, reports, blockers, and close dispositions;
- non-claims;
- residuals;
- gates;
- stale conditions;
- exact next local action.

Recovery behavior is mode-aware:

| State at compaction/restore | Recovery behavior |
| --- | --- |
| `working-target` | Resume the same open target. |
| `awaiting-checkpoint-resolution` | Route to checkpoint controller guidance. |
| `awaiting-verification-repair` | Route to verifier-blocker repair. |
| `awaiting-user-input` | Do not auto-continue. |
| `awaiting-background-lane-intake` | Route to lane intake; ordinary target continuation remains blocked while structured lane blockers are open. |

Overflow and incomplete-output recovery preserve goal state without creating or resolving checkpoints. Handoff compaction serializes goal mode state, including the background-lane ledger, into the new session, restores the `goal` and `background_lane` tools, and schedules the correct continuation by run mode.

## UI behavior

The status line distinguishes:

- ordinary active goal work;
- checkpoint pending;
- checkpoint resolving;
- verifier repair pending;
- verifier repair in progress;
- pause.

The goal menu exposes inspection and control actions for parent details, target, parent frame, gates/residuals/boundaries, latest checkpoint, latest resolution, rubric, verifier feedback, budget, pause, resume, checkpoint-resolution resume, and drop.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `goal.enabled` | `true` | Enables per-session goal mode and the hidden goal tool. |
| `goal.statusInFooter` | `true` | Shows token budget alongside the goal indicator in the status line. |
| `goal.continuationModes` | `["interactive"]` | Interface modes where active goals may auto-continue between turns. |
| `goal.maxCompletionAttempts` | `3` | Maximum rejected completion-verifier attempts before surfacing max-attempt rejection. |

## Invariants

These are the safety boundaries goal mode preserves:

- Parent lifecycle and active run mode are separate.
- A checkpoint closes only a target.
- Parent completion requires `complete` and verifier acceptance.
- Accepted checkpoint blocks ordinary continuation until `resolve_checkpoint`.
- Rejected checkpoint keeps the target active.
- Parent-frame mutations come from `parent_delta`, not prose.
- Verifier rejection blocks immediate repeat `complete` calls until fresh repair evidence exists.
- Read-only side-agent output cannot mutate state if stale.
- Restore, compaction, overflow recovery, and handoff preserve pending checkpoint, verifier repair state, and the durable background-lane ledger.
- Required background lanes block parent completion until closed/dispositioned.
- Blocking lane state comes from structured `lane_report`, not child prose.
- Lane output, branch existence, patch existence, passing checks, RPC ACKs, and lane close are not accepted parent truth.
- `task` remains current fan-in and never creates or satisfies background-lane obligations.
- Runtime state is generic; project-specific release or domain truth belongs in external refs, skills, prompts, or parent-frame data, not hardcoded goal-mode logic.

## Example sequence

```json
{
  "op": "start_target",
  "title": "Prove installer smoke covers worker startup",
  "desired_future_claim": "Compiled installer smoke fails if the stats worker cannot start.",
  "closure_standard": "A focused smoke command exercises worker startup and fails on startup failure.",
  "forbidden_claims": ["Release is ready", "CI is green"]
}
```

```json
{
  "op": "checkpoint",
  "status": "closed_with_evidence",
  "summary": "The smoke path now exercises stats worker startup.",
  "local_claims": ["The smoke probe fails if stats worker startup is broken."],
  "evidence": [
    {
      "claim": "The smoke probe exercises stats worker startup.",
      "evidence": "scripts/install-tests/run-ci.sh invokes omp --smoke-test after install.",
      "current": true
    }
  ],
  "checks_run": ["focused smoke command"],
  "artifacts_touched": ["scripts/install-tests/run-ci.sh"],
  "not_claimed": ["Parent goal is complete", "Release is ready", "CI is green"],
  "remaining_questions": ["Should the next target be CI coverage or tarball install verification?"]
}
```

If accepted, ordinary work stops. The controller resolves it:

```json
{
  "op": "resolve_checkpoint",
  "checkpoint_id": "goal-1-checkpoint-1",
  "decision": "next_target",
  "parent_reading": "The local smoke target is closed, but parent release reliability still needs distribution-path evidence.",
  "parent_delta": {
    "admitted_claims": [
      {
        "id": "compiled-installer-smoke-starts-worker",
        "claim": "Compiled installer smoke path has local evidence for stats worker startup.",
        "status": "accepted",
        "evidence_refs": [{ "id": "checkpoint:goal-1-checkpoint-1", "kind": "artifact" }],
        "non_implications": ["Release is ready", "Tarball install path is verified"]
      }
    ]
  },
  "not_propagated": ["Release is ready", "Tarball install path is verified"],
  "remaining_parent_work": ["Prove tarball install path"],
  "next_target": {
    "title": "Prove tarball smoke path",
    "desired_future_claim": "Tarball install path exercises smoke startup.",
    "closure_standard": "Current tarball smoke output exists.",
    "forbidden_claims": ["Release is ready"]
  }
}
```

Only after all parent evidence is ready should the agent call:

```json
{ "op": "complete" }
```

Verifier acceptance, not checkpoint existence, is what closes the parent goal.
