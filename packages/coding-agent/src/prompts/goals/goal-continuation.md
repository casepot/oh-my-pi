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

This is an autonomous continuation. The objective persists across turns; NEVER redefine success around a smaller, easier, or already-completed subset.

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
- `next_target` is required only when decision is `next_target`.
- Parent completion is only a candidate until verification passes.
{{/when}}

1. **Restate the objective as concrete deliverables.** What files, behaviors, tests, gates, or artifacts must exist for the objective to be true? Write them down (todo, or in your reasoning).
2. **Map each deliverable to evidence.** For every requirement, identify the authoritative source that would prove it: a file's contents, a command's output, a test's pass status, a PR/issue state.
3. **Inspect the actual current state.** Read the files. Run the commands. Check the tests. NEVER rely on memory of earlier work in this session — the repo may have changed.
4. **Close gaps directly.** If a deliverable lacks evidence, keep working until it has evidence or a real blocker is recorded.
5. **Only call complete when every deliverable is satisfied and verified.** A passing build alone is not completion if requirements remain unproven.
6. **Budget exhaustion is not completion.** NEVER call complete merely because tokens are nearly out. If the budget is tight and the work is unfinished, leave the goal active and stop the turn — the user or runtime decides next steps.

{{#when runMode "==" "awaiting-parent-completion"}}
Parent-completion action:
- Call `goal({op:"complete"})`; do not resume implementation.
- Before `complete`, audit every parent deliverable against direct current-state evidence.
{{/when}}

{{#when runMode "==" "awaiting-verification-repair"}}
Verifier-repair action:
- Repair blockers or start a blocker-linked target.
- Do not call `complete` again until blockers are addressed with fresh evidence.
{{/when}}

If the work is not done, just keep working. NEVER narrate that you are continuing — execute.

Closure discipline:
- Checkpoints close targets, not the parent goal.
- Parent completion requires `complete` and verifier acceptance.
- Target closure is not parent completion.
