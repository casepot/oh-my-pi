# checkpoint

> Open a neutral, bounded top-level context span for explicit closure by `rewind`, `seal`, or `keep_checkpoint`.

## Availability

- Built-in, discoverable tool.
- Enabled only when `checkpoint.enabled=true` (default: `false`).
- Top-level sessions only; subagents do not receive any checkpoint lifecycle tool.
- Exactly one checkpoint may be active.

## Input

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `goal` | `string` | Yes | Concrete goal for the bounded span. |

`checkpoint({ goal })` remains wire compatible with the original checkpoint/rewind workflow.

## Output

The result text confirms the checkpoint and names all closure choices. Structured details remain:

```ts
{
  goal: string;
  startedAt: string; // ISO timestamp
}
```

The tool itself does not mutate history. Session lifecycle handling records the successful result as the active boundary.

## Lifecycle

```text
closed --checkpoint------> open
open   --rewind----------> closed (abandon trajectory; retain report)
open   --seal------------> closed (accept work; report + manifest)
open   --keep_checkpoint> closed (retain full trajectory)
```

Choose exactly one close disposition before ordinary terminal yield:

- `rewind`: the trajectory should leave active context, but factual lessons must survive.
- `seal`: resulting work is accepted and can be compacted safely.
- `keep_checkpoint`: detailed chronology must remain available.

Checkpoint operations affect conversation representation and durable orchestration state. They do not roll back filesystem, process, browser, network, or other world effects.

## Errors

- Subagent call: checkpoint lifecycle tools are unavailable.
- Existing active checkpoint: nesting is rejected.

A failed close operation leaves the checkpoint open.

## Sources

- Tool classes and schemas: `packages/coding-agent/src/tools/checkpoint.ts`
- Model prompt: `packages/coding-agent/src/prompts/tools/checkpoint.md`
- Registration and feature gate: `packages/coding-agent/src/tools/index.ts`
- Setting: `packages/coding-agent/src/config/settings-schema.ts`
