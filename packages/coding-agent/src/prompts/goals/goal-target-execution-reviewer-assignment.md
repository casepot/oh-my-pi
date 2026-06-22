Review the submitted goal target plan for execution readiness.

Inputs:
- Focused target-plan review context file: {{contextFile}}
- Serialized goal state file: {{goalStateFile}}
- Goal state snapshot: {{goalStateSnapshot}}
- Proposed plan file: {{planFile}}
- Submitted target-plan JSON: {{submissionFile}}
- Target-unit rules: {{targetUnitRules}}
- Use artifact references from the focused context file; do not expect a full transcript.

Accept only if the plan contains:
- Exact files and symbols to edit.
- Dependency order and state transitions.
- Failure behavior and stale-result behavior.
- Verification commands and the behavior each command proves.
- Branch coverage for required verification signals.
- No unresolved choices for signatures, schema fields, prompt semantics, fallback policy, or test behavior.
- Target card workstreams when implementation spans independent files/subsystems; each names files, inputs, outputs.
- Scenario matrix rows map to executable verification branches; open rows are not silently required for this target.
- Markdown and payload agree on target claim, scope boundaries, branches, workstreams, required verification signals, and known limits.
- Payload uses exact schema keys from `target_plan_schema`; camelCase aliases, guessed nesting, or concern-kind verification layers are blockers.
- Planner performed a real local self-check or task review; dry-run checks all pass and do not substitute for post-implementation verification.

Reject design-doc prose, placeholder implementation steps, schema guesswork, Markdown/payload semantic drift, missing files/symbols, or any plan that leaves policy choices to the executor.
