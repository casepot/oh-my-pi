# Target-plan payload schema reference

Use only during `planning-target`. Write the payload JSON to `targetPlanSubmitIdentity.payloadFilePath`, then call `lint_target_plan` or `submit_target_plan` with `payload_file_path`.

## Required top-level fields

Canonical payload fields:
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

Graph-lint-required for modern plans unless low-risk light legacy lint accepts omission:
- `scenario_matrix`
- `target_card`

Primary signal field:
- `verification_aperture.primary_signal_id`

Optional top-level metadata:
- `primary_signal_group_id`
- `plan_depth`

## Nested object field names

`verification_aperture`:
- `product_intention`
- `primary_signal_id`
- `blast_radius`
- `confidence_target`
- `layer_rationale`
- `residual_uncertainty: string[]`
- `omitted_layers: { layer, reason }[]`

`verification_signals[]`:
- `id`
- `role`
- `layer`
- `concern_ids: string[]`
- `claim`
- `observation`
- `method`
- `expected_outcome`
- `required: boolean`
- `confidence_if_satisfied`
- `stale_if: string[]`

`concern_checks[]`:
- `id`
- `kind`
- `why_independent`
- `covered_by_signal_ids: string[]`

`scope_calibration`:
- `right_sizing_basis`
- `why_not_smaller: string[]`
- `why_not_larger: string[]`
- `included_related_work: { item, reason, signal_ids }[]`
- `deferred_related_work: { item, reason, follow_up_hint? }[]`
- `target_unit_rule_ids?: string[]`
- `target_unit_exemptions?: { rule_id, rationale }[]`

`branch_evidence[]`:
- `branch`
- `required: boolean`
- `planned_signal_ids: string[]`
- `rationale`

`excluded_work_review[]`:
- `item`
- `classification`
- `rationale`

`scenario_matrix`:
- `id`
- `primary_signal_group_id`
- `rows_in_scope: { id, branch, signal_ids, concern_ids, acceptance, expected_outcome, stale_if }[]`
- `rows_left_open: { id, branch, reason, follow_up_hint }[]`
- `splitting_safety: { safe, rationale }`
- `next_larger_target?: { title, primary_signal_group_id, rows, unblocks_matrix_id? }`

`target_card`:
- `capability_claim`
- `trust_privacy_claim?`
- `confidence_earned?`
- `known_limits: string[]`
- `authority_boundary?`
- `policy_deletion_implications?`
- `user_visible_surface`
- `acceptance_rows: { closed, open }`
- `workstreams?: { id, label, kind, files, contract_inputs, contract_outputs }[]`
- `shared_contract?`
- `review_lenses?: string[]`
- `verification_scenarios: string[]`
- `checkpoint_evidence: string[]`
- `rollback_cutover?`

`workflow_review_rounds[]`:
- `lens`
- `verdict`
- `summary`
- `blockers: string[]`
- `revised: boolean`

`dry_run`:
- `status`
- `checks: { id, passed, rationale }[]`

## Minimal valid payload shape

```json
{
  "target_id": "goal-1-target-1",
  "target_plan_id": "goal-1-target-1-plan-1",
  "plan_file_path": "local://goal-1-target-1-plan.md",
  "revision": 1,
  "primary_signal_group_id": "smoke-signal",
  "plan_depth": "standard",
  "scenario_matrix": {
    "id": "matrix-1",
    "primary_signal_group_id": "smoke-signal",
    "rows_in_scope": [
      {
        "id": "row-happy-path",
        "branch": "happy path",
        "signal_ids": ["signal-primary"],
        "concern_ids": ["concern-behavior"],
        "acceptance": "Happy path behavior is implemented and verified.",
        "expected_outcome": "Focused check passes.",
        "stale_if": ["The happy path contract changes."]
      }
    ],
    "rows_left_open": [],
    "splitting_safety": { "safe": true, "rationale": "No independent branch is bundled." }
  },
  "target_card": {
    "capability_claim": "Happy path behavior is directly verified.",
    "known_limits": ["Parent completion remains outside this target."],
    "user_visible_surface": "Happy path behavior",
    "acceptance_rows": { "closed": ["row-happy-path"], "open": [] },
    "workstreams": [
      {
        "id": "ws-main",
        "label": "Main implementation",
        "kind": "main",
        "files": ["src/example.ts"],
        "contract_inputs": ["Existing caller contract"],
        "contract_outputs": ["Verified happy path"]
      }
    ],
    "verification_scenarios": ["row-happy-path happy path signal-primary"],
    "checkpoint_evidence": ["Focused check output"]
  },
  "verification_aperture": {
    "product_intention": "Prove happy path behavior with direct evidence.",
    "primary_signal_id": "signal-primary",
    "blast_radius": "local",
    "confidence_target": "high",
    "layer_rationale": "Focused integration evidence covers this target.",
    "residual_uncertainty": ["Parent completion remains unclaimed."],
    "omitted_layers": [{ "layer": "e2e", "reason": "Parent-level e2e belongs to a later target." }]
  },
  "verification_signals": [
    {
      "id": "signal-primary",
      "role": "primary",
      "layer": "integration",
      "concern_ids": ["concern-behavior"],
      "claim": "Happy path behavior is verified.",
      "observation": "Focused check output is observed.",
      "method": "Run the focused check.",
      "expected_outcome": "The focused check passes.",
      "required": true,
      "confidence_if_satisfied": "high",
      "stale_if": ["Relevant code changes."]
    }
  ],
  "concern_checks": [
    {
      "id": "concern-behavior",
      "kind": "behavior",
      "why_independent": "Behavior can fail independently.",
      "covered_by_signal_ids": ["signal-primary"]
    }
  ],
  "scope_calibration": {
    "right_sizing_basis": "product-signal",
    "why_not_smaller": ["Smaller work would not produce the signal."],
    "why_not_larger": ["Larger work would claim parent completion."],
    "included_related_work": [{ "item": "Happy path implementation", "reason": "Needed for the signal.", "signal_ids": ["signal-primary"] }],
    "deferred_related_work": [{ "item": "Parent completion", "reason": "different-primary-signal", "follow_up_hint": "Checkpoint first." }]
  },
  "branch_evidence": [
    { "branch": "happy path", "required": true, "planned_signal_ids": ["signal-primary"], "rationale": "Primary signal covers it." }
  ],
  "excluded_work_review": [
    { "item": "Parent completion", "classification": "parent-non-claim", "rationale": "Out of target scope." }
  ],
  "workflow_review_rounds": [
    { "lens": "local self-check", "verdict": "accepted", "summary": "Payload and Markdown agree.", "blockers": [], "revised": false }
  ],
  "dry_run": { "status": "passed", "checks": [{ "id": "self-check", "passed": true, "rationale": "Plan is executable." }] }
}
```

## Common alias mistakes

Use canonical snake_case only:
- `targetId` -> `target_id`
- `targetPlanId` -> `target_plan_id`
- `planFilePath` -> `plan_file_path`
- `primarySignalId` -> `primary_signal_id`
- `primarySignalGroupId` -> `primary_signal_group_id`
- `verificationAperture` -> `verification_aperture`
- `verificationSignals` -> `verification_signals`
- `concernChecks` -> `concern_checks`
- `scopeCalibration` -> `scope_calibration`
- `branchEvidence` -> `branch_evidence`
- `excludedWorkReview` -> `excluded_work_review`
- `scenarioMatrix` -> `scenario_matrix`
- `targetCard` -> `target_card`
- `workflowReviewRounds` -> `workflow_review_rounds`
- `dryRun` -> `dry_run`
- `concernIds` -> `concern_ids`
- `expectedOutcome` -> `expected_outcome`
- `confidenceIfSatisfied` -> `confidence_if_satisfied`
- `staleIf` -> `stale_if`
- `coveredBySignalIds` -> `covered_by_signal_ids`
- `plannedSignalIds` -> `planned_signal_ids`
- `rowsInScope` -> `rows_in_scope`
- `rowsLeftOpen` -> `rows_left_open`
- `acceptanceRows` -> `acceptance_rows`
- `knownLimits` -> `known_limits`
- `verificationScenarios` -> `verification_scenarios`
- `checkpointEvidence` -> `checkpoint_evidence`
- `contractInputs` -> `contract_inputs`
- `contractOutputs` -> `contract_outputs`

NEVER paste this payload into `goal({op:"submit_target_plan", ...})`. Store JSON in the payload sidecar and submit only `{ "op": "submit_target_plan", "payload_file_path": "..." }`.
