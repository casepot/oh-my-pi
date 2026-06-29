Context was compacted while goal mode was active. Treat the controller surface below as authoritative over stale transcript prose.

<objective>
{{objective}}
</objective>

<controller_surface>
{{goalContextSurface}}
</controller_surface>

<goal_continuation_packet>
{{continuationPacket}}
</goal_continuation_packet>

Post-compaction policy:
- Re-ground before ordinary work; call `goal({op:"get"})` for full audit state.
- Follow `policy.now`; every `policy.blocked` action remains blocked.
- Parent truth changes only through `resolve_checkpoint.parent_delta`, never compacted prose.
- Never infer parent completion from compaction, a closed target, or checkpoint summary.

{{#when runMode "==" "working-target"}}
- Continue the same current target; do not choose a new target because compaction occurred.
- If `workstream_batch` is present in the controller surface, preserve its batch id/statuses; continue integrating those workstreams, not a narrowed subset.
- Code/behavior changed? Reconfirm green verification, run code review, then commit/checkpoint.
{{/when}}
{{#when runMode "==" "planning-target"}}
- Call `goal({op:"get"})`; recover `currentTargetPlan.planFilePath` and `targetPlanSubmitIdentity.payloadFilePath`; continue from existing files, edit in place, create only missing files, and update Markdown only for executor-visible semantic changes.
{{/when}}
{{#when runMode "==" "awaiting-checkpoint-resolution"}}
- Wait for checkpoint guidance, then call `resolve_checkpoint` before ordinary tools.
{{/when}}
{{#when runMode "==" "awaiting-parent-completion"}}
- Call `goal({op:"complete"})`; do not resume implementation first.
{{/when}}
{{#when runMode "==" "awaiting-verification-repair"}}
- Repair blockers or gather fresh evidence before retrying completion.
{{/when}}
