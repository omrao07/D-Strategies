#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
foot_traffic_retail_stores.py
==============================
Placer.ai-style foot traffic data → same-store sales pre-earnings signal.

What it does
------------
Aggregates store-level daily visit counts by publicly traded ticker symbol.
Computes year-over-year visit growth per ticker and compares against an implied
consensus estimate (sector median YoY). Generates a signal when a ticker's
YoY visit growth exceeds the consensus by more than 10 percentage points —
interpreted as a pre-earnings earnings-beat signal. Also computes trailing
correlation between foot traffic momentum and next-quarter earnings outcomes.

Inputs (CSV format)
-------------------
foot_traffic.csv
    date        : YYYY-MM-DD
    store_id    : str — unique store identifier
    ticker      : str — parent company stock ticker
    visit_count : int — estimated number of visits that day

CLI
---
    python foot_traffic_retail_stores.py \\
        --traffic foot_traffic.csv \\
        --outdir ./output \\
        --consensus-beat-threshold 0.10 \\
        --roll-window 4 \\
        --min-stores 3

Outputs
-------
    outdir/ticker_traffic.csv   — date, ticker, visit_count, yoy_change, vs_consensus, signal
    outdir/store_summary.csv    — ticker, n_stores, avg_visits, avg_yoy
    outdir/summary.json         — metadata, signal counts, top/bottom tickers
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

def load_traffic(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "store_id", "ticker", "visit_count"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"foot_traffic CSV missing columns: {missing}")
    df["ticker"] = df["ticker"].str.upper().str.strip()
    df["visit_count"] = pd.to_numeric(df["visit_count"], errors="coerce").fillna(0).astype(int)
    df = df[df["visit_count"] >= 0]
    return df.sort_values("date").reset_index(drop=True)


# ---------------------------------------------------------------------------
# Signal computation
# ---------------------------------------------------------------------------

def aggregate_by_ticker_week(df: pd.DataFrame, min_stores: int) -> pd.DataFrame:
    """
    Aggregate daily visits to weekly by ticker.
    Only include tickers with at least min_stores unique stores.
    """
    # Filter tickers with enough stores
    store_counts = df.groupby("ticker")["store_id"].nunique()
    valid_tickers = store_counts[store_counts >= min_stores].index
    df = df[df["ticker"].isin(valid_tickers)].copy()

    df["week"] = df["date"].dt.to_period("W").dt.start_time
    weekly = (
        df.groupby(["week", "ticker"])
        .agg(visit_count=("visit_count", "sum"), n_stores=("store_id", "nunique"))
        .reset_index()
        .rename(columns={"week": "date"})
    )
    return weekly.sort_values(["ticker", "date"])


def compute_yoy(weekly: pd.DataFrame) -> pd.DataFrame:
    """Compute year-over-year visit change per ticker (52-week lag)."""
    records = []
    for ticker, grp in weekly.groupby("ticker"):
        grp = grp.copy().sort_values("date")
        grp["visit_yoy"] = grp["visit_count"].pct_change(52)
        records.append(grp)
    return pd.concat(records, ignore_index=True)


def compute_consensus_beat(df: pd.DataFrame, beat_threshold: float) -> pd.DataFrame:
    """
    Consensus estimate = sector median YoY at each date (using all tickers as sector proxy).
    Signal fired when ticker YoY exceeds consensus by beat_threshold.
    """
    df = df.copy()
    df["consensus_yoy"] = df.groupby("date")["visit_yoy"].transform("median")
    df["vs_consensus"] = df["visit_yoy"] - df["consensus_yoy"]
    df["signal"] = 0
    df.loc[df["vs_consensus"] > beat_threshold, "signal"] = 1   # buy: foot traffic beat
    df.loc[df["vs_consensus"] < -beat_threshold, "signal"] = -1  # sell: foot traffic miss
    df["signal_label"] = df["signal"].map({1: "LONG", -1: "SHORT", 0: "NEUTRAL"})
    return df


def rolling_signal_strength(df: pd.DataFrame, roll_window: int) -> pd.DataFrame:
    """
    Add rolling average of vs_consensus for trend persistence.
    """
    records = []
    for ticker, grp in df.groupby("ticker"):
        grp = grp.copy().sort_values("date")
        grp["rolling_beat"] = grp["vs_consensus"].rolling(roll_window, min_periods=1).mean()
        records.append(grp)
    return pd.concat(records, ignore_index=True)


def store_level_summary(df: pd.DataFrame, traffic: pd.DataFrame) -> pd.DataFrame:
    """Summary statistics per ticker."""
    ticker_agg = traffic.groupby("ticker").agg(
        n_stores=("store_id", "nunique"),
        total_visits=("visit_count", "sum"),
        avg_daily_visits=("visit_count", "mean"),
    ).reset_index()
    return ticker_agg.round(2)


def top_bottom_tickers(df: pd.DataFrame, n: int = 5) -> dict:
    """Return top N and bottom N tickers by average vs_consensus."""
    avg = df.groupby("ticker")["vs_consensus"].mean().dropna()
    return {
        "top_tickers": avg.nlargest(n).round(4).to_dict(),
        "bottom_tickers": avg.nsmallest(n).round(4).to_dict(),
    }


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(
    outdir: str,
    signals: pd.DataFrame,
    store_summary: pd.DataFrame,
    summary: dict,
) -> None:
    Path(outdir).mkdir(parents=True, exist_ok=True)

    sig_cols = ["date", "ticker", "visit_count", "n_stores", "visit_yoy",
                "consensus_yoy", "vs_consensus", "rolling_beat", "signal", "signal_label"]
    signals[[c for c in sig_cols if c in signals.columns]].to_csv(
        os.path.join(outdir, "ticker_traffic.csv"), index=False
    )
    store_summary.to_csv(os.path.join(outdir, "store_summary.csv"), index=False)
    with open(os.path.join(outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)

    print(f"[OK] Ticker traffic signals : {outdir}/ticker_traffic.csv")
    print(f"[OK] Store summary          : {outdir}/store_summary.csv")
    print(f"[OK] Summary                : {outdir}/summary.json")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Foot traffic → same-store sales pre-earnings signal")
    p.add_argument("--traffic", required=True, help="Path to foot_traffic.csv")
    p.add_argument("--outdir", default="./output")
    p.add_argument("--consensus-beat-threshold", type=float, default=0.10,
                   help="YoY pct above consensus for buy signal (0.10 = 10ppts)")
    p.add_argument("--roll-window", type=int, default=4, help="Rolling beat window (weeks)")
    p.add_argument("--min-stores", type=int, default=3, help="Min stores per ticker to include")
    return p.parse_args()


def main():
    args = parse_args()

    print(f"[INFO] Loading foot traffic from: {args.traffic}")
    traffic = load_traffic(args.traffic)
    print(f"[INFO] Tickers: {sorted(traffic['ticker'].unique())}")

    weekly = aggregate_by_ticker_week(traffic, args.min_stores)
    weekly = compute_yoy(weekly)
    weekly = compute_consensus_beat(weekly, args.consensus_beat_threshold)
    weekly = rolling_signal_strength(weekly, args.roll_window)
    store_summary = store_level_summary(traffic.groupby("ticker").apply(
        lambda x: x.assign(visit_count=x["visit_count"])), traffic)
    tb = top_bottom_tickers(weekly)

    n_long = int((weekly["signal"] == 1).sum())
    n_short = int((weekly["signal"] == -1).sum())

    summary = {
        "consensus_beat_threshold": args.consensus_beat_threshold,
        "roll_window": args.roll_window,
        "min_stores": args.min_stores,
        "n_tickers": int(weekly["ticker"].nunique()),
        "n_dates": int(weekly["date"].nunique()),
        "n_long_signals": n_long,
        "n_short_signals": n_short,
        "n_neutral": int((weekly["signal"] == 0).sum()),
        "date_range_start": str(weekly["date"].min().date()),
        "date_range_end": str(weekly["date"].max().date()),
        "top_outperformers": tb["top_tickers"],
        "top_underperformers": tb["bottom_tickers"],
        "signal_logic": "YoY>consensus+10ppts=LONG, YoY<consensus-10ppts=SHORT",
    }

    print(f"\n[SUMMARY]")
    print(f"  Date range     : {summary['date_range_start']} → {summary['date_range_end']}")
    print(f"  Tickers        : {summary['n_tickers']}")
    print(f"  Long signals   : {n_long}  |  Short signals: {n_short}")

    write_outputs(args.outdir, weekly, store_summary, summary)


if __name__ == "__main__":
    main()
