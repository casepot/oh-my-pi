# Checkpoint Seal Bloomberg Experiment Results

Status: **completed corrected five-replicate experiment**

Protocol: `experiment.md`

Implementation specification: `context-span-checkpoints.md`

Deep quantitative analysis: `quantitative-analysis.md`

Companion quantitative PDF: `quantitative-analysis.pdf`

Qualitative trajectory and code analysis: `qualitative-analysis.md`

Product direction: `product-direction.md`

Artifacts: `/Users/case/experiments/checkpoint-seal-bloomberg-clean-v2-0.144.1-medium`

## Correction and isolation

The first experiment was invalidated because mutating Shake and semantic derivations shared one writable session file. Its comparative tables and recommendations are withdrawn.

The corrected protocol uses schema version 2 and physically isolated treatment sessions:

- raw uses the untouched shared session;
- Shake uses a dedicated copy;
- report-only and report-plus-manifest use a separate semantic-derivation copy;
- raw and semantic contexts are rejected if they contain any Shake placeholder;
- Shake is rejected if it contains no artifact-backed placeholder;
- the resumed session cwd must equal the frozen canonical workspace;
- provider failures invalidate an attempt instead of becoming a treatment result;
- context size comes from the first provider prompt after the continuation boundary.

Isolation preflight passed. The untouched raw session retained SHA-256 `9430c7d1fcdecd48f41aac56d4393f04ab500b515952ee70f51c04d10e9ae1d5` and zero Shake placeholders after derivation. The Shake copy contained 51 placeholders; the semantic copy contained zero.

## Environment

- Model: `openai-codex/gpt-5.6-sol`
- Reasoning: `medium`
- Codex CLI installed: `0.144.1`
- Latest published Codex CLI at rerun: `0.144.1`
- Conditions: raw, scoped Shake, semantic report, semantic report plus manifest
- Valid replicates: five per condition, 20 total

Observed provider cost for the corrected rerun was `$53.21`: `$49.72` for the 20 valid continuations, `$0.62` for isolated derivation, and `$2.87` across the rejected cwd-mismatch and provider-timeout attempts. The original contaminated experiment is not included in this rerun total.

## Aggregate results

Elapsed time and provider cost in this table are **continuation-only**. The semantic and Shake contexts were derived once and reused across five continuations. For one-shot production economics, add measured seal derivation: Shake `$0.340` and `1.43m`; summary `$0.284` and `1.80m`. The quantitative analysis report provides end-to-end and amortized views.

| Condition | First prompt | Messages | Hidden mean | Hidden range | Tools | Reads | Edits | Errors | Elapsed | Provider cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Raw | 54,015 | 120 | 16.8/21 | 16–20 | 52.8 | 11.2 | 12.0 | 2.6 | 8.15m | $2.90 |
| Scoped Shake | 35,676 | 120 | 15.8/21 | 12–20 | 60.0 | 14.6 | 12.8 | 3.4 | 8.87m | $2.54 |
| Report only | 25,248 | 6 | 14.8/21 | 12–16 | 55.8 | 16.8 | 11.0 | 3.6 | 7.71m | $2.37 |
| Report + manifest | 25,446 | 7 | 16.0/21 | 14–20 | 51.4 | 15.2 | 10.4 | 3.4 | 6.83m | $2.13 |

Hidden passes by replicate:

- Raw: 16, 16, 16, 16, 20
- Scoped Shake: 12, 12, 20, 19, 16
- Report only: 15, 12, 16, 15, 16
- Report + manifest: 20, 15, 16, 15, 14

First-provider-prompt reduction versus raw:

- Scoped Shake: 18,339 tokens, 33.95%
- Report only: 28,767 tokens, 53.26%
- Report + manifest: 28,569 tokens, 52.89%

All 20 valid continuations passed the existing offline suite, isolated Ruff, basedpyright, and `ty check src` in the external evaluator.

## Findings

### Raw retained the strongest correctness floor

Raw had the highest correctness mean, 16.8/21, and the highest observed minimum, 16. Four runs scored 16 and one scored 20. Raw remains the safety baseline when losing a load-bearing detail is more costly than carrying context.

### Report plus manifest was the best context-efficiency tradeoff

Report plus manifest cut the first prompt by 52.89% while averaging 16.0/21, 0.8 below raw. It also had:

- the fewest mean tool calls, 51.4;
- the fewest mean edits, 10.4;
- the shortest mean elapsed time, 6.83 minutes;
- the lowest mean provider cost, $2.13.

Its observed minimum was 14, below raw's 16. That prevents automatic promotion from this single task archetype, but it is the preferred explicit context-pressure strategy.

### The manifest added measurable value

Report-only and report-plus-manifest had nearly identical prompt sizes: 25,248 versus 25,446 tokens. Adding the manifest improved mean correctness from 14.8 to 16.0 and raised the observed minimum from 12 to 14. Report-only is therefore dominated when a manifest is available.

### Scoped Shake was not a safer middle ground

Scoped Shake did have a real mechanical effect: it reduced the first prompt by 18,339 tokens, 33.95%, while preserving all 120 messages.

It did not outperform the semantic candidate:

- correctness mean: 15.8 versus 16.0;
- correctness minimum: 12 versus 14;
- mean tools: 60.0 versus 51.4;
- mean elapsed: 8.87 versus 6.83 minutes;
- prompt reduction: 33.95% versus 52.89%.

Its correctness standard deviation was 3.77, the widest of the four conditions. Scoped Shake remains useful when chronology itself must stay visible, not as the routine compression choice for this task.

## Common hidden-contract limit

Every valid run missed `test_validate_reports_server_not_tested_and_exact_schema_hash`. This shared contract ambiguity limits absolute interpretation but does not explain the between-condition differences. Raw and the two compacted candidates each produced at least one 20/21 run.

## Invalid attempts excluded from outcomes

Two setup/operational attempts are retained separately and excluded:

1. A first corrected pilot reused the clean session at a different workspace path. The resumed session still pointed at the original canonical cwd. The new cwd assertion now prevents this before a continuation prompt.
2. One Shake attempt ended with `OpenAI Codex SSE stream timed out while waiting for the first event`. It was moved to `invalid-runs/provider-failure` and replaced. The new provider-failure guard prevents such an attempt from being marked complete.

## Decision

1. **Safety default:** keep raw history when correctness floor and exact trajectory details are load-bearing.
2. **Explicit context-pressure option:** use report plus manifest. It produced the strongest overall compression/quality/efficiency tradeoff.
3. **Do not use report-only** when the manifest is available.
4. **Use scoped Shake only when chronology must remain visible** or semantic sealing is unsuitable; it was not the better routine compression treatment here.
5. Do not make semantic sealing automatic from one task archetype and five replicates. Repeat on debugging and migration tasks before changing the default.
