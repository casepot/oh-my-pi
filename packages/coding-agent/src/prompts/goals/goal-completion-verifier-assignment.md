Verify whether the active goal is complete.

<full_transcript_file>
{{contextFile}}
</full_transcript_file>

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

Evaluate current repository/session state against every rubric deliverable ID and your own stringent objective interpretation. Return `verified` only when work is complete, coherent, maintainable, and directly evidenced. Return `rejected` for partial work, missing integrations, unverified claims, stale evidence, scope shrinkage, or taste/architecture problems that make closure irresponsible.

Evidence rules:
- Evidence MUST be current-state evidence you personally inspected in this verifier run.
- Transcript tool results MAY be evidence when they directly show current checks/results.
- Assistant claims are hints, not evidence.
- Stale rubric baseline facts MUST be re-checked before they support closure.
- Unknown evidence = not complete.

Return structured output:
- `status`: `verified` or `rejected`.
- `feedback`: concise human feedback for the main agent.
- `summary`: one-sentence judgment.
- `score`: 0..4 using the rubric score levels.
- `deliverableResults`: one item per rubric deliverable ID, with `id`, `status` (`passed`/`failed`/`unknown`), `rationale`, and optional `evidence`.
- `evidenceChecked`: current evidence you inspected, with `claim`, `evidence`, `current`.
- `completionBlockers`: blocking/important/polish gaps, each with `id`, optional `deliverableId`, `severity`, `problem`, `requiredEvidenceOrFix`.
- `continuationFocus`: if rejected, include only delta guidance: `openGaps`, `nextActions`, `evidenceToCollect`, optional `avoidRepeating`.

Feedback rules:
- Name highest-value gaps, not every tiny improvement.
- Explain what evidence would satisfy closure.
- Avoid endless churn; distinguish load-bearing gaps from optional polish.
