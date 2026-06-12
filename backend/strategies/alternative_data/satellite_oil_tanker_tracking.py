#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
satellite_oil_tanker_tracking.py
=================================
Tanker AIS (Automatic Identification System) vessel tracking → crude oil supply/demand signal.

What it does
------------
Aggregates AIS tracking data for oil tankers by status (laden vs ballast). Computes the
laden-to-ballast ratio as a proxy for oil supply-in-transit. When laden vessels dominate,
crude oil is being shipped to market (supply surge = bearish for Brent/WTI). When ballast
(empty) vessels dominate, less oil is in transit (supply draw = bullish). Applies rolling
z-scores and outputs actionable signals for crude oil futures and energy ETFs.

Inputs (CSV format)
-------------------
tanker_ais.csv
    date            : YYYY-MM-DD
    vessel_id       : str — IMO number or vessel name
    cargo_estimate  : float — estimated cargo in barrels (0 for ballast)
    status          : str — 'laden' or 'ballast'
    destination     : str — destination port/region (optional)

CLI
---
    python satellite_oil_tanker_tracking.py \\
        --ais tanker_ais.csv \\
        --outdir ./output \\
        --roll-window 10 \\
        --z-threshold 1.5 \\
        --min-vessels 20

Outputs
-------
    outdir/tanker_flows.csv  — date, laden_count, ballast_count, lb_ratio, cargo_total
    outdir/signals.csv       — date, lb_ratio, z_score, signal, signal_label
    outdir/summary.json      — metadata, signal counts, avg ratio, thresholds
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

def load_ais_data(path: str) -> pd.DataFrame:
    """Load and validate tanker AIS CSV."""
    df = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "vessel_id", "cargo_estimate", "status"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"AIS CSV missing columns: {missing}")
    df["status"] = df["status"].str.lower().str.strip()
    valid_status = {"laden", "ballast"}
    df = df[df["status"].isin(valid_status)].copy()
    df["cargo_estimate"] = pd.to_numeric(df["cargo_estimate"], errors="coerce").fillna(0)
    return df.sort_values("date").reset_index(drop=True)


# ---------------------------------------------------------------------------
# Signal computation
# ---------------------------------------------------------------------------

def aggregate_daily_flows(df: pd.DataFrame, min_vessels: int) -> pd.DataFrame:
    """
    Aggregate AIS data to daily level.
    Compute laden count, ballast count, laden-to-ballast ratio, total cargo.
    """
    daily = df.groupby(["date", "status"]).agg(
        vessel_count=("vessel_id", "count"),
        cargo_sum=("cargo_estimate", "sum")
    ).reset_index()

    laden = daily[daily["status"] == "laden"][["date", "vessel_count", "cargo_sum"]].rename(
        columns={"vessel_count": "laden_count", "cargo_sum": "laden_cargo"}
    )
    ballast = daily[daily["status"] == "ballast"][["date", "vessel_count"]].rename(
        columns={"vessel_count": "ballast_count"}
    )

    merged = pd.merge(laden, ballast, on="date", how="outer").fillna(0)
    merged = merged.sort_values("date")
    merged["total_vessels"] = merged["laden_count"] + merged["ballast_count"]
    merged = merged[merged["total_vessels"] >= min_vessels].copy()

    # Laden-to-ballast ratio: >1 means more supply in transit
    merged["lb_ratio"] = merged["laden_count"] / merged["ballast_count"].replace(0, np.nan)
    merged["cargo_total"] = merged["laden_cargo"]
    return merged.reset_index(drop=True)


def compute_z_score(flows: pd.DataFrame, roll_window: int) -> pd.DataFrame:
    """Rolling z-score on the laden-to-ballast ratio."""
    df = flows.copy()
    df["roll_mean"] = df["lb_ratio"].rolling(roll_window, min_periods=3).mean()
    df["roll_std"] = df["lb_ratio"].rolling(roll_window, min_periods=3).std()
    df["z_score"] = (df["lb_ratio"] - df["roll_mean"]) / df["roll_std"].replace(0, np.nan)
    return df


def generate_signals(df: pd.DataFrame, z_threshold: float) -> pd.DataFrame:
    """
    Signal:
      High z (many laden = supply surge) → SHORT crude oil
      Low z  (many ballast = supply draw) → LONG crude oil
    """
    df = df.copy()
    df["signal"] = 0
    df.loc[df["z_score"] > z_threshold, "signal"] = -1    # supply surge → bearish
    df.loc[df["z_score"] < -z_threshold, "signal"] = 1    # supply draw → bullish
    df["signal_label"] = df["signal"].map({1: "LONG", -1: "SHORT", 0: "NEUTRAL"})
    return df


def destination_breakdown(ais: pd.DataFrame) -> pd.DataFrame:
    """Frequency of top destination regions for laden tankers."""
    if "destination" not in ais.columns:
        return pd.DataFrame(columns=["destination", "laden_trips"])
    laden = ais[ais["status"] == "laden"].copy()
    laden["destination"] = laden["destination"].fillna("UNKNOWN").str.upper().str.strip()
    breakdown = laden.groupby("destination")["vessel_id"].count().rename("laden_trips")
    return breakdown.sort_values(ascending=False).head(10).reset_index()


def backtest_pnl(signals: pd.DataFrame) -> pd.Series:
    """
    Proxy backtest: next-period lb_ratio change used as return proxy.
    Signal × direction-of-ratio-change → realized P&L proxy.
    """
    df = signals.copy()
    df["next_ratio"] = df["lb_ratio"].shift(-1)
    df["ratio_chg"] = df["next_ratio"] - df["lb_ratio"]
    # For SHORT: profit when ratio decreases (supply normalizes)
    # For LONG: profit when ratio increases would be wrong; use inverted
    df["trade_ret"] = df["signal"] * (-df["ratio_chg"])  # short profits from ratio fall
    return df["trade_ret"].dropna()


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(
    outdir: str,
    flows: pd.DataFrame,
    signals: pd.DataFrame,
    dest_breakdown: pd.DataFrame,
    pnl: pd.Series,
    summary: dict,
) -> None:
    """Write all outputs."""
    Path(outdir).mkdir(parents=True, exist_ok=True)

    flows_path = os.path.join(outdir, "tanker_flows.csv")
    sig_path = os.path.join(outdir, "signals.csv")
    sum_path = os.path.join(outdir, "summary.json")

    flow_cols = ["date", "laden_count", "ballast_count", "total_vessels", "lb_ratio", "cargo_total"]
    flows[flow_cols].to_csv(flows_path, index=False)

    sig_cols = ["date", "lb_ratio", "roll_mean", "z_score", "signal", "signal_label"]
    signals[sig_cols].to_csv(sig_path, index=False)

    if not dest_breakdown.empty:
        summary["top_destinations"] = dest_breakdown.to_dict(orient="records")

    # P&L stats
    if len(pnl) > 0:
        summary["backtest_mean_ret"] = round(float(pnl.mean()), 6)
        summary["backtest_std_ret"] = round(float(pnl.std()), 6)
        summary["backtest_total_ret"] = round(float(pnl.sum()), 6)

    with open(sum_path, "w") as f:
        json.dump(summary, f, indent=2, default=str)

    print(f"[OK] Tanker flows written : {flows_path}")
    print(f"[OK] Signals written to   : {sig_path}")
    print(f"[OK] Summary written to   : {sum_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(
        description="Tanker AIS tracking → crude oil supply/demand signal"
    )
    p.add_argument("--ais", required=True, help="Path to tanker_ais.csv")
    p.add_argument("--outdir", default="./output", help="Output directory")
    p.add_argument("--roll-window", type=int, default=10, help="Rolling z-score window")
    p.add_argument("--z-threshold", type=float, default=1.5, help="Z-score signal threshold")
    p.add_argument("--min-vessels", type=int, default=20, help="Min vessels per day to include")
    return p.parse_args()


def main():
    args = parse_args()

    print(f"[INFO] Loading AIS data from: {args.ais}")
    ais = load_ais_data(args.ais)
    print(f"[INFO] Total vessel-day records: {len(ais)}")

    flows = aggregate_daily_flows(ais, args.min_vessels)
    flows = compute_z_score(flows, args.roll_window)
    signals = generate_signals(flows, args.z_threshold)
    dest_brkdn = destination_breakdown(ais)
    pnl = backtest_pnl(signals)

    n_long = int((signals["signal"] == 1).sum())
    n_short = int((signals["signal"] == -1).sum())

    summary = {
        "roll_window": args.roll_window,
        "z_threshold": args.z_threshold,
        "min_vessels_per_day": args.min_vessels,
        "n_dates": len(signals),
        "unique_vessels": int(ais["vessel_id"].nunique()),
        "n_long_signals": n_long,
        "n_short_signals": n_short,
        "n_neutral": int((signals["signal"] == 0).sum()),
        "avg_lb_ratio": round(float(flows["lb_ratio"].mean()), 4),
        "avg_daily_cargo_bbls": round(float(flows["cargo_total"].mean()), 0),
        "date_range_start": str(signals["date"].min().date()),
        "date_range_end": str(signals["date"].max().date()),
        "instruments": ["CL=F", "BZ=F", "UCO", "SCO", "USO"],
        "signal_logic": "high_lb_ratio=SHORT_crude, low_lb_ratio=LONG_crude",
    }

    print("\n[SUMMARY]")
    print(f"  Date range       : {summary['date_range_start']} → {summary['date_range_end']}")
    print(f"  Unique vessels   : {summary['unique_vessels']}")
    print(f"  Avg L/B ratio    : {summary['avg_lb_ratio']:.4f}")
    print(f"  Long signals     : {n_long}  |  Short signals: {n_short}")

    write_outputs(args.outdir, flows, signals, dest_brkdn, pnl, summary)


if __name__ == "__main__":
    main()
