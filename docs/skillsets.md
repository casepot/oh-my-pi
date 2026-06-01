# Skillsets

Skillsets are project-aware activation recipes. They detect project facets (Rust, Node, Python, Go, Java, TypeScript, etc.) and then expose matching skills, rules, TTSR guardrails, and compact prompt summaries for the current session.

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

Security boundary: project-sourced skillsets may only scan skill or rule directories inside the detected project root, using relative paths. Absolute, `~`, env-expanded, or symlink-escaped external directories are allowed only from user skillset definitions such as `~/.omp/agent/skillsets.yaml`.

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
      ruleDirectories:
        - .omp/rules               # flat *.md/*.mdc rule scan when the skillset activates
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
- `ruleDirectories`: flat directories of `*.md` / `*.mdc` rule files loaded only while the skillset is active
- `rules`: surviving rule names to force into the rulebook bucket
- `alwaysApplyRules`: surviving rule names to inject as always-apply for this session
- `promptSummary`: compact text shown in the Active Project Skillsets prompt section
- `toolHints`: metadata for future UI/tooling; not injected as tool instructions

`ruleDirectories` use the same rule markdown/frontmatter parser as normal rule providers. Directory-loaded condition rules become TTSR rules by default; they enter `rule://` only if `provides.rules` forces the surviving rule name into the rulebook. Project, project-scoped plugin, and `skillsets.customFiles` / `customDirectories` definitions must use project-relative rule directories contained by the activation root, and every loaded rule file is realpath-checked to prevent symlink escapes. User-scoped definitions may use absolute and `~` paths.

Disable controls are cumulative and exact-name based:

- `disabledExtensions: ["skillset:<id>"]`, `skillsets.disabled`, `skillsets.include`, and `skillsets.mode` control activation.
- `disabledExtensions: ["rule:<name>"]` and `ttsr.disabledRules: ["<name>"]` drop matching discovered, skillset-provided, and built-in rules before bucket assignment.
- `ttsr.builtinRules: false` drops native embedded rule packs, including global bundled defaults and built-in project-gated packs.

Normal discovered rules shadow skillset-provided rules by name. If `provides.rules` or `provides.alwaysApplyRules` names a shadowed rule, the force applies to the surviving discovered rule.

## Built-in Rust skillset

OMP ships a built-in `rust` skillset with a small native `rs-*` TTSR pack. It activates only from strong root-marker evidence (`Cargo.toml`, `Cargo.lock`, `rust-toolchain*`, `rustfmt.toml`, or `clippy.toml`), not from the weak standalone `**/*.rs` fallback. The pack is embedded; it does not depend on any external `rust-skills` checkout.

The built-in Rust rules are scoped to generated Rust `edit`/`write` tool calls on `*.rs` paths. They are runtime guardrails, so they are not visible through `rule://` unless a same-named project/user rule or force list places a surviving rule in the rulebook. Disable them with `skillsets.disabled: [rust]`, `disabledExtensions: ["skillset:rust"]`, `disabledExtensions: ["rule:rs-from-not-into"]`, `ttsr.disabledRules`, `ttsr.builtinRules: false`, or `ttsr.enabled: false`.

External Rust skills remain optional. Add them through a user/project skillset definition when you want deeper `skill://rust-skills` guidance.

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
- rust: detected from Cargo.toml (root ~/repo). Rust project context is active; enabled Rust TTSR guardrails apply to generated .rs edits. Skills: rust-skills.
```

Full skill content is never injected automatically. The model must read `skill://rust-skills` before applying external Rust skill guidance; built-in Rust TTSR guardrails are separate active rules.