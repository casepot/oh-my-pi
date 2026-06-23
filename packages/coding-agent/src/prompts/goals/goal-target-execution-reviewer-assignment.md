Review the submitted goal target plan for execution readiness.

Inputs:
- Focused target-plan review context file: {{contextFile}}
- Serialized goal state file: {{goalStateFile}}
- Goal state snapshot: {{goalStateSnapshot}}
- Proposed plan file: {{planFile}}
- Submitted target-plan JSON: {{submissionFile}}
- Target-unit rules: {{targetUnitRules}}
- Use artifact references from the focused context file; do not expect a full transcript.

Accept when the submitted plan is decision-complete for product truth:
- No unresolved product behavior, public/external contract, schema/persistence, policy/authority, state/failure/stale-result, dependency-order, or verification decision.
- Exact files/symbols and exact public signatures/types/schema/request/response fields for external, cross-module, or test-consumed contracts.
- Internal helpers/private state machines are exact only when behavior, persistence, policy, or testability depends on them.
- Scenario rows map product branches to executable oracles: initial state, stimulus/API call, transition order, observable result/error/status/record, forbidden meaning, assertion command.
- Verification commands name the behavior each command proves.
- Branch coverage exists for every required verification signal.
- Target card workstreams exist when implementation spans independent files/subsystems; each names files, inputs, outputs.
- Markdown and payload agree on target claim, scope boundaries, branches, workstreams, required verification signals, and known limits.
- Submitted target-plan JSON uses exact schema keys from `target_plan_schema`; camelCase aliases, guessed nesting, or concern-kind verification layers are blockers.
- Only judge schema key casing in the Submitted target-plan JSON; goal state and context artifacts use internal camelCase.
- `dry_run` records observed plan-artifact checks for this exact plan/payload: lint/schema, Markdown/payload agreement, cited repo-symbol reads, and planner review. It is not implementation verification.
- The plan never depends on prior attempts, hidden context, or future executor design.

Strictness boundary:
- A blocking finding MUST name the product-truth decision the executor would otherwise make.
- Missing detail blocks only when plausible implementations could both follow the plan but differ in product-visible behavior, persistence/policy meaning, or asserted verification output.
- Require exact literals for public/API/protocol/status/error/persistence/policy outputs, cross-language seams, and test/golden oracle data.
- Do not require exhaustive private constructor calls, helper constants, fixture names, or implementation-local plumbing when constraints, branch meaning, and verification are fixed.
- Large/substantial targets need code-like precision: contracts, invariants, state transitions, branch oracles, and verification mapping; not source-code volume.
- Small/local targets may require exact declarations/literals when cheap and directly execution-relevant.

Feedback discipline:
- On rejection, return the complete acceptance delta visible from current artifacts; NEVER drip-feed one blocker per round.
- Each blocker MUST name missing decision category, plan/payload location, concrete satisfying shape, and product-truth risk.
- Return one finding per missing decision category; never emit a general blocker and a duplicate missing-detail blocker for the same issue.
- NEVER emit placeholder findings such as `MISSING_EXECUTION_DETAIL_*`.
- Use stable finding IDs such as `api-contract`, `state-machine`, `caller-branch-oracle`, `response-literals`, `verification-command`, `dry-run-evidence`; reuse the same ID when the same category remains unresolved.
- Complete acceptance delta does not mean duplicated blockers.
- Do not repeat a prior blocker unless it remains present; say what is still missing.
- Do not reject for lint-owned presentation/schema issues unless submitted JSON actually violates schema or Markdown/payload semantics drift.
- Schema citations, self-approval prose, future-tense dry runs, or future implementation checks are not evidence.

Reject design-doc prose, placeholder implementation steps, schema guesswork, Markdown/payload semantic drift, missing product-truth decisions, or any plan that leaves policy choices to the executor.
