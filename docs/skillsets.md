# Skillsets

Skillsets are project-aware activation recipes. They detect project facets (Rust, Node, Python, Go, Java, TypeScript, etc.) and then expose matching skills, rule names, and compact prompt summaries for the current session.

They do **not** replace skills:

- **Skill**: addressable content loaded on demand through `skill://<name>`.
- **Rule**: addressable local constraint loaded through `rule://<name>`.
- **Skillset**: deterministic activation layer that decides which skills/rules are relevant for the detected project.

## Detection model

OMP detects project facets by walking from `cwd` to the repository root and checking cheap root markers first:

| Facet | Root markers |
| --- | --- |
| `rust` | `Cargo.toml`, `Cargo.lock`, `rust-toolchain*`, `rustfmt.toml`, `clippy.toml` |
| `node` | `package.json`, lockfiles (`bun.lock`, `pnpm-lock.yaml`, etc.) |
| `typescript` | `tsconfig.json`, `tsconfig.base.json`, `jsconfig.json` |
| `python` | `pyproject.toml`, `requirements.txt`, `setup.py`, `Pipfile`, `uv.lock` |
| `go` | `go.mod`, `go.sum` |
| `java` | `pom.xml`, `build.gradle`, `build.gradle.kts` |

Marker matches produce strong evidence. Bounded file-glob fallbacks (for example `**/*.rs`) produce weak evidence. In monorepos, the nearest matching ancestor wins for that facet.

## Config locations

Skillset definitions are read from JSON or YAML files named:

- `skillsets.json`, `.skillsets.json`
- `skillsets.yaml`, `.skillsets.yaml`
- `skillsets.yml`, `.skillsets.yml`

Supported locations, highest priority first:

1. `skillsets.customFiles`
2. `skillsets.customDirectories`
3. nearest project files while walking from `cwd` to repo root:
   - `<project>/skillsets.*`
   - `<project>/.skillsets.*`
   - `<project>/.omp/skillsets.*`
4. `~/.omp/agent/skillsets.*`
5. plugin roots and marketplace metadata

Project definitions shadow user definitions with the same id. Custom files/directories shadow both.

Security boundary: project-sourced skillsets may only scan skill directories inside the detected project root, using relative paths. Absolute, `~`, env-expanded, or symlink-escaped external directories are allowed only from user skillset definitions such as `~/.omp/agent/skillsets.yaml`.

## Definition format

YAML wrapper form:

```yaml
skillsets:
  rust:
    description: Rust coding, review, refactoring, ownership, async, error handling, testing, and performance guidance.
    mode: auto
    match:
      any:
        - facets: [rust]
        - rootMarkers: [Cargo.toml, Cargo.lock, rust-toolchain.toml]
    provides:
      skillDirectories:
        - /path/to/external-skills  # user/custom definitions only; project configs use relative in-project paths
      skills:
        - rust-skills
      promptSummary: >
        Rust project detected. Use rust-skills for Rust code generation, review,
        ownership/borrowing, async, errors, memory, testing, performance, and linting.
```

Flat JSON/YAML maps and arrays of definitions are also accepted.

### `match`

A matcher can use:

- `facets`: detected facet ids (`rust`, `node`, etc.)
- `rootMarkers`: files/dirs at a candidate project root
- `fileGlobs`: bounded file globs under candidate roots
- `dependencyFiles`: `{ path, contains? }` checks
- `binaries`: binaries available on `$PATH`
- `all`, `any`, `not`: nested matcher composition

Top-level matcher fields are ANDed. `any` activates on the first matching nested matcher.

### `provides`

Supported effects:

- `skillDirectories`: parent directories containing `<skill>/SKILL.md`
- `skills`: skill names that should be available after activation
- `rules`: existing rule names to surface in the rulebook
- `alwaysApplyRules`: existing rule names to inject as always-apply for this session
- `promptSummary`: compact text shown in the Active Project Skillsets prompt section
- `toolHints`: metadata for future UI/tooling; not injected as tool instructions

Rule directory ingestion is intentionally not part of the first implementation. Large rule packs should remain under the activated skill directory and be read via `skill://<skill>/...`.

## Rust external skill library

If your external Rust skill library is shaped like this:

```text
external-skills/
  rust-skills/
    SKILL.md
    rules/
      own-borrow-over-clone.md
```

`skillDirectories` must point at the **parent** directory:

```yaml
provides:
  skillDirectories:
    - /path/to/external-skills
  skills:
    - rust-skills
```

Do not point it at `/path/to/external-skills/rust-skills`; skill scanning is non-recursive and expects `*/SKILL.md` below the configured parent.

Use this absolute external path form from `~/.omp/agent/skillsets.yaml`. A project `.omp/skillsets.yaml` or `skillsets.customFiles` definition should use a relative path to a directory inside the project, for example `./.omp/external-skills`.

Once active, the skill is listed in the prompt and its rules remain accessible through paths such as:

```text
skill://rust-skills/rules/own-borrow-over-clone.md
```

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `skillsets.enabled` | `true` | Enable project-aware skillset activation |
| `skillsets.mode` | `auto` | `auto`, `suggest`, or `off` globally |
| `skillsets.disabled` | `[]` | Skillset ids to skip |
| `skillsets.include` | `[]` | Optional allowlist of skillset ids |
| `skillsets.customFiles` | `[]` | Extra definition files with highest precedence |
| `skillsets.customDirectories` | `[]` | Directories containing skillset config files |
| `skillsets.maxAlwaysApplyChars` | `12000` | Budget for future always-apply rule effects |
| `skillsets.maxPromptSummaryChars` | `3000` | Truncation limit for prompt summaries |
| `skillsets.showDetectedInPrompt` | `true` | Show compact Active Project Skillsets metadata |

`skillsets.mode: suggest` records matching skillsets as suggestions but does not load their skills. `skillsets.mode: off` disables detection and activation.

## Prompt behavior

Active skillsets add a compact prompt section like:

```text
# Active Project Skillsets
- rust: detected from Cargo.toml (root ~/repo). Skills: rust-skills. Read skill://<name> before using an activated skill.
```

Full skill content is never injected automatically. The model must read `skill://rust-skills` before applying the skill.
