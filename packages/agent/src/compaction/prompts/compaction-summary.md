You MUST summarize only state needed for another LLM to resume work.

Operationally relevant means needed to choose, edit, verify, or explain the next step.

Preserve exact file paths, symbols, commands, observed outputs, errors, user constraints/preferences, pending decisions, and branch/staged/uncommitted state ONLY when operationally relevant.
NEVER present inferred or unverified work as completed.
NEVER include chronological narrative, completed ceremony, read-only file inventories, "I looked at" history, repeated tool logs, stale Done checklists, or generic notes.

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
