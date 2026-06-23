# Prompting Plan Reviewers

How to write target-plan reviewer prompts that produce substantive findings instead of rubber stamps, lint churn, or confirmation bias.

The prompt's job is to create an investigation, not a validation ceremony.

## Prompt Structure

Every reviewer prompt needs six elements:

1. **Lens** — what they are looking for. "Reviewing aperture" not "review this plan."
2. **Artifacts** — exact plan Markdown path, payload JSON path, and source/test/docs paths.
3. **Questions** — concrete concerns. "Trace branch `row-happy` from payload to verifier command" not "check verification."
4. **Standards** — the approval bar. "Flag untruthful claims, missing contracts, weak oracles, stale evidence, wrong aperture, and missed simplifications."
5. **Output format** — exact `target_plan_reviews[]` fields.
6. **Exclusions** — "Report only real blockers/important gaps. Skip style, schema churn, and feature requests."

## Required Output Contract

For each gate review, require one `target_plan_reviews[]` record:

- `id`
- `lens`: `aperture` or `execution-readiness`
- `status`: `accepted`, `rejected`, `failed`, or `stale`
- `feedback`
- `findings[]`
- `reviewed_target_plan_id`
- `reviewed_revision`
- `source`
- `revised_after_review`

For each finding, require:

- `id`
- `severity`: `blocking`, `important`, or `polish`
- `problem`: what fails
- `required_revision`: smallest plan/payload change, or target restructure
- `supporting_evidence`: plan heading, payload path, source/test path, command, or trace

Aperture reviews also require:

- `aperture_classification`: `right-sized`, `too-narrow`, `too-broad`, `stale`, or `unclear`
- `revision_decision`: `keep`, `merge-required`, `split-required`, `rescope-required`, `refresh-intention`, or `needs-user-input`
- `scores`: all seven aperture scores

Reject vague findings. "This seems underspecified" is not actionable unless the reviewer names the execution or verification failure.

## What NOT to Include

- **Expected answer.** "Confirm this is right-sized" creates bias. Ask what makes the target too broad or too narrow.
- **Prior findings in first pass.** First reviewers work independently. Later reviewers get prior findings as explored territory.
- **"Verify that X works."** Ask "what is wrong with X?"
- **Preferred fix.** Give constraints and artifacts, not the conclusion.
- **Overbroad scope.** Name the target, artifacts, paths, rows, branches, and invariants.

## Lens Library

Use distinct lenses. Do not ask every reviewer to inspect everything.

### Aperture

- Product signal is smallest meaningful unit.
- Same-signal work is included; independent signals are deferred.
- Target is not schema/plumbing-only when integration is required.
- Parent uncertainty reduction is meaningful.
- Scenario matrix matches included/deferred branches.
- Verification aperture matches blast radius.

### Execution Readiness

- Plan removes product, contract, state, failure, persistence, and verification decisions.
- Public APIs, schema fields, prompts, files, and user-visible literals are exact where needed.
- Branch rows have observable expected outcomes.
- Stale-result, cancellation, rollback, and error behavior are specified when relevant.
- Verification commands prove the claimed behavior, not just plumbing.

### Contract and Boundary

- Produced values trace to consumers.
- New enum/object/payload variants have routing/handler coverage.
- Persistence readers and writers agree.
- Cross-language or process boundaries have exact literals and validation.
- Invalid states are rejected or impossible.

### Test Proof

- Tests would fail on the likely bug.
- Negative cases, edge values, ordering, and absence-of-behavior are covered when relevant.
- Assertions prove behavior, not existence or call plumbing.
- Manual/e2e checks name expected observable outcomes.

### Architecture and Maintainability

- Work lands in the canonical owner.
- Plan avoids scattered special cases and thin abstractions.
- Existing helpers/conventions are reused.
- Simpler target/model would delete branches or uncertainty.
- Scope boundaries are explicit enough for executor handoff.

### Trust, Authority, and Safety

- Security/privacy/irreversible paths have authority and rollback decisions.
- Operator-facing docs or migration notes are included when behavior changes.
- Logs/errors/telemetry avoid sensitive leakage.
- External dependencies and manual authorities are explicit.

## Scaling Reviewer Count

| Target surface | Gate reviewers | Additional reviewers |
|---|---:|---|
| Light local/doc | 2 gate reviews, local only if justified | 0 |
| Standard code/behavior | 2 gate reviews | 0-1 targeted lens |
| Trust-heavy/cross-subsystem | 2 gate reviews | 1-3 domain/authority/test-proof lenses |

More reviewers are not automatically better. Add reviewers only for orthogonal risk.

## Fix Validation Follow-Up

When a reviewer finds a real issue and you revise the plan, follow up with that same reviewer by IRC.

Ask narrowly:

> You found [finding]. I revised [plan/payload paths] by [summary]. Please validate whether this specific finding is resolved. Do not re-review the whole plan unless the fix creates a directly related issue.

Fresh reviewers in later passes do not validate earlier fixes. They search for new, independent, deeper, or newly visible issues.

## Per-Pass Guidance

### Pass 1: Gate Reviews

Run aperture and execution-readiness reviews. Each reviewer gets exact artifacts and a distinct lens.

Example opener:

> You are reviewing target plan [target title] for aperture. Read [plan path], [payload path], and [source/test paths]. Ask what makes this target too broad, too narrow, or untruthful. Check same-signal bundling, deferred work, scenario rows, target-unit rules, blast radius, and parent uncertainty reduction. Return one `target_plan_reviews[]` record. Report only real blockers or important gaps.

### Pass 2: Depth Reviews

Use only when the target is standard/trust-heavy or reviewers surfaced material uncertainty. Provide prior findings as explored territory, not as validation instructions.

Example opener:

> Fresh independent review of target plan [target title] for [lens]. Previous findings: [list]. Treat them as explored territory, not proof the plan is correct. What new, independent, deeper, or newly visible issue remains?

### Pass 3: Convergence Review

Use one targeted reviewer to falsify the riskiest remaining assumption.

Example opener:

> Final convergence review of [target title]. Falsify these assumptions: [A], [B], [C]. Trace the exact plan/payload/source paths. Report only real blockers or important gaps. If none remain, say what evidence you checked.

## Bad Prompt / Good Prompt Examples

Bad:

> Review this target plan.

Good:

> Review target plan `local://goal-1-target-1-plan.md` and payload `local://goal-1-target-1-plan.payload.json` for execution readiness. Trace rows `row-happy` and `row-error` to planned verification commands and expected outcomes. Flag only missing contracts, weak oracles, stale/failure ambiguity, or executor decisions left open. Return one `target_plan_reviews[]` record.

Bad:

> Verify the aperture is right-sized.

Good:

> What makes this aperture too broad or too narrow? Check same-signal work, deferred work, target-unit rules, blast radius, and whether parent uncertainty reduction is meaningful.
