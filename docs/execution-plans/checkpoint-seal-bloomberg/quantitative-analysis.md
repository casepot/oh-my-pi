# Checkpoint Seal Bloomberg: Quantitative Analysis

Status: **additional analysis of the corrected, isolated experiment**

Primary findings: `results.md`

Visual findings: `findings.pdf`

Qualitative trajectory and code analysis: `qualitative-analysis.md`

Experiment artifacts: `/Users/case/experiments/checkpoint-seal-bloomberg-clean-v2-0.144.1-medium`

Analysis population:

- 20 valid continuations;
- five replicates per condition;
- 1,120 provider turns;
- `openai-codex/gpt-5.6-sol`, medium reasoning;
- Codex CLI `0.144.1`;
- provider-failure and cwd-mismatch attempts excluded before aggregation.

## Executive findings

1. **Caching was nearly universal, but not free.** 1,118 of 1,120 provider turns had non-zero `cacheRead`. Across all prompts, 66.069 million of 67.959 million processed prompt tokens came from cache. Those cache reads still contributed 66.4% of continuation provider cost and still occupied context-window capacity.
2. **The initial context chart overstated durable savings.** Report plus manifest reduced the first prompt by 52.9%, but cumulative prompt tokens by 30.0% and the final prompt by 21.8%. Agents reconstructed context as they worked.
3. **Report plus manifest remained the strongest product tradeoff.** It had the smallest cumulative token load, fewest provider turns, lowest continuation cost, and shortest continuation time. Including measured seal derivation, it remained 16.8% cheaper than raw for a one-shot continuation, but became 0.48 minutes slower because sealing itself took 1.80 minutes.
4. **Scoped Shake was not a cost or latency win after seal overhead.** Its one-shot cost was only 0.6% below raw and its serialized time was 2.15 minutes longer. It remains a chronology-preserving mode, not the general efficiency choice.
5. **The manifest appears unusually high value.** It added only 198 tokens to the first prompt relative to report-only, but improved mean hidden score by 1.2, raised the observed floor by 2, removed 4.4 provider turns, saved 274,443 cumulative prompt tokens, saved $0.24, and saved 0.88 minutes per continuation. This is directional evidence from five runs, not a resolved causal estimate.
6. **Treatment was not the main source of quality variation.** Treatment explained 9.0% of hidden-score variance; one-way ANOVA p=.669 and Kruskal-Wallis p=.432. The bootstrap 95% interval for report-plus-manifest minus raw was -3.0 to +1.4 hidden contracts. More task archetypes are more valuable now than many additional repetitions of this one task.
7. **Cheap compacted runs can also be under-worked runs.** Within the manifest arm, higher hidden scores correlated with more cost, elapsed time, and output. Its 20/21 run was its most expensive. Product decisions must use quality-floor metrics, not unconditional mean cost alone.

## What the experiment actually tested

### The shared task

The experiment used the `bloomberg-cli` repository. A common shared phase first implemented and verified a transport-independent transient request workflow:

- exclusive JSON body loading from file, stdin, or inline input;
- normalized-operation schema validation;
- strict and permissive diagnostics;
- schema-hash propagation;
- policy enforcement before adapter mutation;
- request execution through the existing Bloomberg adapter boundary;
- success, partial response, request-status failure, timeout, stale-correlation, entitlement, correlation-ID, and request-ID state;
- focused tests plus the repository’s offline quality gates.

That phase intentionally stopped before CLI integration. Its final filesystem snapshot, todo state, and session checkpoint became the common S1 starting point for every condition.

### The continuation task

Every run received the same continuation request: expose the already-implemented workflow through the CLI while preserving the repository’s existing parsing, envelope, error-registry, output, policy, schema-hash, and adapter conventions.

The hidden evaluator exercised 21 contracts. Broadly, it checked:

- request validation and request sending;
- file, stdin, and inline body semantics;
- deterministic schema diagnostics and schema hash;
- policy-before-mutation behavior;
- success, partial response, request-status failure, and timeout envelopes;
- correlation and Bloomberg request identifiers;
- CLI exit and output behavior;
- offline suite, Ruff, basedpyright, and `ty`.

This task was useful because the continuation depended on decisions and code produced before the checkpoint. It required repository navigation, exact public behavior, error mapping, editing, verification, and recovery from failed checks.

It was not a neutral sample of “coding.” It was a Python CLI integration task over a known application boundary, with a deterministic local evaluator and no live Bloomberg dependency.

## How checkpointing and treatments worked

The common session reached a checkpoint immediately after the shared workflow implementation and verification. The four conditions then changed only the model-visible trajectory:

| Condition | Active messages | First prompt | Treatment mechanics |
| --- | ---: | ---: | --- |
| Raw | 120 | 54,015 | Continue from the untreated checkpoint branch. |
| Scoped Shake | 120 | 35,676 | Replace 51 eligible post-checkpoint tool-result payloads with artifact-backed placeholders; retain chronology and ordinary prose. |
| Report only | 6 | 25,248 | Continue from the semantic report before the runtime manifest entry. |
| Report + manifest | 7 | 25,446 | Continue from the same report plus a runtime-generated provenance manifest. |

### Raw / keep

The original user, assistant, and tool trajectory remained in active context. The checkpoint was closed without rewriting the span.

### Scoped Shake

Shake was spatially constrained to entries strictly after the checkpoint. It mechanically elided eligible tool-result payloads and retained their recoverable artifacts. It did not summarize ordinary reasoning or collapse message chronology.

The corrected Shake source contained 51 placeholders and all 120 active messages.

### Semantic report

The report captured:

- outcome;
- durable context;
- decisions and reasons;
- verification evidence;
- remaining work;
- the recommended next action.

Report-only intentionally omitted the runtime manifest so the incremental value of structured provenance could be observed.

### Runtime manifest

The manifest added mechanically derived state and provenance, including changed paths, successful tool activity, evidence references, checkpoint/seal metadata, and preserved orchestration state. It added only 198 tokens to the first prompt relative to report-only.

### Physical isolation

The corrected experiment used separate physical session files:

```text
untreated shared session
├── raw source
├── independent Shake copy
└── independent semantic copy
    ├── report-only leaf
    └── report + manifest leaf
```

The raw SHA-256 remained unchanged before and after all continuations. Runtime guards rejected:

- raw or semantic contexts containing Shake placeholders;
- Shake contexts containing no placeholders;
- resumed sessions with the wrong cwd;
- provider-error terminal turns;
- missing treatment context measurements.

The filesystem workspace was reset from the same S1 seed before every continuation.

## Experimental methodology

### Experimental unit

The primary experimental unit was one complete continuation run. Provider turns and tool calls were repeated observations within a run, not independent samples.

There were five valid continuation runs per treatment. Conditions were interleaved in seeded randomized blocks so that each replicate round included all four treatments.

### Controlled inputs

Every valid run used:

- the same S1 filesystem seed;
- the same continuation prompt;
- the same model and medium reasoning level;
- the same Codex CLI version;
- the same tool configuration and canonical workspace path;
- the same hidden evaluator;
- the same external Python environment;
- the same todo close-state.

### Outcomes

Primary behavioral outcome:

- hidden contracts passed out of 21.

Operational outcomes:

- first, final, and cumulative prompt tokens;
- uncached input, cache reads, cache writes, and output tokens;
- provider calls and provider cost;
- tool calls, reads, edits, failed tools, and elapsed time;
- existing offline/static gate results.

Exploratory outcomes:

- correlations between trajectory behavior and quality;
- cost and elapsed-time regressions;
- Pareto frontiers;
- cache-price sensitivity;
- replicate-order trends.

### Validity handling

Infrastructure failures were not treated as model outcomes:

- a cwd-mismatch setup pilot was rejected and prompted a mandatory cwd pin;
- one provider SSE timeout was retained separately, rejected, and replaced;
- all 20 accepted runs had non-error provider termination and complete evaluator artifacts.

This exclusion rule is appropriate for infrastructure failures, but it must be specified before runs. A model that voluntarily stops with broken code would remain a valid poor treatment outcome.

### Statistical treatment

The analysis reports:

- raw replicate values;
- means, ranges, and thresholds;
- bootstrap differences and ranking probabilities;
- one-way ANOVA and Kruskal-Wallis tests;
- Pearson and Spearman correlations;
- within-treatment centering to reduce treatment confounding;
- HC3 robust standard errors for descriptive regressions;
- Benjamini-Hochberg adjustment for the exploratory within-treatment quality correlations.

These methods do not overcome the small sample or single-task design. They quantify uncertainty and help rank follow-up questions.

## Methodological blind spots

### One task, one repository, one model

The result may be specific to:

- a Python CLI integration task;
- a mature local test suite;
- the Bloomberg request-domain vocabulary;
- this repository’s architecture and conventions;
- `gpt-5.6-sol` at medium reasoning;
- this provider’s current cache and price behavior.

It does not establish effects for debugging, migrations, research, UI work, multi-language projects, weakly tested repositories, other models, or other providers.

### One generated seal per semantic treatment

The summary report and manifest were generated once, then reused by five continuation replicates. Shake was also derived once.

Therefore:

- the five replicates measure continuation stochasticity conditional on one particular seal;
- they do not measure report-generation variance;
- a better or worse report could shift the entire semantic treatment;
- the effective sample size for the generated handoff itself is one.

This is one of the highest-leverage methodological improvements. Future designs should nest multiple independently generated seals inside each task, then run multiple continuations from each seal.

### Warm, shared prefixes

Identical treatment prefixes were reused across replicates. Provider cache state was therefore likely warm and correlated across runs. Cache behavior was observed, not independently randomized.

The experiment cannot estimate:

- production cold-start frequency;
- time-to-first-token benefit from cache hits;
- cache eviction behavior;
- whether sealing preserves cache identity across providers;
- quality effects of cold versus warm execution.

### Only five continuations per arm

Five runs expose large stochastic variation but leave wide intervals. Treatment explained only 9.0% of score variance, and all mean-quality comparisons remain unresolved.

### One common hidden-contract failure

Every valid run missed the same server-not-tested/schema-hash contract. This caps absolute scores and means the evaluator may contain an under-specified or systematically difficult boundary. Relative differences remain visible, but the task needs an evaluator review before reuse.

### Seal overhead was reused

The experiment generated each treatment once and branched five continuations from it. Continuation means therefore reflect an amortized experimental setting. A normal user may seal once and continue once; that one-shot path must include seal cost and latency.

### No time-to-first-token instrumentation

Event timestamps measure end-to-end run and seal duration, but not provider queueing, first-byte latency, streaming rate, or per-turn wall time. Cache may improve responsiveness even when total billed tokens remain large.

### No direct information-fidelity measurement

The evaluator measured final behavior, not which pre-checkpoint facts survived. The experiment cannot distinguish:

- facts retained in active context;
- facts rediscovered from the repository;
- facts reconstructed incorrectly but not exercised;
- facts recoverable only through artifacts;
- manifest fields actually consulted.

### Workspace task only

No live Bloomberg service, network authentication, daemon state, browser state, external side effects, or multi-agent coordination was involved. Rewind and checkpoint semantics around irreversible external effects were not tested.

### Post-hoc exploratory analysis

The correlation and drift hypotheses were selected after seeing the data. Even adjusted p-values should be treated as hypothesis generation until replicated with pre-registered endpoints.

## Optimization axes

Checkpoint policy is multi-objective. The main axes are:

| Axis | Useful measure | Tension |
| --- | --- | --- |
| Correctness mean | Hidden score average | Can hide a dangerous low tail. |
| Correctness floor | Minimum or threshold pass rate | Usually requires more detail and verification. |
| Immediate capacity | First prompt tokens | Overstates durable savings if context regrows. |
| Lifecycle capacity | Final and cumulative prompt tokens | Depends on remaining turns and reconstruction. |
| Provider cost | Seal + continuation cost | Sensitive to cache pricing and output length. |
| Latency | Seal, TTFT, tool, and continuation time | A cheaper continuation can still be slower end to end. |
| Chronology | Messages and ordering retained | Conflicts with maximum semantic compression. |
| Provenance precision | Paths, symbols, commands, evidence | Small structured additions can reduce rediscovery. |
| Recoverability | Artifact availability and retrieval success | Recovery calls add latency and context. |
| Reconstruction burden | Reads, repeated reads, context growth | Some rereading is healthy grounding; some is waste. |
| Branch fan-out | Continuations per seal | Amortizes seal cost but can share seal defects. |
| Robustness | Variance across tasks, seals, time, models | Requires broader and nested experiments. |
| Operator control | Explicit choice and inspectable report | Limits unsafe automatic optimization. |

These axes interact:

- higher compression can reduce capacity cost while increasing omission risk;
- cheap cache can make raw economically attractive while leaving context-window pressure unchanged;
- verification loops raise cost but may improve the quality floor;
- branch fan-out amortizes seal overhead but multiplies any report defect;
- chronology preservation favors Shake, while semantic density favors report plus manifest;
- automatic re-sealing may control regrowth but compound information loss.

## What “cache hit” means in this report

The provider usage records expose `input`, `cacheRead`, and `cacheWrite` token counts, but no explicit request-level hit/miss flag or attempted-cache count.

This report therefore uses two separate measures:

- **Cache-read incidence:** a turn is counted as having a cache hit when `cacheRead > 0`.
- **Cached-token share:** `cacheRead / (input + cacheRead + cacheWrite)`.

Neither is a perfect cache hit rate. New conversation suffixes appear as ordinary input even when the stable prefix hits cache. A high cached-token share can also be a denominator artifact: the same cached system prefix occupies a larger fraction of a smaller compacted prompt.

## Cache and token accounting

### First provider prompt

| Condition | First prompt | Uncached input | Cache read | Cache write | Reduction vs raw |
| --- | ---: | ---: | ---: | ---: | ---: |
| Raw | 54,015 | 36,197 | 17,818 | 0 | — |
| Scoped Shake | 35,676 | 13,404 | 22,272 | 0 | 34.0% |
| Report only | 25,248 | 2,976 | 22,272 | 0 | 53.3% |
| Report + manifest | 25,446 | 3,174 | 22,272 | 0 | 52.9% |

Four of five raw first turns read the same 22,272-token cached prefix as the compacted conditions. Raw replicate 1 was cold and submitted all 54,037 prompt tokens as uncached input, raising the raw mean.

The semantic conditions did not eliminate the 22,272-token common cached prefix. They primarily removed the uncached session-history suffix.

### All provider turns

| Condition | Provider turns/run | Prompt tokens/run | Uncached input/run | Cache read/run | Weighted cached share | Median turn cached share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Raw | 53.8 | 4.071M | 104,934 | 3.966M | 97.42% | 98.49% |
| Scoped Shake | 61.0 | 3.544M | 87,063 | 3.457M | 97.54% | 98.23% |
| Report only | 56.8 | 3.125M | 103,742 | 3.021M | 96.68% | 97.99% |
| Report + manifest | 52.4 | 2.851M | 82,175 | 2.769M | 97.12% | 97.90% |

Across all 20 valid runs:

```text
Provider turns:        1,120
Turns with cacheRead:  1,118  (99.82% incidence)
Prompt tokens:         67,958,565
  uncached input:       1,889,573
  cache read:          66,068,992
  cache write:                  0
Output tokens:            241,365
Continuation cost:          $49.723
```

Observed token accounting was approximately:

```text
uncached input:  $5.00 / million tokens
cache read:      $0.50 / million tokens
output:         $30.00 / million tokens
```

Continuation cost composition:

| Component | Cost share |
| --- | ---: |
| Cache reads | 66.4% |
| Uncached input | 19.0% |
| Output | 14.6% |

A cached token was discounted 90% relative to uncached input, but the experiment processed 35 times more cached than uncached prompt tokens. Cache-read volume therefore remained the largest cost component.

### Cold-cache observations

Only two turns had `cacheRead = 0`:

| Condition | Replicate | Turn | Uncached input | Estimated premium over cached pricing |
| --- | ---: | ---: | ---: | ---: |
| Raw | 1 | 1 | 54,037 | $0.243 |
| Report only | 2 | 43 | 57,023 | $0.257 |

Total estimated cold-cache premium: **$0.500**.

There are too few misses to estimate a quality effect. The report-only cold turn occurred late in a run that scored 12/21, but a single observation cannot separate cache state from run quality.

The experiment reused identical treatment prefixes across replicates, likely warming provider cache. These cache figures are therefore not independent cold-production estimates.

## Context savings over the whole trajectory

| Condition | First prompt | Final prompt | Growth | Cumulative prompt/run | Cumulative reduction vs raw |
| --- | ---: | ---: | ---: | ---: | ---: |
| Raw | 54,015 | 88,192 | +34,177 | 4.071M | — |
| Scoped Shake | 35,676 | 70,808 | +35,132 | 3.544M | 12.9% |
| Report only | 25,248 | 69,935 | +44,687 | 3.125M | 23.2% |
| Report + manifest | 25,446 | 68,951 | +43,505 | 2.851M | 30.0% |

### Savings decay

| Condition | Initial reduction | Final-prompt reduction | Cumulative reduction |
| --- | ---: | ---: | ---: |
| Scoped Shake | 34.0% | 19.7% | 12.9% |
| Report only | 53.3% | 20.7% | 23.2% |
| Report + manifest | 52.9% | 21.8% | 30.0% |

The compacted agents rebuilt missing working context through reads, tool results, reasoning, and edits. Semantic prompts grew roughly 9,300–10,500 tokens more than raw after treatment. They still finished about 18,300–19,200 tokens below raw, but the first-turn percentage is not a durable lifecycle saving.

This produces a practical metric hierarchy:

1. first prompt: measures immediate context-window relief;
2. final prompt: measures retained relief after reconstruction;
3. cumulative prompt: best predictor of token-processing cost;
4. provider turns: captures how many times the context is paid for;
5. quality floor: prevents apparent efficiency from rewarding early or under-verified completion.

## Cost per run

The following costs and times are continuation-only; seal overhead is handled separately.

| Condition | Rep | Score | Calls | Cumulative prompt | Cost | Elapsed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Raw | 1 | 16 | 49 | 3.551M | $2.60 | 7.28m |
| Raw | 2 | 16 | 65 | 5.095M | $3.51 | 11.12m |
| Raw | 3 | 16 | 51 | 3.679M | $2.58 | 7.11m |
| Raw | 4 | 16 | 54 | 4.158M | $3.02 | 8.48m |
| Raw | 5 | 20 | 50 | 3.874M | $2.78 | 6.76m |
| Scoped Shake | 1 | 12 | 60 | 3.451M | $2.49 | 12.99m |
| Scoped Shake | 2 | 12 | 51 | 2.856M | $2.11 | 7.00m |
| Scoped Shake | 3 | 20 | 69 | 4.151M | $2.95 | 9.01m |
| Scoped Shake | 4 | 19 | 56 | 3.158M | $2.31 | 7.03m |
| Scoped Shake | 5 | 16 | 69 | 4.106M | $2.85 | 8.30m |
| Report only | 1 | 15 | 55 | 3.332M | $2.39 | 10.62m |
| Report only | 2 | 12 | 62 | 3.081M | $2.62 | 8.82m |
| Report only | 3 | 16 | 48 | 2.579M | $1.94 | 5.62m |
| Report only | 4 | 15 | 58 | 3.168M | $2.36 | 6.37m |
| Report only | 5 | 16 | 61 | 3.465M | $2.55 | 7.13m |
| Report + manifest | 1 | 20 | 69 | 3.966M | $2.87 | 8.66m |
| Report + manifest | 2 | 15 | 42 | 2.091M | $1.71 | 7.09m |
| Report + manifest | 3 | 16 | 50 | 2.692M | $2.06 | 6.99m |
| Report + manifest | 4 | 15 | 43 | 2.532M | $1.85 | 5.25m |
| Report + manifest | 5 | 14 | 58 | 2.973M | $2.17 | 6.17m |

### Continuation-only means

| Condition | Cost | Elapsed | Cost/call |
| --- | ---: | ---: | ---: |
| Raw | $2.900 | 8.15m | $0.054 |
| Scoped Shake | $2.542 | 8.87m | $0.042 |
| Report only | $2.372 | 7.71m | $0.042 |
| Report + manifest | $2.130 | 6.83m | $0.041 |

The lower compact-condition cost per call came primarily from smaller prompts. Report plus manifest also used fewer calls. Report-only lost part of its token advantage by taking 4.4 more calls than manifest.

## Seal overhead and one-shot economics

The earlier findings table reported continuation-only cost and time. The measured derivation was created once and reused across five experiment branches, so that table excluded seal overhead.

Measured derivation overhead under the experiment controller:

| Seal | Provider calls | Cost | Elapsed |
| --- | ---: | ---: | ---: |
| Scoped Shake | 2 | $0.340 | 1.43m |
| Summary report + manifest | 5 | $0.284 | 1.80m |

The summary measurement includes the controlled report-authoring and lifecycle-closing turns. It is a measured experiment-path overhead, not a claim that manifest serialization alone takes five calls.

### One seal followed by one continuation

| Condition | End-to-end cost | Change vs raw | End-to-end time | Change vs raw |
| --- | ---: | ---: | ---: | ---: |
| Raw | $2.900 | — | 8.15m | — |
| Scoped Shake | $2.882 | -0.6% | 10.30m | +2.15m |
| Report only | $2.656 | -8.4% | 9.51m | +1.36m |
| Report + manifest | $2.414 | -16.8% | 8.63m | +0.48m |

The report-plus-manifest continuation is faster than raw after the seal exists, but not when the seal must be generated serially for a single continuation. It becomes a time win when the same seal feeds at least two continuations. Report-only needs about five. Shake never reaches a time break-even in this dataset because its continuation itself was slower than raw.

For branch fan-out, the seal overhead amortizes:

```text
K=1: include the full seal cost and latency once.
K>1: total = seal overhead + K × continuation cost/time.
```

This makes sealing more attractive for branch exploration, parallel reviewers, or multi-agent handoff than for a single short continuation.

## Cache-price sensitivity

One-shot cost, including measured seal derivation, while holding uncached-input and output prices fixed:

| Cache-read price | Raw | Scoped Shake | Report only | Report + manifest | Manifest savings vs raw |
| --- | ---: | ---: | ---: | ---: | ---: |
| $0/M | $0.917 | $1.143 | $1.086 | $0.971 | -$0.054 |
| $0.50/M observed | $2.900 | $2.882 | $2.656 | $2.414 | $0.486 |
| $5/M | $20.749 | $18.541 | $16.781 | $15.401 | $5.348 |

If cache reads were free and context-window capacity were irrelevant, raw would be slightly cheaper than generating a one-shot semantic seal. At observed pricing, report plus manifest saved 16.8%. At uncached-token pricing, the saving became large.

Product policy should therefore distinguish:

- token price;
- cache-read price;
- cache-hit continuity;
- context-window pressure;
- remaining expected turns;
- number of downstream branches.

A single “tokens freed” number cannot represent these economics.

## Cost and latency models

These regressions are observational descriptions of 20 runs, not causal estimates.

### Provider cost

Model:

```text
provider cost ~ initial prompt / 10,000 + provider calls
```

Results:

- R² = .905;
- +$0.235 per additional 10,000 initial prompt tokens;
- +$0.0396 per additional provider call;
- HC3 robust p-values below 1.1e-12 for both predictors.

Raw correlations:

| Relationship | Pearson r | p |
| --- | ---: | ---: |
| Cost vs cumulative prompt | .980 | <1e-13 |
| Cost vs provider calls | .709 | <.001 |
| Cost vs initial prompt | .611 | .004 |

After subtracting each treatment mean:

| Relationship | Pearson r | p |
| --- | ---: | ---: |
| Cost vs cumulative prompt | .971 | <1e-11 |
| Cost vs provider calls | .962 | <1e-10 |
| Cost vs initial prompt | -.036 | .879 |

Within a treatment, first-prompt size was almost fixed. Cost variation came from how long the run continued and how much context accumulated.

### Elapsed time

A simple model associated each additional tool call with 7.48 seconds of elapsed time:

- R² = .282;
- HC3 p < .001;
- pooled elapsed vs tool calls r=.531;
- within-treatment r=.475.

Tool count explains some latency, but provider/network time, verification duration, tool type, and output size remain substantial.

## Quality uncertainty

### Treatment effects are not statistically resolved

| Test | Result |
| --- | ---: |
| Treatment variance explained, eta² | 9.0% |
| One-way ANOVA | p=.669 |
| Kruskal-Wallis | p=.432 |
| Manifest minus raw mean | -0.8 contracts |
| Bootstrap 95% interval | -3.0 to +1.4 |
| Probability raw mean > manifest | approximately 71.8% |
| Probability manifest mean > report-only | 82.8% |
| Probability manifest mean > Shake | 51.8% |

Five runs per arm support directional product choices, not a claim that one treatment has a statistically established quality effect.

Threshold behavior is more operationally interpretable:

| Condition | Score at least 16 | Score at least 14 |
| --- | ---: | ---: |
| Raw | 5/5 | 5/5 |
| Scoped Shake | 3/5 | 3/5 |
| Report only | 2/5 | 4/5 |
| Report + manifest | 2/5 | 5/5 |

Raw had the strongest observed floor. Manifest never fell below 14. Shake had both 12/21 and 20/21 outcomes.

### Quality-cost frontier

At the condition-mean level, only two conditions were non-dominated:

- report plus manifest: 16.0 contracts at $2.13;
- raw: 16.8 contracts at $2.90.

Shake and report-only had both lower mean quality and higher cost than report plus manifest.

At run level, stochastic overlap produced this frontier:

| Condition | Rep | Score | Cost |
| --- | ---: | ---: | ---: |
| Report + manifest | 2 | 15 | $1.71 |
| Report only | 3 | 16 | $1.94 |
| Scoped Shake | 4 | 19 | $2.31 |
| Raw | 5 | 20 | $2.78 |

No treatment guarantees a particular quality-cost point.

## Exploratory correlations and second-order effects

All correlations below are post hoc and based on 20 runs. They identify hypotheses; they do not identify causes.

### Repair activity correlated with higher score

After subtracting treatment means:

| Predictor | Hidden-score r | p | BH-adjusted q |
| --- | ---: | ---: | ---: |
| Tool errors | .619 | .0036 | .033 |
| Final prompt size | .573 | .0083 | .033 |
| Prompt growth | .574 | .0081 | .033 |

The tool errors were mostly failed Ruff/type-check/test invocations and edit retries that triggered subsequent repairs. They were not provider failures. The likely interpretation is:

```text
more verification and repair activity → more observable errors → more opportunities to correct defects
```

It would be incorrect to conclude that causing errors improves quality. A useful intervention is a verification-floor gate that requires the agent to execute and react to named checks before finalization.

### Manifest’s cheapest runs were not its best runs

Within the five manifest runs, hidden score correlated with:

| Predictor | r | p |
| --- | ---: | ---: |
| Provider cost | .850 | .068 |
| Elapsed time | .841 | .074 |
| Output tokens | .863 | .060 |

The 20/21 manifest run cost $2.87; its cheapest run cost $1.71 and scored 15. The mean efficiency advantage is real as an average, but some of it reflects shorter lower-scoring trajectories.

A production metric such as “cost per successful run” needs a quality threshold or failure penalty. Average dollars per continuation alone rewards stopping early.

### Replicate-order signal

Manifest scores by replicate were 20, 15, 16, 15, 14:

- score vs replicate Spearman rho=-.821, p=.089;
- elapsed vs replicate rho=-.900, p=.037.

Other arms did not show the same monotonic pattern. This may be chance, cache/provider drift, or a time-of-run effect. Future experiments should block and interleave conditions by wall-clock round, record provider latency, and avoid interpreting replicate number as independent.

### Cache misses and quality

Only two cold turns occurred. There is no basis for a cache-quality correlation. Future cold/warm experiments must deliberately randomize cache state.

## Manifest value and likely mechanism

Report-only and report-plus-manifest shared the same semantic report. Their initial prompts differed by only 198 tokens.

Mean manifest deltas relative to report-only:

| Metric | Manifest change |
| --- | ---: |
| First prompt | +198 tokens |
| Hidden score | +1.2 |
| Observed floor | +2 |
| Provider turns | -4.4 |
| Cumulative prompt | -274,443 tokens |
| Cost | -$0.242 |
| Elapsed | -0.88m |

The likely product mechanism is not generic verbosity. A small structured manifest gives the continuation high-precision provenance—changed paths, evidence pointers, commands, state, and lifecycle facts—that would otherwise require repository rediscovery.

This is a strong ablation candidate because the incremental treatment is small and concrete. The next experiment should identify which manifest fields create the value rather than assuming the entire manifest is necessary.

## Product strategy implications

### 1. Preserve three distinct modes

**Raw / keep checkpoint**

- safety default;
- strongest observed floor;
- appropriate when exact trajectory details are load-bearing;
- potentially cheap when cache reads are very inexpensive and the context window is not pressured.

**Report plus manifest**

- explicit context-pressure and handoff mode;
- strongest mean quality-cost frontier point;
- useful for long remaining trajectories or branch fan-out;
- should show users both projected immediate relief and measured seal overhead.

**Scoped Shake**

- chronology-preserving payload elision;
- useful when semantic rewriting is unsafe or unavailable;
- not a routine efficiency mode on this evidence;
- should be described as retaining message structure, not as equivalent to summary compression.

Report-only should not be a product choice while the manifest is available.

### 2. Add a projected-savings controller, not a fixed default

A sealing recommendation should use:

- current context and available window;
- absolute uncached and cache-read token prices;
- recent cache-read continuity;
- expected remaining provider turns;
- observed context growth per turn;
- number of downstream branches;
- measured seal cost and latency;
- load-bearing-detail risk;
- whether verification evidence exists.

A conservative decision sketch:

```text
if detail is load-bearing and window pressure is low:
    keep raw
elif chronology must remain visible:
    consider scoped Shake
elif window pressure is high or expected remaining work is long or branched:
    offer report + manifest
else:
    keep raw
```

Never trigger semantic sealing solely because a todo phase completed.

### 3. Report lifecycle metrics separately

Product telemetry and experiment reports should distinguish:

1. seal derivation cost/time;
2. first continuation prompt;
3. cumulative prompt processed;
4. final prompt;
5. provider calls;
6. quality-floor outcome;
7. artifact retrievals;
8. cache-read incidence and absolute cache-read tokens.

Continuation-only savings should never be labeled end-to-end savings.

### 4. Make reconstruction observable

Semantic agents rebuilt 43–45k tokens after treatment. Add instrumentation for:

- reads of files named in the report;
- reads of files only present in the manifest;
- artifact recovery calls;
- repeated reads;
- facts rediscovered versus facts supplied;
- context growth by tool type.

This can separate healthy repository grounding from avoidable reconstruction.

### 5. Add a verification-floor gate

Before a compacted continuation finalizes, require evidence for a configured set of checks:

- focused behavioral tests;
- static/type checks;
- current todo state;
- unresolved failures classified;
- exact public output contract reviewed.

The experiment suggests repair loops may protect quality. The gate should test whether forcing those loops raises the low-score tail or merely increases cost.

### 6. Consider hybrid retrieval before repeated sealing

Because savings decay, possible strategies include:

- one summary seal plus on-demand artifact retrieval;
- selective retention of exact tool outputs named by the manifest;
- re-sealing only after context regrows past a threshold;
- a small durable fact index keyed by files, symbols, tests, and decisions.

Repeated semantic sealing risks compounded omission. Hybrid retrieval should be evaluated before automatic re-sealing.

## Prioritized research portfolio

### P0 — Measurement and safety gates

#### A. Cold/warm cache probe

**Question:** How much of the observed economics depends on warm shared prefixes?

**Minimal design:**

- four conditions;
- cold and warm cache treatments;
- three randomized single-turn probes per cell;
- 24 total short provider turns;
- identical response contract;
- record first-byte latency, total latency, `input`, `cacheRead`, `cacheWrite`, output, and cost.

**Decision:** Calibrate cache-aware savings projections and determine whether provider cache continuity survives sealing.

#### B. Mandatory experiment validity contract

Before accepting any run:

- physical session paths distinct;
- raw and semantic placeholder counts zero;
- Shake placeholder count positive;
- source checksums unchanged;
- resumed cwd exact;
- provider stop reason non-error;
- hidden evaluator collected all expected contracts;
- seal and continuation costs recorded separately.

This should become a reusable experiment harness invariant, not Bloomberg-specific code.

### P1 — External validity across task archetypes

**Question:** Does the raw/manifest frontier generalize beyond one feature continuation?

**Design:**

- debugging;
- migration/refactor;
- tool-output-heavy feature work;
- research/planning;
- four treatments;
- three replicates per task-treatment cell;
- 48 valid continuations;
- blocked randomization by task and wall-clock round;
- hierarchical analysis with task as a random effect.

**Primary endpoints, pre-registered:**

1. quality threshold pass;
2. hidden-contract score;
3. end-to-end cost including seal;
4. end-to-end elapsed time;
5. cumulative prompt processed;
6. failure and invalidation rate.

At current observed continuation prices, 48 runs would be roughly $115–$140 plus derivation and evaluator overhead; task mix could materially change that estimate.

### P1 — Manifest ablation

**Question:** Which approximately 198 manifest tokens create value?

**Candidate arms:**

1. report-only;
2. report plus minimal manifest: paths and public symbols;
3. report plus evidence manifest: paths, commands, tests, artifact pointers;
4. full manifest;
5. report plus selectively retained exact evidence.

Vary report token budget separately. Candidate manifest fields:

- changed paths;
- public symbols and signatures;
- completed todo state;
- exact commands and outcomes;
- unresolved risks;
- rejected decisions;
- artifact pointers;
- file responsibility map.

Use more than one task. The current mean gain is promising but statistically unresolved.

### P1 — Quality-floor intervention

**Question:** Can required verification remove the low-cost/low-score tail?

**Design:**

- raw and report-plus-manifest contexts;
- normal finalization versus required evidence gate;
- five replicates per cell;
- score, cost, elapsed, repair-loop count, and verification completeness.

**Decision:** Determine whether the gate raises the floor enough to justify its added cost.

### P2 — Context lifecycle

**Question:** How should the product respond when compacted context regrows?

**Arms:**

- one seal only;
- re-seal at a fixed phase boundary;
- re-seal at a measured context threshold;
- one seal plus on-demand artifact retrieval.

Use long two-stage tasks. Track cumulative omission, repeated reads, prompt growth, quality, and artifact retrieval behavior.

### P2 — Seal amortization and fan-out

**Question:** When does one seal pay for itself across branches?

**Design:** one derived context feeding K=1, 2, and 4 independent continuations.

Current time break-even estimates:

- report plus manifest: two continuations;
- report-only: approximately five;
- scoped Shake: no time break-even because its continuation was slower than raw in this task.

Measure actual provider caching across branches; do not assume linear amortization.

### P2 — Provider and pricing sensitivity

Repeat selected cells with:

- cache-busting namespaces;
- intentionally warmed prefixes;
- another provider or pricing regime;
- first-byte latency instrumentation;
- varied context-window pressure.

Compression can be economically unfavorable when cached tokens are nearly free, while still necessary for context capacity.

### P3 — Adaptive sealing policy

Only after multi-task data exists, train and evaluate a policy using:

- predicted remaining turns;
- projected context growth;
- cache price and recent hit continuity;
- branch fan-out;
- verification risk;
- task archetype;
- load-bearing-detail indicators.

Evaluate the policy on held-out tasks. The policy must default to keep when uncertain and must never infer safe sealing from todo completion alone.

## Automating quantitative analysis

The current analysis is reproducible, but it is still an experiment-specific Python pipeline over JSON and compressed event files. The next step is a versioned analysis substrate that makes these metrics automatic for every checkpoint experiment.

### Canonical event and result schema

Every experiment should emit four normalized tables.

#### Experiment table

One row per experiment:

- experiment ID and protocol version;
- repository and revision;
- task and evaluator IDs;
- model, provider, reasoning, CLI version;
- prompt, overlay, and price-table hashes;
- randomization seed;
- planned and completed cell counts;
- start/end time;
- validity status and invalidation reasons.

#### Run table

One row per experimental run:

- task, treatment, seal ID, replicate, and randomized block;
- source and treatment session hashes;
- workspace cwd and seed hash;
- score, threshold pass, and evaluator completeness;
- seal cost/time and continuation cost/time;
- first, final, and cumulative tokens;
- provider calls, tools, reads, edits, errors, and artifact recoveries;
- infrastructure/model/behavioral failure classification.

#### Provider-turn table

One row per provider turn:

- run and turn IDs;
- wall-clock timestamp and treatment phase;
- `input`, `cacheRead`, `cacheWrite`, output, and reasoning tokens;
- cost components and active price table;
- prompt size and growth;
- queue, first-byte, stream, and total latency;
- stop reason and provider error class.

#### Tool-event table

One row per tool call:

- run, provider turn, tool, duration, and outcome;
- error versus expected non-zero result;
- path/symbol/artifact categories;
- whether the call repeated an earlier read or search;
- whether it was a verification, repair, mutation, or recovery action.

Use Parquet or DuckDB for analysis and retain JSONL as the append-only provenance log. CSV remains useful for export, not as the canonical typed store.

### Versioned metric registry

Metrics need explicit definitions and versions. Examples:

```text
first_prompt_tokens.v1
final_prompt_tokens.v1
cumulative_prompt_tokens.v1
cache_read_incidence.v1
weighted_cache_read_share.v1
seal_cost_usd.v1
continuation_cost_usd.v1
one_shot_cost_usd.v1
quality_threshold_16.v1
artifact_recovery_count.v1
```

Each definition should specify:

- numerator and denominator;
- inclusion and exclusion rules;
- phase boundaries;
- invalid-run handling;
- treatment versus infrastructure failures;
- required source fields;
- price-table version.

This prevents another stale `contextUsage`-style metric from silently replacing actual provider-prompt usage.

### Automated validity gates

Before analysis accepts a run, automatically verify:

1. expected session files are physically distinct;
2. raw and semantic sources contain no Shake placeholders;
3. Shake contains expected placeholders and a completed marker;
4. source and post-run hashes match;
5. resumed cwd equals the protocol pin;
6. provider turns have non-error stop reasons;
7. evaluator collected the expected number of contracts;
8. treatment and replicate labels match the private assignment;
9. first provider prompt exists after the treatment boundary;
10. no missing cost, token, or timestamp fields;
11. model, CLI, prompt, overlay, evaluator, and price hashes match;
12. invalid attempts remain durable but never enter treatment aggregates.

The pipeline should refuse to produce a comparative report when any planned cell is missing or contaminated.

### Automatic statistical output

The protocol should declare:

- primary endpoint;
- quality-floor threshold;
- secondary operational endpoints;
- exploratory endpoints;
- comparison families;
- bootstrap seed and iterations;
- multiplicity correction;
- blocking variables;
- minimum valid cell count.

The analysis job can then automatically produce:

- replicate tables and distributions;
- treatment contrasts with intervals;
- threshold pass rates;
- hierarchical task and seal effects;
- ANOVA/non-parametric diagnostics;
- quality-cost Pareto frontiers;
- cumulative context curves;
- seal amortization curves;
- cache-price sensitivity;
- run-order and provider-drift diagnostics;
- missingness and invalidation reports.

Exploratory correlations should be visually and structurally separated from pre-registered tests.

### Automated anomaly detection

Flag rather than rationalize:

- internal tokens-freed estimates that disagree with the next provider prompt;
- nominal controls whose hashes or placeholders match a treatment;
- first prompts outside expected bands;
- cache state changes inside a randomized block;
- unusual provider-call counts or context growth;
- empty transcripts with non-empty session entries;
- evaluator collection errors;
- condition-specific monotonic time trends;
- cost outliers;
- tool-error spikes;
- seal reports missing required fields.

Every alert should carry the exact run IDs and source evidence.

### Cost forecasting before execution

Before launching model runs, estimate:

```text
planned valid runs × expected continuation cost
+ planned seal derivations × expected seal cost
+ retry reserve
```

Display:
- expected, low, and high cost;
- expected provider turns;
- expected wall-clock time;
- whether treatments can safely run in parallel;
- automatic stop points after preflight and pilot blocks.

The harness should support hard caps on newly executed valid runs and provider spend, then stop between randomized blocks for inspection.

### Continuous experiment dashboard

A product-oriented dashboard should support:

- experiment → task → treatment → seal → run → provider-turn drill-down;
- first/final/cumulative context plots;
- cache, cost, latency, and quality distributions;
- continuation-only versus one-shot views;
- warm/cold and provider/version segmentation;
- invalid-attempt timelines;
- treatment Pareto frontiers;
- cross-experiment trend tracking;
- downloadable run and turn tables.

The dashboard should default to absolute tokens and dollars. Ratios such as cache share should be secondary.

### Automation architecture

A maintainable pipeline:

```text
append-only recorder events
        ↓
schema validation + validity gates
        ↓
normalized Parquet/DuckDB tables
        ↓
versioned metric registry
        ↓
pre-registered statistical analysis
        ↓
Markdown/JSON/PDF/dashboard outputs
```

The report generator should consume only normalized, validated tables. It should never reconstruct experimental truth ad hoc from presentation artifacts.

## Recommended immediate product work

1. **Expose honest metrics:** first prompt, cumulative prompt, cache-read tokens, seal overhead, and one-shot versus amortized cost.
2. **Keep raw as the safety default.**
3. **Offer report plus manifest explicitly under context pressure or branch fan-out.**
4. **Hide or discourage report-only.**
5. **Label Shake as chronology-preserving elision, not generic compression.**
6. **Add a verification-floor experiment before automatic sealing.**
7. **Run manifest ablation and multi-task external-validity studies before changing the default.**

## Reproducible artifacts

Generated by:

```text
scripts/experiments/checkpoint-seal-bloomberg/deep_analysis.py
scripts/experiments/checkpoint-seal-bloomberg/visualize_deep_analysis.py
```

Artifacts:

```text
analysis/deep-analysis.json
analysis/run-level-metrics.csv
analysis/turn-level-metrics.csv.gz
analysis/correlations.csv
analysis/treatment-contrasts.csv
docs/execution-plans/checkpoint-seal-bloomberg/quantitative-analysis.pdf
```

Definitions and caveats are part of this report. Correlations are exploratory, treatment comparisons are descriptive at n=5 per arm, and the common hidden-contract failure limits absolute score interpretation.
