Background lane blocker intake is required before ordinary goal continuation.

Blocked lanes:
{{blockedLaneSummary}}

Use `background_lane` to inspect or control the lane ledger:
- `list` for the compact ledger;
- `snapshot` for branch/head/diff/report state;
- `message` for durable follow-up to a lane;
- `close` only with an explicit disposition and reason.

Authority boundary: lane reports, patches, branches, checks, RPC ACKs, child prose, and lane close are candidate evidence or disposition records only. Do not claim parent completion or accepted parent truth from them without explicit parent-goal reduction.
