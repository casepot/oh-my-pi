Abandon an active checkpoint trajectory while retaining a factual report.

Use `rewind` when the trajectory should leave active context but its lessons must survive.

<instruction>
- Keep `report` concise, factual, and actionable.
- Include findings, decisions, surviving effects, and unresolved risks.
- AVOID raw scratch logs unless continuation requires them.
- Filesystem, process, browser, and network effects are NOT rolled back.
- Use `seal` instead when accepting successful work.
- Use `keep_checkpoint` when detailed chronology must remain active.
</instruction>

<output>
Success replaces the checkpoint span in active context with the retained report and closes the checkpoint. Legacy `rewind({report})` behavior is preserved.
</output>

<critical>
No active checkpoint? Continue normally or create one; NEVER retry a completed rewind.
</critical>
