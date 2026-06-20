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
| `/goal drop` | Drop an idle parent goal without completing it; rejected while planning, target work, checkpoint resolution, parent completion, or verification repair is pending. |

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

Run mode says what kind of continuation, if any, is allowed while a goal is active or exiting.

| Run mode | Meaning | Automatic continuation |
| --- | --- | --- |
| `working-target` | The agent may start a target, or work on the current target after its target plan is approved. | Ordinary target-work continuation. |
| `planning-target` | A target exists, but implementation and checkpointing are blocked while the agent drafts, revises, or submits its target plan. | Target-planning continuation only. Write/edit is limited to the active target-plan file. |
| `awaiting-checkpoint-resolution` | A checkpoint was accepted and needs a controller decision. | Controller guidance only; ordinary work is blocked. |
| `awaiting-parent-completion` | A checkpoint resolution selected `parent_completion_candidate`. | Parent-completion verification only; ordinary work and new targets are blocked. |
| `awaiting-verification-repair` | Parent completion was rejected and verifier blockers need repair. | Repair-focused continuation only. |
| `awaiting-user-input` | The next step needs user or external control, or target planning failed/staled out. | Suppressed. |
| `completed` | The parent goal completed and goal mode is exiting. | None. |

During `planning-target`, ordinary implementation tools are blocked. The allowed surface is discovery/review plus plan-file mutation: `read`, `search`, `find`, `lsp`, `web_search`, `task`, `job`, `irc`, `write`, `edit`, `resolve`, `goal`, and `yield`; `write`/`edit` may touch only the active `currentTargetPlan.planFilePath`.

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

Only one target is active at a time. A target must have an approved target plan before implementation/checkpointing, and must be closed by a checkpoint before its result can be promoted into parent state.

### Target plan

A target plan is the approval gate between selecting a target and executing it. Every `start_target` or checkpoint-resolution `next_target` creates a `currentTargetPlan`, writes its intended file path as `local://goal-<goal>-target-<n>-plan.md`, and switches run mode to `planning-target`.

Target plan status is one of:

- `drafting`
- `reviewing`
- `revision-required`
- `approved`
- `failed`
- `stale`

The plan records revision, target id, plan file path, verification aperture, verification signals, concern checks, scope calibration, branch evidence, excluded-work review, reviewer results, and optional failure details.

Approval requires two read-only side-agent reviews:

- `goal-target-aperture-reviewer` checks product signal, right-sizing, related-work bundling, concern cohesion, verification aperture, blast radius, and parent uncertainty reduction.
- `goal-target-execution-reviewer` checks that the plan is executable without unresolved choices.

Runtime approves only right-sized plans with accepted aperture and execution-readiness reviews, no blocking/important findings, unique signal/concern ids, a required primary verification signal, valid cross-references, passing dry run, and no excluded work classified as essential related or stale/unsupported.

Rejected plans stay in `planning-target`, become `revision-required`, and increment revision until the rejection cap fails the plan and moves to `awaiting-user-input`. Stale review results cannot overwrite newer revisions. A plan can also be failed explicitly when user input, external authority, missing task support, or no right-sized target prevents a valid plan.

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

Returns the complete visible goal state: parent goal, parent frame, run mode, current target, target history, current target plan, target-plan history, checkpoints, checkpoint resolutions, verifier repair state, budget, and completion metadata.

### `resume`

Reactivates a paused parent goal without changing its run mode.

### `drop`

Drops the parent goal without completing it. Runtime rejects drop while target planning, active target work, checkpoint resolution, parent completion, or verification repair is pending, so an in-flight goal cannot be silently relabeled as abandoned.

### `start_target`

Creates a bounded target and immediately opens target planning. It records the target, creates `currentTargetPlan`, stores the plan file path, and sets run mode to `planning-target`. It does not authorize implementation.

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
- `parent_deliverable_ids`

`start_target` is rejected while a checkpoint is pending resolution or while `awaiting-parent-completion`. It is also rejected when another active target exists, except during verifier repair: a new target linked to verifier blockers may supersede the active target.

### `submit_target_plan`

Submits the current target plan for review. The plan file must exist at `plan_file_path`, be non-empty, and match the current plan id/revision.

Required:

- `target_id`
- `target_plan_id`
- `plan_file_path`
- `revision`
- `verification_aperture`
- `verification_signals`
- `concern_checks`
- `scope_calibration`
- `branch_evidence`
- `excluded_work_review`
- `workflow_review_rounds`
- `dry_run`

`verification_aperture.primary_signal_id` must name a required entry in `verification_signals`. Signal/concern/scope/branch references must point to submitted ids. `dry_run.status` must be `passed`, every dry-run check must pass, and `workflow_review_rounds` must include the planner-side adversarial review.

`goal({op:"get"})` during `planning-target` prints the exact submission identity (`target_id`, `target_plan_id`, `plan_file_path`, `revision`) and a copyable `submit_target_plan` skeleton. Submissions are rejected if any identity field or graph reference does not match the current plan.

AgentSession runs the target aperture and execution-plan reviewers. Approval switches run mode to `working-target` and injects the approved plan for execution. Rejection keeps run mode `planning-target` with a higher revision. A current stale or failed plan moves to `awaiting-user-input`; stale reviewer output for a superseded revision is ignored and planning continues on the newer revision.

### `fail_target_plan`

Stops target planning when no valid plan can be submitted.

Required:

- `target_id`
- `target_plan_id`
- `revision`
- `reason`
- `message`
- `blockers`
- `suggested_questions`

Supported reasons are `needs-user-input`, `task-unavailable`, `external-authority`, and `unable-to-find-right-sized-target`. Failing a plan records failure details and moves run mode to `awaiting-user-input`.

### `checkpoint`

Requests closure of the current target after its target plan has been approved. Runtime rejects checkpointing while `planning-target` is active or when the current target lacks an approved matching plan.

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

If the approved target has verification signals, the checkpoint reviewer also requires current evidence for every required signal. It rejects aperture abuse such as hiding essential same-signal work in `not_claimed` or deferred work.

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

`next_target` is valid only when `decision` is `next_target`; it is required for that decision and rejected for all other decisions. A `next_target` resolution installs the next target and immediately opens target planning, so execution still waits for `submit_target_plan` approval.

Supported decisions:

| Decision | Effect |
| --- | --- |
| `next_target` | Applies `parent_delta`, clears the pending checkpoint, installs the next target, and switches to `planning-target`. |
| `parent_completion_candidate` | Clears the pending checkpoint and switches to `awaiting-parent-completion`. It allows a later parent `complete` attempt but does not complete the parent. |
| `needs_user_input` | Records that user or external input is needed and suppresses automatic continuation. The checkpoint remains pending. |
| `needs_broader_checks` | Records that broader checks or inputs are required before more local work. The checkpoint remains pending. |
| `pause_for_external_control` | Suppresses automatic continuation for external control. The checkpoint remains pending. |
| `drop_or_replace_recommended` | Records that the parent may need to be dropped or replaced. The checkpoint remains pending. |

### `complete`

Attempts parent completion. It invokes the independent goal completion verifier. It is rejected if target planning is pending, user/external input is pending, a checkpoint is pending, or verifier repair is open.

Successful completion exits goal mode. Rejected completion records verifier repair state and schedules repair-focused continuation.

## End-to-end lifecycle

### 1. Create parent goal

The user starts `/goal ...`. AgentSession runs the read-only goal rubric side agent, creates goal state, persists a goal mode-change entry, publishes a rubric artifact, and enables the hidden `goal` tool.

### 2. Start target planning

The agent calls `start_target` before substantial work when the parent needs bounded local progress. Runtime records the target, creates `currentTargetPlan`, sets the plan path, and switches run mode to `planning-target`.

### 3. Draft target plan

The target-planning continuation tells the agent to call `goal({op:"get"})`, use workflowz-style discovery/review when useful, spawn read-only `task` reviewers/decomposers, supervise them with `job`, coordinate through `irc`, write only the active target-plan file, and avoid implementation, checkpointing, completion, and non-plan mutation.

The target plan must specify target aperture, execution steps, verification, verification-signal aperture, excluded work, and a dry run.

### 4. Submit and review target plan

The agent calls `submit_target_plan` only after the plan dry run passes and planner-side adversarial review is recorded. AgentSession verifies the plan file, captures the current goal/target/plan expectation, and runs the read-only aperture and execution reviewers.

Side-agent output is stale if the goal id, state version, parent frame version, target id, target plan id, or target sequence changed while reviewers ran. Stale output cannot overwrite a newer plan revision; stale output for a superseded revision does not halt planning.

If the plan is approved, runtime records approval on the target plan, copies the verification aperture/signals/concern checks/scope calibration onto the active target, switches to `working-target`, publishes a `goal_target_plan` artifact, and injects the approved plan for execution.

If the plan is rejected, runtime records review feedback, increments the plan revision, and stays in `planning-target`. If the rejection cap is hit, the current plan is stale, or the agent calls `fail_target_plan`, runtime records failure or stale state and switches to `awaiting-user-input`.

### 5. Work locally

The ordinary hidden continuation dispatcher can resume target work while all normal interactive guards are clear:

- goal mode enabled and not paused;
- parent status active;
- run mode not `awaiting-user-input`;
- no queued user input;
- editor has no pending text/images;
- no plan/loop mode conflict;
- no streaming/compaction blocker.

For an active current target, checkpointing remains blocked until the matching target plan is approved.

### 6. Request checkpoint

When the approved target meets its closure standard, the agent calls `checkpoint` with concrete evidence and explicit non-claims.

AgentSession builds a candidate packet and runs the read-only checkpoint reviewer side agent. The reviewer receives structured goal state, the candidate checkpoint, and transcript/context. It can accept or reject only local target closure.

For approved target-plan work, checkpoint review is verification-signal-gated: every required signal from the approved plan needs current evidence before the target can close.

Side-agent output is stale if the goal id, state version, target id, pending checkpoint, verifier attempt, or parent frame version changed while the side agent ran. Stale output cannot mutate state.

### 7A. Accepted checkpoint

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

### 7B. Rejected checkpoint

Runtime:

- keeps the target active;
- records the rejection feedback;
- leaves run mode as `working-target`;
- publishes a rejected `goal-checkpoint` artifact.

Visible output says the checkpoint was rejected and the target remains active.

### 8. Resolve checkpoint

The checkpoint guidance side agent prepares a controller continuation from the structured goal snapshot, checkpoint packet, and transcript. The controller must call `resolve_checkpoint`.

If resolution installs a next target, runtime switches immediately to `planning-target` for that target. If it selects user input or broader checks, automatic work is suppressed and the checkpoint remains pending. If it selects `parent_completion_candidate`, runtime switches to `awaiting-parent-completion`; ordinary tools stay blocked until `complete` runs verifier acceptance.

### 9. Complete parent goal

The agent calls `complete` only when parent evidence is ready, no checkpoint is pending, and verifier repair is clear.

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
| `goal-target-aperture-reviewer` | Accepts or rejects the target plan's product/verification aperture. |
| `goal-target-execution-reviewer` | Accepts or rejects the target plan's execution readiness. |
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
| `goal_target_plan` | Approved, revision-required, stale, or failed target-plan review result. |
| `goal-checkpoint` | Accepted or rejected target checkpoint. |
| `goal-checkpoint-resolution` | Controller decision for a checkpoint. |
| `goal-verification-feedback` | Parent completion verifier rejection details. |

Rubric, checkpoint, target-plan, and resolution artifacts label parent-active/non-completion boundaries. If runtime state was committed while streaming but the custom message was not flushed before restore, AgentSession reconstructs missing rubric/target-plan/checkpoint/resolution artifacts from serialized goal state. Serialized goal state remains source of truth; custom messages are audit surfaces only. Rubric artifacts are display-only and excluded from model context injection. Session logs persist full goal state in `goal_state_snapshot` entries; ordinary `mode_change` entries carry only compact `{ goalId, stateVersion, snapshotEntryId }` markers, and accounting-only token updates use `goal_usage_delta`.

## Compaction, handoff, and recovery

Goal mode contributes explicit context to compaction and handoff:

- parent frame;
- current target;
- current target plan;
- approved target-plan reference;
- pending checkpoint;
- checkpoint resolution state;
- verification repair state;
- non-claims;
- residuals;
- gates;
- stale conditions;
- exact next local action.

Recovery behavior is mode-aware:

| State at compaction/restore | Recovery behavior |
| --- | --- |
| `planning-target` | Resume target planning; implementation/checkpointing remain blocked until the plan is approved. |
| `working-target` | Resume the same open target, using the approved target plan when one is active. |
| `awaiting-checkpoint-resolution` | Route to checkpoint controller guidance. |
| `awaiting-parent-completion` | Route to parent completion verification. |
| `awaiting-verification-repair` | Route to verifier-blocker repair. |
| `awaiting-user-input` | Do not auto-continue. |

Overflow and incomplete-output recovery preserve goal state without creating or resolving checkpoints. Handoff compaction writes a recovery `goal_state_snapshot`, restores the `goal` tool, and schedules the correct continuation by run mode.

## UI behavior

The status line distinguishes:

- ordinary active goal work;
- checkpoint pending;
- checkpoint resolving;
- target planning;
- target-plan review in progress;
- parent completion verification pending;
- parent completion verification in progress;
- verifier repair pending;
- verifier repair in progress;
- awaiting user or external input;
- pause.

The goal menu exposes inspection and control actions for parent details, target, parent frame, gates/residuals/boundaries, latest checkpoint, latest resolution, rubric, verifier feedback, budget, pause, resume, checkpoint-resolution resume, parent-completion verification resume, and drop.

When a target-planning continuation is dispatched, the UI temporarily makes `task`, `job`, `irc`, `write`, `edit`, and `goal` available so the agent can coordinate read-only planning helpers, draft the fixed plan file, and submit it. Those tools are restored when planning exits. When a plan is approved, the UI injects the approved plan as a synthetic execution prompt and stores a target-plan reference so later compaction/handoff can re-surface it if needed.

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
- A target starts in `planning-target`; implementation and checkpointing require an approved target plan.
- Target-plan approval requires right-sized aperture review, execution-readiness review, required primary verification signal, valid signal references, and a passing dry run.
- A checkpoint closes only a target.
- Parent completion requires `complete` and verifier acceptance.
- Accepted checkpoint blocks ordinary continuation until `resolve_checkpoint`.
- Rejected checkpoint keeps the target active.
- A `next_target` checkpoint resolution starts another target-planning gate; it does not authorize immediate implementation.
- Parent-frame mutations come from `parent_delta`, not prose.
- Verifier rejection blocks immediate repeat `complete` calls until fresh repair evidence exists.
- Read-only side-agent output cannot mutate state if stale.
- Restore, compaction, overflow recovery, and handoff preserve target plans, pending checkpoint, verifier repair state, and parent-frame boundaries.
- `task` remains current-target fan-in; task output is not accepted parent truth by itself.
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

After `start_target`, runtime enters `planning-target` and creates `currentTargetPlan.planFilePath`. The agent drafts that plan, submits it with `submit_target_plan`, and may implement only after the plan is approved.

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

After the target plan is approved and the checkpoint is accepted, ordinary work stops. The controller resolves it:

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
