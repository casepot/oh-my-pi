# DeepSWE Bench Operations

This is the developer runbook for `packages/deepswe-bench`: how to run it, what its guardrails mean, and how to interpret failures. It intentionally avoids host-specific disk/task-session state.

## Purpose

`packages/deepswe-bench` runs DeepSWE tasks through Pier using the local OMP coding-agent build. It exists for durable product-quality evaluations where the runner must preserve enough evidence to distinguish:

- model/task failure;
- OMP agent failure;
- Pier/Docker infrastructure failure;
- auth/gateway setup failure;
- interrupted or timed-out runs.

The runner's main contract is durability: every real run should leave enough artifacts to reconstruct what happened, even when the agent crashes, Pier exits non-zero, or the user interrupts the process.

## Default local workflow

Use direct Codex token mode first for local iteration. It is cheaper, avoids the filtered-egress gateway trap, and exercises the OMP agent path quickly.

```bash
OPENAI_CODEX_OAUTH_TOKEN="$(omp token openai-codex)" \
bun --cwd=packages/deepswe-bench run src/runner.ts \
  --tasks-path ./deep-swe/tasks \
  --model openai-codex/gpt-5.5 \
  --preset smoke-fast \
  --no-gateway \
  --job-name deepswe-codex-low-smoke-fast
```

Default runner settings are intentionally conservative:

- `--thinking low`
- `--concurrency 1`
- one attempt per task
- `smoke-fast` preset for first feedback

Direct Codex mode deliberately passes `OPENAI_CODEX_OAUTH_TOKEN` into the task container. That is acceptable for controlled local iteration on a trusted machine; it is not the preferred posture for shareable benchmark runs.

## Clean benchmark auth posture

Gateway mode keeps provider secrets out of DeepSWE containers. It should be used for clean/shareable benchmark posture once the gateway endpoint is compatible with Pier's filtered egress proxy.

The important trap: many DeepSWE tasks set `allow_internet = false`. Pier routes those agent containers through a filtered Squid proxy whose default safe ports are HTTP/80 and HTTPS/443. A local gateway such as `http://host.docker.internal:4000` can be healthy from the host while still unreachable from the task container through Pier's proxy.

Runner behavior:

- gateway mode remains the default auth posture;
- if selected tasks use filtered agent internet and `--gateway-url` uses a port other than `80` or `443`, the runner fails before build/Pier/model spend;
- `--allow-filtered-gateway-port` is an escape hatch only for a customized Pier proxy that permits the chosen port.

Use one of these fixes for no-secret runs:

- expose the auth gateway on port `80` or `443` and pass that `--gateway-url`;
- customize Pier's proxy safe ports and pass `--allow-filtered-gateway-port`;
- use `--no-gateway` only for controlled local iteration.

## Presets

### `smoke-fast`

`smoke-fast` maps to:

```text
anko-default-function-arguments
```

Use it for first feedback and runner hardening. It is still a real DeepSWE task, so it can require substantial Docker storage and model tokens.

### `product-long`

`product-long` is for broader product behavior evaluation after smoke and small pilot runs are stable. Do not start with it when validating runner changes.

## Task checkout

The DeepSWE task checkout is external repo data and should not be committed here.

Expected local layout:

```text
deep-swe/tasks/<task-id>/task.toml
```

If missing, recreate it:

```bash
git clone https://github.com/datacurve-ai/deep-swe
```

The repository ignores `/deep-swe/` to avoid accidentally committing that checkout.

## Preflight behavior

The runner fails early for known non-productive cases.

### Direct Codex token guard

For `--no-gateway` with `openai-codex/*`, one of these must be present:

- `OPENAI_CODEX_OAUTH_TOKEN` in the runner environment;
- `--env OPENAI_CODEX_OAUTH_TOKEN=...`.

The error intentionally mentions both options.

### Gateway port guard

For filtered DeepSWE agent tasks, gateway ports other than `80` and `443` fail before spend unless `--allow-filtered-gateway-port` is set.

### Storage guard

Before a real run, the runner compares selected task `environment.storage_mb` against free host/Docker backing disk space near `--jobs-dir`.

If the preflight fails, prefer freeing Docker/host disk. For controlled local smoke runs, `--override-storage-mb <N>` can be used when the task is known to fit in a smaller environment. `--allow-low-disk` skips only this preflight and should be rare.

### Job collision guard

Real runs fail if either the Pier job dir or `_bench/<jobName>` already contains artifacts. Reusing job names can merge old trials with new output and corrupt interpretation.

Use a fresh `--job-name`. Use `--allow-existing-job-dir` only for intentional diagnosis.

## Durable artifacts

For job `example`, expect:

```text
runs/deepswe/example/
  result.json
  <trial>/result.json
  <trial>/agent/omp.txt
  <trial>/verifier/reward.json
  <trial>/verifier/ctrf.json
  <trial>/artifacts/model.patch
runs/deepswe/_bench/example/
  run.json
  runner.log
  pier.log
  models.yml
  report.md
```

Important properties:

- `run.json` contains run shape, not token/provider env values.
- `runner.log` records runner lifecycle events: manifest write, Pier spawn, signals, report writes, report-only recovery.
- `pier.log` captures Pier stdout/stderr.
- `report.md` is atomically written and periodically refreshed during long runs.
- final summaries print all artifact paths regardless of pass/fail/error/interruption.

Generated run output under `/runs/` is ignored and should not be committed.

## Report-only recovery

Use report-only when a run already wrote Pier results but the wrapper died, was interrupted, or the report needs to be regenerated after parser improvements.

By job name:

```bash
bun --cwd=packages/deepswe-bench run src/runner.ts \
  --report-only \
  --job-name deepswe-codex-low-smoke-fast
```

By explicit Pier job dir:

```bash
bun --cwd=packages/deepswe-bench run src/runner.ts \
  --report-only \
  --job-dir ../../runs/deepswe/deepswe-codex-low-smoke-fast
```

Report-only must not build tarballs, write model config, start Docker, start Pier, hit the gateway, or spend model tokens.

## Interpreting report rows

The report table includes:

```text
result | reward | f2p | p2p | partial | apply_failed | exception | cost | tokens in/cache/out | duration | patch bytes | detail
```

Classification rules:

- if verifier reward exists, it controls `pass` vs `fail`;
- a reward below 1 is a scored `fail`, even if Pier also records an exception;
- if no reward exists and exception info exists, the row is an `error`;
- `exception` shows Pier exception type when present;
- `detail` prefers agent error, then infrastructure hints, then normalized exception detail, then verifier output.

Useful distinctions:

- `fail` with reward/f2p/p2p/partial means the verifier ran and produced model-quality signal.
- `error` with no reward usually means harness, infrastructure, setup, auth, or agent execution failed before scoring.
- `NonZeroAgentExitCodeError` with reward can still be a scored model failure.
- `exit 137` is normalized as `agent killed (exit 137)`.
- `infrastructure: no space left on device` points at Docker/host storage, not model quality.

## Interrupt behavior

SIGINT/SIGTERM handling should:

- record the signal in `runner.log`;
- forward the same signal once to Pier;
- avoid `process.exit()` inside the signal handler;
- let cleanup write a final `status: interrupted` report when possible.

If Pier does not finish writing all expected outputs, use report-only after it settles.

## Verification commands

Static checks:

```bash
bun --cwd=packages/deepswe-bench run check
bun --cwd=packages/deepswe-bench run lint
python3 -m py_compile packages/deepswe-bench/agent/omp_pier_local.py
rm -rf packages/deepswe-bench/agent/__pycache__
```

Gateway preflight smoke:

```bash
bun --cwd=packages/deepswe-bench run src/runner.ts \
  --tasks-path ./deep-swe/tasks \
  --model openai-codex/gpt-5.5 \
  --preset smoke-fast \
  --dry-run
```

Expected: non-zero exit mentioning gateway port `4000` and Pier filtered egress safe ports `80`/`443`.

Direct Codex dry run:

```bash
OPENAI_CODEX_OAUTH_TOKEN=dummy \
bun --cwd=packages/deepswe-bench run src/runner.ts \
  --tasks-path ./deep-swe/tasks \
  --model openai-codex/gpt-5.5 \
  --preset smoke-fast \
  --no-gateway \
  --dry-run
```

Expected: command shape shows `anko-default-function-arguments`, `openai-codex/gpt-5.5`, local Pier agent import, and low thinking; token value is not printed.

Real smoke minimum evidence:

- root job `result.json` exists;
- trial `result.json` exists;
- `_bench/<job>/run.json`, `runner.log`, `pier.log`, and `report.md` exist;
- report includes reward/f2p/p2p/partial/cost/tokens/exception columns;
- reward `0` is acceptable if the verifier produced a score and artifacts were preserved.

## Cleanup policy

Safe cleanup:

- remove ignored generated `runs/deepswe/<job>` and `runs/deepswe/_bench/<job>` after extracting needed reports;
- remove local `deep-swe/` checkout when no longer needed; it is recoverable by clone;
- remove stale benchmark containers that clearly belong to the job under investigation.

Avoid by default:

- global Docker volume prune;
- global Docker system prune;
- deleting unrelated ignored `runs/` directories.

Those can remove unrelated user data. Use them only with explicit operator intent.
