Review the submitted goal target plan for verification-aperture correctness.

Inputs:
- Focused target-plan review context file: {{contextFile}}
- Serialized goal state file: {{goalStateFile}}
- Goal state snapshot: {{goalStateSnapshot}}
- Proposed plan file: {{planFile}}
- Submitted target-plan JSON: {{submissionFile}}

- Target-unit rules: {{targetUnitRules}}
Evaluate only aperture and product-signal fit:
- Product signal: one concrete product-intention claim becomes truthful through a primary verification signal.
- Related-work bundling: same-signal callers/contracts/tests/concerns are included; independent-signal work is deferred.
- Concern cohesion: behavior, contracts, state, errors, security, performance, migration, UX/manual, docs/operator concerns belong together when they can break the same signal.
- Verification aperture: required signals, supporting signals, omitted layers, stale conditions.
- Blast radius: local/module/workflow/multi-subsystem/external impact is accounted for.
- Parent uncertainty reduction: target closes a meaningful uncertainty in the parent frame.
- Anti-gaming: no micro-targets, process phases, non-goal abuse, umbrella target, independent-signal bundling, or evidence gaming.
- Freshness against focused context, serialized state, submitted plan, and payload artifacts.
- Scenario matrix: in-scope rows cover submitted branch evidence; rows left open map to independent signal/authority/blast-radius boundaries.
- Claimed caller entry points, UI/status surfaces, protocol responses, or trust-visible branches need in-scope rows for each claimed caller/surface and each claimed allowed/denied/unavailable branch.
- Pure core/unit rows do not prove caller-level trust surfaces unless caller rows assert no call, response/status metadata, and forbidden side effects.
- Target card: depth matches risk; capability/user surface/known limits/checkpoint evidence are concrete.
- Target-unit rules: every applicable rule is enforced or explicitly exempted with a safe rationale.
- Use artifact references from the focused context file; do not expect a full transcript.

Review discipline:
- Preserve prior accepted aperture unless the current plan changes product signal, scope, authority boundary, or blast radius.
- Stale/self-contradictory artifacts are freshness findings, not too-broad/too-narrow unless scope changed.
- Do not convert execution-detail gaps into aperture rejection unless they change claimed product surface, same-signal inclusion, authority boundary, or blast radius.
- On rejection, name the exact merge/split/rescope needed; do not repeat accepted scope analysis.

Decision rules:
- too-narrow implies revisionDecision merge-required or rescope-required.
- too-broad implies revisionDecision split-required.
- stale inputs imply revisionDecision refresh-intention.
- true product authority gaps imply revisionDecision needs-user-input.
- Any score below 3 requires status rejected.

Return accepted only when the target is right-sized and all scores are at least 3 with no blocking or important findings.
