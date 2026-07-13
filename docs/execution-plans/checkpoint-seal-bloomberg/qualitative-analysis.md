# Checkpoint Seal Bloomberg: Qualitative Trajectory and Code Analysis

Status: **sub-agent qualitative review of the 20 valid corrected continuations**

Quantitative analysis: `quantitative-analysis.md`

Product direction: `product-direction.md`

Experiment root: `/Users/case/experiments/checkpoint-seal-bloomberg-clean-v2-0.144.1-medium`

Reviewer evidence bundle: `analysis/qualitative-review-bundle.md`

## Reading convention

- `[OBSERVED]` identifies behavior, code, output, or experiment state directly present in artifacts.
- `[INFERENCE]` identifies an interpretation or causal hypothesis.

This report describes recorded actions and written code. It does not claim access to unrecorded private reasoning.

## Executive judgment

[INFERENCE] Taken together, the following observed behaviors are consistent with disciplined local maintenance:

- 20/20 scoped the task before editing;
- 20/20 inspected the CLI, registry, application boundary, or specification before implementation;
- 20/20 reused the existing Phase-1 body loader, validator, request executor, envelopes, and adapter/result types rather than replacing the request workflow;
- 20/20 added focused command tests;
- 20/20 finished with the offline suite, Ruff, basedpyright, and `ty` passing;
- visible failures were normally followed by targeted rereads, repairs, and reruns.

[INFERENCE] They were less reliable at matching the evaluator’s external CLI boundary:

- 16/20 accepted internal normalized-operation serialization for `--schema-file` but not the direct generated JSON Schema exercised by the hidden continuation evaluator; the checked-in specification does not unambiguously choose between those file dialects;
- six runs mishandled strict validation through either the wrong CLI surface or a success envelope around failed validation;
- five runs had validate-command metadata drift;
- one run opened the adapter before validation;
- one run returned process exit 0 for a structured error envelope;
- final answers routinely said “end to end” even when the exercised tests did not cover the external boundary completely.

[INFERENCE] The dominant problem was not insufficient planning, reading, effort, typing discipline, or test execution. It was **verification-oracle alignment**: agents wrote coherent code and tests for the contract they inferred, but that contract often differed from the evaluator at an underspecified serialized-schema boundary. Repeated green checks then reinforced the chosen interpretation.

[OBSERVED] The highest hidden-item scores occurred in three treatments:

- report + manifest run `000-428721eb…`: 20/21;
- scoped-Shake run `008-14a6714c…`: 20/21;
- raw run `018-3621b753…`: 20/21;
- scoped-Shake run `015-c3231ff0…`: 19/21.

[OBSERVED] All four directly pass an allowed `PolicyDecision(True)` on send rather than resolving real command/profile policy; the hidden score does not test that production requirement.

[INFERENCE] These are the most evaluator-aligned implementations, not necessarily the strongest production implementations. The item score overweights schema-dialect compatibility, does not cover all policy integration, and weights metadata and safety failures equally.

[OBSERVED] All 20 fail C12’s first assertion because they emit `server_accepted: null`, matching `BLOOMBERG_CLI_SPEC.md:668–669`, while the evaluator requires `"not_tested"`. C12 then checks an exact hash under `schema_hash`; workspaces expose `operation_schema_hash`, but short-circuiting means recorded verification cannot establish whether any run satisfies that second assertion.

[INFERENCE] Read 20/21 as “passed every hidden item outside C12,” not “passed every non-conflicted hidden case.” Split C12, reconcile the sentinel, and assess the hash separately.

## Evidence and review method

Eight parallel reviewer agents examined:

1. each raw trajectory;
2. each scoped-Shake trajectory;
3. each report-only trajectory;
4. each report-plus-manifest trajectory;
5. final code artifacts before treatment narratives;
6. hidden-contract failure clusters before treatment narratives;
7. causal identification and competing explanations;
8. maintainer behavior across all treatments.

The code reviewer inspected final patches/workspaces before transcripts to reduce narrative bias. The failure reviewer clustered hidden outcomes before reading treatment narratives. Only the 20 complete runs in `protocol.json` were included; invalid cwd/provider attempts were excluded.

Evidence sources:

- `runs/<id>/session-entries.json`;
- `runs/<id>/transcript.json` when populated;
- `runs/<id>/tool-events.json.gz`;
- `runs/<id>/final.patch`;
- `runs/<id>/final-workspace/`;
- `runs/<id>/verification.json`;
- treatment session artifacts;
- run-level and turn-level quantitative metrics.

[OBSERVED] Several valid runs have a three-byte `transcript.json` containing `[]`, while their complete trajectory remains in `session-entries.json`. Reviewers used session entries as the fallback. This is an artifact-export defect, not missing agent behavior.

## The behavioral skeleton shared by all treatments

[OBSERVED] The modal continuation sequence was:

```text
create continuation plan
→ inspect CLI / registry / spec / existing workflow
→ choose schema-file representation and command architecture
→ edit CLI, registry, mirrored build output, and focused tests
→ run focused tests
→ repair visible failures
→ run request-workflow tests
→ run offline suite
→ run Ruff, basedpyright, and ty
→ repair and repeat affected checks
→ report completion
```

[OBSERVED] Plans were specific rather than ceremonial. They normally separated:

- registry/dispatch inspection;
- validate and send wiring;
- adapter/stdin seams;
- policy and identity metadata;
- deterministic command tests;
- regression and static verification.

[INFERENCE] Context treatment changed how much repository state had to be reacquired, but did not change the learned maintainer ritual. Planning quality was nearly invariant.

### What they did well

[OBSERVED] Agents consistently preserved the intended architecture:

- `load_request_body` remained the body-source boundary;
- `validate_request_body` remained the validator;
- `execute_transient_request` remained the transport-independent executor;
- existing result, diagnostic, envelope, policy, and fake-adapter types were reused;
- no run created a second transport runner, schema hash implementation, result record, or envelope system;
- adapter and stdin injection seams were commonly exposed for deterministic tests.

[OBSERVED] Visible repair loops were generally disciplined. Agents reread stale or failing regions, made bounded changes, and reran the failing check plus broader checks. Tool errors were usually lint/type/test failures or edit-anchor failures—not random rewrites or provider instability.

[OBSERVED] Every final workspace was statically clean and regression-safe under the recorded evaluator.

### Where they were weak

[OBSERVED] The agents repeatedly created new schema deserializers at the presentation boundary. Eleven runs embedded recursive normalized-operation decoding directly in `cli.py`; five added reusable normalized decoders but did not accept the evaluator’s direct JSON Schema; four supported direct JSON Schema.

[INFERENCE] They understood the named architecture but lacked an unambiguous, executable boundary for:

```text
CLI --schema-file
→ accepted serialized shape
→ canonical loader
→ NormalizedOperation
```

[INFERENCE] They filled that gap with locally coherent but divergent glue.

[OBSERVED] Local tests often confirmed the implementation’s assumptions rather than discriminating between plausible contracts. Sixteen runs wrote `sample_reference_data_operation().to_json()`-shaped fixtures. The evaluator supplied a direct Draft 2020-12 JSON Schema produced by `operation_input_schema`.

[INFERENCE] The nearest observed discriminator was schema-contract alignment: the selected loader and its self-authored fixture encoded the same interpretation. Because implementation usually preceded test authoring, this study does not identify fixtures as the cause of the architecture choice. It shows that endogenous tests failed to challenge that choice.

## Code architecture taxonomy

### Family A — CLI-local direct JSON-Schema bridge

Runs:

- `000-428721eb…` report + manifest, 20/21;
- `008-14a6714c…` Shake, 20/21.

[OBSERVED] These runs convert a direct request JSON Schema into `NormalizedOperation`/`NormalizedElement`, then delegate to the Phase-1 workflow. Representative symbols:

- `_operation_from_json_schema`;
- `_element_from_json_schema`;
- `_schema_kind`.

[OBSERVED] Both runs passed every hidden item except conflicted C12. [INFERENCE] Their main maintainability cost is roughly a hundred lines of recursive schema-model conversion inside `cli.py`, which already owns parsing, dispatch, envelope mapping, and exit behavior.

### Family B — Dual-format CLI-local bridge

Run:

- `018-3621b753…` raw, 20/21.

[OBSERVED] `_operation_from_schema_file` accepts both normalized-operation serialization and direct JSON Schema.

[OBSERVED] This is the broadest compatibility behavior. It is also a large amount of decoding responsibility inside the CLI module.

### Family C — Schema-module inverse bridge

Run:

- `015-c3231ff0…` Shake, 19/21.

[OBSERVED] This run adds `operation_from_input_schema` next to the forward `operation_input_schema` generator in `schema/json_schema.py` and calls it from the CLI.

[INFERENCE] This is the strongest repository-boundary design in the sample: the inverse is typed, recursive, reusable, and colocated with the representation it decodes. [OBSERVED] Its only non-conflicted hidden miss was validate-command stdin metadata.

### Family D — Reusable normalized-serialization decoder

Runs:

- `004-539633fc…` raw, 16/21;
- `010-2f18899e…` report-only, 16/21;
- `012-f6407c8b…` raw, 16/21;
- `019-0c083369…` Shake, 12/21;
- `019-efc688ae…` Shake, 16/21.

[OBSERVED] These runs place `operation_from_json`, `normalized_operation_from_json`, or `NormalizedOperation.from_json` in `schema/normalized.py`.

[OBSERVED] These decoders do not accept the direct JSON Schema used by the evaluator. [INFERENCE] Their module factoring is better than CLI-local normalized decoding, but they still implement only one side of an underspecified file-dialect boundary.

### Family E — CLI-local normalized-serialization decoder

Runs:

- `001-2f89d23e…` Shake, 12/21;
- `002-d204c2fc…` report-only, 15/21;
- `003-22d2bbcd…` raw, 16/21;
- `005-22176f9c…` report-only, 12/21;
- `006-1b7c037a…` report + manifest, 15/21;
- `009-9ba88a9a…` raw, 16/21;
- `011-d5d974f2…` report + manifest, 16/21;
- `013-882980ea…` report-only, 15/21;
- `014-1b30c598…` report + manifest, 15/21;
- `016-5b22f00f…` report + manifest, 14/21;
- `017-d917f464…` report-only, 16/21.

[OBSERVED] This was the modal solution: independently written recursive decoding in `cli.py`, usually expecting `name`, `request`, `kind`, and `children` records. [INFERENCE] Repeated domain construction in the presentation module is the principal maintainability hotspot.

[OBSERVED] It systematically rejects the evaluator’s direct JSON Schema and often combines that mismatch with envelope, option, metadata, mutation-order, or exit-code defects.

## Run-level implementation assessment

Failure clusters:

- `S`: direct JSON Schema unsupported, causing three body-source cases plus successful `main()` to fail;
- `V/P`: strict/permissive semantics or CLI option surface wrong;
- `D`: command metadata wrong;
- `Z`: invalid input mutates adapter;
- `M−`: structured error returned with process exit 0;
- `C12`: visible-spec/evaluator sentinel conflict; omitted from the qualitative defect judgment below.

[INFERENCE] The final column combines observed code/failures with reviewer judgments about maintainability and product fidelity.

| Run | Treatment | Family | Hidden | Observable implementation judgment |
| --- | --- | --- | ---: | --- |
| `000-428…` | Manifest | A | 20 | Evaluator-aligned schema/error behavior; converter is CLI-local; send policy is hard-coded allow. |
| `001-2f8…` | Shake | E | 12 | Multiple surface defects: normalized-only schema, wrong validation-mode grammar, metadata drift. |
| `002-d20…` | Report | E | 15 | Coherent normalized-only implementation; genuine process-exit defect on structured errors. |
| `003-22d…` | Raw | E | 16 | Compact reuse; normalized-only schema and unconditional policy allow reduce product fidelity. |
| `004-539…` | Raw | D | 16 | Better parser boundary and good policy integration; wide patch surface; does not support the evaluator’s direct schema dialect. |
| `005-221…` | Report | E | 12 | Normalized-only schema plus wrong validation flags/metadata; extensive repair reinforced the chosen surface. |
| `006-1b7…` | Manifest | E | 15 | Normalized-only schema; failed strict validation is wrapped as success. |
| `008-14a…` | Shake | A | 20 | Evaluator-aligned schema/tests; converter is CLI-local; send policy is hard-coded allow. |
| `009-9ba…` | Raw | E | 16 | Compact unified dispatch; normalized-only schema and unconditional policy allow. |
| `010-2f1…` | Report | D | 16 | Clean reusable normalized decoder; does not support the evaluator’s direct schema dialect. |
| `011-d5d…` | Manifest | E | 16 | Clean handler/envelope behavior; does not support the evaluator’s direct schema dialect. |
| `012-f64…` | Raw | D | 16 | Strong profile-aware policy integration and reusable decoder; does not support the evaluator’s direct schema dialect. |
| `013-882…` | Report | E | 15 | Genuine safety defect: opens service before local validation. |
| `014-1b3…` | Manifest | E | 15 | Compact dispatch, but strict-invalid validation is returned as success; own test locks it in. |
| `015-c32…` | Shake | C | 19 | Best-factored schema architecture; validate metadata omits stdin support; send policy is hard-coded allow. |
| `016-5b2…` | Manifest | E | 14 | Normalized-only schema, strict-success envelope, and validate metadata omission. |
| `017-d91…` | Report | E | 16 | Good registry/policy/mutation behavior; does not support the evaluator’s direct schema dialect. |
| `018-362…` | Raw | B | 20 | Broadest schema compatibility; converter enlarges CLI; send policy is hard-coded allow. |
| `019-0c0…` | Shake | D | 12 | Reusable decoder but normalized-only schema and validation-mode/metadata defects. |
| `019-efc…` | Shake | D | 16 | Typed normalized-model boundary; direct evaluator schema unsupported; larger package surface. |

[OBSERVED] No two final `cli.py` files are byte-identical. Sixteen of 20 leave `request_workflow.py` byte-identical. The agents converged on the supplied application layer and diverged at the new CLI/schema boundary.

[OBSERVED] Every patch mirrors source changes into `build/lib/bloomberg_cli`. This follows the experiment workspace’s tracked build surface but doubles review area and creates drift risk.

## Hidden outcome as defect families

The 21 scalar items are not 21 independent behavioral dimensions.

### Universal C12 — evaluator/public-spec conflict

[OBSERVED] All 20 emit `server_accepted: null`, matching the checked-in public specification. Hidden C12 requires `"not_tested"` and then checks a schema-hash field.

[OBSERVED] The sentinel assertion fails first, masking whether the hash assertion would pass.

[INFERENCE] C12 should be excluded or sensitivity-tested in treatment comparisons until the specification and evaluator agree. It should be split into two tests.

### Schema dialect cluster — one choice counted four times

[OBSERVED] Sixteen runs fail C02, C03, C04, and C20 together because one schema loader rejects direct JSON Schema. The body loader itself normally succeeds; the failure occurs during schema reconstruction.

[INFERENCE] The scalar score overstates the number of independent defects in these runs. A defect-family score would count this as one high-severity integration mismatch.

### Validation-mode clusters

[OBSERVED] Runs `006`, `014`, and `016` detect strict invalidity but return a success envelope.

[OBSERVED] Runs `001`, `005`, and `019-0c` expose `--strict`/`--permissive` instead of `--validation-mode`, causing runtime and metadata failures together.

### Metadata drift

[OBSERVED] Runs `015` and `016` execute stdin body handling but advertise validate stdin as unsupported. This is discoverability drift rather than runtime failure in run `015`.

### Safety and process defects

[OBSERVED] Run `013` mutates the adapter before validation.

[OBSERVED] Run `002` returns process exit 0 after writing an error envelope.

[INFERENCE] These isolated defects are operationally more serious than several metadata assertions, but each receives one scalar point.

## Treatment narratives

### Raw history

[OBSERVED] Raw runs immediately used Phase-1 API names; four of five did not reread `request_workflow.py` before wiring it. Raw used the fewest reads on average, 11.2.

[OBSERVED] Four raw runs chose normalized-only schema parsing and plateaued at 16/21; run `018` chose dual-format parsing and reached 20/21.

[INFERENCE] Raw history preserved implementation continuity, but it also supported confident reuse at a new boundary without forcing exact specification grounding. Its main benefit was remembering completed internals, not discovering the new external schema contract.

### Scoped Shake

[OBSERVED] Every Shake source had 51 elided tool results and retained 120 messages. No valid Shake run read `artifact://22` or explicitly recovered any elided region.

[OBSERVED] Agents reconstructed state from current source and surviving chronology. Scores ranged 12–20. The two strongest runs read or used the canonical schema generator and normative request surface; the lower runs selected normalized serialization or the wrong validation-mode surface.

[INFERENCE] The task was recoverable without artifact restoration. There is no evidence that artifact recovery itself improved behavior, because recovery uptake was zero. The widest treatment variance came from new boundary choices, not observable missing-region recovery.

### Report only

[OBSERVED] All five report-only agents trusted the completed application boundary and reused it. All five then independently implemented normalized-only schema-file decoding and wrote normalized-operation fixtures. Mean reads were highest at 16.8.

[OBSERVED] All five tests asserted internal `server_accepted is None`, exactly following the report’s durable-context statement.

[INFERENCE] The report transferred internal architecture successfully but left the new external serialized boundary underspecified. Its emphasis on `NormalizedOperation` and internal `None` semantics plausibly anchored fixture choice and public translation.

### Report plus manifest

[OBSERVED] None of the five agents dereferenced `artifact://22`, quoted manifest counts, or explicitly used manifest failures as repair leads. First action remained plan plus glob/grep and broad repository rediscovery.

[OBSERVED] The manifest omitted `blp/fake.py` from changed paths despite the report naming a fake-adapter extension. Four runs still chose normalized-only schema decoding; one chose direct JSON Schema and reached 20/21.

[INFERENCE] There is no direct behavioral evidence that the 198-token manifest changed first action. Aggregate reductions in reads/calls/cost may reflect subtle confidence/provenance effects or continuation stochasticity. The current evidence pointer was too opaque and its facts too coarse to resolve the decisive schema-file question.

## Did the agents “think properly”?

### Process reasoning

[OBSERVED] Yes, generally:

- they decomposed the continuation;
- identified existing boundaries before editing;
- reused architecture rather than rewriting the core;
- formed explicit implementation and verification sequences;
- reacted to diagnostics;
- retained type discipline;
- reran focused and broad checks;
- produced concrete final evidence.

[INFERENCE] Their process was recognizably maintainer-like rather than trial-and-error code generation.

### Product reasoning

[INFERENCE] Product-boundary reasoning was mixed:

- most agents did not resolve the schema-file representation expected by the evaluator at an underspecified external boundary;
- test fixtures were often isomorphic to their implementation rather than independent challenges to it;
- several bypassed or simplified policy integration;
- one violated validate-before-mutation;
- one mishandled process exit status;
- completion summaries were broader than demonstrated coverage.

[INFERENCE] They reasoned well about local architecture and visible feedback, but inconsistently about ambiguous external boundaries and how to construct adversarial acceptance evidence.

### Code quality

[OBSERVED] The code was typed, statically clean, regression-safe, and usually internally coherent. [INFERENCE] It was not generally sloppy; the main quality issues were placement and contract choice:

- too much schema decoding in `cli.py`;
- repeated private constructors for an established domain model;
- internal serialization confused with external wire format;
- locally green tests built around the chosen implementation.

[INFERENCE] This is a specification-grounding and API-ownership problem more than a syntax, style, or basic engineering-competence problem.

## Verification behavior

[OBSERVED] Verification volume alone did not predict success:

- Shake run `008` reached 20 with six visible tool errors after implementing and testing the evaluator’s direct JSON-Schema case;
- manifest run `016` made 18 bash calls and scored 14 because it repeatedly verified an incomplete fixture/surface;
- raw run `018` reached 20 with fewer calls than the most expensive raw run;
- report-only run `010` reached 16 with a clean reusable decoder, but still did not accept the evaluator’s direct schema dialect.

[INFERENCE] **Independent coverage beats repetition.** The loader interpretation and its self-authored fixture normally agreed because both came from the same schema-contract interpretation. Repair loops helped when the oracle exercised a representative boundary; repeating endogenous tests could not challenge a missing boundary.

## Final-answer behavior

[OBSERVED] Final answers accurately listed commands that had run and checks that had passed.

[OBSERVED] They frequently used categorical language such as “implemented end to end” despite not having exercised every public boundary.

[INFERENCE] This was procedural honesty but epistemic overreach. The product should distinguish:

- observed working;
- not exercised;
- known failures;
- architecture changed.

Unqualified “end to end” should require a top-level scenario, not only green unit/static checks.

## Causal assessment

### Causally credible

[OBSERVED] Continuations ran sequentially in seeded randomized blocks. Raw run `003` had a cold first turn, report-only run `005` had a later cold turn, and manifest score/elapsed showed replicate-order trends.

[INFERENCE] Context treatment directly caused the large initial context-size differences and plausibly caused the observed efficiency differences under this fixed task and seal.

[INFERENCE] Randomized assignment supports conditional comparisons among these four exact context artifacts in this realized execution, but does not eliminate secular provider, order, or cache effects.

### Plausible but not identified firmly

[INFERENCE] Raw chronology reduced core rediscovery.

[INFERENCE] Semantic compression shifted work toward repository reacquisition.

[INFERENCE] The manifest may have reduced redundant exploration relative to report-only.

[INFERENCE] Preserved chronology may have made the next file/action easier to select.

These mechanisms fit trajectories and aggregate metrics, but only one report, one manifest, one Shake derivation, and five continuations per condition were observed.

### Not identified as a stable treatment effect

[INFERENCE] No stable correctness ordering is identified. High-scoring direct-schema solutions occurred in raw, Shake, and manifest. Normalized-only solutions occurred in every treatment. Treatment explained only about 9% of score variance.

[INFERENCE] Schema-contract interpretation, loader architecture, and endogenous fixture choice were stronger proximal explanations than condition label; their causal ordering is not identified here.

## Observation-to-hypothesis matrix

| Observation | [INFERENCE] Hypothesis | Competing explanation | Discriminating test |
| --- | --- | --- | --- |
| Raw reread the core least and immediately used correct Phase-1 APIs. | Chronology preserved procedural recency. | Raw simply had more source/prose tokens; first actions are stochastic. | Add only the last 3–5 action summaries to a semantic report and preregister first file/action. |
| Report-only agents all chose normalized fixtures. | Report wording anchored internal `NormalizedOperation` as the file contract. | The repository itself makes normalized serialization more discoverable. | Cross report wording: internal-model emphasis versus explicit canonical wire-format sentence. |
| No Shake/manifest run opened `artifact://22`. | Opaque artifact pointers have low practical value when current source is cheaper to inspect. | The task happened not to need old outputs. | Give question-targeted evidence pointers and tasks whose answer exists only in retained evidence. |
| Manifest used fewer tools than report-only without explicit citation. | Provenance increased confidence or focused rediscovery implicitly. | Difference is continuation stochasticity/order drift. | Factor report × accurate/shuffled/omitted manifest over independently generated seals. |
| High scores co-occur with direct-schema loaders and fixtures across treatments. | One schema-contract interpretation jointly shaped loader and fixture; endogenous tests then failed to challenge it. | More capable runs may independently infer better code and write better tests. | Supply half the runs an independent black-box acceptance harness before implementation or finalization. |
| Within-treatment hidden score correlated with tool errors (r=.619, BH q=.033). | Visible verification/repair activity may expose and correct defects. | Broader, more capable trajectories attempt more checks and therefore observe more failures. | Randomize a verification-floor gate while holding context treatment fixed. |
| All final answers report visible green checks and use categorical end-to-end completion language. | Final-answer policy overgeneralizes from local verification. | Hidden requirements were unavailable and visible spec was partly conflicting. | Generate completion language from explicit evidence provenance and untested-boundary inventory. |

## General takeaway beyond spec-rich repositories

[OBSERVED] This experiment directly establishes a narrow result: when continuations faced an underspecified, high-impact integration choice, more history and more self-authored tests did not reliably resolve it. The study does not establish that every repository needs a formal contract compiler, an architecture map, or a specification-derived test matrix.

[INFERENCE] The broader product hypothesis is **uncertainty-aware continuation with independent challenge**:

1. preserve settled facts and their provenance;
2. distinguish open questions from settled decisions;
3. surface high-impact assumptions before they become architecture;
4. record plausible alternatives and reversibility;
5. challenge the selected interpretation with evidence not authored from the same assumption;
6. calibrate completion claims to what was actually exercised.

This applies when no formal specification exists. Sources of truth may instead be:

- current callers;
- types and interfaces;
- existing tests and fixtures;
- runtime behavior;
- examples and snapshots;
- repository conventions;
- user instructions;
- version history;
- explicit operator decisions.

If those sources disagree or remain underdetermined, the useful product behavior is not to fabricate a contract. It is to mark the decision as uncertain, show the competing interpretations and evidence, choose a reversible default when safe, or ask the operator when the consequences are material.

An executable contract matrix is one implementation for a spec-rich command surface. A more general continuation object would be a **decision and evidence ledger**:

```text
settled facts
open questions
assumptions currently chosen
alternatives considered
evidence for each
architecture ownership
verification performed
unverified risk
```

[INFERENCE] The general research priority is therefore not “build a contract system.” It is to test whether making uncertainty, decision provenance, and independent evidence first-class improves continuation quality across tasks with and without specifications.

## Task-specific product improvements suggested by this case

### 1. Executable contract matrix

Generate a visible acceptance matrix from the specification and registry:

```text
{validate, send}
× {inline, file, stdin}
× {live discovery, offline schema}
× {strict, permissive}
× {dispatch, main}
```

Require each row to link to a test or be marked unverified.

### 2. Canonical boundary card

At continuation, provide exact:

- accepted serialized shapes;
- callable signatures;
- owning modules;
- producer and consumer examples;
- public/internal translation requirements;
- content-addressed symbol anchors.

The card should say whether anchors still match the workspace.

### 3. Domain-constructor warning

Flag new CLI-local reconstruction of established domain types such as `NormalizedOperation`. Ask the agent to locate or create one canonical inverse in the owning schema module.

### 4. Coverage-aware finalization

Build final status from evidence:

- observed working;
- unexercised boundaries;
- known failures;
- static/regression status;
- top-level scenarios actually run.

### 5. Adjacent-case prompt after repair

After fixing a visible failure, ask one contract-shaped question about the neighboring branch. Do not ask for generic extra testing.

### 6. Question-targeted artifact recovery

Replace an opaque `artifact://22` pointer with entries such as:

```text
schema-file contract evidence → artifact://…
last successful public CLI example → artifact://…
policy-before-mutation verification → artifact://…
```

Track whether the agent reads the pointer and whether it avoids rediscovery.

### 7. Defect-family scoring

Report both:

- item-weighted hidden score;
- defect-family score with severity.

Do not count one schema dialect choice as four independent defects while valuing a safety mutation error equally to metadata drift.

## Follow-up qualitative experiments

1. **Independent-seal replication:** several generated reports/manifests per task, several continuations per seal.
2. **Canonical-wire-format ablation:** report wording with and without one exact `--schema-file` sentence.
3. **Manifest uptake experiment:** accurate, omitted-path, shuffled-control, and question-targeted manifests.
4. **Chronology cue experiment:** semantic report with or without the final action sequence.
5. **External acceptance harness:** provide a small black-box boundary suite to half the runs before finalization.
6. **Verification-floor intervention:** require named evidence for every public matrix row.
7. **Blinded code-quality scoring:** rate architecture, duplication, policy, side-effect ordering, and test oracle before treatment reveal.
8. **Information-fidelity probes:** before coding, ask agents to state public shapes, invariants, changed symbols, unverified risks, and evidence locations; score retention separately from implementation.

## Bottom line

[OBSERVED] The agents generally wrote coherent, typed, regression-safe code. [INFERENCE] Their behavior was consistent with competent local maintenance, and they did not generally produce arbitrary or low-quality code.

[OBSERVED] Their biggest repeated evaluator mismatch was an underspecified external schema-file boundary, and their tests often made the same assumption as their implementation. The visible process looked strong while evaluator completeness remained variable.

[INFERENCE] For this task, the most direct intervention is to make the disputed boundary and its independent evidence inspectable. The broader product hypothesis is more modest: continuation systems should preserve uncertainty and decision provenance, then seek evidence independent of the chosen implementation. Whether that is higher leverage than context, retrieval, or other interventions must be tested across task types and repositories without formal specifications.
