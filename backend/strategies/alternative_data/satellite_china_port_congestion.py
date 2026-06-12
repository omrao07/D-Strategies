#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
satellite_china_port_congestion.py
===================================
Container vessel counts at major Chinese ports → global trade signal.

What it does
------------
Ingests satellite-derived vessel count and DWT (deadweight tonnage) data for major
Chinese ports. Computes a composite congestion index, normalizes via rolling z-score,
and generates directional signals for shipping and global trade ETFs. High congestion
implies elevated trade throughput and is treated as bullish for shipping stocks (BDRY,
ZIM, MATX) and trade-exposed ETFs.

Inputs (CSV format)
-------------------
port_data.csv
    date         : YYYY-MM-DD
    port         : str — port name (e.g. Shanghai, Ningbo, Shenzhen)
    vessel_count : int — number of vessels in port
    dwt_total    : float — total deadweight tonnage present (metric tons)

CLI
---
    python satellite_china_port_congestion.py \\
        --port-data port_data.csv \\
        --outdir ./output \\
        --roll-window 12 \\
        --z-threshold 1.2 \\
        --top-ports 5

Outputs
-------
    outdir/congestion_index.csv  — date, port, vessel_count, dwt_total, congestion_index
    outdir/signals.csv           — date, composite_index, z_score, signal, signal_label
    outdir/summary.json          — metadata, signal counts, top ports used
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

def load_port_data(path: str) -> pd.DataFrame:
    """Load and validate port data CSV."""
    df = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "port", "vessel_count", "dwt_total"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"port_data CSV missing columns: {missing}")
    df = df.dropna(subset=["date", "vessel_count", "dwt_total"])
    df["vessel_count"] = pd.to_numeric(df["vessel_count"], errors="coerce").fillna(0)
    df["dwt_total"] = pd.to_numeric(df["dwt_total"], errors="coerce").fillna(0)
    return df.sort_values(["date", "port"]).reset_index(drop=True)


# ---------------------------------------------------------------------------
# Signal computation
# ---------------------------------------------------------------------------

def select_top_ports(df: pd.DataFrame, top_n: int) -> list:
    """Select top N ports by average vessel count."""
    port_avg = df.groupby("port")["vessel_count"].mean().nlargest(top_n)
    return list(port_avg.index)


def compute_port_congestion_index(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute per-port congestion index as:
        congestion_index = vessel_count * (dwt_total / max_dwt_for_port)
    Normalized to [0, 1] relative to each port's historical max.
    """
    df = df.copy()
    port_max_dwt = df.groupby("port")["dwt_total"].transform("max")
    port_max_vc = df.groupby("port")["vessel_count"].transform("max")
    df["norm_dwt"] = df["dwt_total"] / port_max_dwt.replace(0, np.nan)
    df["norm_vc"] = df["vessel_count"] / port_max_vc.replace(0, np.nan)
    df["congestion_index"] = (df["norm_dwt"] + df["norm_vc"]) / 2.0
    return df


def compute_composite_index(
    port_df: pd.DataFrame,
    top_ports: list,
    roll_window: int,
) -> pd.DataFrame:
    """
    Equal-weight aggregate congestion across top ports, then rolling z-score.
    """
    filtered = port_df[port_df["port"].isin(top_ports)].copy()
    daily = (
        filtered.groupby("date")["congestion_index"]
        .mean()
        .rename("composite_index")
        .reset_index()
        .sort_values("date")
    )
    daily["roll_mean"] = daily["composite_index"].rolling(roll_window, min_periods=3).mean()
    daily["roll_std"] = daily["composite_index"].rolling(roll_window, min_periods=3).std()
    daily["z_score"] = (
        (daily["composite_index"] - daily["roll_mean"])
        / daily["roll_std"].replace(0, np.nan)
    )
    return daily


def generate_signals(composite: pd.DataFrame, z_threshold: float) -> pd.DataFrame:
    """
    Signal generation:
      z > +threshold → LONG shipping stocks (bullish congestion = high demand)
      z < -threshold → SHORT shipping stocks (weak trade throughput)
    """
    df = composite.copy()
    df["signal"] = 0
    df.loc[df["z_score"] > z_threshold, "signal"] = 1
    df.loc[df["z_score"] < -z_threshold, "signal"] = -1
    df["signal_label"] = df["signal"].map({1: "LONG", -1: "SHORT", 0: "NEUTRAL"})
    return df


def port_contribution_breakdown(port_df: pd.DataFrame, top_ports: list) -> pd.DataFrame:
    """Average congestion index per port for reporting."""
    filtered = port_df[port_df["port"].isin(top_ports)]
    return (
        filtered.groupby("port")["congestion_index"]
        .agg(["mean", "std", "min", "max"])
        .round(4)
        .reset_index()
        .rename(columns={"mean": "avg_congestion", "std": "std_congestion",
                         "min": "min_congestion", "max": "max_congestion"})
    )


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(
    outdir: str,
    port_df: pd.DataFrame,
    signals: pd.DataFrame,
    port_stats: pd.DataFrame,
    summary: dict,
) -> None:
    """Write all output files."""
    Path(outdir).mkdir(parents=True, exist_ok=True)

    congestion_path = os.path.join(outdir, "congestion_index.csv")
    signals_path = os.path.join(outdir, "signals.csv")
    summary_path = os.path.join(outdir, "summary.json")

    port_out_cols = ["date", "port", "vessel_count", "dwt_total", "congestion_index"]
    port_df[port_out_cols].to_csv(congestion_path, index=False)

    sig_cols = ["date", "composite_index", "roll_mean", "z_score", "signal", "signal_label"]
    signals[sig_cols].to_csv(signals_path, index=False)

    summary["port_stats"] = port_stats.to_dict(orient="records")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2, default=str)

    print(f"[OK] Congestion index written : {congestion_path}")
    print(f"[OK] Signals written to       : {signals_path}")
    print(f"[OK] Summary written to       : {summary_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(
        description="China port congestion satellite data → global trade / shipping signal"
    )
    p.add_argument("--port-data", required=True, help="Path to port_data.csv")
    p.add_argument("--outdir", default="./output", help="Output directory")
    p.add_argument("--roll-window", type=int, default=12, help="Rolling z-score window (weeks)")
    p.add_argument("--z-threshold", type=float, default=1.2, help="Z-score signal threshold")
    p.add_argument("--top-ports", type=int, default=5, help="Number of top ports to include")
    return p.parse_args()


def main():
    args = parse_args()

    print(f"[INFO] Loading port data from: {args.port_data}")
    raw = load_port_data(args.port_data)

    top_ports = select_top_ports(raw, args.top_ports)
    print(f"[INFO] Top {args.top_ports} ports selected: {top_ports}")

    port_df = compute_port_congestion_index(raw)
    composite = compute_composite_index(port_df, top_ports, args.roll_window)
    signals = generate_signals(composite, args.z_threshold)
    port_stats = port_contribution_breakdown(port_df, top_ports)

    n_long = int((signals["signal"] == 1).sum())
    n_short = int((signals["signal"] == -1).sum())

    summary = {
        "roll_window": args.roll_window,
        "z_threshold": args.z_threshold,
        "top_ports": top_ports,
        "n_dates": len(signals),
        "n_long_signals": n_long,
        "n_short_signals": n_short,
        "n_neutral": int((signals["signal"] == 0).sum()),
        "avg_composite_index": round(float(composite["composite_index"].mean()), 4),
        "date_range_start": str(signals["date"].min().date()),
        "date_range_end": str(signals["date"].max().date()),
        "instruments": ["BDRY", "ZIM", "MATX", "SBLK", "GOGL"],
        "signal_logic": "z>threshold=LONG shipping, z<-threshold=SHORT shipping",
    }

    print("\n[SUMMARY]")
    print(f"  Date range     : {summary['date_range_start']} → {summary['date_range_end']}")
    print(f"  Top ports      : {top_ports}")
    print(f"  Long signals   : {n_long}  |  Short signals: {n_short}")
    print(f"  Avg congestion : {summary['avg_composite_index']:.4f}")

    write_outputs(args.outdir, port_df, signals, port_stats, summary)


if __name__ == "__main__":
    main()
