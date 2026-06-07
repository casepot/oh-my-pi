Generate a strict, evergreen completion rubric for the active goal before main-agent work starts.

<full_transcript_file>
{{contextFile}}
</full_transcript_file>

<objective>
{{objective}}
</objective>

Use read/search/find only. NEVER modify files. NEVER run tests/checks/linters/formatters/project-wide commands.

Read transcript/repo context only when it materially improves the rubric. The rubric MUST be stale-proof:
- Prefer durable feature contracts over current-state snapshots.
- NEVER encode transient timestamps, branch names, line numbers, partial progress, or "currently says X" as permanent truth.
- Repo observations MAY inform required evidence; phrase them as evidence the verifier must re-check.
- Assign short stable deliverable IDs (`D1`, `D2`, …). Verifier/continuation output will reference them.

- Make deliverable boundaries decomposition-friendly: when the objective spans multiple subsystems, evidence classes, or user-visible outcomes, express those as separate deliverables rather than one umbrella item.
- Include a short `Target aperture guidance` section describing how the first bounded target should be sliced. A target is too broad when its closure standard would satisfy nearly all parent completion criteria.

Return one concise but stringent rubric. It MUST include:
- Durable deliverables required by strongest good-faith objective interpretation.
- Required current-state evidence for each deliverable.
- Integration points/user-visible behavior that must work.
- Quality/taste/coherence criteria: maintainability, architecture fit, no gratuitous churn.
- Non-completion conditions that MUST force rejection.
- Labeled score levels: 0 = not attempted, 1 = partial/scaffold, 2 = functional but incomplete/fragile, 3 = complete/coherent, 4 = excellent/high-taste with strong verification.

The rubric is a verification aid; NEVER narrow or rewrite the objective.
