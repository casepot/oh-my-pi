# Agent Brief: Uncertainty-Aware Continuation

We want to explore a Decision & Evidence Layer for OMP checkpointing: preserve not only what happened, but what remains uncertain, assumed, conflicted, or unverified.

This direction is a product hypothesis motivated by one Bloomberg continuation experiment. Treat it as something to test, not settled architecture.

## Start with the exploration

Read:

- `docs/execution-plans/checkpoint-seal-bloomberg/README.md`
- `context-span-checkpoints.md`
- `results.md`
- `quantitative-analysis.md`
- `qualitative-analysis.md`
- `product-direction.md`

Then inspect the current checkpoint, session, replay, manifest, RPC, TUI, prompt, and atomic-rewrite paths. Reuse existing lifecycle architecture rather than introducing a parallel state system.

## Product intent

Current context mechanisms mainly transfer state:

```text
raw history      detailed trajectory
summary          semantic state
manifest         provenance
Shake            chronology with payload elision
artifacts        recoverable evidence
```

The missing question is epistemic state:

```text
What is settled?
What remains open?
Which interpretation is only an assumption?
Which sources conflict?
What has independent evidence?
What important behavior remains unverified?
```

The broader hypothesis:

```text
explicit uncertainty
+ decision provenance
+ evidence independent of implementation
→ fewer severe assumption-driven continuation defects
```

The experiment does not yet establish that hypothesis across tasks.

## Plan before implementation

Create a durable plan at:

```text
docs/execution-plans/checkpoint-seal-bloomberg/implementation-plan.md
```

The plan should explain:

- current lifecycle and persistence architecture;
- where uncertainty disappears today;
- smallest useful vertical slice;
- proposed durable schema and versioning;
- integration with keep, rewind, summary seal, and Shake;
- replay, rollback, backward compatibility, and size/privacy behavior;
- model-visible and operator-visible presentation;
- measurement needed to evaluate the hypothesis;
- tests and migration strategy;
- later stages and explicit non-goals;
- unresolved design questions and rejected alternatives.

Use independent architecture/plan review if sub-agents are available. Resolve substantive blockers, then continue into implementation unless the active harness requires plan approval.

## First implementation slice

Aim for a reversible, measurable ledger—not automatic intelligence.

A likely model includes explicit entries equivalent to:

```text
Fact
Open question
Assumption
Conflict
Evidence
Unverified risk
```

Useful metadata may include:

```text
claim or question
status
provenance
freshness
alternatives
impact
reversibility
evidence references
evidence independence
resolution
```

Refine names and shape after inspecting repository conventions. Avoid fake confidence precision and silent promotion of assumptions into facts.

The slice should make ledger state:

- explicitly authorable;
- durably persisted;
- deterministic on replay;
- backward compatible with old sessions;
- protected from manual and automatic Shake maintenance;
- included in atomic rewrite/rollback behavior;
- compactly visible to the continuing model;
- inspectable through an existing operator/RPC/UI surface;
- measurable without changing model behavior invisibly.

Evidence references should reuse existing artifact infrastructure and, where known, distinguish sources such as:

```text
endogenous
repository-preexisting
differential
external runtime
independent review
operator
```

Do not claim evidence independence when provenance cannot establish it.

## Measurement

Record enough durable information to study:

- uncertainty preserved or lost through checkpoint operations;
- assumptions created, revised, resolved, or abandoned;
- evidence references used after continuation;
- conflicts surfaced;
- final claims that remain unsupported;
- operator interventions;
- context/token overhead;
- replay, migration, or parse failures.

Keep measurement versioned and behaviorally inert for the first stage.

## Finalization

Where existing architecture permits a lightweight, reversible presentation, help final output distinguish:

```text
Observed working
Assumptions still active
Not exercised
Conflicts
Known failures
Architecture changed
```

Do not build a hard completion gate merely to satisfy this prototype. First establish whether the state is useful and accurate.

## Preserve existing behavior

The work should not regress:

- raw continuation;
- rewind;
- keep;
- seal;
- manual and automatic Shake maintenance;
- todo/orchestration state;
- session replay;
- atomic rollback;
- provider-usage reset semantics;
- prompt loading and TUI sanitization.

Persistence should fail closed. A failed rewrite must not leave history, leaf/index, checkpoint, provider-usage, or ledger state partially committed.

## Validation

Test observable behavior rather than source shape. Cover at least:

- every ledger entry kind round-trips;
- sessions without ledger still replay;
- each checkpoint disposition preserves the intended ledger state;
- restart reconstructs identical active state;
- malformed data fails safely;
- failed atomic rewrite restores pre-operation state;
- evidence references remain explicit when artifacts are unavailable;
- serialization and ordering are deterministic;
- model-visible and operator-visible states agree;
- context overhead is measured.

Run focused tests and `bun check`. Update docs and changelog only after the vertical slice works.

## Keep later stages out of the first slice

Document, but do not implement yet:

- automatic uncertainty extraction;
- learned risk scoring;
- automatic contract generation;
- always-on critic agents;
- mandatory operator questions;
- adaptive sealing policy;
- automatic resealing;
- a new dashboard;
- broad cross-repository inference.

Do not run paid model/provider experiments without explicit approval after presenting protocol, pilot gate, stop conditions, and cost forecast.

## Research protocol

Prepare—but do not execute—a multi-task experiment comparing:

```text
A. semantic report
B. report + provenance manifest
C. report + decision/evidence ledger
D. report + ledger + explicit targeted challenge
```

Include tasks with and without formal specifications:

- debugging with competing causes;
- compatibility-sensitive migration;
- feature work with weak documentation;
- API/CLI work with a specification;
- greenfield irreversible choice;
- research with conflicting sources.

Use multiple independently generated handoffs and multiple continuations per handoff. Measure severe assumption-driven defects, quality floor, unsupported assumptions, independent evidence use, completion calibration, operator burden, cost, latency, and context growth.

Primary success criterion:

```text
fewer severe assumption-driven defects
without unacceptable operator burden, cost, or latency
```

## Deliverables

- reviewed implementation plan;
- first ledger vertical slice integrated through checkpoint lifecycle;
- persistence/replay/rollback and backward-compatibility tests;
- consistent model/operator visibility;
- versioned measurement events;
- focused verification and `bun check` results;
- accurate docs/changelog;
- unexecuted multi-task experiment protocol;
- clear separation between implemented behavior, later roadmap, and unresolved hypotheses.

Before finishing, report changed files and symbols, exact verification results, unresolved decisions, and whether any provider spend occurred. Do not present later-stage scaffolding as delivered behavior.
