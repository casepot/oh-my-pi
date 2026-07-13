<critical>
You MUST call `checkpoint` before reading or changing repository files. Use goal `Implement and verify the transport-independent Phase 1 request workflow core`. You MUST close it with `keep_checkpoint` only after every required contract passes. Do not use subagents.
</critical>

Implement the transport-independent Phase 1 transient request workflow core described by `BLOOMBERG_CLI_SPEC.md` sections 14.5 and 15.1–15.7.

End at a stable application-layer API. Do not wire request commands into `src/bloomberg_cli/cli.py` or alter command dispatch. Reuse the existing normalized schema generator, schema hash, adapter protocol, request/result records, policy decision, envelopes, errors, and fake adapter. Do not create parallel conventions.

Load a request body from exactly one JSON file, stdin, or inline JSON source. Require an object. Produce deterministic JSON Pointer validation diagnostics. Distinguish local schema validity, BLPAPI request-population validity, and server acceptance; local validation must never claim server acceptance. Support strict and permissive unknown-field handling and deprecated-field warnings. Validate and authorize policy before adapter mutation. Include the operation schema hash. Execute through `BlpApiAdapter`, preserving complete partial/final event and message boundaries, timeout/incomplete state, request-status failures, entitlement state, correlation identity, and Bloomberg request IDs.

Add deterministic contract tests for body-source behavior, validation boundaries, schema hash, successful and partial requests, request failure, timeout, stale correlation, entitlement partial status, and zero adapter mutation after validation/policy failure.

Real Bloomberg connectivity, CLI dispatch, daemon state, schema cache commands, authorization requests, subscriptions, and provider workflows are non-goals.

Run all required checks before closing the checkpoint:

1. Focused request-workflow tests.
2. `uv run pytest -q --ignore=tests/blp/test_real_adapter_versions.py --ignore=tests/security/test_live_probe_stubs.py`
3. `uv run ruff check --isolated` on every changed Python source and test file.
4. `uv run basedpyright --level error`
5. `uv run ty check src`

A failed check is evidence to diagnose. Correct in-scope implementation or typing defects at the source, add a behavioral regression test when appropriate, and rerun the affected checks. Do not suppress tests, weaken strictness, edit project configuration, or broaden scope. If an external blocker remains after investigation, call `keep_checkpoint` with the exact blocker and report it.

After every required check passes, mark the shared todo phase complete, call `keep_checkpoint` with the exact verification evidence, then respond exactly `SHARED_PHASE_COMPLETE`.

<critical>
No CLI integration. The checkpoint closes only after every shared-phase contract passes.
</critical>