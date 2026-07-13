Accept a successful checkpoint span and replace its active trajectory with a structured report plus runtime manifest.

<instruction>
- Verify stable outcomes before sealing.
- Supply `outcome`, `durableContext`, `decisions`, `verification`, `remaining`, and `next`.
- Record observed evidence separately from decisions and interpretation.
- Retain unresolved work and risks in `remaining`.
- Close-time durable orchestration state survives sealing.
- Use `keep_checkpoint` when detail loss risks continuation correctness.
</instruction>

<critical>
Sealing accepts world effects; it does not prove correctness or roll anything back. No active checkpoint? Create one before calling `seal`.
</critical>
