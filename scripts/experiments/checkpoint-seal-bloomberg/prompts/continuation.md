<critical>
Continue from the supplied completed Phase 1 boundary. Do not use subagents. Never weaken, suppress, or skip required verification. Complete the implementation end to end.
</critical>

Continue the completed Phase 1 request workflow by exposing it through the CLI contract.

Reuse the existing request application layer. Do not introduce a second request validator, runner, result model, schema hash implementation, body loader, or error convention. Modify the core only when integration exposes a concrete behavioral defect, and add a regression test for that defect.

Implement `bbg request validate` and `bbg request send` according to the repository specification and executable command registry. `request validate` must support exactly one body source, offline `--schema-file` validation, adapter-backed discovery, strict/permissive diagnostics, operation schema hash, explicit local/population/server statuses, and no send mutation. `request send` must validate then execute through `BlpApiAdapter`, preserve every partial/final event and message boundary, include schema/identity metadata, and classify failure, timeout, and entitlement outcomes.

Add a narrow keyword-only adapter/stdin injection seam to dispatch for deterministic tests. Production behavior must still use the real adapter and process stdin by default. Do not expose a fake CLI flag.

Update command metadata to reflect the implemented surface. Preserve one-JSON stdout, existing envelopes/errors, registry exit codes, strict argument arity, and secret redaction.

Add deterministic command-level tests using `FakeBlpApiAdapter` for valid/invalid validation, strict/permissive handling, source conflicts, success, partial/final responses, request failure, timeout, no mutation after validation failure, command metadata, and stdout discipline.

Real Bloomberg networking, daemon request state, cancel/status, schema cache management, auth requests, subscriptions, and provider workflows are non-goals.

Run focused command tests, shared request-core tests, the offline regression suite, Ruff, basedpyright, and `ty check src`. Complete the implementation end to end.

<critical>
Finish only after every required behavior and check passes. Report observed failures exactly. Never call checkpoint, rewind, seal, or keep_checkpoint during this continuation.
</critical>
