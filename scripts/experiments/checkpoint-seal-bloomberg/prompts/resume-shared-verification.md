<critical>
You are on the original implementation checkpoint immediately before its blocker `keep_checkpoint`. Do not use subagents. Keep the scope to completing this shared request-core phase.
</critical>

The focused request tests and exact offline suite passed, and isolated Ruff plus basedpyright can pass with the experiment environment. `uv run ty check src` exposed eight typing diagnostics in `src/bloomberg_cli/request_workflow.py`, primarily invariant `list`/`dict` narrowing and the Bloomberg request-ID return type.

Fix those typing defects at the source without changing the established request behavior. You MAY edit `src/bloomberg_cli/request_workflow.py` and its focused tests only when a behavioral regression test is required. Do not touch CLI dispatch, command registry, unrelated modules, project configuration, or dependency files.

After the fix, run these required checks:

1. `uv run pytest -q tests/request/test_request_workflow.py tests/blp/test_fake_adapter_request_flows.py`
2. `uv run pytest -q --ignore=tests/blp/test_real_adapter_versions.py --ignore=tests/security/test_live_probe_stubs.py`
3. `uv run ruff check --isolated src/bloomberg_cli/request_workflow.py src/bloomberg_cli/blp/adapter.py src/bloomberg_cli/blp/fake.py tests/request/test_request_workflow.py tests/blp/test_fake_adapter_request_flows.py`
4. `uv run basedpyright --level error`
5. `uv run ty check src`

If all five pass, call `keep_checkpoint` with a precise reason naming the successful checks and then respond exactly `VERIFIED`.

If a check fails, diagnose and correct a shared-phase defect when it is in scope. If an external/pre-existing blocker remains after investigation, call `keep_checkpoint` with the exact blocker and report it.

<critical>
No CLI integration. The checkpoint closes only after every required shared-phase contract passes.
</critical>