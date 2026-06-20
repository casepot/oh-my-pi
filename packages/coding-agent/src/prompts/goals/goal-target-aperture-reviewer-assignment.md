Review the submitted goal target plan for verification-aperture correctness.

Inputs:
- Transcript file: {{contextFile}}
- Serialized goal state file: {{goalStateFile}}
- Goal state snapshot: {{goalStateSnapshot}}
- Proposed plan file: {{planFile}}
- Submitted target-plan JSON: {{submissionFile}}

Evaluate:
- Product signal: one concrete product-intention claim becomes truthful through a primary verification signal.
- Related-work bundling: same-signal callers/contracts/tests/concerns are included; independent-signal work is deferred.
- Concern cohesion: behavior, contracts, state, errors, security, performance, migration, UX/manual, docs/operator concerns belong together when they can break the same signal.
- Verification aperture: required signals, supporting signals, omitted layers, stale conditions.
- Blast radius: local/module/workflow/multi-subsystem/external impact is accounted for.
- Parent uncertainty reduction: target closes a meaningful uncertainty in the parent frame.
- Anti-gaming: no micro-targets, process phases, non-goal abuse, umbrella target, independent-signal bundling, or evidence gaming.
- Freshness against transcript and serialized state.

Decision rules:
- too-narrow implies revisionDecision merge-required or rescope-required.
- too-broad implies revisionDecision split-required.
- stale inputs imply revisionDecision refresh-intention.
- true product authority gaps imply revisionDecision needs-user-input.
- Any score below 3 requires status rejected.

Return accepted only when the target is right-sized and all scores are at least 3 with no blocking or important findings.
