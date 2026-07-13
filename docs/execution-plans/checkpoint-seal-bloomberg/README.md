# Checkpoint Seal Bloomberg Exploration

End-to-end implementation, experiment, quantitative/qualitative analysis, and product-direction package for context-span checkpoints.

## Reading order

1. [`context-span-checkpoints.md`](context-span-checkpoints.md) — checkpoint dispositions, state semantics, atomicity, recovery, rollout, decision rule.
2. [`experiment.md`](experiment.md) — Bloomberg CLI continuation experiment protocol, treatments, evaluator, randomization, validity requirements.
3. [`results.md`](results.md) — corrected five-replicate results, isolation evidence, aggregate findings, product decision.
4. [`findings.pdf`](findings.pdf) — concise two-page findings visualization.
5. [`quantitative-analysis.md`](quantitative-analysis.md) — cache, cost, context lifecycle, correlations, second-order effects, methodological limits, research portfolio, analysis automation.
6. [`quantitative-analysis.pdf`](quantitative-analysis.pdf) — four-page quantitative/methodology visualization.
7. [`qualitative-analysis.md`](qualitative-analysis.md) — sub-agent trajectory review, code taxonomy, defect families, treatment behavior, causal assessment, product interventions.
8. [`product-direction.md`](product-direction.md) — generalized uncertainty-aware continuation and Decision & Evidence Layer product direction.

## Reproducible implementation and analysis

Experiment harness and analysis scripts:

```text
scripts/experiments/checkpoint-seal-bloomberg/
```

Corrected durable experiment artifacts:

```text
/Users/case/experiments/checkpoint-seal-bloomberg-clean-v2-0.144.1-medium
```

Key generated data:

```text
analysis/aggregate.json
analysis/deep-analysis.json
analysis/run-level-metrics.csv
analysis/turn-level-metrics.csv.gz
analysis/correlations.csv
analysis/treatment-contrasts.csv
analysis/qualitative-review-bundle.md
analysis/isolation-preflight.json
analysis/post-run-isolation.json
```

## Validity status

- 20 valid isolated continuations; five per treatment.
- Raw, Shake, and semantic treatments use physically distinct session files.
- Raw source hash remained unchanged through derivation and continuation.
- Provider-error and cwd-mismatch attempts remain durable under `invalid-runs/` and are excluded from treatment outcomes.
- The original contaminated experiment remains invalidated and is not used for comparative conclusions.
- Hidden C12 conflicts with the checked-in `server_accepted: null` specification and masks its subsequent schema-hash assertion; interpret 20/21 as passing every hidden item outside C12.
