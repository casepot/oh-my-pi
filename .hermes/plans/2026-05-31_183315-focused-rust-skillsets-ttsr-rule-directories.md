# Fresh Implementation Plan: Project-Gated Rule Directories and Built-in Rust TTSR Pack

## Goal

Refine and extend the current OMP project-aware skillset implementation so it can safely activate curated rule/TTSR guardrails by detected project type, with Rust as the first built-in pilot.

The focused end state:

```text
current project detection
  -> current skillset activation
  -> active skillset loads rule objects
  -> centralized bucketRules/TTSR pipeline
  -> built-in Rust TTSR guardrails only when strong Rust project evidence is detected
```

This supersedes `.hermes/plans/2026-05-31_174046-rust-project-skillsets-ttsr-end-to-end.md`. That earlier plan is directionally correct but stale: project detection, skillset definitions, skillset activation, prompt summaries, and session wiring already exist in the current working tree. The next plan should not rebuild those foundations.

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
active skillset -> loaded Rule[] -> centralized bucketRules/TTSR pipeline
```

not “add skillsets.”

### Upstream merge facts that change this plan

The latest upstream merge added a bundled default-rule substrate:

- `packages/coding-agent/src/discovery/builtin-defaults.ts`
- `packages/coding-agent/src/discovery/builtin-rules/index.ts`
- `packages/coding-agent/src/capability/rule-buckets.ts`
- settings: `ttsr.builtinRules`, `ttsr.disabledRules`
- docs now describe `bucketRules(...)` as the rule bucketing funnel

This is material. Do not add a second, parallel embedded Rust-rule system. Reuse and correct the bundled-rule substrate:

- split global defaults from project-gated Rust defaults
- use the existing embedded Markdown import pattern
- route every rule through one bucket/filter path
- keep rule names consistent with the existing bundled convention (`rs-*`, `ts-*`)

Current caveats in that upstream substrate:

- `ttsr.enabled` still is not enforced by `TtsrManager.addRule()`, `TtsrManager.checkDelta()`, or SDK bucketing.
- `builtin-defaults` currently builds source metadata as `level: "user"` even though bundled defaults should be native; if fixed without splitting the pack, existing `rs-*` rules would become globally active.
- `bucketRules(...)` exists, but current `sdk.ts` still hand-rolls the bucket loop.
- Existing upstream `rs-*` rules are candidates to audit, not automatic members of the project-gated Rust pack. Some are style or project-policy rules, not high-signal default interruptions.

### Current package-suite rebaseline gate

After the upstream merge, the previously failing focused tests rebaseline cleanly on the reviewed tree:

```text
bun --cwd=packages/coding-agent test test/keybindings-selector-navigation.test.ts test/issue-851-repro.test.ts test/task/executor-subagent-reminders.test.ts
  23 pass
  0 fail
```

Keep these files in Phase 0 because they cover fragile seams touched by this plan: selector determinism, plugin source trust, and subagent session construction. Treat any future regression in these files as a package-health gate, not as feature scope to ignore.

### Architectural decisions and questions this plan answers

These are the decisions implementors should not have to rediscover:

1. **What disables automatic rule loading?**
   - `options.rules` is the only SDK option that makes automatic rule discovery/skillset-provided rules non-authoritative for a session.
   - `options.skills` is authoritative only for the prompt skill list. It should not suppress project detection, active skillset metadata, `provides.rules`, `provides.alwaysApplyRules`, `ruleDirectories`, or built-in skillset rules.
2. **How should `ttsr.enabled=false` differ from invalid TTSR metadata?**
   - `bucketRules(...)` must inspect `ttsrManager.getSettings().enabled` before calling `addRule(...)`.
   - When disabled, non-forced condition rules are suppressed and are not promoted to rulebook just because they have `description`.
   - `TtsrManager.addRule(...)` should still defensively return `false` when disabled, but `bucketRules(...)` must not rely on that `false` to distinguish disabled from invalid regex/scope metadata.
3. **What is a built-in rule?**
   - Built-in rules are native, embedded rule sources owned by OMP code, not filesystem/user/project rules.
   - Add explicit predicates/helpers such as `isBuiltinRule(rule)` and `createNativeSourceMeta(...)`; do not scatter provider string checks through SDK code.
   - `ttsr.builtinRules=false` applies to both global bundled defaults and project-gated native skillset packs, but not to user/project `ruleDirectories`.
4. **Are rule names case-sensitive?**
   - Yes. Rule names are exact, canonical ids (`rs-from-not-into`, `ts-no-any`). Disabled names, force lists, collision checks, and `rule://` lookup use exact names. Do not lowercase or fuzzy-match.
5. **What source paths are valid for native rules?**
   - `SourceMeta.path` should be clarified to allow documented virtual URIs for native bundled sources (`builtin://...`) in addition to absolute filesystem paths for user/project sources.
   - `createSourceMeta(...)` should remain the filesystem helper. Native sources need a separate helper that does not call `path.resolve(...)`.
6. **Are `skillsets.customFiles` and `skillsets.customDirectories` trusted user sources?**
   - No, keep the current conservative behavior: they are project-level for rule/skill directory path policy because those settings can originate from project config.
   - Users who need absolute trusted external rule/skill paths should use user-level `~/.omp/agent/skillsets.*` or a user-scoped plugin. Do not silently upgrade custom paths to user trust.
7. **Can weak Rust evidence activate built-in Rust TTSR?**
   - No. Weak `**/*.rs` evidence may still activate user-authored skillsets that match `facets: [rust]`, but the built-in Rust TTSR pack requires strong root-marker evidence.
8. **Where do rule merge/scanning warnings go?**
   - Missing directories, symlink escapes, duplicate names, disabled skips that deserve visibility, and invalid built-in packaging should surface through the existing skillset warning/startup warning path. Debug-only logging is insufficient for project-sourced configuration problems.

## Non-goals

- Do not redesign project detection from scratch.
- Do not introduce a parallel skillset architecture outside current `capability`, `discovery`, `extensibility`, SDK, and prompt paths.
- Do not mutate `/Users/case/projects/_external-skills/rust-skills`.
- Do not convert all 179 external Rust rules into TTSR.
- Do not load the full Rust rule corpus into the prompt.
- Do not make TTSR a replacement for rustc, Clippy, rustfmt, tests, or CI.
- Do not make built-in Rust TTSR depend on a local checkout path such as `/Users/case/projects/_external-skills`.
- Do not use broad default TTSR scopes. Built-in Rust rules must be scoped to Rust edit/write tool calls.
- Do not leave unaudited bundled `rs-*` rules globally active merely because upstream added `builtin-defaults`.

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
2. Built-in `rust` skillset activates by default only from strong root-marker evidence, not from the weak `**/*.rs` fallback alone.
3. System prompt shows a compact Active Project Skillsets entry, for example:

```text
# Active Project Skillsets
- rust: detected from Cargo.toml (root ~/repo). Rust project context is active; enabled Rust TTSR guardrails apply to generated .rs edits.
```

4. Built-in Rust TTSR rules are registered only for this session.
5. The rules trigger only on Rust tool-call content, primarily `edit` and `write` targeting `.rs` paths.
6. Full external `rust-skills` remains optional and can still be activated by user/project skillset config through `skillDirectories`.

When OMP starts outside a strong Rust project:

- built-in Rust skillset does not activate
- built-in Rust TTSR rules do not register
- editing a standalone `.rs` file in an otherwise non-Rust project does not enable the built-in Rust pack; users can opt in through explicit skillset config

### Disable semantics

Support these controls:

```text
skillsets.enabled: false                    # disables all project-aware skillsets
skillsets.mode: off                         # disables all project-aware skillsets
skillsets.mode: suggest                     # detects but does not activate
skillsets.disabled: [rust]                  # disables Rust skillset by id
skillsets.include: [node]                   # allowlist excludes Rust
disabledExtensions: [skillset:rust]
disabledExtensions: [rule:rs-lock-across-await]
ttsr.enabled: false                         # no TTSR registration or matching
ttsr.builtinRules: false                    # disables bundled default-rule providers/packs
ttsr.disabledRules: [rs-lock-across-await]  # disables a named TTSR/bundled rule by name
```

Disable semantics should be boring and cumulative:

- `disabledExtensions: ["rule:<name>"]` and `ttsr.disabledRules: ["<name>"]` both suppress the named rule before bucket assignment.
- `ttsr.builtinRules=false` suppresses embedded built-in rule sources, including the project-gated Rust built-in pack.
- `skillsets.*` controls activation; `ttsr.*` controls TTSR/bundled-rule runtime after activation.

### Rule precedence

Use conservative precedence:

1. `options.rules`, if supplied to `createAgentSession`, is authoritative; skip auto-discovered and skillset-provided rule objects.
2. Normal discovered rules from `loadCapability("rules")` win over skillset-loaded rules by name.
3. Global bundled defaults (`ts-*` and any future global defaults) sit at lowest provider priority and are shadowed by project/user rules.
4. Active skillset-provided rules append after discovered rules but before any later bucket assignment.
5. Among active skillsets, activation order wins:
   - definition priority descending
   - id lexical order, matching current sorting
6. `disabledExtensions: ["rule:<name>"]` and `ttsr.disabledRules` win over all force lists, rule directories, and built-in packs.
7. `ttsr.builtinRules=false` drops embedded built-in rules/packs before TTSR registration.
8. `provides.alwaysApplyRules` and `provides.rules` force bucket behavior for active rule names, but cannot resurrect disabled rules.

Rationale: project-local `.omp/rules` and explicit SDK options should override generic activated packs.

Force lists are name-based. If a skillset-loaded rule name collides with a normal discovered rule, the normal rule wins; `provides.rules` / `provides.alwaysApplyRules` still target the surviving rule by that name. Test and document this so force-by-name cannot accidentally resurrect a shadowed skillset rule.

## Proposed implementation phases

## Phase 0 — Rebaseline package health after upstream merge

Before touching the Rust pack, run the focused package-health files that were previously noisy and classify current failures against the post-merge tree.

Acceptance criteria:

```text
bun --cwd=packages/coding-agent test test/keybindings-selector-navigation.test.ts
bun --cwd=packages/coding-agent test test/issue-851-repro.test.ts
bun --cwd=packages/coding-agent test test/task/executor-subagent-reminders.test.ts
```

Each command should pass, or the remaining failure should be explicitly linked/classified before enabling project-gated Rust TTSR by default. Do not carry forward stale failure diagnoses if upstream already fixed or removed the relevant test.

If a fix is needed, leave a regression assertion for the intended contract:

- Selector navigation tests assert movement relative to a stable/injected list, not a catalog-specific provider id.
- MCP plugin capability tests explicitly set or deny user-source discovery and assert the intended trust boundary.
- Subagent reminder tests observe a stable session-factory seam and assert suffix thinking-level precedence plus no-suffix preservation.

## Phase 1 — Normalize built-in rule bucketing and `ttsr.enabled`

Do this before adding any new TTSR rule pack. The latest upstream merge introduced `builtin-defaults`, `ttsr.builtinRules`, `ttsr.disabledRules`, and `bucketRules(...)`; this phase turns that into the single reliable substrate instead of layering new logic beside it.

### Files likely to change

```text
packages/coding-agent/src/export/ttsr.ts
packages/coding-agent/src/capability/rule-buckets.ts
packages/coding-agent/src/discovery/builtin-defaults.ts
packages/coding-agent/src/discovery/builtin-rules/index.ts
packages/coding-agent/src/sdk.ts
packages/coding-agent/test/ttsr.test.ts
packages/coding-agent/test/capability/rule-buckets.test.ts
packages/coding-agent/test/discovery/builtin-defaults.test.ts
packages/coding-agent/test/sdk-ttsr.test.ts              # new or existing suitable SDK test file
```

### Implementation details

1. In `TtsrManager.addRule(rule)`, return `false` when `this.#settings.enabled === false`.
2. In `TtsrManager.checkDelta(...)`, return `[]` when disabled as a defensive guard and avoid appending disabled deltas to buffers.
3. Make `bucketRules(...)` the only bucket/filter function used by SDK rule registration.
4. Inside `bucketRules(...)`, read `const ttsrEnabled = ttsrManager.getSettings().enabled !== false` before registration:
   - if a rule has `condition` and is not forced, suppress it immediately when `ttsrEnabled` is false
   - if `ttsrEnabled` is true, call `addRule(...)`
   - only allow rulebook fallback for condition rules when TTSR is enabled and `addRule(...)` rejects the rule due to invalid user-authored regex/scope metadata
5. Extend `bucketRules(...)` to support:
   - `forceRulebookNames`
   - `forceAlwaysApplyNames`
   - exact-name `disabledRules` from both `ttsr.disabledRules` and `disabledExtensions: ["rule:<name>"]`
   - `builtinRules` gate backed by an explicit `isBuiltinRule(rule)` helper, not ad-hoc provider checks
   - duplicate-name defensive handling: if duplicate names reach `bucketRules(...)`, first wins and later duplicates produce warnings rather than falling through to another bucket
6. Return bucket warnings from `bucketRules(...)` so SDK can surface disabled/duplicate/native-packaging problems through the existing startup warning path.
7. In `sdk.ts`, replace the hand-rolled bucket loop with `bucketRules(...)`; do not maintain two bucket implementations.
8. Fix native source metadata before relying on `builtin-defaults`:
   - bundled defaults should use `SourceMeta.level = "native"`
   - update `SourceMeta.path` docs to allow virtual native URIs
   - do not call `createSourceMeta(...)` in a way that `path.resolve()` mangles `builtin://` or `builtin-defaults:` virtual paths
   - add `createNativeSourceMeta(...)` or an explicit native metadata constructor
9. Split embedded sources before making built-ins native:
   - global bundled defaults remain in `builtin-defaults`
   - project-gated Rust sources move behind the built-in `rust` skillset path
   - this prevents current upstream `rs-*` rules from becoming global Rust interruptions just because source metadata is corrected

Keep existing behavior for invalid condition regexes when TTSR is enabled: if `addRule()` returns false due to invalid regex and the rule has a description, user-authored rules may fall through to rulebook. That is useful for user-authored rules with bad TTSR metadata.

Exception: built-in TTSR packs must not rely on the user-authored invalid-regex fallback. Add focused validation that parses every embedded built-in rule and asserts `new TtsrManager({ enabled: true }).addRule(rule) === true`; a built-in rule with an invalid condition, unreachable scope, or duplicate name is a test failure, not a rulebook fallback.

### Tests

```text
TtsrManager({ enabled: false }).addRule(rule) returns false
TtsrManager({ enabled: false }).checkDelta(...) returns [] and does not retain disabled buffered content
bucketRules checks ttsrManager settings before addRule, so ttsr.enabled=false suppresses pure condition rules instead of promoting described TTSR rules to rulebook
bucketRules still lets forceRulebookNames/forceAlwaysApplyNames place named condition rules when ttsr.enabled=false
bucketRules applies ttsr.disabledRules and disabledExtensions-derived exact rule names before any bucket assignment
bucketRules uses isBuiltinRule(rule) for ttsr.builtinRules=false, covering native global defaults and project-gated built-in packs
bucketRules first-wins duplicate names and emits warnings for later duplicates
bucketRules returns warnings for duplicate names and native built-in metadata problems; SDK surfaces those warnings instead of dropping them
loadCapability("rules") includes native builtin-defaults without discovery.enableUserSources, but not project-gated Rust rules outside Rust activation
createAgentSession with Settings.isolated({ "ttsr.enabled": false }) and options.rules: [conditionRule] does not register or match that condition rule
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
- Missing/unreadable directories return `[]` with a warning naming the requested directory and provider; they are never silent for skillset `ruleDirectories`.
- Rule markdown does not gain `enabled: false` support in this pass unless parser support is added consistently for all rule providers.
- Ordering is part of the contract: sort loaded rules by `name` case-insensitively, then exact `name`, then absolute `path`, mirroring `compareSkillOrder` style. Do not rely on glob/filesystem order.

### Tests

```text
loads .md and .mdc from a directory
parses description / globs / alwaysApply / condition / scope / interruptMode
supports legacy ttsr_trigger / ttsrTrigger through existing parser
filename-derived names are stable
same directory scanned twice yields identical rule order and collision winner
missing/unreadable directory emits a warning
invalid regex does not fail directory scanning; TTSR add handles it later
`enabled: false` behavior is documented and tested, whether ignored or implemented
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
  providedRules: Rule[]; // new: Rule objects loaded by active skillsets/rule packs
}
```

Do not overload `ruleNames`.

Current meaning should remain:

```text
ruleNames = names forced into rulebook by provides.rules
alwaysApplyRuleNames = names forced into always-apply by provides.alwaysApplyRules
providedRules = actual Rule objects supplied by active skillsets/rule packs
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


### Force-by-name collision behavior

`provides.rules` and `provides.alwaysApplyRules` are force lists for the surviving rule with that name after merge precedence. If a project `.omp/rules` rule shadows a same-name skillset rule, the force list targets the project rule, not the shadowed skillset duplicate.

### Project path safety

Mirror current skill directory safety and make trust depend on source level, not provider label:

For sources with `_source.level === "project"`:

- `ruleDirectories` must be relative to the activation root
- absolute paths, `~`, and env-expanded absolute paths are rejected
- resolved directory realpath must stay within activation root realpath
- every loaded rule file realpath must also stay within activation root realpath, so symlinked files cannot escape after directory validation

For sources with `_source.level === "user"`:

- `~` and absolute paths are allowed
- expand via `expandTilde`

For sources with `_source.level === "native"`:

- do not use filesystem `ruleDirectories`; built-in rules come from embedded registry data

For plugin skillsets:

- inherit the plugin root scope
- user-scoped plugins follow user path policy
- project-scoped plugins follow project path policy even when `installPath` is outside the repo

For `skillsets.customFiles` / `skillsets.customDirectories`:

- keep current project-level trust semantics
- their `ruleDirectories` are project-relative and containment-checked like project configs
- if future API work needs trusted absolute custom paths, add a distinct user-trusted input rather than changing these settings in place

Rationale: project config should not be able to load arbitrary local machine rule directories or symlinked files just because a repository was opened.

Add `scanSkillsetRuleDirectories(...)` beside `scanSkillsetSkillDirectories(...)`.

The function should:

1. Resolve and validate each active `activation.effects.ruleDirectories` entry using the source-level policy above.
2. Scan with `scanRulesFromDir` using `providerId: skillset:<id>`.
3. Assign source level based on `activation.skillset._source.level`, except native built-ins which bypass filesystem scanning.
4. Reject project-sourced file symlink escapes after scanning and before accepting the rule.
5. Apply disabled rule filter.
6. Deduplicate by accepted realpath, then by rule name.
7. Emit collision warnings using the existing activation warning channel.
8. Return `providedRules: Rule[]` without mutating `activation.effects.rules`.
Do not automatically add directory-loaded rule names into `activation.effects.rules`; that would force condition rules into the rulebook and prevent TTSR registration.

### Tests

```text
active skillset ruleDirectories loads rule files into plan.providedRules
loadSkillsetDefinitions parses provides.ruleDirectories, provides.rules, and provides.alwaysApplyRules from YAML and preserves them on activated effects
suggest-mode skillset does not load ruleDirectories
manual skillset does not load ruleDirectories
non-matching skillset does not load ruleDirectories
missing rule directory emits warning
project skillset rejects absolute ruleDirectories
project skillset rejects escaping relative ruleDirectories
project skillset rejects symlinked rule files that escape the activation root
customFiles/customDirectories remain project-level and reject absolute ruleDirectories
project-scoped plugin skillset rejects absolute and escaping ruleDirectories
user-scoped plugin skillset accepts absolute/tilde ruleDirectories
user skillset accepts absolute/tilde ruleDirectories
rule:<name> disables a directory-loaded rule
skillset:<id> disables the whole activation before scanning
same rule realpath is loaded once
same rule name collides deterministically and first active source wins
condition rule from ruleDirectories is not added to ruleNames by default
provides.rules for a same-name skillset rule forces the normal discovered winner, not the shadowed skillset duplicate
```

## Phase 4 — Merge activated rules into the centralized bucket funnel

### Files likely to change

```text
packages/coding-agent/src/sdk.ts
packages/coding-agent/src/capability/rule-buckets.ts
packages/coding-agent/test/sdk-skillsets.test.ts
packages/coding-agent/test/sdk-skillsets-rules.test.ts       # new
packages/coding-agent/test/capability/rule-buckets.test.ts
```

### Implementation details

First decouple skillset activation from explicit skill overrides. `options.skills` is authoritative only for the final prompt skill list; it must not by itself disable project detection, skillset matching, `provides.rules`, `provides.alwaysApplyRules`, `ruleDirectories`, or built-in skillset rules. Only `skillsets.enabled=false`, `skillsets.mode=off`, `skillsets.disabled/include`, `disabledExtensions: ["skillset:<id>"]`, and explicit `options.rules` should suppress automatic skillset-provided rule objects.

Implementation: compute project facets and skillset definitions whenever skillsets are enabled, even when `options.skills` is supplied. When `options.skills` is supplied, use it as `baseSkills` and skip only discovered skill loading / skillDirectory expansion if the API contract requires explicit skills to remain exact; still collect activation rule effects.

Refine SDK rule flow to:

1. Preserve `options.rules` as authoritative.
2. Otherwise load normal rules with disabled extension filtering explicit.
3. Merge active skillset `providedRules` after discovered rules, skipping disabled names and name collisions.
4. Pass the merged list into `bucketRules(...)` with force-name sets and TTSR settings.

Sketch:

```ts
const disabledRuleNames = ruleNamesFromDisabledExtensions(disabledExtensionIds);
for (const name of ttsrSettings.disabledRules ?? []) disabledRuleNames.add(name);

const baseRules =
  options.rules !== undefined
    ? options.rules
    : (await loadCapability<Rule>(ruleCapability.id, {
        cwd,
        disabledExtensions: disabledExtensionIds,
      })).items;

const { rules: allRules, warnings: mergeWarnings } =
  options.rules !== undefined
    ? { rules: baseRules, warnings: [] }
    : mergeRulesFirstWins(baseRules, activationPlan.providedRules, disabledRuleNames);

const { rulebookRules, alwaysApplyRules, warnings: bucketWarnings } = bucketRules(allRules, ttsrManager, {
  builtinRules: ttsrSettings.builtinRules,
  disabledRules: [...disabledRuleNames],
  forceRulebookNames: activationPlan.ruleNames,
  forceAlwaysApplyNames: activationPlan.alwaysApplyRuleNames,
  isBuiltinRule,
});
```

`mergeRulesFirstWins` should:

- preserve base rule order
- keep first name
- append active skillset rules only when name is absent
- skip names already disabled by either disable surface
- return `{ rules, warnings }`, with warnings for skipped duplicate skillset rule names including both source paths/providers
- thread merge and bucket warnings into the existing startup/session warning surface used for skillset warnings; do not make project configuration mistakes debug-log only

### Bucket logic

Keep one force-aware precedence inside `bucketRules(...)`:

```text
disabled name / disabled builtin pack > forceAlwaysApply > forceRulebook > TTSR > alwaysApply > description/rulebook
```

Important: skillset-provided condition rules should become TTSR by default, not rulebook. They only enter rulebook when forced by `provides.rules` or when they are authored without `condition` and have `description`. When `ttsr.enabled=false`, pure condition rules are suppressed unless forced.

### Tests

```text
skillset-loaded described non-condition rule appears in system prompt rulebook and rule://
skillset-loaded alwaysApply rule injects into generic/always-apply rules
skillset-loaded condition rule registers as TTSR and is not active via rule://
provides.rules forces a named condition rule into rulebook instead of TTSR
provides.alwaysApplyRules forces a named condition rule into always-apply instead of TTSR
normal .omp/rules rule shadows same-name skillset rule
options.rules skips automatic skillset-provided rule merging
disabledExtensions rule:<name> suppresses rule in all buckets
ttsr.disabledRules suppresses discovered, skillset-provided, and built-in rules by name
ttsr.builtinRules=false suppresses global bundled defaults and the project-gated Rust built-in pack
SDK with `skills: []` in a Rust project still registers built-in Rust TTSR rules unless `options.rules` is supplied or skillsets/TTSR are disabled
SDK with `skills: []` keeps `session.skills` empty while still recording `session.skillsetActivations` and registering project-gated Rust TTSR rules
createAgentSession in a temp Cargo project with a skillset `ruleDirectories` condition rule wires that rule into `session.ttsrManager`
that wired rule matches `checkDelta(..., { source: "tool", toolName: "edit", filePaths: ["src/lib.rs"] })`
the same rule does not match assistant text, thinking text, `write`/`edit` on non-`.rs` paths, or unrelated tool names
TTSR-only skillset rule is not returned by `rule://<name>` / active rulebook unless forced by `provides.rules`
non-Rust project with the same configured rule directory does not register the Rust TTSR rule
```

## Phase 5 — Add built-in Rust skillset and project-gated embedded Rust rule pack

### Files likely to add/change

Reuse the upstream built-in rule substrate; do not create a parallel `src/skillsets/builtin` or `extensibility/rust/rules` tree.

```text
packages/coding-agent/src/discovery/builtin-skillsets.ts          # new built-in SkillsetDefinition provider/registry
packages/coding-agent/src/discovery/builtin-defaults.ts           # keep global defaults only
packages/coding-agent/src/discovery/builtin-rules/index.ts        # split global vs rust skillset sources
packages/coding-agent/src/discovery/builtin-rules/
  rs-box-leak.md                       # existing; candidate first-wave
  rs-lock-across-await.md              # new
  rs-unbounded-channel.md              # new
  rs-async-std-mpsc.md                 # new
  rs-error-source-chain.md             # new
  rs-from-not-into.md                  # new
  rs-tokio-async-test.md               # new
packages/coding-agent/src/extensibility/skillsets.ts
packages/coding-agent/src/discovery/index.ts                      # import builtin-skillsets if implemented as provider registration
packages/coding-agent/test/discovery/builtin-defaults.test.ts
packages/coding-agent/test/rust-skillset-ttsr.test.ts             # new
```

### Built-in definition loading

Add built-in skillset definitions after custom/native definitions so user/project/custom definitions can shadow them by id.

Recommended behavior:

```text
customFiles/customDirectories > project/user/plugin definitions > built-in definitions
```

Implementation detail: append built-ins to the definition list **before** deduplication and after custom/project/user/plugin definitions. The current loader's first-seen id wins before final sorting; preserve that property so a user/project `rust` skillset completely replaces the built-in one instead of merging with it.

For a built-in `rust` definition:

```ts
{
  id: "rust",
  description: "Rust edit guardrails for async, error handling, APIs, and tests.",
  mode: "auto",
  priority: -100,
  // Built-in default TTSR requires strong Rust project evidence.
  // Do not match the weak `**/*.rs` fallback unless a future matcher can require confidence/evidence kind explicitly.
  match: {
    rootMarkers: ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "rustfmt.toml", "clippy.toml"],
  },
  provides: {
    promptSummary:
      "Rust project detected. Enabled Rust TTSR guardrails apply to generated .rs edits. Use configured Rust skills for deeper workflow guidance.",
  },
  _source: {
    provider: "builtin-skillsets",
    providerName: "Built-in Skillsets",
    path: "builtin://skillsets/rust",
    level: "native",
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

### Built-in rule packaging and split

Upstream already embeds Markdown rule files with `with { type: "text" }`. Keep that pattern and add pack metadata instead of inventing a new loader.

Recommended registry shape:

```ts
export interface BuiltinRuleSource {
  name: string;
  content: string;
  pack: "global" | "skillset:rust";
}

export const BUILTIN_RULE_SOURCES: readonly BuiltinRuleSource[] = [
  { name: "ts-no-any", content: tsNoAny, pack: "global" },
  { name: "rs-box-leak", content: rsBoxLeak, pack: "skillset:rust" },
];
```

Then:

- `builtin-defaults` provider loads only `pack: "global"`.
- `getBuiltinSkillsetRules("rust")` builds only `pack: "skillset:rust"`.
- all built-in rules use native source metadata and virtual paths such as `builtin://rules/rs-box-leak.md`.
- project/user rules of the same name still shadow built-ins through first-wins merge.

The activation compiler should include these embedded Rule objects when the built-in `rust` skillset activates.

Implementation options, in order of preference:

1. Add an internal built-in skillset/rule registry:
   - `getBuiltinSkillsetDefinitions()`
   - `getBuiltinSkillsetRules(skillsetId)`
2. Append built-in definitions in `loadSkillsetDefinitions(...)` after discovered definitions.
3. During `compileSkillsetActivationPlan(...)`, when an activated definition source is `builtin-skillsets`, append `getBuiltinSkillsetRules(definition.id)` to `result.providedRules`.

Embedded built-in rules must enter the same acceptance pipeline as directory-loaded rules after construction: apply `rule:<name>` / `ttsr.disabledRules` filtering, honor `ttsr.builtinRules`, merge with first-wins precedence, and emit deterministic warnings for skipped duplicate built-in names. Tests must cover `rule:rs-from-not-into` and `ttsr.disabledRules: [rs-from-not-into]` disabling a built-in rule before TTSR registration, plus a project `.omp/rules` rule shadowing the same built-in name.

This avoids exposing arbitrary inline `Rule` objects in user-authored skillset JSON/YAML while still supporting filesystem `ruleDirectories` for user/project/extension packs.

### Required before built-in Rust rules: edit path extraction

`tool:edit(*.rs)` must be proven against the default hashline edit payload. Current TTSR path extraction only inspects structured `path` / `paths` arguments, while hashline edit uses an `input` string containing `¶path#tag` section headers.

Before enabling Rust rules, extend TTSR tool path extraction to recover paths from supported edit payloads:

- hashline: every `¶<path>#<tag>` section header in `input`
- apply-patch/hashline variants: paths from their structured entries when present
- existing generic `path` / `paths` extraction for `write` and other tools remains

Design requirements:

- Extract path parsing into a small shared helper used by live `AgentSession` TTSR and rule-history validation (`omfg-rule`) so manual validation and runtime matching do not diverge.
- Scoped rules must not match as unscoped just because no path is known yet. If a path appears later in the same tool-call argument stream, the already-buffered content may match at that point.
- Normalize candidates the same way existing path arguments are normalized: raw, de-`./`-prefixed, absolute, and cwd-relative forms.

Tests must prove a scoped rule `tool:edit(*.rs)` matches hashline edits to `src/lib.rs`, does not match `src/lib.ts`, and still matches `write` with `path: "src/lib.rs"`.

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
You are about to write Rust code that may violate <specific rule>.
Before retrying the tool call, either change the code so the pattern no longer applies, or, only for a deliberate exception, include a short code comment or adjacent rationale explaining why this case is safe. Do not repeat the same edit unchanged.
```

Do not use default scope. Default scope allows assistant text and any tool; built-in Rust rules must explicitly scope to Rust edit/write tools.

Regex constraints for built-in rules:

- Conditions are JavaScript `RegExp` pattern strings compiled with `new RegExp(pattern)` and no flags.
- Do not use inline flag syntax such as `(?s)`; use `[\\s\\S]` for bounded multiline matching.
- Avoid unbounded `.*` / `[\\s\\S]*` across tool buffers; use small explicit bounds such as `{0,800}`.
- Conditions are ORed, not ANDed. If a rule needs both context and a code smell, encode both in the same pattern or add a more precise scope/extraction primitive first.
- Every built-in condition must compile and register in tests; invalid built-in regexes are release blockers, not warnings.

### First-wave Rust TTSR rules

Default TTSR should stay small and interruption-worthy. Ship only rules that are high-signal under regex-only matching and current tool/path scope semantics.

Audit upstream's current `rs-*` defaults before inclusion:

- Keep as first-wave if negatives pass: `rs-box-leak`.
- Do not automatically keep as interrupting defaults: `rs-future-prelude`, `rs-lazylock`, `rs-match-ergonomics`, `rs-parking-lot`, `rs-result-type`.
- If those deferred rules remain valuable, move them to Rust skill/reference guidance or later opt-in rules. They are style/version/dependency/project-policy rules, not universal stream-time guardrails.

| File | Purpose | Initial condition strategy | Notes |
| --- | --- | --- | --- |
| `rs-box-leak.md` | Avoid accidental process-lifetime memory leaks | `\\bBox::leak\\b` | existing upstream rule; include only with negatives for intentional one-time leaks with explicit rationale |
| `rs-lock-across-await.md` | Avoid holding `Mutex`/`RwLock` guards across `.await` | bounded multiline regex for guard acquisition followed by `.await`, e.g. `(?:(?:\\.lock\\(\\)|\\.read\\(\\)|\\.write\\(\\))(?:[\\s\\S]{0,800})\\.await)` | include only with negatives for `drop(guard)` before await and block-scoped guards; wording must say “if the guard can live across await” |
| `rs-unbounded-channel.md` | Avoid unbounded Tokio channels without justification | `\\bmpsc::unbounded_channel\\b|\\bUnbounded(?:Sender|Receiver)\\b` | high-signal default rule; allow explicit rationale for fanout/shutdown paths |
| `rs-async-std-mpsc.md` | Avoid `std::sync::mpsc` in async/Tokio code | bounded multiline regex requiring async/Tokio context and `std::sync::mpsc` | include only if positive and negative async-context samples pass |
| `rs-error-source-chain.md` | Preserve source error chains | `\\.map_err\\s*\\(\\s*\\|\\s*\\w+\\s*\\|\\s*\\w+\\.to_string\\s*\\(\\s*\\)\\s*\\)|Err\\s*\\(\\s*\\w+\\.to_string\\s*\\(\\s*\\)\\s*\\)` | allow UI/API boundary stringification with explicit rationale |
| `rs-from-not-into.md` | Prefer `From` over direct `Into` impls when coherence permits | `\\bimpl(?:\\s*<[^>]*>)?\\s+Into\\s*<` | if `From` is blocked by coherence/orphan rules, require short justification and keep direct `Into` |
| `rs-tokio-async-test.md` | Avoid non-Tokio async test scaffolding in Tokio tests | `#\\s*\\[\\s*test\\s*\\]\\s*(?:\\n|.){0,160}\\basync\\s+fn\\b|Runtime::new\\s*\\(\\s*\\)(?:[\\s\\S]{0,160})\\.block_on\\s*\\(` | allow deliberate runtime-configuration tests |

Second-wave candidates should remain out of the first implementation:

```text
rs-future-prelude.md
rs-lazylock.md
rs-match-ergonomics.md
rs-parking-lot.md
rs-result-type.md
rs-async-std-fs.md
rs-unwrap-prod.md
rs-silent-error-discard.md
rs-borrowed-api-params.md
entry API
push_str(&format!(...))
simple 0..len indexing loops
unsafe safety docs reminders
collect-then-immediate-use
benchmark black_box rules
```

Move deferred rules into default TTSR only after false-positive behavior is measured and rule-specific negatives are reliable. Broad API/style/version/dependency lints usually belong in Rust skills or Clippy guidance, not interrupting default TTSR.

For every first-wave Rust rule, add table-driven tests with:

- rule markdown parses
- every condition compiles
- `TtsrManager.addRule` returns true
- positive `write` context with `path: *.rs` matches
- positive default hashline `edit` input for `*.rs` matches
- same payload under a non-Rust path does not match
- `toolName: bash/read` does not match
- at least two rule-specific negative Rust snippets do not match

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
  - source-level path policy: project/project-scoped plugin/custom sources are project-contained; user sources may use absolute/tilde paths; native built-ins use embedded rules
  - disable semantics for `disabledExtensions`, `ttsr.disabledRules`, and `ttsr.builtinRules`
- Document built-in Rust skillset:
  - activates from strong Rust root-marker evidence, not weak `**/*.rs` fallback alone
  - supplies enabled, project-gated TTSR guardrails
  - uses bundled `rs-*` rule names
  - does not depend on external `rust-skills`
- Document external Rust skills remain optional.

In `docs/rulebook-matching-pipeline.md`:

- Update the current `bucketRules(...)` section to match implementation, not the stale hand-rolled SDK loop.
- Add skillset-provided rules as an additional source after normal discovery.
- Explain global `builtin-defaults` versus project-gated built-in skillset rule packs.
- Explain merge precedence and first-wins shadowing.
- Explain forced bucket names from `provides.rules` and `provides.alwaysApplyRules`.
- Explain `ttsr.disabledRules`, `disabledExtensions: ["rule:<name>"]`, and `ttsr.builtinRules`.
- Explicitly state that TTSR-only rules are not `rule://` entries unless forced or companion rulebook rules exist.

In `docs/ttsr-injection-lifecycle.md`:

- Remove/update the caveat that `ttsr.enabled` is not enforced after Phase 1.
- Add skillset-loaded TTSR rules to registration source description.
- Explain `bucketRules(...)` as the single rule funnel.
- Mention project-gated built-in Rust guardrails if shipped.

In `docs/skills.md`:

- Keep clear distinction:
  - skills are passive `skill://` capability packs
  - rules are active/rulebook constraints
  - skillsets activate both based on detected project context
- Clarify external `rust-skills` rules under `skill://rust-skills/rules/...` are not automatically OMP rules unless a skillset explicitly loads a rule directory or a built-in pack provides rules.

In changelog:

```text
Added: skillset ruleDirectories can load active rule/TTSR rule packs for matched projects.
Added: built-in Rust skillset with a small project-gated `rs-*` TTSR guardrail pack for generated Rust edits.
Fixed: ttsr.enabled now actually disables TTSR registration/matching.
Changed: bundled default rules now use native source metadata and centralized bucketRules filtering.
Changed: existing bundled Rust defaults are audited/gated instead of globally interrupting standalone .rs edits.
```

## Phase 7 — Validation plan

### Focused tests

Run from:

```text
/Users/case/projects/external/oh-my-pi/packages/coding-agent
```

Suggested commands:

```bash
bun test test/ttsr.test.ts test/capability/rule-buckets.test.ts test/discovery/builtin-defaults.test.ts test/sdk-session-isolation.test.ts
bun test test/discovery/rule-directory.test.ts
bun test test/project-detection.test.ts test/skillsets-activation.test.ts test/skillsets-config.test.ts test/system-prompt-skillsets.test.ts test/sdk-skillsets.test.ts
bun test test/sdk-skillsets-rules.test.ts test/rust-skillset-ttsr.test.ts
```

### Broader package checks

```bash
# focused type gate for this package
bun run check:types

# final package gates after known baseline failures are fixed/classified
bun test
bun run check
```

If the full `bun test` suite fails, classify each failure before proceeding:

- directly caused by this work: fix in the same stack before enabling Rust TTSR by default
- existing package-health blocker: add or reference a focused fix task, then keep the failure visible in this plan
- flaky/environmental: prove by rerun or isolation before marking it as such

Do not declare final validation complete while any rebaselined package-health failure remains unclassified.

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

Start a session with skillsets and TTSR enabled, then attempt both a `write` and a default hashline `edit` containing one known pattern such as `impl Into<...> for ...`.

Expected:

1. Active Project Skillsets includes `rust`.
2. A built-in Rust TTSR rule registers.
3. A `write` tool call targeting `src/lib.rs` containing `impl Into<...> for ...` triggers `rs-from-not-into`.
4. A default hashline `edit` tool call targeting `src/lib.rs` with the same pattern also triggers `rs-from-not-into`.
5. The same content targeting a non-`.rs` path does not trigger.
6. `disabledExtensions: ["rule:rs-from-not-into"]` suppresses just that rule.
7. `ttsr.disabledRules: ["rs-from-not-into"]` suppresses the same rule through the TTSR setting.
8. `ttsr.builtinRules: false` suppresses the project-gated Rust built-in pack.
9. `skillsets.disabled: [rust]` suppresses the Rust pack.
10. `ttsr.enabled: false` suppresses TTSR behavior.

## Recommended task breakdown for implementation

### Task 0 — Package-health rebaseline

- Run the three focused package-health files.
- Fix only current failures, not stale diagnoses from before the upstream merge.
- Preserve/verify the intended contracts if a fix is needed.
- Run the focused package-health tests before continuing to Rust TTSR work.

### Task 1 — Built-in rule substrate and TTSR gate

- Enforce `ttsr.enabled` in `TtsrManager` and centralized bucket logic.
- Make `bucketRules(...)` the SDK's only rule bucket funnel.
- Normalize bundled default rules to native source metadata without turning Rust defaults global.
- Add rule-bucket, built-in-default, SDK, and TTSR manager tests.
- Update `docs/ttsr-injection-lifecycle.md` caveat.

### Task 2 — Rule directory scanner

- Add `scanRulesFromDir` helper.
- Add tests for parser parity and deterministic naming.

### Task 3 — Skillset ruleDirectories ingestion

- Extend `CompileSkillsetActivationResult` with `providedRules: Rule[]`.
- Add `scanSkillsetRuleDirectories`.
- Enforce project-relative safety.
- Apply `rule:<name>` filter.
- Add activation-level tests.

### Task 4 — SDK rule merge and bucket integration

- Merge activated `providedRules` into the centralized `bucketRules(...)` path.
- Preserve first-wins precedence and emit useful duplicate diagnostics.
- Add SDK/system-prompt tests for rulebook, always-apply, TTSR, force-by-name, disabled-by-name, `ttsr.disabledRules`, `ttsr.builtinRules`, and explicit `options.rules`.

### Task 5 — Built-in Rust skillset and embedded rule pack

- Add built-in skillset definition with low precedence and strong-marker Rust activation.
- Split existing bundled `rs-*` sources so global defaults and project-gated Rust rules are distinct.
- Audit existing upstream Rust defaults; keep only high-signal rules in first wave.
- Add embedded Markdown-backed Rust TTSR rules using existing `discovery/builtin-rules` packaging.
- Ensure built-in Rust rules are included only when the `rust` skillset activates and `ttsr.builtinRules` remains enabled.
- Add positive/negative samples for each first-wave rule.

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

- Start with a small default set of high-signal rules.
- Use `tool:edit(*.rs)` / `tool:write(*.rs)` scopes only after edit path extraction is verified.
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

### Risk: correcting built-in source metadata activates noisy defaults globally

Mitigation:

- Split `BUILTIN_RULE_SOURCES` into global and project-gated packs before changing bundled source level to `native`.
- Keep global defaults language-agnostic or clearly global.
- Gate Rust rules behind strong Rust project activation.
- Audit existing upstream `rs-*` rules before inclusion; defer style/version/dependency rules.

### Risk: project config loads arbitrary local files

Mitigation:

- Project-level `ruleDirectories` must be relative to activation root.
- Reject `~` and absolute paths for project-level skillsets.
- Validate both directory and loaded file realpath containment.

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

Recommended answer: yes for strong Rust-marker projects, but only after `ttsr.enabled` is fixed, edit path extraction is verified, rules are scoped to edit/write `.rs` tool calls, and current upstream `rs-*` defaults are audited. Weak `**/*.rs` fallback evidence should not enable the built-in pack by default in this pass. Users can disable via `skillsets.disabled`, `disabledExtensions`, `ttsr.disabledRules`, `ttsr.builtinRules`, or `ttsr.enabled`.

2. Should built-in Rust TTSR rules be visible through `rule://`?

Recommended answer: not by default. They are runtime guardrails. If rulebook visibility is desired later, add companion non-TTSR rulebook summaries or force specific names via `provides.rules`.

3. Should the public schema add `rulePacks`?

Recommended answer: not in the first pass. Keep user schema to `ruleDirectories`, `rules`, and `alwaysApplyRules`. Use an internal built-in registry for embedded Rust rules to avoid packaging risks.

4. Should project skillsets be allowed to reference absolute `ruleDirectories`?

Recommended answer: no. Match existing `skillDirectories` hardening: project skillsets must stay project-relative; user-level configs can use absolute paths.

5. Should condition rules with descriptions become rulebook rules when `ttsr.enabled=false`?

Recommended answer: not automatically for pure TTSR rules. Explicit forcing via `provides.rules` should still work.

6. Should existing upstream `rs-*` built-in defaults remain globally active?

Recommended answer: no. Split them before native source metadata makes bundled defaults truly active. Keep only audited high-signal Rust rules in the project-gated Rust pack; move broad style/version/dependency guidance to Rust skills or later opt-in rules.

## Definition of done

- `ttsr.enabled=false` actually prevents TTSR registration and matching.
- SDK uses centralized `bucketRules(...)`; no second hand-rolled bucket loop remains.
- Built-in defaults use native source metadata without making unaudited Rust rules global.
- `ttsr.builtinRules=false` and `ttsr.disabledRules` work for global bundled defaults and project-gated built-in packs.
- Active skillsets can load rule directories into `providedRules: Rule[]` objects.
- Skillset-loaded rules flow through centralized `bucketRules(...)` bucketing.
- Normal rules shadow skillset-provided rules by name.
- `rule:<name>` and `ttsr.disabledRules` disable directory-loaded and built-in rules.
- Built-in Rust skillset activates only for strong Rust-marker projects, not weak `**/*.rs` fallback evidence.
- First-wave `rs-*` Rust TTSR pack is embedded, scoped, audited against existing upstream `rs-*` defaults, tested with positive/negative samples, and documented.
- `tool:edit(*.rs)` matching works for default hashline edit payloads.
- External `rust-skills` remains optional and separate.
- Focused tests and `bun run check:types` pass; final `bun test` and `bun run check` pass, or every pre-existing package-health failure is linked and not hidden by narrowed validation.
- Docs/changelog reflect current behavior and exact setting names.
