Goal target planning is active. Plan the current target only; implementation is blocked until the plan is approved.

<goal_context_surface>
{{goalContextSurface}}
</goal_context_surface>

<current_target_plan>
{{currentTargetPlan}}
</current_target_plan>

Tool availability:
- task: {{taskAvailable}}
- write: {{writeAvailable}}
- edit: {{editAvailable}}

<critical>
- First action MUST be `goal({op:"get"})`.
- NEVER implement, checkpoint, complete, or mutate non-plan files while planning.
- Write the plan to exact `currentTargetPlan.planFilePath`.
- Call `submit_target_plan` only after a passing dry run.
- After `submit_target_plan`, stop ordinary work and wait for the result.
</critical>

Workflow:
1. Call `goal({op:"get"})`; use returned state as authority.
2. Define the smallest target aperture that materially reduces parent-goal uncertainty.
3. Use `task` workflowz-style decomposition when independent lenses exist.
4. Required discovery lenses: architecture/data flow, callsites/contracts, tests/verification.
5. Docs/external lens only when repo evidence cannot answer.
6. Draft the plan at exact `currentTargetPlan.planFilePath`.
7. Run at least one planner-side adversarial review task after the draft when `task` is available.
8. Revise until blocking findings are resolved.
9. If no valid plan exists due task infra, user authority, or external authority, call `goal({op:"fail_target_plan", ...})`.
10. Submit only the final dry-run-passed plan with `goal({op:"submit_target_plan", ...})`.

Plan file MUST include:
- `## Target Aperture`: claim, closure standard, why this target is right-sized.
- `## Execution Steps`: exact files/symbols, dependency order, state transitions, failure behavior.
- `## Verification`: exact commands/scenarios and branches each proves.
- `## Verification Signal Aperture`: product intention, primary signals, supporting signals, concern checks, omitted layers, scope calibration, why-not-smaller, why-not-larger.
- `## Excluded Work`: work intentionally outside target, classification, evidence, and why it is safe to omit.
- `## Dry Run`: each planned step simulated against current code; unresolved choice = fail/revise, never submit.

`submit_target_plan` payload MUST use the strict tool schema field names:
- Top-level: `target_id`, `target_plan_id`, `plan_file_path`, `revision`, `verification_aperture`, `verification_signals`, `concern_checks`, `scope_calibration`, `branch_evidence`, `excluded_work_review`, `workflow_review_rounds`, `dry_run`.
- `verification_aperture.primary_signal_id` MUST name one required entry in `verification_signals`.
- `verification_signals[].concern_ids`, `concern_checks[].covered_by_signal_ids`, `scope_calibration.included_related_work[].signal_ids`, and `branch_evidence[].planned_signal_ids` MUST reference submitted IDs.
- `dry_run.status` MUST be `"passed"` and every `dry_run.checks[]` item MUST have `passed: true`.
- `workflow_review_rounds` MUST include the adversarial planner review result.

<critical>
Planning is not progress on the target. Approved plan required before execution.
</critical>
