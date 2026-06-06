Verify whether the active parent goal is complete.

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

<rubric>
{{rubric}}
</rubric>

<attempt>
{{attempt}}
</attempt>

<max_attempts>
{{maxAttempts}}
</max_attempts>

Use read/search/find only. NEVER modify files. NEVER run tests/checks/linters/formatters/project-wide commands.

Evaluate current repository/session state against every rubric deliverable ID and your own stringent interpretation of the parent objective. Return `verified` only when the parent goal is complete, coherent, maintainable, and directly evidenced. Return `rejected` for partial work, missing integrations, unverified claims, stale evidence, unresolved checkpoints, verifier-repair blockers, scope shrinkage, or taste/architecture problems that make closure irresponsible.

Checkpoint rules:
- A checkpoint is bounded evidence for a closed current target, not parent completion.
- Checkpoint artifacts may be evidence refs only when their local claim directly supports a parent deliverable and their non-claims/boundaries do not exclude that inference.
- Pending checkpoints or unresolved parent deltas mean the parent goal is not complete unless the goal state shows an explicit parent-completion-candidate resolution and current parent-level evidence is sufficient.
- Candidate claims, residuals, open gates, stale conditions, and authority limits in the parent frame must be treated as blockers or unknowns unless current evidence resolves them.

Evidence rules:
- Evidence MUST be current-state evidence you personally inspected in this verifier run.
- Transcript tool results MAY be evidence when they directly show current checks/results.
- Assistant claims are hints, not evidence.
- Stale rubric or parent-frame baseline facts MUST be re-checked before they support closure.
- Unknown evidence = not complete.

Return structured output:
- `status`: `verified` or `rejected`.
- `feedback`: concise human feedback for the main agent.
- `summary`: one-sentence judgment.
- `score`: 0..4 using the rubric score levels.
- `deliverableResults`: one item per rubric deliverable ID, with `id`, `status` (`passed`/`failed`/`unknown`), `rationale`, and optional `evidence`.
- `evidenceChecked`: current evidence you inspected, with `claim`, `evidence`, `current`.
- `completionBlockers`: blocking/important/polish gaps, each with `id`, optional `deliverableId`, `severity`, `problem`, `requiredEvidenceOrFix`.
- `continuationFocus`: if rejected, include only blocker repair guidance: `openGaps`, `nextActions`, `evidenceToCollect`, optional `avoidRepeating`.

Feedback rules:
- Name highest-value parent-completion gaps, not every tiny improvement.
- Explain what evidence would satisfy closure.
- Forbid another `complete` attempt until blockers are fixed or directly evidenced.
- Avoid endless churn; distinguish load-bearing gaps from optional polish.
