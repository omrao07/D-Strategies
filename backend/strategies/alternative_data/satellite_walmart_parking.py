#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
satellite_walmart_parking.py
============================
Orbital Insight-style parking lot occupancy analysis for retail same-store sales prediction.

What it does
------------
Ingests satellite-derived parking lot vehicle counts alongside reported same-store sales
data. Computes occupancy rates (count / capacity), rolling z-scores to normalize seasonal
patterns, lead-lag correlation between occupancy and sales, and generates long/short signals
for retail stocks based on occupancy momentum relative to historical norms.

Inputs (CSV format)
-------------------
parking_counts.csv
    date        : YYYY-MM-DD
    location_id : str — store identifier (e.g. WMT_001)
    count       : int — vehicle count from satellite image
    capacity    : int — lot maximum capacity

sales.csv
    date        : YYYY-MM-DD
    location_id : str — must match parking_counts
    sales       : float — same-store sales (USD)

CLI
---
    python satellite_walmart_parking.py \\
        --parking parking_counts.csv \\
        --sales sales.csv \\
        --outdir ./output \\
        --ticker WMT \\
        --roll-window 8 \\
        --z-threshold 1.5 \\
        --lag-max 4

Outputs
-------
    outdir/occupancy_signals.csv   — date, location_id, occupancy, z_score, signal
    outdir/correlation_results.csv — lag, correlation for each lag tested
    outdir/summary.json            — metadata, best lag, signal counts, sharpe proxy
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

def load_parking(path: str) -> pd.DataFrame:
    """Load and validate parking counts CSV."""
    df = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "location_id", "count", "capacity"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"parking CSV missing columns: {missing}")
    df = df.dropna(subset=["date", "count", "capacity"])
    df["count"] = pd.to_numeric(df["count"], errors="coerce").fillna(0).astype(int)
    df["capacity"] = pd.to_numeric(df["capacity"], errors="coerce")
    df = df[df["capacity"] > 0]
    return df.sort_values("date").reset_index(drop=True)


def load_sales(path: str) -> pd.DataFrame:
    """Load and validate same-store sales CSV."""
    df = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "location_id", "sales"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"sales CSV missing columns: {missing}")
    df = df.dropna(subset=["date", "sales"])
    df["sales"] = pd.to_numeric(df["sales"], errors="coerce")
    return df.sort_values("date").reset_index(drop=True)


# ---------------------------------------------------------------------------
# Signal computation
# ---------------------------------------------------------------------------

def compute_occupancy(parking: pd.DataFrame) -> pd.DataFrame:
    """Compute occupancy rate per location per date."""
    parking = parking.copy()
    parking["occupancy"] = parking["count"] / parking["capacity"]
    parking["occupancy"] = parking["occupancy"].clip(0, 1.2)  # allow slight overflow
    return parking


def compute_aggregate_occupancy(parking: pd.DataFrame, roll_window: int) -> pd.DataFrame:
    """
    Aggregate occupancy across all locations (equal-weight),
    compute rolling mean/std, and derive z-scores.
    """
    daily = (
        parking.groupby("date")["occupancy"]
        .mean()
        .rename("occ_mean")
        .reset_index()
        .sort_values("date")
    )
    daily["roll_mean"] = daily["occ_mean"].rolling(roll_window, min_periods=2).mean()
    daily["roll_std"] = daily["occ_mean"].rolling(roll_window, min_periods=2).std()
    daily["z_score"] = (daily["occ_mean"] - daily["roll_mean"]) / daily["roll_std"].replace(0, np.nan)
    return daily


def compute_lead_lag(
    occ_df: pd.DataFrame,
    sales_df: pd.DataFrame,
    lag_max: int,
) -> pd.DataFrame:
    """
    Cross-correlate aggregate occupancy with aggregate same-store sales
    at lags 0..lag_max (weeks/periods). Positive lag = occupancy leads sales.
    """
    agg_sales = (
        sales_df.groupby("date")["sales"]
        .mean()
        .rename("sales_mean")
        .reset_index()
        .sort_values("date")
    )
    merged = pd.merge(occ_df[["date", "occ_mean"]], agg_sales, on="date", how="inner")
    merged = merged.dropna()

    results = []
    for lag in range(0, lag_max + 1):
        if lag == 0:
            x = merged["occ_mean"]
            y = merged["sales_mean"]
        else:
            x = merged["occ_mean"].iloc[:-lag].reset_index(drop=True)
            y = merged["sales_mean"].iloc[lag:].reset_index(drop=True)
        if len(x) < 4:
            corr = np.nan
        else:
            corr = float(np.corrcoef(x, y)[0, 1])
        results.append({"lag": lag, "correlation": round(corr, 4)})
    return pd.DataFrame(results)


def generate_signals(occ_df: pd.DataFrame, z_threshold: float) -> pd.DataFrame:
    """
    Generate long/short signals per date based on z-score of occupancy.
    z > +threshold → LONG (high traffic = bullish for sales)
    z < -threshold → SHORT (low traffic = bearish)
    """
    df = occ_df.copy()
    df["signal"] = 0
    df.loc[df["z_score"] > z_threshold, "signal"] = 1
    df.loc[df["z_score"] < -z_threshold, "signal"] = -1
    df["signal_label"] = df["signal"].map({1: "LONG", -1: "SHORT", 0: "NEUTRAL"})
    return df


def compute_sharpe_proxy(signals: pd.DataFrame) -> float:
    """
    Approximate Sharpe using next-period occupancy change as a proxy for returns.
    Only meaningful if occupancy change correlates with stock returns.
    """
    sig = signals.copy()
    sig["next_occ"] = sig["occ_mean"].shift(-1)
    sig["ret"] = (sig["next_occ"] - sig["occ_mean"]) / sig["occ_mean"].replace(0, np.nan)
    sig["strat_ret"] = sig["signal"] * sig["ret"]
    strat = sig["strat_ret"].dropna()
    if strat.std() == 0 or len(strat) < 3:
        return 0.0
    return float(strat.mean() / strat.std() * np.sqrt(52))


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(
    outdir: str,
    signals: pd.DataFrame,
    corr_df: pd.DataFrame,
    summary: dict,
) -> None:
    """Write all output files to outdir."""
    Path(outdir).mkdir(parents=True, exist_ok=True)

    sig_path = os.path.join(outdir, "occupancy_signals.csv")
    corr_path = os.path.join(outdir, "correlation_results.csv")
    sum_path = os.path.join(outdir, "summary.json")

    out_cols = ["date", "occ_mean", "roll_mean", "roll_std", "z_score", "signal", "signal_label"]
    signals[out_cols].to_csv(sig_path, index=False)
    corr_df.to_csv(corr_path, index=False)

    with open(sum_path, "w") as f:
        json.dump(summary, f, indent=2, default=str)

    print(f"[OK] Signals written to      : {sig_path}")
    print(f"[OK] Correlations written to : {corr_path}")
    print(f"[OK] Summary written to      : {sum_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(
        description="Satellite parking lot occupancy → retail same-store sales signal"
    )
    p.add_argument("--parking", required=True, help="Path to parking_counts.csv")
    p.add_argument("--sales", required=True, help="Path to sales.csv")
    p.add_argument("--outdir", default="./output", help="Output directory")
    p.add_argument("--ticker", default="WMT", help="Retail stock ticker label")
    p.add_argument("--roll-window", type=int, default=8, help="Rolling z-score window (periods)")
    p.add_argument("--z-threshold", type=float, default=1.5, help="Z-score threshold for signals")
    p.add_argument("--lag-max", type=int, default=4, help="Max lead-lag periods to test")
    return p.parse_args()


def main():
    args = parse_args()

    print(f"[INFO] Loading parking data from: {args.parking}")
    parking = load_parking(args.parking)
    print(f"[INFO] Loading sales data from  : {args.sales}")
    sales = load_sales(args.sales)

    parking = compute_occupancy(parking)
    occ_agg = compute_aggregate_occupancy(parking, args.roll_window)
    corr_df = compute_lead_lag(occ_agg, sales, args.lag_max)
    signals = generate_signals(occ_agg, args.z_threshold)
    sharpe = compute_sharpe_proxy(signals)

    best_lag_row = corr_df.loc[corr_df["correlation"].abs().idxmax()]
    n_long = int((signals["signal"] == 1).sum())
    n_short = int((signals["signal"] == -1).sum())
    n_neutral = int((signals["signal"] == 0).sum())

    summary = {
        "ticker": args.ticker,
        "roll_window": args.roll_window,
        "z_threshold": args.z_threshold,
        "lag_max": args.lag_max,
        "n_dates": len(signals),
        "n_locations": parking["location_id"].nunique(),
        "n_long_signals": n_long,
        "n_short_signals": n_short,
        "n_neutral": n_neutral,
        "best_lag_periods": int(best_lag_row["lag"]),
        "best_lag_correlation": float(best_lag_row["correlation"]),
        "sharpe_proxy_annualized": round(sharpe, 4),
        "mean_occupancy": round(float(parking["occupancy"].mean()), 4),
        "date_range_start": str(signals["date"].min().date()),
        "date_range_end": str(signals["date"].max().date()),
    }

    print(f"\n[SUMMARY] Ticker: {args.ticker}")
    print(f"  Dates          : {summary['date_range_start']} → {summary['date_range_end']}")
    print(f"  Locations      : {summary['n_locations']}")
    print(f"  Long signals   : {n_long}")
    print(f"  Short signals  : {n_short}")
    print(f"  Best lag       : {summary['best_lag_periods']} periods (corr={summary['best_lag_correlation']})")
    print(f"  Sharpe proxy   : {sharpe:.4f}")

    write_outputs(args.outdir, signals, corr_df, summary)


if __name__ == "__main__":
    main()
