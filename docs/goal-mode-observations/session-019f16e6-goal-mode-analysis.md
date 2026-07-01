# Goal-mode observations: session 019f16e6-fff1-7000-8861-dfaa83fca43b

Source transcript:

`/Users/case/.omp/agent/sessions/-projects-screen-observer/2026-06-30T05-01-05-393Z_019f16e6-fff1-7000-8861-dfaa83fca43b.jsonl`

Analyzed session objective:

> Screen Observer goal-mode run lasting about 15 hours and about 20M goal-accounted tokens. The user asked whether the session had done meaningful implementation work or regressed into proof/evidence theater, and where that pressure was coming from.

## Executive read

The user's complaint is materially supported, but the strongest version is not "nothing happened." The transcript records real implementation work and four committed target slices. The problem is that goal mode made "accepted evidence-backed target closure" the dominant unit of progress, so product behavior, acceptance harnesses, schema artifacts, matrices, reviews, checkpoint packets, non-claims, docs, and compaction summaries all became co-equal parts of "shipping."

Observed product work did happen:

- Target 1 committed `32691b4`: Codex can see/install/use four Screen Observer product MCP profiles.
- Target 2 committed `74db4cc`: Product/default can answer current/recent/activity/change questions with evidence and policy-safe readback.
- Target 3 committed `edfd2e6572cb244464dffd8b60b71b9ef735acad`: review/control trust repair mutations update Product/default readback.
- Target 4 committed `798a0b7`: product health/doctor/repair handles a narrow local blob/FTS readiness drift slice.

The value/efficiency concern is still valid. Four target closures consumed 19,624,422 goal-accounted tokens and 53,281 seconds of goal-accounted time. Final state still had the parent active/paused with only 1 of 9 deliverables satisfied, 4 partial, and 4 pending. Major parent outcomes remained unshipped: fresh live inspection, first safe LiveAction/after-state, Swift UI parity, broader broker/profile readiness, and release/TCC/onboarding readiness.

The primary pressure source is not one bad prompt or one bad target title. It is a stack of hard mechanics:

1. Every target entered `planning-target` before implementation.
2. Target-plan payloads were evidence graphs, not compact execution contracts.
3. Product/e2e verification signals pushed all four plans into `trust-heavy`.
4. Plan-review evidence was machine-validated.
5. Lint made scenario matrices, branch evidence, target cards, dry runs, and Markdown/payload agreement salient work.
6. Approved-plan execution contexts kept verification/evidence guardrails in front of the executor.
7. Checkpoints defined closure as claims/evidence/checks/artifacts/non-claims.
8. Compactions repeatedly rehydrated evidence-heavy summaries.
9. Checkpoint resolution permitted locally valid target chaining without forcing enough parent-deliverable movement.
10. Proof-first wording compounded the behavior, especially Target 4, but was not the root cause by itself.

Goal mode already contains product-first language and anti-ledger warnings. Those were weaker than the hard schema/lint/review/checkpoint gates.

## Transcript shape

Observed session scale:

- 11,034 JSONL records.
- Session span: `2026-06-30T05:01:05.393Z` through `2026-06-30T20:16:13.527Z`, about 15h15m08s elapsed.
- Final goal usage: 19,624,422 tokens and 53,281 seconds at line 11019.
- File size: 580,430,863 bytes.
- 6,327 `message` events.
- 2,825 `goal_usage_delta` events.
- 638 `goal_state_snapshot` events.
- 638 `mode_change` events.
- 324 `custom_message` events.
- 211 `custom` events.
- 60 `compaction` events.

Goal/process storage dominated the transcript:

| Event type | Bytes | Share |
| --- | ---: | ---: |
| `goal_state_snapshot` | 317,186,959 | 54.6% |
| `compaction` | 150,697,339 | 26.0% |
| Snapshots + compactions | 467,884,298 | 80.6% |
| `message` | 109,772,922 | 18.9% |

Tool-call counts observed in assistant messages:

| Tool | Calls |
| --- | ---: |
| `read` | 1,371 |
| `bash` | 742 |
| `grep` | 430 |
| `edit` | 265 |
| `job` | 166 |
| `irc` | 134 |
| `todo` | 96 |
| `eval` | 90 |
| `goal` | 68 |
| `lsp` | 54 |
| `task` | 24 |
| `glob` | 12 |
| `write` | 4 |
| `report_tool_issue` | 4 |
| `ast_edit` | 1 |
| `resolve` | 1 |

Goal-tool operation counts:

| Goal op | Calls |
| --- | ---: |
| `get` | 29 |
| `lint_target_plan` | 16 |
| `target_plan_schema` | 7 |
| `resolve_checkpoint` | 7 |
| `submit_target_plan` | 4 |
| `checkpoint` | 4 |
| `start_target` | 1 |

The goal-tool pattern was repetitive and clear: get state, plan, lint, review, approve, execute, checkpoint, resolve, repeat.

## Goal lifecycle timeline

All four targets ended as `trust-heavy` plans and `closed_with_evidence` checkpoints.

| Target | Title | Planning start | Plan approved / working start | Checkpoint accepted | Planning time | Working/checkpoint time |
| --- | --- | --- | --- | --- | ---: | ---: |
| T1 | Make Codex see four product MCP profiles | line 67, `05:07:10` | line 190, `05:21:59` | line 1477, `06:54:56` | about 15m | about 93m |
| T2 | Make Product/default answer daily current/recent/change questions with evidence | line 1494, `06:58:37` | line 1897, `08:13:16` | line 6255, `14:07:26` | about 75m | about 354m |
| T3 | Make review/control trust repair mutations update Product/default readback | line 6270, `14:08:36` | line 6745, `15:07:34` | line 9704, `18:08:49` | about 59m | about 181m |
| T4 | Prove product health can diagnose and repair local readiness drift | line 9720, `18:10:05` | line 9869, `18:27:17` | line 10994, `19:53:30` | about 17m | about 86m |

Run-mode progression by target was effectively:

```text
planning-target
  -> working-target
  -> awaiting-checkpoint-resolution
  -> planning-target / next target
  -> ...
  -> awaiting-user-input / goal_paused after Target 4
```

Checkpoint resolutions:

- T1 resolution: `next_target`; parent frame advanced to version 1.
- T2 resolution: `next_target`; parent frame advanced to version 2.
- T3 resolution: `next_target`; parent frame advanced to version 3.
- T4 resolution: `pause_for_external_control`; parent frame advanced to version 4.

No parent completion attempt occurred. No completion verifier accepted the parent.

## Target 2 as the main sink

Target 2 dominated the run.

Observed Target 2 pressure:

- About 75 minutes planning before approved execution.
- About 354–355 minutes execution/checkpoint time.
- About 13.65M to 13.67M goal-accounted tokens depending exact boundary parsing, roughly 70% of the full session.
- 40 compactions between plan approval and checkpoint in one parse; 43 related compaction boundary audits in another parse.
- Dense compaction storm: 15 compactions in about 35m37s around lines 3960–4383.
- Target 2 plan Markdown: 22,165 bytes / 274 lines.
- Target 2 payload JSON: 72,361 bytes / 1,227 lines.
- Current `scripts/codex_target2_acceptance.py`: 71,777 bytes / 1,773 lines.
- Target 2 checkpoint: 23 checks run and 18 artifacts touched.

Target 2 was product-relevant. Product/default answering current/recent/activity/change questions is the clearest user-facing capability in the session. But the target title included "with evidence," and the plan/checkpoint machinery turned the answer loop into a broad proof surface: freshness, coverage, uncertainty, policy, provenance, evidence refs, accepted memory context, denied/deleted/unavailable/empty/stale branches, schema agreement, readback tools, memory/deletion support, docs, matrix, and acceptance artifacts.

Interpretation: Target 2 shipped value, but it also became the evidence flywheel's center of mass.

## What implementation work happened

This observation does not independently verify git history. The implementation evidence below is from session logs, checkpoint summaries, command output, and changed-file references in the transcript.

### Target 1: product MCP profiles

Recorded commit: `32691b4`.

Claimed behavior:

- Codex sees four Screen Observer product MCP profiles.
- Product/default read-only/action-free inventory is visible.
- `tools/list` and schema agreement work across profiles.
- Product/default health/current/observation/live runtime surfaces are callable.
- Broker grant reload happens after install without app restart.
- Real local Codex config validates `product_default`.

Representative touched artifacts:

- `apps/screen-observer-mac/Sources/ScreenObserverApp/AppModelBrokerControls.swift`
- `apps/screen-observer-mac/Sources/ScreenObserverIPC/BrokerGrantStore.swift`
- `apps/screen-observer-mac/Tests/ScreenObserverAppTests/AppModelBrokerLifecycleTests.swift`
- `apps/screen-observer-mac/Tests/ScreenObserverIPCTests/BrokerGrantStoreTests.swift`
- `crates/screen-observer-agent/src/mcp_install.rs`
- `crates/screen-observer-agent/tests/product_cli_mcp_install.rs`
- `scripts/codex_target1_acceptance.py`
- `target/codex-acceptance/direct-product-path-smoke.json`
- `target/codex-acceptance/target-1-local-install-mcp.txt`
- `/Users/case/.codex/config.toml`

Product-value read: real prerequisite value, low immediate end-user visibility. It made later Product/default MCP use possible.

### Target 2: Product/default daily answers

Recorded commit: `74db4cc`.

Claimed behavior:

- Product/default answers current/recent/activity/change questions.
- Answers expose evidence-backed metadata: freshness, coverage, uncertainty, policy, provenance, evidence refs, accepted memory context.
- Product/default readback covers search/read evidence, policy explanation, deletion manifest, and memory list/search/read.
- Denied/deleted/unavailable/empty/stale branches fail closed.
- Schemas omit internal identifiers and raw next-tool drilldown.
- MCP-only acceptance artifact summarizes answer/readback results.

Representative touched artifacts:

- `crates/screen-observer-agent/src/current_context.rs`
- `crates/screen-observer-agent/src/evidence_read.rs`
- `crates/screen-observer-agent/src/mcp.rs`
- `crates/screen-observer-agent/src/mcp_server.rs`
- `crates/screen-observer-agent/src/mcp_install.rs`
- `crates/screen-observer-agent/src/memory_records.rs`
- `crates/screen-observer-agent/src/deletion.rs`
- `crates/screen-observer-agent/src/policy_explain.rs`
- `crates/screen-observer-agent/src/work_reconstruction.rs`
- `schemas/mcp/recent_observed_context_response.schema.json`
- `schemas/mcp/profiles/product.schema-manifest.json`
- `schemas/mcp/profiles/dev-control.schema-manifest.json`
- `scripts/codex_target2_acceptance.py`
- `target/codex-acceptance/target-2-product-default-daily-mcp.txt`
- `target/codex-acceptance/target-2-direct-setup-smoke.json`
- `CHANGELOG.md`
- `docs/spec-aligned-development-roadmap.md`
- `fixtures/product_scenarios/phase11_matrix.json`

Product-value read: strongest shipped product value in the session. Also the largest proof/provenance expansion.

### Target 3: trust repair readback

Recorded commit: `edfd2e6572cb244464dffd8b60b71b9ef735acad`.

Claimed behavior:

- Review/control MCP tools perform evidence correction, targeted deletion with freshness, deletion-manifest listing, and source-actor-aware memory review.
- Product/default hides mutation/control tools and fails closed on hidden direct calls.
- Product/default readback reflects authorized corrected/deleted/memory state.
- Deleted/rejected/superseded/correction-review payloads do not hydrate through Product/default.
- Stale review-control scope filters and unsupported persisted payload constraints fail readiness.

Representative touched artifacts:

- `crates/screen-observer-agent/src/deletion.rs`
- `crates/screen-observer-agent/src/evidence_correction.rs`
- `crates/screen-observer-agent/src/mcp.rs`
- `crates/screen-observer-agent/src/mcp_install.rs`
- `crates/screen-observer-agent/src/mcp_server.rs`
- `crates/screen-observer-agent/src/memory_records.rs`
- `crates/screen-observer-agent/src/schema.rs`
- `crates/screen-observer-agent/src/scope_registry.rs`
- `crates/screen-observer-agent/tests/deletion.rs`
- `crates/screen-observer-agent/tests/mcp_stdio.rs`
- `crates/screen-observer-agent/tests/memory_records.rs`
- `crates/screen-observer-agent/tests/phase11_policy_graph_memory_trust.rs`
- `crates/screen-observer-agent/tests/product_cli_mcp_install.rs`
- `crates/screen-observer-agent/tests/schema_contract.rs`
- multiple schema artifacts under `schemas/ledger` and `schemas/mcp`
- `scripts/codex_target3_trust_repair_acceptance.py`
- `target/codex-acceptance/target-3-trust-repair-mcp.txt`
- `target/codex-acceptance/target-3-direct-setup-smoke.json`
- `CHANGELOG.md`
- `docs/spec-aligned-development-roadmap.md`
- `fixtures/product_scenarios/phase11_matrix.json`

Product-value read: real trust/safety infrastructure, but less directly visible than daily answers. It broadened the trusted correction/deletion/memory contract family.

### Target 4: product health repair

Recorded commit: `798a0b7`.

Claimed behavior:

- Product doctor emits a `ProductEnvelope`-wrapped `DoctorReport` for the product data root.
- Doctor reports blob/FTS degraded storage before repair.
- Repair commands are narrowed to blobs and FTS.
- Product repair requires exactly one of `--dry-run` or `--apply`.
- No-flag, conflict, backup, and unselected-component cases are blocked/non-mutating.
- Apply repairs missing/tampered available blob state and stale/deleted FTS state.
- Maintenance authority/provenance stays outside logical scopes.
- FTS consistency check fails closed on query errors.
- Product/default remains read-only/action-free.
- Deleted FTS marker content does not hydrate through supported Product/default surfaces.

Representative touched artifacts:

- `crates/screen-observer-agent/src/product_cli.rs`
- `crates/screen-observer-agent/src/health.rs`
- `crates/screen-observer-agent/src/repair.rs`
- `crates/screen-observer-agent/tests/product_cli_mcp_install.rs`
- `scripts/codex_target4_health_repair_acceptance.py`
- `fixtures/product_scenarios/phase11_matrix.json`
- `docs/spec-aligned-development-roadmap.md`
- `CHANGELOG.md`
- `target/codex-acceptance/target-4-health-doctor.txt`
- `target/codex-acceptance/target-4-health-repair-product-smoke.json`

Visible late diff-stat near line 10861:

- 7 files changed.
- +1371 / -93.
- `crates/screen-observer-agent/src/health.rs`: 127 changed lines.
- `crates/screen-observer-agent/src/product_cli.rs`: 379 changed lines.
- `crates/screen-observer-agent/src/repair.rs`: 24 changed lines.
- `crates/screen-observer-agent/tests/product_cli_mcp_install.rs`: 846 changed lines.

Product-value read: real but narrow. It proves isolated blob/FTS storage repair while fresh live inspection, LiveAction, Swift UI parity, broader MCP/profile/broker readiness, and release/TCC readiness remained unclaimed.

## Proof/process versus product proxies

These proxies are imperfect because snapshots and compactions repeat the same context, and many commands are both product and proof. Still, the pattern is useful.

Edit/write path occurrences by category:

| Category | Occurrences |
| --- | ---: |
| Product source | 106 |
| Test code | 67 |
| Acceptance scripts | 64 |
| Fixture data | 5 |
| Docs/changelog | 13 |
| Goal plan/payload artifacts | 12 |
| Other code | 15 |

Interpretation: product code changed materially, but tests/acceptance/fixtures together outnumbered product-source edit/write occurrences.

Bash command classification:

- 742 bash calls total.
- 236 `cargo test` calls.
- 72 `cargo fmt` calls.
- 30 `cargo check` calls.
- 4 git commit calls.
- 86 git inspection calls.
- 369 product/e2e command mentions.

Interpretation: verification and product execution were both frequent, but the command stream was heavily gate/check oriented.

Checkpoint packet totals:

| Checkpoint packet field | Total across 4 checkpoints |
| --- | ---: |
| Local claims | 27 |
| Evidence items | 26 |
| Checks run | 74 |
| Artifacts touched | 79 |
| Not-claimed entries | 29 |

This is the user-visible feeling of proof theater: each target closure produced a substantial evidence bundle, not just a product delta.

## Checkpoint packet density by target

| Target checkpoint | Claims | Evidence items | Checks run | Artifacts touched | Not-claimed | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| T1 | 9 | 6 | 15 | 10 | 7 | Product profile setup + acceptance |
| T2 | 6 | 6 | 23 | 18 | 8 | Daily answers + readback + schema/docs/matrix |
| T3 | 6 | 7 | 25 | 40 | 10 | Trust repair + many schema artifacts |
| T4 | 6 | 7 | 11 | 11 | 4 | Local blob/FTS repair proof |
| Total | 27 | 26 | 74 | 79 | 29 | — |

The checkpoint schema made this shape predictable: closure required claims, evidence, checks, artifacts, non-claims, and remaining questions.

## Side-agent and review churn

Observed:

- 24 `task` tool calls.
- 65 total subagents.
- About 36–40 reviewer-like subagents depending classification.
- 7 scout-like agents.
- 16 workstream-like implementation tasks.
- 221 custom `advisor` messages.
- 128 `agent-ref` custom events.
- 46 incoming IRC messages.

Examples of review/plan pressure:

- Target 1 planning spawned aperture and execution-plan reviewers.
- Target 2 planning spawned scouts for answer assembly, evidence support, and acceptance harnesses, then workstreams for integrated cutover, answer assembly, evidence/policy/memory, schema/profile boundary, and verification.
- Target 3 planning spawned aperture, authority, and execution reviews, then later final MCP/proof/deletion reviews.
- Target 4 spawned implementer/tester/ledger roles and post-work reviewers.

Interpretation: review churn was not just behavioral caution. Planning prompt and runtime lint made accepted review evidence part of plan validity, especially for `trust-heavy` plans.

## Compaction and context pressure

Observed:

- 60 compactions.
- Compaction byte total: 150,697,339 bytes.
- Goal snapshots + compactions: 80.6% of JSONL bytes.
- T2 had the compaction storm: about 40 compactions between plan approval and checkpoint.
- Largest JSONL lines were about 4.7MB.
- Assistant usage context prompt tokens: min 40,282; average 136,421.6; max 204,063.
- Context maintenance failures appeared around estimated 206k–212k token contexts:
  - line 2107: branch changed before compaction could be appended for estimated 211,999 token context.
  - line 10727: no compaction appended for estimated 207,580 token context.
  - line 11022: no compaction appended for estimated 206,397 token context.

Large injected context surfaces:

- `goal-mode-context`: 8 messages, total 476,774 chars, max 77,699 chars.
- `goal-continuation`: 74,604 chars.
- `goal-target-planning`: 33,908 chars.
- Large context lines included 77,699 chars at line 2111, 74,604 chars at line 2112, and 71,557 chars at line 10449.

Boundary audits reported no mismatches. That matters: this does not look like the earlier narrowing/loss failure mode where parent goal state became unrecoverable. The failure mode here is bloat/replay. Compaction preserved continuity, but it also repeatedly reintroduced evidence/ledger/review state as current context.

Interpretation: compaction summaries acted like a positive-feedback loop. Evidence-heavy summaries became future context; future actions then optimized for satisfying evidence-heavy context.

## Goal-mode mechanics causing proof pressure

### 1. Mandatory target planning before implementation

Observed code/prompt semantics:

- `startTarget` enters target planning through `#beginTargetPlanning`.
- `resolve_checkpoint` with `decision: next_target` also enters target planning.
- `goal-target-planning.md` says implementation is blocked until approval.
- The planning prompt forbids implementation while planning.

Session correlation:

- Every target entered `planning-target` before working execution.
- Four targets produced four approved plans and four plan-approval context resets.
- Planning alone consumed about 168 minutes and about 1.5M tokens across targets.

Interpretation: the default product-progress path was not "pick target and build." It was "pick target, write plan, write payload, look up schema, run review, lint, repair, approve, then build."

### 2. Target-plan payloads were evidence graphs

Required payload fields included:

- `verification_aperture`
- `verification_signals`
- `concern_checks`
- `scope_calibration`
- `branch_evidence`
- `excluded_work_review`
- `target_plan_reviews`
- `dry_run`
- `scenario_matrix`
- `target_card`

The minimal schema reference itself includes a multi-object graph: target card, scenario matrix, verification signals, concern checks, branch evidence, excluded work review, plan reviews, and dry run.

Interpretation: even a modest implementation target had to be expressed as a proof topology before code started.

### 3. Product/e2e work became `trust-heavy`

`targetPlanNeedsTrustHeavy()` forces trust-heavy for external/irreversible blast radius, security concerns, or product/e2e verification signals.

All four Screen Observer targets were `trust-heavy`. For a product like Screen Observer, product/e2e verification is not exceptional; it is the normal way to verify product behavior. The current rule therefore makes heavy planning the normal path.

Interpretation: product/e2e should not automatically imply trust-heavy. Local product behavior with focused e2e acceptance can be `standard` unless it crosses external, irreversible, security, destructive, or privacy-authority boundaries.

### 4. Plan review evidence was hard-gated

Prompt/runtime pressure:

- Planning prompt requires aperture and execution-readiness reviews before submit.
- It requires explicit review evidence.
- Payload/state stores `target_plan_reviews` with lens/status/findings/source/revised-after-review metadata.
- Runtime lints missing aperture or execution-readiness review.
- Runtime lints review target/revision mismatch and stale accepted reviews.
- Standard/trust-heavy plans need subagent source metadata.

Session correlation:

- 65 spawned subagents.
- Many reviewer roles.
- T3 required seven lint calls before approval.

Interpretation: the agent optimized for review convergence because review convergence was part of validity.

### 5. Lint turned schema/matrix/Markdown into work

Observed lint loops:

- Target 1: 3 lint calls; first blocked with 2 errors.
- Target 2: 3 lint calls; first blocked with 33 errors and 23 warnings.
- Target 3: 7 lint calls; multiple blocked states, including 11 errors and 12 warnings before later success.
- Target 4: 3 lint calls; one blocked state had 4 errors and 17 warnings.

Lint/code mechanics included:

- required `plan_depth` and `target_card`;
- scenario matrix required for non-light/modern plans;
- branch evidence linked to scenario matrix rows;
- target card fields for capability claim, user-visible surface, acceptance rows, verification scenarios, checkpoint evidence;
- trust-heavy trust/privacy/authority/policy fields;
- dry-run passing before approval.

Interpretation: lint protected against under-specified plans, but it also made planning conformance a major workstream.

### 6. Approved-plan execution context foregrounded proof

After plan approval, execution guidance required:

- execute approved plan;
- satisfy every required verification signal;
- integrate or replace workstreams;
- run code review;
- checkpoint only after closure evidence;
- keep going until accepted checkpoint.

Runtime execution summaries and guardrails carried:

- verification aperture;
- required signals;
- review lenses;
- branch evidence;
- acceptance rows;
- checkpoint evidence;
- stale conditions;
- task batch scaffold;
- excluded work;
- forbidden claims;
- known limits.

Observed approved-plan developer context sizes:

| Target | Developer context size |
| --- | ---: |
| T1 | 31,296 chars |
| T2 | 50,837 chars |
| T3 | 52,971 chars |
| T4 | large approved-plan context near line 9877 |

Interpretation: implementation started from an evidence graph, not a compact code seam and acceptance path.

### 7. Checkpoints were evidence-first

Checkpoint operation required:

- `status: closed_with_evidence`;
- `summary`;
- non-empty `local_claims`;
- non-empty `evidence`;
- non-empty `not_claimed`;
- non-empty `remaining_questions`.

Checkpoint reviewer prompt checked target claim, closure standard, current evidence, not-claimed boundaries, verification freshness, and workstream completeness.

Interpretation: a target was not done until converted into a claims/evidence/checks/artifacts/non-claims packet. That is useful anti-overclaiming, but it made evidence the completion currency.

### 8. Parent/target separation was correct but weakly tied to deliverable progress

Goal mode correctly prevented target checkpoints from completing the parent. The problem is target chaining: four locally valid target closures left the parent with only 1 of 9 deliverables satisfied.

Interpretation: "smallest product-meaningful target" needs a counterweight: each target should predict and then record a meaningful parent-deliverable status delta. After multiple accepted targets with weak deliverable movement, the controller should force a broader parent-gap target.

### 9. `pause_for_external_control` was allowed even when prompts discourage generic pause

After Target 4, the agent chose `pause_for_external_control`. Prompts discourage using pause just because work remains, but schema/runtime allow the enum and create a blocked/awaiting-user state.

Interpretation: if pause requires external authority, unavailable credentials, device access, or destructive approval, that should be structural. Otherwise the controller should continue to next target or parent completion candidate.

### 10. Proof-first title language compounded the issue

Only Target 4 started with "Prove," but proof pressure existed in T1-T3 too.

Target titles:

1. `Make Codex see four product MCP profiles`
2. `Make Product/default answer daily current/recent/change questions with evidence`
3. `Make review/control trust repair mutations update Product/default readback`
4. `Prove product health can diagnose and repair local readiness drift`

Interpretation: banning proof-first titles helps, but it is insufficient. The hard gates still reward proof readiness.

## Countervailing product-first semantics already present

The repo already contains good product-first guidance:

- Targets should be product-meaningful, not process phases.
- Same primary signal should stay together.
- Avoid tiny plumbing/schema-only slices.
- Planning should write executor decisions, not design docs.
- A `no-process-phase` target-unit rule exists.
- Excluded essential related work can be linted.
- Roadmaps, scenario matrices, changelogs, and acceptance artifacts are described as ledgers, not product intent.
- Compaction prompts say overflow/recovery is not checkpoint evidence.
- Checkpoint guidance says next target must be product-meaningful.

Why this did not win: these are softer than the hard schema/lint/review/checkpoint gates. Hard gates validated proof readiness. Product-first language existed, but it was not the primary validation surface.

## Product-value assessment

### What did ship

Session evidence supports four real product/foundation slices:

1. Codex can see/install/use Screen Observer MCP product profiles.
2. Product/default can answer current/recent/activity/change questions with evidence/readback.
3. Review/control can mutate trust state, and Product/default can read back safe effects.
4. Product CLI can diagnose/repair one class of local blob/FTS storage drift.

### What did not ship

Final state and checkpoint non-claims left these unresolved:

- Parent completion.
- Fresh live inspection payload.
- First safe LiveAction execution and after-state.
- Swift UI parity.
- Broader profile/broker readiness.
- Release/TCC/onboarding/uninstall readiness.
- Full app-owned product path parity.

Product-progress read: medium for foundational local MCP/Product-default readback capability; low-to-medium for visible Screen Observer alpha progress.

## Where target shape left value on the table

### Target 1

Before:

> Make Codex see four product MCP profiles

Better:

> Make a fresh Codex session install Screen Observer and ask Product/default what is happening now.

Why: profile visibility becomes the means, not the product outcome. Install/status/schema proof stays as acceptance criteria.

### Target 2

Before:

> Make Product/default answer daily current/recent/change questions with evidence

Better:

> Make Product/default answer "what am I doing now, what happened recently, and what changed?" in one fresh Codex MCP session.

Why: daily answers remain the product behavior. Evidence/readback becomes acceptance, not the target noun.

### Target 3

Before:

> Make review/control trust repair mutations update Product/default readback

Better:

> Let Codex remove one bad evidence item and show the daily answer stops relying on it.

Why: connects trust repair directly to answer quality and narrows the mutation family while preserving safety proof.

### Target 4

Before:

> Prove product health can diagnose and repair local readiness drift

Better local-repair version:

> Make `product doctor` fix one local blob/FTS storage blocker and tell Codex what changed without exposing raw data.

Better parent-value version:

> Make fresh live inspection return one current Screen Observer observation through the staged app-owned broker.

Why: the second version attacks a higher-value unresolved parent gap.

## Highest-impact tuning levers

### 1. Add a direct-execution/light-target path

Current behavior: every target goes through planning and approval before implementation.

Change:

- Allow `start_target` / `resolve_checkpoint.next_target` to enter `working-target` directly with a compact `execution_brief` for low/standard-risk product slices.
- Keep full target-plan mode for trust-heavy, external/irreversible, security/privacy, multi-workstream, or ambiguous same-signal targets.

Compact execution brief fields:

- target title;
- product behavior delta;
- user-visible surface;
- implementation owner paths;
- one acceptance path;
- one or two risks;
- stale-if condition;
- top non-claims.

Expected effect: small product slices stop spending 15–75 minutes in plan/payload/review/lint loops before code.

### 2. Stop promoting ordinary product/e2e to `trust-heavy`

Current behavior: product/e2e verification signals can force trust-heavy.

Change: `trust-heavy` should require a real high-risk dimension:

- external or irreversible blast radius;
- security-sensitive behavior;
- privacy boundary change involving real user data exposure/mutation;
- durable destructive state mutation;
- release/public distribution;
- high-blast-radius authority expansion.

Product/e2e alone should usually be `standard` with focused verification.

Expected effect: most normal Screen Observer product work no longer takes the maximum ceremony path.

### 3. Make product behavior delta the primary schema gate

Add first-class fields:

- `product_behavior_delta`
- `user_value_delta`
- `user_visible_surface`
- `before_product_state`
- `after_product_state`
- `implementation_surface`
- `parent_deliverable_delta`

Lint should fail if:

- title/capability claim is proof/ledger/schema/harness-first;
- product behavior delta is empty;
- main workstreams are docs/changelog/matrix/acceptance only;
- checkpoint claims stronger proof artifacts than product behavior.

Expected effect: evidence supports product behavior instead of replacing it.

### 4. Collapse review requirements by default

Current behavior: aperture and execution-readiness review evidence is expected and validated for heavy plans.

Change:

- Default to one combined plan reviewer or one local structured checklist for standard targets.
- Extra reviewers require a unique named product-failure mode.
- Schema-only fixes do not invalidate reviews.
- Review stale rules apply only to semantic plan changes.

Expected effect: fewer review farms; less plan-lint/review oscillation.

### 5. Split lint into blockers and advisories

Block only:

- missing product behavior delta;
- missing implementation owner;
- impossible acceptance;
- false parent claim;
- missing safety review for actual high risk;
- branch/scope split that loses essential work.

Advisory only:

- Markdown heading shape;
- docs/changelog mention;
- workstream file mention;
- review prose formatting;
- non-semantic schema repairs.

Expected effect: lint protects execution correctness without inducing document polishing.

### 6. Move proof-dominance detection into checkpoint review

Add checkpoint reviewer fields:

- `productDeltaChecked`
- `userVisibleAcceptanceChecked`
- `implementationEvidenceBalance`
- `proofArtifactRisk`
- `artifactMix`
- `parentDeliverableDeltaChecked`

Reviewer should warn or reject when:

- product code/API/UI/storage delta is weak;
- acceptance/docs/schema/ledger dominate changed artifacts;
- summary starts with proof rather than behavior;
- no parent deliverable moved.

Expected effect: over-proofed targets are caught before acceptance, not diagnosed afterward.

### 7. Shrink checkpoint packets

Current checkpoint packets require many prose arrays.

Change:

- Summary starts with product behavior now usable.
- Evidence uses refs/artifacts, not repeated prose.
- `not_claimed` is capped to top 3 parent-risk non-claims; runtime inserts defaults.
- `remaining_questions` is optional unless it blocks next target.
- Claims are behavior claims, not artifact claims.
- Checks are grouped by behavior/invariant unless exact commands matter.

Expected effect: checkpoint remains truthful without becoming the product story.

### 8. Change compaction continuation format

Current compaction summaries carry evidence/ledger/review state forward heavily.

New continuation packet order:

1. `current_product_delta_done`
2. `next_code_seam`
3. `next_command_or_file`
4. `verification_stale_if`
5. `blocked_by`
6. `do_not_reopen`
7. `evidence_refs`
8. `ledger_refs`

Hard rules:

- Deduplicate stable evidence after first compaction.
- Store artifact references, not repeated prose lists.
- Omit full scenario matrix unless actively editing it.
- Omit full checkpoint packet unless resolving/checkpointing.
- Debounce snapshot/compaction detail when boundary audit is clean and goal state did not materially change.

Expected effect: post-compaction work resumes from a code/product seam, not an evidence graph.

### 9. Rank next target by parent-deliverable impact

At checkpoint resolution, require:

- candidate next targets;
- predicted parent deliverable delta;
- why this target beats more user-visible remaining gaps;
- why parent completion is not candidate;
- whether previous accepted targets moved deliverables enough.

Rule:

> A next target must retire meaningful parent uncertainty, not merely produce another valid proof slice.

Expected effect: after several target closures with low deliverable satisfaction, the controller forces a broader or more user-visible parent-gap target.

### 10. Ban proof-first target titles and capability claims

Lint target title and capability claim against dominant proof/process verbs unless the target is explicitly verifier-repair.

Disallowed as primary phrasing:

- `Prove`
- `Verify`
- `Validate`
- `Demonstrate`
- `Show evidence`
- `Acceptance`
- `Schema agreement`
- `Ledger`
- `Readback`, unless readback itself is the user-visible product behavior

Preferred forms:

- `Make <product behavior> usable through <surface>`
- `Let <actor> do <user-visible action>`
- `Repair <real blocker> so <product path> works`

Expected effect: proof remains in verification signals instead of becoming the target.

### 11. Put acceptance harnesses on a budget

Observed current acceptance script sizes:

| Script | Size / lines |
| --- | ---: |
| `scripts/codex_target1_acceptance.py` | 53,641 bytes / 1,397 lines |
| `scripts/codex_target2_acceptance.py` | 71,777 bytes / 1,773 lines |
| `scripts/codex_target3_trust_repair_acceptance.py` | 69,750 bytes / 1,657 lines |
| `scripts/codex_target4_health_repair_acceptance.py` | 62,676 bytes / 1,452 lines |

Change:

- One externally observable acceptance path per target by default.
- Explicit branch budget per target.
- Large scripts must split reusable harness helpers from scenario scripts.
- Fail-closed branches belong in focused unit/integration tests unless they are externally observable contract branches.

Expected effect: acceptance proves behavior without becoming the largest artifact.

### 12. Make `pause_for_external_control` structurally hard to misuse

Change schema/runtime so `pause_for_external_control` requires one of:

- explicit external authority/user input reference;
- unavailable credential/device/API;
- destructive next step requiring user approval.

Otherwise require:

- `next_target`;
- `parent_completion_candidate`;
- or `needs_user_input` with an exact question.

Expected effect: goal mode keeps moving when parent work remains and no external authority is actually needed.

## Suggested implementation order

1. Change `targetPlanNeedsTrustHeavy()` so product/e2e alone does not force trust-heavy.
2. Add product behavior delta fields and proof-dominance checks to plan/checkpoint schema.
3. Add direct-execution/light-target path for standard low-risk product slices.
4. Tier plan reviews by risk and stop invalidating reviews after schema-only fixes.
5. Split lint diagnostics into submit blockers and advisories.
6. Reorder/deduplicate compaction continuation packets around product delta and next code seam.
7. Harden `pause_for_external_control`.
8. Add proof-first title/capability lint.
9. Add parent-deliverable impact ranking for next target selection.
10. Add acceptance harness budget guidance.

The first two changes likely provide the highest immediate leverage because they change hard validation surfaces. Prompt wording alone is unlikely to overcome current schema/lint/runtime incentives.

## Better checkpoint report shape

A product-first checkpoint should read like this:

```markdown
Product behavior now usable:
- Product/default can answer current/recent/change questions in a fresh Codex MCP session.

Owned code paths:
- crates/screen-observer-agent/src/current_context.rs
- crates/screen-observer-agent/src/mcp_server.rs
- crates/screen-observer-agent/src/evidence_read.rs

User-visible acceptance:
- Fresh MCP run asked current/recent/change and got evidence-cited answers.

Safety boundaries:
- Deleted/denied evidence fails closed.
- Product/default exposes no mutation tools.

Verification refs:
- target/codex-acceptance/target-2-product-default-daily-mcp.txt
- focused cargo tests: ...

Not claimed:
- Live inspection not done.
- LiveAction not done.
- UI parity not done.

Next highest-value parent gap:
- Fresh live inspection through staged app-owned broker.
```

This still preserves evidence and non-claims, but it answers the product question first.

## What not to do

Do not remove verification wholesale. Screen Observer has real trust, privacy, and authority boundaries. Evidence matters.

Do not rely on prompt edits alone. Product-first prose already exists; hard gates currently reward proof readiness.

Do not only ban `Prove` in target titles. Target 4 makes the title problem obvious, but T2 and T3 were proof-heavy without starting with `Prove`.

Do not blame changelog/roadmap alone. Docs and ledgers contributed, but the root stack is target planning, schema, lint, review validation, checkpoint schema, and compaction replay.

Do not make every target `light`. Use risk-based depth: local product behavior can be standard; external/irreversible/security/destructive/privacy-authority changes should stay trust-heavy.

## Final diagnosis

The session optimized for safe, auditable target closure more strongly than for visible product throughput. It did ship code, but the closure economy made proof artifacts and product changes co-equal. Compaction then repeatedly replayed that proof frame.

The highest-impact fix is to make product behavior delta the hard primary gate and make heavy proof/review planning conditional rather than the default for product/e2e work.
