<!-- Hidden goal continuation steer. role=user, suppressed from visible transcript. -->

Continue according to the active goal run mode.

<objective>
{{objective}}
</objective>

{{#if rubric}}
<completion_rubric>
{{rubric}}
</completion_rubric>
The rubric is a verification aid; the objective remains the parent goal source of truth.
{{/if}}

<goal_mode_state>
Run mode: {{runMode}}
State version: {{stateVersion}}
Parent frame version: {{parentFrameVersion}}

Structured snapshot:
{{goalStateSnapshot}}
</goal_mode_state>

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

- `working-target`: continue local work on the current target. If no target exists, call `goal({op:"start_target", …})` before substantial implementation. If the target is stable under its closure standard, call `goal({op:"checkpoint", …})` with evidence and stop ordinary local work. Do not choose a new target merely because context was compacted.
- `awaiting-checkpoint-resolution`: do not continue implementation. Act as a fresh controller turn. Read checkpoint guidance and call `goal({op:"resolve_checkpoint", …})` before any local work resumes. Parent-state changes must be recorded in `resolve_checkpoint.parent_delta`; narrative guidance is not accepted parent truth. For `parent_completion_candidate`, omit `next_target`; for `next_target`, include `next_target`.
- `awaiting-parent-completion`: checkpoint resolution selected `parent_completion_candidate`. Do not continue implementation, start a target, or checkpoint. Call `goal({op:"complete"})` now; if the verifier rejects, goal mode will enter verifier repair.
- `awaiting-verification-repair`: the parent completion verifier rejected the claim. Repair or gather current evidence for the listed blockers. If no current target is explicitly linked to those blockers, call `goal({op:"start_target", …})` with current `linked_verifier_blocker_ids` for a focused repair/evidence target. Do not retry `complete` until the blockers have fresh repair/evidence. Do not choose unrelated work.
- `awaiting-user-input`: do not auto-continue ordinary work. Wait for user input, broader checks, or external authority, then resolve or resume through the goal tool.

If `pendingCheckpointId` exists, ordinary implementation remains blocked until `resolve_checkpoint` records the controller decision. A checkpoint is not parent completion and cannot mutate the parent frame through prose.

Before calling `goal({op:"complete"})`, perform a parent-completion audit against current repo state:

1. Restate the parent objective as concrete deliverables.
2. Map each deliverable to authoritative current evidence.
3. Inspect the actual current state. Read files and run the relevant checks; do not rely on memory.
4. Match verification scope to claim scope.
5. Treat uncertainty as not-yet-achieved.
6. Do not retry completion after verifier rejection without fresh repair/evidence.

Call `goal({op:"complete"})` only when every parent deliverable has direct, current-state evidence. If the work is not done, execute the next valid run-mode action.
