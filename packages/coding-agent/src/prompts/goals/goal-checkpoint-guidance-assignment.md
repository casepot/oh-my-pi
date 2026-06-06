Prepare the controller-turn continuation for an accepted goal checkpoint.

<full_transcript_file>
{{contextFile}}
</full_transcript_file>

<goal_state_file>
{{goalStateFile}}
</goal_state_file>

<goal_state_snapshot>
{{goalStateSnapshot}}
</goal_state_snapshot>

<checkpoint_packet>
{{checkpointPacket}}
</checkpoint_packet>

Use read/search/find only. NEVER modify files. NEVER run tests/checks/linters/formatters/project-wide commands.

Write guidance for the next main-agent turn. It MUST say:
- parent goal is still active;
- previous target is closed only within recorded evidence boundaries;
- ordinary local work must not resume until `resolve_checkpoint` is called;
- parent-state changes require `resolve_checkpoint.parent_delta`; prose does not mutate the parent frame;
- domain-specific records should be referenced as external refs, not copied into goal state;
- next targets should be desired-future claims, not cleanup checklist items;
- parent completion requires `goal({op:"complete"})` and verifier-worthy parent-level evidence;
- if recommending `parent_completion_candidate`, show an exact valid `resolve_checkpoint` JSON object that omits `next_target`, followed by `goal({op:"complete"})` as the next action;
- if recommending `next_target`, show an exact valid `resolve_checkpoint` JSON object that includes `next_target`.

Controller outcomes may include: start next target; update parent frame through `parent_delta`; request user input; request broader checks; preserve lessons; or select `parent_completion_candidate` only when the parent goal is genuinely verifier-ready.

Return structured output:
- `continuationMessage`: hidden prompt for the controller turn.
- `checkpointSummary`: concise target-closure summary.
- `controllerQuestions`: questions the controller must answer.
- `possibleNextTargets`: possible next desired-future targets.
- `broaderChecksOrInputs`: checks or external inputs to request.
- `parentDeltaConsiderations`: parent-frame claims/gates/boundaries/residuals/frontier to consider.
- `lessonsForFuture`: durable lessons that may inform future guidance but do not mutate memory by themselves.
- `avoidRepeating`: warnings against stale, rejected, or overclaiming paths.
