Manage the active goal-mode objective.

Goal mode has a parent goal plus, when needed, a current target. A checkpoint closes only the current target with evidence. It never completes the parent goal.

Use a single `op` field:

- `create`: start a parent goal. Requires `objective`; optional `token_budget` must be positive; optional `parent_frame` records desired future/current truth/claims/gates/boundaries/residuals/authority/external refs. Use only when no goal exists and no goal is paused.
- `get`: inspect current parent goal, parent frame, current target, target history, checkpoints, checkpoint resolutions, verifier-repair state, run mode, and remaining budget.
- `resume`: reactivate a paused parent goal without changing its run mode.
- `start_target`: start a bounded current target. Requires `title`, `desired_future_claim`, and `closure_standard`. Optional: `expected_parent_contribution`, `baseline_refs`, `gate_refs`, `evidence_expectation`, `non_goals`, `forbidden_claims`, `stale_if`, `linked_verifier_blocker_ids`.
- `checkpoint`: close the current target with evidence and prepare a controller turn. Requires `status:"closed_with_evidence"`, `summary`, `local_claims`, `evidence`, `not_claimed`, and `remaining_questions`. Optional: `checks_run`, `artifacts_touched`, `risks_or_caveats`, `stale_if`, `suggested_controller_questions`, `retrospective_target` for legacy sessions only.
- `resolve_checkpoint`: record the fresh controller decision after an accepted checkpoint. Requires `checkpoint_id`, `decision`, `parent_reading`, `not_propagated`, and `remaining_parent_work`. Optional: `parent_delta`, `broader_checks_or_inputs`, `lessons_for_future`. `next_target` is legal only when `decision:"next_target"`; omit the field for every other decision, especially `parent_completion_candidate`.
- `complete`: attempt verified parent-goal completion. This remains parent-scoped and invokes the independent verifier.
- `drop`: drop the parent goal without completing it.

Examples:

```json
{"op":"create","objective":"Improve release reliability","token_budget":50000,"parent_frame":{"kind":"claim-gated","desired_future":"Release work advances through explicit claims, evidence, non-claims, and controller-approved next targets.","current_truth":"Installer smoke coverage exists but release readiness is not established.","gates":[{"id":"install-smoke","name":"Install smoke evidence","status":"unknown","required_evidence":["install smoke output"]}],"boundaries":[{"id":"local-smoke-not-release","kind":"forbidden-inference","statement":"Local smoke success does not imply CI, tarball install, or release readiness."}]}}
```

```json
{"op":"start_target","title":"Prove stats worker starts in compiled installer smoke test","desired_future_claim":"Compiled installs exercise stats worker startup instead of silently skipping it.","expected_parent_contribution":"Closes one release-reliability evidence gap without claiming release readiness.","closure_standard":"A focused smoke command fails if the worker cannot start.","gate_refs":["install-smoke"],"evidence_expectation":["smoke command output"],"non_goals":["full release readiness"],"forbidden_claims":["CI is green","release is ready"],"stale_if":["installer script changes"]}
```

```json
{"op":"checkpoint","status":"closed_with_evidence","summary":"The compiled installer smoke path now exercises stats worker startup.","local_claims":["The smoke probe fails if stats worker startup is broken."],"evidence":[{"claim":"The smoke probe exercises stats worker startup.","evidence":"scripts/install-tests/run-ci.sh invokes omp --smoke-test after install.","current":true}],"checks_run":["focused smoke command"],"artifacts_touched":["scripts/install-tests/run-ci.sh"],"not_claimed":["Parent goal is complete","Release is ready","CI is green"],"remaining_questions":["Should the next target be CI coverage or tarball install verification?"]}
```

```json
{"op":"resolve_checkpoint","checkpoint_id":"goal-1-checkpoint-1","decision":"parent_completion_candidate","parent_reading":"The closed target plus prior accepted evidence appears to satisfy the parent objective; the independent verifier must decide.","not_propagated":["Parent goal is complete without verifier acceptance"],"remaining_parent_work":["Call goal({op:\"complete\"}) for parent completion verification."]}
```

```json
{"op":"resolve_checkpoint","checkpoint_id":"goal-1-checkpoint-1","decision":"next_target","parent_reading":"The local smoke target is closed, but parent release reliability still needs distribution-path evidence.","parent_delta":{"admitted_claims":[{"id":"compiled-installer-smoke-starts-worker","claim":"Compiled installer smoke path has local evidence for stats worker startup.","status":"accepted","evidence_refs":[{"id":"checkpoint:goal-1-checkpoint-1","kind":"artifact"}],"non_implications":["Release is ready","Tarball install path is verified"]}],"candidate_claims_added":[],"rejected_claims":[],"boundaries_added":[{"id":"source-link-not-tarball","kind":"forbidden-inference","statement":"Local source-link smoke success does not prove tarball install success."}],"residuals_added_or_updated":[{"id":"tarball-smoke-evidence","statement":"Tarball install path still needs equivalent smoke evidence.","classification":"current-parent-blocker","required_evidence":["tarball install smoke output"]}],"gate_deltas":[{"gate_id":"install-smoke","status":"passed","evidence_refs":[{"id":"checkpoint:goal-1-checkpoint-1","kind":"artifact"}]}],"frontier_deltas":[{"id":"tarball-install-smoke-frontier","statement":"Tarball install verification is the next release-reliability frontier.","evidence_required":["tarball install smoke output"]}],"stale_refs":[],"external_record_refs":[]},"next_target":{"title":"Prove tarball install exercises the same smoke path","desired_future_claim":"Tarball installs run the smoke path that catches stats worker startup failure.","closure_standard":"Tarball install test runs omp --smoke-test and fails on worker startup errors."},"not_propagated":["Local source-link smoke success does not prove tarball install success."],"remaining_parent_work":["Tarball install path evidence","CI evidence"],"broader_checks_or_inputs":["Run install test matrix when target closes."],"lessons_for_future":["Worker smoke probes should cover every install surface."]}
```

```json
{"op":"resolve_checkpoint","checkpoint_id":"goal-1-checkpoint-1","decision":"needs_broader_checks","parent_reading":"The target is locally closed but parent state needs CI evidence before further claims advance.","not_propagated":["Local evidence is not CI evidence."],"remaining_parent_work":["Run CI matrix"],"broader_checks_or_inputs":["CI matrix"]}
```

```json
{"op":"complete"}
```

Invalid uses:

- Do not call `checkpoint` for fatigue, low budget, partial work, or arbitrary phase boundaries.
- Do not treat `checkpoint` or `resolve_checkpoint` as parent completion.
- Do not call `complete` while a checkpoint is pending. First resolve the checkpoint; if the resolution selected `parent_completion_candidate`, immediately call `complete`.
- Do not mutate parent frame through prose. Use `resolve_checkpoint.parent_delta`.
- Do not include `next_target` unless `decision` is exactly `next_target`; for `parent_completion_candidate`, omit `next_target` entirely.
- Do not retry `complete` after verifier rejection until the blockers have been fixed or directly evidenced.
