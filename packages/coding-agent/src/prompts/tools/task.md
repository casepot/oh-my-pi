{{#if asyncEnabled}}{{#if batchEnabled}}Delegate work to background subagents by passing multiple items in a single `tasks[]` batch.{{else}}Delegate work to ONE background subagent per call.{{/if}}
Execution does not block your turn: you receive agent and job IDs immediately, and the final results deliver themselves when the subagents finish.{{#if hasBlockingAgents}}
{{#if batchEnabled}}Exception: agents marked BLOCKING below run inline — their results return in this call, while non-blocking items in the same batch still spawn as background jobs.{{else}}Exception: agents marked BLOCKING below run inline and return their result in this call instead of spawning a background job.{{/if}}{{/if}}{{else}}{{#if batchEnabled}}Run subagents synchronously by passing items in a `tasks[]` batch.{{else}}Run ONE subagent synchronously per call.{{/if}}
Execution blocks your turn: the call only returns once the work is completely finished.{{/if}}

# Task Design
{{#when MAX_CONCURRENCY ">" 0}}
- **Concurrency cap:** At most {{pluralize MAX_CONCURRENCY "subagent" "subagents"}} run at once in this session — anything beyond that just queues, so a {{#if batchEnabled}}`tasks[]` batch{{else}}set of parallel `task` calls{{/if}} larger than {{MAX_CONCURRENCY}} only delays results. Keep the fan-out at or under the cap.
{{/when}}
{{#if allowedAgentsText}}
- **Agent typing:** Current spawn policy allows only {{allowedAgentsText}}. Omitting `agent` selects `{{defaultAgent}}`; choose another allowed specialist explicitly when it fits better.
{{else}}
- **Agent typing:** Choose the `agent` type first. Read-only research MUST use `agent: "scout"`, which runs on a faster model. Use the default worker only when no listed specialist fits.
{{/if}}
- **No overhead:** Each `task` assignment MUST instruct its agent to skip formatters, linters, and project-wide test suites. You will run those once at the end.
- **One-pass agents:** Prefer agents that investigate **and** edit in one pass; use a read-only discovery agent only when the affected files are genuinely unknown.

# Effective Child Policy
Shared runs default to the policy below; every spawn acknowledgment returns the exact per-agent snapshot in `details.effectivePolicies`.
- Request policy: {{runtimePolicy.request}}.
- Runtime policy: {{runtimePolicy.wallClock}}.
- Stall guard: {{runtimePolicy.stall}}.
- Descendant spawn depth: {{runtimePolicy.spawn}}.
- Retention: {{runtimePolicy.idle}}. Recovery uses `history://<id>` for the transcript and `agent://<id>` for latest output. Messages resume `paused`/`idle` sessions only while resumable; `parked` revival also requires a retained resumable session.
{{#if isolationEnabled}}- Isolated runs retain no live session; their stall action is `fail`, not `pause`.{{/if}}

# Inputs
{{#if batchEnabled}}
- `context`: Shared project state, constraints, and contracts. Applies to the entire batch; do not duplicate this background into individual tasks.
- `tasks[]`: Array of subagents to spawn.
  - `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
  - `agent`: The agent type running this item (e.g. `scout`, `reviewer`). {{#if allowedAgentsText}}Omitting it selects the restricted-policy default (`{{defaultAgent}}`). Allowed types: {{allowedAgentsText}}.{{else}}Omitting it gives you the general-purpose worker (`{{defaultAgent}}`) — NEVER pass that name explicitly. Only omit it after checking the agent list below and finding no specialist that fits.{{/if}}
  - `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
{{#if isolationEnabled}}
  - `isolated`: Run in a dedicated worktree and return patches. Isolated agents are destroyed upon completion and cannot be addressed afterward.
{{/if}}
{{else}}
- `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
- `agent`: The agent type to spawn (e.g. `scout`, `reviewer`). {{#if allowedAgentsText}}Omitting it selects the restricted-policy default (`{{defaultAgent}}`). Allowed types: {{allowedAgentsText}}.{{else}}Omitting it gives you the general-purpose worker (`{{defaultAgent}}`) — NEVER pass that name explicitly. Only omit it after checking the agent list below and finding no specialist that fits.{{/if}}
- `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
{{#if isolationEnabled}}
- `isolated`: Run in a dedicated worktree and return patches. Isolated agents are destroyed upon completion and cannot be addressed afterward.
{{/if}}
{{/if}}

# Context and Communication
Subagents start blank. They have no access to your conversation history.
{{#if ircEnabled}}- **Steering delivery:** Parent-to-subagent IRC is delivered immediately as steering; subagents blocked in `job poll` / `irc wait` do not need to poll separately for it.{{/if}}
{{#if batchEnabled}}
- Pass large payloads using `local://<path>` URIs, NEVER inline text.
{{else}}
- Write shared project state ONCE to a `local://` file (e.g., `local://ctx.md`) and reference that URL in each `task`.
{{/if}}

# Format Contracts
{{#if batchEnabled}}
The `context` field MUST follow this format:
# Goal         ← what the batch accomplishes
# Constraints  ← rules and session decisions
# Contract     ← shared interfaces
{{/if}}

The `task` field MUST follow this format:
# Target       ← exact files and symbols; explicit non-goals
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands

# Available Agents
{{#if spawningDisabled}}
Agent spawning is currently disabled.
{{else}}
{{#if allowedAgentsText}}Pick the most specific allowed agent. Omitting `agent` selects `{{defaultAgent}}`.{{else}}Pick the most specific agent for each task. Use the default worker only when no specialist below fits.{{/if}}
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (READ-ONLY: no edit/write/command tools){{/if}}{{#if blocking}} (BLOCKING: runs inline; its result returns in this call){{/if}}
{{description}}
{{#if readOnly}}Use ONLY for investigation and reporting; do the edits yourself or assign them to a writing agent.{{/if}}
{{/list}}
{{/if}}
