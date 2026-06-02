---
name: omp-fork-maintenance
description: Maintain the casepot fork-backed OMP install/update workflow: local Bun source link, fork/upstream remotes, source checkout updater, startup divergence banner, verification, commit, and push rules.
---

# OMP Fork Maintenance

Maintain the current `casepot/oh-my-pi` fork-backed install/update workflow without rediscovering its topology.

## When to use

Use this skill for:

- `omp update` behavior.
- Installer changes in `scripts/install.sh` or `scripts/install.ps1`.
- Local `omp` install/link problems.
- Fork/upstream/local divergence questions.
- Startup update/divergence banner behavior.
- Release workflow questions for fork builds.

## Current topology

- `origin` = `https://github.com/casepot/oh-my-pi.git`.
- `upstream` = `https://github.com/can1357/oh-my-pi.git`.
- Plain `git push` from `main` pushes to the fork.
- The local `omp` command is expected to resolve through Bun into this checkout.
- `bun run install:dev` is the local relink workflow.
- Keep imports and package names as `@oh-my-pi/*`; do not migrate to a personal npm scope.

## Install channels

### Local dev link

- Run `bun run install:dev` from the repo root.
- The script runs `bun install`, then links `packages/coding-agent` and `packages/ai`.
- Verify the active command with `type -a omp`; resolve symlinks when the path is ambiguous.

### Source installs

- POSIX default source checkout: `${XDG_DATA_HOME:-$HOME/.local/share}/omp/source/oh-my-pi`.
- Windows default source checkout: `%LOCALAPPDATA%\omp\source\oh-my-pi`.
- `OMP_SOURCE_DIR` or `PI_SOURCE_DIR` overrides the durable source checkout.
- Source install refuses non-empty non-checkout targets.
- Source install refuses dirty existing checkouts.
- Source install sets `origin` to the fork and `upstream` to the original repo.
- Source install runs `bun install`, then links `packages/coding-agent` and `packages/ai`.

### Binary installs

- Binary installs use GitHub release assets from the fork.
- Fork release assets are safe because workflow asset URLs use `${{ github.repository }}`.
- npm publish is guarded to upstream owner `can1357`; personal fork releases must not publish npm packages.

## Update path map

- Installer defaults: `scripts/install.sh`, `scripts/install.ps1`.
- Runtime update command: `packages/coding-agent/src/cli/update-cli.ts`.
- Install/source status: `packages/coding-agent/src/update/source-status.ts`.
- Startup check call site: `packages/coding-agent/src/main.ts`.
- Startup notification rendering: `packages/coding-agent/src/modes/utils/ui-helpers.ts`.
- Fork release/publish safety: `.github/workflows/ci.yml`.

## Divergence semantics

- Dirty source checkout = uncommitted local changes; refuse source update.
- Local vs fork uses `HEAD...origin/<branch>`.
- Local behind fork = update available.
- Local ahead fork = local commits not pushed.
- Local ahead and behind fork = divergent; reconcile before update.
- Fork vs upstream uses `origin/<branch>...upstream/<branch>`.
- Fork behind upstream is informational; source installs track fork first.
- Startup banner appears only when update/divergence state is relevant.
- Startup banner is capped to four short status lines.
- Show startup update information only through the existing update notification path.

## Operational workflows

### Check install target

```sh
type -a omp
omp --version
omp --smoke-test
```

If `omp` is not this checkout, run:

```sh
bun run install:dev
```

### Check repo topology

```sh
git remote -v
git status --short
git rev-list --left-right --count main...origin/main
git rev-list --left-right --count origin/main...upstream/main
```

Interpret counts as `left right`:

- `main...origin/main`: left = local-ahead, right = fork-ahead.
- `origin/main...upstream/main`: left = fork-ahead, right = upstream-ahead.

### Upstream sync workflow

Use for `/upstream-sync` and maintainer fork catch-up.

#### Preflight

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

- `origin` MUST normalize to `casepot/oh-my-pi`.
- `upstream` MUST normalize to `can1357/oh-my-pi`.
- Current branch MUST be `main`.
- Refuse in-progress merge/rebase/cherry-pick.
- Refuse local/remote divergence: `main...origin/main` MUST be `0 0`.
- Refuse dirty tracked files unless explicitly unrelated user work.
- Refuse when `origin/main...upstream/main` right count is `0`.

#### Conflict forecast

```sh
git merge-tree --write-tree --name-only origin/main upstream/main
```

- List preview conflict files before merging.
- Classify upstream changes by source core, session/UI, workflow, docs, tests/metadata.
- Treat these surfaces as high risk:
  - `.github/workflows/ci.yml`
  - `packages/coding-agent/src/config/settings-schema.ts`
  - `packages/coding-agent/src/main.ts`
  - `packages/coding-agent/src/sdk.ts`
  - `packages/coding-agent/src/task/executor.ts`
  - docs and tests that encode fork policy

#### Merge execution

```sh
git merge --no-commit upstream/main
```

- Preserve upstream by default.
- Re-apply fork invariants explicitly.
- Resolve semantically; NEVER suppress tests or conflict markers.
- NEVER stash, reset, or discard unrelated user work.

#### Fork invariant checklist

- Source install/update topology remains fork-first.
- Startup fork/source divergence uses existing update notification path.
- npm publish remains guarded to `github.repository_owner == 'can1357'`.
- User/home discovery default remains opt-in/false.
- User MCP config default remains opt-in/false.
- Subagent parent-model auth fallback default remains opt-in/false.
- `contextPromotion` / `contextPromotionTarget` stay removed.
- Project skillsets remain present.
- Package names stay `@oh-my-pi/*`.

#### Resolution strategy

- Fan out disjoint surfaces with `task` subagents.
- Suggested slices: source core, session/UI, workflow, docs, tests/metadata.
- Subagents edit only assigned files.
- Subagents NEVER verify, format, commit, or push.
- Orchestrator runs all gates centrally.

#### Verification gates

```sh
git diff --check
git diff --name-only --diff-filter=U
bun --cwd=packages/coding-agent test <focused affected tests>
bun run check
bun run test
bun run ci:test:smoke
```

- No unmerged paths.
- No conflict markers.
- Focused affected tests pass first.
- All required gates MUST pass before commit/push.
- Abort if a required gate cannot run.

#### Commit and push

```sh
git rev-list --left-right --count main...origin/main
git rev-list --left-right --count origin/main...upstream/main
git push origin main
git rev-list --left-right --count main...origin/main
git rev-list --left-right --count origin/main...upstream/main
```

- Stage only intended merge files.
- Exclude unrelated user dirt.
- Commit with a focused upstream-sync message.
- Push `main` to `origin` only.
- Final `main...origin/main` MUST be `0 0`.
- Final `origin/main...upstream/main` MUST be `<fork-ahead> 0`.

#### Recurring pitfalls

- Keep `contextPromotion` removed.
- User/home source tests must opt in explicitly.
- Subagent fallback tests satisfy the fork credential gate.
- Coding-agent tests use bounded non-parallel execution here.


### Commit and push

- Preserve unrelated user work.
- Stage only files requested by the task.
- Do not stage unrelated deletions or untracked directories.
- Commit focused changes.
- Push `main` to `origin` unless the user explicitly requests another remote.

## Verification commands

For install/update/source-status changes, run:

```sh
bun --cwd=packages/coding-agent test test/update-cli.test.ts test/source-status.test.ts
bun --cwd=packages/coding-agent run check
sh -n scripts/install.sh
```

For local runtime/link verification, run:

```sh
bun run install:dev
type -a omp
omp --version
omp --smoke-test
```

For PowerShell installer edits, parse-check `scripts/install.ps1` only when `pwsh` or `powershell` is available.

## Pitfalls

- Do not use upstream npm registry as source truth for fork source updates.
- Do not rename packages to a personal npm scope.
- Do not assume upstream divergence means the local install is stale.
- Do not bypass dirty-check refusal in source updates.
- Do not duplicate startup update UI outside the existing notification location.
- Do not stage unrelated files while preserving the fork stack.
