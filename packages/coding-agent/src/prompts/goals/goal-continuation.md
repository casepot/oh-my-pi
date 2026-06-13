<!-- Hidden goal continuation steer. role=user, suppressed from visible transcript. -->

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

{{#when runMode "==" "working-target"}}
Working-target action:
- Continue the current target. If none exists, start one before substantial work.
- Project/domain target rules override generic splitting; use their minimum target unit when present.
- NEVER start targets for internal process phases: planning, evidence review, closure, recomposition, reviewer passes.
- Choose the smallest independently verifiable desired-future claim that advances the parent goal.
- Checkpoint only after full target closure evidence.
{{/when}}

{{#when runMode "==" "awaiting-checkpoint-resolution"}}
Checkpoint-resolution action:
- Do not implement; inspect checkpoint guidance and call `resolve_checkpoint`.
- Prefer `decision:"next_target"` until every parent deliverable has accepted current evidence.
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

{{#when runMode "==" "awaiting-background-lane-intake"}}
Background-lane-intake action:
- Disposition blocked background lanes before ordinary implementation resumes.
{{/when}}

{{#when runMode "==" "awaiting-user-input"}}
Awaiting-input action:
- Wait for user input, broader checks, or external authority.
{{/when}}

Parent invariant:
- Target closure is not parent completion.
