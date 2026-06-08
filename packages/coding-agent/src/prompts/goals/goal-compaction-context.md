<goal_mode_compaction_context>
Transition: {{transition}}
Reason: {{reason}}

The following controller surface is authoritative for next-action routing. Full audit state remains in preserve data and `goal({op:"get"})`.

{{stateSnapshot}}
<goal_continuation_packet>
{{continuationPacket}}
</goal_continuation_packet>

Compaction policy:
- `working-target`: preserve and resume the same current target.
- `awaiting-checkpoint-resolution`: route to checkpoint guidance and `resolve_checkpoint`.
- `awaiting-parent-completion`: call `goal({op:"complete"})`; do not resume implementation.
- `awaiting-verification-repair`: require fresh repair/evidence before another `complete`.
- `awaiting-user-input`: wait for user/check/external-control input.
- Overflow or incomplete-output recovery is not checkpoint evidence.
</goal_mode_compaction_context>
