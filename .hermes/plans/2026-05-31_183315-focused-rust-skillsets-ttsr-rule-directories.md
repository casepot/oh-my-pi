# Fresh Implementation Plan: Project-Gated Rule Directories and Built-in Rust TTSR Pack

## Goal

Refine and extend the current OMP project-aware skillset implementation so it can safely activate curated rule/TTSR guardrails by detected project type, with Rust as the first built-in pilot.

The focused end state:

```text
current project detection
  -> current skillset activation
  -> active skillset loads rule objects
  -> existing rule bucketing/TTSR pipeline
  -> built-in Rust TTSR guardrails only when a Rust project is detected
```

This supersedes the broader earlier plan at:

```text
/Users/case/projects/external/oh-my-pi/.hermes/plans/2026-05-31_174046-rust-project-skillsets-ttsr-end-to-end.md
```

That earlier plan is directionally correct but stale: project detection, skillset definitions, skillset activation, prompt summaries, and session wiring already exist in the current working tree. The next plan should not rebuild those foundations.

## Current base from investigation

Current working tree is representative enough to design against. Relevant current facts:

### Already implemented

- Project detection exists in:
  - `packages/coding-agent/src/project-detection/defaults.ts`
  - `packages/coding-agent/src/project-detection/detect.ts`
  - `packages/coding-agent/src/project-detection/types.ts`
- Current facet ids are simple ids:
  - `rust`, `node`, `typescript`, `python`, `go`, `java`
- Skillset capability exists in:
  - `packages/coding-agent/src/capability/skillset.ts`
- Skillset config loading exists in:
  - `packages/coding-agent/src/discovery/skillsets.ts`
- Skillset activation exists in:
  - `packages/coding-agent/src/extensibility/skillsets.ts`
- SDK integration exists in:
  - `packages/coding-agent/src/sdk.ts`
- Prompt rendering exists in:
  - `packages/coding-agent/src/system-prompt.ts`
- Current docs exist in:
  - `docs/skillsets.md`
  - `docs/skills.md`
- Rule/TTSR machinery exists in:
  - `packages/coding-agent/src/capability/rule.ts`
  - `packages/coding-agent/src/discovery/helpers.ts`
  - `packages/coding-agent/src/discovery/builtin.ts`
  - `packages/coding-agent/src/export/ttsr.ts`
  - `packages/coding-agent/src/session/agent-session.ts`
  - `docs/rulebook-matching-pipeline.md`
  - `docs/ttsr-injection-lifecycle.md`

### Current skillset schema

Use the current vocabulary, not the stale `detect` / `activates` vocabulary:

```yaml
skillsets:
  rust:
    description: Rust coding, review, and refactoring guidance.
    mode: auto
    match:
      facets: [rust]
    provides:
      skillDirectories:
        - /path/to/external-skills
      skills:
        - rust-skills
      promptSummary: Rust project detected. Use rust-skills for Rust work.
```

Current settings:

```text
skillsets.enabled
skillsets.mode              # auto | suggest | off
skillsets.disabled
skillsets.include
skillsets.customFiles
skillsets.customDirectories
skillsets.maxAlwaysApplyChars
skillsets.maxPromptSummaryChars
skillsets.showDetectedInPrompt
```

### Key gap

`SkillsetProvides.ruleDirectories` is already present in the type and parser:

```ts
// packages/coding-agent/src/capability/skillset.ts
ruleDirectories?: string[];
```

and parsed in:

```text
packages/coding-agent/src/discovery/skillsets.ts
packages/coding-agent/src/extensibility/skillsets.ts
```

but it is not consumed. `docs/skillsets.md` currently says:

```text
Rule directory ingestion is intentionally not part of the first implementation.
```

The central remaining architectural move is therefore:

```text
active skillset -> loaded Rule[] -> existing SDK rule bucketing/TTSR pipeline
```

not “add skillsets.”

### Important TTSR bug / caveat

`ttsr.enabled` exists in settings and is documented, but current runtime does not appear to enforce it. `TtsrManager` stores `enabled`, but `addRule()` and `checkDelta()` do not check it, and `sdk.ts` registers TTSR rules regardless.

This should be fixed before enabling project-gated TTSR rule packs by default.

## Non-goals

- Do not redesign project detection from scratch.
- Do not introduce a parallel skillset architecture outside current `capability`, `discovery`, `extensibility`, SDK, and prompt paths.
- Do not mutate `/Users/case/projects/_external-skills/rust-skills`.
- Do not convert all 179 external Rust rules into TTSR.
- Do not load the full Rust rule corpus into the prompt.
- Do not make TTSR a replacement for rustc, Clippy, rustfmt, tests, or CI.
- Do not make built-in Rust TTSR depend on a local checkout path such as `/Users/case/projects/_external-skills`.
- Do not use broad default TTSR scopes. Built-in Rust rules must be scoped to Rust edit/write tool calls.

## Design refinements from the previous plan

Drop these stale assumptions:

- `ProjectFacet.id` should not become `language:rust` / `build:cargo` in this iteration. Current ids are `rust`, `node`, etc.
- Do not create `packages/coding-agent/src/skillsets/types.ts` or a new standalone skillset subsystem unless implementation forces it. Current types live in `capability/skillset.ts`; current orchestration lives in `extensibility/skillsets.ts`.
- Do not use settings like `skillsets.autoDetect`, `skillsets.enabledSkillsets`, or `skillsets.disabledSkillsets`; use current settings.
- Do not assume `ruleDirectories` currently works.
- Do not assume a condition rule remains available through `rule://`; current TTSR-only rules are not added to active rulebook rules.

Keep these architectural principles:

- Skillsets are LSP-style activation recipes.
- Prompt bloat avoidance is mandatory.
- Rust is the pilot, not a hard-coded one-off model.
- TTSR is for high-signal, stream-detectable mistakes only.
- Long-form Rust knowledge remains skill/reference content; active TTSR guardrails are short runtime constraints.

## Target behavior

### User-visible behavior

When OMP starts in a Rust project:

1. Project detection emits a `rust` facet from `Cargo.toml`, `Cargo.lock`, `rust-toolchain*`, `rustfmt.toml`, `clippy.toml`, or a bounded `**/*.rs` fallback.
2. Built-in `rust` skillset activates unless disabled.
3. System prompt shows a compact Active Project Skillsets entry, for example:

```text
# Active Project Skillsets
- rust: detected from Cargo.toml (root ~/repo). Rust TTSR guardrails are active for generated Rust edits.
```

4. Built-in Rust TTSR rules are registered only for this session.
5. The rules trigger only on Rust tool-call content, primarily `edit` and `write` targeting `.rs` paths.
6. Full external `rust-skills` remains optional and can still be activated by user/project skillset config through `skillDirectories`.

When OMP starts outside a Rust project:

- built-in Rust skillset does not activate
- built-in Rust TTSR rules do not register
- editing a random `.rs` file in a non-Rust session should not unexpectedly activate the whole Rust pack unless project detection has found the `rust` facet

### Disable semantics

Support these controls:

```text
skillsets.enabled: false               # disables all project-aware skillsets
skillsets.mode: off                    # disables all project-aware skillsets
skillsets.mode: suggest                # detects but does not activate
skillsets.disabled: [rust]             # disables Rust skillset by id
skillsets.include: [node]              # allowlist excludes Rust
settings.disabledExtensions: [skillset:rust]
settings.disabledExtensions: [rule:rust-lock-across-await]
ttsr.enabled: false                    # no TTSR registration or matching
```

### Rule precedence

Use conservative precedence:

1. `options.rules`, if supplied to `createAgentSession`, is authoritative; skip auto-discovered and skillset-provided rule objects.
2. Normal discovered rules from `loadCapability("rules")` win over skillset-loaded rules by name.
3. Active skillset-provided rules append after discovered rules.
4. Among active skillsets, activation order wins:
   - definition priority descending
   - id lexical order, matching current sorting
5. `disabledExtensions: ["rule:<name>"]` wins over all skillset force lists and rule directories.
6. `provides.alwaysApplyRules` and `provides.rules` force bucket behavior for active rule names, but cannot resurrect disabled rules.

Rationale: project-local `.omp/rules` and explicit SDK options should override generic activated packs.

## Proposed implementation phases

## Phase 1 — Make `ttsr.enabled` real

Do this before adding any new TTSR rule pack.

### Files likely to change

```text
packages/coding-agent/src/export/ttsr.ts
packages/coding-agent/src/sdk.ts
packages/coding-agent/test/ttsr.test.ts
packages/coding-agent/test/sdk-ttsr.test.ts              # new or existing suitable SDK test file
```

### Implementation details

1. In `TtsrManager.addRule(rule)`, return `false` when `this.#settings.enabled === false`.
2. In `TtsrManager.checkDelta(...)`, return `[]` when disabled as a defensive guard.
3. In `sdk.ts`, read `ttsrSettings.enabled` before bucket logic.
4. Do not register TTSR rules when disabled.
5. Decide bucket behavior for disabled TTSR:
   - Recommended: pure condition rules should not auto-promote into rulebook solely because TTSR is disabled.
   - Explicit `provides.rules` can still force a named rule into rulebook.
   - Explicit `provides.alwaysApplyRules` can still force a named rule into always-apply.

Suggested SDK policy:

```ts
const hasCondition = rule.condition && rule.condition.length > 0;
const ttsrEnabled = ttsrSettings.enabled !== false;

if (!forceAlwaysApply && !forceRulebook && hasCondition) {
  if (ttsrEnabled && ttsrManager.addRule(rule)) continue;
  if (!ttsrEnabled) continue; // pure TTSR rule suppressed, not auto-promoted
}
```

Keep existing behavior for invalid condition regexes when TTSR is enabled: if `addRule()` returns false due to invalid regex and the rule has a description, it may fall through to rulebook. That is useful for user-authored rules with bad TTSR metadata.

### Tests

Add/adjust tests:

```text
TtsrManager({ enabled: false }).addRule(rule) returns false
TtsrManager({ enabled: false }).checkDelta(...) returns []
SDK with ttsr.enabled=false does not trigger/interruption-register condition rules
SDK with ttsr.enabled=false can still force a condition rule into rulebook if provides.rules names it
```

## Phase 2 — Add a shared rule directory scanner

### Files likely to change

```text
packages/coding-agent/src/discovery/helpers.ts
packages/coding-agent/test/discovery/rule-directory.test.ts       # new
```

### Implementation details

Add a helper analogous to `scanSkillsFromDir`, for example:

```ts
export async function scanRulesFromDir(
  ctx: LoadContext,
  options: {
    dir: string;
    providerId: string;
    level: "user" | "project";
    recursive?: boolean;          // default false for first pass
    stripNamePattern?: RegExp;    // default /\.(md|mdc)$/
  },
): Promise<LoadResult<Rule>>
```

Implementation should reuse existing primitives:

```text
buildRuleFromMarkdown(...)
loadFilesFromDir(...)
createSourceMeta(...)
```

First-pass semantics:

- Flat directory scan only, matching current `.omp/rules` behavior.
- Accept `*.md` and `*.mdc`.
- Rule name derives from filename without extension.
- Frontmatter parsing is identical to existing providers.
- Return warnings instead of throwing for missing/unreadable files where existing helpers do so.
- Sort file names deterministically if `loadFilesFromDir` does not already guarantee ordering.

### Tests

```text
loads .md and .mdc from a directory
parses description / globs / alwaysApply / condition / scope / interruptMode
supports legacy ttsr_trigger / ttsrTrigger through existing parser
filename-derived names are stable
invalid regex does not fail directory scanning; TTSR add handles it later
```

## Phase 3 — Teach skillset activation to load rule objects

### Files likely to change

```text
packages/coding-agent/src/extensibility/skillsets.ts
packages/coding-agent/src/capability/skillset.ts            # if result/types need expansion
packages/coding-agent/test/skillsets-activation.test.ts
packages/coding-agent/test/skillsets-rule-directories.test.ts # new
```

### Type changes

Extend `CompileSkillsetActivationResult` to carry activated rule objects separately from force-by-name sets:

```ts
export interface CompileSkillsetActivationResult extends SkillsetActivationPlan {
  skills: Skill[];
  skillWarnings: SkillWarning[];
  alwaysApplyRuleNames: Set<string>;
  ruleNames: Set<string>;
  rules: Rule[]; // new: Rule objects loaded by active skillsets
}
```

Do not overload `ruleNames`.

Current meaning should remain:

```text
ruleNames = names forced into rulebook by provides.rules
alwaysApplyRuleNames = names forced into always-apply by provides.alwaysApplyRules
rules = actual Rule objects supplied by active skillsets/rule packs
```

### Rule name filter

Add a rule-name filter analogous to `createSkillNameFilter`:

```ts
function createRuleNameFilter(disabledExtensions: readonly string[] | undefined) {
  const disabledRuleNames = new Set(
    (disabledExtensions ?? [])
      .filter(id => id.startsWith("rule:"))
      .map(id => id.slice(5)),
  );
  return { canUse: (name: string) => !disabledRuleNames.has(name) };
}
```

`disabledExtensions: ["rule:<name>"]` should suppress:

- directory-loaded rules
- embedded built-in rules
- forced rulebook inclusion
- forced always-apply inclusion
- TTSR registration

### Project path safety

Mirror current skill directory safety:

For project-level skillsets:

- `ruleDirectories` must be relative to the activation root
- absolute paths and `~` are rejected
- resolved realpath must stay within activation root

For user/custom/plugin skillsets:

- `~` and absolute paths are allowed
- expand via `expandTilde`

Rationale: project config should not be able to load arbitrary local machine rule directories just because a repository was opened.

### Directory scanning behavior

Add `scanSkillsetRuleDirectories(...)` beside `scanSkillsetSkillDirectories(...)`.

The function should:

1. Resolve and validate each active `activation.effects.ruleDirectories` entry.
2. Scan with `scanRulesFromDir` using `providerId: skillset:<id>`.
3. Assign source level based on `activation.skillset._source.level`.
4. Apply disabled rule filter.
5. Deduplicate by realpath, then by rule name.
6. Emit collision warnings using the existing activation warning channel.
7. Return `Rule[]` without mutating `activation.effects.rules`.

Do not automatically add directory-loaded rule names into `activation.effects.rules`; that would force condition rules into the rulebook and prevent TTSR registration.

### Tests

```text
active skillset ruleDirectories loads rule files into plan.rules
suggest-mode skillset does not load ruleDirectories
manual skillset does not load ruleDirectories
non-matching skillset does not load ruleDirectories
missing rule directory emits warning
project skillset rejects absolute ruleDirectories
project skillset rejects escaping relative ruleDirectories
user skillset accepts absolute/tilde ruleDirectories
rule:<name> disables a directory-loaded rule
skillset:<id> disables the whole activation before scanning
same rule realpath is loaded once
same rule name collides deterministically and first active source wins
condition rule from ruleDirectories is not added to ruleNames by default
```

## Phase 4 — Merge activated rules into SDK rule bucketing

### Files likely to change

```text
packages/coding-agent/src/sdk.ts
packages/coding-agent/test/sdk-skillsets.test.ts
packages/coding-agent/test/sdk-skillsets-rules.test.ts       # new
```

### Implementation details

Current SDK bucket path:

```ts
const rulesResult =
  options.rules !== undefined
    ? { items: options.rules, warnings: undefined }
    : await loadCapability<Rule>(ruleCapability.id, { cwd });
```

Refine it to:

1. Preserve `options.rules` as authoritative.
2. Otherwise load normal rules with disabled extension filtering explicit.
3. Append active skillset rules after discovered rules, skipping disabled names and name collisions.
4. Bucket the merged list with existing logic.

Sketch:

```ts
const baseRules =
  options.rules !== undefined
    ? options.rules
    : (await loadCapability<Rule>(ruleCapability.id, {
        cwd,
        disabledExtensions: disabledExtensionIds,
      })).items;

const allRules =
  options.rules !== undefined
    ? baseRules
    : mergeRulesFirstWins(baseRules, activationPlan.rules);
```

`mergeRulesFirstWins` should:

- preserve base rule order
- keep first name
- append active skillset rules only when name is absent
- optionally emit/propagate warnings for skipped duplicates

### Bucket logic

Keep existing force semantics:

```text
forceAlwaysApply > forceRulebook > TTSR > alwaysApply > description/rulebook
```

But enforce `ttsr.enabled` from Phase 1.

Important: skillset-provided condition rules should become TTSR by default, not rulebook. They only enter rulebook when forced by `provides.rules` or when they are authored without `condition` and have `description`.

### Tests

```text
skillset-loaded described non-condition rule appears in system prompt rulebook and rule://
skillset-loaded alwaysApply rule injects into generic/always-apply rules
skillset-loaded condition rule registers as TTSR and is not active via rule://
provides.rules forces a named condition rule into rulebook instead of TTSR
provides.alwaysApplyRules forces a named condition rule into always-apply instead of TTSR
normal .omp/rules rule shadows same-name skillset rule
options.rules skips automatic skillset-provided rule merging
rule:<name> disabled extension suppresses rule in all buckets
```

## Phase 5 — Add built-in Rust skillset and embedded Rust TTSR rule pack

### Files likely to add/change

Recommended packaging-safe layout:

```text
packages/coding-agent/src/skillsets/builtin/index.ts          # new
packages/coding-agent/src/skillsets/builtin/rust.ts           # new
packages/coding-agent/src/skillsets/builtin/rust-rules.ts     # new
packages/coding-agent/src/skillsets/builtin/rust/rules/
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

Potential integration files:

```text
packages/coding-agent/src/extensibility/skillsets.ts
packages/coding-agent/src/discovery/skillsets.ts
packages/coding-agent/src/discovery/index.ts                  # only if implemented as provider registration
packages/coding-agent/test/rust-skillset-ttsr.test.ts          # new
```

### Built-in definition loading

Add built-in skillset definitions after custom/native definitions so user/project/custom definitions can shadow them by id.

Recommended behavior:

```text
customFiles/customDirectories > project/user/plugin definitions > built-in definitions
```

For a built-in `rust` definition:

```ts
{
  id: "rust",
  description: "Rust edit guardrails for async, error handling, APIs, and tests.",
  mode: "auto",
  priority: -100,
  match: { facets: ["rust"] },
  provides: {
    promptSummary:
      "Rust project detected. Curated Rust TTSR guardrails are active for generated .rs edits. Use configured Rust skills for deeper workflow guidance.",
  },
  _source: {
    provider: "builtin-skillsets",
    providerName: "Built-in Skillsets",
    path: "builtin://skillsets/rust",
    level: "user", // or project-neutral if SourceMeta allows future expansion
  },
}
```

Do not make the built-in Rust skillset depend on external `rust-skills`. External Rust skills can be added separately by user/project config:

```yaml
provides:
  skillDirectories:
    - /Users/case/projects/_external-skills
  skills:
    - rust-skills
```

### Built-in rule packaging

Prefer importing markdown files as text rather than relying solely on runtime filesystem reads, because compiled/bundled OMP paths may not preserve arbitrary source directories.

Pattern:

```ts
import lockAcrossAwait from "./rust/rules/rust-lock-across-await.md" with { type: "text" };
```

Then parse with existing rule helper:

```ts
buildRuleFromMarkdown(
  "rust-lock-across-await.md",
  lockAcrossAwait,
  "builtin://skillsets/rust/rules/rust-lock-across-await.md",
  builtinSource,
)
```

This keeps authoring as markdown while making runtime packaging explicit.

The activation compiler should include these embedded Rule objects when the built-in `rust` skillset activates.

Implementation options, in order of preference:

1. Add an internal built-in skillset registry:
   - `getBuiltinSkillsetDefinitions()`
   - `getBuiltinSkillsetRules(skillsetId)`
2. Append built-in definitions in `loadSkillsetDefinitions(...)` after discovered definitions.
3. During `compileSkillsetActivationPlan(...)`, when an activated definition source is `builtin-skillsets`, append `getBuiltinSkillsetRules(definition.id)` to `result.rules`.

This avoids exposing arbitrary inline `Rule` objects in user-authored skillset JSON/YAML while still supporting filesystem `ruleDirectories` for user/project/extension packs.

### Rust TTSR authoring standard

Every built-in Rust TTSR rule should be short and active, not educationally long.

Common frontmatter:

```yaml
---
description: One-line explanation for logs/debugging.
condition:
  - "...regex..."
scope:
  - "tool:edit(*.rs)"
  - "tool:write(*.rs)"
interruptMode: tool-only
---
```

Body should be concise:

```text
You are generating or editing Rust code that appears to violate <specific rule>.
Before writing this change, revise the code to <specific fix>, or add an explicit justification if this is intentional.
```

Do not use default scope. Default scope allows assistant text and any tool; built-in Rust rules must explicitly scope to Rust edit/write tools.

### First-wave Rust TTSR rules

| File | Purpose | Initial condition strategy | Notes |
| --- | --- | --- | --- |
| `rust-lock-across-await.md` | Avoid holding `Mutex`/`RwLock` guards across `.await` | detect `.lock()` / `.read()` / `.write()` followed soon by `.await` | highest priority; wording must allow explicit drop before await |
| `rust-unbounded-channel.md` | Avoid unbounded Tokio channels without justification | `mpsc::unbounded_channel`, `UnboundedSender`, `UnboundedReceiver` | ask for bounded channel or explicit rationale |
| `rust-async-std-fs.md` | Avoid blocking `std::fs` in async contexts | async fn / tokio::spawn async containing `std::fs::...` | may false-positive startup reads; scope text carefully |
| `rust-async-std-mpsc.md` | Avoid `std::sync::mpsc` inside async/Tokio code | `tokio::spawn(async` or `async fn` near `std::sync::mpsc` | prefer `tokio::sync::mpsc` |
| `rust-unwrap-prod.md` | Avoid unwrap on fallible production operations | fallible APIs near `.unwrap()` | do not catch all unwraps; tests/examples are legitimate |
| `rust-silent-error-discard.md` | Avoid silently discarding errors | `Err(_) => {}`, `let _ = fallible`, `.ok();` | ask for log/propagate/comment |
| `rust-error-source-chain.md` | Preserve source error chains | `map_err(|e| e.to_string())`, `Err(e.to_string())` | precise and high-signal |
| `rust-from-not-into.md` | Prefer `From` over direct `Into` impls | `impl Into<...> for ...` | crisp API rule |
| `rust-tokio-async-test.md` | Use `#[tokio::test]` for async tests | `#[test] async fn`, manual `Runtime::new().block_on` | test-scope focused |
| `rust-borrowed-api-params.md` | Prefer `&[T]`, `&str`, `&Path` params | function params `&Vec<`, `&String`, `&PathBuf` | allow trait/API exceptions |

Second-wave candidates should remain out of the first implementation:

```text
entry API
push_str(&format!(...))
simple 0..len indexing loops
unsafe safety docs reminders
collect-then-immediate-use
benchmark black_box rules
```

Add second-wave only after first-wave false positive behavior is observed.

## Phase 6 — Documentation and changelog updates

### Files likely to change

```text
docs/skillsets.md
docs/skills.md
docs/rulebook-matching-pipeline.md
docs/ttsr-injection-lifecycle.md
packages/coding-agent/CHANGELOG.md
```

### Required docs changes

In `docs/skillsets.md`:

- Replace “Rule directory ingestion is intentionally not part of the first implementation.”
- Document `ruleDirectories` behavior:
  - active skillsets only
  - flat `*.md` / `*.mdc` scan
  - project-relative safety
  - user/custom absolute path allowance
  - disabled extension semantics
- Document built-in Rust skillset:
  - activates from `rust` facet
  - supplies TTSR guardrails
  - does not depend on external `rust-skills`
- Document external Rust skills remain optional.

In `docs/rulebook-matching-pipeline.md`:

- Add skillset-provided rules as an additional source after normal discovery.
- Explain merge precedence.
- Explain forced bucket names from `provides.rules` and `provides.alwaysApplyRules`.
- Explicitly state that TTSR-only rules are not `rule://` entries unless forced or companion rulebook rules exist.

In `docs/ttsr-injection-lifecycle.md`:

- Remove/update the caveat that `ttsr.enabled` is not enforced after Phase 1.
- Add skillset-loaded TTSR rules to registration source description.
- Mention built-in Rust guardrails if shipped.

In `docs/skills.md`:

- Keep clear distinction:
  - skills are passive `skill://` capability packs
  - rules are active/rulebook constraints
  - skillsets activate both based on detected project context
- Clarify external `rust-skills` rules under `skill://rust-skills/rules/...` are not automatically OMP rules unless a skillset explicitly loads a rule directory or a built-in pack provides rules.

In changelog:

```text
Added: skillset ruleDirectories can load active rule/TTSR rule packs for matched projects.
Added: built-in Rust skillset with curated TTSR guardrails for generated Rust edits.
Fixed: ttsr.enabled now actually disables TTSR registration/matching.
Changed: skillset docs now describe active rule loading and precedence.
```

## Phase 7 — Validation plan

### Focused tests

Run from:

```text
/Users/case/projects/external/oh-my-pi/packages/coding-agent
```

Suggested commands:

```bash
bun test test/ttsr.test.ts
bun test test/discovery/rule-directory.test.ts
bun test test/project-detection.test.ts test/skillsets-activation.test.ts test/skillsets-config.test.ts test/system-prompt-skillsets.test.ts test/sdk-skillsets.test.ts
bun test test/sdk-skillsets-rules.test.ts test/rust-skillset-ttsr.test.ts
```

### Broader package checks

```bash
bun test
bun run check:types
bun run check
```

`package.json` current relevant scripts:

```text
build: bun scripts/build-binary.ts
check: biome check . && bun run check:types
check:types: tsgo -p tsconfig.json --noEmit
lint: biome lint .
test: bun test
```

### Manual smoke scenario

Create a temp Rust project:

```text
/tmp/omp-rust-smoke/
  Cargo.toml
  src/lib.rs
```

Start a session with skillsets and TTSR enabled, then attempt a write/edit containing one known pattern such as `impl Into<...> for ...` or `mpsc::unbounded_channel`.

Expected:

- Active Project Skillsets includes `rust`.
- Rust TTSR rule registers.
- Matching tool-call content triggers TTSR behavior.
- Disabling `skillsets.disabled: [rust]` suppresses it.
- Disabling `rule:rust-from-not-into` suppresses just that rule.
- Disabling `ttsr.enabled` suppresses TTSR behavior.

## Recommended task breakdown for implementation

### Task 1 — TTSR enabled gate

- Implement `ttsr.enabled` in `TtsrManager` and SDK bucket logic.
- Add unit tests.
- Update `docs/ttsr-injection-lifecycle.md` caveat.

### Task 2 — Rule directory scanner

- Add `scanRulesFromDir` helper.
- Add tests for parser parity and deterministic naming.

### Task 3 — Skillset ruleDirectories ingestion

- Extend `CompileSkillsetActivationResult` with `rules: Rule[]`.
- Add `scanSkillsetRuleDirectories`.
- Enforce project-relative safety.
- Apply `rule:<name>` filter.
- Add activation-level tests.

### Task 4 — SDK rule merge and bucket integration

- Merge activated rules into the existing rule bucketing pass.
- Preserve first-wins precedence.
- Add SDK/system-prompt tests for rulebook, always-apply, TTSR, force-by-name, disabled-by-name, and explicit `options.rules`.

### Task 5 — Built-in Rust skillset and embedded rule pack

- Add built-in skillset definition with low precedence.
- Add embedded Markdown-backed Rust TTSR rules.
- Ensure built-in rules are included only when `rust` skillset activates.
- Add positive/negative samples for each rule.

### Task 6 — Docs/changelog

- Update skillsets, skills, rulebook, TTSR lifecycle, changelog.
- Keep docs aligned with exact setting names and current manifest vocabulary.

### Task 7 — Final validation

- Run focused tests.
- Run package test/check commands.
- Inspect `git diff --stat` and relevant diffs for accidental scope creep.

## Risks and mitigations

### Risk: regex false positives

Mitigation:

- Start with only 10 high-signal rules.
- Use `tool:edit(*.rs)` / `tool:write(*.rs)` scopes.
- Add positive and negative samples per rule.
- Use wording that asks to revise or explicitly justify, not blindly ban.

### Risk: prompt bloat

Mitigation:

- TTSR rules do not enter rulebook by default.
- Active skillset prompt summary stays compact.
- No full external Rust rule corpus is injected.

### Risk: built-in rule files missing in compiled binaries

Mitigation:

- Import built-in Markdown rule files with `with { type: "text" }` and parse from embedded strings.
- Do not rely only on filesystem directory reads for built-in packs.
- Keep filesystem `ruleDirectories` for user/project/extension packs.

### Risk: project config loads arbitrary local files

Mitigation:

- Project-level `ruleDirectories` must be relative to activation root.
- Reject `~` and absolute paths for project-level skillsets.
- Validate realpath containment.

### Risk: ambiguous rule precedence

Mitigation:

- Normal discovered rules win over skillset rules.
- Skillset rules append first-wins.
- Document the precedence.
- Test same-name collisions.

### Risk: `ttsr.enabled=false` surprises users

Mitigation:

- Enforce it both at registration and match time.
- Decide and document that pure TTSR rules are suppressed when TTSR is disabled, unless explicitly forced into rulebook/always-apply.

### Risk: monorepo/nested roots

Mitigation:

- Use existing facet root as activation root.
- Project-relative rule directories resolve against activation root.
- Add tests for nested Rust project in a larger repo if time permits.

## Open questions

1. Should built-in Rust TTSR be enabled by default in all Rust projects?

Recommended answer: yes, but only after `ttsr.enabled` is fixed and rules are scoped to edit/write `.rs` tool calls. Users can disable via `skillsets.disabled`, `disabledExtensions`, or `ttsr.enabled`.

2. Should built-in Rust TTSR rules be visible through `rule://`?

Recommended answer: not by default. They are runtime guardrails. If rulebook visibility is desired later, add companion non-TTSR rulebook summaries or force specific names via `provides.rules`.

3. Should the public schema add `rulePacks`?

Recommended answer: not in the first pass. Keep user schema to `ruleDirectories`, `rules`, and `alwaysApplyRules`. Use an internal built-in registry for embedded Rust rules to avoid packaging risks.

4. Should project skillsets be allowed to reference absolute `ruleDirectories`?

Recommended answer: no. Match existing `skillDirectories` hardening: project skillsets must stay project-relative; user/custom configs can use absolute paths.

5. Should condition rules with descriptions become rulebook rules when `ttsr.enabled=false`?

Recommended answer: not automatically for pure TTSR rules. Explicit forcing via `provides.rules` should still work.

## Definition of done

- `ttsr.enabled=false` actually prevents TTSR registration and matching.
- Active skillsets can load rule directories into `Rule[]` objects.
- Skillset-loaded rules flow through existing SDK bucketing.
- Normal rules shadow skillset-provided rules by name.
- `rule:<name>` disables directory-loaded and built-in rules.
- Built-in Rust skillset activates only for detected Rust projects.
- First-wave Rust TTSR pack is embedded, scoped, tested, and documented.
- External `rust-skills` remains optional and separate.
- Focused tests and type checks pass.
- Docs/changelog reflect current behavior and exact setting names.
