#!/usr/bin/env python3
"""Aggregate completed checkpoint-seal experiment runs from durable artifacts."""

from __future__ import annotations

import argparse
import gzip
import json
import statistics
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from typing import Any

CONDITIONS = ("raw", "shake", "report-only", "report+manifest")
DISPLAY = {
    "raw": "Raw",
    "shake": "Scoped Shake",
    "report-only": "Report only",
    "report+manifest": "Report + manifest",
}
SEARCH_TOOLS = {"grep", "glob", "ast_grep"}
EDIT_TOOLS = {"edit", "write", "ast_edit"}
STATIC_CHECKS = {"offline_tests", "ruff", "basedpyright", "ty"}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_gzip_json(path: Path) -> Any:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def iso_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def event_elapsed_minutes(events: list[dict[str, Any]]) -> float:
    timestamps = [
        timestamp
        for event in events
        if (timestamp := iso_timestamp(event.get("timestamp"))) is not None
    ]
    if len(timestamps) < 2:
        raise ValueError("run events do not contain a measurable timestamp range")
    return round((max(timestamps) - min(timestamps)).total_seconds() / 60, 2)


def summarize(values: Iterable[float | int]) -> dict[str, Any]:
    materialized = list(values)
    if not materialized:
        raise ValueError("cannot summarize an empty metric")
    return {
        "values": materialized,
        "mean": round(statistics.fmean(materialized), 2),
        "median": round(statistics.median(materialized), 2),
        "min": min(materialized),
        "max": max(materialized),
        "sd": round(statistics.stdev(materialized), 2)
        if len(materialized) > 1
        else 0.0,
    }


def verification_metrics(verification: dict[str, Any]) -> tuple[int, int, bool]:
    score = verification["score"]
    passed = int(score["hidden_contracts_passed"])
    total = int(score["hidden_contracts_total"])
    checks = verification["checks"]
    static_pass = all(checks[name]["status"] == "passed" for name in STATIC_CHECKS)
    return passed, total, static_pass


def run_metrics(root: Path, run: dict[str, Any]) -> dict[str, Any]:
    directory = root / "runs" / run["id"]
    private = load_json(directory / "private-condition.json")
    if (
        private["condition"] != run["condition"]
        or private["replicate"] != run["replicate"]
    ):
        raise ValueError(f"private condition mismatch for {run['id']}")

    treatment = load_json(directory / "treatment-context.json")
    initial_state = load_json(directory / "initial-state.json")
    verification = load_json(directory / "verification.json")
    events = load_gzip_json(directory / "tool-events.json.gz")
    starts = [event for event in events if event.get("type") == "tool_execution_start"]
    ends = [event for event in events if event.get("type") == "tool_execution_end"]
    tool_names = [event.get("toolName") for event in starts]
    hidden_passed, hidden_total, static_pass = verification_metrics(verification)
    assistant_ends = [
        event
        for event in events
        if event.get("type") == "message_end"
        and isinstance(event.get("message"), dict)
        and event["message"].get("role") == "assistant"
    ]
    provider_failures = [
        event["message"].get("errorMessage", "assistant provider turn failed")
        for event in assistant_ends
        if event["message"].get("stopReason") == "error"
    ]
    if provider_failures:
        raise ValueError(
            f"run {run['id']} contains provider failure: {provider_failures[-1]}"
        )
    provider_cost = 0.0
    for event in assistant_ends:
        usage = event["message"].get("usage")
        cost = usage.get("cost") if isinstance(usage, dict) else None
        if isinstance(cost, dict) and isinstance(cost.get("total"), int | float):
            provider_cost += float(cost["total"])

    return {
        "id": run["id"],
        "condition": run["condition"],
        "replicate": run["replicate"],
        "prompt_tokens": int(treatment["promptTokens"]),
        "messages": int(initial_state["messageCount"]),
        "hidden_passed": hidden_passed,
        "hidden_total": hidden_total,
        "tool_calls": len(starts),
        "reads": tool_names.count("read"),
        "searches": sum(name in SEARCH_TOOLS for name in tool_names),
        "edits": sum(name in EDIT_TOOLS for name in tool_names),
        "bash_calls": tool_names.count("bash"),
        "tool_errors": sum(event.get("isError") is True for event in ends),
        "provider_calls": len(assistant_ends),
        "provider_cost_usd": round(provider_cost, 4),
        "elapsed_minutes": event_elapsed_minutes(events),
        "static_pass": static_pass,
    }


def aggregate(root: Path) -> dict[str, Any]:
    protocol = load_json(root / "protocol.json")
    runs = protocol.get("runs", [])
    metrics = [
        run_metrics(root, run) for run in runs if run.get("status") == "complete"
    ]
    by_condition: dict[str, list[dict[str, Any]]] = {
        condition: sorted(
            (metric for metric in metrics if metric["condition"] == condition),
            key=lambda metric: metric["replicate"],
        )
        for condition in CONDITIONS
    }

    conditions: dict[str, Any] = {}
    metric_names = (
        "prompt_tokens",
        "messages",
        "hidden_passed",
        "tool_calls",
        "reads",
        "searches",
        "edits",
        "bash_calls",
        "tool_errors",
        "elapsed_minutes",
        "provider_calls",
        "provider_cost_usd",
    )
    for condition, rows in by_condition.items():
        summaries = (
            {name: summarize(row[name] for row in rows) for name in metric_names}
            if rows
            else {}
        )
        conditions[condition] = {
            "n": len(rows),
            **summaries,
            "all_static_pass": bool(rows) and all(row["static_pass"] for row in rows),
            "runs": rows,
        }

    raw_prompt = conditions["raw"].get("prompt_tokens", {}).get("mean")
    reductions: dict[str, Any] = {}
    if isinstance(raw_prompt, int | float) and raw_prompt > 0:
        for condition in CONDITIONS[1:]:
            treatment_prompt = (
                conditions[condition].get("prompt_tokens", {}).get("mean")
            )
            if isinstance(treatment_prompt, int | float):
                tokens = raw_prompt - treatment_prompt
                reductions[condition] = {
                    "tokens": round(tokens, 2),
                    "percent": round(tokens / raw_prompt * 100, 2),
                }

    return {
        "schema_version": 3,
        "experiment_root": str(root),
        "protocol_schema": protocol["schemaVersion"],
        "model": f"{protocol['model']['provider']}/{protocol['model']['id']}",
        "reasoning": protocol["model"].get("thinking"),
        "valid_runs": len(metrics),
        "replicates_per_condition": protocol["replicates"],
        "conditions": conditions,
        "prompt_reduction_vs_raw": reductions,
    }


def render_comparison(data: dict[str, Any]) -> str:
    lines = [
        "# Checkpoint Seal Bloomberg Comparison",
        "",
        f"Valid completed runs: {data['valid_runs']}",
        "",
        "| Condition | N | First prompt | Messages | Hidden mean | Hidden range | Tools | Reads | Edits | Errors | Elapsed | Provider cost |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for condition in CONDITIONS:
        row = data["conditions"][condition]
        if row["n"] == 0:
            lines.append(
                f"| {DISPLAY[condition]} | 0 | — | — | — | — | — | — | — | — | — | — |"
            )
            continue
        lines.append(
            "| "
            + " | ".join(
                [
                    DISPLAY[condition],
                    str(row["n"]),
                    f"{row['prompt_tokens']['mean']:,.0f}",
                    f"{row['messages']['mean']:,.1f}",
                    f"{row['hidden_passed']['mean']:.2f}/21",
                    f"{row['hidden_passed']['min']}–{row['hidden_passed']['max']}",
                    f"{row['tool_calls']['mean']:.1f}",
                    f"{row['reads']['mean']:.1f}",
                    f"{row['edits']['mean']:.1f}",
                    f"{row['tool_errors']['mean']:.1f}",
                    f"{row['elapsed_minutes']['mean']:.2f}m",
                    f"${row['provider_cost_usd']['mean']:.2f}",
                ]
            )
            + " |"
        )
    lines.extend(["", "Hidden passes by replicate:"])
    for condition in CONDITIONS:
        values = (
            data["conditions"][condition].get("hidden_passed", {}).get("values", [])
        )
        lines.append(f"- {DISPLAY[condition]}: {', '.join(map(str, values)) or 'none'}")
    lines.append("")
    lines.append("First-prompt reduction versus raw:")
    for condition, reduction in data["prompt_reduction_vs_raw"].items():
        lines.append(
            f"- {DISPLAY[condition]}: {reduction['tokens']:,.0f} tokens, {reduction['percent']:.2f}%"
        )
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("experiment_root", type=Path)
    args = parser.parse_args()
    root = args.experiment_root.resolve()
    data = aggregate(root)
    analysis = root / "analysis"
    analysis.mkdir(parents=True, exist_ok=True)
    (analysis / "aggregate.json").write_text(
        f"{json.dumps(data, indent=2)}\n", encoding="utf-8"
    )
    (analysis / "comparison.md").write_text(render_comparison(data), encoding="utf-8")
    print(f"{data['valid_runs']} runs aggregated into {analysis}")


if __name__ == "__main__":
    main()
