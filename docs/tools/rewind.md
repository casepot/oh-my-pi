# rewind

> Abandon an active checkpoint trajectory while retaining a factual report.

## Availability

- Built-in, discoverable tool.
- Shares the disabled-by-default `checkpoint.enabled` gate.
- Top-level sessions only.
- Requires one active checkpoint.

## Input

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `report` | `string` | Yes | Concise factual findings, decisions, surviving effects, and unresolved risks. |

`rewind({ report })` remains wire compatible. The report is trimmed and must be nonempty.

## Output

```ts
{
  report: string;
  rewound: true;
}
```

The immediate tool result requests rewind. Existing session lifecycle handling performs the branch/context rewrite and retains legacy `rewind-report` persistence compatibility.

## Semantics

- Active context returns to the successful checkpoint boundary.
- The retained report replaces the abandoned span for continuation.
- Detailed descendants remain in persisted session history.
- Durable orchestration state returns to checkpoint state.
- Filesystem, process, browser, network, and other world effects survive.

Use `seal` instead when accepting successful work. Use `keep_checkpoint` when detailed chronology must remain active.

## Errors

- No active checkpoint: create a checkpoint before rewinding.
- Empty report: provide factual retained context.
- Completed rewind: continue from the retained report rather than retrying.
- Subagent call: checkpoint lifecycle tools are unavailable.

## Sources

- Tool class and schema: `packages/coding-agent/src/tools/checkpoint.ts`
- Model prompt: `packages/coding-agent/src/prompts/tools/rewind.md`
- Registration and feature gate: `packages/coding-agent/src/tools/index.ts`
