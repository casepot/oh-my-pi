Inspects, waits, or cancels async jobs.

Results arrive automatically on completion; reach for this tool only to intervene.

Jobs are process-local scheduling records. They are not restored after a restart or resume; for a remembered subagent, use `irc` to wake it or `history://<id>` to read its transcript.

# Operations

## `list: true`
Inspect what's running.

## `poll: [id, …]`
Block until specified jobs finish or the wait window elapses. Omit `poll` (no `list`/`cancel`) to wait on ALL running jobs — NEVER enumerate ids you don't need to filter.
- Use only when genuinely blocked with no other work.
- Completed jobs include final output.

## `cancel: [id, …]`
Stop running jobs.
- Use when a job is stalled, hung, or no longer needed.
