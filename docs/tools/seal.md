# seal

> Accept an active checkpoint span and compact its active representation.

## Availability

- Built-in, discoverable tool.
- Shares the disabled-by-default `checkpoint.enabled` gate.
- Top-level sessions only.
- Requires one active checkpoint.

## Input

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `strategy` | `"summary" \| "shake"` | Yes | Semantic replacement or scoped payload elision. |
| `report` | `SealReport` | For `summary` | Structured continuation handoff. Optional for `shake`. |

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

The schema is strict. `execute()` additionally rejects `strategy: "summary"` when `report` is absent.

## Output

Lifecycle handling recognizes these stable structured details:

```ts
{
  disposition: "seal";
  strategy: "summary" | "shake";
  report?: SealReport;
}
```

The tool validates and requests closure; it does not mutate session history itself.

## Strategy choice

- `summary`: use only when the structured handoff can replace chronology without reducing continuation correctness.
- `shake`: preserve chronology while eliding eligible heavy payloads strictly after the checkpoint boundary.
- `keep_checkpoint`: use instead when exact detail remains necessary or outcomes are uncertain.

Both seal strategies accept existing world effects and preserve close-time durable state. They do not prove correctness or roll back external effects.

## Errors

- No active checkpoint.
- Summary strategy without a structured report.
- Subagent call.

A failed seal leaves the checkpoint open.

## Sources

- Tool class, schemas, and result types: `packages/coding-agent/src/tools/checkpoint.ts`
- Model prompt: `packages/coding-agent/src/prompts/tools/seal.md`
- Registration and feature gate: `packages/coding-agent/src/tools/index.ts`
