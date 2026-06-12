Run code in a persistent kernel using a list of cells.

<instruction>
Cells run in array order. State persists per language — across cells and tool calls{{#if spawns}}, and across `task` subagents: variables either side defines are visible to the other. Stage helpers, datasets, or live clients once; subagents use them directly — no re-importing or serializing across the boundary{{/if}}.

Cell fields:

- `language` — {{#if py}}`"py"` for the IPython kernel{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}`"js"` for the persistent JavaScript VM{{/if}}.
- `code` — cell body, verbatim. Newlines and quotes JSON-encoded; no fences, no headers.
- `title` (optional) — short transcript label (e.g. `"imports"`).
- `timeout` (optional) — per-cell seconds (1-3600, default 30). Bounds the cell's own work only; the clock pauses while {{#if spawns}}`agent()`/`parallel()`/{{/if}}`completion()` calls are in flight{{#if spawns}}, so fanouts never need a raise{{/if}}. Raise only for heavy local compute or long non-agent tool calls.
- `reset` (optional) — wipe this cell's language kernel first.{{#ifAll py js}} Per-language: a `py` reset never touches the JS VM.{{/ifAll}}

Work incrementally: one logical step per cell (imports, define, test, use); pass multiple small cells per call; define small reusable functions for individual debugging. Workflow explanations go in the assistant message or `title`, never inside cell code.
{{#if py}}Python runs in IPython with a live event loop: use top-level `await` directly; `asyncio.run(…)` raises "cannot be called from a running event loop".{{/if}}
On failure, errors name the failing cell ("Cell 3 failed") — resubmit only the fixed cell (plus any remaining).
</instruction>

<prelude>
{{#ifAll py js}}Same helpers in both runtimes, same positional order. Python: helpers run synchronously; trailing options are keyword args. JavaScript: helpers are async and `await`able; trailing options are ONE trailing object literal, never positional (extra positional args throw).{{else}}{{#if py}}Helpers run synchronously. Trailing options are keyword arguments.{{/if}}{{#if js}}Helpers are async and `await`able. Trailing options are ONE trailing object literal, never positional (extra positional args throw).{{/if}}{{/ifAll}}
```
display(value) → None
    Render value in cell output, shows presentable values natively (figures, images, dataframes)
print(value, ...) → None
    Print to text output.
read(path, offset?=1, limit?=None) → str
    Read file contents as text. offset/limit are 1-indexed line bounds. Local line selectors like `"file.md:201-305"` also work; accepts `local://…`; if the base file is missing, the error says it was parsed as a selector.
write(path, content) → str
    Write file (creates parents); returns resolved path. `local://…` persists across turns{{#if spawns}} / subagents{{/if}}.
append(path, content) → str
    Append to file; returns resolved path. Accepts `local://…`.
tree(path?=".", max_depth?=3, show_hidden?=False) → str
    Directory tree.
diff(a, b) → str
    Unified diff of two files.
env(key?=None, value?=None) → str | None | dict
    No args → full env dict; one → value of `key`; two → set `key=value`, return value.
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
    Read task/agent output by id; one id → text/dict, multiple → list.
tool.<name>(args) → unknown
    Invoke any session tool by name. `args` is the tool's parameter object. Null/None optional fields are omitted when the tool schema rejects null but accepts omission.
llm(prompt, model?="default", system?=None, schema?=None) → str | dict
    Oneshot, stateless LLM call (no history, no tools). `model` picks a tier: "smol" (fast), "default" (this session's model), "slow" (most capable). Pass `system` for a system prompt. Pass a JSON-Schema `schema` to force structured output and get the parsed object back; otherwise returns the completion text.
completion(prompt, model?="default", system?=None, schema?=None) → str | dict
    Alias for `llm`.
{{#if spawns}}
agent(prompt, agent_type?="task", model?=None, context?=None, label?=None, schema?=None) → str | dict
    Run a subagent and return its final output. Defaults to the bundled "task" agent; pass `agent_type`/`agentType` for another discovered agent. Pass a JSON-Schema `schema` to force structured output and get the parsed object back.
parallel(thunks) → list
    Run thunks through a bounded pool (as wide as a `task` batch — don't pre-shrink), preserving input order. Barrier: returns when all finish; a throwing thunk propagates after siblings settle.
parallel_settled(thunks) → list
    Same scheduling/order as `parallel()`, but returns per-child `{status:"fulfilled", value}` or `{status:"rejected", reason, error_type}` records so one failure cannot erase successful siblings.
pipeline(items, ...stages) → list
    Map items through one-arg stages left-to-right, barrier between stages; stage 1 gets the item, later stages the previous result. Same pool width as parallel().
{{/if}}
log(message) → None
    Progress line above the status tree.
phase(title) → None
    Start a phase grouping subsequent status lines.
budget → per-turn token budget
    {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()` (math.inf when no ceiling), `budget.hard` (bool).{{/if}}{{#if js}}`await budget.total()` (ceiling or null), `await budget.spent()`, `await budget.remaining()` (Infinity when no ceiling), `await budget.hard()`.{{/if}} Ceiling comes from a `+Nk` directive (advisory) or `+Nk!`/Goal Mode{{#if spawns}} (hard — `agent()` refuses to spawn past it){{/if}}; otherwise None/null, spend still tracked across the turn.
```
</prelude>

<example>
{
  "cells": [
    { "language": "py", "title": "imports", "timeout": 10, "code": "import json\nfrom pathlib import Path" },
    { "language": "py", "title": "load config", "code": "data = json.loads(read('package.json'))\ndisplay(data)" }
  ]
}
</example>
