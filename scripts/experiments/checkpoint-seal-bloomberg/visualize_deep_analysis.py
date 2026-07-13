#!/usr/bin/env python3
"""Generate the companion PDF for the checkpoint-seal quantitative analysis."""

from __future__ import annotations

import json
from pathlib import Path
from textwrap import fill

import matplotlib as mpl
import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.lines import Line2D

ROOT = Path(__file__).resolve().parents[3]
EXPERIMENT_ROOT = Path(
    "/Users/case/experiments/checkpoint-seal-bloomberg-clean-v2-0.144.1-medium"
)
ANALYSIS_PATH = EXPERIMENT_ROOT / "analysis/deep-analysis.json"
RUNS_PATH = EXPERIMENT_ROOT / "analysis/run-level-metrics.csv"
OUTPUT_PATH = (
    ROOT / "docs/execution-plans/checkpoint-seal-bloomberg/quantitative-analysis.pdf"
)

INK = "#20252B"
MUTED = "#68717C"
HAIRLINE = "#D8DDE2"
PALE = "#EEF1F3"
ACCENT = "#1E6F8C"
ACCENT_PALE = "#CFE3EA"
RISK = "#A14D3D"
WHITE = "#FFFFFF"

ORDER = ["raw", "shake", "report-only", "report+manifest"]
DISPLAY = {
    "raw": "Raw history",
    "shake": "Scoped Shake",
    "report-only": "Report only",
    "report+manifest": "Report + manifest",
}
COLORS = {
    "raw": INK,
    "shake": "#66727E",
    "report-only": "#A2A9B0",
    "report+manifest": ACCENT,
}
ROWS = {condition: 3 - index for index, condition in enumerate(ORDER)}


def style_axis(ax: plt.Axes) -> None:
    ax.set_facecolor(WHITE)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.tick_params(axis="both", colors=MUTED, labelsize=8.2, length=0, pad=5)
    ax.set_axisbelow(True)


def add_header(fig: plt.Figure, title: str, subtitle: str, page: int) -> None:
    fig.text(0.065, 0.925, title, fontsize=22, weight="semibold", color=INK, va="top")
    fig.text(0.065, 0.875, subtitle, fontsize=9.3, color=MUTED, va="top")
    fig.text(0.935, 0.925, str(page), fontsize=8.5, color=MUTED, ha="right", va="top")
    fig.add_artist(
        Line2D(
            [0.065, 0.935],
            [0.845, 0.845],
            transform=fig.transFigure,
            color=HAIRLINE,
            lw=0.7,
        )
    )


def add_footer(fig: plt.Figure, text: str) -> None:
    fig.add_artist(
        Line2D(
            [0.065, 0.935],
            [0.06, 0.06],
            transform=fig.transFigure,
            color=HAIRLINE,
            lw=0.7,
        )
    )
    fig.text(0.065, 0.035, text, fontsize=7.0, color=MUTED, va="center")


def page_cache(pdf: PdfPages, data: dict) -> None:
    fig = plt.figure(figsize=(11, 8.5), facecolor=WHITE)
    add_header(
        fig,
        "Cache reads were ubiquitous—and still the largest cost",
        "20 valid runs · 1,120 provider turns · absolute token accounting, not a ratio-only view",
        1,
    )

    first_ax = fig.add_axes((0.15, 0.49, 0.35, 0.29))
    style_axis(first_ax)
    first_ax.set_xlim(0, 59)
    first_ax.set_ylim(-0.55, 3.55)
    first_ax.set_xticks([0, 20, 40, 60])
    first_ax.set_xticklabels(["0", "20k", "40k", "60k"])
    first_ax.set_yticks([ROWS[condition] for condition in ORDER])
    first_ax.set_yticklabels([DISPLAY[condition] for condition in ORDER])
    first_ax.grid(axis="x", color=PALE, lw=0.7)
    first_ax.set_title(
        "First prompt: cache read + uncached input",
        loc="left",
        fontsize=10.3,
        weight="semibold",
        color=INK,
        pad=14,
    )
    for condition in ORDER:
        y = ROWS[condition]
        means = data["condition_stats"][condition]["means"]
        cache = means["first_cache_read"] / 1000
        uncached = means["first_input"] / 1000
        first_ax.barh(y, cache, height=0.20, color=ACCENT_PALE, edgecolor="none")
        first_ax.barh(
            y,
            uncached,
            left=cache,
            height=0.20,
            color=COLORS[condition],
            edgecolor="none",
        )
        first_ax.text(
            cache + uncached + 0.8,
            y,
            f"{cache + uncached:.1f}k",
            fontsize=8.2,
            color=INK,
            va="center",
        )
    raw_first = data["condition_stats"]["raw"]["means"]
    raw_cache = raw_first["first_cache_read"] / 1000
    raw_input = raw_first["first_input"] / 1000
    first_ax.text(
        raw_cache / 2,
        ROWS["raw"],
        f"{raw_cache:.1f}k cache",
        fontsize=7.0,
        color=ACCENT,
        ha="center",
        va="center",
    )
    first_ax.text(
        raw_cache + raw_input / 2,
        ROWS["raw"],
        f"{raw_input:.1f}k input",
        fontsize=7.0,
        color=WHITE,
        ha="center",
        va="center",
    )

    cumulative_ax = fig.add_axes((0.60, 0.49, 0.32, 0.29))
    style_axis(cumulative_ax)
    cumulative_ax.set_xlim(0, 4.35)
    cumulative_ax.set_ylim(-0.55, 3.55)
    cumulative_ax.set_xticks([0, 1, 2, 3, 4])
    cumulative_ax.set_xticklabels(["0", "1M", "2M", "3M", "4M"])
    cumulative_ax.set_yticks([])
    cumulative_ax.grid(axis="x", color=PALE, lw=0.7)
    cumulative_ax.set_title(
        "Cumulative prompt tokens per run",
        loc="left",
        fontsize=10.3,
        weight="semibold",
        color=INK,
        pad=14,
    )
    raw_cumulative = data["condition_stats"]["raw"]["means"]["cumulative_prompt"]
    for condition in ORDER:
        y = ROWS[condition]
        value = data["condition_stats"][condition]["means"]["cumulative_prompt"]
        cumulative_ax.hlines(y, 0, value / 1_000_000, color=HAIRLINE, lw=1)
        cumulative_ax.scatter(
            value / 1_000_000, y, color=COLORS[condition], s=34, zorder=3
        )
        reduction = (raw_cumulative - value) / raw_cumulative * 100
        label = (
            f"{value / 1_000_000:.2f}M"
            if condition == "raw"
            else f"{value / 1_000_000:.2f}M  −{reduction:.1f}%"
        )
        cumulative_ax.text(
            value / 1_000_000 + 0.07,
            y,
            label,
            fontsize=8.1,
            color=COLORS[condition],
            va="center",
        )

    fig.text(
        0.065,
        0.405,
        "CACHE AND COST TOTALS",
        fontsize=8.2,
        color=MUTED,
        weight="semibold",
    )

    cost_ax = fig.add_axes((0.065, 0.305, 0.55, 0.06))
    style_axis(cost_ax)
    shares = data["pooled"]["cost_shares"]
    segments = [
        ("cache reads", shares["cache_read"], ACCENT),
        ("uncached input", shares["input"], INK),
        ("output", shares["output"], "#A2A9B0"),
    ]
    left = 0.0
    for name, share, color in segments:
        cost_ax.barh(0, share * 100, left=left, height=0.32, color=color)
        cost_ax.text(
            left + share * 50,
            0,
            f"{name}\n{share * 100:.1f}%",
            color=WHITE,
            fontsize=7.6,
            ha="center",
            va="center",
        )
        left += share * 100
    cost_ax.set_xlim(0, 100)
    cost_ax.set_ylim(-0.3, 0.3)
    cost_ax.set_xticks([])
    cost_ax.set_yticks([])

    callouts = [
        (
            0.065,
            "99.82%",
            "cache-read incidence",
            "1,118 of 1,120 turns had cacheRead > 0.",
            ACCENT,
        ),
        (
            0.37,
            "66.1M",
            "cached prompt tokens",
            "Cached tokens were 97.2% of prompt volume.",
            INK,
        ),
        (
            0.675,
            "$0.50",
            "cold-cache premium",
            "Two cold turns; no quality inference.",
            RISK,
        ),
    ]
    for x, number, label, body, color in callouts:
        fig.text(x, 0.245, number, fontsize=21, color=color, weight="semibold")
        fig.text(x, 0.213, label, fontsize=9.3, color=INK, weight="semibold")
        fig.text(
            x,
            0.174,
            fill(body, 40),
            fontsize=8.4,
            color=MUTED,
            linespacing=1.35,
            va="top",
        )

    fig.text(
        0.065,
        0.105,
        "Cached tokens were discounted—not free—and still consumed context capacity on every turn.",
        fontsize=11.0,
        color=INK,
        weight="semibold",
    )
    add_footer(
        fig,
        "A ‘hit’ here means cacheRead > 0; provider usage exposes no attempted-cache or explicit miss counter.",
    )
    pdf.savefig(fig, facecolor=WHITE)
    plt.close(fig)


def page_lifecycle(pdf: PdfPages, data: dict, runs: pd.DataFrame) -> None:
    fig = plt.figure(figsize=(11, 8.5), facecolor=WHITE)
    add_header(
        fig,
        "Initial savings decayed; run stochasticity dominated quality",
        "Lifecycle context reduction, continuation economics, and quality-cost overlap",
        2,
    )

    lifecycle_ax = fig.add_axes((0.09, 0.49, 0.37, 0.29))
    style_axis(lifecycle_ax)
    stages = ["First prompt", "Final prompt", "Cumulative"]
    x = [0, 1, 2]
    lifecycle_ax.set_xlim(-0.12, 2.12)
    lifecycle_ax.set_ylim(0, 58)
    lifecycle_ax.set_xticks(x)
    lifecycle_ax.set_xticklabels(stages)
    lifecycle_ax.set_yticks([0, 20, 40, 60])
    lifecycle_ax.set_yticklabels(["0%", "20%", "40%", "60%"])
    lifecycle_ax.grid(axis="y", color=PALE, lw=0.7)
    lifecycle_ax.set_title(
        "Reduction versus raw over the trajectory",
        loc="left",
        fontsize=10.3,
        weight="semibold",
        color=INK,
        pad=14,
    )
    raw = data["condition_stats"]["raw"]["means"]
    for condition in ORDER[1:]:
        means = data["condition_stats"][condition]["means"]
        values = [
            (raw["first_prompt"] - means["first_prompt"]) / raw["first_prompt"] * 100,
            (raw["last_prompt"] - means["last_prompt"]) / raw["last_prompt"] * 100,
            (raw["cumulative_prompt"] - means["cumulative_prompt"])
            / raw["cumulative_prompt"]
            * 100,
        ]
        lifecycle_ax.plot(x, values, color=COLORS[condition], lw=1.5, marker="o", ms=4)
        lifecycle_ax.text(
            2.05,
            values[-1],
            DISPLAY[condition],
            fontsize=8.0,
            color=COLORS[condition],
            va="center",
        )

    scatter_ax = fig.add_axes((0.56, 0.49, 0.37, 0.29))
    style_axis(scatter_ax)
    scatter_ax.set_xlim(1.55, 3.65)
    scatter_ax.set_ylim(11, 21)
    scatter_ax.set_xticks([1.5, 2.0, 2.5, 3.0, 3.5])
    scatter_ax.set_xticklabels(["$1.50", "$2.00", "$2.50", "$3.00", "$3.50"])
    scatter_ax.set_yticks([12, 14, 16, 18, 20])
    scatter_ax.grid(color=PALE, lw=0.7)
    scatter_ax.set_title(
        "Run-level quality versus continuation cost",
        loc="left",
        fontsize=10.3,
        weight="semibold",
        color=INK,
        pad=14,
    )
    for condition in ORDER:
        subset = runs[runs.condition == condition]
        scatter_ax.scatter(
            subset.provider_cost,
            subset.hidden_passed,
            s=34,
            facecolor=WHITE,
            edgecolor=COLORS[condition],
            linewidth=1.2,
        )
        scatter_ax.scatter(
            subset.provider_cost.mean(),
            subset.hidden_passed.mean(),
            marker="D",
            s=35,
            color=COLORS[condition],
            zorder=4,
        )
    scatter_ax.text(1.72, 15.0, "manifest mean", fontsize=7.8, color=ACCENT)
    scatter_ax.text(2.91, 16.9, "raw mean", fontsize=7.8, color=INK)
    scatter_ax.text(
        1.58, 20.65, "hollow: runs   diamond: mean", fontsize=7.4, color=MUTED
    )

    fig.text(
        0.065,
        0.415,
        "ONE-SHOT END-TO-END ECONOMICS",
        fontsize=8.2,
        color=MUTED,
        weight="semibold",
    )
    columns = [0.065, 0.28, 0.49, 0.70]
    for x_pos, condition in zip(columns, ORDER, strict=True):
        one_shot = data["one_shot_end_to_end"][condition]
        continuation = data["condition_stats"][condition]["means"]
        seal_cost = one_shot["cost"] - continuation["provider_cost"]
        seal_time = one_shot["elapsed_minutes"] - continuation["elapsed_minutes"]
        fig.text(
            x_pos,
            0.365,
            DISPLAY[condition],
            fontsize=9.0,
            color=COLORS[condition],
            weight="semibold",
        )
        fig.text(
            x_pos,
            0.327,
            f"${one_shot['cost']:.2f}",
            fontsize=17,
            color=INK,
            weight="semibold",
        )
        fig.text(
            x_pos,
            0.298,
            f"{one_shot['elapsed_minutes']:.2f}m",
            fontsize=9.0,
            color=MUTED,
        )
        if condition != "raw":
            fig.text(
                x_pos,
                0.268,
                f"seal: +${seal_cost:.2f}, +{seal_time:.2f}m",
                fontsize=7.5,
                color=MUTED,
            )

    fig.add_artist(
        Line2D(
            [0.065, 0.935],
            [0.235, 0.235],
            transform=fig.transFigure,
            color=HAIRLINE,
            lw=0.7,
        )
    )
    findings = [
        (
            0.065,
            "9.0%",
            "score variance explained by treatment",
            "ANOVA p=.669; treatment means are not resolved.",
            RISK,
        ),
        (
            0.37,
            "−30.0%",
            "manifest cumulative prompt",
            "Initial: 52.9%. Reconstruction reduced lifecycle savings.",
            ACCENT,
        ),
        (
            0.675,
            "K ≥ 2",
            "manifest time break-even",
            "Two continuations amortize 1.80m seal latency.",
            INK,
        ),
    ]
    for x_pos, number, label, body, color in findings:
        fig.text(x_pos, 0.185, number, fontsize=20, color=color, weight="semibold")
        fig.text(x_pos, 0.154, label, fontsize=9.0, color=INK, weight="semibold")
        fig.text(
            x_pos,
            0.118,
            fill(body, 42),
            fontsize=8.2,
            color=MUTED,
            linespacing=1.3,
            va="top",
        )

    add_footer(
        fig,
        "Continuation means exclude seal overhead; the one-shot row adds measured treatment derivation once.",
    )
    pdf.savefig(fig, facecolor=WHITE)
    plt.close(fig)


def page_methods(pdf: PdfPages) -> None:
    fig = plt.figure(figsize=(11, 8.5), facecolor=WHITE)
    add_header(
        fig,
        "One continuation task, four isolated context treatments",
        "What the corrected experiment measured—and what it could not measure",
        3,
    )

    fig.text(0.065, 0.800, "COMMON START", fontsize=8.2, color=MUTED, weight="semibold")
    fig.text(
        0.065,
        0.755,
        "Verified S1 checkpoint: transient Bloomberg request workflow implemented; CLI integration intentionally unfinished.",
        fontsize=11.0,
        color=INK,
        weight="semibold",
    )
    fig.text(
        0.065,
        0.720,
        "Identical filesystem seed, todo state, continuation prompt, model, tools, evaluator, and canonical cwd.",
        fontsize=8.8,
        color=MUTED,
    )
    fig.add_artist(
        Line2D(
            [0.065, 0.935],
            [0.690, 0.690],
            transform=fig.transFigure,
            color=HAIRLINE,
            lw=0.7,
        )
    )

    treatments = [
        (
            0.065,
            "RAW",
            "120 messages · 54.0k",
            "Untreated user, assistant, and tool trajectory.",
            INK,
        ),
        (
            0.285,
            "SCOPED SHAKE",
            "120 messages · 35.7k",
            "51 tool payloads elided; chronology retained.",
            RISK,
        ),
        (
            0.505,
            "REPORT ONLY",
            "6 messages · 25.2k",
            "Semantic handoff without runtime provenance.",
            "#8A929A",
        ),
        (
            0.725,
            "REPORT + MANIFEST",
            "7 messages · 25.4k",
            "The same report plus 198 provenance tokens.",
            ACCENT,
        ),
    ]
    for x_pos, kicker, metric, body, color in treatments:
        fig.text(x_pos, 0.645, kicker, fontsize=7.5, color=color, weight="semibold")
        fig.text(x_pos, 0.612, metric, fontsize=10.0, color=INK, weight="semibold")
        fig.text(
            x_pos,
            0.575,
            fill(body, 29),
            fontsize=8.0,
            color=MUTED,
            linespacing=1.28,
            va="top",
        )

    fig.text(
        0.205,
        0.490,
        "same CLI continuation task",
        fontsize=10.0,
        color=INK,
        weight="semibold",
        ha="center",
    )
    fig.text(0.405, 0.490, ">", fontsize=14, color=ACCENT, ha="center", va="center")
    fig.text(
        0.585,
        0.490,
        "21 hidden contracts",
        fontsize=10.0,
        color=INK,
        weight="semibold",
        ha="center",
    )
    fig.text(0.745, 0.490, ">", fontsize=14, color=ACCENT, ha="center", va="center")
    fig.text(
        0.850,
        0.490,
        "cost · time · tokens",
        fontsize=10.0,
        color=INK,
        weight="semibold",
        ha="center",
    )

    fig.add_artist(
        Line2D(
            [0.065, 0.935],
            [0.445, 0.445],
            transform=fig.transFigure,
            color=HAIRLINE,
            lw=0.7,
        )
    )
    fig.text(
        0.065, 0.410, "WHAT IT MEASURES", fontsize=8.2, color=MUTED, weight="semibold"
    )
    fig.text(0.53, 0.410, "BLIND SPOTS", fontsize=8.2, color=MUTED, weight="semibold")
    measured = [
        "Continuation behavior conditional on one shared implementation checkpoint.",
        "Repository grounding, editing, repair, and exact CLI output contracts.",
        "First/final/cumulative context, provider cost, tools, and hidden behavior.",
    ]
    blind = [
        "One Python task, repository, evaluator, model, provider, and price regime.",
        "One generated semantic seal and one Shake derivation reused five times.",
        "Warm shared prefixes; no TTFT, live Bloomberg, external effects, or multi-agent work.",
    ]
    y = 0.370
    for item in measured:
        fig.text(0.075, y, "•", fontsize=8.2, color=ACCENT, va="top")
        fig.text(0.090, y, fill(item, 61), fontsize=8.1, color=MUTED, va="top")
        y -= 0.055
    y = 0.370
    for item in blind:
        fig.text(0.540, y, "•", fontsize=8.2, color=RISK, va="top")
        fig.text(0.555, y, fill(item, 61), fontsize=8.1, color=MUTED, va="top")
        y -= 0.055

    fig.add_artist(
        Line2D(
            [0.065, 0.935],
            [0.220, 0.220],
            transform=fig.transFigure,
            color=HAIRLINE,
            lw=0.7,
        )
    )
    fig.text(
        0.065,
        0.185,
        "HIGHEST-LEVERAGE METHOD UPGRADES",
        fontsize=8.2,
        color=MUTED,
        weight="semibold",
    )
    upgrades = [
        (
            0.065,
            "Nested seal replication",
            "Several reports per task and continuations per report separate handoff variance from run variance.",
        ),
        (
            0.36,
            "More tasks before more repeats",
            "Block debugging, migration, feature, and research tasks; estimate task effects.",
        ),
        (
            0.655,
            "Pre-register and instrument",
            "Predefine quality floors, cache/TTFT, invalidation, and one-shot economics.",
        ),
    ]
    for x_pos, heading, body in upgrades:
        fig.text(x_pos, 0.145, heading, fontsize=9.1, color=INK, weight="semibold")
        fig.text(
            x_pos,
            0.112,
            fill(body, 43),
            fontsize=7.8,
            color=MUTED,
            va="top",
            linespacing=1.28,
        )

    add_footer(
        fig,
        "Provider turns are nested observations; the experimental unit is a complete continuation run.",
    )
    pdf.savefig(fig, facecolor=WHITE)
    plt.close(fig)


def page_roadmap(pdf: PdfPages) -> None:
    fig = plt.figure(figsize=(11, 8.5), facecolor=WHITE)
    add_header(
        fig,
        "Use the result to narrow the product—and broaden the research",
        "Product modes, prioritized research, and an automated evidence pipeline",
        4,
    )

    fig.text(
        0.065, 0.800, "PRODUCT MODES", fontsize=8.2, color=MUTED, weight="semibold"
    )
    modes = [
        (
            0.065,
            "SAFETY DEFAULT",
            "Raw / keep",
            "Strongest observed floor. Prefer when exact trajectory detail is load-bearing or cache is cheap and window pressure is low.",
            INK,
        ),
        (
            0.36,
            "CONTEXT PRESSURE",
            "Report + manifest",
            "Best mean quality-cost frontier. Prefer for long remaining work, handoff, or branch fan-out; disclose seal overhead.",
            ACCENT,
        ),
        (
            0.655,
            "CHRONOLOGY REQUIRED",
            "Scoped Shake",
            "Retains all message structure. Do not market as the general efficiency mode; it did not beat the semantic candidate here.",
            RISK,
        ),
    ]
    for x_pos, kicker, heading, body, color in modes:
        fig.text(x_pos, 0.755, kicker, fontsize=7.6, color=color, weight="semibold")
        fig.text(x_pos, 0.717, heading, fontsize=13.0, color=INK, weight="semibold")
        fig.text(
            x_pos,
            0.676,
            fill(body, 42),
            fontsize=8.5,
            color=MUTED,
            linespacing=1.35,
            va="top",
        )

    fig.add_artist(
        Line2D(
            [0.065, 0.935],
            [0.600, 0.600],
            transform=fig.transFigure,
            color=HAIRLINE,
            lw=0.7,
        )
    )
    fig.text(
        0.065,
        0.565,
        "PRIORITIZED RESEARCH",
        fontsize=8.2,
        color=MUTED,
        weight="semibold",
    )

    rows = [
        (
            "P0",
            "Cold/warm cache probes",
            "4 conditions × 2 cache states × 3 short probes",
            "Calibrate cache continuity, TTFT, and true first-turn economics.",
        ),
        (
            "P1",
            "Multi-task external validity",
            "4 task types × 4 treatments × 3 replicates",
            "Estimate task-level effects; pre-register quality floor and end-to-end cost.",
        ),
        (
            "P1",
            "Manifest ablation",
            "Report, minimal manifest, evidence manifest, full manifest",
            "Identify which approximately 198 structured tokens reduce rediscovery.",
        ),
        (
            "P1",
            "Verification-floor gate",
            "Raw/manifest × normal/required evidence × 5",
            "Test whether mandatory repair loops remove low-cost, low-score tails.",
        ),
        (
            "P2",
            "Lifecycle and retrieval",
            "Single seal, re-seal, threshold re-seal, artifact retrieval",
            "Measure context regrowth without compounding semantic omission.",
        ),
        (
            "P2",
            "Fan-out amortization",
            "One seal feeding K=1, 2, 4 continuations",
            "Measure actual branch cache behavior and seal break-even.",
        ),
    ]
    y = 0.520
    for priority, question, design, decision in rows:
        fig.text(
            0.065,
            y,
            priority,
            fontsize=8.2,
            color=ACCENT if priority == "P1" else INK,
            weight="semibold",
        )
        fig.text(0.115, y, question, fontsize=9.0, color=INK, weight="semibold")
        fig.text(0.36, y, design, fontsize=8.1, color=MUTED)
        fig.text(
            0.655,
            y,
            fill(decision, 47),
            fontsize=8.1,
            color=MUTED,
            va="top",
            linespacing=1.25,
        )
        fig.add_artist(
            Line2D(
                [0.065, 0.935],
                [y - 0.035, y - 0.035],
                transform=fig.transFigure,
                color=PALE,
                lw=0.7,
            )
        )
        y -= 0.070

    fig.text(
        0.065,
        0.095,
        "AUTOMATE THE EVIDENCE",
        fontsize=8.2,
        color=RISK,
        weight="semibold",
    )
    fig.text(
        0.23,
        0.095,
        "events > validity gates > typed tables > versioned metrics > pre-registered statistics > reports and dashboards. Never auto-seal from todo completion alone.",
        fontsize=8.5,
        color=INK,
        va="center",
    )

    add_footer(
        fig,
        "Next data should span more tasks before adding many repetitions to this one Bloomberg continuation.",
    )
    pdf.savefig(fig, facecolor=WHITE)
    plt.close(fig)


def main() -> None:
    data = json.loads(ANALYSIS_PATH.read_text(encoding="utf-8"))
    runs = pd.read_csv(RUNS_PATH)
    if data["valid_runs"] != 20 or len(runs) != 20:
        raise ValueError("deep report requires exactly 20 valid isolated runs")

    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": [
                "Avenir Next",
                "Helvetica Neue",
                "Arial",
                "DejaVu Sans",
            ],
            "pdf.fonttype": 42,
            "axes.unicode_minus": True,
            "figure.dpi": 144,
            "savefig.dpi": 144,
        }
    )
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with PdfPages(
        OUTPUT_PATH,
        metadata={
            "Title": "Checkpoint Seal Bloomberg Quantitative Analysis",
            "Author": "Oh My Pi experiment",
            "Subject": "Cache, cost, correlation, lifecycle, and product research analysis",
            "Keywords": "checkpoint, cache, cost, Shake, manifest, experiment, product research",
        },
    ) as pdf:
        page_cache(pdf, data)
        page_lifecycle(pdf, data, runs)
        page_methods(pdf)
        page_roadmap(pdf)
    print(OUTPUT_PATH)


if __name__ == "__main__":
    main()
