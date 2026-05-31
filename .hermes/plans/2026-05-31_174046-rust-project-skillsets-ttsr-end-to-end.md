# Implementation Plan: Project-Aware Rust Skillsets and OMP TTSR Guardrails

## Goal

Carry the Rust skillset/TTSR work end to end inside OMP:

1. Add an LSP-style project detection layer that identifies Rust projects from workspace evidence.
2. Add a project skillset activation layer that turns detected project facets into session-local capabilities.
3. Ship a curated built-in Rust skillset pilot that activates high-signal Rust TTSR rules without prompt bloat.
4. Keep long-form Rust knowledge as skill/reference material and keep TTSR as short active guardrails only.
5. Make the system configurable, extensible, testable, and safe to enable by default.

This plan is for `/Users/case/projects/external/oh-my-pi`.

## Architectural thesis

Treat project-aware guidance like LSP activation, not like prompt stuffing.

```text
workspace evidence
  -> project facets
  -> activation policy
  -> session-local skillset activation plan
  -> skills + rules + TTSR guardrails + compact prompt metadata
```

A skillset is not a giant prompt blob. It is an activation recipe that can attach multiple capability surfaces:

- skills: deep optional workflows / references loaded through `skill://`
- rulebook rules: named domain constraints available through `rule://`
- always-apply rules: small persistent project/session constraints
- TTSR rules: high-signal stream guardrails for bad generated code
- compact prompt summary: minimal notice of what is active

TTSR should remain selective: only stream-detectable, high-cost, locally correctable mistakes should interrupt generation.

## Current context from inspection

### Existing OMP rule system

Relevant files:

- `packages/coding-agent/src/capability/rule.ts`
- `packages/coding-agent/src/export/ttsr.ts`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/internal-urls/rule-protocol.ts`
- `packages/coding-agent/src/prompts/system/system-prompt.md`
- `packages/coding-agent/test/ttsr.test.ts`
- `packages/coding-agent/test/discovery/builtin-rules-md.test.ts`
- `docs/rulebook-matching-pipeline.md`

Current rule bucketing in `sdk.ts`:

```text
rule.condition present -> register with TtsrManager
rule.alwaysApply true  -> inject full content in prompt
rule.description       -> list as Domain Rule and expose through rule://
```

Important behavior: if a rule has `condition`, it becomes TTSR and is not listed as a normal rulebook rule.

### Existing OMP skill system

Relevant files:

- `packages/coding-agent/src/capability/skill.ts`
- `packages/coding-agent/src/extensibility/skills.ts`
- `packages/coding-agent/src/internal-urls/skill-protocol.ts`
- `packages/coding-agent/src/discovery/builtin.ts`
- `packages/coding-agent/src/discovery/helpers.ts`
- `docs/skills.md`

Skills are passive capability packs. They are exposed as compact prompt metadata and full content is available through `skill://...`.

### Existing settings surface

Relevant files:

- `packages/coding-agent/src/config/settings-schema.ts`
- `packages/coding-agent/src/config/settings.ts`

Relevant settings already exist:

```text
ttsr.enabled
ttsr.contextMode
ttsr.interruptMode
ttsr.repeatMode
ttsr.repeatGap
skills.enabled
skills.enableSkillCommands
skills.customDirectories
skills.ignoredSkills
skills.includeSkills
disabledExtensions
```

### Existing TTSR capabilities

`TtsrManager` supports:

- condition regex compilation
- source matching: `text`, `thinking`, `tool`
- tool scopes: `tool`, `tool:edit`, `tool:write`, `tool:edit(*.rs)`, etc.
- path glob matching against tool-associated file paths
- per-rule `interruptMode`: `never`, `prose-only`, `tool-only`, `always`
- repeat gating

### Local Rust skill source analyzed

Local source:

```text
/Users/case/projects/_external-skills/rust-skills
/Users/case/projects/_external-skills/rust-skills/rules/*.md
```

Inventory:

- 179 Rust rule files
- no OMP frontmatter in those files at analysis time

Do not mutate this external source directly for the OMP implementation. Treat it as source material/reference.

## Non-goals

- Do not load all 179 Rust rules into the prompt.
- Do not convert every Rust rule into TTSR.
- Do not mutate `/Users/case/projects/_external-skills/rust-skills` as part of OMP implementation.
- Do not make TTSR a replacement for rustc, Clippy, rustfmt, or CI.
- Do not hard-code this system only for Rust. Rust is the pilot; the architecture should support future Python/Node/Go/etc. skillsets.
- Do not add broad `text`/`thinking` TTSR scopes by default. Prefer `tool:edit`/`tool:write` scopes.

## Proposed design

### 1. Project facets

Add a lightweight project detection layer that turns workspace evidence into structured facts.

New conceptual type:

```ts
export interface ProjectFacet {
  id: string;                       // e.g. "language:rust", "build:cargo", "crate:library"
  kind: "language" | "build" | "framework" | "tooling" | "policy";
  confidence: "low" | "medium" | "high";
  root: string;
  evidence: ProjectFacetEvidence[];
}

export interface ProjectFacetEvidence {
  type: "file" | "directory" | "manifest" | "content";
  path: string;
  reason: string;
}
```

Rust detector evidence:

- `Cargo.toml`
- `Cargo.lock`
- `rust-toolchain.toml` / `rust-toolchain`
- `rustfmt.toml` / `.rustfmt.toml`
- `clippy.toml` / `.clippy.toml`
- `src/lib.rs`
- `src/main.rs`
- `crates/*/Cargo.toml` in workspaces
- `[workspace]` in root `Cargo.toml`
- `[package]` in `Cargo.toml`

Do not run `cargo metadata` in the default startup path. It can be added later behind an explicit deeper-detection setting. First implementation should be fast filesystem/TOML inspection only.

Suggested files:

```text
packages/coding-agent/src/project-detection/types.ts
packages/coding-agent/src/project-detection/index.ts
packages/coding-agent/src/project-detection/rust.ts
```

### 2. Skillset manifests

Add a skillset abstraction as activation policy, not as another prompt blob.

Suggested type:

```ts
export interface SkillsetManifest {
  id: string;                       // "rust"
  title: string;                    // "Rust"
  description: string;
  version?: string;
  detect: SkillsetDetectionSpec;
  activates: SkillsetActivationSpec;
}

export interface SkillsetDetectionSpec {
  all?: string[];                   // facet IDs required
  any?: string[];                   // any facet ID activates
  none?: string[];                  // facet IDs that suppress activation
  minConfidence?: "low" | "medium" | "high";
}

export interface SkillsetActivationSpec {
  skills?: SkillsetSkillRef[];
  rules?: SkillsetRuleRef[];
  ruleDirs?: string[];
  promptSummary?: string;
}

export interface SkillsetActivationPlan {
  activated: ActivatedSkillset[];
  facets: ProjectFacet[];
  skills: Skill[];
  rules: Rule[];
  warnings: string[];
}
```

Suggested files:

```text
packages/coding-agent/src/skillsets/types.ts
packages/coding-agent/src/skillsets/activation.ts
packages/coding-agent/src/skillsets/builtin/index.ts
packages/coding-agent/src/skillsets/builtin/rust.ts
```

### 3. Built-in Rust skillset pilot

Ship a built-in Rust skillset that activates only when Rust project facets are detected.

Initial activation:

```ts
id: "rust"
title: "Rust"
detect: {
  any: ["language:rust", "build:cargo"],
  minConfidence: "medium"
}
activates: {
  rules: [firstWaveRustTtsrRules],
  promptSummary: "Rust project detected: Rust TTSR guardrails are active for generated .rs edits. Use skill://rust when deeper Rust workflow guidance is needed."
}
```

Do not depend on the local external `rust-skills` directory at runtime. The built-in TTSR rules should live inside the OMP repo.

Suggested data layout:

```text
packages/coding-agent/src/skillsets/builtin/rust/rules/ttsr/
  rust-lock-across-await.md
  rust-unbounded-channel.md
  rust-async-std-fs.md
  rust-async-std-mpsc.md
  rust-unwrap-prod.md
  rust-silent-error-discard.md
  rust-error-source-chain.md
  rust-from-not-into.md
  rust-tokio-async-test.md
  rust-borrowed-api-params.md
```

Each file should be a short OMP rule with frontmatter plus concise corrective content. It should not copy the full long-form educational rust-skills file.

Example rule shape:

```markdown
---
description: Do not hold Mutex/RwLock guards across await points.
globs:
  - "**/*.rs"
condition:
  - "\\.(lock|read|write)\\(\\)(\\.await|\\.unwrap\\(\\)|\\.expect\\()[\\s\\S]{0,800}\\.await"
scope:
  - "tool:write(**/*.rs)"
  - "tool:edit(**/*.rs)"
interruptMode: tool-only
---

A lock guard appears to remain live across an `.await`. Refactor so the guard is dropped before awaiting, or move the awaited work before acquiring the lock.
```

### 4. First-wave Rust TTSR rules

Implement exactly these first. They are high-signal enough for a default-on pilot when scoped to Rust edit/write tools.

#### A. `rust-lock-across-await.md`

Source references:

- `async-no-lock-await.md`
- `anti-lock-across-await.md`

Frontmatter sketch:

```yaml
description: Do not hold Mutex/RwLock guards across await points.
globs: ["**/*.rs"]
condition:
  - "\\.(lock|read|write)\\(\\)(\\.await|\\.unwrap\\(\\)|\\.expect\\()[\\s\\S]{0,800}\\.await"
scope:
  - "tool:write(**/*.rs)"
  - "tool:edit(**/*.rs)"
interruptMode: tool-only
```

Guidance: warn that this is a liveness check; if the guard is dropped before `.await`, explain/structure the code to make that explicit.

#### B. `rust-unbounded-channel.md`

Source reference:

- `async-bounded-channel.md`

```yaml
description: Prefer bounded Tokio channels unless unbounded growth is explicitly justified.
globs: ["**/*.rs"]
condition:
  - "mpsc::unbounded_channel\\s*(::)?\\s*<"
  - "tokio::sync::mpsc::unbounded_channel"
  - "Unbounded(Sender|Receiver)"
scope:
  - "tool:write(**/*.rs)"
  - "tool:edit(**/*.rs)"
interruptMode: tool-only
```

Guidance: use bounded `mpsc::channel(capacity)` or add an explicit comment/justification for intentionally unbounded low-volume channels.

#### C. `rust-async-std-fs.md`

Source reference:

- `async-tokio-fs.md`

```yaml
description: Use tokio::fs or spawn_blocking for filesystem work in async code.
globs: ["**/*.rs"]
condition:
  - "async\\s+fn[\\s\\S]{0,1200}std::fs::(read|read_to_string|write|File|metadata|rename|remove_)"
  - "tokio::spawn\\s*\\(\\s*async[\\s\\S]{0,1200}std::fs::"
scope:
  - "tool:write(**/*.rs)"
  - "tool:edit(**/*.rs)"
interruptMode: tool-only
```

Guidance: use `tokio::fs::*` or wrap truly blocking filesystem work in `tokio::task::spawn_blocking`.

#### D. `rust-async-std-mpsc.md`

Source reference:

- `async-mpsc-queue.md`

```yaml
description: Use Tokio channels in async tasks instead of std::sync::mpsc.
globs: ["**/*.rs"]
condition:
  - "tokio::spawn\\s*\\(\\s*async[\\s\\S]{0,800}std::sync::mpsc"
  - "async\\s+fn[\\s\\S]{0,800}std::sync::mpsc::(channel|sync_channel)"
scope:
  - "tool:write(**/*.rs)"
  - "tool:edit(**/*.rs)"
interruptMode: tool-only
```

#### E. `rust-unwrap-prod.md`

Source references:

- `err-no-unwrap-prod.md`
- `anti-unwrap-abuse.md`

Do not ban all unwraps. Target fallible external/production operations.

```yaml
description: Avoid unwrap on fallible production operations; propagate or add context.
globs: ["**/*.rs"]
condition:
  - "(std::fs|fs::|File::|reqwest|serde_json|toml|parse\\(\\)|recv\\(\\)|send\\(|database|db\\.)[\\s\\S]{0,200}\\.unwrap\\s*\\(\\s*\\)"
scope:
  - "tool:write(src/**/*.rs)"
  - "tool:edit(src/**/*.rs)"
  - "tool:write(crates/**/src/**/*.rs)"
  - "tool:edit(crates/**/src/**/*.rs)"
interruptMode: tool-only
```

Guidance: use `?`, `ok_or_else`, `map_err`, or `expect("BUG: ...")` only for true invariants.

#### F. `rust-silent-error-discard.md`

Source reference:

- `anti-empty-catch.md`

```yaml
description: Do not silently discard errors; log, propagate, or explicitly justify.
globs: ["**/*.rs"]
condition:
  - "Err\\s*\\(_\\)\\s*=>\\s*\\{\\s*\\}"
  - "let\\s+_\\s*=\\s*(std::fs|fs::|File::|write|send|save|database|db\\.)"
  - "\\.ok\\s*\\(\\s*\\)\\s*;"
scope:
  - "tool:write(**/*.rs)"
  - "tool:edit(**/*.rs)"
interruptMode: tool-only
```

Guidance: explicitly handle, log, propagate, or comment why best-effort discard is acceptable.

#### G. `rust-error-source-chain.md`

Source reference:

- `err-source-chain.md`

```yaml
description: Preserve error sources instead of converting underlying errors to strings.
globs: ["**/*.rs"]
condition:
  - "\\.map_err\\s*\\(\\s*\\|(e|err|source)\\|\\s*[^)]*\\.to_string\\s*\\(\\s*\\)"
  - "Err\\s*\\([^)]*\\.to_string\\s*\\(\\s*\\)\\)"
scope:
  - "tool:write(**/*.rs)"
  - "tool:edit(**/*.rs)"
interruptMode: tool-only
```

Guidance: keep the original error as `#[source]`, use `thiserror`, or attach context without erasing source.

#### H. `rust-from-not-into.md`

Source reference:

- `api-from-not-into.md`

```yaml
description: Implement From<T>, not Into<U>; From provides Into automatically.
globs: ["**/*.rs"]
condition:
  - "^\\s*impl(?:<[^>]*>)?\\s+Into\\s*<[^>]+>\\s+for\\s+"
scope:
  - "tool:write(**/*.rs)"
  - "tool:edit(**/*.rs)"
interruptMode: tool-only
```

#### I. `rust-tokio-async-test.md`

Source reference:

- `test-tokio-async.md`

```yaml
description: Use #[tokio::test] for Tokio async tests.
globs: ["**/*.rs"]
condition:
  - "#\\s*\\[\\s*test\\s*]\\s*(?:#\\[[^\\]]*]\\s*)*async\\s+fn"
  - "Runtime::new\\(\\)[\\s\\S]{0,160}\\.block_on\\("
scope:
  - "tool:write(**/tests/**/*.rs)"
  - "tool:edit(**/tests/**/*.rs)"
  - "tool:write(**/*test*.rs)"
  - "tool:edit(**/*test*.rs)"
interruptMode: tool-only
```

#### J. `rust-borrowed-api-params.md`

Source reference:

- `own-slice-over-vec.md`

```yaml
description: Prefer &[T], &str, and &Path over &Vec<T>, &String, and &PathBuf in function parameters.
globs: ["**/*.rs"]
condition:
  - "fn\\s+\\w+[^{;]*\\([^)]*&\\s*Vec\\s*<"
  - "fn\\s+\\w+[^{;]*\\([^)]*&\\s*String\\b"
  - "fn\\s+\\w+[^{;]*\\([^)]*&\\s*PathBuf\\b"
scope:
  - "tool:write(**/*.rs)"
  - "tool:edit(**/*.rs)"
interruptMode: tool-only
```

### 5. Second-wave optional rules

Do not include these in the default pilot until first-wave false-positive behavior is observed.

Potential second-wave rules:

- `rust-map-entry-api.md` from `perf-entry-api.md`
- `rust-write-over-format.md` from `mem-write-over-format.md`
- `rust-iter-over-index.md` from `perf-iter-over-index.md` / `opt-bounds-check.md`
- `rust-doc-examples-question-mark.md` from `doc-question-mark.md`
- `rust-test-cfg-module.md` from `test-cfg-test-module.md`
- `rust-option-discarded-error.md` from `type-result-fallible.md`
- `rust-raw-id-params.md` from `type-newtype-ids.md`
- `rust-as-owned-return.md` from `name-as-free.md`
- `rust-unsafe-safety-comment.md` from `lint-unsafe-doc.md` / `doc-safety-section.md`

These should default to `interruptMode: never` or remain rulebook until the matching is proven.

## Settings and configurability

Add a new settings group.

Suggested settings in `packages/coding-agent/src/config/settings-schema.ts`:

```ts
"skillsets.enabled": { type: "boolean", default: true },
"skillsets.autoDetect": { type: "boolean", default: true },
"skillsets.enabledSkillsets": { type: "array", default: [] as string[] },
"skillsets.disabledSkillsets": { type: "array", default: [] as string[] },
"skillsets.customDirectories": { type: "array", default: [] as string[] },
"skillsets.activationNotice": {
  type: "enum",
  values: ["off", "compact", "verbose"] as const,
  default: "compact",
},
"skillsets.rust.enabled": { type: "boolean", default: true },
"skillsets.rust.ttsrProfile": {
  type: "enum",
  values: ["off", "safe", "extended"] as const,
  default: "safe",
},
```

Semantics:

- `skillsets.enabled=false`: disables all project-aware skillset activation.
- `skillsets.autoDetect=false`: only explicit/manual skillsets activate.
- `enabledSkillsets=[]`: all known skillsets are eligible.
- `disabledSkillsets` wins over `enabledSkillsets`.
- `skillsets.rust.enabled=false`: disables Rust activation only.
- `skillsets.rust.ttsrProfile=off`: Rust skillset may still expose skill/rulebook metadata later, but no Rust TTSR rules are attached.
- `ttsr.enabled=false`: still globally disables TTSR behavior even if skillsets attach TTSR-shaped rules.

Future extension, not required for first PR:

```text
.omp/skillsets/*.json
.omp/skillsets/*.toml
~/.omp/agent/skillsets/*.json
```

## Runtime integration plan

### Preferred integration point

Integrate in `createAgentSession` in `packages/coding-agent/src/sdk.ts`.

Current approximate flow:

```text
settings loaded
skills discovery starts
rules loaded and bucketed later
system prompt built with skills + rulebookRules + alwaysApplyRules
```

New approximate flow:

```text
settings loaded
project facets detected
skillset activation plan resolved
skills discovery starts
merge discovered skills + activated skillset skills
rules loaded
merge discovered rules + activated skillset rules
bucket merged rules into TTSR / alwaysApply / rulebook
system prompt built with merged skills/rules + optional compact activation notice
```

Add helper functions rather than bloating `sdk.ts`:

```text
packages/coding-agent/src/skillsets/session.ts
  resolveSessionSkillsets({ cwd, repoRoot, home, settings }): Promise<SkillsetActivationPlan>
  mergeActivatedSkills(discovered, activated): Skill[]
  mergeActivatedRules(discovered, activated): Rule[]
```

### Deduplication

Rules and skills should retain existing capability semantics:

- skill key: `skill.name`
- rule key: `rule.name`
- existing project/user explicit rules should win over built-in activated rules
- disabled extension ids should apply to activated rules too

Suggested extension ids:

```text
skillset:rust
rule:rust-lock-across-await
rule:rust-unbounded-channel
...
```

If a user disables `rule:rust-lock-across-await`, that one guardrail is excluded.
If a user disables `skillset:rust`, the whole Rust skillset is excluded.

### Source metadata

For built-in Rust TTSR rules, use real source file paths and provider metadata:

```ts
_source: {
  provider: "skillsets",
  providerName: "Project Skillsets",
  path: absoluteRuleFilePath,
  level: "native",
}
```

If later user/project custom skillsets are loaded from `.omp/skillsets`, use `level: "project"` or `"user"` accordingly.

## Prompt/UI behavior

### Prompt

Do not inject all Rust rule text.

For first implementation, keep prompt changes minimal:

- TTSR rules are active but not listed as Domain Rules because they are TTSR.
- Add an optional compact activation notice only when `skillsets.activationNotice !== "off"`.

Example compact prompt section:

```text
# Active Project Skillsets
- Rust: Rust project detected. Rust edit/write guardrails are active for high-risk async/error/API mistakes.
```

Suggested implementation:

- extend `buildSystemPromptInternal` input with `activeSkillsets?: ActiveSkillsetSummary[]`
- render after `# Skills` or before `# Generic Rules`
- keep it compact; no rule list unless verbose mode is requested

Files:

```text
packages/coding-agent/src/system-prompt.ts
packages/coding-agent/src/prompts/system/system-prompt.md
```

### UI/extensions state

If extension list/status UI already shows capabilities, include activated skillset rules there naturally via `Rule` objects. Add explicit skillset summaries later only if useful.

## Implementation phases

### Phase 1 — Project detection foundation

Files to add:

```text
packages/coding-agent/src/project-detection/types.ts
packages/coding-agent/src/project-detection/index.ts
packages/coding-agent/src/project-detection/rust.ts
packages/coding-agent/test/project-detection/rust.test.ts
```

Tasks:

1. Define `ProjectFacet`, `ProjectFacetEvidence`, and detector interface.
2. Implement `detectRustProject({ cwd, repoRoot })`.
3. Keep detection bounded and synchronous/cheap where possible.
4. Parse `Cargo.toml` only enough to detect `[package]` / `[workspace]`; do not require full TOML semantic model unless an existing TOML utility is already available.
5. Return no facets for non-Rust projects.
6. Test temp projects:
   - root `Cargo.toml` with `[package]`
   - root `Cargo.toml` with `[workspace]` and member crate
   - `src/lib.rs` without Cargo.toml: low/medium confidence depending evidence
   - non-Rust project: no Rust facet

Acceptance:

- Rust facets are stable and evidence-rich.
- No external commands required.
- Detection does not scan entire large repos deeply.

### Phase 2 — Skillset activation core

Files to add:

```text
packages/coding-agent/src/skillsets/types.ts
packages/coding-agent/src/skillsets/activation.ts
packages/coding-agent/src/skillsets/session.ts
packages/coding-agent/src/skillsets/builtin/index.ts
packages/coding-agent/test/skillsets/activation.test.ts
```

Tasks:

1. Define `SkillsetManifest` and `SkillsetActivationPlan`.
2. Implement manifest matching against facets.
3. Implement settings gates:
   - global enabled/disabled
   - enabled allowlist
   - disabled denylist
   - per-skillset gate for Rust
4. Implement activated rule loading from markdown files using the existing rule parser/helpers where possible.
5. Ensure activated rules have `_source` metadata.
6. Ensure disabled extension ids filter activated rules and skillsets.
7. Test matching/dedup/filter behavior without creating full agent sessions.

Acceptance:

- A Rust project produces one Rust activation plan.
- Non-Rust project produces no activation.
- `skillsets.disabledSkillsets=["rust"]` suppresses activation.
- `disabledExtensions=["rule:rust-unbounded-channel"]` removes that one rule.

### Phase 3 — Built-in Rust TTSR rule pack

Files to add:

```text
packages/coding-agent/src/skillsets/builtin/rust.ts
packages/coding-agent/src/skillsets/builtin/rust/rules/ttsr/rust-lock-across-await.md
packages/coding-agent/src/skillsets/builtin/rust/rules/ttsr/rust-unbounded-channel.md
packages/coding-agent/src/skillsets/builtin/rust/rules/ttsr/rust-async-std-fs.md
packages/coding-agent/src/skillsets/builtin/rust/rules/ttsr/rust-async-std-mpsc.md
packages/coding-agent/src/skillsets/builtin/rust/rules/ttsr/rust-unwrap-prod.md
packages/coding-agent/src/skillsets/builtin/rust/rules/ttsr/rust-silent-error-discard.md
packages/coding-agent/src/skillsets/builtin/rust/rules/ttsr/rust-error-source-chain.md
packages/coding-agent/src/skillsets/builtin/rust/rules/ttsr/rust-from-not-into.md
packages/coding-agent/src/skillsets/builtin/rust/rules/ttsr/rust-tokio-async-test.md
packages/coding-agent/src/skillsets/builtin/rust/rules/ttsr/rust-borrowed-api-params.md
packages/coding-agent/test/skillsets/rust-ttsr-rules.test.ts
```

Tasks:

1. Create short TTSR markdown files with frontmatter.
2. Keep body concise: what matched, why it matters, what to do instead.
3. Load them through the same markdown/frontmatter path as normal rules.
4. Test every rule:
   - frontmatter parses
   - `condition` exists
   - `scope` exists
   - `interruptMode` is present
   - `TtsrManager.addRule(rule)` returns true
5. Add positive and negative samples for each rule.
6. Verify rule scopes match Rust files and do not match non-Rust files.

Acceptance:

- All first-wave rules compile as TTSR rules.
- Each rule has at least one positive sample and one negative sample.
- No rule fires on `.ts` or `.py` tool paths.

### Phase 4 — SDK/session integration

Files likely to change:

```text
packages/coding-agent/src/sdk.ts
packages/coding-agent/src/system-prompt.ts
packages/coding-agent/src/prompts/system/system-prompt.md
packages/coding-agent/src/config/settings-schema.ts
packages/coding-agent/src/config/settings.ts
packages/coding-agent/test/sdk-skillsets.test.ts
```

Tasks:

1. Add settings schema entries.
2. In `createAgentSession`, resolve project facets and skillset activation before rule bucketing.
3. Merge activated skills into discovered skills, preserving existing provider/discovery behavior.
4. Merge activated rules into discovered rules before TTSR/alwaysApply/rulebook bucketing.
5. Ensure `setActiveRules([...rulebookRules, ...alwaysApplyRules])` remains correct; TTSR-only rules should not need `rule://` unless deliberately duplicated as rulebook variants.
6. Add compact active skillset prompt summary if enabled.
7. Keep startup latency bounded. If detection ever grows expensive, use a short deadline and continue without activation on timeout.

Acceptance:

- Creating a session in a Rust project activates Rust TTSR rules.
- Creating a session outside a Rust project does not activate them.
- Existing explicit project/user rules still work.
- Existing TTSR behavior and tests still pass.

### Phase 5 — Documentation

Files likely to change:

```text
docs/skills.md
docs/rulebook-matching-pipeline.md
docs/project-skillsets.md
```

Tasks:

1. Document the distinction:
   - skills = passive workflows/references
   - rules = constraints and guardrails
   - TTSR = active stream guardrails
   - skillsets = project-detected activation recipes
2. Document Rust pilot behavior.
3. Document settings and disabling:
   - disable all skillsets
   - disable Rust skillset
   - disable one rule
   - disable TTSR globally
4. Document authoring guidance for future skillsets.
5. Keep docs concrete; avoid fluff.

### Phase 6 — Validation and hardening

Run targeted tests first:

```bash
cd /Users/case/projects/external/oh-my-pi/packages/coding-agent
bun test test/ttsr.test.ts
bun test test/discovery/builtin-rules-md.test.ts
bun test test/project-detection/rust.test.ts
bun test test/skillsets/activation.test.ts
bun test test/skillsets/rust-ttsr-rules.test.ts
bun test test/sdk-skillsets.test.ts
```

Then run package checks:

```bash
cd /Users/case/projects/external/oh-my-pi/packages/coding-agent
bun run check:types
bun run check
bun test
```

If root-level workflows are preferred or required:

```bash
cd /Users/case/projects/external/oh-my-pi
bun test packages/coding-agent/test/ttsr.test.ts
bun test packages/coding-agent/test/skillsets/rust-ttsr-rules.test.ts
```

Acceptance:

- targeted tests pass
- typecheck passes
- formatter/linter passes
- full package test suite passes or existing unrelated failures are documented with evidence

## Suggested implementation order

1. Add Rust detector and tests.
2. Add skillset activation types/core and tests.
3. Add built-in Rust manifest without TTSR rule files yet; test activation only.
4. Add first two TTSR rules:
   - `rust-lock-across-await.md`
   - `rust-unbounded-channel.md`
5. Add rule loading/compilation tests for those two.
6. Integrate activation plan with `sdk.ts` rule bucketing.
7. Verify those two rules trigger in a Rust temp project and not elsewhere.
8. Add the remaining first-wave eight rules.
9. Add prompt activation notice.
10. Add docs.
11. Run full validation.

This staged order reduces risk: prove the activation mechanism with two high-confidence rules before adding the whole pack.

## Test matrix

### Project detection tests

| Case | Files | Expected |
|---|---|---|
| Cargo package | `Cargo.toml` with `[package]` | `language:rust`, `build:cargo` high confidence |
| Cargo workspace | `Cargo.toml` with `[workspace]` | `language:rust`, `build:cargo`, possibly `workspace:cargo` |
| Rust source only | `src/lib.rs` | Rust facet lower confidence |
| Non-Rust | `package.json`, no Rust markers | no Rust facet |
| Nested crate cwd | cwd under `crates/foo` | root/evidence stable |

### Skillset activation tests

| Case | Settings | Expected |
|---|---|---|
| default Rust project | default | Rust skillset active |
| non-Rust project | default | no Rust skillset |
| disabled all skillsets | `skillsets.enabled=false` | no activation |
| disabled auto-detect | `skillsets.autoDetect=false` | no auto activation |
| disabled Rust | `skillsets.rust.enabled=false` | no Rust activation |
| disabled one rule | `disabledExtensions=["rule:rust-unbounded-channel"]` | other Rust rules active, that rule absent |
| Rust TTSR off | `skillsets.rust.ttsrProfile=off` | Rust skillset active, zero Rust TTSR rules |

### TTSR rule tests

Each built-in Rust TTSR rule should have:

- positive Rust edit/write match
- negative non-Rust path mismatch
- negative explanation/prose case if scope excludes text
- at least one false-positive guard sample where feasible

Example for `rust-unbounded-channel`:

```ts
expect(manager.checkDelta("let (tx, rx) = mpsc::unbounded_channel::<Msg>();", {
  source: "tool",
  toolName: "write",
  filePaths: ["src/main.rs"],
})).toEqual([rule]);

expect(manager.checkDelta("let (tx, rx) = mpsc::unbounded_channel::<Msg>();", {
  source: "tool",
  toolName: "write",
  filePaths: ["src/main.ts"],
})).toEqual([]);
```

## Risks and mitigations

### Risk: TTSR false positives make the agent annoying

Mitigations:

- start with 10 high-signal rules only
- scope to `tool:write`/`tool:edit` and `**/*.rs`
- avoid `text` and `thinking` by default
- allow disabling individual rules through `disabledExtensions`
- make second-wave rules opt-in or non-blocking first

### Risk: Regex cannot express absence well

Examples:

- unsafe block without nearby `SAFETY:`
- public unsafe function without `# Safety`
- test module without preceding `#[cfg(test)]`

Mitigation:

- do not ship these as blocking first-wave TTSR
- keep them as rulebook or non-blocking reminders unless matching improves
- consider future structural parser/tree-sitter matching as a separate feature

### Risk: Startup latency grows

Mitigations:

- marker-based detection only for first implementation
- no default `cargo metadata`
- bounded directory checks
- no recursive full-repo scan unless cached and deadline-bound

### Risk: Capability merging becomes hard to reason about

Mitigations:

- keep skillsets as activation planning, not a new parallel capability universe
- merge into existing `Skill` and `Rule` arrays before existing prompt/rule bucketing
- preserve existing dedupe keys and `disabledExtensions`
- test precedence explicitly

### Risk: Built-in Rust pack gets stale against external rust-skills

Mitigations:

- treat OMP TTSR pack as curated runtime guardrails, not a mirror
- include source-reference comments/docs mapping each guardrail to rust-skills rule files
- review periodically, but do not auto-import all rules

## Open questions

1. Should Rust skillset activation be default-on for all detected Rust projects? Recommendation: yes, with only the safe first-wave TTSR profile.
2. Should the Rust skillset also expose a `skill://rust` workflow? Recommendation: later, after the TTSR pilot. First ship the active guardrails without requiring an external local skill directory.
3. Should TTSR rules be visible through `rule://`? Current OMP behavior excludes TTSR-only rules from active `rule://`. Recommendation: do not force visibility initially; if needed, create separate rulebook companions later.
4. Should custom skillsets ship in this PR? Recommendation: define the data model with custom support in mind, but do not block the Rust pilot on full custom manifest loading.
5. Should matching use tree-sitter/Rust AST? Recommendation: not for this PR. Regex scoped to tool writes is enough for first-wave rules; structural matching is a future capability.

## Definition of done

This work is complete when:

1. Rust projects are detected from workspace markers.
2. The Rust skillset auto-activates by default in detected Rust projects.
3. Ten first-wave Rust TTSR rules are loaded only for Rust project sessions.
4. The rules compile and match positive/negative tests.
5. Users can disable all skillsets, the Rust skillset, or individual Rust TTSR rules.
6. Existing skill/rule/TTSR behavior remains compatible.
7. Prompt additions are compact and do not dump long Rust guidance.
8. Documentation explains skillsets, rules, skills, and TTSR clearly.
9. Targeted tests, typecheck, and package checks pass.

## Final target architecture

```text
ProjectDetector
  detects facets from workspace evidence

SkillsetResolver
  maps facets + settings to activation plan

SkillsetActivationPlan
  contains activated skills, rules, summaries, warnings

SDK session startup
  merges activated skills/rules into existing OMP capability flow

Existing OMP rule pipeline
  buckets rules into TTSR / always-apply / rulebook

Existing TTSR runtime
  interrupts or reminds only when high-signal Rust guardrail conditions match generated Rust edits/writes
```

This preserves OMP's existing capability architecture while adding LSP-like project sensitivity and a practical Rust guardrail pilot.
