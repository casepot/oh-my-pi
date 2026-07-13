from __future__ import annotations

import hashlib
import inspect
import io
import json
from pathlib import Path
from typing import Any, Iterator

import pytest

from bloomberg_cli.blp.fake import FakeBlpApiAdapter
from bloomberg_cli.cli import dispatch, main, parse_args
from bloomberg_cli.errors import CliError
from bloomberg_cli.schema.json_schema import operation_input_schema
from bloomberg_cli.schema.normalized import sample_reference_data_operation

pytestmark = pytest.mark.tier1_offline_with_blpapi

SERVICE = "//blp/refdata"
OPERATION = "ReferenceDataRequest"
VALID_BODY = {"securities": ["IBM US Equity"], "fields": ["PX_LAST"]}
OFFLINE_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "bbg://hidden-tests/reference-data.request.v1",
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "securities": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "fields": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "returnEids": {"type": "boolean"},
    },
    "required": ["securities", "fields"],
}


def _walk(value: Any) -> Iterator[Any]:
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list | tuple):
        for child in value:
            yield from _walk(child)


def _dicts(value: Any) -> Iterator[dict[str, Any]]:
    for item in _walk(value):
        if isinstance(item, dict):
            yield item


def _values_for_key(value: Any, key: str) -> list[Any]:
    return [item[key] for item in _dicts(value) if key in item]


def _invoke(
    argv: list[str],
    *,
    adapter: FakeBlpApiAdapter | None = None,
    stdin_text: str = "",
) -> dict[str, Any]:
    try:
        result = dispatch(
            parse_args(argv),
            adapter=adapter,
            stdin=io.StringIO(stdin_text),
        )
    except CliError as exc:
        return {
            "ok": False,
            "kind": "raised_cli_error",
            "error": {"code": exc.code, "message": exc.message, "details": exc.details},
        }
    assert isinstance(result, dict)
    return result


def _validate_args(*extra: str) -> list[str]:
    return ["request", "validate", SERVICE, OPERATION, *extra]


def _send_args(*extra: str) -> list[str]:
    return ["request", "send", SERVICE, OPERATION, *extra]


def _assert_success(result: dict[str, Any]) -> None:
    assert result.get("ok") is True, result


def _assert_failure(result: dict[str, Any]) -> None:
    assert result.get("ok") is False, result
    assert result.get("kind") in {"error", "raised_cli_error"}, result
    assert any("code" in item for item in _dicts(result)), result


def _write_schema(path: Path) -> Path:
    path.write_text(json.dumps(OFFLINE_SCHEMA), encoding="utf-8")
    return path


def _canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return f"sha256:{hashlib.sha256(encoded.encode()).hexdigest()}"


def test_dispatch_exposes_keyword_only_adapter_and_stdin_seam() -> None:
    parameters = inspect.signature(dispatch).parameters
    for name in ("adapter", "stdin"):
        parameter = parameters[name]
        assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
        assert parameter.default is not inspect.Parameter.empty


@pytest.mark.parametrize("source", ["inline", "file", "stdin"])
def test_validate_accepts_each_exclusive_body_source(tmp_path: Path, source: str) -> None:
    schema = _write_schema(tmp_path / "schema.json")
    body = json.dumps(VALID_BODY)
    stdin_text = ""
    if source == "inline":
        source_args = ["--body-json", body]
    elif source == "file":
        body_path = tmp_path / "body.json"
        body_path.write_text(body, encoding="utf-8")
        source_args = ["--body", str(body_path)]
    else:
        source_args = ["--body", "-"]
        stdin_text = body
    result = _invoke(
        _validate_args(*source_args, "--schema-file", str(schema)),
        stdin_text=stdin_text,
    )
    _assert_success(result)


def test_validate_rejects_conflicting_body_sources(tmp_path: Path) -> None:
    schema = _write_schema(tmp_path / "schema.json")
    body_path = tmp_path / "body.json"
    body_path.write_text(json.dumps(VALID_BODY), encoding="utf-8")
    result = _invoke(
        _validate_args(
            "--body",
            str(body_path),
            "--body-json",
            json.dumps(VALID_BODY),
            "--schema-file",
            str(schema),
        )
    )
    _assert_failure(result)


def test_validate_rejects_missing_body_source(tmp_path: Path) -> None:
    schema = _write_schema(tmp_path / "schema.json")
    result = _invoke(_validate_args("--schema-file", str(schema)))
    _assert_failure(result)


@pytest.mark.parametrize("body", ["[1, 2]", "null", "{not-json"])
def test_validate_rejects_non_object_or_malformed_body(tmp_path: Path, body: str) -> None:
    schema = _write_schema(tmp_path / "schema.json")
    result = _invoke(
        _validate_args("--body-json", body, "--schema-file", str(schema))
    )
    _assert_failure(result)


def test_strict_unknown_field_fails_with_json_pointer() -> None:
    adapter = FakeBlpApiAdapter()
    body = {**VALID_BODY, "secretUnknown": "must-not-be-echoed"}
    result = _invoke(
        _validate_args(
            "--body-json", json.dumps(body), "--validation-mode", "strict"
        ),
        adapter=adapter,
    )
    _assert_failure(result)
    paths = [
        item[key]
        for item in _dicts(result)
        for key in ("path", "pointer", "json_pointer", "instance_path")
        if key in item
    ]
    assert any(isinstance(path, str) and path.startswith("/") for path in paths), result
    assert "must-not-be-echoed" not in json.dumps(result)


def test_permissive_unknown_field_succeeds_with_warning() -> None:
    adapter = FakeBlpApiAdapter()
    body = {**VALID_BODY, "unknownField": 1}
    result = _invoke(
        _validate_args(
            "--body-json", json.dumps(body), "--validation-mode", "permissive"
        ),
        adapter=adapter,
    )
    _assert_success(result)
    diagnostic_dicts = [
        item
        for item in _dicts(result)
        if any(key in item for key in ("severity", "level", "path", "pointer"))
    ]
    assert any(
        str(item.get("severity", item.get("level", ""))).lower() == "warning"
        for item in diagnostic_dicts
    ), result
    assert any("unknown" in json.dumps(item).lower() for item in diagnostic_dicts), result


def test_validate_reports_server_not_tested_and_exact_schema_hash() -> None:
    adapter = FakeBlpApiAdapter()
    result = _invoke(
        _validate_args("--body-json", json.dumps(VALID_BODY)), adapter=adapter
    )
    _assert_success(result)
    assert "not_tested" in _values_for_key(result, "server_accepted"), result
    expected_hash = _canonical_hash(
        operation_input_schema(sample_reference_data_operation())
    )
    assert expected_hash in _values_for_key(result, "schema_hash"), result


def test_fake_success_preserves_final_response_and_identity_truth() -> None:
    result = _invoke(
        _send_args("--body-json", json.dumps(VALID_BODY)),
        adapter=FakeBlpApiAdapter("request_success"),
    )
    _assert_success(result)
    encoded = json.dumps(result)
    assert "ReferenceDataResponse" in encoded
    assert "PX_LAST" in encoded
    assert 100.25 in list(_walk(result))
    authorization_values = _values_for_key(result, "authorized")
    assert not authorization_values or all(value is False for value in authorization_values)


def test_fake_partial_then_final_preserves_order_and_boundaries() -> None:
    result = _invoke(
        _send_args("--body-json", json.dumps(VALID_BODY)),
        adapter=FakeBlpApiAdapter("partial_then_response"),
    )
    _assert_success(result)
    event_types = _values_for_key(result, "event_type")
    partial_index = event_types.index("PARTIAL_RESPONSE")
    final_index = event_types.index("RESPONSE", partial_index + 1)
    assert partial_index < final_index
    sequences = _values_for_key(result, "sequence")
    assert 1 in sequences and 2 in sequences
    assert "ReferenceDataPartialResponse" in json.dumps(result)
    assert "ReferenceDataResponse" in json.dumps(result)


@pytest.mark.parametrize(
    ("scenario", "expected_code", "forbidden_words"),
    [
        ("request_failure", "BLPAPI_REQUEST_FAILURE", ("timeout",)),
        ("timeout", "REQUEST_TIMEOUT", ("rejected", "requestfailure")),
    ],
)
def test_fake_failure_and_timeout_are_not_success(
    scenario: str, expected_code: str, forbidden_words: tuple[str, ...]
) -> None:
    result = _invoke(
        _send_args("--body-json", json.dumps(VALID_BODY)),
        adapter=FakeBlpApiAdapter(scenario),  # type: ignore[arg-type]
    )
    _assert_failure(result)
    encoded = json.dumps(result).lower()
    assert expected_code.lower() in encoded
    assert all(word not in encoded for word in forbidden_words)


def test_invalid_send_has_zero_adapter_mutation() -> None:
    adapter = FakeBlpApiAdapter()
    result = _invoke(
        _send_args("--body-json", json.dumps({"securities": [], "fields": []})),
        adapter=adapter,
    )
    _assert_failure(result)
    assert adapter.mutation_count == 0


@pytest.mark.parametrize("name", ["request.validate", "request.send"])
def test_command_description_matches_request_surface(name: str) -> None:
    result = _invoke(["command", "describe", name])
    _assert_success(result)
    commands = [item for item in _dicts(result) if item.get("name") == name]
    assert len(commands) == 1, result
    command = commands[0]
    inputs = command["inputs"]
    options = set(inputs["options"])
    assert {"--body", "--body-json", "--validation-mode", "--json"} <= options
    assert inputs["stdin"]["accepted"] is True
    if name == "request.validate":
        assert "--schema-file" in options
        assert command["side_effects"] == []
        assert command["outputs"]["success_kind"] == "validation_result"
    else:
        assert {
            "--timeout-ms",
            "--profile",
            "--session",
            "--identity",
            "--use-session-identity",
        } <= options
        assert "opens_service" in command["side_effects"]
        assert "sends_bloomberg_request" in command["side_effects"]
        assert command["outputs"]["success_kind"] == "request_result"


def test_offline_main_emits_exactly_one_json_value(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    schema = _write_schema(tmp_path / "schema.json")
    exit_code = main(
        _validate_args(
            "--body-json",
            json.dumps(VALID_BODY),
            "--schema-file",
            str(schema),
            "--json",
        )
    )
    captured = capsys.readouterr()
    assert exit_code == 0
    assert captured.err == ""
    decoder = json.JSONDecoder()
    value, end = decoder.raw_decode(captured.out)
    assert isinstance(value, dict) and value.get("ok") is True
    assert captured.out[end:].strip() == ""


def test_offline_main_failure_emits_one_structured_json_without_traceback(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    schema = _write_schema(tmp_path / "schema.json")
    exit_code = main(
        _validate_args(
            "--body-json",
            "{malformed",
            "--schema-file",
            str(schema),
            "--json",
        )
    )
    captured = capsys.readouterr()
    assert exit_code != 0
    assert captured.err == ""
    value, end = json.JSONDecoder().raw_decode(captured.out)
    assert isinstance(value, dict)
    assert value.get("ok") is False
    assert value.get("kind") == "error"
    assert "traceback" not in captured.out.lower()
    assert captured.out[end:].strip() == ""
