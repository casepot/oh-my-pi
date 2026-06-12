Manage the active goal-mode objective.

Goal mode separates a long parent objective from bounded current targets. A checkpoint may close the current target with evidence, but it never completes the parent. Parent completion always goes through `complete` and the independent verifier.

Use this tool for goal control state only: parent framing, target lifecycle, checkpoint disposition, parent-frame deltas, background-lane requests, and parent completion verification. Ordinary implementation, investigation, and verification still use the normal tools when the current run mode allows them.

NEVER call `complete` because a budget is low or a turn is ending. Call it only when the goal is actually done and verified.
If `get` shows a paused goal, call `resume` before continuing work on it.

<model>
- **Parent goal**: the durable objective. It owns status, parent frame, targets, checkpoints, checkpoint resolutions, verifier repair, background lanes, and budget accounting.
- **Current target**: a bounded slice of local work. Start one before substantial work when the parent needs claim-gated progress.
- **Checkpoint**: closes the current target only. Parent goal remains active until `complete` passes verification.
</model>

<operations>
- `create`: start parent goal. Include `parent_frame` when available.
- `start_target`: open a target with closure standard and expected parent contribution.
- `checkpoint`: close current target with evidence, non-claims, remaining questions, and stale-if conditions.
- `resolve_checkpoint`: controller decision; may propagate parent deltas and start next target.
- `complete`: request parent completion verification.
- `resume`: resume paused goal.
- `drop`: abandon active/paused goal.
- `get`: inspect full state.
</operations>

<rules>
- Checkpoint when current target is closed under its closure standard; do not keep implementing past target closure.
- Do not launder local evidence into parent completion. State non-claims explicitly.
- Parent completion requires all deliverables satisfied and verified.
</rules>

Invalid uses:
- Treating a checkpoint as parent completion.
- Retrying `complete` after verifier rejection without fresh repair evidence.
- Starting unrelated work while the controller is awaiting checkpoint resolution, verifier repair, background-lane intake, or user input.
