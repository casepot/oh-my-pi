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

Evaluate whether the current target is a valid target unit and is closed under its closure standard. Do not decide parent completion and do not choose the next target.

Check:
- target claim and closure standard are clear;
- target respects project/domain target-unit rules when they exist;
- checkpoint is not closing an internal process phase: planning, implementation, evidence review, record writing, closure, recomposition, or reviewer pass;
- target baseline/gate refs match the parent frame assumptions;
- evidence supports the local target claim and is current enough under target/parent stale rules;
- `not_claimed` and forbidden claims prevent parent-goal, CI, external-check, and authority overclaim;
- remaining questions are explicit;
- checkpoint is not being used for fatigue, budget, arbitrary phase boundary, or partial work.
- if target has accepted `verificationSignals`, every required signal has current evidence;
- reject aperture abuse: essential same-signal work hidden in `not_claimed` or deferred work;
- if `currentWorkstreamBatch` exists, reject partial fanout closure: non-doc workstreams must be completed/accepted or clearly replaced by equivalent serial evidence; failed/aborted/blocked workstreams need repaired evidence before acceptance;
- if `verificationFreshness` marks a check stale/unknown/failed, NEVER count that check as current evidence unless newer equivalent evidence is supplied;

Return structured output:
- `status`: `accepted` or `rejected`.
- `feedback`: concise human feedback for the main agent.
- `evidenceChecked`: evidence you inspected, with `claim`, `evidence`, `current`.
- `blockers`: gaps, each with `id`, optional `deliverableId`, `severity`, `problem`, `requiredEvidenceOrFix`.
- `continuationFocus`: if rejected, include only target-closure repair guidance: `openGaps`, `nextActions`, `evidenceToCollect`, optional `avoidRepeating`.
