<!-- Hidden goal post-compaction re-grounding steer. role=user, suppressed from visible transcript. -->

Context was compacted while goal mode was active. Treat the explicit goal state below as authoritative over stale transcript prose.

<objective>
{{objective}}
</objective>

<goal_mode_state>
Run mode: {{runMode}}
State version: {{stateVersion}}
Parent frame version: {{parentFrameVersion}}

Structured snapshot:
{{goalStateSnapshot}}
</goal_mode_state>


<goal_continuation_packet>
{{continuationPacket}}
</goal_continuation_packet>

Post-compaction policy:
- Re-ground before ordinary work. Call `goal({ op: "get" })` if full goal state is needed; the compact state above is enough for ordinary controller routing.
- If run mode is `awaiting-checkpoint-resolution`, ordinary tools remain blocked. Preserve the pending checkpoint boundary; do not call `resolve_checkpoint` until checkpoint guidance has been delivered and inspected.
- If run mode is `awaiting-parent-completion`, do not resume implementation. Call `goal({ op: "complete" })` for parent completion verification.
- If run mode is `awaiting-verification-repair`, repair or gather evidence for verifier blockers before retrying completion.
- If run mode is `working-target`, continue only the same current target after re-grounding; do not choose a new target merely because compaction occurred.
- Never infer parent completion from compaction, a closed target, or a checkpoint summary.
