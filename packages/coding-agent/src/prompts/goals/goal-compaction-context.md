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
- `working-target` with `workstream_batch`: preserve batch id/statuses; do not restart, drop, or narrow encoded workstreams because transcript detail was compacted.
- `planning-target`: recover `plan_file_path` and `payload_file_path`; continue target planning only.
- `awaiting-checkpoint-resolution`: route to checkpoint guidance and `resolve_checkpoint`.
- `awaiting-parent-completion`: call `goal({op:"complete"})`; do not resume implementation.
- `awaiting-verification-repair`: require fresh repair/evidence before another `complete`.
- `awaiting-user-input`: preserve `blocked_state` and wait unless current input explicitly recovers it through `recover_blocked_state`.
- Overflow or incomplete-output recovery is not checkpoint evidence.
</goal_mode_compaction_context>
