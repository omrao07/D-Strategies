#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
credit_card_spending_sector.py
================================
Second Measure-style credit card sector spending data → consumer stock signals.

What it does
------------
Processes anonymized credit card spend indices by sector (restaurants, apparel, travel,
electronics, etc.). Computes spend momentum (month-over-month acceleration in YoY growth),
identifies sectors with accelerating vs decelerating spend trends, and generates monthly
rebalance signals: long sectors with accelerating consumer spending, short sectors with
decelerating or contracting spend. Includes cross-sectional ranking for portfolio
construction.

Inputs (CSV format)
-------------------
cc_spend.csv
    date        : YYYY-MM-DD (monthly, first of month)
    sector      : str — e.g. restaurants, apparel, travel, electronics, grocery
    spend_index : float — indexed spending level (100 = base period)
    yoy_growth  : float — year-over-year growth rate (decimal, e.g. 0.12 = 12%)

CLI
---
    python credit_card_spending_sector.py \\
        --spend cc_spend.csv \\
        --outdir ./output \\
        --momentum-window 3 \\
        --top-n 3 \\
        --short-n 3 \\
        --rebalance-freq monthly

Outputs
-------
    outdir/spend_momentum.csv  — date, sector, yoy_growth, momentum, rank, signal
    outdir/portfolio.csv       — date, long_sectors, short_sectors, sector_weights
    outdir/summary.json        — signal counts, sector coverage, momentum stats
"""

import argparse
import json
import os
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=FutureWarning)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_spend_data(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "sector", "spend_index", "yoy_growth"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"cc_spend CSV missing columns: {missing}")
    df["sector"] = df["sector"].str.lower().str.strip()
    df["spend_index"] = pd.to_numeric(df["spend_index"], errors="coerce")
    df["yoy_growth"] = pd.to_numeric(df["yoy_growth"], errors="coerce")
    df = df.dropna(subset=["spend_index", "yoy_growth"])
    # Align to monthly frequency
    df["date"] = df["date"].dt.to_period("M").dt.to_timestamp()
    return df.sort_values(["sector", "date"]).reset_index(drop=True)


# ---------------------------------------------------------------------------
# Signal computation
# ---------------------------------------------------------------------------

def compute_momentum(df: pd.DataFrame, window: int) -> pd.DataFrame:
    """
    Momentum = change in YoY growth rate over `window` months.
    Positive momentum = accelerating spend (bullish).
    Negative momentum = decelerating spend (bearish).
    """
    records = []
    for sector, group in df.groupby("sector"):
        group = group.copy().sort_values("date")
        group["momentum"] = group["yoy_growth"].diff(window)
        group["momentum_z"] = (
            (group["momentum"] - group["momentum"].rolling(12, min_periods=3).mean())
            / group["momentum"].rolling(12, min_periods=3).std().replace(0, np.nan)
        )
        group["spend_accel"] = group["spend_index"].pct_change(window)
        records.append(group)
    return pd.concat(records, ignore_index=True)


def rank_sectors_monthly(df: pd.DataFrame) -> pd.DataFrame:
    """
    For each date, rank sectors by momentum score (descending).
    Cross-sectional ranks for long/short portfolio construction.
    """
    df = df.copy()
    df["rank"] = df.groupby("date")["momentum"].rank(ascending=False, method="min")
    df["n_sectors"] = df.groupby("date")["sector"].transform("count")
    df["pct_rank"] = (df["rank"] - 1) / (df["n_sectors"] - 1).replace(0, 1)
    return df


def generate_signals(df: pd.DataFrame, top_n: int, short_n: int) -> pd.DataFrame:
    """
    Monthly rebalance signal:
      Top N by momentum → LONG (1)
      Bottom N by momentum → SHORT (-1)
      Middle → NEUTRAL (0)
    """
    df = df.copy()
    df["signal"] = 0

    def assign_signals(group):
        group = group.copy()
        n = len(group)
        top = min(top_n, n // 3)
        bot = min(short_n, n // 3)
        sorted_idx = group["momentum"].rank(ascending=False, method="first")
        group.loc[sorted_idx <= top, "signal"] = 1
        group.loc[sorted_idx > (n - bot), "signal"] = -1
        return group

    df = df.groupby("date", group_keys=False).apply(assign_signals)
    df["signal_label"] = df["signal"].map({1: "LONG", -1: "SHORT", 0: "NEUTRAL"})
    return df


def build_portfolio(signals: pd.DataFrame) -> pd.DataFrame:
    """
    For each rebalance date, produce the long basket and short basket with equal weights.
    """
    records = []
    for date, group in signals.groupby("date"):
        longs = group[group["signal"] == 1]["sector"].tolist()
        shorts = group[group["signal"] == -1]["sector"].tolist()
        n_long = len(longs)
        n_short = len(shorts)
        records.append({
            "date": date,
            "long_sectors": "|".join(longs),
            "short_sectors": "|".join(shorts),
            "n_long": n_long,
            "n_short": n_short,
            "long_weight": round(1.0 / n_long, 4) if n_long > 0 else 0,
            "short_weight": round(1.0 / n_short, 4) if n_short > 0 else 0,
        })
    return pd.DataFrame(records)


def compute_backtest_returns(signals: pd.DataFrame) -> dict:
    """
    Approximate strategy returns using next-month spend_index change as return proxy.
    Long positions profit from accelerating spend, shorts from decelerating.
    """
    df = signals.copy().sort_values(["sector", "date"])
    df["next_month_ret"] = df.groupby("sector")["spend_index"].pct_change().shift(-1)
    df["strat_ret"] = df["signal"] * df["next_month_ret"]

    by_date = df.groupby("date")["strat_ret"].mean()
    sharpe = 0.0
    if by_date.std() > 0:
        sharpe = float(by_date.mean() / by_date.std() * np.sqrt(12))

    return {
        "mean_monthly_return": round(float(by_date.mean()), 6),
        "sharpe_annualized": round(sharpe, 4),
        "total_return": round(float(by_date.sum()), 4),
    }


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(
    outdir: str,
    signals: pd.DataFrame,
    portfolio: pd.DataFrame,
    summary: dict,
) -> None:
    Path(outdir).mkdir(parents=True, exist_ok=True)

    sig_cols = ["date", "sector", "spend_index", "yoy_growth", "momentum",
                "momentum_z", "rank", "signal", "signal_label"]
    signals[[c for c in sig_cols if c in signals.columns]].to_csv(
        os.path.join(outdir, "spend_momentum.csv"), index=False
    )
    portfolio.to_csv(os.path.join(outdir, "portfolio.csv"), index=False)
    with open(os.path.join(outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)

    print(f"[OK] Spend momentum written : {outdir}/spend_momentum.csv")
    print(f"[OK] Portfolio written      : {outdir}/portfolio.csv")
    print(f"[OK] Summary written        : {outdir}/summary.json")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="CC sector spend → consumer stock signals")
    p.add_argument("--spend", required=True, help="Path to cc_spend.csv")
    p.add_argument("--outdir", default="./output")
    p.add_argument("--momentum-window", type=int, default=3, help="Month window for momentum calc")
    p.add_argument("--top-n", type=int, default=3, help="Number of long sectors")
    p.add_argument("--short-n", type=int, default=3, help="Number of short sectors")
    p.add_argument("--rebalance-freq", default="monthly", choices=["monthly", "quarterly"])
    return p.parse_args()


def main():
    args = parse_args()

    print(f"[INFO] Loading spend data from: {args.spend}")
    df = load_spend_data(args.spend)
    print(f"[INFO] Sectors: {sorted(df['sector'].unique())}")

    df = compute_momentum(df, args.momentum_window)
    df = rank_sectors_monthly(df)
    signals = generate_signals(df, args.top_n, args.short_n)
    portfolio = build_portfolio(signals)
    bt_stats = compute_backtest_returns(signals)

    sector_avg_mom = (
        signals.groupby("sector")["momentum"]
        .mean()
        .round(4)
        .sort_values(ascending=False)
        .to_dict()
    )

    summary = {
        "momentum_window": args.momentum_window,
        "top_n_long": args.top_n,
        "short_n_short": args.short_n,
        "rebalance_freq": args.rebalance_freq,
        "sectors": sorted(df["sector"].unique().tolist()),
        "n_rebalance_dates": len(portfolio),
        "avg_momentum_by_sector": sector_avg_mom,
        "backtest": bt_stats,
        "date_range_start": str(signals["date"].min().date()),
        "date_range_end": str(signals["date"].max().date()),
        "signal_logic": "top_momentum=LONG, bottom_momentum=SHORT, monthly_rebalance",
    }

    print("\n[SUMMARY]")
    print(f"  Date range     : {summary['date_range_start']} → {summary['date_range_end']}")
    print(f"  Sectors        : {summary['sectors']}")
    print(f"  Sharpe proxy   : {bt_stats['sharpe_annualized']:.4f}")
    print(f"  Rebalance dates: {summary['n_rebalance_dates']}")

    write_outputs(args.outdir, signals, portfolio, summary)


if __name__ == "__main__":
    main()
