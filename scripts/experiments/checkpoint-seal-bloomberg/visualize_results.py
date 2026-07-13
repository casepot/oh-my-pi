#!/usr/bin/env python3
"""Generate the corrected two-page checkpoint-seal findings report."""

from __future__ import annotations

import json
from pathlib import Path
from textwrap import fill

import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.lines import Line2D

ROOT = Path(__file__).resolve().parents[3]
EXPERIMENT_ROOT = Path(
    "/Users/case/experiments/checkpoint-seal-bloomberg-clean-v2-0.144.1-medium"
)
DATA_PATH = EXPERIMENT_ROOT / "analysis/aggregate.json"
OUTPUT_PATH = ROOT / "docs/execution-plans/checkpoint-seal-bloomberg/findings.pdf"

INK = "#20252B"
MUTED = "#68717C"
HAIRLINE = "#D8DDE2"
PALE = "#EEF1F3"
ACCENT = "#1E6F8C"
RISK = "#A14D3D"
WHITE = "#FFFFFF"

ORDER = ["raw", "shake", "report-only", "report+manifest"]
DISPLAY_NAMES = {
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
ROWS = {key: 3 - index for index, key in enumerate(ORDER)}


def load_data() -> dict:
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def metric(data: dict, condition: str, name: str) -> dict:
    return data["conditions"][condition][name]


def style_axis(ax: plt.Axes) -> None:
    ax.set_facecolor(WHITE)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.tick_params(axis="both", colors=MUTED, labelsize=8.4, length=0, pad=5)
    ax.set_axisbelow(True)


def add_header(fig: plt.Figure, title: str, subtitle: str, page: int) -> None:
    fig.text(0.065, 0.925, title, fontsize=22, weight="semibold", color=INK, va="top")
    fig.text(0.065, 0.875, subtitle, fontsize=9.4, color=MUTED, va="top")
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
    fig.text(0.065, 0.035, text, fontsize=7.1, color=MUTED, va="center")


def page_one(pdf: PdfPages, data: dict) -> None:
    fig = plt.figure(figsize=(11, 8.5), facecolor=WHITE)
    add_header(
        fig,
        "Raw kept the strongest floor; the manifest halved context",
        "Corrected isolated Bloomberg continuation experiment  ·  five runs per condition  ·  21 hidden contracts",
        1,
    )

    context_ax = fig.add_axes((0.13, 0.41, 0.34, 0.35))
    style_axis(context_ax)
    context_ax.set_xlim(0, 59)
    context_ax.set_ylim(-0.55, 3.55)
    context_ax.set_xticks([0, 20, 40, 60])
    context_ax.set_xticklabels(["0", "20k", "40k", "60k"])
    context_ax.set_yticks([])
    context_ax.grid(axis="x", color=PALE, lw=0.7)
    context_ax.set_title(
        "First continuation prompt",
        loc="left",
        fontsize=10.5,
        weight="semibold",
        color=INK,
        pad=16,
    )

    for condition in ORDER:
        y = ROWS[condition]
        value = metric(data, condition, "prompt_tokens")["mean"] / 1000
        color = COLORS[condition]
        context_ax.hlines(y, 0, value, color=HAIRLINE, lw=1.0)
        context_ax.scatter(
            value,
            y,
            s=42 if condition == "report+manifest" else 30,
            color=color,
            zorder=3,
        )
        context_ax.text(
            -1.2,
            y,
            DISPLAY_NAMES[condition],
            fontsize=9.2,
            color=color if condition == "report+manifest" else INK,
            ha="right",
            va="center",
            weight="semibold" if condition == "report+manifest" else "normal",
        )
        context_ax.text(
            value + 0.9,
            y,
            f"{value:.1f}k",
            fontsize=8.5,
            color=color,
            ha="left",
            va="center",
            weight="semibold" if condition == "report+manifest" else "normal",
        )

    manifest_reduction = data["prompt_reduction_vs_raw"]["report+manifest"]["percent"]
    context_ax.annotate(
        f"−{manifest_reduction:.1f}% vs raw",
        xy=(
            metric(data, "report+manifest", "prompt_tokens")["mean"] / 1000,
            ROWS["report+manifest"],
        ),
        xytext=(38, ROWS["report+manifest"] - 0.40),
        color=ACCENT,
        fontsize=8.5,
        ha="center",
        arrowprops={"arrowstyle": "-", "color": ACCENT, "lw": 0.8},
    )

    score_ax = fig.add_axes((0.56, 0.41, 0.37, 0.35))
    style_axis(score_ax)
    score_ax.set_xlim(11.3, 20.7)
    score_ax.set_ylim(-0.55, 3.55)
    score_ax.set_xticks([12, 14, 16, 18, 20])
    score_ax.set_yticks([])
    score_ax.grid(axis="x", color=PALE, lw=0.7)
    score_ax.set_title(
        "Hidden contracts passed  (each dot is one run)",
        loc="left",
        fontsize=10.5,
        weight="semibold",
        color=INK,
        pad=16,
    )

    offsets = [-0.16, -0.08, 0.0, 0.08, 0.16]
    for condition in ORDER:
        y = ROWS[condition]
        values = metric(data, condition, "hidden_passed")["values"]
        mean = metric(data, condition, "hidden_passed")["mean"]
        color = COLORS[condition]
        for value, offset in zip(values, offsets, strict=True):
            score_ax.scatter(
                value,
                y + offset,
                s=27,
                facecolor=WHITE,
                edgecolor=color,
                linewidth=1.2,
                zorder=3,
            )
        score_ax.scatter(
            mean, y, marker="|", s=130, color=color, linewidth=1.8, zorder=4
        )
        score_ax.text(
            20.62,
            y,
            f"mean {mean:.1f}",
            fontsize=8.5,
            color=color,
            ha="right",
            va="center",
            weight="semibold" if condition in {"raw", "report+manifest"} else "normal",
        )

    fig.text(
        0.065,
        0.325,
        "WHAT THE CORRECTED RUNS SHOWED",
        fontsize=8.2,
        color=MUTED,
        weight="semibold",
    )
    raw_mean = metric(data, "raw", "hidden_passed")["mean"]
    manifest_mean = metric(data, "report+manifest", "hidden_passed")["mean"]
    shake_reduction = data["prompt_reduction_vs_raw"]["shake"]["percent"]
    callouts = [
        (
            0.065,
            f"{manifest_reduction:.1f}%",
            "less context",
            "Report + manifest removed 28,569 prompt tokens while retaining a 16.0/21 mean.",
            ACCENT,
        ),
        (
            0.36,
            f"{raw_mean:.1f} · {manifest_mean:.1f}",
            "raw · manifest means",
            "Raw kept the strongest floor: 16. Manifest ranged from 14 to 20.",
            INK,
        ),
        (
            0.655,
            f"{shake_reduction:.1f}%",
            "Shake reduction",
            "Shake kept all 120 messages and ranged from 12 to 20 contracts.",
            RISK,
        ),
    ]
    for x, number, label, body, color in callouts:
        fig.text(
            x, 0.258, number, fontsize=21, color=color, weight="semibold", va="baseline"
        )
        fig.text(x, 0.225, label, fontsize=9.5, color=INK, weight="semibold")
        fig.text(
            x,
            0.187,
            fill(body, 45),
            fontsize=8.6,
            color=MUTED,
            linespacing=1.35,
            va="top",
        )

    fig.text(
        0.065,
        0.105,
        "Decision: raw is the safety default; report + manifest is the explicit context-pressure option.",
        fontsize=11.2,
        color=INK,
        weight="semibold",
    )
    add_footer(
        fig,
        "Protocol v2 · physically isolated sessions · first-provider-prompt measurement · gpt-5.6-sol, medium · Codex CLI 0.144.1.",
    )
    pdf.savefig(fig, facecolor=WHITE)
    plt.close(fig)


def replicate_panel(
    fig: plt.Figure,
    position: tuple[float, float, float, float],
    data: dict,
    metric_name: str,
    title: str,
    limits: tuple[float, float],
    ticks: list[float],
    formatter,
    show_labels: bool,
) -> None:
    ax = fig.add_axes(position)
    style_axis(ax)
    ax.set_xlim(*limits)
    ax.set_ylim(-0.45, 3.45)
    ax.set_xticks(ticks)
    ax.set_yticks([ROWS[key] for key in ORDER])
    ax.set_yticklabels([DISPLAY_NAMES[key] if show_labels else "" for key in ORDER])
    ax.grid(axis="x", color=PALE, lw=0.7)
    ax.set_title(title, loc="left", fontsize=10.1, weight="semibold", color=INK, pad=13)

    offsets = [-0.13, -0.065, 0.0, 0.065, 0.13]
    for condition in ORDER:
        y = ROWS[condition]
        values = metric(data, condition, metric_name)["values"]
        mean = metric(data, condition, metric_name)["mean"]
        color = COLORS[condition]
        for value, offset in zip(values, offsets, strict=True):
            ax.scatter(
                value,
                y + offset,
                s=21,
                facecolor=WHITE,
                edgecolor=color,
                linewidth=1.0,
                zorder=3,
            )
        ax.scatter(mean, y, marker="|", s=120, color=color, linewidth=1.8, zorder=4)
        ax.text(
            limits[1],
            y + 0.22,
            formatter(mean),
            fontsize=7.8,
            color=color,
            ha="right",
            va="bottom",
            weight="semibold" if condition == "report+manifest" else "normal",
        )


def page_two(pdf: PdfPages, data: dict) -> None:
    fig = plt.figure(figsize=(11, 8.5), facecolor=WHITE)
    add_header(
        fig,
        "Report + manifest bought the most context per unit of work",
        "Corrected five-replicate workload and cost comparison",
        2,
    )

    replicate_panel(
        fig,
        (0.12, 0.50, 0.24, 0.25),
        data,
        "tool_calls",
        "Tool calls",
        (38, 73),
        [40, 50, 60, 70],
        lambda value: f"{value:.1f}",
        True,
    )
    replicate_panel(
        fig,
        (0.43, 0.50, 0.22, 0.25),
        data,
        "elapsed_minutes",
        "Elapsed minutes",
        (4.5, 13.5),
        [5, 7, 9, 11, 13],
        lambda value: f"{value:.2f}m",
        False,
    )
    replicate_panel(
        fig,
        (0.72, 0.50, 0.22, 0.25),
        data,
        "provider_cost_usd",
        "Provider cost",
        (1.5, 3.7),
        [1.5, 2.0, 2.5, 3.0, 3.5],
        lambda value: f"${value:.2f}",
        False,
    )

    fig.text(
        0.065,
        0.435,
        "Report + manifest used the fewest mean tools, finished fastest, and cost least in these runs.",
        fontsize=10.4,
        color=INK,
        weight="semibold",
    )
    fig.text(
        0.065,
        0.402,
        "Scoped Shake reduced prompt size, but required the most work and had the widest correctness spread.",
        fontsize=9.2,
        color=MUTED,
    )

    fig.add_artist(
        Line2D(
            [0.065, 0.935],
            [0.37, 0.37],
            transform=fig.transFigure,
            color=HAIRLINE,
            lw=0.7,
        )
    )
    fig.text(
        0.065, 0.335, "PRODUCT DECISION", fontsize=8.2, color=MUTED, weight="semibold"
    )

    decisions = [
        (
            0.065,
            "SAFETY DEFAULT",
            "Keep raw history",
            "Highest mean (16.8), strongest floor (16). Preserve load-bearing trajectory detail.",
            INK,
        ),
        (
            0.36,
            "CONTEXT PRESSURE",
            "Report + manifest",
            "52.9% smaller prompt, 16.0 mean, 14 minimum, and the best observed workload and cost profile.",
            ACCENT,
        ),
        (
            0.655,
            "SPECIAL CASE",
            "Scoped Shake",
            "Use when chronology must stay visible. It saved 34.0%, but did not beat the semantic candidate here.",
            RISK,
        ),
    ]
    for x, kicker, heading, body, color in decisions:
        fig.text(x, 0.295, kicker, fontsize=7.7, color=color, weight="semibold")
        fig.text(x, 0.258, heading, fontsize=13.0, color=INK, weight="semibold")
        fig.text(
            x,
            0.218,
            fill(body, 42),
            fontsize=8.6,
            color=MUTED,
            linespacing=1.35,
            va="top",
        )

    fig.text(
        0.065, 0.137, "QUALIFICATIONS", fontsize=8.2, color=MUTED, weight="semibold"
    )
    notes = [
        "All 20 valid runs passed the offline suite, Ruff, basedpyright, and ty in the external evaluator.",
        "Every run missed the same server-not-tested/schema-hash contract; relative differences remain visible, but absolute scores are capped.",
        "Five runs per arm and one task archetype support a directional decision—not automatic default promotion.",
        "One cwd-mismatch setup pilot and one provider-timeout attempt were rejected, retained separately, and excluded before aggregation.",
    ]
    y = 0.112
    for note in notes:
        fig.text(0.075, y, "•", fontsize=8.2, color=ACCENT, va="top")
        fig.text(0.088, y, note, fontsize=7.55, color=MUTED, va="top")
        y -= 0.020

    add_footer(
        fig,
        "Source: checkpoint-seal-bloomberg-clean-v2-0.144.1-medium/analysis/aggregate.json · 20 valid runs.",
    )
    pdf.savefig(fig, facecolor=WHITE)
    plt.close(fig)


def main() -> None:
    data = load_data()
    if data["valid_runs"] != 20:
        raise ValueError(f"expected 20 valid runs, found {data['valid_runs']}")
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

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

    with PdfPages(
        OUTPUT_PATH,
        metadata={
            "Title": "Corrected Checkpoint Seal Bloomberg Experiment Findings",
            "Author": "Oh My Pi experiment",
            "Subject": "Isolated comparison of raw, Shake, report, and report-plus-manifest context",
            "Keywords": "checkpoint, semantic compression, Shake, Bloomberg, corrected experiment",
        },
    ) as pdf:
        page_one(pdf, data)
        page_two(pdf, data)

    print(OUTPUT_PATH)


if __name__ == "__main__":
    main()
