#!/usr/bin/env python3
from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import tomllib
from typing import Sequence
import xml.etree.ElementTree as ET


@dataclass(frozen=True)
class CheckResult:
    name: str
    command: list[str]
    status: str
    exit_code: int | None
    duration_seconds: float
    stdout: str
    stderr: str
    tests: dict[str, int] | None = None
    detail: str | None = None


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate a Bloomberg CLI workspace without modifying it."
    )
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--python",
        type=Path,
        help="Python interpreter with the workspace's test dependencies installed.",
    )
    parser.add_argument("--timeout-seconds", type=int, default=600)
    return parser.parse_args()


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _interpreter(workspace: Path, requested: Path | None) -> Path:
    if requested is not None:
        return requested.expanduser().absolute()
    candidate = workspace / ".venv" / "bin" / "python"
    return candidate if candidate.is_file() else Path(sys.executable).resolve()


def _test_counts(junit_path: Path) -> dict[str, int] | None:
    if not junit_path.is_file():
        return None
    root = ET.parse(junit_path).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    if not suites:
        return None
    counts = {"tests": 0, "failures": 0, "errors": 0, "skipped": 0, "passed": 0}
    for suite in suites:
        if suite is not root and root.tag == "testsuite":
            continue
        counts["tests"] += int(suite.attrib.get("tests", "0"))
        counts["failures"] += int(suite.attrib.get("failures", "0"))
        counts["errors"] += int(suite.attrib.get("errors", "0"))
        counts["skipped"] += int(suite.attrib.get("skipped", "0"))
    counts["passed"] = (
        counts["tests"] - counts["failures"] - counts["errors"] - counts["skipped"]
    )
    return counts


def _captured_text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    return value.decode(errors="replace") if isinstance(value, bytes) else value


def _run_check(
    name: str,
    command: Sequence[str],
    *,
    workspace: Path,
    environment: dict[str, str],
    timeout_seconds: int,
    junit_path: Path | None = None,
) -> CheckResult:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            list(command),
            cwd=workspace,
            env=environment,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except FileNotFoundError as exc:
        return CheckResult(
            name,
            list(command),
            "unavailable",
            None,
            time.monotonic() - started,
            "",
            "",
            detail=str(exc),
        )
    except subprocess.TimeoutExpired as exc:
        return CheckResult(
            name,
            list(command),
            "timeout",
            None,
            time.monotonic() - started,
            _captured_text(exc.stdout),
            _captured_text(exc.stderr),
            detail=f"exceeded {timeout_seconds} seconds",
        )
    stdout = completed.stdout
    stderr = completed.stderr
    missing_module = completed.returncode != 0 and "No module named" in (
        stdout + stderr
    )
    status = (
        "unavailable"
        if missing_module
        else "passed"
        if completed.returncode == 0
        else "failed"
    )
    return CheckResult(
        name,
        list(command),
        status,
        completed.returncode,
        time.monotonic() - started,
        stdout,
        stderr,
        tests=_test_counts(junit_path) if junit_path else None,
    )


def main() -> int:
    args = _parse_args()
    workspace = args.workspace.expanduser().resolve(strict=True)
    output = args.output.expanduser().resolve()
    if not workspace.is_dir():
        raise SystemExit(f"workspace is not a directory: {workspace}")
    if _is_within(output, workspace):
        raise SystemExit("--output must be outside --workspace")
    source = workspace / "src"
    tests = workspace / "tests"
    if not source.is_dir() or not tests.is_dir():
        raise SystemExit("workspace must contain src/ and tests/")

    evaluator_root = Path(__file__).resolve().parent
    hidden_tests = evaluator_root / "hidden-tests"
    python = _interpreter(workspace, args.python)
    if not python.is_file():
        raise SystemExit(f"Python interpreter does not exist: {python}")

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="checkpoint-seal-evaluator-") as temp_name:
        temp = Path(temp_name)
        environment = os.environ.copy()
        existing_pythonpath = environment.get("PYTHONPATH")
        environment.update(
            {
                "PYTHONPATH": os.pathsep.join(
                    [
                        str(source),
                        *([existing_pythonpath] if existing_pythonpath else []),
                    ]
                ),
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONHASHSEED": "0",
                "XDG_CACHE_HOME": str(temp / "cache"),
                "RUFF_CACHE_DIR": str(temp / "ruff-cache"),
                "TMPDIR": str(temp / "tmp"),
            }
        )
        (temp / "tmp").mkdir()
        hidden_junit = temp / "hidden.xml"
        offline_junit = temp / "offline.xml"
        environment_root = python.parent.parent
        project_config = tomllib.loads(
            (workspace / "pyproject.toml").read_text(encoding="utf-8")
        )
        basedpyright_options = dict(project_config["tool"]["basedpyright"])
        basedpyright_options["extraPaths"] = [str(source)]
        basedpyright_options["include"] = [str(source)]
        basedpyright_options["exclude"] = [
            str(workspace / pattern)
            for pattern in basedpyright_options.get("exclude", [])
        ]
        basedpyright_options["venvPath"] = str(environment_root.parent)
        basedpyright_options["venv"] = environment_root.name
        basedpyright_config = temp / "basedpyrightconfig.json"
        basedpyright_config.write_text(
            json.dumps(basedpyright_options),
            encoding="utf-8",
        )
        pytest_base = [
            str(python),
            "-m",
            "pytest",
            "-c",
            str(workspace / "pyproject.toml"),
            "--rootdir",
            str(workspace),
            "-q",
            "-p",
            "no:cacheprovider",
        ]
        checks = [
            _run_check(
                "hidden_tests",
                [*pytest_base, str(hidden_tests), f"--junitxml={hidden_junit}"],
                workspace=workspace,
                environment=environment,
                timeout_seconds=args.timeout_seconds,
                junit_path=hidden_junit,
            ),
            _run_check(
                "ruff",
                [
                    str(python),
                    "-m",
                    "ruff",
                    "check",
                    "--isolated",
                    "--no-fix",
                    "src",
                    "tests",
                ],
                workspace=workspace,
                environment=environment,
                timeout_seconds=args.timeout_seconds,
            ),
            _run_check(
                "basedpyright",
                [
                    str(python),
                    "-m",
                    "basedpyright",
                    "--project",
                    str(basedpyright_config),
                    "--level",
                    "error",
                ],
                workspace=workspace,
                environment=environment,
                timeout_seconds=args.timeout_seconds,
            ),
            _run_check(
                "ty",
                [str(python), "-m", "ty", "check", "src"],
                workspace=workspace,
                environment=environment,
                timeout_seconds=args.timeout_seconds,
            ),
            _run_check(
                "offline_tests",
                [
                    *pytest_base,
                    str(tests),
                    f"--ignore={tests / 'blp' / 'test_real_adapter_versions.py'}",
                    f"--ignore={tests / 'security' / 'test_live_probe_stubs.py'}",
                    f"--junitxml={offline_junit}",
                ],
                workspace=workspace,
                environment=environment,
                timeout_seconds=args.timeout_seconds,
                junit_path=offline_junit,
            ),
        ]

    hidden = checks[0]
    hidden_counts = hidden.tests or {}
    passed = hidden_counts.get("passed", 0)
    total = hidden_counts.get("tests", 0)
    report = {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "workspace": str(workspace),
        "evaluator": str(evaluator_root),
        "python": str(python),
        "checks": {check.name: asdict(check) for check in checks},
        "score": {
            "hidden_contracts_passed": passed,
            "hidden_contracts_total": total,
            "hidden_contract_fraction": passed / total if total else 0.0,
            "mandatory_hidden_contracts_complete": (
                hidden.status == "passed" and total > 0 and passed == total
            ),
            "regression_safe": checks[-1].status == "passed",
            "static_checks_passed": all(
                check.status == "passed" for check in checks[1:4]
            ),
        },
    }
    temporary_output = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    temporary_output.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    temporary_output.replace(output)
    return 0 if all(check.status == "passed" for check in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
