<!-- Hidden checkpoint controller steer. role=user, suppressed from visible transcript. -->

<goal_checkpoint_controller>
Checkpoint guidance below is the handoff for a fresh controller turn.

- Parent goal remains active.
- Call `goal({op:"resolve_checkpoint", …})` before ordinary tools.
- Use `decision:"next_target"` when parent work remains and a valid target can be named.
- NEVER use `pause_for_external_control` as a generic stop after accepted checkpoint guidance.
- Use guidance to admit/narrow/reject target claims.
- Parent-frame changes require `parent_delta`.
- Start only a valid project/domain target unit.
- Do not resume implementation before checkpoint resolution.
- Do not infer parent completion from target closure.
</goal_checkpoint_controller>
