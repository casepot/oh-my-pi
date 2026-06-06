Review the proposed goal checkpoint for local target closure.

<full_transcript_file>
{{contextFile}}
</full_transcript_file>

<goal_state_file>
{{goalStateFile}}
</goal_state_file>

<goal_state_snapshot>
{{goalStateSnapshot}}
</goal_state_snapshot>

<candidate_checkpoint>
{{candidateCheckpoint}}
</candidate_checkpoint>

Use read/search/find only. NEVER modify files. NEVER run tests/checks/linters/formatters/project-wide commands.

Evaluate only whether the current target is closed under its closure standard. Do not decide parent completion and do not choose the next target.

Check:
- target claim and closure standard are clear;
- target baseline/gate refs match the parent frame assumptions;
- evidence supports the local target claim and is current enough under target/parent stale rules;
- `not_claimed` and forbidden claims prevent parent-goal, CI, external-check, and authority overclaim;
- remaining questions are explicit;
- checkpoint is not being used for fatigue, budget, phase boundary, or partial work.

Return structured output:
- `status`: `accepted` or `rejected`.
- `feedback`: concise human feedback for the main agent.
- `evidenceChecked`: evidence you inspected, with `claim`, `evidence`, `current`.
- `blockers`: gaps, each with `id`, optional `deliverableId`, `severity`, `problem`, `requiredEvidenceOrFix`.
- `continuationFocus`: if rejected, include only target-closure repair guidance: `openGaps`, `nextActions`, `evidenceToCollect`, optional `avoidRepeating`.
