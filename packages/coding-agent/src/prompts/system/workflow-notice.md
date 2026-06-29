<system-notice>
The user's message above contains the **workflowz** keyword: drive this task as a deterministic workflow. Use eval/task fan-out when capabilities allow — for comprehensive coverage, independent confidence, or scale one context cannot hold. Decompose first; keep going until the task is closed.

<capabilities>
{{spawnPolicy}}
Eval available: {{evalAvailable}}
Task tool available: {{taskToolAvailable}}
</capabilities>

<when>
Worth it when the task benefits from decomposition + parallel coverage, or from independent/adversarial cross-checking before you commit. For a quick lookup or single edit, just do it directly — don't spin up agents. Scout inline FIRST (list the files, scope the diff, find the call sites) to discover the work-list, then fan out over it only if current capabilities allow it. You need the shape before fan-out, not before the task. Common shapes:
- **Understand** — parallel readers over subsystems → structured map
- **Design** — judge panel of independent approaches → scored synthesis
- **Review** — split into dimensions → find per dimension → adversarially verify each finding
- **Research** — multi-modal sweep → deep-read the hits → synthesize
- **Migrate** — discover sites → transform each → verify
</when>

{{#if canUseEvalAgents}}
<helpers>
State persists across eval calls, so scout in one call and fan out in the next. Every eval call has:

- `agent(prompt, *, agent="task", model=None, label=None, schema=None, isolated=None, apply=None, merge=None, handle=False)` — run ONE allowed subagent; returns final text, or the validated object when `schema` (a JSON Schema dict) is given. With `schema`, branch on the object, not parsed prose. `agent` MUST be one of: {{allowedAgentSummary}}; {{#if preferredAgentType}}use `agent="{{preferredAgentType}}"` unless another allowed agent fits better{{else}}choose one allowed agent explicitly{{/if}}. Shared background goes in a `local://` file referenced from each prompt. `agent()` blocks until the subagent finishes; eval-spawned agents nest at most 3 deep and inherit spawn limits. Pass `isolated=True` to run the spawn in a copy-on-write worktree when enabled. With isolation, `apply=False` keeps changes in the worktree, and `merge=False` forces patch mode. Use `handle=True` with `apply=False` to recover patch, branch, nested-patch, apply-summary, and artifact metadata.
- `parallel(thunks)` — run zero-arg callables concurrently through a bounded pool, preserving input order; returns once all finish. The pool is bounded by the session's `task` concurrency — don't hand-tune it; fan out as wide as the work divides. A thunk that raises propagates after siblings settle. In a loop, bind each closure's value with a default arg (`lambda d=d: …`) or every thunk captures the last one.
- `parallel_settled(thunks)` — same scheduling/order as `parallel()`, but returns `[{"status":"fulfilled","value":…}, {"status":"rejected","reason":"…","error_type":"…"}]` so one bad child cannot erase successful siblings.
- `pipeline(items, *stages)` — map items through `stages` left-to-right. There is a BARRIER between stages: ALL items clear stage N before stage N+1 begins. Each stage is a one-arg callable; stage 1 gets the original item, later stages get the previous result. Same pool width as `parallel()`.
- `completion(prompt, *, model="default", system=None, schema=None)` — oneshot, stateless model call (no tools, no history). Tiers: "smol", "default", "slow". Cheap classification/scoring inside a fan-out.
- `log(message)` — emit a progress line above the status tree. `phase(title)` — start a phase; the status lines that follow group under it.
- `budget` — `budget.total` (output-token ceiling, or `None` when none is set), `budget.spent()` (tokens spent this turn — main loop + eval subagents), `budget.remaining()` (`math.inf` when total is `None`), `budget.hard` (whether it's enforced). A ceiling is set by the user: `+Nk` is advisory, `+Nk!` or Goal Mode is hard — `agent()` refuses to spawn once spent reaches it. Gate loops on `budget.total` first, since it's `None` when the user set no budget.

Everything runs INLINE and synchronously inside the eval call — no background mode, no resume, no separate progress app. Each eval call is one well-scoped fan-out; chain several across calls and turns for multi-phase work, reading each result before you decide the next phase.
</helpers>

<structure>
For independent per-item chains (review → verify, fetch → extract → score), wrap the WHOLE chain in one function and run it with `parallel()` or `parallel_settled()`:

    DIMENSIONS = [{"key": "bugs", "prompt": "…"}, {"key": "perf", "prompt": "…"}]
    def review_and_verify(d):
        found = agent(d["prompt"], {{#if preferredAgentType}}agent="{{preferredAgentType}}", {{/if}}label=f"review:{d['key']}", schema=FINDINGS_SCHEMA)
        return parallel_settled([lambda f=f: {**f, "verdict": agent(
            f"Refute if you can (default refuted when unsure): {f['title']}",
            {{#if preferredAgentType}}agent="{{preferredAgentType}}", {{/if}}label=f"verify:{f['file']}", schema=VERDICT_SCHEMA)} for f in found["findings"]])
    phase("Review")
    results = parallel_settled([lambda d=d: review_and_verify(d) for d in DIMENSIONS])
    usable = [r["value"] for r in results if r["status"] == "fulfilled"]

Reach for `pipeline()` only when a stage genuinely needs ALL of the previous stage first — dedup/merge across the whole set, early-exit on zero, or compare against other findings. Don't add a barrier just to flatten/map/filter — do that with plain Python between calls. Nested `parallel()` pools each cap independently, so keep total fan-out sane.
</structure>

<patterns>
Compose the harness the task calls for:
- **Adversarial verify** — N independent skeptics per finding, each prompted to REFUTE; keep it only if a majority survive.
- **Perspective-diverse verify** — distinct lenses: correctness, security, perf, reproduce.
- **Judge panel** — independent attempts scored by parallel judges; synthesize from the winner, graft useful parts.
- **Loop-until-dry** — unknown-size discovery continues until K consecutive rounds surface nothing new; dedup against everything SEEN.
- **Multi-modal sweep** — parallel finders by-container, by-content, by-entity, by-time.
- **Completeness critic** — final agent asks what is missing; answer drives next round.
- **Budget/count loops** — target count or `budget.remaining()` gates scale; `log()` each round.
- **No silent caps** — if you bound coverage, `log()` what you dropped.

Scale to the ask: "find any bugs" → a few finders, single-vote verify. "Thoroughly audit / be comprehensive" → larger finder pool, 3–5-vote adversarial pass, synthesis stage.
</patterns>
{{else}}
{{#if canUseTaskTool}}
<task-tool-workflow>
Use `task` directly for independent subagent work. Batch the full decomposed work-list in one task call when items are independent. Use only allowed agents: {{allowedAgentSummary}}. Subagents inherit their own spawn limits; recursive spawning is allowed only when their capability notice says so.
</task-tool-workflow>
{{else}}
<inline-workflow>
Run the workflow inline with direct tools and eval computation. Use `todo` for phases, `read`/`grep`/`glob`/`lsp` for evidence, and `completion()` in eval only if eval is available and useful. Record where independent/adversarial coverage would have run if capabilities allowed it; do not silently pretend it ran.
</inline-workflow>
{{/if}}
{{/if}}

<execution>
- Decompose the surface first; capture it in `todo` when it spans phases.
- Prefer `schema=` for any agent whose output you branch on.
- After a fan-out returns, YOU own correctness: read the artifacts, run the gate, verify before acting. Subagents do the legwork; they don't get the last word.
{{#if planningMode}}- Planning mode: agents are for planning/review evidence; eval/bash file transforms stay within the active plan artifacts.
{{else}}- Eval file edits are allowed; choose edit/write/eval based on reliability semantics and recovery needs.
{{/if}}
- Keep going until the task is closed — a returned fan-out is a step, not a stopping point.
</execution>
</system-notice>
