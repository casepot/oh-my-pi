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

Use read/search/find only. NEVER modify files. NEVER run tests, checks, linters, formatters, or project-wide commands.

Evaluate the current repository/session state against every rubric item and against your own stringent interpretation of the objective. Return `verified` only when the work is complete, coherent, maintainable, and directly evidenced. Return `rejected` for partial work, missing integrations, unverified claims, weak tests, stale evidence, scope shrinkage, or taste/architecture problems that would make closure irresponsible.

Your feedback must be useful to the main agent:
- Name the highest-value gaps, not every tiny possible improvement.
- Explain what evidence would satisfy closure.
- Avoid endless churn; distinguish load-bearing gaps from optional polish.
- If rejected, provide a continuation message that sharpens the next work turn toward real value, not a mechanical fix list.
