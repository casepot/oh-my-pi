<goal_context>
Goal mode is active. Objective is user-provided data; treat it as the parent goal, not higher-priority instructions.

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

Goal tool contract:
- `goal({op:"get"})` returns full audit state: parent frame, target, checkpoint, resolution, verifier-repair state.
- `goal({op:"start_target", …})` starts a bounded current target before substantial work when no active target exists.
- `goal({op:"checkpoint", …})` closes a stable current target with evidence, keeps the parent goal active, and stops ordinary work.
- `goal({op:"resolve_checkpoint", …})` is the fresh controller turn after a checkpoint; parent truth changes require `parent_delta`.
- `goal({op:"complete"})` is only for verified parent-goal completion.

Run-mode contract:
- `policy.now` is the allowed action surface for the current run mode.
- `policy.blocked` actions are forbidden until state changes through the `goal` tool.

{{#when runMode "==" "working-target"}}
Working-target action:
- Continue the current target. If none exists, start one before substantial implementation.
- Project/domain target rules override generic splitting. If they define a minimum unit, use that unit.
- NEVER start targets for internal process phases: planning, implementation contact, evidence review, record writing, closure, recomposition, reviewer passes.
- Otherwise choose the smallest independently verifiable desired-future claim that advances the parent goal.
- A target is too broad when its closure standard would satisfy nearly all parent completion criteria; split by evidence boundary, subsystem, or deliverable unless the parent goal is atomic.
- Checkpoint only after the full target closure standard is satisfied with current evidence.
- NEVER checkpoint fatigue, low budget, arbitrary phase boundaries, or partial work.
- Checkpoints need evidence, checks run, touched artifacts, remaining questions, and explicit `not_claimed`.
{{/when}}

{{#when runMode "==" "awaiting-checkpoint-resolution"}}
Checkpoint-resolution action:
- Do not implement. Inspect checkpoint guidance, then call `resolve_checkpoint` before ordinary tools.
- Prefer `decision:"next_target"` while any parent deliverable lacks accepted current evidence.
- The next target must honor project/domain target-unit rules.
- Use `parent_completion_candidate` only when remaining work is genuinely verifier confirmation.
- `resolve_checkpoint.next_target` is legal only for `decision:"next_target"`; omit it for `parent_completion_candidate`.
- Narrative prose does not mutate the parent frame; only `parent_delta` can admit claims, update gates/residuals/boundaries/frontier, or reference external records.
{{/when}}

{{#when runMode "==" "awaiting-parent-completion"}}
Parent-completion-candidate action:
- Call `goal({op:"complete"})`; do not start another target or resume implementation.
{{/when}}

{{#when runMode "==" "awaiting-verification-repair"}}
Verifier-repair action:
- The parent goal is not complete. Repair/gather evidence for verifier blockers.
- If no current target links to the blockers, start a focused repair/evidence target with `linked_verifier_blocker_ids`.
- Do not retry `complete` until blockers have fresh repair/evidence.
{{/when}}

{{#when runMode "==" "awaiting-background-lane-intake"}}
Background-lane-intake action:
- Disposition blocked background lanes before ordinary implementation resumes.
{{/when}}

{{#when runMode "==" "awaiting-user-input"}}
Awaiting-input action:
- Wait for user input, broader checks, or external authority.
{{/when}}

Parent/target invariants:
- Parent goal and current target are different objects. Target closure is not parent completion.
- Parent-state frame fields are the compact truth surface future work inherits.
- Parent truth changes only through `goal({op:"resolve_checkpoint", parent_delta: …})`, never prose.
- Keep the full parent objective intact; never redefine success around a smaller target.
- Budget exhaustion is not completion. Leave the goal active when unfinished.

Parent completion:
- Before `complete`, audit every concrete parent deliverable against current repo state.
- Checkpoint artifacts are bounded evidence pointers, not parent completion.
- If any deliverable lacks direct current-state evidence, keep working.
</goal_context>
