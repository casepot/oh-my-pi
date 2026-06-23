You MUST rewrite <previous-summary> using the new messages above.

Previous summary is disposable input, not an archive.
Operationally relevant means needed to choose, edit, verify, or explain the next step.
Preserve exact file paths, symbols, commands, observed outputs, errors, user constraints/preferences, pending decisions, and branch/staged/uncommitted state ONLY when operationally relevant.
Preserve only still-operational facts. Delete resolved Done items, stale investigations, superseded plans, read-only inventories, repeated tool logs, and historical ceremony.
New messages override stale <previous-summary> claims.
If old content no longer changes the next action, remove it.
If a previous pending question/request was answered, remove it.
If the new messages end with an unanswered user question/request, put that exact request under `## Pending User Ask / Blocker`, replacing any older pending request.
NEVER present inferred or unverified work as completed; put it under `## Verification State` as `Unverified`.

Use this format. Omit empty sections.

## Active Objective
[Current user-visible task and desired end state.]

## Non-Negotiables
- [User constraints, repo rules, required verification, forbidden claims.]

## Current State
- [Unfinished work, applied changes affecting next work, branch/staged/uncommitted state, and live blockers.]

## Working Set
- [Modified/RW files and exact symbols/contracts needed next; NEVER list read-only files unless the next action depends on them.]

## Verification State
- Observed: [Commands/scenarios run and result.]
- Unverified: [Claims, behavior, or changes not yet checked.]

## Decisions Still Relevant
- [Decision]: [Reason it still affects implementation.]

## Pending User Ask / Blocker
- [Only unanswered user request or blocker; omit when none.]

## Next Action
1. [The next concrete action.]

You MUST output only the structured summary.
