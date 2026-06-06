# Internal URL Resource Router Execution Plan

## Objective

Turn OMP internal URLs from a scheme-to-handler dispatch mechanism into a coherent resource-reference router.

The desired user/agent experience:

```text
artifact://7                         # live alias in current artifact scope
agent://ReviewApi                    # live alias in current agent tree
local://plan.md                      # mutable caller-session scratch
pr://owner/repo/123                  # canonical external resource ref
omp-ref://v1/session/<sid>/artifact/7?sha256=<hash>#L10-L40
```

Agents and tools should be able to pass, cite, complete, search, materialize, and write resource references without each tool carrying its own hardcoded scheme folklore.

Durable docs should be able to cite refs that can be found later. Live aliases should remain convenient, but the system must distinguish them from canonical durable citations.

Companion workflow: `docs/execution-plans/internal-url-citation-freeze.md` owns document scanning, legends, inline replacement, and publication-time citation freezing. This plan owns the router primitives those workflows consume: descriptors, context, canonical metadata, manifests, indexes, selectors, materialization, and durable ref resolution.

## Problem Statement

The current router solves a real integration problem: OMP has many useful resources that are not ordinary workspace files or web URLs.

Examples:

- tool output artifacts: `artifact://<id>`;
- subagent outputs: `agent://<id>`;
- session scratch: `local://<path>`;
- embedded docs: `omp://`;
- active skills, rules, memory: `skill://`, `rule://`, `memory://root`;
- external resources: `mcp://`, `issue://`, `pr://`, `vault://`;
- RPC-host-owned resources via dynamically registered schemes.

The useful evolution has been to remove bespoke tool operations and route these resources through common read/search/find/write/autocomplete surfaces. But the router's current contract is too small for the role it now plays.

Current handler shape:

```ts
interface ProtocolHandler {
  scheme: string;
  immutable: boolean;
  resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource>;
  write?(url: InternalUrl, content: string, context?: WriteContext): Promise<void>;
  complete?(query?: string): Promise<UrlCompletion[]>;
}
```

Current resource shape:

```ts
interface InternalResource {
  url: string;
  content: string;
  contentType: "text/plain" | "text/markdown" | "application/json";
  size?: number;
  sourcePath?: string;
  notes?: string[];
  immutable?: boolean;
}
```

That is enough for "read this thing". It is not enough for:

- caller/session-scoped authority;
- alias vs canonical identity;
- selector parsing;
- shell/search/AST materialization;
- write approval;
- completion correctness;
- dynamic RPC scheme ownership;
- durable citation/deeplink behavior;
- ambiguity detection across concurrent sessions.

The result is policy drift. Scheme knowledge exists in the router, path utilities, bash expansion, write approval, autocomplete, docs, and prompts. Adding or changing a scheme is not a single protocol change; it is a multi-surface integration hazard.

## Evidence From Current Evolution

The git history shows a clear pattern:

- `docs://` was added for embedded docs, then renamed through `pi://` to `omp://`.
- plan/notes scratch evolved into `local://`.
- `mcp://` replaced a bespoke MCP resource-read path.
- a process-global router was introduced so parent/subagent sessions could share refs.
- subagents adopted a shared artifact manager and flat output directory.
- `issue://` and `pr://` replaced GitHub view operations.
- RPC host URI frames allowed hosts to register dynamic schemes.
- `vault://` added an external mutable resource namespace.
- internal URL completion was added.
- `local://` then needed a context fix because process-global fallback selected a sibling session's local root in multi-session hosts.

The objective lesson is not "the router needs more schemes." The lesson is:

> Resource references are becoming the inter-tool ABI for OMP.

The architecture should make that ABI explicit.

## Design Principle

An internal URL is a resource reference, not a pathname.

Resolution should be deterministic under explicit caller context:

```text
resolved resource = f(url, caller context, scheme descriptor, handler state)
```

Resolution should not depend on incidental process-global ordering:

```text
resolved resource ≠ first match in AgentRegistry.global().list()
```

Short refs are aliases. Canonical refs are explicit. Filesystem paths are implementation details.

## Definitions

### Resource Reference

A copyable identifier for a resource in a declared namespace.

Examples:

```text
artifact://7
agent://ReviewApi
skill://rust-skills
pr://owner/repo/123
mcp://<server-resource-uri>
```

### Live Alias

A convenient ref whose meaning depends on caller scope.

Examples:

```text
artifact://7
agent://ReviewApi
pr://123
issue://123
vault://_/Daily.md
```

Live aliases are correct for interactive work, but they are not durable citations.

### Canonical Ref

A ref that encodes enough explicit identity to resolve without ambient guesswork.

Examples:

```text
pr://owner/repo/123
issue://owner/repo/123
omp-ref://v1/session/<sid>/artifact/7?sha256=<hash>
```

### Resource Context

The caller authority/scope used to resolve a resource.

This includes cwd, settings, session id, agent tree/artifact scope, local root, active skills/rules, MCP manager, host bridge authority, and abort signal.

### Scheme Descriptor

The declarative contract for one scheme: scope, mutability, selector policy, materialization policy, completion policy, durability, and examples.

### Materialization

A separate operation that converts a resource to a safe filesystem path for a specific purpose such as bash, search, AST, find, edit, or readback.

Materialization is not the same as origin path.

### Selector

A view over resolved text, such as line range, raw mode, conflict mode, bytes, JSON pointer, or region.

Selectors are not part of resource identity.

## Required Invariants

1. **Explicit caller scope**
   - Session-sensitive schemes resolve against the caller's explicit context first.
   - Process-global fallback is compatibility-only.

2. **No ambient first-match for session-local refs**
   - If multiple independent sessions contain `artifact://7`, resolution must not silently choose one.
   - Caller/shared artifact roots win; otherwise ambiguity is reported.

3. **Single scheme registry**
   - Scheme capabilities are declared once.
   - Read, search, find, AST, bash, write, autocomplete, prompts, and docs consume the same descriptor data.

4. **Selectors are router-owned policy**
   - Consumers do not hardcode which schemes can peel `:raw` or `:10-40`.
   - Opaque schemes such as `mcp://` do not lose valid resource URIs to syntactic selector parsing.

5. **Source paths are not authority**
   - `originPath` / `sourcePath` may explain where content came from.
   - Tools must request materialization for filesystem operations.

6. **Write fails closed**
   - A handled internal URL without write capability never falls through into normal filesystem writing.

7. **Completion is context-correct**
   - Completion uses the same caller context as resolution.
   - No sibling-session local files or stale global skills should be suggested for a caller that cannot resolve them.

8. **Dynamic schemes are owned**
   - RPC host schemes cannot shadow built-ins by accident.
   - A host can unregister only schemes it owns.

9. **Aliases canonicalize when possible**
   - `pr://123` resolves with canonical metadata such as `pr://owner/repo/123`.
   - `artifact://7` and `agent://ReviewApi` remain live aliases until durable `omp-ref://` refs exist.

10. **Durability is explicit**
    - Live, session-retained, cache-backed, static, external, and content-addressed resources are different classes.
    - Tool output and docs should not imply live aliases are durable citations.

11. **Citation/export policy is explicit**
    - Not every readable resource is safe to cite in a durable document.
    - Private, mutable, local, vault, memory, and host-owned resources default to non-exportable unless the effective target capability says otherwise.

## Proposed Architecture

### InternalSchemeDescriptor

Add a descriptor next to `ProtocolHandler`.

```ts
type InternalSchemeScope =
  | "process"
  | "caller-session"
  | "agent-tree"
  | "repo"
  | "external"
  | "host";

type InternalSchemeDurability =
  | "static"
  | "live"
  | "session-retained"
  | "cache-backed"
  | "content-addressed";

type InternalSelectorPolicy =
  | "path-like"
  | "opaque"
  | "none"
  | "resolver-aware";

type InternalMaterializationPolicy =
  | "backing-path"
  | "scratch-copy"
  | "virtual-only"
  | "forbidden";

interface InternalSchemeDescriptor {
  scheme: string;
  description: string;
  owner: "builtin" | "rpc-host";
  scope: InternalSchemeScope;
  durability: InternalSchemeDurability;

  readable: boolean;
  writable: boolean;
  immutableDefault: boolean;

  selectorPolicy: InternalSelectorPolicy;
  completionPolicy: "none" | "local" | "context-required";
  materializationPolicy: InternalMaterializationPolicy;
  citationPolicy: "public" | "private" | "session-only" | "non-exportable" | "requires-explicit-export";
  metadataVisibility: "canonical-only" | "redacted" | "private-diagnostic";

  contextRequirements?: Array<
    | "cwd"
    | "settings"
    | "skills"
    | "rules"
    | "localRoot"
    | "artifactScope"
    | "memoryRoots"
    | "mcpManager"
    | "hostAuthority"
  >;

  examples: string[];
}
```

Register handlers with descriptors:

```ts
router.register({ descriptor, handler });
```

The descriptor becomes the source of truth for:

- `canHandle`;
- selector splitting;
- internal path classification;
- write approval;
- bash/search/find/AST materialization;
- autocomplete eligibility;
- docs/prompt inventory;
- conformance tests.

Descriptors are scheme defaults. Some schemes have mixed targets under one scheme, so write/materialize/citation decisions must use effective target capabilities after parsing/resolution.

```ts
interface EffectiveResourceCapabilities {
  readable: boolean;
  writable: boolean;
  immutable: boolean;
  selectorPolicy: InternalSelectorPolicy;
  materializationPolicy: InternalMaterializationPolicy;
  citationPolicy: InternalSchemeDescriptor["citationPolicy"];
  metadataVisibility: InternalSchemeDescriptor["metadataVisibility"];
}
```

### ResourceContext

Expand and normalize context passed to all router operations.

```ts
interface ResourceContext {
  cwd: string;
  settings?: Settings;
  signal?: AbortSignal;

  sessionId?: string;
  agentId?: string;
  agentTreeId?: string;

  artifactRoots?: string[];
  sharedArtifactRoots?: string[];
  memoryRoots?: string[];

  localProtocolOptions?: LocalProtocolOptions;

  skills?: readonly Skill[];
  rules?: readonly Rule[];

  mcpManager?: McpManager;
  hostAuthority?: RpcHostAuthority;

  compatibilityGlobalFallback?: boolean;
}
```

`ResolveContext` can evolve into this shape incrementally.

### Router Operations

Move policy-sensitive operations onto the router.

```ts
router.resolve(input, context)
router.write(input, content, context)
router.complete(scheme, query, context)
router.parseTarget(input, context?)
router.classify(input, context?)
router.describeTarget(input, context)
router.materialize(input, context, purpose)
router.canonicalize(input, context)
```

`parseTarget` returns resource identity and selector separately:

```ts
interface ParsedResourceTarget {
  original: string;
  resourceUrl: string;
  descriptor: InternalSchemeDescriptor;
  selector?: ReadSelector;
}
```

`materialize` is purpose-specific:

```ts
type MaterializationPurpose = "bash" | "search" | "find" | "ast" | "edit" | "readback";

interface MaterializedResource {
  path: string;
  immutable: boolean;
  cleanup?: () => Promise<void>;
}

```

Edit materialization is backing-path-only unless a future writeback/commit protocol is added. Scratch copies are acceptable for read/search/bash purposes, but they must not be exposed as editable targets without explicit commit semantics.

### Resolved Resource Metadata

Keep `InternalResource` backward-compatible, but add explicit metadata.

```ts
interface InternalResource {
  url: string;
  canonicalUrl?: string;

  content: string;
  contentType: "text/plain" | "text/markdown" | "application/json";
  size?: number;

  immutable?: boolean;
  durability?: InternalSchemeDurability;
  scope?: InternalSchemeScope;

  originPath?: string;
  sourcePath?: string; // compatibility alias while callers migrate
  materializedPath?: string; // only from router.materialize, not generic resolve

  contentHash?: string;
  notes?: string[];
}
```

The important semantic split:

- `originPath`: private/debug provenance;
- `materializedPath`: safe path returned for an explicit purpose;
- `sourcePath`: deprecated compatibility field.

## Scheme Semantics

### `artifact://`

Role: live alias for immutable tool output artifacts in the caller artifact scope.

Resolution order:

1. caller artifact roots;
2. explicitly shared parent/subagent artifact roots;
3. compatibility global active roots;
4. ambiguity error if multiple independent matches remain.

Do not treat `artifact://7` as durable outside active/resumable session context.

Future canonical durable form:

```text
omp-ref://v1/session/<artifactSessionId>/artifact/7?sha256=<hash>#L10-L40
```

### `agent://`

Role: live alias for subagent final output in the caller agent tree.

Resolution order mirrors `artifact://`.

`agent://<id>/<path>` and `agent://<id>?q=<query>` remain JSON extraction shorthands, but canonical durable citations should use explicit fragment/query rules under `omp-ref://` later.

### `local://`

Role: mutable caller-session scratch.

Changes:

- add first-class write handler;
- resolve and complete only from `context.localProtocolOptions` by default;
- keep global fallback only for compatibility paths such as UI hyperlink resolution.

### `memory://`

Role: caller/session memory namespace.

Changes:

- prefer caller memory roots;
- detect ambiguity across independent roots;
- avoid first-match global root behavior except compatibility fallback.

### `skill://` and `rule://`

Role: capability resources available to the caller.

Changes:

- resolve and complete from caller context;
- avoid process-global active skill/rule lists for context-sensitive callers;
- if global fallback is needed, make it explicit and tested.

### `issue://` and `pr://`

Role: GitHub resource aliases and canonical refs.

Short forms:

```text
issue://123
pr://123
```

are cwd/repo aliases.

Canonical forms:

```text
issue://owner/repo/123
pr://owner/repo/123
```

should be exposed in `canonicalUrl` after resolution.

### `mcp://`

Role: opaque external MCP resource URI.

Default policy:

- selector policy: `opaque`;
- materialization: usually `virtual-only` or `scratch-copy` only when explicitly requested and safe;
- completion depends on MCP manager context.

### `vault://`

Role: external mutable vault resource.

Descriptor should separate:

- file-like vault resources;
- vault operations via `?op=`;
- mutability and materialization policy;
- active vault alias `_` from canonical vault identity.

### Dynamic RPC Host Schemes

Role: host-owned resource namespaces.

Requirements:

- built-in schemes are reserved;
- host registration has owner id/token;
- unregister affects only the registering owner;
- duplicate scheme semantics are explicit;
- default selector policy is `opaque`;
- default materialization is `virtual-only`;
- host may opt into write, completion, immutability, and selector/materialization policy.

## Execution Plan

### P0: Descriptor mirror and conformance baseline

1. Add `InternalSchemeDescriptor` and register descriptors for existing built-ins.
2. Preserve current runtime behavior.
3. Add descriptor lookup APIs:
   - `getDescriptor(scheme)`;
   - `listDescriptors(context?)`;
   - `isRegisteredScheme(scheme)`.
4. Add dynamic descriptor defaults for host-registered schemes:
   - selector policy: `opaque`;
   - materialization policy: `virtual-only`;
   - completion policy: `none`;
   - citation policy: `non-exportable` unless host declares otherwise.
5. Add conformance tests that every built-in scheme has:
   - descriptor;
   - handler registration;
   - prompt/docs inventory coverage or explicit exclusion;
   - selector policy;
   - materialization policy;
   - read/write declaration.

Acceptance:

- no behavior changes except better diagnostics;
- all existing tests continue to pass;
- new descriptor tests prevent another scheme from being half-integrated.

### P1: Context-aware completion and resolution plumbing

1. Change handler completion signature:

   ```ts
   complete?(query?: string, context?: ResourceContext): Promise<UrlCompletion[]>;
   ```

2. Change router completion signature:

   ```ts
   router.complete(scheme, query, context)
   ```

3. Thread caller context through interactive autocomplete.
4. Make `local://` completion use `context.localProtocolOptions`.
5. Make `skill://` completion use `context.skills`.
6. Add or thread caller-scoped rule data for `rule://`, or mark rule completion process-global intentionally.
7. Ensure read/search/find/AST/write/bash use a common context builder.

Acceptance:

- distinct concurrent sessions complete `local://` against their own roots;
- skill completion matches caller skill set;
- no sibling-session suggestions appear in context-sensitive completion tests.

### P2: Router-owned parsing and selector policy

1. Add `router.parseTarget(input, context?)`.
2. Move internal URL selector splitting behind descriptor policy.
3. Replace hardcoded selector lists in `path-utils.ts`:
   - `INTERNAL_SCHEMES_WITH_SELECTORS`;
   - `OPAQUE_RESOURCE_SCHEMES`.
4. Preserve `mcp://` exact-resource behavior.
5. Default dynamic RPC schemes to opaque via P0 dynamic descriptor defaults.
6. Add tests for:
   - path-like selector peeling;
   - opaque exact refs ending in `:raw` or `:1-50`;
   - malformed selectors surfacing as selector errors, not handler host errors.

Acceptance:

- consumers no longer maintain independent selector scheme lists;
- `mcp://` behavior is preserved;
- new dynamic schemes cannot accidentally become selector-peelable.

### P3: Internal path classification from descriptors

1. Replace hardcoded top-level prefix lists in path utilities with router descriptor queries.
2. Update `@` prefix stripping to recognize registered internal schemes where safe.
3. Make `resolveToCwd` reject registered internal schemes even when a scheme is dynamic.
4. Make write approval classification ask the router/descriptor instead of `isInternalUrlPath` prefix folklore.
5. Ensure schemes without write capability fail closed.

Acceptance:

- a registered dynamic read-only RPC scheme is classified as internal, not a relative filesystem path;
- writes to handled read-only internal refs fail with a clear read-only error;
- writable host schemes receive the intended approval class.

### P4: Dynamic RPC ownership and descriptor enforcement

1. Extend RPC host scheme registration to bind descriptors and handlers to an owner id/token.
2. Reject collisions with built-in schemes by default.
3. Define duplicate dynamic scheme behavior explicitly:
   - same owner may replace its own scheme definition;
   - different owners cannot destructively replace each other;
   - unregister removes only schemes owned by the requesting bridge.
4. Preserve P0 defaults unless the host explicitly opts into supported selector, completion, materialization, immutability, write, and citation capabilities.
5. Keep host-owned schemes non-exportable by default even when readable.

Acceptance:

- a host cannot shadow `agent://`, `artifact://`, `local://`, or other built-ins by default;
- one host cannot unregister another host's scheme;
- dynamic host schemes appear in descriptor-driven classification, write approval, and selector policy.

### P5: Materialization API skeleton

1. Add `router.materialize(input, context, purpose)`.
2. Add descriptor materialization policies and effective target capability checks.
3. Split provenance from materialized path:
   - keep `sourcePath` compatibility;
   - add `originPath`;
   - only `materialize` returns filesystem paths for tool use.
4. Add scratch-copy support for immutable virtual text where useful and safe.
5. Forbid scratch-copy materialization for `purpose: "edit"` unless a future writeback/commit protocol exists.
6. Keep broad search/find/AST/bash consumer cutover for P7, after scoped alias resolution is fixed.

Acceptance:

- virtual readable resources either materialize through explicit policy or produce clear unsupported errors;
- immutable resources are not accidentally treated as editable backing files;
- the API exists without centralizing current cross-session alias ambiguity into every materializing tool.

### P6: Scoped alias resolution

1. Extend context with explicit artifact and memory scopes.
2. Refactor `artifact://`:
   - caller roots first;
   - explicitly shared roots second;
   - compatibility global roots only when `context.compatibilityGlobalFallback === true`;
   - no-context or unrelated-context calls fail closed by default;
   - ambiguity error for independent duplicate IDs.
3. Refactor `agent://` similarly.
4. Refactor `memory://` to prefer caller memory roots and detect ambiguity.
5. Ensure parent/subagent shared artifact manager behavior remains intact by representing the shared scope explicitly.
6. Add multi-session tests for duplicate artifact IDs, duplicate agent IDs, local roots, and memory roots.

Acceptance:

- independent sessions in one process cannot silently read each other's `artifact://0`;
- a caller with no artifact scope cannot read a single sibling session's `artifact://0` unless compatibility fallback is explicitly enabled;
- parent/subagent shared outputs still resolve conveniently;
- ambiguity diagnostics include canonical disambiguation options without leaking unnecessary content.

### P7: Materialization consumer cutover

1. Refactor search/find/AST scope resolution to use `router.materialize`.
2. Refactor bash internal URL expansion to use materialization instead of its own scheme regex/list.
3. Remove obsolete `plan` from bash URL expansion unless a descriptor-level redirect is explicitly kept.
4. Add focused tests that materialization uses scoped `artifact://`, `agent://`, and `memory://` resolution from P6.

Acceptance:

- bash/search/find/AST no longer maintain independent supported-scheme lists;
- materializing `artifact://0` in independent concurrent sessions cannot read the wrong session;
- unsupported virtual resources error clearly.

### P8: Canonical metadata and alias surfacing

1. Add `canonicalUrl`, `durability`, `scope`, and `contentHash` metadata where available.
2. Add `router.describeTarget` and `router.canonicalize` deliverables that expose effective target capabilities and canonical metadata for the companion freeze workflow.
3. `issue://N` and `pr://N` expose owner/repo canonical URLs after resolution.
4. `vault://_/...` exposes concrete vault identity only through metadata visibility/redaction rules.
5. `artifact://` and `agent://` expose live-alias scope metadata.
6. Update read/tool renderers to surface canonical refs where useful without overwhelming normal output, applying `metadataVisibility` so private-diagnostic metadata never appears in normal output.

Acceptance:

- docs and agents can distinguish live aliases from canonical refs;
- canonical metadata is available programmatically for future citation helpers;
- existing visible output remains concise.

### P9: Generated or checked scheme inventory

1. Generate or mechanically check prompt/docs scheme inventories from descriptors.
2. Keep human docs explanatory, but make the scheme list impossible to drift silently.
3. Add tests or snapshots for:
   - system prompt URL inventory;
   - read tool docs inventory;
   - completion scheme inventory;
   - descriptor examples.

Acceptance:

- adding a scheme requires descriptor registration and fails tests if user/model-facing inventory is stale;
- conditional schemes such as `vault://` remain conditionally surfaced.

### P10: Durable `omp-ref://` router primitives

This phase should follow live-router cleanup. It provides the durable ref scheme, manifests, indexes, hash verification, selector behavior, and agent self-citation metadata consumed by the companion citation-freeze workflow. Document scanning, YAML/Markdown transforms, legends, and inline replacements live in `docs/execution-plans/internal-url-citation-freeze.md`.

1. Add a reserved durable citation scheme:

   ```text
   omp-ref://v1/session/<artifactSessionId>/artifact/<id>?sha256=<hash>#L10-L40
   omp-ref://v1/session/<artifactSessionId>/agent/<id>?sha256=<hash>
   omp-ref://v1/content/sha256/<hash>#L10-L40
   ```

2. Declare `omp-ref://` selector handling explicitly:
   - URI fragments such as `#L10-L40`, `#bytes=10-40`, `#json=/findings/0`, and `#region=<id>` are durable deeplink selectors;
   - read-tool colon selectors remain live shorthand and must not conflict with fragments;
   - if both fragment and colon selector are supplied, reject unless they are equivalent.
3. Add anchor metadata to manifests:
   - selector kind;
   - byte/line/json span;
   - bounded context hashes where useful for drift diagnostics.
4. Add per-session ref manifest:

   ```text
   <artifactsDir>/refs.jsonl
   ```

5. Add global local ref index under configured OMP agent dir.
6. Register artifact and agent outputs with content hashes at creation time.
7. Add a router-owned citation preparation API consumed by the companion freeze workflow:

   ```ts
   router.prepareCitation(input, context) -> {
     canonicalRef,
     publicMetadata,
     contentPinned,
     exportable,
   }
   ```


8. Resolve durable refs only after caller/session/export authority is checked:
   - active matching authorized session;
   - authorized global index entry;
   - authorized per-session manifest;
   - content-addressed store only through an authorized citation/manifest record.
9. Verify hash before serving immutable content.
10. Apply fragment selectors after hash verification and before pagination/materialization.
11. Materialize hash-pinned refs through content-addressed cache, not mutable origin paths.
12. Add agent self-citation metadata:
   - agent id;
   - parent id;
   - live `agent://` ref;
   - pending/final canonical durable ref;
   - private sidecar ref.

Acceptance:

- docs can cite durable refs and recover them later on the same configured OMP installation;
- content hash mismatch fails closed for immutable refs;
- durable fragment selectors resolve the cited line/byte/json region after hash verification;
- live aliases remain unchanged and do not pretend to be durable.
- `omp-ref://v1/content/sha256/...` does not bypass authority; content-only refs require an authorized manifest/citation record;

## Affected Areas

Primary files:

- `packages/coding-agent/src/internal-urls/types.ts`
- `packages/coding-agent/src/internal-urls/router.ts`
- `packages/coding-agent/src/internal-urls/parse.ts`
- `packages/coding-agent/src/internal-urls/artifact-protocol.ts`
- `packages/coding-agent/src/internal-urls/agent-protocol.ts`
- `packages/coding-agent/src/internal-urls/local-protocol.ts`
- `packages/coding-agent/src/internal-urls/memory-protocol.ts`
- `packages/coding-agent/src/internal-urls/skill-protocol.ts`
- `packages/coding-agent/src/internal-urls/rule-protocol.ts`
- `packages/coding-agent/src/internal-urls/mcp-protocol.ts`
- `packages/coding-agent/src/internal-urls/issue-pr-protocol.ts`
- `packages/coding-agent/src/internal-urls/vault-protocol.ts`
- `packages/coding-agent/src/modes/rpc/host-uris.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`

Tool integration files:

- `packages/coding-agent/src/tools/path-utils.ts`
- `packages/coding-agent/src/tools/read.ts`
- `packages/coding-agent/src/tools/search.ts`
- `packages/coding-agent/src/tools/find.ts`
- `packages/coding-agent/src/tools/ast-grep.ts`
- `packages/coding-agent/src/tools/ast-edit.ts`
- `packages/coding-agent/src/tools/write.ts`
- `packages/coding-agent/src/tools/bash-skill-urls.ts`

UX/docs/prompt files:

- internal URL autocomplete implementation;
- system prompt URL inventory;
- `docs/tools/read.md`;
- `docs/tools/task.md`;
- `docs/tools/github.md`;
- `docs/rpc.md`;
- future citation/deeplink docs.

## Verification Plan

Focused tests should cover behavior, not internal plumbing.

Required test groups:

1. **Descriptor conformance**
   - every registered scheme has descriptor and handler;
   - descriptor capabilities match expected read/write/materialization/selector behavior.
   - citation/exportability defaults deny private and mixed-capability resources unless explicitly allowed.

2. **Context correctness**
   - two concurrent sessions with different `local://` roots resolve and complete independently;
   - skill/rule completion matches caller context;
   - issue/pr short forms use caller cwd.

3. **Ambiguity safety**
   - duplicate `artifact://0` across independent sessions errors;
   - shared parent/subagent artifact scope still resolves;
   - duplicate `agent://Review` across independent sessions errors.

4. **Selector policy**
   - path-like schemes support selectors;
   - `mcp://` and opaque RPC refs ending in `:raw` remain exact resources;
   - malformed selectors produce selector diagnostics.

5. **Write safety**
   - read-only internal refs do not fall through to filesystem writes;
   - writable `local://` and writable RPC schemes route through write handlers;
   - approval class derives from descriptor.

6. **Materialization**
   - bash/search/find/AST materialize supported resources through router API;
   - unsupported virtual resources error clearly;
   - immutable virtual refs use scratch/content cache when materialized.

7. **RPC ownership**
   - host cannot shadow built-ins by default;
   - one host cannot unregister another host's scheme;
   - duplicate dynamic scheme behavior is deterministic.

8. **Canonical metadata**
   - `issue://N` and `pr://N` expose owner/repo canonical URLs;
   - live artifact/agent aliases expose scope/durability metadata;
   - durable `omp-ref://` hash mismatch fails closed once implemented;
   - durable `omp-ref://` applies hash verification before selector extraction;
   - durable fragment selectors and read-tool colon selectors reject conflicts unless equivalent.

9. **Companion workflow contract**
   - router `canonicalize`/manifest APIs provide enough metadata for `internal-url-citation-freeze.md`;
   - router does not parse or rewrite YAML/Markdown documents.

Run focused coding-agent tests for touched areas, then `bun check` for the package.

## Migration Strategy

1. Start permissive: descriptors mirror current behavior.
2. Add context-aware APIs while keeping old call signatures as wrappers.
3. Move consumers one by one to descriptor/router APIs.
4. Add conformance tests before tightening semantics.
5. Tighten ambiguous global fallback only after caller context is wired through all major tools.
6. Keep live aliases stable.
7. Add durable refs as a new scheme instead of overloading existing alias schemes.

8. Keep document citation freezing in the companion workflow; expose canonicalization, manifest, and resolver APIs here.

## Non-Goals

- Do not remove existing live aliases.
- Do not make every internal resource editable.
- Do not make URL possession grant authority.
- Do not use filesystem paths as the durable citation contract.
- Do not overload `artifact://` or `agent://` with durable session/hash syntax.
- Do not force opaque external schemes into path-like URL grammar.

## Settled and Open Design Decisions

1. Exact durable scheme name:
   - recommended: `omp-ref://v1/...`.

2. Canonical artifact/session identity:
   - settled for artifact/agent refs: use the artifact-root session id, not a subagent conversation session id.

3. Global ref index storage:
   - likely SQLite under configured agent dir;
   - per-session `refs.jsonl` remains append-only source of truth.

4. Prompt/docs inventory generation:
   - choose between generated Markdown snippets and tests that compare hand-written docs against descriptors.

5. RPC dynamic scheme namespace:
   - decide whether collisions are rejected globally or allowed only within a host-scoped authority prefix.

6. Source-span durable refs:
   - companion freeze workflow may detect hashline source refs early;
   - strict source freezing must wait until this router registers a source-ref descriptor/resolver such as `repo-ref://...` or `omp-ref://v1/source/...`.

## Final Shape

The target paradigm:

```text
Internal URL Router = Resource Reference Router
```

Contract:

```text
An internal URL identifies a resource in a declared namespace.
A caller context supplies authority and scope.
A scheme descriptor declares capabilities.
Tools ask the router what is allowed.
Short refs are aliases.
Canonical refs are explicit.
Filesystem paths are materialization details.
Durable citations use content/session identity, not active-session aliases.
```
