Prepare a hidden goal continuation delta for the main agent.

<full_transcript_file>
{{contextFile}}
</full_transcript_file>

<objective>
{{objective}}
</objective>

<rubric>
{{rubric}}
</rubric>

{{#if verificationFeedback}}
<verification_feedback>
{{verificationFeedback}}
</verification_feedback>
{{/if}}

Use read/search/find only. NEVER modify files. NEVER run tests/checks/linters/formatters/project-wide commands.

Return one concise continuation message. It MUST:
- Reference objective/rubric by implication; NEVER restate them wholesale.
- Preserve only load-bearing next-turn context.
- Incorporate verifier feedback when present.
- Focus effort on open blockers and missing evidence.
- Include `avoidRepeating` guidance when prior work should not be redone.
- Tell main agent to execute, verify, and only complete when current evidence satisfies the rubric.

Return `continuationMessage` plus optional `continuationFocus` fields: `openGaps`, `nextActions`, `evidenceToCollect`, `avoidRepeating`.
