# Plan: LSP-style Project Detection for Skillsets in OMP

## Goal

Design and implement a first-class OMP mechanism that enables relevant skillsets automatically when a project is detected, analogous to how LSP servers are activated from project markers and available binaries.

The desired outcome is not just "load more skills." It should be an elegant project-capability activation system:

- detect project facets from files, markers, dependencies, and workspace roots
- activate matching skillsets, rule packs, and optional prompt affordances
- avoid prompt bloat by exposing lightweight metadata and loading full content on demand
- remain configurable at user, project, and plugin/marketplace scopes
- support monorepos and nested project roots
- keep activation deterministic, inspectable, overrideable, and safe

## Current context from repo inspection

Target repo:

```text
/Users/case/projects/external/oh-my-pi
```

Relevant existing behavior:

1. Skills already exist as file-backed capability packs.

   Source files:

   ```text
   packages/coding-agent/src/capability/skill.ts
   packages/coding-agent/src/extensibility/skills.ts
   packages/coding-agent/src/internal-urls/skill-protocol.ts
   packages/coding-agent/src/discovery/builtin.ts
   docs/skills.md
   ```

   Current skill shape includes:

   ```ts
   name
   description
   filePath
   baseDir
   globs?
   alwaysApply?
   hide?
   source metadata
   ```

   Skills are exposed as lightweight metadata in the system prompt and full content is loaded via `skill://<name>`.

2. Native project skills are discovered by walking ancestors from `cwd` to `repoRoot`.

   Existing code:

   ```text
   packages/coding-agent/src/discovery/builtin.ts
   ```

   It scans:

   ```text
   <ancestor>/.omp/skills/<skill>/SKILL.md
   ~/.omp/agent/skills/<skill>/SKILL.md
   ```

   The monorepo behavior is already tested in:

   ```text
   packages/coding-agent/test/discovery/monorepo-skills.test.ts
   ```

3. Skills can already be filtered statically.

   Existing settings:

   ```text
   skills.enabled
   skills.enableCodexUser
   skills.enableClaudeUser
   skills.enableClaudeProject
   skills.enablePiUser
   skills.enablePiProject
   skills.customDirectories
   skills.ignoredSkills
   skills.includeSkills
   ```

   Defined in:

   ```text
   packages/coding-agent/src/config/settings-schema.ts
   ```

4. LSP activation is a useful precedent.

   Source files:

   ```text
   packages/coding-agent/src/lsp/config.ts
   packages/coding-agent/src/lsp/defaults.json
   docs/lsp-config.md
   ```

   LSP auto-detection currently works by intersecting:

   - project root markers such as `package.json`, `Cargo.toml`, `pyproject.toml`
   - binary availability, resolving project-local bins before `$PATH`

   LSP config is mergeable from project/user/plugin/global sources and supports explicit overrides.

5. Rules are adjacent but separate.

   Source files:

   ```text
   packages/coding-agent/src/capability/rule.ts
   packages/coding-agent/src/discovery/builtin.ts
   packages/coding-agent/src/system-prompt.ts
   packages/coding-agent/src/prompts/system/system-prompt.md
   ```

   Rules can be:

   - always-applied
   - listed by description/globs
   - read via `rule://<name>`
   - conditionally used by TTSR if they have conditions

6. External Rust skillset exists locally.

   ```text
   /Users/case/projects/_external-skills/rust-skills
   /Users/case/projects/_external-skills/rust-skills/SKILL.md
   /Users/case/projects/_external-skills/rust-skills/rules
   ```

   It contains one `SKILL.md` plus 179 rule markdown files across 14 categories.

## Core design recommendation

Do not bolt project detection directly onto `skills.includeSkills`.

Instead, add a small project-activation layer between "discovered capabilities" and "session prompt/runtime exposure":

```text
cwd / repoRoot
  -> ProjectDetector
  -> ProjectFacet[]
  -> SkillsetDefinition[]
  -> SkillsetActivationPlan
  -> active skills/rules/prompt affordances
```

This mirrors LSPs without copying their exact shape:

- LSPs activate executable language-server processes.
- Skillsets activate knowledge/rule/capability packs.
- Both should share the same project-marker philosophy.

The central abstraction should be a detected project facet, not a hard-coded language special case.

Example facets:

```ts
ProjectFacet {
  id: "rust" | "node" | "typescript" | "python" | "go" | "workspace" | string;
  root: string;
  confidence: "explicit" | "strong" | "weak";
  evidence: Array<{
    kind: "rootMarker" | "fileGlob" | "dependency" | "config" | "binary";
    path?: string;
    value?: string;
  }>;
}
```

Then skillsets bind to facets:

```ts
SkillsetDefinition {
  id: string;
  description: string;
  match: ProjectMatcher;
  provides: SkillsetProvides;
  mode?: "auto" | "suggest" | "manual";
  priority?: number;
}
```

This keeps OMP powerful and extensible: future project intelligence can power skillsets, tools, rules, prompts, LSPs, DAPs, MCPs, models, and agent recipes without each subsystem reinventing root-marker detection.

## Proposed architecture

### 1. Add shared project detection

New files:

```text
packages/coding-agent/src/project-detection/types.ts
packages/coding-agent/src/project-detection/defaults.ts
packages/coding-agent/src/project-detection/detect.ts
packages/coding-agent/src/project-detection/index.ts
```

Responsibilities:

- inspect `cwd`, ancestor dirs, and `repoRoot`
- detect language/framework/workspace facets
- support monorepo roots and nested package roots
- return evidence, not just booleans
- cache per `cwd`/`repoRoot` during startup
- run within the same startup scan deadline philosophy already used in `sdk.ts`

Initial default detectors:

```ts
rust:
  rootMarkers: ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "rustfmt.toml", "clippy.toml"]
  fileGlobs: ["**/*.rs"]

node:
  rootMarkers: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]

python:
  rootMarkers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", "uv.lock"]

go:
  rootMarkers: ["go.mod", "go.sum"]

java:
  rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts"]
```

Detection should be cheap. Start with one-level root markers and bounded globs. Avoid recursive full-tree scans unless explicitly configured.

### 2. Introduce first-class skillsets

New files:

```text
packages/coding-agent/src/capability/skillset.ts
packages/coding-agent/src/extensibility/skillsets.ts
packages/coding-agent/src/discovery/skillsets.ts
packages/coding-agent/src/internal-urls/skillset-protocol.ts  # optional later
```

A skillset is an activation recipe, not necessarily a skill directory.

Proposed shape:

```ts
export interface SkillsetDefinition {
  id: string;
  description: string;
  match: ProjectMatcher;
  provides: SkillsetProvides;
  mode?: "auto" | "suggest" | "manual";
  priority?: number;
  source?: SourceMeta;
}

export interface ProjectMatcher {
  facets?: string[];
  rootMarkers?: string[];
  fileGlobs?: string[];
  dependencyFiles?: Array<{
    path: string;
    contains?: string[];
  }>;
  binaries?: string[];
  all?: ProjectMatcher[];
  any?: ProjectMatcher[];
  not?: ProjectMatcher[];
}

export interface SkillsetProvides {
  skills?: string[];
  skillDirectories?: string[];
  rules?: string[];
  ruleDirectories?: string[];
  alwaysApplyRules?: string[];
  promptSummary?: string;
  toolHints?: string[];
}

export interface SkillsetActivation {
  skillset: SkillsetDefinition;
  root: string;
  confidence: "explicit" | "strong" | "weak";
  evidence: ProjectFacet["evidence"];
  effects: ResolvedSkillsetEffects;
}
```

Important distinction:

- `Skill` remains an addressable knowledge artifact loaded by `skill://`.
- `Rule` remains an addressable local constraint loaded by `rule://`.
- `Skillset` is the project-aware activation layer that selects skills/rules/prompt hints.

### 3. Config and discovery sources

Mirror LSP config locations, but name them for skillsets:

```text
<project>/skillsets.json|yaml
<project>/.skillsets.json|yaml
<project>/.omp/skillsets.json|yaml
~/.omp/agent/skillsets.json|yaml
plugin roots / marketplace metadata
bundled defaults
```

Settings to add in `settings-schema.ts`:

```text
skillsets.enabled: boolean = true
skillsets.mode: "off" | "suggest" | "auto" = "auto"
skillsets.disabled: string[] = []
skillsets.include: string[] = []
skillsets.customFiles: string[] = []
skillsets.customDirectories: string[] = []
skillsets.maxAlwaysApplyChars: number = 12000
skillsets.maxPromptSummaryChars: number = 3000
skillsets.showDetectedInPrompt: boolean = true
```

Why separate from `skills.*`:

- `skills.*` controls skill discovery and static filtering.
- `skillsets.*` controls dynamic project activation.
- Dynamic activation should not mutate `skills.includeSkills`; it should compile a session-local activation plan.

### 4. Runtime integration point

Best integration point is `createAgentSession` in:

```text
packages/coding-agent/src/sdk.ts
```

Current startup already parallelizes:

```text
workspaceTreePromise
contextFilesPromise
promptTemplatesPromise
slashCommandsPromise
discoveredSkillsPromise
```

Add:

```text
projectFacetsPromise
skillsetActivationPromise
```

Flow:

```text
Settings.init(cwd)
  -> discover skills as today
  -> discover rules as today
  -> detect project facets
  -> load skillset definitions
  -> compile activation plan
  -> merge activated skill/rule effects into session-local prompt inputs
  -> build system prompt
```

Do not block startup longer than current discovery budget. If detection times out, fall back to no auto skillsets and let background cache warm.

### 5. Prompt behavior

Avoid dumping full rule packs into the system prompt.

Add a compact section to the system prompt when active skillsets exist:

```text
# Active Project Skillsets
Detected Rust project at <short-root> from Cargo.toml.
- rust: Rust coding and review guidance is available via skill://rust-skills.
  Use for Rust code generation, refactoring, review, ownership, async, error handling, testing, and performance.
```

Then keep the existing skill behavior:

- expose active skills in `<skills>` list
- require the model to read `skill://<name>` before using a skill
- full content remains on demand

For rules:

- only inject `alwaysApplyRules` if explicitly configured and under budget
- otherwise list rule metadata and let the model read `rule://<name>` or `skill://rust-skills/rules/<rule>.md`

This preserves power without prompt bloat.

### 6. Rust skillset as initial proof

Use the local Rust skill library as the first real activation example, but do not hard-code the local absolute path into product defaults.

Local source:

```text
/Users/case/projects/_external-skills/rust-skills
```

For development/testing, configure via user/project skillset config:

```yaml
skillsets:
  rust:
    description: Rust coding, review, refactoring, ownership, async, error handling, testing, and performance guidance.
    mode: auto
    match:
      any:
        - facets: [rust]
        - rootMarkers: [Cargo.toml, Cargo.lock, rust-toolchain.toml]
        - fileGlobs: ["**/*.rs"]
    provides:
      skillDirectories:
        - /Users/case/projects/_external-skills
      skills:
        - rust-skills
      promptSummary: >
        Rust project detected. Use rust-skills for Rust code generation, review, refactoring,
        ownership/borrowing, async, errors, memory, testing, performance, and linting.
```

Because the Rust package is shaped as:

```text
rust-skills/SKILL.md
rust-skills/rules/*.md
```

it already fits OMP's non-recursive `skills.customDirectories` layout if the custom directory points at:

```text
/Users/case/projects/_external-skills
```

not at:

```text
/Users/case/projects/_external-skills/rust-skills
```

That detail should be documented and tested.

### 7. Optional rule-pack enhancement

The Rust skill contains 179 rule files. Today those are accessible via `skill://rust-skills/rules/<name>.md` once the skill is active, but they are not automatically part of the `rule://` rulebook.

Do not make rule-pack ingestion part of the first implementation unless needed.

Stage 1:

- activate `rust-skills`
- advertise that rule files are available under `skill://rust-skills/rules/...`
- rely on `SKILL.md` quick reference for rule selection

Stage 2:

- allow skillsets to expose `ruleDirectories`
- parse external rule directories with the existing `Rule` shape
- namespace imported rules to avoid collisions, e.g. `rust-skills:own-borrow-over-clone`
- expose them via `rule://`

This keeps the first slice small and avoids accidentally flooding the prompt with 179 rules.

## Step-by-step implementation plan

### Phase 1: Project detection substrate

1. Create project detection types.

   Files:

   ```text
   packages/coding-agent/src/project-detection/types.ts
   packages/coding-agent/src/project-detection/index.ts
   ```

2. Implement marker-based detector.

   File:

   ```text
   packages/coding-agent/src/project-detection/detect.ts
   ```

   Reuse existing patterns where possible:

   - `findRepoRoot` from `capability/fs`
   - ancestor walking similar to `discovery/builtin.ts`
   - marker semantics similar to `lsp/config.ts:hasRootMarkers`

3. Add default detector definitions.

   File:

   ```text
   packages/coding-agent/src/project-detection/defaults.ts
   ```

4. Unit tests for:

   ```text
   packages/coding-agent/test/project-detection.test.ts
   ```

   Cases:

   - detects Rust from `Cargo.toml`
   - detects Node from `package.json`
   - detects nested monorepo package root
   - returns evidence with marker path
   - handles no match cheaply

### Phase 2: Skillset definition and config loading

1. Add `SkillsetDefinition` capability type.

   File:

   ```text
   packages/coding-agent/src/capability/skillset.ts
   ```

2. Add loader for bundled/project/user/plugin skillset config.

   File:

   ```text
   packages/coding-agent/src/extensibility/skillsets.ts
   ```

3. Support JSON and YAML parsing, matching LSP config conventions.

   Reuse parsing style from:

   ```text
   packages/coding-agent/src/lsp/config.ts
   ```

4. Add settings schema entries.

   File:

   ```text
   packages/coding-agent/src/config/settings-schema.ts
   ```

5. Tests:

   ```text
   packages/coding-agent/test/skillsets-config.test.ts
   ```

   Cases:

   - project config overrides user config
   - disabled skillset is skipped
   - include allowlist narrows active set
   - invalid definition produces warning not crash

### Phase 3: Activation compiler

1. Implement matcher evaluation.

   File:

   ```text
   packages/coding-agent/src/extensibility/skillsets.ts
   ```

   It should evaluate:

   - detected facets
   - root markers
   - bounded file globs
   - optional binary existence
   - `all` / `any` / `not`

2. Compile `SkillsetActivationPlan`.

   Inputs:

   - detected facets
   - discovered skills
   - discovered rules
   - skillset definitions
   - settings

   Outputs:

   - active skillset summaries
   - additional skill directories to scan
   - active skill names
   - optional always-apply rule additions
   - warnings for missing skills/directories

3. Important behavior:

   - never mutate persistent settings
   - do not duplicate skill discovery by realpath
   - preserve existing provider precedence/collision warnings
   - keep activation session-local

4. Tests:

   ```text
   packages/coding-agent/test/skillsets-activation.test.ts
   ```

   Cases:

   - Rust project activates `rust-skills`
   - non-Rust project does not
   - missing custom skill directory emits warning
   - activation respects `skillsets.mode = suggest`
   - activation respects disabled list

### Phase 4: SDK/session integration

1. Update `createAgentSession` startup flow.

   File:

   ```text
   packages/coding-agent/src/sdk.ts
   ```

2. Add project detection and skillset activation promises near existing discovery promises.

3. Extend `ToolSession` or session state only if needed for inspection/debugging.

4. Add active skillsets to `AgentSession` state if useful.

   Possible field:

   ```ts
   session.skillsetActivations: SkillsetActivation[]
   ```

5. Add tests around session creation.

   Files:

   ```text
   packages/coding-agent/test/sdk-skillsets.test.ts
   packages/coding-agent/test/system-prompt-skillsets.test.ts
   ```

### Phase 5: System prompt integration

1. Extend system prompt options.

   File:

   ```text
   packages/coding-agent/src/system-prompt.ts
   ```

   Add:

   ```ts
   activeSkillsets?: ActiveSkillsetPromptSummary[]
   ```

2. Update templates.

   Files:

   ```text
   packages/coding-agent/src/prompts/system/system-prompt.md
   packages/coding-agent/src/prompts/system/custom-system-prompt.md
   ```

3. Prompt section should be compact, evidence-backed, and non-bloated.

   Example:

   ```text
   # Active Project Skillsets
   - rust: detected from Cargo.toml. Skill available: rust-skills. Read skill://rust-skills before Rust coding/review/refactor work.
   ```

4. Tests:

   ```text
   packages/coding-agent/test/system-prompt-templates.test.ts
   packages/coding-agent/test/system-prompt-skillsets.test.ts
   ```

### Phase 6: Rust proof fixture

1. Add test fixture for local/external Rust skillset layout.

   Do not depend on the absolute local path in tests. Create temp fixture:

   ```text
   temp/external-skills/rust-skills/SKILL.md
   temp/external-skills/rust-skills/rules/own-borrow-over-clone.md
   ```

2. Confirm that `skillDirectories` points to the parent directory:

   ```text
   temp/external-skills
   ```

3. Confirm Rust project activation exposes `rust-skills`.

4. Confirm non-Rust project does not expose it.

### Phase 7: Docs and UX

1. Add a new doc:

   ```text
   docs/skillsets.md
   ```

2. Update existing docs:

   ```text
   docs/skills.md
   docs/lsp-config.md
   docs/marketplace.md
   docs/environment-variables.md  # only if new env flags are added
   ```

3. Include examples:

   - Rust skillset activation
   - project-local skillset config
   - user-global skillset config
   - disabling a skillset
   - suggest mode vs auto mode
   - monorepo behavior

4. Add an inspection/debug command if the CLI already has an appropriate command surface.

   Possible UX:

   ```text
   omp skills list
   omp skillsets list
   omp skillsets status
   omp skillsets explain rust
   ```

   If no command framework is appropriate for the first slice, defer this and surface warnings in session startup logs/tests.

## Files likely to change

Primary implementation:

```text
packages/coding-agent/src/project-detection/types.ts
packages/coding-agent/src/project-detection/defaults.ts
packages/coding-agent/src/project-detection/detect.ts
packages/coding-agent/src/project-detection/index.ts
packages/coding-agent/src/capability/skillset.ts
packages/coding-agent/src/extensibility/skillsets.ts
packages/coding-agent/src/discovery/skillsets.ts
packages/coding-agent/src/sdk.ts
packages/coding-agent/src/system-prompt.ts
packages/coding-agent/src/config/settings-schema.ts
packages/coding-agent/src/prompts/system/system-prompt.md
packages/coding-agent/src/prompts/system/custom-system-prompt.md
```

Likely optional/refactor files:

```text
packages/coding-agent/src/lsp/config.ts
packages/coding-agent/src/internal-urls/skillset-protocol.ts
packages/coding-agent/src/internal-urls/index.ts
packages/coding-agent/src/session/agent-session.ts
packages/coding-agent/src/modes/components/settings-defs.ts
packages/coding-agent/src/modes/components/settings-selector.ts
```

Tests:

```text
packages/coding-agent/test/project-detection.test.ts
packages/coding-agent/test/skillsets-config.test.ts
packages/coding-agent/test/skillsets-activation.test.ts
packages/coding-agent/test/sdk-skillsets.test.ts
packages/coding-agent/test/system-prompt-skillsets.test.ts
packages/coding-agent/test/system-prompt-templates.test.ts
```

Docs:

```text
docs/skillsets.md
docs/skills.md
docs/lsp-config.md
docs/marketplace.md
```

## Validation plan

Run focused tests first:

```bash
bun test packages/coding-agent/test/project-detection.test.ts
bun test packages/coding-agent/test/skillsets-config.test.ts
bun test packages/coding-agent/test/skillsets-activation.test.ts
bun test packages/coding-agent/test/sdk-skillsets.test.ts
bun test packages/coding-agent/test/system-prompt-skillsets.test.ts
```

Then run broader package checks:

```bash
bun --cwd=packages/coding-agent test
bun --cwd=packages/coding-agent run check
```

Then root checks if the change touches shared config/package exports:

```bash
bun run check:ts
bun run test:ts
```

Manual smoke tests:

1. Create temp Rust project with `Cargo.toml`.
2. Configure skillset to point at a temp copy of `rust-skills`.
3. Start OMP in that directory.
4. Verify system prompt/session skills include `rust-skills`.
5. Verify `skill://rust-skills` resolves.
6. Start OMP in a non-Rust temp project.
7. Verify `rust-skills` is not active unless manually included.

## Risks and tradeoffs

### Prompt bloat

Large skillsets such as `rust-skills` have many rules. Do not inject all rules. Advertise active skillsets and load full content on demand.

### False positives

A lone `.rs` file should probably produce weak confidence, while `Cargo.toml` should produce strong confidence. Use evidence/confidence and allow `suggest` mode.

### Monorepos

Activation should be rooted at the nearest relevant project root, not only the git root. Existing ancestor-walk skill tests are a good model.

### Configuration complexity

Keep first-slice config simple: `match` + `provides` + `mode`. Avoid a huge declarative DSL initially.

### Security / trust

External `skillDirectories` and `ruleDirectories` should follow existing realpath/path containment practices where possible. Skillsets should not execute code; they only activate content. Executable effects belong in tools/hooks/extensions with their own trust model.

### Collisions

Skill names collide across providers today. Preserve current first-wins behavior and emit warnings. For imported rule packs, namespace rules before exposing them globally.

### Startup latency

Detection should share the existing non-blocking startup pattern and deadline. Bounded marker checks first; recursive scans only if explicitly configured.

## Open questions

1. Should active skillsets merely expose skills, or should some be allowed to autoload compact summaries into the conversation?

   Recommendation: expose by default; compact summaries only if configured.

2. Should skillsets be a capability provider like skills/rules, or a separate extension subsystem?

   Recommendation: define a `skillset` capability for discoverability, then compile activations in `extensibility/skillsets.ts`.

3. Should LSP and skillset detection share one project-detection module immediately?

   Recommendation: implement shared project detection for skillsets first, then optionally migrate LSP config to use it after behavior is stable. Avoid risky LSP regression in the first slice.

4. Should Rust rules become first-class `rule://` entries?

   Recommendation: defer. Start with `skill://rust-skills/rules/...` access and add `ruleDirectories` ingestion in a second slice.

## Suggested first implementation slice

The smallest valuable slice:

1. Add `project-detection` with marker-based Rust detection.
2. Add skillset config loading for project/user JSON/YAML.
3. Add activation compiler that can append `skillDirectories` and activate named skills.
4. Add compact active-skillset prompt section.
5. Add tests for Rust activation against a temp `rust-skills` fixture.
6. Document `docs/skillsets.md`.

This gives OMP an LSP-like project activation model without overfitting to Rust or bloating the prompt. It also establishes a clean architectural hook for future project-aware activation of rules, tools, MCPs, DAPs, model profiles, and runtime recipes.
