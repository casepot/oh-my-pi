# Uncertainty-Aware Continuation

## Product direction

### Thesis

Continuation quality depends on three separable capabilities:

1. **State transfer** — preserve what happened.
2. **Uncertainty management** — preserve what remains unsettled.
3. **Independent feedback** — challenge chosen interpretations with evidence not derived from same choice.

Current context systems optimize mostly state transfer:

- raw history;
- compaction;
- summaries;
- manifests;
- artifact-backed elision;
- retrieval.

Missing layer: decision state.

```text
known
assumed
uncertain
conflicted
unverified
reversible
high-impact
```

Product opportunity: **Decision & Evidence Layer** embedded in checkpoint, continuation, tool, verification, finalization flows.

Not universal contract compiler. Not more prompt boilerplate. Not generic critic on every turn.

Goal: preserve uncertainty until resolved; focus challenge where wrong assumptions create expensive architecture, behavior, side effects, or claims.

---

## Evidence motivating direction

### Directly observed in Bloomberg continuation experiment

- 20/20 agents planned before editing.
- 20/20 reused existing architecture.
- 20/20 wrote focused tests.
- 20/20 passed regression/static gates.
- Context ranged 25k–54k first-prompt tokens.
- Treatment explained approximately 9% hidden-score variance.
- 16/20 selected one plausible schema-file interpretation; hidden evaluator selected another.
- Implementations usually preceded tests; tests then encoded same interpretation.
- Repeated green checks increased confidence without independently challenging boundary choice.
- More context did not resolve boundary never previously settled.
- More verification commands did not guarantee broader behavioral coverage.
- High-scoring implementations existed under raw, Shake, report-plus-manifest.
- Manifest artifact pointers received no explicit reads.
- Final answers accurately reported visible checks, then generalized to categorical “end to end” completion.

### Narrow conclusion

For this task: disputed boundary + independent acceptance evidence likely higher leverage than additional history or test repetition.

### General hypothesis

Across continuation tasks, failure often arises from:

```text
plausible interpretation
→ implementation commitment
→ endogenous evidence
→ false closure
```

General intervention:

```text
make uncertainty explicit
→ expose alternatives + consequences
→ obtain independent evidence
→ calibrate closure
```

Requires cross-task validation. Current evidence: motivating case, not universal proof.

---

## Problem model

### State transfer answers

- What changed?
- Which files/symbols?
- Which decisions?
- Which commands passed?
- What remains?
- Where is raw evidence?

### Uncertainty management answers

- Which claims settled versus provisional?
- Which decisions inherited versus newly required?
- Which interpretations compete?
- Which sources disagree?
- Which assumptions high-impact or irreversible?
- Which behavior never exercised?
- Which evidence stale after workspace changes?

### Independent feedback answers

- What could falsify current interpretation?
- Did evidence predate implementation?
- Did test fixture come from same assumption?
- Do callers/runtime/examples agree?
- Did another agent or human independently inspect boundary?
- Does top-level behavior match local unit behavior?

Conflating layers causes predictable errors:

- report treats assumption as fact;
- manifest proves activity, not behavior;
- self-authored tests prove internal consistency, not external correctness;
- more context preserves unresolved ambiguity;
- completion language exceeds evidence.

---

## Core product primitive: Decision & Evidence Ledger

Versioned, compact, machine-readable, model-visible, operator-inspectable.

```yaml
facts:
  - claim: request workflow validates before adapter mutation
    provenance:
      - src/request_workflow.py:execute_transient_request
      - test_invalid_body_zero_mutation
    freshness: workspace-hash
    confidence: observed

open_questions:
  - question: exact serialized format accepted by --schema-file
    alternatives:
      - normalized-operation serialization
      - generated request JSON Schema
      - schema-command envelope
    evidence:
      normalized:
        - NormalizedOperation.to_json exists
      json_schema:
        - operation_input_schema exists
      spec:
        - wording permits serialized/discovered schema
    impact:
      - CLI compatibility
      - offline validation
      - test fixtures
    reversibility: medium

assumptions:
  - claim: support generated JSON Schema
    status: provisional
    chosen_because:
      - evaluator fixture
      - existing producer
    rejected:
      - normalized-only because caller contract unresolved

verification:
  - claim: invalid send causes zero adapter mutation
    status: passed
    evidence: test_invalid_send_never_mutates_adapter
    independence: preexisting-black-box

unverified:
  - claim: top-level main emits one JSON document on error
    severity: required
```

### Required semantics

#### Fact

Observed or authoritative claim. Must include provenance/freshness.

#### Open question

Material uncertainty. Must not silently collapse into fact during summary.

#### Assumption

Chosen interpretation under uncertainty. Includes alternatives, evidence, impact, reversibility.

#### Conflict

Sources disagree. Product displays disagreement; does not synthesize false certainty.

#### Verification

Claim + status + evidence + independence class.

#### Unverified risk

Important behavior lacking evidence. Persists through checkpoint/finalization.

---

## Evidence independence

Not all green checks equal.

### Evidence classes

1. **Endogenous**
   - test/fixture written after implementation by same trajectory;
   - mocks shaped like implementation;
   - assertion derived from selected representation.

2. **Repository-preexisting**
   - tests/callers/examples predating change;
   - historical snapshots;
   - compatibility fixtures.

3. **Differential**
   - old versus new implementation;
   - two plausible interpretations;
   - alternative provider/runtime;
   - property/invariant comparison.

4. **External/runtime**
   - real service;
   - black-box process behavior;
   - integration environment;
   - independent evaluator.

5. **Independent reviewer**
   - separate agent/human sees requirement and artifact without implementation narrative.

Ledger records evidence class. Finalization distinguishes internal consistency from independent confirmation.

No implication endogenous tests useless. They protect implementation. They simply should not close ambiguous boundary alone.

---

## Risk-triggered challenge

Challenge every decision → noise, latency, paralysis.

Challenge high-impact uncertain decisions.

### Trigger candidates

- public API/CLI/protocol behavior;
- serialized data or schema format;
- database migration or irreversible state;
- security/auth/policy boundary;
- side-effect ordering;
- compatibility surface;
- architecture ownership unclear;
- multiple plausible representations found;
- new domain constructor in presentation layer;
- self-authored fixture mirrors new implementation;
- high branch fan-out;
- final claim lacks top-level evidence;
- source conflict;
- low reversibility + medium/low confidence.

### Challenge actions

Choose cheapest discriminating action:

1. inspect existing callers;
2. inspect producer/consumer pair;
3. run preexisting test/example;
4. construct counterexample from alternative interpretation;
5. differential test;
6. black-box process probe;
7. targeted artifact retrieval;
8. independent sub-agent review;
9. ask operator when material ambiguity remains;
10. choose reversible multi-format support when cost acceptable.

Product value: select challenge, not merely request “more tests.”

---

## No-spec repositories

Formal specification optional.

Potential evidence sources:

- current callers;
- types/interfaces;
- existing tests;
- runtime behavior;
- fixtures/examples;
- snapshots/golden outputs;
- repository conventions;
- version history;
- logs/incidents;
- user instructions;
- operator decisions.

### Source disagreement

Do not invent authority ranking silently.

```text
caller behavior ≠ tests
runtime ≠ docs
types ≠ fixtures
user request ≠ compatibility
```

Ledger records conflict. Agent selects reversible default, gathers evidence, or asks operator.

### Greenfield work

Little historical evidence. Ledger focuses:

- user-visible commitments;
- irreversible choices;
- data/security boundaries;
- prototype-only assumptions;
- decisions safe to defer;
- alternatives preserved.

### Debugging

Ledger becomes hypothesis map:

```text
symptom
candidate causes
supporting/contradicting evidence
next discriminating probe
```

### Research

Ledger becomes evidence map:

```text
known findings
source quality
competing explanations
unresolved questions
next experiment
```

Same primitive; task-specific rendering.

---

## Checkpoint integration

Current checkpoint payloads:

- report: semantic state;
- manifest: provenance/state;
- raw artifact: recoverability;
- Shake placeholders: chronology-preserving elision.

Add ledger as independent durable object.

```text
checkpoint
├── semantic report
├── provenance manifest
├── decision & evidence ledger
├── targeted evidence index
└── raw trajectory artifact
```

### Why independent object

Natural-language report compresses toward conclusions. Open uncertainty easily disappears.

Manifest records actions, not epistemic status.

Ledger must survive:

- raw keep;
- semantic seal;
- Shake;
- rewind/branch;
- sub-agent handoff;
- later reseal.

### Seal rules

Must preserve:

- open questions;
- assumption alternatives;
- conflicts;
- unverified high-severity claims;
- evidence references;
- freshness hashes.

May compress:

- resolved low-impact deliberation;
- duplicate evidence;
- superseded alternatives with reason preserved.

Never promote assumption → fact because report omitted uncertainty marker.

---

## Continuation UX

### Start

Small state panel:

```text
Settled facts       12
Open questions       3
Active assumptions   2
Source conflicts     1
High-risk unverified 2
Stale anchors        0
```

Show salient items only. Full ledger expandable.

### Plan

Plan items bind to:

- open question resolved;
- assumption tested;
- contract behavior implemented;
- evidence required;
- risk accepted.

Avoid activity-only plan:

```text
bad: add tests
better: independently exercise all body-source modes through top-level CLI
```

### Edit

Contextual warning, not hard prohibition:

```text
New NormalizedOperation constructor in cli.py
Canonical owner uncertain
Existing producers:
- operation_input_schema
- NormalizedOperation.to_json
Open question: --schema-file format
```

### Verify

Coverage view:

```text
passed      preexisting behavior
passed      self-authored unit behavior
failed      black-box process case
unverified  side-effect ordering
conflict    spec vs evaluator sentinel
```

### Finalize

Evidence-derived sections:

- Observed working;
- Assumptions still active;
- Not exercised;
- Conflicts;
- Known failures;
- Architecture changed.

Reserve “end to end” for top-level evidence across required path.

---

## Optional specialized modules

Decision & Evidence Layer general. Domain modules optional.

### Contract module

For CLI/API/protocol/schema-rich systems:

- executable behavior matrix;
- generated probes;
- source-to-requirement links;
- conflict detection.

### Architecture module

- canonical symbol ownership;
- producer/consumer map;
- duplicate-domain-constructor warning;
- content-addressed anchors.

### Migration module

- compatibility invariants;
- reversible/irreversible steps;
- data validation;
- rollback evidence.

### Debugging module

- competing hypotheses;
- evidence updates;
- falsifying probes;
- confidence changes.

### Research module

- claim/source graph;
- source independence;
- contradiction map;
- next experiments.

Do not force contract vocabulary onto every task.

---

## Product principles

1. **Preserve uncertainty, not only conclusions.**
2. **Evidence must carry provenance and freshness.**
3. **Independent challenge beats test repetition.**
4. **Risk-triggered intervention beats ambient nagging.**
5. **Operator sees same decision state as model.**
6. **Conflicts remain conflicts until resolved.**
7. **Reversible choices require less ceremony.**
8. **High-impact irreversible assumptions require stronger evidence.**
9. **Completion language derives from evidence coverage.**
10. **Context optimization remains separate from decision quality.**

---

## Non-goals

- formalize every repository;
- replace human product decisions;
- ask operator about every ambiguity;
- run critic agent every turn;
- generate maximal test matrices;
- treat codebase behavior as automatically authoritative;
- convert assumptions into fake certainty;
- block reversible experimentation;
- optimize solely for fewer tokens;
- claim current Bloomberg result generalizes.

---

## Research program

### Primary question

Does explicit uncertainty + independent challenge improve continuation quality across task types without unacceptable cost/latency?

### Core experiment

Treatments:

```text
A. semantic report
B. report + provenance manifest
C. report + decision/evidence ledger
D. report + ledger + risk-triggered independent challenge
```

Tasks:

- debugging with competing causes;
- migration with compatibility ambiguity;
- feature work without formal spec;
- API/CLI work with formal spec;
- greenfield design with irreversible choices;
- research with conflicting sources.

Nested design:

```text
multiple tasks
× multiple independently generated handoffs
× multiple continuations per handoff
```

### Primary outcomes

- task-specific quality floor;
- severe defect rate;
- unsupported assumption count;
- assumption detection precision/recall;
- independently verified claims;
- completion calibration;
- end-to-end cost/latency;
- operator interventions;
- decision reversals/rework;
- context growth/retrieval.

### Mechanism outcomes

- open questions preserved through seal;
- assumptions surfaced before implementation;
- alternative interpretations considered;
- challenge action selected;
- independent evidence changed implementation;
- stale/conflicting evidence detected;
- final claims narrowed appropriately.

### Key ablations

1. ledger without challenge;
2. challenge without ledger;
3. always-on versus risk-triggered challenge;
4. self-authored versus independent probes;
5. opaque versus question-targeted artifact pointers;
6. human-curated versus automatically inferred ledger;
7. spec-rich versus spec-poor tasks;
8. raw versus semantic state transfer under same ledger.

### Stop conditions

Reject direction if:

- ledger becomes stale noise;
- assumption detection floods false positives;
- agents ignore ledger;
- challenge adds cost without changing decisions;
- operator burden rises materially;
- completion calibration improves but task quality does not;
- benefit exists only in spec-heavy CLI tasks.

---

## Instrumentation

Canonical records:

### Decision event

```yaml
id: decision-42
question: schema-file representation
alternatives: [normalized, json-schema, envelope]
selected: json-schema
evidence_ids: [e17, e22]
confidence: medium
impact: high
reversibility: medium
```

### Evidence event

```yaml
id: e22
source: existing-caller
location: src/schema_command.py
claim: producer emits Draft JSON Schema
freshness: workspace-hash
independence: repository-preexisting
```

### Challenge event

```yaml
trigger: high-impact ambiguity
method: differential fixture
result: normalized-only fails existing producer output
changed_decision: true
cost: tokens/time/tools
```

### Finalization event

```yaml
claim: request CLI works end to end
status: rejected
reason: top-level error path unverified
suggested_claim: validate/send dispatch paths verified; main error path untested
```

Metrics and report generation consume events, not reconstructed prose.

---

## Product sequence

### Stage 0 — Measurement

- capture decision/assumption/evidence events manually or via explicit agent tool;
- measure current uncertainty loss through checkpointing;
- classify final defects by unresolved assumptions;
- no automatic interventions.

### Stage 1 — Ledger

- add checkpoint ledger object;
- surface facts/open questions/assumptions/conflicts/unverified risks;
- content-address evidence anchors;
- operator inspection/editing;
- finalization summary from ledger.

### Stage 2 — Risk detection

- detect high-impact ambiguity using change surface + source disagreement + reversibility;
- suggest grounding action;
- track false positives and ignored suggestions.

### Stage 3 — Independent challenge

- targeted counterexample/probe/reviewer;
- evidence independence label;
- intervention only at selected decision points;
- cost caps.

### Stage 4 — Adaptive policy

- learn when ledger/challenge helps from multi-task data;
- default silent when uncertainty low;
- escalate when impact high;
- preserve operator control.

Do not start with automatic contract generation.

---

## Immediate design recommendation

Explore **Decision & Evidence Layer**, not “checkpoint contract compiler.”

First prototype:

1. checkpoint report gains explicit `open_questions`, `assumptions`, `conflicts`, `unverified` fields;
2. manifest references evidence with source/freshness/independence metadata;
3. continuation UI shows only high-impact unresolved items;
4. finalization emits evidence-calibrated status;
5. optional manual challenge action targets one selected assumption;
6. multi-task experiment tests ledger and challenge separately.

Success criterion:

```text
fewer severe assumption-driven defects
without unacceptable operator burden, cost, or latency
```

Token reduction remains valuable but orthogonal:

```text
context system: what model can see
Decision & Evidence Layer: what model knows, assumes, doubts, and has independently established
```

---

## Decision

Pursue research/prototype direction.

Confidence:

- high: state transfer alone insufficient for unresolved decisions;
- medium: explicit uncertainty ledger improves continuation calibration;
- medium-low: automated risk-triggered challenge improves task quality broadly;
- unknown: net value outside engineering tasks;
- unknown: best balance between automatic inference and explicit agent/operator input.

Next evidence needed:

1. multi-task baseline of assumption-driven continuation defects;
2. ledger preservation fidelity through raw/report/Shake/reseal;
3. independent challenge intervention effect;
4. operator burden and false-positive rate;
5. behavior in repositories without specifications.
