# Plan Review Anti-Patterns

Common failure modes in target-plan review, with causes and remedies.

## Rubber Stamp Gate

**Symptom:** Reviewer returns `accepted` with generic praise or no concrete trace.

**Cause:** Prompt asked for approval instead of investigation.

**Remedy:** Re-prompt with exact artifacts, lens, risk questions, output fields, and evidence requirements. Ask what is wrong, not whether it works.

## Lint Treadmill

**Symptom:** Review findings only restate schema or enum issues.

**Cause:** Reviewer was used as a schema checker.

**Remedy:** Run `lint_target_plan` for schema/graph issues. Use reviewers for product truth, aperture, contracts, branch oracles, and execution ambiguity.

## Schema Theater

**Symptom:** Payload is complete but plan still leaves executor decisions open.

**Cause:** Agent optimized for fields instead of execution truth.

**Remedy:** Require reviewer to trace plan/payload to concrete execution choices and verification outcomes.

## Confirmation Bias

**Symptom:** Reviewer confirms the target is right-sized or complete because the prompt says it is.

**Cause:** Prompt includes expected verdict or preferred fix.

**Remedy:** Ask "what makes this too broad/too narrow/incomplete?" Never tell reviewers what answer you want.

## Overbroad Target

**Symptom:** Plan bundles independent product signals, authority boundaries, or verification layers.

**Cause:** Parent objective leaked into target scope.

**Remedy:** Split target by primary signal or authority boundary. Keep same-signal work together; defer independent signals explicitly.

## Micro-Target

**Symptom:** Target closes schema/plumbing/helper work while product signal remains untruthful.

**Cause:** Agent chose easiest implementation slice instead of smallest meaningful product unit.

**Remedy:** Merge same-signal callers, contracts, state, errors, tests, and docs/operator changes into one right-sized target.

## Reviewer Theater

**Symptom:** Payload contains review records, but reviewer ids/artifacts/source are fake, local-only, or unverifiable.

**Cause:** Agent treated evidence as a field-filling exercise.

**Remedy:** Use real reviewer artifacts or mark local review only where low-risk and justified. Never fabricate ids, artifact URIs, validation replies, or source metadata.

## Stale Review Evidence

**Symptom:** Plan changes after accepted review, but payload keeps `revised_after_review:false`.

**Cause:** Review freshness was not tracked.

**Remedy:** Mark stale, ask original reviewer to validate the specific fix, or rerun the gate review. Submit only current target-plan id/revision.

## Fresh Reviewer as Fix Validator

**Symptom:** A new reviewer is asked whether an old finding was fixed.

**Cause:** Fix validation and new discovery were collapsed.

**Remedy:** Ask the original reviewer by IRC to validate their specific finding. Fresh reviewers search for new issues only.

## Broad Fix Validation

**Symptom:** Original reviewer re-reviews the whole plan instead of the fixed finding.

**Cause:** Follow-up prompt was too broad.

**Remedy:** Ask narrowly whether the specific finding is resolved, whether the fix creates a directly related issue, and what evidence they checked.

## Missing Consumer Trace

**Symptom:** Plan names a new field, command, state, API, or prompt behavior without checking consumers.

**Cause:** Reviewer inspected producer-side text only.

**Remedy:** Trace producer to router/handler/verifier/persistence/operator surface. Missing branch, oracle, or failure path is a finding.

## Weak Verification Oracle

**Symptom:** Verification command runs but would pass if target behavior were wrong.

**Cause:** Plan asserts activity instead of observable outcome.

**Remedy:** Require expected branch outcomes, negative cases, stale-if conditions, and the signal each check proves.

## Markdown/Payload Drift

**Symptom:** Markdown tells executor one thing; payload encodes another.

**Cause:** Agent patched only one artifact after review or lint.

**Remedy:** Treat Markdown as executor spec and payload as machine contract. Patch both when executor-visible semantics change; avoid Markdown churn for schema-only repairs.

## Source-Free Confidence

**Symptom:** Reviewer says "looks complete" without citing files, branches, commands, or payload paths.

**Cause:** Prompt did not require evidence.

**Remedy:** Reject or re-prompt. Review silence is not evidence.

## Local Review on Heavy Target

**Symptom:** Standard/trust-heavy target uses `source.kind:"local"` for gate reviews.

**Cause:** Agent avoided reviewer fanout or tooling constraints.

**Remedy:** Use planning-mode subagent reviewers. If unavailable, record why in feedback and downgrade/reshape the target if evidence cannot support it.

## False Convergence

**Symptom:** Later reviews find no issues because prompts got narrower or confirmatory.

**Cause:** Scrutiny decreased rather than plan improving.

**Remedy:** Use a targeted convergence prompt that falsifies the riskiest remaining assumptions. Convergence requires evidence, not silence.

## Reviewer-Driven Overfixing

**Symptom:** Plan expands scope to satisfy every suggestion.

**Cause:** Orchestrator treated reviewer output as commands.

**Remedy:** Triage every finding. Fix blockers, document simplifications, defer parent/future work, reject noise.

## Repeated Boundary Findings

**Symptom:** Multiple reviews keep finding target-size or scope-boundary problems.

**Cause:** Target shape is wrong, not wording.

**Remedy:** Stop patching prose. Split, merge, rescope, refresh intention, or fail target planning.

## Findings That Are Not Findings

Not every reviewer output is actionable:

- **Feature requests** — evaluate independently, not as review findings.
- **Schema preferences** — lint owns schema; review owns truth.
- **Pre-existing parent work** — defer unless current target worsens it.
- **Architecture disagreements** — reject if target boundary is documented and truthful.
- **Suggestions that add complexity** — require concrete failure mode.
- **Restated facts** — not a finding unless they break execution or verification.
