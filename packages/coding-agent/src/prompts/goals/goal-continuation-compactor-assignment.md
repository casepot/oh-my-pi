Prepare a hidden goal continuation message for the main agent.

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

Use the transcript and current repository state available through read/search/find only. NEVER modify files. NEVER run tests, checks, linters, formatters, or project-wide commands.

Return one concise continuation message. It MUST:
- Preserve the full objective and rubric.
- Capture only load-bearing context the next turn needs.
- Incorporate verifier feedback when present.
- Direct effort toward the work/evidence that most increases goal completion confidence.
- Avoid becoming a raw fix list, status recap, or invitation to churn.
- Tell the main agent to execute, verify, and only attempt completion when the stringent rubric is directly satisfied.
