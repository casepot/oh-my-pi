# Upstream Sync Command

Synchronize the `casepot/oh-my-pi` fork with `can1357/oh-my-pi` upstream.

## Arguments

- `$ARGUMENTS` — optional flags or maintainer notes.
  - `--check`: read-only preflight + forecast. NEVER merge, commit, or push.
  - `--no-push`: merge, resolve, verify, and commit; stop before push.
  - Other text: human instructions. Follow only when they do not weaken safety gates.

Default behavior: full sync, commit, and push to `origin main`.

## Required first step

Read `skill://omp-fork-maintenance` before acting. Treat that skill as authoritative for topology, invariants, verification, commit, and push rules.

## Operating principles

- Treat upstream changes as generally correct.
- Preserve fork behavior only where intentional divergence exists.
- Keep `omp update` as the install/source update command.
- Use todo tracking for preflight, forecast, merge, resolution, verification, commit, and push.
- Use `task` subagents for decomposable conflict-resolution/editing surfaces.
- Subagents edit only assigned files; the orchestrator runs verification.
- NEVER stash, reset, or discard unrelated user work.
- NEVER suppress tests, skip required gates, or hide failures.
- NEVER push unless every required gate passes.

## Abort before mutation

Stop with an explicit blocker before any merge or file mutation if:

- Current branch is not `main`.
- `origin` does not normalize to `casepot/oh-my-pi`.
- `upstream` does not normalize to `can1357/oh-my-pi`.
- `git fetch origin main` or `git fetch upstream main` fails.
- `main...origin/main` is not `0 0`.
- Merge, rebase, cherry-pick, or revert state is active.
- Dirty tracked files are not explicitly classified as unrelated user work.
- `origin/main...upstream/main` shows upstream-ahead count `0`.

## Workflow

### 1. Preflight

Run the skill topology checks:

```sh
git branch --show-current
git remote get-url origin
git remote get-url upstream
git status --short
git fetch origin main
git fetch upstream main
git rev-list --left-right --count main...origin/main
git rev-list --left-right --count origin/main...upstream/main
```

Interpret `origin/main...upstream/main` as `fork-ahead upstream-ahead`.

If `$ARGUMENTS` contains `--check`, continue through forecast and report; NEVER merge, commit, or push.

### 2. Forecast conflicts

Preview the merge:

```sh
git merge-tree --write-tree --name-only origin/main upstream/main
```

List conflict files and high-risk surfaces before merging. Classify upstream changes by:

- source core;
- session/UI;
- workflow;
- docs;
- tests/metadata.

High-risk files:

- `.github/workflows/ci.yml`
- `packages/coding-agent/src/config/settings-schema.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/task/executor.ts`
- docs and tests that encode fork policy

### 3. Merge without committing

```sh
git merge --no-commit upstream/main
```

Preserve upstream by default, then re-apply fork invariants explicitly.

### 4. Resolve and enforce fork invariants

Required invariants:

- Source install/update topology remains fork-first.
- Startup fork/source divergence notification stays in the existing update notification path.
- npm publish remains guarded to `github.repository_owner == 'can1357'`.
- User/home discovery default remains opt-in/false.
- User MCP config default remains opt-in/false.
- Subagent parent-model auth fallback default remains opt-in/false.
- `contextPromotion` / `contextPromotionTarget` stay removed.
- Project skillsets remain present.
- Package names stay `@oh-my-pi/*`.

Fan out subagents by disjoint surfaces when useful: source core, session/UI, workflow, docs, tests/metadata. Do not let subagents verify, format, commit, or push.

### 5. Verify centrally

Before commit/push, require:

```sh
git diff --check
git diff --name-only --diff-filter=U
bun --cwd=packages/coding-agent test <focused affected tests>
bun run check
bun run test
bun run ci:test:smoke
```

Required outcomes:

- No unmerged paths.
- No conflict markers.
- Focused affected tests pass first.
- `bun run check` passes.
- `bun run test` passes.
- `bun run ci:test:smoke` passes.

Abort before commit/push if any required gate fails or cannot run.

### 6. Commit

Stage only intended merge files. Exclude unrelated user dirt.

Use a focused upstream-sync message, for example:

```text
chore: sync fork with upstream
```

Do not include unrelated local work.

### 7. Push

Push only to `origin main` unless `$ARGUMENTS` contains `--no-push`.

```sh
git push origin main
```

After push, confirm:

```sh
git rev-list --left-right --count main...origin/main
git rev-list --left-right --count origin/main...upstream/main
```

Required final state:

- `main...origin/main = 0 0`.
- `origin/main...upstream/main = <fork-ahead> 0`.

## Final blocker rule

If safe completion is impossible, stop only after reporting the exact blocker, the command/output that proved it, and the completed non-mutating checks. NEVER present a partial sync as complete.
