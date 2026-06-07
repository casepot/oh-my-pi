<goal_mode_compaction_context>
Transition: {{transition}}
Reason: {{reason}}

The following goal-mode state is authoritative. It is not evidence that a target closed, a checkpoint resolved, or the parent goal completed unless the serialized state says so.

{{stateSnapshot}}


<goal_continuation_packet>
{{continuationPacket}}
</goal_continuation_packet>

Compaction policy:
- If runMode is `working-target`, preserve and resume the same current target. Do not choose a new target merely because compaction occurred.
- If runMode is `awaiting-checkpoint-resolution`, route the next continuation to checkpoint guidance and `resolve_checkpoint`; do not resume local implementation.
- If runMode is `awaiting-parent-completion`, preserve the parent-completion candidate state and call `goal({op:"complete"})` next; do not resume implementation first.
- If runMode is `awaiting-verification-repair`, preserve verifier blockers and require fresh repair/evidence before another `complete` attempt.
- If runMode is `awaiting-user-input`, suppress hidden auto-continuation until the operator/check/external-control decision resumes the goal.
- Overflow or incomplete-output recovery is not a checkpoint and must not create or resolve a checkpoint by implication.
</goal_mode_compaction_context>
