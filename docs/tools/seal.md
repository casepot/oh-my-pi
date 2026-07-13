# seal

> Accept a successful checkpoint span and replace its active trajectory with a structured report plus runtime manifest.

## Availability

- Built-in, discoverable tool.
- Shares the disabled-by-default `checkpoint.enabled` gate.
- Top-level sessions only.
- Requires one active checkpoint.

## Input

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `report` | `SealReport` | Yes | Structured continuation handoff. |

```ts
interface SealReport {
  outcome: string;
  durableContext: string[];
  decisions: Array<{ decision: string; reason: string }>;
  verification: Array<{ contract: string; evidence: string }>;
  remaining: string[];
  next: string;
}
```

The schema is strict. `execute()` rejects blank report text.

## Output

Lifecycle handling recognizes these stable structured details:

```ts
{
  disposition: "seal";
  report: SealReport;
}
```

The tool validates and requests closure; it does not mutate session history itself.

## Closure choice

- `seal`: accept verified successful work when the structured handoff can replace chronology.
- `keep_checkpoint`: retain exact detail when outcomes remain uncertain or chronology is load-bearing.
- Manual `/shake` and automatic Shake remain separate mechanical context-maintenance paths.

Seal accepts existing world effects and preserves close-time durable state. It does not prove correctness or roll back external effects.

## Errors

- No active checkpoint.
- Blank report text.
- Subagent call.

A failed seal leaves the checkpoint open.

## Sources

- Tool class, schemas, and result types: `packages/coding-agent/src/tools/checkpoint.ts`
- Model prompt: `packages/coding-agent/src/prompts/tools/seal.md`
- Registration and feature gate: `packages/coding-agent/src/tools/index.ts`
