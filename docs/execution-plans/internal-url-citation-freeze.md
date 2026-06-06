# Internal URL Citation Freeze Execution Plan

## Objective

Build a session-aware citation workflow that lets agents author naturally with live OMP refs, then mechanically freezes those refs into durable, recoverable evidence citations before documents become release records, design records, or long-lived handoff artifacts.

Authoring should stay simple:

```yaml
basis:
  - artifact://83
  - agent://LifecycleEvidenceFinal
```

Publication should be durable:

```yaml
# OMP-REF-LEGEND-BEGIN v1
# artifact://83 => omp-ref://v1/session/<artifact-session-id>/artifact/83?sha256=<sha83> (occurrences: 3)
# agent://LifecycleEvidenceFinal => omp-ref://v1/session/<artifact-session-id>/agent/LifecycleEvidenceFinal?sha256=<sha-agent> (occurrences: 1)
# OMP-REF-LEGEND-END
```

The citation freeze workflow is the companion to `docs/execution-plans/internal-url-resource-router.md`:

- the router plan owns resource semantics, descriptors, caller context, canonical metadata, manifests, indexes, selectors, materialization, and durable `omp-ref://` resolution;
- this plan owns document scanning, ref checking, freeze commands, legends, optional inline replacement, schema profiles, and publication-time guardrails.

## Problem Statement

Live refs are exactly what agents should use while working:

```text
artifact://83
artifact://85
agent://LifecycleBoundaryFinal
agent://LifecycleEvidenceFinal
```

They are short, copyable, and readable in the active OMP session. They are also not durable enough for release records and documentation. A future reader cannot infer from `artifact://83` alone:

- which OMP session produced it;
- which artifact directory contained it;
- which tool or agent created it;
- what exact bytes were cited;
- whether `artifact://83` from another active session is a collision;
- whether the ref was current, stale, superseded, private, or exportable;
- whether the backing file was pruned or moved.

The current failure mode is visible in real release YAML such as:

```yaml
basis:
  - artifact://83
invalidated:
  - ref: artifact://49
    reason: superseded by review-fixed lifecycle test artifact://66 and then real-proof artifacts artifact://83/artifact://85
successor_state_reliance_set:
  - artifact://83
  - artifact://85
  - agent://LifecycleBoundaryFinal
  - agent://LifecycleEvidenceFinal
rejected_or_stale_paths:
  - artifact://49
  - artifact://66
```

Those refs are meaningful in the session that produced the file. They rot as citations unless they are frozen with explicit session identity, content identity, selector identity, provenance, and export policy.

## Design Principle

Separate authoring handles from evidence citations.

```text
Live refs are working handles.
Freeze turns working handles into evidence citations.
Canonical refs identify pinned bytes plus provenance.
Legends preserve readability.
Inline replacement is opt-in publication formatting.
Authority and exportability are explicit.
```

Agents should not be forced to manually write long `omp-ref://...sha256=...` refs during reasoning. They should write live refs naturally, then run a deterministic tool that freezes the document.

## Relationship To Router Plan

### Router plan owns

- scheme descriptors;
- resource context and caller-scoped resolution;
- router-owned parsing and selector policy;
- effective target capabilities;
- citation/exportability policy;
- canonical metadata;
- durable `omp-ref://` scheme;
- per-session manifests and global index;
- content hash verification;
- content-addressed materialization;
- agent self-citation metadata.

### Citation freeze plan owns

- CLI command surface for `omp refs ...`;
- document scanning for live refs and hashline/source refs;
- explicit session/deeplink context input;
- conversion checks from live aliases to canonical refs;
- managed legends and sidecar citation manifests;
- optional inline replacement;
- YAML/Markdown/plaintext-safe transforms;
- idempotence and dry-run diffs;
- publication-time refusal rules.

### Boundary

The freeze workflow must not reimplement resource authority or canonicalization. It asks the router:

```ts
router.parseTarget(input, context)
router.describeTarget(input, context)
router.canonicalize(input, context)
```

The router must not parse or rewrite arbitrary YAML/Markdown documents. It returns resource facts; the freeze workflow edits documents.

## Definitions

### Live Ref

A short ref that resolves only under an active caller/session context.

Examples:

```text
artifact://83
agent://LifecycleEvidenceFinal
pr://123
issue://123
vault://_/Daily.md
```

### Frozen Citation

A document occurrence whose live ref has a durable mapping to a canonical ref, content hash, provenance record, and selector metadata.

### Canonical Ref

An explicit durable ref such as:

```text
omp-ref://v1/session/<artifact-session-id>/artifact/83?sha256=<sha83>#L10-L40
```

or an external canonical alias such as:

```text
pr://owner/repo/123
```

### Citation Legend

A managed block appended to or updated inside a document that maps live refs to canonical refs.

### Citation Sidecar

A machine-readable file emitted next to or near a document containing the same mapping and richer metadata. Sidecars are optional but recommended for automation.

### Freeze Context

Explicit information proving which session/tree/export live aliases should resolve against.

Accepted context forms:

```text
--artifact-session <artifact-root-session-id>
--session-file <path-to-session-jsonl>
--artifacts-dir <path>
--manifest <path-to-refs.jsonl>
--deeplink <omp-ref://... | agent://... session deeplink>
--ref-context <path-to-export-context.json>
--current
```

`--artifact-session` names the artifact-root session id used by durable `omp-ref://v1/session/...` refs. `--deeplink` and `--ref-context` are portable context inputs produced by OMP/session exports. `--current` is allowed only inside an active OMP session where the caller context is unambiguous.

### Managed Zone

A sentinel-bounded block the tool owns and may replace idempotently.

Examples:

```yaml
# OMP-REF-LEGEND-BEGIN v1
# ...
# OMP-REF-LEGEND-END
```

```md
<!-- OMP-REF-LEGEND-BEGIN v1 -->
...
<!-- OMP-REF-LEGEND-END -->
```

## Required Invariants

1. **Live alias conversion requires explicit context**
   - The tool never resolves `artifact://83` by searching a global index without a session/export context.
   - Global indexes resolve already-canonical refs; they do not guess live aliases.

2. **No provenance fabrication**
   - The tool does not create authoritative provenance by hashing a file later.
   - It uses creation-time manifest records written by artifact/agent output creation.
   - If provenance is missing, freeze refuses or marks the citation as provenance-incomplete under an explicit flag.

3. **Pinned bytes before published canonical refs**
   - A canonical `omp-ref://...sha256=...` is emitted only after the cited bytes are retained in a manifest-backed location or copied to the content-addressed store.

4. **Authority before resolution**
   - Possessing a live ref or canonical ref does not grant read access.
   - The freeze context must authorize reading and exporting the resource.

5. **Export policy is default-deny**
   - Private, mutable, memory, local, vault, and host-owned resources are non-exportable unless the effective resource capability explicitly allows citation.

6. **No private path leakage**
   - Public legends and canonical refs do not include absolute paths, usernames, `~/.omp` session paths, cwd, vault roots, or `sourcePath`/`originPath` values.

7. **Syntax-aware transforms only**
   - The tool never rewrites files with blind string replacement in write mode.
   - It uses safe spans and refuses overlapping, ambiguous, or invalid edits.

8. **Idempotent writes**
   - Running freeze twice after a successful write produces no diff.

9. **No partial writes on failure**
   - If any candidate is unresolved, ambiguous, private, overlapping, or unsafe, write mode applies no changes unless the user explicitly selects a partial mode.

10. **Superseded refs still resolve exact old bytes**
    - A superseded artifact is not replaced with its successor by default.
    - Supersession metadata is recorded separately.

11. **Inline replacement is opt-in**
    - Default mode appends/updates a legend and preserves body text.
    - Inline canonicalization is used only when safe and requested.

## User-Facing CLI

Top-level command group:

```text
omp refs <subcommand>
```

Subcommands:

```text
omp refs scan <files...>
omp refs check <files...> --artifact-session <...>
omp refs freeze <files...> --artifact-session <...> --mode legend --write
omp refs freeze <files...> --artifact-session <...> --mode inline --write
omp refs freeze <files...> --artifact-session <...> --mode both --write
omp refs explain <ref> --artifact-session <...>
```

### `scan`

No resource resolution. Finds candidate refs and reports zones.

Detects:

- internal URL live refs: `artifact://`, `agent://`, `local://`, `memory://`, `skill://`, `rule://`, `mcp://`, `vault://`, `issue://`, `pr://`, dynamic schemes where known;
- existing canonical `omp-ref://` refs;
- hashline source spans such as `path#0BD8:266-402`;
- repeated refs and refs inside prose.

Example output:

```text
file: docs/releases/x.yaml
  artifact://83                       3 occurrences
  artifact://85                       2 occurrences
  agent://LifecycleEvidenceFinal      1 occurrence
  crates/foo.rs#0BD8:10-40            1 source-span candidate
```

### `check`

Resolves candidates under explicit context, but does not edit files.

Reports:

- status: resolvable, ambiguous, missing, private, unsupported, already canonical;
- canonical ref if available;
- content hash;
- export policy;
- provenance status;
- occurrence count;
- line/column examples;
- YAML path / Markdown zone when available.

### `freeze`

Resolves, pins, and writes citation mappings.

Flags:

```text
--mode legend|inline|both       default: legend
--dry-run                       default unless --write is supplied
--write
--artifact-session <id>
--session-file <path>
--artifacts-dir <path>
--manifest <path>
--deeplink <ref-or-url>
--ref-context <path>
--current
--sidecar <path|auto|none>      default: auto for write mode
--profile <generic|release-yaml|markdown|plaintext>
--allow-unresolved              check/dry-run diagnostics only; never writes unresolved mappings
--allow-provenance-incomplete   check/dry-run diagnostics only; never emits authoritative refs
--private-diagnostic            no-write diagnostic output for private/non-exportable refs
--partial                       allow safe candidates to write while reporting failures
```

### `explain`

Shows how one ref resolves under context and why it can or cannot be frozen.

```text
omp refs explain artifact://83 --artifact-session <artifact-root-session-id>
```

## Default Transform Strategy

Default write mode is `legend`.

This preserves the author's live refs and appends or updates a managed block.

### YAML default legend

Generic YAML should use comments by default because adding keys can break schema consumers.

```yaml
# OMP-REF-LEGEND-BEGIN v1
# artifact://83 => omp-ref://v1/session/<sid>/artifact/83?sha256=<sha83> (kind: artifact, occurrences: 3)
# artifact://85 => omp-ref://v1/session/<sid>/artifact/85?sha256=<sha85> (kind: artifact, occurrences: 2)
# agent://LifecycleEvidenceFinal => omp-ref://v1/session/<sid>/agent/LifecycleEvidenceFinal?sha256=<sha-agent> (kind: agent_output, occurrences: 1)
# OMP-REF-LEGEND-END
```

### YAML profile legend

Schema-aware profiles may add structured data when allowed.

For release YAML:

```yaml
omp_citations:
  version: 1
  context:
    artifact_session: <sid>
  refs:
    artifact://83:
      canonical: omp-ref://v1/session/<sid>/artifact/83?sha256=<sha83>
      kind: artifact
      status: current
      occurrences:
        - line: 23
        - line: 75
        - line: 104
    agent://LifecycleEvidenceFinal:
      canonical: omp-ref://v1/session/<sid>/agent/LifecycleEvidenceFinal?sha256=<sha-agent>
      kind: agent_output
      status: current
      occurrences:
        - line: 107
```

The generic tool must not invent this block unless `--profile release-yaml` or equivalent schema policy allows it.

### Markdown legend

```md
<!-- OMP-REF-LEGEND-BEGIN v1 -->
| Live ref | Canonical ref | Kind | Occurrences |
|---|---|---|---:|
| `artifact://83` | `omp-ref://v1/session/<sid>/artifact/83?sha256=<sha83>` | artifact | 3 |
| `agent://LifecycleEvidenceFinal` | `omp-ref://v1/session/<sid>/agent/LifecycleEvidenceFinal?sha256=<sha-agent>` | agent_output | 1 |
<!-- OMP-REF-LEGEND-END -->
```

### Plaintext legend

```text
OMP-REF-LEGEND-BEGIN v1
artifact://83 => omp-ref://v1/session/<sid>/artifact/83?sha256=<sha83> [artifact, occurrences=3]
OMP-REF-LEGEND-END
```

## Inline Replacement Rules

Inline mode is opt-in.

Safe scalar replacement:

```yaml
- artifact://83
```

becomes:

```yaml
- omp-ref://v1/session/<sid>/artifact/83?sha256=<sha83>
```

Embedded prose requires delimiter-aware tokenization.

Input:

```yaml
reason: superseded by artifact://83/artifact://85
```

The scanner must recognize two refs, not one URL. If replacement would become ambiguous because neighboring characters are URI-valid, the tool must either:

- leave body text unchanged and rely on legend mode;
- use an explicitly configured prose normalization such as `<omp-ref://...83> / <omp-ref://...85>`;
- or fail with a dry-run warning.

Never rewrite:

- YAML keys unless profile explicitly allows it;
- Markdown fenced code by default;
- inline code by default;
- HTML comments except managed zones;
- already canonical `omp-ref://` refs except to verify them;
- refs inside generated legends except by replacing the entire managed block.

## Citation Record Data Model

The freeze workflow consumes records produced by the router/runtime and emits document-level records.

### Session record

```ts
interface CitationSessionRecord {
  sessionId: string;
  artifactSessionId: string;
  agentTreeId?: string;
  sessionFile?: string;       // private/local index only
  artifactsDir?: string;      // private/local index only
  cwdHash?: string;
  repoIdentity?: string;
  createdAt: string;
  closedAt?: string;
}
```

### Resource record

Written when artifacts/agent outputs are created.

```ts
interface CitationResourceRecord {
  recordId: string;
  kind: "artifact" | "agent" | "agent-log" | "source-snapshot" | "external" | "content";
  liveUrl: string;
  canonicalRef: string;
  artifactSessionId: string;
  resourceId: string;
  contentType: "text/plain" | "text/markdown" | "application/json";
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  producer?: {
    tool?: string;
    agentId?: string;
    parentAgentId?: string;
  };
  status: "current" | "superseded" | "stale" | "missing";
  supersedes?: string[];
  supersededBy?: string[];
  exportable: boolean;
  metadataVisibility: "canonical-only" | "redacted" | "private-diagnostic";
}
```

### Content index record

```ts
interface CitationContentRecord {
  sha256: string;
  contentType: string;
  sizeBytes: number;
  storage: "cas" | "session-artifact";
  firstSeenSessionId: string;
  retained: boolean;
}
```

### Document citation occurrence

```ts
interface CitationOccurrence {
  file: string;
  line: number;
  column: number;
  byteStart: number;
  byteEnd: number;
  zone: "yaml-scalar" | "yaml-comment" | "markdown-text" | "markdown-link" | "plaintext";
  yamlPath?: string;
  originalText: string;
  selector?: string;
}
```

### Document citation mapping

```ts
interface DocumentCitationMapping {
  liveRef: string;
  canonicalRef: string;
  kind: CitationResourceRecord["kind"];
  sha256: string;
  status: CitationResourceRecord["status"];
  occurrences: CitationOccurrence[];
  notes?: string[];
}
```

## Source Span Handling

The gateway YAML also cites hashline source spans:

```text
crates/gateway-runtime-omp/src/rpc_lifecycle.rs#0BD8:266-402
```

Those are not durable either. The four-hex hashline tag is a read snapshot anchor, not a long-term repo citation.

The freeze workflow should handle this in phases:

1. Detect and warn on hashline source refs in `scan`.
2. In `check`, resolve against the current worktree and report whether the tag still matches known read snapshot metadata.
3. Later, freeze to a durable source ref:

   ```text
   repo-ref://<repo-id>/<commit>/<path>#L266-L402
   ```

   or:

   ```text
   omp-ref://v1/source/<repo-id>/<commit>/<path>?sha256=<file-sha>#L266-L402
   ```

Source ref freezing requires repo identity and commit/file hash. It should not block artifact/agent citation freezing, but the tool should make unresolved source-span durability visible.

## Supersession Semantics

A superseded ref remains evidence. Do not rewrite it to its successor.

Example:

```yaml
invalidated:
  - ref: artifact://49
    reason: superseded by artifact://66 and then artifact://83/artifact://85
```

Frozen citation should preserve exact old refs:

```yaml
# artifact://49 => omp-ref://v1/session/<sid>/artifact/49?sha256=<sha49> (status: superseded)
# artifact://66 => omp-ref://v1/session/<sid>/artifact/66?sha256=<sha66> (status: superseded)
# artifact://83 => omp-ref://v1/session/<sid>/artifact/83?sha256=<sha83> (status: current)
# artifact://85 => omp-ref://v1/session/<sid>/artifact/85?sha256=<sha85> (status: current)
```

If the document contains explicit supersession structure, the tool may record it. It must not infer supersession silently from prose.

## Execution Plan

### P0: CLI skeleton and ref scanner

1. Add top-level CLI command group `refs`.
2. Register it in the explicit command table so argv does not fall through to `launch`.
3. Add subcommands:
   - `scan`;
   - `check` placeholder;
   - `freeze` placeholder;
   - `explain` placeholder.
4. Implement scanner with no resource resolution.
5. Recognize:
   - internal URL candidates;
   - existing `omp-ref://` refs;
   - hashline source-span candidates;
   - repeated occurrences;
   - managed legend blocks.
6. Emit structured JSON and human table output.

Acceptance:

- `omp refs scan <file>` reports live refs and source-span candidates without resolving resources;
- scanner ignores managed legend blocks by default;
- command help/completion lists `refs` and subcommands.

### P1: Context contract and check mode

This phase requires router parsing/context APIs. Ambiguity guarantees for duplicate artifact/agent aliases require the router scoped-alias phase.

1. Add freeze context parsing:
   - `--artifact-session`;
   - `--session-file`;
   - `--artifacts-dir`;
   - `--manifest`;
   - `--deeplink`;
   - `--ref-context`;
   - `--current`.
2. Require explicit context for live alias resolution.
3. Build `ResourceContext` for router calls.
4. Implement `check`:
   - resolve candidates where router APIs can do so safely;
   - report missing/ambiguous/private/non-exportable refs;
   - do not write files.
5. Refuse global-index guessing for live aliases.

Acceptance:

- `artifact://83` without context is reported as unresolved-context, not guessed;
- duplicate artifact IDs across sessions are ambiguous after router scoped-alias resolution is available;
- check mode returns non-zero on unresolved or unsafe refs unless `--allow-unresolved` is passed for diagnostics.

### P2: Provenance and pinning prerequisites

This phase depends on router/runtime manifest support and `router.prepareCitation` from `internal-url-resource-router.md`.

1. Consume creation-time `refs.jsonl` records for artifact and agent outputs.
2. Require content hash, size, kind, producer, and artifact-root session identity.
3. Call router-owned citation preparation/pinning APIs; the freeze CLI does not write CAS entries directly.
4. Add freeze diagnostics for:
   - provenance missing;
   - bytes missing;
   - hash mismatch;
   - content not retained;
   - export policy denied.
5. Do not emit canonical `omp-ref://` mappings unless `router.prepareCitation` returns `contentPinned: true` and `exportable: true`.

Acceptance:

- freeze refuses to publish canonical refs for artifacts without manifest-backed provenance;
- freeze uses router-owned preparation/pinning APIs before producing a canonical mapping;
- hash mismatch fails closed.

### P3: Legend preview generation

1. Implement managed legend block generation for:
   - YAML comments;
   - Markdown HTML blocks;
   - plaintext sentinel blocks.
2. Add idempotent replacement planning for existing managed blocks.
3. Preserve file bytes outside managed block in previews.
4. Include for each mapping:
   - live ref;
   - canonical ref;
   - kind;
   - occurrence count;
   - status;
   - optional redacted label.
5. Exclude private paths and private metadata.
6. Add sidecar preview generation:
   - `auto` default for future write mode;
   - `none` option;
   - explicit path option.
7. Keep this phase dry-run-only until P4 supplies syntax-safe write transforms.

Acceptance:

- `freeze --mode legend --dry-run` prints the managed legend and sidecar preview;
- no file is modified in this phase;
- no absolute OMP/session paths appear in public output.

### P4: Syntax-safe legend writes

1. Implement format detection:
   - YAML;
   - Markdown;
   - plaintext.
2. Use CST/span-preserving edits for YAML and Markdown.
3. Preserve:
   - line endings;
   - BOM;
   - final newline;
   - comments;
   - key order;
   - indentation;
   - scalar style;
   - folded/literal block style.
4. Skip by default:
   - Markdown fenced code;
   - Markdown inline code;
   - HTML comments except managed zones;
   - YAML keys;
   - unknown binary/non-text files.
5. Apply no partial changes when edits overlap or would invalidate syntax.
6. Enable `freeze --mode legend --write`.

Acceptance:

- generic YAML freeze preserves formatting and parses after write;
- Markdown freeze preserves fenced code and inline code;
- `freeze --mode legend --write` appends or updates a legend and sidecar idempotently;
- write mode is all-or-nothing by default.

### P5: Inline replacement mode

1. Implement `--mode inline` for safe scalar/list/link occurrences.
2. Implement `--mode both` for inline replacement plus legend.
3. Replace exact scalar refs safely.
4. Tokenize embedded prose refs such as `artifact://83/artifact://85` as two refs or refuse.
5. Leave already canonical `omp-ref://` refs unchanged unless verification reports mismatch.
6. Add dry-run diff output for inline changes.

Acceptance:

- scalar `- artifact://83` can become `- omp-ref://...`;
- ambiguous prose replacements are refused or left to legend mode;
- inline mode remains opt-in.

### P6: Schema profiles

1. Add `--profile generic` default.
2. Add `--profile release-yaml` for release records that allow structured `omp_citations` blocks.
3. Make profile behavior explicit:
   - allowed insertion locations;
   - allowed inline replacement fields;
   - fields that should remain live aliases plus legend;
   - fields carrying status/supersession semantics.
4. Add profile validation for the gateway release YAML shape.

Acceptance:

- generic YAML uses comment legends;
- release YAML profile can emit structured `omp_citations` without breaking schema expectations;
- profile output is idempotent.

### P7: Source-span warning and gated freezing

1. `scan` detects hashline source spans.
2. `check` warns that hashline tags are not durable citations.
3. Add optional source ref freezing only after the router registers a source-ref descriptor/resolver such as `repo-ref://...` or `omp-ref://v1/source/...`.
4. Do not block artifact/agent freezing on source-span support unless `--strict-source-refs` is passed.
5. Keep strict source mode unavailable until the router source-ref primitive exists.

Acceptance:

- source hashline refs are visible in reports;
- tool does not silently present hashline tags as durable;
- strict mode can require source-span canonicalization only after router source-ref support exists.

### P8: Supersession/status support

1. Preserve exact superseded refs.
2. Add status from manifest when available.
3. Allow schema profiles to map document fields such as `invalidated`, `rejected_or_stale_paths`, and `stale_or_superseded_targets` into status hints.
4. Never infer supersession from prose without profile support.

Acceptance:

- superseded artifacts freeze to their own hash-pinned refs;
- current and superseded refs are distinguishable in legends/sidecars;
- successors are recorded only from explicit metadata or profile-supported fields.

### P9: Agent ergonomics

1. Teach agents their citation/freeze workflow in prompt/tool docs once command exists.
2. Provide a short instruction pattern:

   ```text
   Use live refs while drafting. Before finalizing durable docs, run `omp refs freeze ... --mode legend --write`.
   ```

3. Add optional task/eval helper output that lists refs created in the current session and suggests the freeze command.
4. Keep final reports concise; do not force long canonical refs into reasoning loops.

Acceptance:

- agents know they can keep citing `artifact://N` during work;
- finalization guidance points to one mechanical freeze command;
- generated docs contain durable citation legends before publication workflows rely on them.

## Affected Areas

CLI:

- `packages/coding-agent/src/cli-commands.ts`
- `packages/coding-agent/src/commands/refs.ts`
- `packages/coding-agent/src/cli/refs-cli.ts`
- completion/help command metadata

Router/runtime APIs consumed:

- `packages/coding-agent/src/internal-urls/router.ts`
- `packages/coding-agent/src/internal-urls/types.ts`
- artifact manager / artifact write registration
- task output manager / agent output registration
- durable ref manifest/index modules from the router plan

Document transform helpers:

- YAML scanner/CST helpers;
- Markdown scanner helpers;
- plaintext scanner helpers;
- sidecar writer;
- managed block updater.

Docs/prompts:

- `docs/execution-plans/internal-url-resource-router.md`
- `docs/tools/read.md`
- future `docs/tools/refs.md`
- system prompt/tool guidance for citation freezing

## Verification Plan

Required behavior tests:

1. **Scanner**
   - finds repeated `artifact://` and `agent://` refs;
   - finds refs embedded in prose such as `artifact://83/artifact://85`;
   - finds existing `omp-ref://` refs;
   - detects hashline source spans;
   - ignores managed legend blocks.

2. **Context requirement**
   - live refs without context fail check/freeze;
   - explicit artifact-session/deeplink/ref-context resolves expected refs;
   - ambiguous duplicate live refs fail closed.

3. **Export policy**
   - non-exportable schemes are refused by default;
   - private paths are not written to legends/sidecars;
   - explicit private diagnostic mode is visibly marked.

4. **Provenance and pinning**
   - missing manifest provenance fails;
   - router preparation/pinning verifies retained bytes before canonical ref output;
   - hash mismatch fails closed.

5. **Legend mode**
   - YAML comment legend is appended/updated idempotently;
   - Markdown legend is appended/updated idempotently;
   - plaintext legend is appended/updated idempotently;
   - rerun produces no diff.

6. **Inline mode**
   - scalar/list refs replace safely;
   - prose boundary ambiguity is refused or normalized only when configured;
   - existing canonical refs are not duplicated.

7. **Format preservation**
   - YAML comments, key order, scalar style, indentation, line endings, and final newline are preserved;
   - Markdown fenced and inline code are skipped by default;
   - write mode is all-or-nothing.

8. **Release YAML profile**
   - generic mode uses comments;
   - profile mode emits valid structured `omp_citations`;
   - `invalidated` and `rejected_or_stale_paths` refs freeze as exact superseded refs.

9. **CLI integration**
   - `omp refs` is registered and does not fall through to launch;
   - help/examples render;
   - completion includes subcommands;
   - dry-run prints diff and resolution table;
   - write mode returns non-zero on unresolved refs unless partial mode is explicit.

Run focused command/transform/router-integration tests for touched areas, then package-local `bun check`.

## Migration Strategy

1. Land `scan` first. It has no durable-ref dependency and immediately exposes the problem in existing docs.
2. Land `check` once router parsing/context APIs are available; enable ambiguity guarantees after router scoped-alias resolution.
3. Land manifest/provenance and router-owned citation preparation with the router durable-ref work.
4. Land legend mode before inline mode.
5. Land schema profiles after generic YAML/Markdown/plaintext behavior is stable.
6. Add source-span freezing after artifact/agent refs work end-to-end.
7. Teach agents the workflow only after `freeze --mode legend` is reliable.

## Non-Goals

- Do not force agents to author long canonical refs manually.
- Do not replace live refs by default.
- Do not make `artifact://N` globally meaningful without context.
- Do not leak local filesystem paths in public legends.
- Do not infer supersession from prose.
- Do not parse/rewrite arbitrary formats beyond supported text/YAML/Markdown/plaintext modes.
- Do not treat hashes as authorization.
- Do not use global indexes to guess live alias source sessions.

## Settled and Open Design Decisions

1. Command name:
   - recommended: `omp refs`.

2. Default sidecar path:
   - candidate: `<document>.omp-refs.json`;
   - alternative: `.omp/refs/<document-hash>.json`.

3. Durable source ref grammar:
   - `repo-ref://...`;
   - or `omp-ref://v1/source/...`.

4. Release YAML profile schema:
   - comment legend only;
   - structured `omp_citations` block;
   - or both.

5. Incomplete provenance mode:
   - settled for write mode: refuse;
   - diagnostic mode may report incomplete refs only when explicitly marked non-authoritative.

6. Private export behavior:
   - settled for autonomous agents: no write-mode private export;
   - private diagnostics require `--private-diagnostic` and do not write legends/sidecars.

## Final Shape

The combined model with the router plan:

```text
Router: knows what refs mean and whether they may be cited.
Runtime: records provenance when refs are produced.
Freeze CLI: turns live refs in documents into durable citation mappings.
Docs: stay readable, with managed legends or opt-in canonical inline refs.
```

This keeps agent authoring ergonomic while making durable evidence records mechanically checkable and recoverable.
