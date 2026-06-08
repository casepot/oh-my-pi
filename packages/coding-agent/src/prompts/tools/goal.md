Manage the active goal-mode objective.

Goal mode separates a long parent objective from bounded current targets. A checkpoint may close the current target with evidence, but it never completes the parent. Parent completion always goes through `complete` and the independent verifier.

Use this tool for goal control state only: parent framing, target lifecycle, checkpoint disposition, parent-frame deltas, background-lane requests, and parent completion verification. Ordinary implementation, investigation, and verification still use the normal tools when the current run mode allows them.

<model>
- **Parent goal**: the durable objective. It owns status, parent frame, targets, checkpoints, checkpoint resolutions, verifier repair, background lanes, and budget accounting.
- **Current target**: a bounded slice of local work. Start one before substantial work when the parent needs claim-gated progress.
- **Checkpoint**: evidence-backed target closure reviewed by a side agent. Accepted checkpoints pause ordinary continuation until `resolve_checkpoint`; rejected checkpoints leave the target active.
- **Parent frame**: optional claim-gated state: desired/current truth, refs, accepted/candidate/rejected claims, boundaries, residuals, gates, frontier, stale conditions, authority, and external refs.
- **Run mode**: what continuation is allowed. `working-target` permits local work; `awaiting-checkpoint-resolution`, `awaiting-parent-completion`, and `awaiting-background-lane-intake` block ordinary tool work until the relevant goal/lane action; `awaiting-verification-repair` permits repair-focused work; `awaiting-user-input` suppresses automatic continuation; `completed` is terminal.
</model>

<operations>
- `create`: start a parent goal. Requires `objective`; optional `token_budget` must be a positive integer; optional `parent_frame` seeds claim/gate/boundary/residual/authority state. Use only when no active or paused goal already exists.
- `get`: inspect current goal state: parent frame, run mode, target history, current target, checkpoints, resolutions, verifier repair, background lanes, and remaining budget.
- `resume`: reactivate a paused parent goal without changing its run mode.
- `start_target`: start a bounded current target. Requires `title`, `desired_future_claim`, and `closure_standard`. Optional: `expected_parent_contribution`, `parent_deliverable_ids`, `baseline_refs`, `gate_refs`, `evidence_expectation`, `non_goals`, `forbidden_claims`, `stale_if`, `linked_verifier_blocker_ids`.
- `checkpoint`: submit target-closure evidence for review. Requires `status:"closed_with_evidence"`, `summary`, non-empty `local_claims`, non-empty `evidence`, non-empty `not_claimed`, and non-empty `remaining_questions`. Optional: `checks_run`, `artifacts_touched`, `risks_or_caveats`, `stale_if`, `suggested_controller_questions`, `retrospective_target` for legacy sessions only.
- `resolve_checkpoint`: record the controller decision for the pending accepted checkpoint. Requires `checkpoint_id`, `decision`, `parent_reading`, `not_propagated`, and `remaining_parent_work`. Optional: `parent_delta`, `broader_checks_or_inputs`, `lessons_for_future`, and `next_target` for `decision:"next_target"`.
- `complete`: attempt verified parent completion. Use only when there is no pending checkpoint, no undispositioned required background lane, no open lane blocker, and no unrepaired verifier blocker.
- `drop`: drop the parent goal without completing it.
</operations>

<target-aperture>
Targets are completion units, not process phases or miniature parent goals.
- Project/domain target rules override generic splitting. If they define a minimum target unit, `start_target` MUST use that unit.
- NEVER start targets for internal process phases such as planning, implementation contact, evidence review, record writing, closure, recomposition, or reviewer passes.
- A target is too broad when its `closure_standard` would satisfy nearly all parent completion criteria.
- Include `parent_deliverable_ids` when the compact deliverable map shows which parent deliverables this target contributes to.
- Include `non_goals` and `forbidden_claims` that prevent target closure from laundering parent completion.
- Absent project-specific target rules, split by evidence boundary, subsystem, or deliverable; if the parent objective is already one atomic deliverable, one target may cover it.
- At checkpoint resolution, prefer `decision:"next_target"` while any parent deliverable lacks accepted current evidence. Use `parent_completion_candidate` only when remaining work is genuinely parent verification, not unresolved implementation, evidence collection, review convergence, or domain closeout.
</target-aperture>

<checkpoint-resolution>
`resolve_checkpoint.decision` must be one of:
- `next_target`: applies `parent_delta`, clears the pending checkpoint, installs `next_target`, and returns to `working-target`. `next_target` is required for this decision and rejected for every other decision.
- `parent_completion_candidate`: applies `parent_delta`, clears the pending checkpoint, enters `awaiting-parent-completion`, and makes the next action `complete`. It does not complete the parent. Use only when every parent deliverable already has accepted current evidence and the remaining work is verifier confirmation.
- `needs_user_input`, `needs_broader_checks`, `pause_for_external_control`, or `drop_or_replace_recommended`: records the controller reading and leaves continuation suppressed. Do not include `next_target`.

`parent_delta` is the only way to mutate parent-frame truth or compact deliverable-map status through this tool. It may include:
- `admitted_claims`, `candidate_claims_added`, `rejected_claims`;
- `boundaries_added`, `residuals_added_or_updated`, `gate_deltas`, `frontier_deltas`;
- `stale_refs`, `external_record_refs`, `authority_decision_refs`;
- `background_lanes_to_spawn`;
- `deliverable_deltas` for compact deliverable-map status/evidence/blocker/next-target updates.

`parent_delta.background_lanes_to_spawn` requests generic background lanes after the checkpoint resolution is durably recorded. Each request uses `from.source_ref`, optional `from.checkpoint_id` (defaults to the resolved checkpoint), `contract.question`, `contract.blocks_if`, `contract.required_before_parent`, `assignment`, and optional `agent`.
</checkpoint-resolution>

<output>
Returns a compact status summary and structured details containing the goal, state, remaining budget, checkpoint/review, checkpoint resolution, and completion-verification data when applicable. A rejected checkpoint means the target remains active. A rejected completion records verifier repair state; it is not a soft success.
</output>

<critical>
Invalid uses:
- NEVER call `checkpoint` for fatigue, low budget, partial work, or arbitrary phase boundaries. Checkpoint only when the current target is actually closed with evidence.
- NEVER treat `checkpoint` or `resolve_checkpoint` as parent completion.
- NEVER call `complete` while a checkpoint is pending. Resolve it first; if the resolution is `parent_completion_candidate`, immediately call `complete`.
- NEVER start a target that violates project/domain target-unit rules or whose closure standard is effectively the whole parent completion standard unless the parent goal is already one atomic deliverable.
- NEVER mutate parent frame through prose. Use `resolve_checkpoint.parent_delta`.
- NEVER include `next_target` unless `decision` is exactly `next_target`.
- NEVER retry `complete` after verifier rejection until the blockers have fresh repair evidence or a blocker-scoped target links to `linked_verifier_blocker_ids`.
- Do not start unrelated target work while run mode is `awaiting-checkpoint-resolution`, `awaiting-parent-completion`, or `awaiting-background-lane-intake`.
</critical>

<examples>
Create a claim-gated parent:
```json
{"op":"create","objective":"Improve release reliability","token_budget":50000,"parent_frame":{"kind":"claim-gated","desired_future":"Release work advances through explicit claims, evidence, non-claims, and controller-approved next targets.","current_truth":"Some local evidence exists; parent readiness is not accepted.","boundaries":[{"id":"local-evidence-not-release","kind":"forbidden-inference","statement":"Local evidence does not imply release readiness."}]}}
```

Start a bounded target:
```json
{"op":"start_target","title":"Prove installer smoke catches worker startup failure","desired_future_claim":"Installer smoke evidence fails when worker startup is broken.","expected_parent_contribution":"Closes one evidence gap without claiming release readiness.","closure_standard":"A focused smoke command fails on worker startup errors.","parent_deliverable_ids":["D1"],"evidence_expectation":["smoke command output"],"non_goals":["full release readiness"],"forbidden_claims":["CI is green","release is ready"],"stale_if":["installer smoke path changes"]}
```

Checkpoint closed target evidence:
```json
{"op":"checkpoint","status":"closed_with_evidence","summary":"The smoke path now exercises worker startup.","local_claims":["The smoke probe fails if worker startup is broken."],"evidence":[{"claim":"The smoke probe exercises worker startup.","evidence":"Focused smoke command output shows worker startup was exercised.","current":true}],"checks_run":["focused smoke command"],"artifacts_touched":["scripts/install-tests/run-ci.sh"],"not_claimed":["Parent goal is complete","Release is ready","CI is green"],"remaining_questions":["Should the next target cover distribution-path evidence?"]}
```

Resolve to the next target:
```json
{"op":"resolve_checkpoint","checkpoint_id":"goal-1-checkpoint-1","decision":"next_target","parent_reading":"The target is closed locally, but the parent still needs distribution-path evidence.","parent_delta":{"admitted_claims":[{"id":"installer-smoke-worker-startup","claim":"Installer smoke has local evidence for worker startup coverage.","status":"accepted","evidence_refs":[{"id":"checkpoint:goal-1-checkpoint-1","kind":"artifact"}],"non_implications":["Release is ready","Distribution path is verified"]}],"boundaries_added":[{"id":"local-smoke-not-distribution","kind":"forbidden-inference","statement":"Local smoke success does not prove distribution install success."}],"deliverable_deltas":[{"id":"D1","status":"partial","evidence_refs":[{"id":"checkpoint:goal-1-checkpoint-1","kind":"artifact"}],"next_relevant_target":"Prove distribution install runs smoke path"}]},"next_target":{"title":"Prove distribution install runs smoke path","desired_future_claim":"Distribution installs run the same smoke path.","closure_standard":"Distribution install test runs the smoke command and fails on worker startup errors.","parent_deliverable_ids":["D1"]},"not_propagated":["Local evidence is not distribution evidence."],"remaining_parent_work":["Distribution-path evidence","CI evidence"]}
```

Resolve to parent verification:
```json
{"op":"resolve_checkpoint","checkpoint_id":"goal-1-checkpoint-1","decision":"parent_completion_candidate","parent_reading":"Accepted target evidence appears to satisfy the parent objective; the verifier must decide.","not_propagated":["Parent goal is complete without verifier acceptance"],"remaining_parent_work":["Call goal({op:\"complete\"}) for parent completion verification."]}
```

Attempt parent completion:
```json
{"op":"complete"}
```
</examples>
