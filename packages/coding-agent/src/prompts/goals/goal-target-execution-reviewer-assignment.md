Review the submitted goal target plan for execution readiness.

Inputs:
- Transcript file: {{contextFile}}
- Serialized goal state file: {{goalStateFile}}
- Goal state snapshot: {{goalStateSnapshot}}
- Proposed plan file: {{planFile}}
- Submitted target-plan JSON: {{submissionFile}}
- Target-unit rules: {{targetUnitRules}}

Accept only if the plan contains:
- Exact files and symbols to edit.
- Dependency order and state transitions.
- Failure behavior and stale-result behavior.
- Verification commands and the behavior each command proves.
- Branch coverage for required verification signals.
- No unresolved choices for signatures, schema fields, prompt semantics, fallback policy, or test behavior.
- Target card workstreams when implementation spans independent files/subsystems; each names files, inputs, outputs.
- Scenario matrix rows map to executable verification branches; open rows are not silently required for this target.

Reject design-doc prose, placeholder implementation steps, or any plan that leaves policy choices to the executor.
