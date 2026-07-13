Accept an active checkpoint span and compact its active representation.

<instruction>
- Verify stable outcomes before sealing.
- Choose `summary` only when the report can replace chronology.
- Choose `shake` when chronology matters but heavy payloads do not.
- `summary` requires `outcome`, `durableContext`, `decisions`, `verification`, `remaining`, and `next`.
- Record observed evidence separately from decisions and interpretation.
- Retain unresolved work and risks in `remaining`.
- Close-time durable orchestration state survives sealing.
- Use `keep_checkpoint` when detail loss risks continuation correctness.
</instruction>

<critical>
Sealing accepts world effects; it does not prove correctness or roll anything back. No active checkpoint? Create one before calling `seal`.
</critical>
