# DeepSWE Bench

Run [DeepSWE](https://github.com/datacurve-ai/deep-swe) through [Pier](https://github.com/datacurve-ai/pier) against the local `omp` coding-agent build.

This package mirrors `packages/terminal-bench` but uses Pier because DeepSWE v1.1 grades in a separate verifier environment and Pier exposes the installed-agent/network-allowlist behavior DeepSWE depends on.

## What it does

- Validates a local DeepSWE checkout (`deep-swe/tasks`, not a single task directory).
- Launches `pier run` with a custom Pier installed agent: `omp_pier_local:OmpPierLocal`.
- Installs OMP inside each task container using one of three modes:
  - `local`: packs `packages/coding-agent` with `bun pm pack` and installs that tarball.
  - `published`: installs `@oh-my-pi/pi-coding-agent` from npm.
  - `binary`: uploads a self-contained OMP binary and avoids Bun/npm setup inside the task container.
- Supports two auth postures:
  - fast local iteration with direct provider/Codex credentials forwarded into the task container;
  - no-secret gateway mode through `omp auth-gateway`, when the gateway is reachable from Pier's filtered egress proxy.
- Polls Pier trial output and renders live pass/fail/reward/spend progress.
- Writes durable `_bench/<jobName>/run.json`, `runner.log`, `pier.log`, and `report.md` artifacts. `report.md` is refreshed periodically during long runs and can be regenerated with `--report-only`.

## Prerequisites

```bash
git clone https://github.com/datacurve-ai/deep-swe
uv tool install datacurve-pier
```

Docker must be available for real Pier runs. Dry runs and report-only recovery do not require Pier or Docker.

Before starting Pier, the runner checks the selected task storage budget against the host/Docker backing disk space near `--jobs-dir`. The `smoke-fast` task asks DeepSWE for 20GiB, so low-disk laptops fail before any model spend. Prefer freeing Docker/host disk; for controlled local smoke runs where you have verified the task fits smaller storage, pass `--override-storage-mb <N>`. `--allow-low-disk` skips only this preflight.

## Fast local iteration: direct Codex token

Use this path first while hardening runner behavior. Defaults are intentionally low-cost: `--thinking low`, `--concurrency 1`, and the single-task `smoke-fast` preset.

```bash
OPENAI_CODEX_OAUTH_TOKEN="$(omp token openai-codex)" \
bun --cwd=packages/deepswe-bench run src/runner.ts \
  --tasks-path ./deep-swe/tasks \
  --model openai-codex/gpt-5.5 \
  --preset smoke-fast \
  --no-gateway \
  --job-name deepswe-codex-low-smoke-fast
```

Direct Codex token mode deliberately places `OPENAI_CODEX_OAUTH_TOKEN` inside the task container. That is acceptable for local controlled iteration where you own the machine and task checkout; it is not the preferred clean benchmark posture for shareable or less trusted runs. Dry-run output may show the key name, but values for token/key/secret/password-like variables are redacted.

Equivalent workspace binary, when installed/linked:

```bash
OPENAI_CODEX_OAUTH_TOKEN="$(omp token openai-codex)" \
deepswe --tasks-path ./deep-swe/tasks --preset smoke-fast --no-gateway
```

## No-secret gateway mode

Gateway mode keeps provider secrets out of DeepSWE containers. Start the local gateway before the run:

```bash
omp auth-gateway serve --bind 127.0.0.1:4000
```

The container-facing gateway URL defaults to `http://host.docker.internal:4000`, while the runner health-checks the host through `127.0.0.1:4000`.

DeepSWE tasks usually set `allow_internet = false`, so Pier routes agent traffic through its filtered egress proxy. Pier's default proxy allows only HTTP/80 and HTTPS/443. For normal filtered DeepSWE tasks, gateway mode therefore requires a gateway URL reachable on port `80` or `443`, unless your Pier proxy has been customized. The runner fails fast when selected tasks are filtered and `--gateway-url` uses another port.

Use one of these fixes for no-secret runs:

- expose the auth gateway on port `80` or `443` and pass that `--gateway-url`;
- use a Pier/proxy configuration that permits the chosen gateway port, then pass `--allow-filtered-gateway-port`;
- use direct local iteration with `--no-gateway` until the gateway deployment is ready.

If the gateway uses a token, the runner reads `OMP_AUTH_GATEWAY_TOKEN`, `PI_AUTH_GATEWAY_TOKEN`, or `~/.omp/auth-gateway.token` automatically. Generated config and dry-run output redact the token value.

## No-spend dry run

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

The dry run prints the exact `pier run` argv, the generated config, and all `OMP_DEEPSWE_*` environment variables. It validates the DeepSWE tasks directory but does not pack OMP, start Pier, create Docker containers, or spend model tokens.

## Job and storage safety

Real runs fail fast if either the Pier job directory or `_bench/<jobName>` already contains artifacts. Reusing a job name can merge old trial rows with a new Pier process and hide the real failure. Use a fresh `--job-name`, move/remove the old artifacts, or pass `--allow-existing-job-dir` only for intentional diagnosis.

Storage preflight uses the selected task `environment.storage_mb`, the runner concurrency, and the free space visible near `--jobs-dir`. It is intentionally conservative: the DeepSWE task image, Docker overlay, verifier artifacts, agent logs, and patches all consume space before scoring. If it reports a 20GiB task on a smaller host disk, fix the disk first or use a smaller `--override-storage-mb` for local-only iteration.

## Presets

### `smoke-fast`

`--preset smoke-fast` expands to:

```text
anko-default-function-arguments
```

This task was selected for fast feedback because local DeepSWE metadata shows it is a feature request with 147 instruction words, 3 solution files / 442 solution delta lines, and 4 test files / 105 test delta lines. It is the lowest rough expected-effort feature/bug task found in the checkout.

### `product-long`

`--preset product-long` expands to the long-horizon product/feature DeepSWE tasks selected during runner planning:

```text
arcane-drift-detection-baselines
fastapi-deprecation-response-headers
updo-policy-alerting
ofetch-per-origin-circuit-breaker
kgateway-consistent-hash-policy
prometheus-transactional-reload-status
mnamer-daemon-watch-lifecycle
clack-async-autocomplete-options
effect-sse-httpapi-streaming
drizzle-orm-window-function-builders
```

These tasks emphasize multi-file product behavior, API/runtime semantics, feature configuration, and broad test surfaces rather than compiler-only or algorithm-only work. Use `product-long` only after single-task and three-task pilots are stable.

## Direct provider mode

Direct-auth mode forwards only the provider API variables needed for the selected provider into the in-container OMP process. For non-Codex OpenAI-compatible runs:

```bash
OPENAI_API_KEY=... bun --cwd=packages/deepswe-bench run src/runner.ts \
  --tasks-path ./deep-swe/tasks \
  --model openai/gpt-5.5 \
  --no-gateway \
  --include-task-name anko-default-function-arguments
```

For `openai-codex/*` direct mode, provide the token in the runner environment or explicitly with `--env`:

```bash
OPENAI_CODEX_OAUTH_TOKEN="$(omp token openai-codex)" \
bun --cwd=packages/deepswe-bench run src/runner.ts \
  --tasks-path ./deep-swe/tasks \
  --model openai-codex/gpt-5.5 \
  --preset smoke-fast \
  --no-gateway
```

The runner rejects `--no-gateway` with `openai-codex/*` unless `OPENAI_CODEX_OAUTH_TOKEN` is present in the runner environment or passed as `--env OPENAI_CODEX_OAUTH_TOKEN=...`.

## Install modes

### Local tarball (default)

```bash
bun --cwd=packages/deepswe-bench run src/runner.ts --tasks-path ./deep-swe/tasks --install local
```

This reflects current TypeScript source changes in `packages/coding-agent`, but still depends on Bun/npm network access during trial setup unless the task image already has the required artifacts cached.

### Published package

```bash
bun --cwd=packages/deepswe-bench run src/runner.ts --tasks-path ./deep-swe/tasks --install published --version latest
```

### Binary

```bash
bun --cwd=packages/deepswe-bench run src/runner.ts \
  --tasks-path ./deep-swe/tasks \
  --install binary \
  --binary-arm64 /path/to/omp-darwin-arm64 \
  --binary-x64 /path/to/omp-linux-x64
```

Binary mode uploads and chmods the matching binary inside each task container. It is preferred for stricter DeepSWE integrity checks because setup does not need outbound access to `bun.sh` or the npm registry.

## CLI flags

```text
-m, --model <provider/model>        repeatable; default openai-codex/gpt-5.5
--tasks-path <path>                 DeepSWE tasks directory; default ./deep-swe/tasks or DEEPSWE_TASKS
--preset <product-long|smoke-fast>  include a built-in task set
-l, --tasks, --n-tasks <N>          Pier task limit
-i, --include-task-name <glob>      repeatable include filter
-x, --exclude-task-name <glob>      repeatable exclude filter
-n, --concurrency <N>               Pier concurrent trials; default 1
-k, --attempts <N>                  attempts per task; default 1
--thinking <level>                  default low; pass xhigh explicitly for high-effort runs
--advisor-model <provider/model>    optional advisor spend, summed separately
--install <local|published|binary>  default local
--gateway-url <url>                 default http://host.docker.internal:4000
--gateway-token <tok>               override token; defaults to env/token file when present
--allow-filtered-gateway-port       escape hatch only for customized Pier proxies
--no-gateway                        direct provider/Codex token mode
--web-search                        enable OMP web_search; off by default
--allow-low-disk                    skip host/Docker backing disk preflight
--allow-existing-job-dir            allow appending to an existing job; diagnostic only
--report-only                       rebuild report.md from an existing job and exit
--job-dir <path>                    existing Pier job directory for --report-only
--report-interval-sec <N>           periodic report snapshot interval; default 30
--dry-run                           print Pier argv and generated config only
```

Use `-- --pier-flag value` to append raw Pier arguments after the runner's generated arguments.

The runner forwards safe host `PI_*` settings into the in-container OMP process and defaults `PI_NATIVE_VARIANT=baseline` for DeepSWE's common linux/amd64 images under Apple Silicon emulation. Override it explicitly with `--env PI_NATIVE_VARIANT=modern` on a native x64 Docker host if you want the faster native addon variant.

## Outputs

For a job named `deepswe-codex-low-smoke-fast`:

```text
runs/deepswe/deepswe-codex-low-smoke-fast/
  result.json
  <trial>/result.json
  <trial>/agent/omp.txt
  <trial>/verifier/reward.json
  <trial>/verifier/ctrf.json
  <trial>/artifacts/model.patch
runs/deepswe/_bench/deepswe-codex-low-smoke-fast/
  run.json
  runner.log
  pier.log
  models.yml
  report.md
```

`report.md` summarizes the externally observable DeepSWE outcome: reward, f2p, p2p, partial credit, apply failure, exception type, patch size, token usage, spend, and agent/verifier failure hints. The runner writes it atomically during the run and once more during cleanup, including interrupted or error exits.

Regenerate a report without Docker/Pier/model spend:

```bash
bun --cwd=packages/deepswe-bench run src/runner.ts \
  --report-only \
  --job-name deepswe-codex-low-smoke-fast
```

You can also point at a job dir directly:

```bash
bun --cwd=packages/deepswe-bench run src/runner.ts \
  --report-only \
  --job-dir ../../runs/deepswe/deepswe-gpt55-direct-smoke-2
```

## Report interpretation example

The first useful local direct Codex data point for `clack-async-autocomplete-options` reported reward `0`, f2p `0.0`, p2p `1.0`, partial `0.8869`, input/cache/output tokens around `568k/502k/15k`, cost about `$1.04`, and exception `NonZeroAgentExitCodeError` with exit `137`.

Interpretation: this is a scored failure after the agent was killed, not a harness setup failure. The verifier produced partial-credit metrics, so the row should be read as "agent made progress but did not solve the task before termination."

## Broad eval mode

Run broad product evaluations only after `smoke-fast` and a small three-task pilot are stable:

```bash
OPENAI_CODEX_OAUTH_TOKEN="$(omp token openai-codex)" \
bun --cwd=packages/deepswe-bench run src/runner.ts \
  --tasks-path ./deep-swe/tasks \
  --model openai-codex/gpt-5.5 \
  --preset product-long \
  --thinking xhigh \
  --concurrency 1 \
  --no-gateway \
  --job-name deepswe-codex-product-long
```

Use no-secret gateway mode instead of `--no-gateway` when the gateway is reachable on port `80` or `443`.

## Checks

```bash
bun --cwd=packages/deepswe-bench run check
bun --cwd=packages/deepswe-bench run lint
python3 -m py_compile packages/deepswe-bench/agent/omp_pier_local.py
OPENAI_CODEX_OAUTH_TOKEN=dummy \
bun --cwd=packages/deepswe-bench run src/runner.ts \
  --tasks-path ./deep-swe/tasks \
  --model openai-codex/gpt-5.5 \
  --preset smoke-fast \
  --no-gateway \
  --dry-run
```
