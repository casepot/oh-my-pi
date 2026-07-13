# Checkpoint Seal Evaluation: Bloomberg CLI Request Workflow

Status: executable experiment protocol

Target repository: `/Users/case/projects/bloomberg-cli`

Checkpoint implementation specification: `context-span-checkpoints.md`

## Research question

After a substantial implementation phase is completed and verified, which active-context representation best supports correct and efficient continuation into the next phase?

Conditions:

1. full raw context;
2. scoped-Shake context;
3. semantic-seal report only;
4. the identical semantic report plus deterministic execution manifest.

The fourth condition is the proposed target design. Conditions 3 and 4 use identical report bytes so their difference isolates manifest value.

## Why Bloomberg CLI

The repository is at Phase 0/preflight but already contains enough substrate for a substantial offline Phase 1 task:

- `src/bloomberg_cli/blp/adapter.py`: `BlpApiAdapter` protocol;
- `src/bloomberg_cli/blp/fake.py`: deterministic success, partial/final, failure, timeout, race, stale-correlation, auth, and entitlement scenarios;
- `src/bloomberg_cli/blp/types.py`: request/result/event/message records;
- `src/bloomberg_cli/schema/normalized.py`: normalized service/operation schema types;
- `src/bloomberg_cli/schema/json_schema.py`: Draft 2020-12 request schema generation;
- codecs preserve event and message boundaries;
- `contract/registry.py` declares `request.validate` and `request.send`;
- `cli.py` leaves request execution phase-pending;
- `blp/real.py` explicitly leaves live request execution unimplemented.

The shared phase can produce a complete adapter-injected request application layer. The continuation then integrates it into the CLI. Continuation depends on shared decisions but can recover them from source, making omission and rediscovery measurable rather than fatal.

## Environmental baseline

Observed before implementation:

```text
Offline suite excluding Bloomberg-runtime-dependent files: 84 passed.
Unfiltered suite: 87 passed, 4 failed.
All four failures were caused by missing official `blpapi` in the local environment.
```

Offline baseline command:

```bash
uv run pytest -q \
  --ignore=tests/blp/test_real_adapter_versions.py \
  --ignore=tests/security/test_live_probe_stubs.py
```

The experiment MUST remain fake-adapter-backed. Real Bloomberg connectivity, daemon sessions, live identities, and external service availability are confounds and non-goals.

## Experimental task

### Shared phase: request workflow core

Implement the transport-independent Phase 1 request preparation, validation, and adapter-backed execution layer. Do not expose it through CLI dispatch yet.

Required behavior:

1. Load a JSON object from exactly one source: file, stdin, or inline JSON.
2. Reject conflicting sources, malformed JSON, and non-object bodies through structured errors.
3. Discover a normalized operation through `BlpApiAdapter`.
4. Generate the operation request JSON Schema.
5. Validate before any adapter mutation.
6. Emit deterministic diagnostics with JSON Pointer paths.
7. Distinguish local schema validity, BLPAPI population validity, and server acceptance.
8. Never claim local validation proves server acceptance.
9. Support strict unknown-field failure and permissive unknown-field warning.
10. Warn on deprecated elements.
11. Include the deterministic operation schema hash.
12. Authorize policy before mutation.
13. Open the service and send through `BlpApiAdapter` only after local acceptance.
14. Preserve complete `BlpRequestResult`: partial/final event order, final messages, aggregate data, entitlement state, correlation metadata, and Bloomberg request IDs.
15. Translate fake adapter and policy failures into existing structured CLI/domain errors rather than generic configuration failures.

Recommended architecture:

- Add one request-focused application module/package.
- Depend on `BlpApiAdapter` rather than fake/real concrete adapters.
- Reuse `RequestSpec`, `BlpRequestResult`, normalized schemas, schema hash, envelopes, errors, and policy conventions.
- Avoid new duplicate wire models unless a behavior contract requires one.

Required tests:

- three body sources;
- conflicting/malformed/non-object bodies;
- strict/permissive validation;
- deprecated warnings;
- JSON Pointer diagnostics;
- schema hash;
- successful request;
- partial then final response;
- request failure;
- timeout/incomplete;
- stale correlation behavior;
- entitlement partial status;
- validation/policy denial before adapter mutation.

Non-goals:

- CLI dispatch;
- fake selection in public CLI flags;
- real Bloomberg request execution;
- daemon requests;
- schema cache commands;
- cancellation/status;
- subscriptions/provider workflows.

### Genuine boundary acceptance

Do not fork until:

- core behavior is complete;
- focused tests pass;
- offline regression tests pass;
- Ruff passes;
- basedpyright passes;
- `ty check src` passes;
- no request CLI branch exists;
- no pending jobs/actions/tool calls remain;
- close-time todo state is captured;
- exact filesystem snapshot and raw transcript are durable.

Name the captured state:

```text
S0 = repository seed before shared phase
S1 = verified filesystem after shared phase
R  = raw shared-phase transcript
T1 = close-time orchestration snapshot
```

## Shared-phase task prompt

Use this prompt verbatim apart from unavoidable repository-context injection:

> Implement the transport-independent Phase 1 transient request workflow core described by `BLOOMBERG_CLI_SPEC.md` sections 14.5 and 15.1–15.7.
>
> End at a stable application-layer API. Do not wire request commands into `src/bloomberg_cli/cli.py` or alter command dispatch in this phase.
>
> Reuse the existing normalized schema generator, schema hash, adapter protocol, request/result records, policy decision, envelopes, errors, and fake adapter. Do not create parallel conventions.
>
> Load a request body from exactly one JSON file, stdin, or inline JSON source. Require an object. Produce deterministic JSON Pointer validation diagnostics. Distinguish local schema validity, BLPAPI request-population validity, and server acceptance; local validation must never claim server acceptance. Support strict and permissive unknown-field handling and deprecated-field warnings. Validate and authorize policy before adapter mutation. Include the operation schema hash. Execute through `BlpApiAdapter`, preserving complete partial/final event and message boundaries, timeout/incomplete state, request-status failures, entitlement state, correlation identity, and Bloomberg request IDs.
>
> Add deterministic contract tests for body-source behavior, validation boundaries, schema hash, successful and partial requests, request failure, timeout, stale correlation, entitlement partial status, and zero adapter mutation after validation/policy failure.
>
> Real Bloomberg connectivity, CLI dispatch, daemon state, schema cache commands, authorization requests, subscriptions, and provider workflows are non-goals.
>
> Run focused tests, the offline regression suite, Ruff, basedpyright, and `ty check src`. Finish only when the application-layer phase is complete and verified.

## Continuation phase: CLI integration

All four conditions receive the same continuation task.

Required behavior:

### `bbg request validate`

- resolve service and operation positional arguments;
- accept exactly one `--body <path|->` or `--body-json <json>`;
- support `--schema-file` offline validation;
- support adapter-backed operation discovery;
- support strict/permissive validation;
- emit stable JSON envelope with schema source/hash, three validation statuses, diagnostics, warnings, and explicit `server_accepted: not_tested`;
- never mutate send state when local validation fails.

### `bbg request send`

- reuse the completed application layer;
- execute through an injected `BlpApiAdapter` in deterministic tests;
- production default remains `RealBlpApiAdapter`;
- preserve partial/final event and message boundaries;
- include schema hash and identity-use metadata;
- classify success, request failure, timeout/incomplete, and entitlement/auth outcomes;
- reject invalid requests before adapter mutation.

### Test seam

`dispatch` MUST accept optional keyword-only dependencies sufficient to supply an adapter and stdin. Production invocation uses the real adapter/process stdin when absent. Do not add a fake public CLI flag or environment switch.

### Command contract

Update registry metadata to match implemented body, schema, validation, timeout, profile/session/identity, stdin, side-effect, and error behavior. `command describe request.validate` and `request.send` must remain executable truth.

### Output discipline

- one JSON value on stdout in JSON mode;
- structured error envelope and registry exit code;
- no traceback/prose contamination;
- no body-secret echo.

### Continuation tests

- valid offline validation;
- invalid JSON Pointer diagnostics;
- strict/permissive unknown fields;
- conflicting body sources;
- success;
- partial/final;
- request failure;
- timeout;
- no send mutation after validation failure;
- command-description metadata;
- stdout discipline.

## Continuation prompt

Use this prompt verbatim:

> Continue the completed Phase 1 request workflow by exposing it through the CLI contract.
>
> Reuse the existing request application layer. Do not introduce a second request validator, runner, result model, schema hash implementation, body loader, or error convention. Modify the core only when integration exposes a concrete behavioral defect, and add a regression test for that defect.
>
> Implement `bbg request validate` and `bbg request send` according to the repository specification and executable command registry. `request validate` must support exactly one body source, offline `--schema-file` validation, adapter-backed discovery, strict/permissive diagnostics, operation schema hash, explicit local/population/server statuses, and no send mutation. `request send` must validate then execute through `BlpApiAdapter`, preserve every partial/final event and message boundary, include schema/identity metadata, and classify failure, timeout, and entitlement outcomes.
>
> Add a narrow keyword-only adapter/stdin injection seam to dispatch for deterministic tests. Production behavior must still use the real adapter and process stdin by default. Do not expose a fake CLI flag.
>
> Update command metadata to reflect the implemented surface. Preserve one-JSON stdout, existing envelopes/errors, registry exit codes, strict argument arity, and secret redaction.
>
> Add deterministic command-level tests using `FakeBlpApiAdapter` for valid/invalid validation, strict/permissive handling, source conflicts, success, partial/final responses, request failure, timeout, no mutation after validation failure, command metadata, and stdout discipline.
>
> Real Bloomberg networking, daemon request state, cancel/status, schema cache management, auth requests, subscriptions, and provider workflows are non-goals.
>
> Run focused command tests, shared request-core tests, the offline regression suite, Ruff, basedpyright, and `ty check src`. Complete the implementation end to end.

## Context conditions

### A: Full raw

Active context contains complete `R`: reads, searches, decisions, edits, failures, tests, and final delivery.

Provider sessions are recreated from visible history. Hidden provider cache is not retained.

### B: Scoped Shake

Apply deterministic artifact-backed Shake only to `R`. Preserve ordinary decisions and prose; elide eligible tool results and large closed blocks. All artifacts remain recoverable. Do not add a semantic report.

### C: Semantic report

Replace eligible `R` content with one structured assistant-authored report containing outcome, durable context, decisions/reasons, verification, remaining risk, and next phase. Include raw evidence URI. Do not inject the execution manifest.

### D: Semantic report plus manifest

Use the exact report bytes from C and append a runtime-generated manifest digest containing changed paths, command outcomes, tool failures, todo delta/state, opaque effects, evidence URI, and compression statistics.

## Report derivation

1. Capture raw `R` before asking for a report.
2. Preserve the raw branch.
3. On a derivation branch, ask the shared-phase agent to produce the structured report without further edits.
4. Freeze the report bytes.
5. Use them unchanged in C and D.
6. Generate the manifest mechanically from runtime records.
7. Validate factual consistency without improving the report.

### Treatment-session isolation

Each mutating derivation MUST start from its own physical copy of the untreated shared session file. Raw, Shake, and semantic conditions MUST NOT share mutable session-entry objects or a writable session journal.

- Raw continues from the untouched shared session file.
- Shake continues from a dedicated copy mutated only by scoped Shake.
- Report-only and report-plus-manifest continue from a separate semantic-derivation copy.
- Before every continuation, raw and semantic branches MUST contain zero `[shaken …]` placeholders.
- Before every Shake continuation, the branch MUST contain at least one artifact-backed Shake placeholder and a completed Shake seal marker.
- Any isolation assertion failure invalidates the experiment before a provider continuation runs.

## Experimental controls

Every continuation starts from identical `S1`, lockfile, runtime, model, effort, tool definitions, request/runtime policy, and `T1`. No jobs or pending actions may remain.

All shared, derivation, continuation, and model-based review runs MUST use `openai-codex/gpt-5.6-sol` with `medium` reasoning. The harness MUST pass `--thinking medium`, assert the RPC state reports `thinkingLevel: "medium"`, and record that pin in `protocol.json`. Runs at another reasoning level are invalid setup trials and excluded from outcome analysis.

The workstation Codex CLI MUST be the latest published release that supports the pinned model. For the 2026-07-12 pilot, both `codex --version` and the published package check resolved to `0.144.1`; the installed Homebrew cask was upgraded from `0.142.4` before valid continuation runs. Record the installed and published versions in the experiment environment artifact.

Use fresh provider sessions for every arm. Disable or hold constant automatic context maintenance. An arm is invalid if unplanned compaction occurs or the context window overflows.

Measure treatment context from the first assistant provider usage after the continuation boundary: `input + cacheRead + cacheWrite`. Pre-turn session `contextUsage` is diagnostic only; history rewrites can leave it anchored to usage recorded before the rewrite.

Use disposable workspaces at the same visible canonical path, or deterministically normalize path references. Different worktree paths inside raw transcripts are a confound.

Assert orchestration equality before each continuation:

- identical todos/statuses;
- identical active next task;
- identical goal/MCP state;
- no pending action/job;
- checkpoint closed.

Use the same toolset. Controlled runs SHOULD disable optional subagent delegation; a later naturalistic run may enable it.

Randomize arm order.

## Replication

Pilot: one run per condition to validate instrumentation.

Main experiment: five runs per condition, twenty continuation runs total. Three per condition is acceptable for a directional first pass but not a definitive ranking.

All main runs share `S1`, `R`, report, and manifest. Later replication should use a different task archetype.

## Pre-registered hypotheses

- H1: raw minimizes some rediscovery but retains stale/noisy chronology.
- H2: scoped Shake preserves quality near raw with substantial context reduction.
- H3: semantic report maximizes compression but increases omission-sensitive rediscovery/errors.
- H4: report plus manifest recovers much of report-only efficiency/correctness loss.
- H5: compacted context may outperform raw by reducing trajectory noise.

## Hidden behavioral contracts

Author hidden tests before continuation runs and keep them outside agent workspaces.

Validation:

1. valid schema-file request succeeds;
2. strict unknown field fails;
3. permissive unknown field warns;
4. diagnostic path is JSON Pointer;
5. deprecated field warns;
6. malformed/non-object body fails structurally;
7. conflicting body sources fail;
8. server acceptance remains `not_tested`;
9. operation schema hash is present and correct.

Execution:

10. success preserves final response;
11. partial/final ordering and boundaries survive;
12. request-status failure is not success;
13. timeout is incomplete, not Bloomberg rejection;
14. invalid body causes zero adapter mutations;
15. identity metadata does not invent authorization;
16. partial entitlement is not full success;
17. correlation and Bloomberg request IDs remain distinct;
18. stale-correlation records are quarantined;
19. event-before-return sequence remains valid.

CLI:

20. request command descriptions expose implemented options;
21. success emits one JSON value and empty stderr;
22. failure emits one structured JSON error and no traceback;
23. existing Phase 0 commands remain unchanged.

## Evaluation

### Primary outcomes

Rank in order:

1. mandatory hidden-contract completion;
2. regression safety;
3. blinded final implementation quality;
4. verification integrity.

Efficiency cannot compensate for incorrect behavior.

### Verification metrics

Record focused tests, shared tests, offline regression, Ruff, basedpyright, ty, hidden tests, and whether claims match observed evidence.

Classify:

- V1 focused tests omitted;
- V2 regression omitted;
- V3 static check omitted;
- V4 observed failure ignored;
- V5 test weakened/suppressed;
- V6 claim exceeds evidence;
- V7 environment failure misattributed;
- V8 hidden contract fails despite completion claim.

### Duplicate work

Distinguish healthy re-grounding from redundant rediscovery and duplicate implementation.

Measure:

- broad searches and repeated reads before locating the integration seam;
- raw history/artifact recovery;
- shared-core files modified during continuation;
- unnecessary core churn/reverts;
- duplicate body loaders, validators, hash helpers, runners, result/error models;
- validation implemented directly in CLI;
- regression-backed legitimate core fixes.

### Tool trajectory

Record:

- calls by tool and status;
- reads/searches/edits/test commands;
- failed edits/retries;
- time/calls to first edit and first passing focused test;
- artifact/history reads;
- input/output tokens;
- unplanned maintenance;
- elapsed time as secondary data.

### Blind review rubric

Reviewers see only `S1 -> final` diff, final tree, hidden/static results, and continuation specification.

- Observable correctness: 40
- Reuse and architecture: 20
- Regression safety: 15
- Test quality: 15
- Maintainability: 10

Do not show condition, transcript, tool counts, context size, or run order before scoring.

## Incident taxonomy

- C1 durable fact omitted from report;
- C2 report contains incorrect claim;
- C3 manifest omits needed provenance;
- C4 manifest misleads or over-anchors;
- C5 Shake removes information without practical recovery;
- C6 agent ignores available context;
- C7 raw context preserves stale trajectory causing drift;
- C8 shared-prefix defect;
- C9 continuation prompt ambiguity;
- C10 model stochasticity unrelated to context;
- C11 harness/session transform defect;
- C12 environment/dependency failure.

Classify incidents before unblinding.

## Analysis

Report per condition: individual values, median, range, failure categories, and notable incidents. With small samples, emphasize direction, consistency, and practical magnitude rather than unsupported statistical significance.

Primary pairwise comparisons:

- A vs B: cost/value of mechanical elision;
- A vs C: cost/value of semantic replacement;
- C vs D: incremental manifest value;
- B vs D: whether hybrid semantic sealing justifies complexity over safer Shake.

Plot or tabulate quality versus active-context size, tool calls, duplicate work, and recovery behavior. Keep quality and efficiency separate.

## Decision rules

- Shake matches raw while semantic arms regress: ship scoped Shake first; keep semantic sealing experimental.
- Report + manifest matches raw/Shake at lower context: proceed with hybrid seal.
- Report only matches manifest arm: keep manifest for audit/UI or reduce its active digest; do not assume context value.
- Manifest materially improves report only: make manifest part of semantic seal and identify the smallest useful fields.
- Compacted arms outperform raw: treat sealing as trajectory control, not merely token savings.
- All arms equivalent: prefer lower-risk Shake and test a harder/different task.
- High variance: add replicates and inspect model/delegation variability.
- Frequent raw recovery: add only repeatedly needed information; do not inflate every report.

## Durable run artifacts

Persist:

```text
experiment/
  protocol.json
  seed/{s0,s1,boundary-audit}
  contexts/{raw,derivation/shake-sessions,derivation/summary-sessions,shake,semantic-report,manifest}
  runs/<anonymous-id>/{private-condition,treatment-context,transcript,tool-events,final.patch,verification,hidden-tests,metrics,incidents}
  reviews/<anonymous-id>.*.json
  analysis/{aggregate,comparison,decision}
```

Every run records harness revision, model/settings, tool-prompt hashes, seed, environment, context transform, token estimates, policy, maintenance events, final status, and invalidation reason.

## Execution order

1. Freeze protocol, prompts, hidden tests, and rubric.
2. Capture S0.
3. Implement shared request core.
4. Audit boundary.
5. Capture S1, R, and T1.
6. Derive A/B/C/D contexts.
7. Assert filesystem/orchestration equality.
8. Run one pilot per condition.
9. Fix evaluator/harness defects only; never improve the report after outcomes.
10. Run randomized replicates.
11. Run hidden/static evaluation.
12. Blind-review final patches.
13. classify incidents before unblinding.
14. Compare results and apply decision rules.
15. Record actionable implementation/prompt changes.
16. Replicate with another task archetype if hybrid sealing wins.

## Knowledge target

The experiment must answer more than which arm scores highest. It should identify:

- whether productive phase sealing is viable;
- whether semantic report fields are sufficient;
- whether a manifest improves continuation or only auditability;
- which manifest facts agents actually need;
- when Shake is the safer default;
- which conditions should trigger keep instead of seal;
- whether compacted context improves trajectory independently of token savings.