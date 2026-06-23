# Assessing Plan Review Findings

How to triage target-plan reviewer output: what to revise, restructure, document, reject, defer, or fail.

Reviewer output is raw signal. The orchestrator owns judgment.

## Finding Decisions

Every reviewer item must become exactly one of these:

- **Revise plan/payload now** — real aperture, contract, state, verification, or failure-semantics gap.
- **Restructure target** — finding proves the target is too broad, too narrow, or wrong-shaped.
- **Document accepted simplification** — scope is intentionally narrower and executor/maintainer must see the boundary.
- **Reject as noise** — unsupported concern, schema churn, style preference, or feature request.
- **Defer as parent/future work** — real issue outside this target's primary signal.
- **Fail target planning** — needs user authority, external authority, unavailable reviewer/tool, or no right-sized target.
- **Re-prompt** — output is vague, confirmatory, nit-heavy, or lacks evidence.

Do not revise the plan before classifying the finding.

## Severity Classification

Severity is about consequence, not reviewer tone.

### Blocking

Approval/execution would be unsafe, untruthful, or impossible.

Examples:

- target is too broad or too narrow
- same-signal required work is excluded
- execution plan leaves product/contract/state/failure decision open
- verification cannot prove the claim
- payload references wrong target/revision/source
- trust-heavy authority, privacy, migration, rollback, or security decision is missing

Action: revise, restructure, or fail before submission.

### Important

Plan likely executes but leaves material ambiguity or weak evidence.

Examples:

- branch outcome underspecified
- test command lacks expected signal
- accepted simplification is not visible to executor
- source metadata is incomplete for non-light plan
- payload and Markdown disagree on executor-visible semantics

Action: revise, document, or justify before submission.

### Polish

Useful refinement with no approval-blocking consequence.

Examples:

- wording clarity
- redundant payload explanation
- optional reviewer evidence improvement for low-risk local work

Action: skip unless it improves executor correctness.

## Confidence Classification

Confidence determines how much grounding you need before acting.

### High Confidence

- Reviewer cites exact plan heading, payload path, source/test path, or command.
- Failure mode and consequence are concrete.
- You can trace the execution or verification gap directly.

Action: revise or restructure.

### Medium Confidence

- Risk is plausible but evidence is incomplete.
- Reviewer names the right area but not the exact failure.

Action: inspect artifacts/source yourself before revising.

### Low Confidence

- Vague concern, preference, speculation, or unsupported architecture claim.
- No concrete approval, execution, verification, or product-truth failure.

Action: reject, or re-prompt if the lens was important.

## Fix Validation Status

For every fixed finding, track:

- **original reviewer** — who found it
- **finding** — the concrete issue
- **revision summary** — plan/payload/source changes
- **validation status** — pending / validated / disputed / unavailable
- **evidence** — reviewer validation, lint, trace, test, or orchestrator assessment

When the original reviewer is available, ask by IRC to validate their specific finding. Keep the request narrow: whether the finding is resolved, whether the fix creates a directly related issue, and what evidence they checked.

Do not use fresh next-pass reviewers as fix validators. Their job is new discovery.

If the original reviewer is unavailable, validate by trace/lint/test yourself and mark reviewer validation unavailable. Do not invent validation.

## Triage Questions

For each finding, ask:

- **Would this make the target claim untruthful?** Revise or restructure.
- **Would executor still need to decide product/contract/state/failure behavior?** Revise.
- **Would verification pass while behavior is wrong?** Strengthen verification.
- **Would payload and Markdown send different instructions?** Repair agreement.
- **Does this prove the target is wrong-sized?** Restructure target or fail.
- **Does this demand broader scope than the target claim?** Defer or restructure.
- **Is source metadata real and current?** Fix evidence, or reject fabricated/unavailable evidence.
- **Is the reviewer asking for a feature?** Evaluate independently; not a finding.
- **Are two reviewers saying the same thing?** Fix once; note lens overlap.
- **Would a future executor violate this without being told?** Make the constraint explicit.

## When to Restructure Instead of Patch

Choose target restructuring when:

- aperture finding requires adding unrelated primary signals
- same-signal work is split across multiple targets
- verification cannot be meaningful at current slice
- plan needs many local exceptions to stay coherent
- reviewer findings cluster around target boundary, not wording
- branch rows expose the wrong product unit
- target must be merged/split/rescoped to make truth testable

Do not patch a wrong aperture. Change the target shape.

## When Findings Conflict

If reviewers contradict each other, one misunderstands the target, artifacts, or product boundary. Do not average their opinions.

Read the plan, payload, source, and tests yourself. Trace the primary signal and verification path. The reviewer with the concrete trace is usually right.

## Interpreting Accepted Reviews

- **Gate pass with no evidence**: not acceptable. Ask for concrete trace or re-prompt.
- **Aperture accepted but scores missing/low**: not approval-ready.
- **Execution accepted with blocking/important findings**: contradiction; treat as rejected.
- **Accepted after plan edits**: stale unless original reviewer validated the fix or fresh review reran.
- **Local-only source on heavy plan**: insufficient unless task/reviewer unavailability is explicitly justified.

## Acceptable Simplifications

Some targets intentionally close a smaller product truth than the future design.

Common acceptable simplifications:

- one backend path while UI remains deferred
- unit/integration proof while e2e remains parent scope
- local-only storage behavior behind a future migration seam
- explicit omission of unrelated provider/platform variants
- manual check instead of automated proof for operator-only behavior

The key: document the boundary in the plan/payload where the executor will see it. Undocumented simplification is latent scope drift.

## Red Flags in Reviewer Output

- **All schema nits, no product-truth issue.** Prompt caused lint churn.
- **Finding lacks path/branch/command.** Evidence is insufficient.
- **Reviewer confirms expected answer.** Prompt was biased.
- **Reviewer asks for extra feature.** Not a finding.
- **Reviewer contradicts explicit target boundary.** Check whether boundary is justified.
- **Reviewer suggests complexity without failure mode.** Reject.
- **Reviewer validates whole plan instead of their finding.** Narrow follow-up.
