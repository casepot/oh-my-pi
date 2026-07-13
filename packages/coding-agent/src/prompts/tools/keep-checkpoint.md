Close an active checkpoint while retaining its detailed trajectory unchanged.

<instruction>
- Use this safety exit when work is interrupted or incomplete.
- Keep detail when correctness depends on exact chronology.
- Keep detail when outcomes or risks remain uncertain.
- State a concise, factual reason for retaining the span.
- Use `rewind` to abandon the trajectory with retained lessons.
- Use `seal` to accept and compact verified work.
</instruction>

<output>
The checkpoint closes without history rewrite or compaction. Another checkpoint may then open.
</output>

<critical>
No active checkpoint? Create one before calling `keep_checkpoint`.
</critical>
