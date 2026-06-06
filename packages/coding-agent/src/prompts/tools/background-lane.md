Controls durable background lanes for active goal-mode sessions.

Background lanes are not `task` fan-in. A lane is a persistent divergent branch/worktree with an attached child OMP RPC session and an explicit parent-disposition obligation. Use it when accepted checkpoint truth lets the main spine continue while a separate question must run in parallel and be reduced later.

<operations>
- `spawn`: create a lane from an accepted checkpoint and source commit. Requires `from.checkpoint_id`, `from.source_ref`, `contract.question`, `contract.blocks_if`, `contract.required_before_parent`, and `assignment`; `agent` is optional. Persists the lane record, creates a branch/worktree, starts or attaches a child RPC session, and sends the assignment.
- `list`: show compact lane ledger rows: id, status/outcome, agent status, required-before-parent flag, blocker flag, branch, and question.
- `message`: send durable follow-up to an open lane. Reattaches or restarts the child session when possible, then returns the child operation id.
- `snapshot`: observe lane source state: child status, branch/worktree, head source ref, changed-file count, patch artifact ref, latest report ref, and blocker flag. Observation only.
- `close`: record a disposition for the lane obligation. Requires `lane_id`, `outcome`, and `reason`; `outcome` is one of `merged`, `dropped`, `stale`, `superseded`, `no_release`, or `deferred`. `merged` also requires `merged_source_ref` or `operator_statement`.
</operations>

<rules>
- `spawn` requires active goal mode, an accepted checkpoint id, a branchable commit source ref, and a clean git working tree in v1.
- `required_before_parent: true` makes the lane a parent-completion obligation until `close` records a disposition.
- A lane blocker is structured state, not prose. Parent blocker state changes only when the child uses `lane_report` with `blocks_if_fired: true`.
- If a lane is blocked, ordinary goal continuation is suppressed. Use `list`/`snapshot` to inspect, `message` for durable follow-up, and `close` only when you have an explicit disposition and reason.
- `snapshot` and `list` never accept claims, merge code, or close the obligation.
- `close` satisfies or defers the lane obligation only; it does not accept parent truth, release truth, residual risk, or child claims.
</rules>

<critical>
- NEVER use `background_lane` as a substitute for `task`. Use `task` for bounded work that must fan into the current target; use `background_lane` for durable divergent work that may outlive the current target.
- NEVER infer a blocker from child prose, branch existence, patch existence, checks, RPC ACKs, or child completion. Use structured `lane_report` state.
- NEVER treat lane output, lane closure, merged source refs, or operator statements as parent completion. Parent completion still requires the goal completion path.
- Do not spawn a lane from dirty local state or from an unaccepted checkpoint.
</critical>