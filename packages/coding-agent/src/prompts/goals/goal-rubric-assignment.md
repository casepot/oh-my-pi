Generate a strict completion rubric for the active goal before the main agent starts work.

<full_transcript_file>
{{contextFile}}
</full_transcript_file>

<objective>
{{objective}}
</objective>

Read the transcript file and inspect repository context only when it materially improves the rubric. Use read/search/find only. NEVER modify files. NEVER run tests, checks, linters, formatters, or project-wide commands.

Return one concise but stringent rubric. It MUST include:
- Concrete deliverables required by the strongest good-faith interpretation of the objective.
- Evidence required for each deliverable: files, commands, behavior, integration points, or user-visible outcomes.
- Quality/taste/coherence criteria, including maintainability and architectural fit.
- Non-completion conditions that must force rejection.
- Labeled score levels, at least: 0 = not attempted, 1 = partial/scaffold, 2 = functional but incomplete/fragile, 3 = complete and coherent, 4 = excellent/high-taste with strong verification.

The rubric is a verification aid; do not narrow or rewrite the objective.
