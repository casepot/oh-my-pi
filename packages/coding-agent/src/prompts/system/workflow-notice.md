<system-notice>
The user's message above contains the **workflow** keyword: drive this task as an explicit workflow. Decompose first, use independent/adversarial coverage when it materially improves correctness, and keep going until the task is closed.

<capabilities>
Allowed subagent spawns now: {{allowedAgentSummary}}.
{{#if planMode}}Plan mode is active: use read/search/find/lsp/web_search directly; nested subagent spawning is unavailable.{{/if}}
{{#if canUseEvalAgents}}Use Python `eval` orchestration for fan-out. Current safe agent call shape: `{{agentCallExample}}`.{{else}}{{#if canUseTaskTool}}Use the `task` tool for fan-out. Do not use eval `agent()` here: {{agentUnavailableReason}}.{{else}}Subagent fan-out is unavailable in this session: {{agentUnavailableReason}}; {{taskUnavailableReason}}. Do not call eval `agent()` or the `task` tool unless the user explicitly requests a forbidden agent and accepts the runtime error.{{/if}}{{/if}}
{{#if restrictedSpawns}}This is a restricted-spawn session. If you spawn, specify an allowed agent type explicitly unless the safe call shape above omits it.{{/if}}
</capabilities>

<when>
Worth it when the task benefits from decomposition + parallel coverage, or from independent/adversarial cross-checking before you commit. For a quick lookup or single edit, just do it directly — don't spin up agents. Scout inline FIRST (list the files, scope the diff, find the call sites) to discover the work-list, then fan out over it only if current capabilities allow it. Common shapes:
- **Understand** — parallel readers over subsystems → structured map
- **Design** — judge panel of independent approaches → scored synthesis
- **Review** — split into dimensions → find per dimension → adversarially verify each finding
- **Research** — multi-modal sweep → deep-read the hits → synthesize
- **Migrate** — discover sites → transform each → verify
</when>

{{#if canUseEvalAgents}}
<helpers>
State persists across cells, so scout in one cell and fan out in the next. Every cell has:

- `agent(prompt, *, agent_type="{{preferredAgentType}}", model=None, context=None, label=None, schema=None)` — run ONE allowed subagent; returns final text, or the validated object when `schema` (a JSON Schema dict) is given. With `schema`, branch on the object, not parsed prose. `agent_type` MUST be one of: {{allowedAgentSummary}}. Eval-spawned agents nest at most 3 deep and still inherit their own spawn limits.
- `parallel(thunks)` — run zero-arg callables concurrently through a bounded pool, preserving input order; returns once all finish. A thunk that raises propagates after siblings settle.
- `parallel_settled(thunks)` — same scheduling/order as `parallel()`, but returns `[{"status":"fulfilled","value":…}, {"status":"rejected","reason":"…","error_type":"…"}]` so one bad child cannot erase successful siblings.
- `pipeline(items, *stages)` — map items through `stages` left-to-right. There is a BARRIER between stages: ALL items clear stage N before stage N+1 begins.
- `llm(prompt, *, model="default", system=None, schema=None)` — oneshot, stateless model call. Tiers: "smol", "default", "slow".
- `log(message)` / `phase(title)` — emit progress/status.
- `budget` — hard turn ceilings block `agent()` once spent reaches total.

Everything runs inline and synchronously inside the eval call. Each eval call is one well-scoped fan-out; chain several across cells and turns for multi-phase work, reading each result before deciding the next phase.
</helpers>

<structure>
For independent per-item chains (review → verify, fetch → extract → score), wrap the WHOLE chain in one function and run it with `parallel()` or `parallel_settled()`:

    DIMENSIONS = [{"key": "bugs", "prompt": "…"}, {"key": "perf", "prompt": "…"}]
    def review_and_verify(d):
        found = agent(d["prompt"], agent_type="{{preferredAgentType}}", label=f"review:{d['key']}", schema=FINDINGS_SCHEMA)
        return parallel_settled([lambda f=f: {**f, "verdict": agent(
            f"Refute if you can (default refuted when unsure): {f['title']}",
            agent_type="{{preferredAgentType}}", label=f"verify:{f['file']}", schema=VERDICT_SCHEMA)} for f in found["findings"]])
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
- **No silent caps** — if you bound coverage, `log()` what you dropped.
</patterns>
{{else}}
{{#if canUseTaskTool}}
<task-tool-workflow>
Use `task` directly for independent subagent work. Batch the full decomposed work-list in one task call when items are independent. Use only allowed agents: {{allowedAgentSummary}}. Subagents inherit their own spawn limits; recursive spawning is allowed only when their capability notice says so.
</task-tool-workflow>
{{else}}
<inline-workflow>
Run the workflow inline with direct tools and eval computation. Use `todo` for phases, `read`/`search`/`find`/`lsp` for evidence, and `llm()` in eval only if eval is available and useful. Record where independent/adversarial coverage would have run if capabilities allowed it; do not silently pretend it ran.
</inline-workflow>
{{/if}}
{{/if}}

<execution>
- Decompose the surface first; capture it in `todo` when it spans phases.
- Prefer `schema=` for any agent whose output you branch on.
- After a fan-out returns, YOU own correctness: read the artifacts, run the gate, verify before acting. Subagents do the legwork; they don't get the last word.
- Eval file edits are allowed; choose edit/write/eval based on reliability semantics and recovery needs.
- Keep going until the task is closed — a returned fan-out is a step, not a stopping point.
</execution>
</system-notice>
