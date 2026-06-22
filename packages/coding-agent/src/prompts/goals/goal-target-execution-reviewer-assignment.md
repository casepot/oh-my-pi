Review the submitted goal target plan for execution readiness.

Inputs:
- Focused target-plan review context file: {{contextFile}}
- Serialized goal state file: {{goalStateFile}}
- Goal state snapshot: {{goalStateSnapshot}}
- Proposed plan file: {{planFile}}
- Submitted target-plan JSON: {{submissionFile}}
- Target-unit rules: {{targetUnitRules}}
- Use artifact references from the focused context file; do not expect a full transcript.

Accept only if the submitted plan is a self-contained implementation oracle:
- Exact files and symbols to edit.
- Exact public signatures/types/schema fields/request/response fields.
- Exact private helpers/state machines when behavior needs them.
- Dependency order, state transitions, failure behavior, and stale-result behavior.
- Scenario rows map to executable branches: initial state, stimulus/API call, transition order, exact result/error/record/explain values, forbidden meaning, assertion command.
- Verification commands name the behavior each command proves.
- Branch coverage exists for every required verification signal.
- No unresolved choices for signatures, schema fields, prompt semantics, fallback policy, literals, oracle data, or test behavior.
- Target card workstreams exist when implementation spans independent files/subsystems; each names files, inputs, outputs.
- Markdown and payload agree on target claim, scope boundaries, branches, workstreams, required verification signals, and known limits.
- Submitted target-plan JSON uses exact schema keys from `target_plan_schema`; camelCase aliases, guessed nesting, or concern-kind verification layers are blockers.
- Only judge schema key casing in the Submitted target-plan JSON; goal state and context artifacts use internal camelCase.
- Planner performed a real local self-check or task review; `dry_run` checks pass and cite observed current-artifact evidence.
- The plan never depends on prior attempts, hidden context, or future executor design.
Feedback discipline:
- On rejection, return the complete acceptance delta visible from current artifacts; NEVER drip-feed one blocker per round.
- Each blocker MUST name missing decision category, plan/payload location, and concrete satisfying shape.
- Do not repeat a prior blocker unless it remains present; say what is still missing.
- Do not reject for lint-owned presentation/schema issues unless submitted JSON actually violates schema or Markdown/payload semantics drift.
- Schema citations, self-approval prose, or future-tense dry runs are not evidence.

Reject design-doc prose, placeholder implementation steps, schema guesswork, Markdown/payload semantic drift, missing files/symbols, or any plan that leaves policy choices to the executor.
