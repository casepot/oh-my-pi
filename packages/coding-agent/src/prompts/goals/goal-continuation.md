Continue according to the active goal controller surface.

<objective>
{{objective}}
</objective>

<controller_surface>
{{goalContextSurface}}
</controller_surface>

{{#if lastVerificationFeedback}}
Previous parent-completion verification rejected attempt {{failedCompletionAttempts}}. Address this feedback before trying parent completion again:
<verifier_feedback>
{{lastVerificationFeedback}}
</verifier_feedback>
{{/if}}

Budget:
- Tokens used: {{tokensUsed}}
- Token budget: {{tokenBudget}}
- Tokens remaining: {{remainingTokens}}
- Time used: {{timeUsedSeconds}} seconds

Run-mode policy:
- Follow `policy.now`; avoid every `policy.blocked` item.
- Need full audit state? Call `goal({op:"get"})`.
- `resolve_checkpoint` and `recover_blocked_state` must include fresh `state_version` and `parent_frame_version` from `goal({op:"get"})`.

{{#when runMode "==" "working-target"}}
Working-target action:
- Continue the current target.
- No target? Apply active goal target-acquisition guidance before `start_target`.
- Project/domain target rules override generic splitting; use their minimum target unit when present.
- NEVER start targets for internal process phases: planning, evidence review, closure, recomposition, reviewer passes.
- Same primary signal stays together; split independent signals, authority boundaries, blast radii, or unrelated deliverables.
- Checkpoint only after full target closure evidence.
- Code/behavior changed? Green verification → code-review → fixes → commit/checkpoint.
{{/when}}

{{#when runMode "==" "planning-target"}}
Target-planning action:
- First call `goal({op:"get"})`.
- Produce a decision-complete execution spec for the current product-meaningful target.
- Use `write` for missing plan/payload; edit/eval/bash-transform only `currentTargetPlan.planFilePath` and `targetPlanSubmitIdentity.payloadFilePath`; do not implement.
- Submit only after read-only planner simulation and review pass; use `payload_file_path`.
- `fail_target_plan.reason` accepts only `needs-user-input`, `task-unavailable`, `external-authority`, or `unable-to-find-right-sized-target`; never pass recovery reasons (`user-input`, `broader-checks`, `state-refresh`).
{{/when}}

{{#when runMode "==" "awaiting-checkpoint-resolution"}}
Checkpoint-resolution action:
- Do not implement; inspect checkpoint guidance and call `resolve_checkpoint`.
- Prefer `decision:"next_target"` until every parent deliverable has accepted current evidence.
- `next_target` requires target acquisition; never install the first plausible gap.
- Do not select `pause_for_external_control` unless explicit user/operator/external authority is required; use `needs_user_input`, `needs_broader_checks`, or `drop_or_replace_recommended` when no valid `next_target` or `parent_completion_candidate` exists.
- Parent truth changes only through `resolve_checkpoint.parent_delta`, never prose.
{{/when}}

{{#when runMode "==" "awaiting-parent-completion"}}
Parent-completion action:
- Call `goal({op:"complete"})`; do not resume implementation.
- Before `complete`, audit every parent deliverable against direct current-state evidence.
{{/when}}

{{#when runMode "==" "awaiting-verification-repair"}}
Verifier-repair action:
- Repair blockers or start a blocker-linked target.
- Do not retry `complete` without fresh evidence.
{{/when}}
{{#when runMode "==" "awaiting-user-input"}}
Awaiting-input action:
- Wait when no new user/broader-check/external input is present.
- If current input resolves `blocked_state.requiredOperation == "recover_blocked_state"`, call `goal({op:"recover_blocked_state", …})` using `blocked_state.id`, `blocked_state.source`, and one listed `blocked_state.allowedActions` item.
- Include fresh `state_version` and `parent_frame_version` from `goal({op:"get"})`; stale target-plan recovery must use the current blocked-state identity and current versions.
- `recover_blocked_state.reason` accepts only `user-input`, `broader-checks`, `external-authority`, or `state-refresh`; never pass failure reasons such as `needs-user-input`.
- Put the concrete user/external decision in `guidance`; use `reason:"user-input"` for direct user answers.
- NEVER call `resume` or direct `start_target` while `blocked_state` is open.
{{/when}}

Parent invariant:
- Target closure is not parent completion.
