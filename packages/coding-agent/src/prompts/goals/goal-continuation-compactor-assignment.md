Prepare a hidden goal continuation delta for the main agent.

<full_transcript_file>
{{contextFile}}
</full_transcript_file>

{{#if goalStateFile}}
<goal_state_file>
{{goalStateFile}}
</goal_state_file>
{{/if}}

{{#if goalStateSnapshot}}
<goal_state_snapshot>
{{goalStateSnapshot}}
</goal_state_snapshot>
{{/if}}

<objective>
{{objective}}
</objective>


{{#if verificationFeedback}}
<verification_feedback>
{{verificationFeedback}}
</verification_feedback>
{{/if}}

Use read/search/find only. NEVER modify files. NEVER run tests/checks/linters/formatters/project-wide commands.

Return one concise continuation message. It MUST:
- Preserve parent goal, parent-state frame, current target, pending checkpoint, verification repair, non-claims, residuals, gates, stale conditions, and exact next local action when present.
- For ordinary compaction, resume the same open target; do not choose a new target merely because context was compacted.
- Preserve target aperture: project/domain target rules override generic splitting; if they define a minimum target unit, the next target must preserve that unit. Absent project-specific target rules, keep one coherent desired-future claim rather than the whole parent goal.
- If a checkpoint is pending, route the next turn to checkpoint guidance and `resolve_checkpoint`, not local work.
- If parent completion was rejected, route the next turn to verifier blockers and fresh evidence; do not allow a cosmetic `complete` retry.
- Include things not to infer from the summary, especially checkpoint non-claims and parent-frame boundaries.
- Include `avoidRepeating` guidance when prior work should not be redone.

Return `continuationMessage` plus optional `continuationFocus` fields: `openGaps`, `nextActions`, `evidenceToCollect`, `avoidRepeating`.
