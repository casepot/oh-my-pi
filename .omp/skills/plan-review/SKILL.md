---
name: plan-review
description: Orchestrate code-review-style planning-mode target-plan reviews before `submit_target_plan`. Produces explicit review evidence for deterministic approval gates.
---

# Plan Review

Use before submitting any non-trivial goal target plan.

The goal is not to collect review records. The goal is to make the plan decision-complete, right-sized, executable, and backed by evidence.

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` mean `MUST NOT` and `SHOULD NOT`.
</system-conventions>

<critical>
- You are the orchestrator. Reviewers report; you decide.
- You MUST use planning-mode read-only reviewers when available.
- You MUST apply code-review criteria to plan artifacts.
- You NEVER fabricate review evidence, agent ids, artifacts, or validation replies.
- You NEVER use fresh reviewers to validate prior fixes.
</critical>

## Workflow

1. Run `goal({op:"get"})` and `goal({op:"target_plan_schema"})`.
2. Draft plan Markdown + payload JSON.
3. Run aperture review:
   - lens: right-sized target/product signal;
   - files: plan Markdown, payload JSON, relevant source/test/docs;
   - questions: same-signal bundling, independent deferrals, scenario matrix, target-unit rules, blast radius, parent uncertainty reduction;
   - Open `references/prompting-reviewers.md`.
   - output: one `target_plan_reviews[]` record with `lens:"aperture"`.
4. Run execution-readiness review:
   - lens: decision completeness;
   - files: plan Markdown, payload JSON, relevant source/test/docs;
   - questions: product behavior, public contracts, state/failure/stale behavior, branch oracles, verification commands;
   - output: one `target_plan_reviews[]` record with `lens:"execution-readiness"`.
   - Open `references/prompting-reviewers.md`.
5. Trust-heavy/cross-subsystem? Run additional fresh reviewers for domain invariants, authority/privacy, test proof, or maintainability.
6. Triage every finding: fix now, restructure, document accepted simplification, reject noise, defer pre-existing, or re-prompt.
   - Open `references/assessing-findings.md`.
7. After fixes, ask the original reviewer by IRC to validate only their finding.
8. Fresh convergence reviewers search for new issues; they do not validate old fixes.
9. Write final `target_plan_reviews` into the payload.
10. Lint; fix diagnostics; submit only when current gate reviews are accepted and unrevised.
11. Rubber stamp, lint churn, shallow pass, stale evidence, or reviewer theater? Open `references/anti-patterns.md`.

## Review criteria

Report a finding only when ALL conditions hold:

- Provable impact: identify the execution, approval, verification, or product-truth failure.
- Actionable: name the discrete plan/payload revision.
- Unintentional: not an explicit scope tradeoff.
- Current-artifact introduced: exists in this plan/payload revision.
- No unstated assumptions: cite plan/payload/source evidence.
- Proportionate rigor: demand no precision absent from adjacent plans/code.

For cross-boundary plan claims:

1. Locate producer: file, API, state, command, schema, prompt, or payload field.
2. Locate consumer: router, handler, verifier, test, persistence reader, or operator surface.
3. Missing consumer branch, oracle, or failure path? Report.

Findings MUST be anchored to an exact plan heading, payload path, or source/test path.

Severity mapping:

- `blocking`: approval/execution would be unsafe or untruthful.
- `important`: plan likely executes but leaves material ambiguity.
- `polish`: useful refinement; not approval-blocking.

## Reviewer prompt contract

Every reviewer prompt MUST name:

- lens;
- exact files/URIs;
- concrete questions;
- quality bar;
- output schema;
- exclusions.

Ask what is wrong. NEVER ask reviewers to confirm your expected answer.

## Gate review output

Return one record:

- `id`
- `lens`
- `status`
- `feedback`
- aperture only: `aperture_classification`, `revision_decision`, `scores`
- `findings[]`: `id`, `severity`, `problem`, `required_revision`, `supporting_evidence?`
- `reviewed_target_plan_id`
- `reviewed_revision`
- `source`
- `revised_after_review`

## Acceptance bar

Approval evidence requires:

- aperture review accepted;
- aperture classification `right-sized`;
- all aperture scores ≥ 3;
- execution-readiness review accepted;
- no blocking/important findings;
- no accepted gate review marked `revised_after_review:true`;
- plan/payload lint passed;
- Markdown/payload agree on executor-visible semantics.

## Reference Triggers

When a trigger applies, you MUST read that reference before continuing.

- Writing a reviewer prompt → read `references/prompting-reviewers.md`.
- Triaging reviewer findings → read `references/assessing-findings.md`.
- Rubber stamps, lint churn, shallow passes, stale evidence, reviewer theater, or false convergence → read `references/anti-patterns.md`.

## References

- `references/prompting-reviewers.md` — prompt structure, output contract, lens definitions, pass guidance.
- `references/assessing-findings.md` — severity, confidence, triage decisions, target restructuring, validation status.
- `references/anti-patterns.md` — plan-review failure modes with causes and remedies.

<critical>
- Keep going until the plan is decision-complete or formally failed.
- Review silence is not evidence. Evidence names files, lines, branches, or artifacts.
</critical>
