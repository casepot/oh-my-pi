# Rust Maintainer Benchmark

The Rust maintainer benchmark evaluates whether an agent can make small Rust maintenance changes while preserving the observable behavior and maintenance boundaries of a fixture crate or workspace.

It is not a general Rust performance benchmark. It is a coding-agent benchmark: each fixture gives the agent an input Rust project plus a maintainer-style prompt, runs the agent against that project, then verifies the edited project with structured checks.

## Goals

The benchmark is intended to measure:

- Rust maintenance behavior under realistic edit constraints.
- Ability to read and modify an existing crate or workspace.
- Ability to satisfy compiler, formatter, and test feedback.
- Ability to make the intended change without touching unrelated files.
- Exact reproduction quality as a diagnostic, not as the primary success condition for non-deterministic tasks.
- Agent cost and workflow shape: tokens, duration, tool calls, edit failures, and edit autocorrections.

The benchmark is not intended to reward hidden exact-text reconstruction. For most tasks, many Rust implementations can be behaviorally valid. Exact matching is therefore reserved for deterministic surgical fixtures and otherwise reported as preferred quality information.

## Running the benchmark

From the repository root:

```sh
bun run bench:rust [options]
```

Common commands:

```sh
bun run bench:rust --list
bun run bench:rust --check-fixtures
bun run bench:rust --model openai-codex/gpt-5.5 --thinking low --runs 1 --task-concurrency 1
```

Useful options:

| Option | Meaning |
|---|---|
| `--model <id>` | Model id. Defaults to the package default in `src/index.ts`. |
| `--provider <id>` | Provider id. Defaults to the prefix before `/` in the model id, or `anthropic`. |
| `--thinking <level>` | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `--runs <n>` | Number of runs per task. Defaults to `1`. |
| `--task-concurrency <n>` | Number of task runs to execute concurrently. |
| `--timeout <ms>` | Agent run timeout. |
| `--verification-timeout <ms>` | Timeout for each Cargo/rustfmt verification command. |
| `--tasks <ids>` | Comma-separated task id filter. |
| `--max-tasks <n>` | Run a deterministic sample of at most `n` tasks when no explicit task filter is provided. |
| `--fixtures <path>` | Override the fixture directory. |
| `--format <markdown\|json>` | Report format. |
| `--output <file>` | Report output path. Conversation dumps are written beside this path. |
| `--require-edit-tool-call` | Treat a passing verification as failed if no edit tool call was observed. |
| `--require-read-tool-call` | Treat a passing verification as failed if no read tool call was observed. |
| `--check-fixtures` | Validate fixture structure and verify every expected tree. |
| `--list` | List fixture ids and comparable files. |

## Fixture layout

Fixtures live under `packages/rust-maintainer-benchmark/fixtures/`.

Each fixture directory has this shape:

```text
<fixture-id>/
  metadata.json
  prompt.md
  input/
    Cargo.toml
    src/...
  expected/
    Cargo.toml
    src/...
```

`input/` is copied into a temporary run directory before the agent starts. The agent edits that copy. `expected/` is the reference implementation used for exact-match diagnostics and fixture self-checking.

`prompt.md` is the user-facing maintenance request shown to the agent. Important behavior contracts should be visible in prompt text, source tests, or compiler feedback. The benchmark should not depend on hidden exact-text hints for non-surgical tasks.

## Metadata

`metadata.json` defines categorization, difficulty, crate root, and verification policy.

Example:

```json
{
  "category": "error-handling",
  "difficulty": "medium",
  "difficulty_score": 4,
  "crate_root": ".",
  "file_path": "src/lib.rs",
  "verification": {
    "rustfmt": true,
    "exact_match": "preferred",
    "allowed_changed_files": ["src/lib.rs"],
    "commands": [
      { "name": "cargo check", "args": ["check", "--color", "never"] },
      { "name": "cargo test", "args": ["test", "--lib", "--color", "never"] }
    ]
  }
}
```

Supported categories:

- `surgical`
- `compiler-repair`
- `error-handling`
- `api-migration`
- `workspace-migration`

Supported difficulties:

- `easy`
- `medium`
- `hard`
- `nightmare`

`exact_match` modes:

| Mode | Meaning |
|---|---|
| `required` | Exact file comparison is required for success. Reserved for deterministic surgical fixtures. |
| `preferred` | Exact file comparison is reported but does not fail a behaviorally valid run. |
| `disabled` | No exact-match check is recorded. |

`allowed_changed_files` is a required-boundary mechanism when present. Any changed comparable file outside that list fails the run even if Cargo checks pass.

`commands` are Cargo commands run after metadata and exact-match diagnostics. If omitted, the loader defaults to `cargo check --color never` and `cargo test --lib --color never`.

## Execution model

For each selected task and each requested run:

1. The benchmark copies `input/` into a run directory under `runs/`.
2. It starts an in-process coding-agent session in that copied project.
3. The benchmark appends fixture-specific benchmark instructions and sends `prompt.md` as the user task.
4. The agent can use the benchmark tool allowlist, currently read/edit/write/bash-oriented maintenance tools.
5. After the agent stops, the benchmark verifies the edited project.
6. The run result records verification checks, changed files, diff information, token usage, duration, tool calls, edit failures, edit warnings, and autocorrection counts.
7. The benchmark summarizes runs by task, category, difficulty, and whole-suite totals.

Each run receives isolated benchmark settings. Memory and autolearn are disabled for benchmark sessions so later tasks do not inherit prior benchmark prompts or completions through local memory:

- `memory.backend = "off"`
- `memories.enabled = false`
- `autolearn.enabled = false`

The benchmark still uses an in-memory session manager for each run.

## Verification model

Verification produces a vector of checks. Final run success is based on required checks only:

```text
success = every failed check has required === false
```

The current check kinds are:

| Kind | Check | Required? | Purpose |
|---|---|---:|---|
| `metadata` | `allowed changed files` | yes | Fails changes outside `allowed_changed_files`. |
| `exact` | `exact match` | depends on fixture mode | Required only for `exact_match: "required"`; diagnostic for `preferred`. |
| `cargo` | `cargo fmt` | yes, when `rustfmt` is true | Enforces rustfmt cleanliness. |
| `cargo` | fixture command, e.g. `cargo check` | yes | Compiler/type/API validation. |
| `cargo` | fixture command, e.g. `cargo test` | yes | Behavioral validation. |

All verification layers run even after an earlier required check fails. This is intentional: reports should show whether a run only missed exact text, only touched an extra file, only failed formatting, or also failed compile/tests.

Exact-match diagnostics preserve compact diff and diff stats when files differ.

## Scoring and reporting

The primary score is task success rate:

```text
successful tasks / total tasks
```

A task succeeds if at least one non-ghost run succeeds. With `--runs 1`, this is one-shot success. With multiple runs, the report also exposes flakiness and one-shot success metrics.

The report includes:

- configuration: provider, model, thinking level, run count, timeouts, concurrency;
- summary: total tasks, completed runs, successful runs/tasks, success rate, flaky tasks, token and duration aggregates;
- exact-match summary: required exact failures, preferred exact mismatches, allowed changed-file failures;
- Rust check failures: Cargo failures only;
- category and difficulty summaries;
- failed task details with exact status, failed check names, Cargo output excerpt, and diff when available;
- task table with status, category, difficulty, changed files, exact status, checks, tokens, duration, and tool-call counts.

JSON output contains the same run and summary data in machine-readable form.

## Current fixture set

Current built-in fixtures:

| Fixture | Category | Exact policy | Purpose |
|---|---|---|---|
| `api-slice-param-001` | `api-migration` | preferred | Change a `&Vec<String>`-style API to accept slices without forcing allocation. |
| `compiler-move-after-iter-001` | `compiler-repair` | preferred | Repair ownership after consuming an iterator without cloning. |
| `error-unwrap-to-result-001` | `error-handling` | preferred | Replace panic/unwrap behavior with typed error handling. |
| `surgical-bounds-inclusive-001` | `surgical` | required | Deterministic inclusive-bound one-line edit. |
| `workspace-user-id-newtype-001` | `workspace-migration` | preferred | Migrate a workspace from raw user id strings to a `UserId` newtype. |

The non-surgical fixtures use preferred exact matching because there are multiple valid Rust implementations. The surgical fixture uses required exact matching because the expected change is deterministic.

## Fixture validation

`bun run bench:rust --check-fixtures` performs two stages:

1. Static fixture validation through `validateFixturesFromDir`.
2. Expected-tree verification by running `verifyRustTask(task, { actualDir: task.expectedDir, ... })` for every fixture.

Static validation checks:

- `prompt.md` exists and is not empty;
- `input/` and `expected/` exist;
- `metadata.json` exists, parses, and uses known categories, difficulties, exact-match modes, and command shapes;
- `crate_root` exists in both `input/` and `expected/`;
- every `allowed_changed_files` entry exists in `expected/`;
- generated artifacts are not committed under `input/` or `expected/`:
  - `Cargo.lock`
  - `target/`
  - `.cargo-target/`
  - `.git/`
- `exact_match: "required"` is used only for `category: "surgical"`;
- exact-required Rust fixtures do not contain `Benchmark fixture rationale` comments.

Expected-tree verification then ensures each expected fixture still passes its own exact, rustfmt, and Cargo checks.

## Recent live smoke result

A live one-run smoke with `openai-codex/gpt-5.5`, low thinking, and task concurrency 1 produced:

```text
Completed: 5/5
Successful tasks: 5/5
Required exact-match failures: 0
Preferred exact-match mismatches: 3
Allowed changed-file failures: 0
Rust check failures: 0
```

That result demonstrates the intended current scoring behavior: non-surgical tasks can pass behavioral verification while still recording preferred exact mismatches.

The same smoke's conversation dumps contained no `<memories>` blocks, which validates the benchmark memory-isolation path for that run.

## Current limitations

### The primary reward is still sparse

The benchmark now records a richer diagnostic vector, but final correctness is still mostly binary: all required checks pass or they do not. A passing solution, a minimal idiomatic passing solution, and a sloppy but passing solution all receive the same primary success result.

### Cargo checks are coarse

`cargo fmt`, `cargo check`, and `cargo test` are command-level checks. The report does not currently convert individual test cases, compiler errors, panic causes, or assertion failures into structured sub-scores.

Two runs can both be reported as `cargo test failed` even if one missed a single edge case and the other has broad semantic breakage.

### Passing solution quality is under-scored

The benchmark records changed files, diff stats, tokens, duration, tool calls, and exact status, but it does not yet assign a quality score for:

- idiomatic Rust API design;
- unnecessary clones or allocations;
- maintainability;
- simplicity;
- long-term extensibility;
- preserving comments or documentation when behavior does not require exact text;
- performance unless a fixture explicitly tests it.

### Small fixture set

The built-in suite currently has five fixtures. This is useful for smoke testing and regression testing, but it is not enough for robust model ranking. A model can look strong or weak because of a small number of task-specific interactions.

### Single-run results are not reliability results

With `--runs 1`, the report is a one-shot result. It does not measure variance, flakiness, or consistency. Multiple runs are required to interpret reliability.

### Exact matching is only a proxy

Preferred exact matching can identify divergence from the expected solution, but it is not semantic quality. A preferred mismatch may be better, worse, or equivalent to the expected tree.

### Hidden expected trees still exist

Expected trees are necessary for exact diagnostics and fixture self-checking. For non-surgical tasks, they should not decide pass/fail, but they can still shape benchmark interpretation if reviewers over-focus on preferred exact mismatch counts.

### Fixture contracts determine correctness

If a fixture's visible tests and commands under-specify the intended behavior, the benchmark cannot infer missing contracts. The score is only as accurate as the fixture's prompt, tests, metadata, and verification commands.

## Future directions

### Add contract-level checks

Split broad `cargo test` commands into named behavior checks when a fixture has separable contracts.

Example direction:

```json
"commands": [
  { "name": "cargo test parses_valid_port", "args": ["test", "parses_valid_port", "--lib", "--color", "never"] },
  { "name": "cargo test reports_missing_port", "args": ["test", "reports_missing_port", "--lib", "--color", "never"] },
  { "name": "cargo test reports_invalid_port_message", "args": ["test", "reports_invalid_port_message", "--lib", "--color", "never"] }
]
```

This would let the benchmark report partial behavioral progress instead of a single `cargo test failed` bucket.

### Introduce explicit contract metadata

Add optional metadata describing each scored contract:

```json
"contracts": [
  { "id": "valid-port", "check": "cargo test parses_valid_port", "required": true },
  { "id": "missing-port-error", "check": "cargo test reports_missing_port", "required": true },
  { "id": "exact-text", "check": "exact match", "required": false }
]
```

Reports could then distinguish behavior, metadata, exactness, and efficiency more clearly.

### Add negative controls

For each fixture, maintain known-bad outputs that must fail verification. Examples:

- panicking `parse_config` should fail the error-handling fixture;
- `&Vec<String>`-only API should fail the slice fixture;
- raw `String` user ids should fail the newtype fixture;
- off-by-one comparison should fail the surgical fixture;
- extra changed files should fail allowed-file validation.

Negative controls prove that the reward catches the intended mistakes.

### Expand fixture coverage

Add more fixtures per category and difficulty. Good additions would cover:

- lifetimes and borrowing repairs;
- trait-bound/API ergonomics;
- async error propagation;
- workspace dependency boundaries;
- feature flags;
- serde/data migration;
- macro-adjacent maintenance;
- no-std or constrained API changes;
- performance-sensitive ownership repairs.

### Use repeated-run statistics for model comparison

For model ranking, prefer multiple runs per task and report:

- pass rate by task;
- pass rate by category/difficulty;
- confidence intervals;
- one-shot success;
- consistency/flake rate;
- median tokens and duration among successful runs.

### Score passing-run quality without making exact text primary

Introduce non-required quality metrics for passing runs:

- changed file count;
- changed line count;
- preferred exact status;
- token budget;
- duration;
- edit autocorrection count;
- tool call count;
- warning count;
- optional fixture-specific quality checks.

These should be reported as dimensions, not collapsed into a hidden scalar that rewards exact-text reproduction.

### Parse failure causes more structurally

Improve reporting by classifying failures:

- rustfmt failure;
- compiler/type error;
- borrow checker error;
- missing item/API;
- test assertion failure;
- panic;
- timeout;
- tool/transport failure.

This would make aggregate reports more informative than command-name failure counts.

### Keep memory-isolation checks visible

The benchmark now disables memory/autolearn for sessions. Future report metadata could explicitly include memory-isolation configuration and optionally scan dumps for `<memories>` blocks during smoke runs.

## Interpretation guidance

Use the current benchmark as:

- a fixture regression suite;
- a behavioral smoke test for Rust maintenance agents;
- a way to compare exact-reproduction pressure against behavioral correctness;
- a diagnostic source for tool use, tokens, duration, and failure layers.

Do not treat the current benchmark as:

- a statistically robust model leaderboard;
- a dense reinforcement-learning reward;
- a complete Rust quality judge;
- proof that a passing solution is the best maintainable solution.

A good benchmark result today means:

```text
The agent satisfied the fixture's required observable contracts under isolated benchmark conditions.
```

It does not yet mean:

```text
The agent produced the most idiomatic, maintainable, minimal, or performant Rust solution.
```
