#!/usr/bin/env python3
"""Produce cache, cost, correlation, and product-analysis artifacts for the corrected experiment."""

from __future__ import annotations

import argparse
import csv
import gzip
import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy import stats

CONDITIONS = ("raw", "shake", "report-only", "report+manifest")
DISPLAY = {
    "raw": "Raw",
    "shake": "Scoped Shake",
    "report-only": "Report only",
    "report+manifest": "Report + manifest",
}
EXPERIMENT_ROOT = Path(
    "/Users/case/experiments/checkpoint-seal-bloomberg-clean-v2-0.144.1-medium"
)
RNG = np.random.default_rng(20260713)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_gzip_json(path: Path) -> Any:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def assistant_turns(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    turns = []
    for event in events:
        if event.get("type") != "message_end":
            continue
        message = event.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        if message.get("stopReason") == "error":
            raise ValueError(
                f"provider failure in valid run: {message.get('errorMessage')}"
            )
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        cost = usage.get("cost") if isinstance(usage.get("cost"), dict) else {}
        turns.append(
            {
                "timestamp": event.get("timestamp"),
                "stop_reason": message.get("stopReason"),
                "input": int(usage.get("input", 0)),
                "output": int(usage.get("output", 0)),
                "cache_read": int(usage.get("cacheRead", 0)),
                "cache_write": int(usage.get("cacheWrite", 0)),
                "total_tokens": int(usage.get("totalTokens", 0)),
                "cost_input": float(cost.get("input", 0)),
                "cost_output": float(cost.get("output", 0)),
                "cost_cache_read": float(cost.get("cacheRead", 0)),
                "cost_cache_write": float(cost.get("cacheWrite", 0)),
                "cost_total": float(cost.get("total", 0)),
            }
        )
    return turns


def condition_rows(root: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    protocol = load_json(root / "protocol.json")
    aggregate = load_json(root / "analysis/aggregate.json")
    run_rows: list[dict[str, Any]] = []
    turn_rows: list[dict[str, Any]] = []

    aggregate_runs = {
        row["id"]: row
        for condition in CONDITIONS
        for row in aggregate["conditions"][condition]["runs"]
    }
    for run in protocol["runs"]:
        if run.get("status") != "complete":
            continue
        run_id = run["id"]
        condition = run["condition"]
        base = aggregate_runs[run_id]
        events = load_gzip_json(root / "runs" / run_id / "tool-events.json.gz")
        turns = assistant_turns(events)
        if not turns:
            raise ValueError(f"run {run_id} contains no provider turns")
        for index, turn in enumerate(turns, start=1):
            prompt_tokens = turn["input"] + turn["cache_read"] + turn["cache_write"]
            turn_rows.append(
                {
                    "run_id": run_id,
                    "condition": condition,
                    "replicate": run["replicate"],
                    "turn": index,
                    **turn,
                    "prompt_tokens": prompt_tokens,
                    "cache_hit": turn["cache_read"] > 0,
                    "cache_read_share": turn["cache_read"] / prompt_tokens
                    if prompt_tokens
                    else 0,
                }
            )
        first = turns[0]
        last = turns[-1]
        first_prompt = first["input"] + first["cache_read"] + first["cache_write"]
        last_prompt = last["input"] + last["cache_read"] + last["cache_write"]
        run_rows.append(
            {
                **base,
                "first_input": first["input"],
                "first_cache_read": first["cache_read"],
                "first_cache_write": first["cache_write"],
                "first_prompt": first_prompt,
                "last_prompt": last_prompt,
                "prompt_growth": last_prompt - first_prompt,
                "cumulative_input": sum(turn["input"] for turn in turns),
                "cumulative_cache_read": sum(turn["cache_read"] for turn in turns),
                "cumulative_cache_write": sum(turn["cache_write"] for turn in turns),
                "cumulative_prompt": sum(
                    turn["input"] + turn["cache_read"] + turn["cache_write"]
                    for turn in turns
                ),
                "cumulative_output": sum(turn["output"] for turn in turns),
                "provider_calls": len(turns),
                "provider_cost": sum(turn["cost_total"] for turn in turns),
                "cost_input": sum(turn["cost_input"] for turn in turns),
                "cost_output": sum(turn["cost_output"] for turn in turns),
                "cost_cache_read": sum(turn["cost_cache_read"] for turn in turns),
                "cost_cache_write": sum(turn["cost_cache_write"] for turn in turns),
            }
        )
    return pd.DataFrame(run_rows), pd.DataFrame(turn_rows)


def seal_overheads(root: Path) -> dict[str, dict[str, float]]:
    events = sorted(
        load_gzip_json(root / "contexts/derivation/tool-events.json.gz"),
        key=lambda event: event.get("timestamp", ""),
    )
    groups: list[list[dict[str, Any]]] = []
    active: list[dict[str, Any]] | None = None
    for event in events:
        if event.get("type") == "agent_start":
            active = [event]
        elif active is not None:
            active.append(event)
            if event.get("type") == "agent_end":
                groups.append(active)
                active = None

    result: dict[str, dict[str, float]] = {}
    for group in groups:
        strategies = {
            event.get("args", {}).get("strategy")
            for event in group
            if event.get("type") == "tool_execution_start"
            and event.get("toolName") == "seal"
            and isinstance(event.get("args"), dict)
        }
        if len(strategies) != 1:
            raise ValueError(
                f"derivation provider group has ambiguous seal strategies: {sorted(strategies)}"
            )
        strategy = strategies.pop()
        turns = assistant_turns(group)
        timestamps = [
            pd.Timestamp(event["timestamp"])
            for event in group
            if isinstance(event.get("timestamp"), str)
        ]
        result[strategy] = {
            "provider_calls": float(len(turns)),
            "cost": sum(turn["cost_total"] for turn in turns),
            "elapsed_minutes": (max(timestamps) - min(timestamps)).total_seconds() / 60,
            "input": float(sum(turn["input"] for turn in turns)),
            "cache_read": float(sum(turn["cache_read"] for turn in turns)),
            "cache_write": float(sum(turn["cache_write"] for turn in turns)),
            "output": float(sum(turn["output"] for turn in turns)),
            "cost_input": sum(turn["cost_input"] for turn in turns),
            "cost_cache_read": sum(turn["cost_cache_read"] for turn in turns),
            "cost_output": sum(turn["cost_output"] for turn in turns),
        }
    if set(result) != {"shake", "summary"}:
        raise ValueError(f"could not identify both seal strategies: {sorted(result)}")
    return result


def mean_table(runs: pd.DataFrame) -> pd.DataFrame:
    metrics = [
        "first_prompt",
        "first_input",
        "first_cache_read",
        "last_prompt",
        "prompt_growth",
        "cumulative_prompt",
        "cumulative_input",
        "cumulative_cache_read",
        "cumulative_output",
        "provider_calls",
        "provider_cost",
        "hidden_passed",
        "tool_calls",
        "reads",
        "edits",
        "tool_errors",
        "elapsed_minutes",
    ]
    return runs.groupby("condition", sort=False)[metrics].mean().reindex(CONDITIONS)


def bootstrap_difference(
    left: np.ndarray, right: np.ndarray, iterations: int = 100_000
) -> dict[str, float]:
    left_samples = RNG.choice(left, size=(iterations, len(left)), replace=True).mean(
        axis=1
    )
    right_samples = RNG.choice(right, size=(iterations, len(right)), replace=True).mean(
        axis=1
    )
    differences = left_samples - right_samples
    return {
        "mean_difference": float(left.mean() - right.mean()),
        "ci_low": float(np.quantile(differences, 0.025)),
        "ci_high": float(np.quantile(differences, 0.975)),
        "probability_greater": float(np.mean(differences > 0)),
    }


def benjamini_hochberg(p_values: Iterable[float]) -> list[float]:
    values = np.asarray(list(p_values), dtype=float)
    order = np.argsort(values)
    adjusted = np.empty_like(values)
    running = 1.0
    for rank_index in range(len(values) - 1, -1, -1):
        original_index = order[rank_index]
        rank = rank_index + 1
        running = min(running, values[original_index] * len(values) / rank)
        adjusted[original_index] = running
    return adjusted.tolist()


def correlations(runs: pd.DataFrame) -> pd.DataFrame:
    predictors = [
        "first_prompt",
        "last_prompt",
        "prompt_growth",
        "cumulative_prompt",
        "cumulative_output",
        "provider_calls",
        "provider_cost",
        "tool_calls",
        "reads",
        "edits",
        "tool_errors",
        "elapsed_minutes",
    ]
    rows: list[dict[str, Any]] = []
    for scope in ("pooled", "within-treatment"):
        outcome = runs["hidden_passed"].astype(float)
        if scope == "within-treatment":
            outcome = outcome - runs.groupby("condition")["hidden_passed"].transform(
                "mean"
            )
        for predictor in predictors:
            values = runs[predictor].astype(float)
            if scope == "within-treatment":
                values = values - runs.groupby("condition")[predictor].transform("mean")
            pearson = stats.pearsonr(values, outcome)
            spearman = stats.spearmanr(values, outcome)
            rows.append(
                {
                    "scope": scope,
                    "outcome": "hidden_passed",
                    "predictor": predictor,
                    "n": len(runs),
                    "pearson_r": pearson.statistic,
                    "pearson_p": pearson.pvalue,
                    "spearman_rho": spearman.statistic,
                    "spearman_p": spearman.pvalue,
                }
            )
    result = pd.DataFrame(rows)
    mask = result["scope"] == "within-treatment"
    result.loc[mask, "pearson_q_bh"] = benjamini_hochberg(result.loc[mask, "pearson_p"])
    return result


def operational_correlations(runs: pd.DataFrame) -> pd.DataFrame:
    pairs = [
        ("provider_cost", "cumulative_prompt"),
        ("provider_cost", "provider_calls"),
        ("provider_cost", "first_prompt"),
        ("elapsed_minutes", "tool_calls"),
    ]
    rows: list[dict[str, Any]] = []
    for scope in ("pooled", "within-treatment"):
        for outcome_name, predictor_name in pairs:
            outcome = runs[outcome_name].astype(float)
            predictor = runs[predictor_name].astype(float)
            if scope == "within-treatment":
                outcome = outcome - runs.groupby("condition")[outcome_name].transform(
                    "mean"
                )
                predictor = predictor - runs.groupby("condition")[
                    predictor_name
                ].transform("mean")
            pearson = stats.pearsonr(predictor, outcome)
            spearman = stats.spearmanr(predictor, outcome)
            rows.append(
                {
                    "scope": scope,
                    "outcome": outcome_name,
                    "predictor": predictor_name,
                    "n": len(runs),
                    "pearson_r": pearson.statistic,
                    "pearson_p": pearson.pvalue,
                    "spearman_rho": spearman.statistic,
                    "spearman_p": spearman.pvalue,
                    "pearson_q_bh": np.nan,
                }
            )
    return pd.DataFrame(rows)


def contrasts(means: pd.DataFrame, runs: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    pairs = [
        ("shake", "raw"),
        ("report-only", "raw"),
        ("report+manifest", "raw"),
        ("report+manifest", "report-only"),
        ("report+manifest", "shake"),
    ]
    metrics = [
        "first_prompt",
        "last_prompt",
        "cumulative_prompt",
        "hidden_passed",
        "provider_calls",
        "provider_cost",
        "tool_calls",
        "elapsed_minutes",
    ]
    for treatment, baseline in pairs:
        for metric in metrics:
            treatment_mean = float(means.loc[treatment, metric])
            baseline_mean = float(means.loc[baseline, metric])
            row = {
                "treatment": treatment,
                "baseline": baseline,
                "metric": metric,
                "treatment_mean": treatment_mean,
                "baseline_mean": baseline_mean,
                "difference": treatment_mean - baseline_mean,
                "percent_difference": (treatment_mean - baseline_mean)
                / baseline_mean
                * 100,
            }
            if metric == "hidden_passed":
                boot = bootstrap_difference(
                    runs.loc[runs.condition == treatment, metric].to_numpy(),
                    runs.loc[runs.condition == baseline, metric].to_numpy(),
                )
                row.update(
                    {
                        "bootstrap_ci_low": boot["ci_low"],
                        "bootstrap_ci_high": boot["ci_high"],
                        "probability_treatment_greater": boot["probability_greater"],
                    }
                )
            rows.append(row)
    return pd.DataFrame(rows)


def pareto_frontier(
    rows: pd.DataFrame, cost_column: str = "provider_cost"
) -> pd.DataFrame:
    frontier = []
    for _, candidate in rows.iterrows():
        dominated = any(
            other[cost_column] <= candidate[cost_column]
            and other["hidden_passed"] >= candidate["hidden_passed"]
            and (
                other[cost_column] < candidate[cost_column]
                or other["hidden_passed"] > candidate["hidden_passed"]
            )
            for _, other in rows.iterrows()
        )
        if not dominated:
            frontier.append(candidate)
    return pd.DataFrame(frontier).sort_values([cost_column, "hidden_passed"])


def regression_summary(runs: pd.DataFrame) -> dict[str, Any]:
    cost_x = sm.add_constant(
        pd.DataFrame(
            {
                "initial_prompt_10k": runs["first_prompt"] / 10_000,
                "provider_calls": runs["provider_calls"],
            }
        )
    )
    cost_model = sm.OLS(runs["provider_cost"], cost_x).fit(cov_type="HC3")
    tool_x = sm.add_constant(runs[["tool_calls"]])
    elapsed_model = sm.OLS(runs["elapsed_minutes"] * 60, tool_x).fit(cov_type="HC3")
    return {
        "cost_model": {
            "r_squared": cost_model.rsquared,
            "coefficients": cost_model.params.to_dict(),
            "p_values_hc3": cost_model.pvalues.to_dict(),
        },
        "elapsed_tool_model": {
            "r_squared": elapsed_model.rsquared,
            "coefficients_seconds": elapsed_model.params.to_dict(),
            "p_values_hc3": elapsed_model.pvalues.to_dict(),
        },
    }


def cache_price_sensitivity(
    runs: pd.DataFrame, seals: dict[str, dict[str, float]]
) -> list[dict[str, float]]:
    results = []
    for price in (0.0, 0.5, 5.0):
        row: dict[str, float] = {"cache_read_price_per_million": price}
        for condition in CONDITIONS:
            treatment = runs[runs.condition == condition]
            non_cache = float(
                (
                    treatment.cost_input
                    + treatment.cost_output
                    + treatment.cost_cache_write
                ).mean()
            )
            cache_tokens = float(treatment.cumulative_cache_read.mean())
            cost = non_cache + cache_tokens * price / 1_000_000
            if condition == "shake":
                seal = seals["shake"]
            elif condition in {"report-only", "report+manifest"}:
                seal = seals["summary"]
            else:
                seal = None
            if seal:
                cost += (
                    seal["cost_input"] + seal["cost_output"] + seal["cache_write"] * 0
                )
                cost += seal["cache_read"] * price / 1_000_000
            row[condition] = cost
        results.append(row)
    return results


def json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [json_safe(item) for item in value]
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "experiment_root", nargs="?", type=Path, default=EXPERIMENT_ROOT
    )
    args = parser.parse_args()
    root = args.experiment_root.resolve()
    output = root / "analysis"
    output.mkdir(parents=True, exist_ok=True)

    runs, turns = condition_rows(root)
    means = mean_table(runs)
    seals = seal_overheads(root)
    correlation_table = pd.concat(
        [correlations(runs), operational_correlations(runs)], ignore_index=True
    )
    contrast_table = contrasts(means, runs)
    regressions = regression_summary(runs)

    pooled = {
        "provider_turns": len(turns),
        "turns_with_cache_read": int(turns.cache_hit.sum()),
        "cache_hit_incidence": float(turns.cache_hit.mean()),
        "input": int(turns.input.sum()),
        "cache_read": int(turns.cache_read.sum()),
        "cache_write": int(turns.cache_write.sum()),
        "prompt": int(turns.prompt_tokens.sum()),
        "output": int(turns.output.sum()),
        "provider_cost": float(turns.cost_total.sum()),
        "cost_shares": {
            "input": float(turns.cost_input.sum() / turns.cost_total.sum()),
            "cache_read": float(turns.cost_cache_read.sum() / turns.cost_total.sum()),
            "output": float(turns.cost_output.sum() / turns.cost_total.sum()),
        },
    }
    cache_rates = {
        "input_per_token": float(turns.cost_input.sum() / turns.input.sum()),
        "cache_read_per_token": float(
            turns.cost_cache_read.sum() / turns.cache_read.sum()
        ),
    }
    cold = turns[~turns.cache_hit].copy()
    cold["estimated_cache_premium"] = cold.input * (
        cache_rates["input_per_token"] - cache_rates["cache_read_per_token"]
    )

    condition_stats: dict[str, Any] = {}
    for condition in CONDITIONS:
        run_slice = runs[runs.condition == condition]
        turn_slice = turns[turns.condition == condition]
        condition_stats[condition] = {
            "n": len(run_slice),
            "means": means.loc[condition].to_dict(),
            "weighted_cache_read_share": float(
                turn_slice.cache_read.sum() / turn_slice.prompt_tokens.sum()
            ),
            "median_turn_cache_read_share": float(turn_slice.cache_read_share.median()),
            "cache_hit_incidence": float(turn_slice.cache_hit.mean()),
            "cost_per_provider_call": float(
                run_slice.provider_cost.mean() / run_slice.provider_calls.mean()
            ),
            "score_thresholds": {
                "at_least_16": int((run_slice.hidden_passed >= 16).sum()),
                "at_least_14": int((run_slice.hidden_passed >= 14).sum()),
            },
        }

    groups = [
        runs.loc[runs.condition == condition, "hidden_passed"].to_numpy()
        for condition in CONDITIONS
    ]
    grand_mean = runs.hidden_passed.mean()
    between = sum(len(group) * (group.mean() - grand_mean) ** 2 for group in groups)
    total = float(((runs.hidden_passed - grand_mean) ** 2).sum())
    anova = stats.f_oneway(*groups)
    kruskal = stats.kruskal(*groups)

    mean_frontier_input = means.reset_index()[
        ["condition", "hidden_passed", "provider_cost"]
    ]
    mean_frontier = pareto_frontier(mean_frontier_input).to_dict(orient="records")
    run_frontier = pareto_frontier(
        runs[["id", "condition", "replicate", "hidden_passed", "provider_cost"]]
    ).to_dict(orient="records")

    sensitivity = cache_price_sensitivity(runs, seals)
    one_shot = {}
    for condition in CONDITIONS:
        seal = (
            seals["shake"]
            if condition == "shake"
            else seals["summary"]
            if condition != "raw"
            else None
        )
        one_shot[condition] = {
            "cost": float(
                means.loc[condition, "provider_cost"] + (seal["cost"] if seal else 0)
            ),
            "elapsed_minutes": float(
                means.loc[condition, "elapsed_minutes"]
                + (seal["elapsed_minutes"] if seal else 0)
            ),
        }

    manifest_score = runs.loc[runs.condition == "report+manifest", "hidden_passed"]
    manifest_order = stats.spearmanr(
        runs.loc[runs.condition == "report+manifest", "replicate"], manifest_score
    )
    manifest_elapsed_order = stats.spearmanr(
        runs.loc[runs.condition == "report+manifest", "replicate"],
        runs.loc[runs.condition == "report+manifest", "elapsed_minutes"],
    )
    manifest_runs = runs[runs.condition == "report+manifest"]
    manifest_quality_correlations = {}
    for predictor in ("provider_cost", "elapsed_minutes", "cumulative_output"):
        pearson = stats.pearsonr(manifest_runs[predictor], manifest_runs.hidden_passed)
        manifest_quality_correlations[predictor] = {
            "r": pearson.statistic,
            "p": pearson.pvalue,
        }

    result = {
        "schema_version": 1,
        "experiment_root": str(root),
        "valid_runs": len(runs),
        "pooled": pooled,
        "condition_stats": condition_stats,
        "seal_overheads": seals,
        "one_shot_end_to_end": one_shot,
        "cache_price_sensitivity": sensitivity,
        "observed_token_prices_per_million": {
            "input": cache_rates["input_per_token"] * 1_000_000,
            "cache_read": cache_rates["cache_read_per_token"] * 1_000_000,
        },
        "cold_turns": cold[
            [
                "run_id",
                "condition",
                "replicate",
                "turn",
                "input",
                "cache_read",
                "estimated_cache_premium",
            ]
        ].to_dict(orient="records"),
        "cold_cache_premium_total": float(cold.estimated_cache_premium.sum()),
        "quality": {
            "anova_f": anova.statistic,
            "anova_p": anova.pvalue,
            "kruskal_h": kruskal.statistic,
            "kruskal_p": kruskal.pvalue,
            "treatment_variance_explained_eta_squared": between / total,
            "manifest_minus_raw": bootstrap_difference(
                runs.loc[
                    runs.condition == "report+manifest", "hidden_passed"
                ].to_numpy(),
                runs.loc[runs.condition == "raw", "hidden_passed"].to_numpy(),
            ),
            "manifest_vs_report_probability": bootstrap_difference(
                runs.loc[
                    runs.condition == "report+manifest", "hidden_passed"
                ].to_numpy(),
                runs.loc[runs.condition == "report-only", "hidden_passed"].to_numpy(),
            )["probability_greater"],
            "manifest_vs_shake_probability": bootstrap_difference(
                runs.loc[
                    runs.condition == "report+manifest", "hidden_passed"
                ].to_numpy(),
                runs.loc[runs.condition == "shake", "hidden_passed"].to_numpy(),
            )["probability_greater"],
            "manifest_replicate_score_spearman": {
                "rho": manifest_order.statistic,
                "p": manifest_order.pvalue,
            },
            "manifest_replicate_elapsed_spearman": {
                "rho": manifest_elapsed_order.statistic,
                "p": manifest_elapsed_order.pvalue,
            },
            "manifest_quality_correlations": manifest_quality_correlations,
        },
        "regressions": regressions,
        "mean_pareto_frontier": mean_frontier,
        "run_pareto_frontier": run_frontier,
    }

    runs.to_csv(output / "run-level-metrics.csv", index=False)
    with gzip.open(
        output / "turn-level-metrics.csv.gz", "wt", encoding="utf-8", newline=""
    ) as handle:
        turns.to_csv(handle, index=False, quoting=csv.QUOTE_MINIMAL)
    correlation_table.to_csv(output / "correlations.csv", index=False)
    contrast_table.to_csv(output / "treatment-contrasts.csv", index=False)
    (output / "deep-analysis.json").write_text(
        f"{json.dumps(json_safe(result), indent=2)}\n",
        encoding="utf-8",
    )
    print(f"{len(runs)} runs and {len(turns)} provider turns analyzed into {output}")


if __name__ == "__main__":
    main()
