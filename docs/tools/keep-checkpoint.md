# keep_checkpoint

> Close an active checkpoint while retaining its detailed trajectory unchanged.

## Availability

- Built-in, discoverable tool.
- Shares the disabled-by-default `checkpoint.enabled` gate.
- Top-level sessions only.
- Requires one active checkpoint.

## Input

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `reason` | `string` | Yes | Why detailed chronology must remain available. |

The reason is trimmed and must be nonempty.

## Output

Lifecycle handling recognizes these stable structured details:

```ts
{
  disposition: "keep";
  reason: string;
}
```

The tool validates and requests closure; it does not mutate session history itself.

## Semantics

Use this safety exit when work is interrupted, incomplete, uncertain, or dependent on exact detail. The close disposition:

- retains the active branch and messages;
- preserves close-time state;
- performs no compaction or provider-context rebuild;
- permits a later checkpoint after lifecycle handling records closure.

Use `rewind` to abandon the trajectory with retained lessons. Use `seal` to accept and compact verified work.

## Errors

- No active checkpoint.
- Empty reason.
- Subagent call.

A failed keep request leaves the checkpoint open.

## Sources

- Tool class, schema, and result type: `packages/coding-agent/src/tools/checkpoint.ts`
- Model prompt: `packages/coding-agent/src/prompts/tools/keep-checkpoint.md`
- Registration and feature gate: `packages/coding-agent/src/tools/index.ts`
