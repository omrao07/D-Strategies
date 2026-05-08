#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
satellite_crop_yields.py
=========================
NDVI (Normalized Difference Vegetation Index) satellite imaging → agricultural futures signal.

What it does
------------
Processes NDVI readings by crop and region to predict agricultural commodity prices.
Below-average NDVI indicates crop stress, reduced yields, and bullish futures prices.
Above-average NDVI signals healthy yields and bearish futures. Computes lead-lag
correlations between NDVI and futures prices, generates long/short signals for
corn, wheat, soy, and other agricultural commodities, and performs a rolling
backtest of the signal's predictive power.

Inputs (CSV format)
-------------------
ndvi_data.csv
    date       : YYYY-MM-DD
    region     : str — geographic region (e.g. US_Midwest, Brazil_Mato_Grosso)
    crop       : str — commodity (corn, wheat, soybeans, cotton)
    ndvi_index : float — NDVI value, range [-1, 1], healthy crop typically 0.3-0.8

futures.csv
    date       : YYYY-MM-DD
    commodity  : str — must match ndvi_data crop names
    price      : float — futures settlement price (USD/bushel or USD/cwt)

CLI
---
    python satellite_crop_yields.py \\
        --ndvi ndvi_data.csv \\
        --futures futures.csv \\
        --outdir ./output \\
        --roll-window 6 \\
        --z-threshold 1.0 \\
        --lag-max 8 \\
        --crops corn wheat soybeans

Outputs
-------
    outdir/ndvi_signals.csv       — date, commodity, ndvi_mean, z_score, signal
    outdir/lead_lag_analysis.csv  — commodity, lag, correlation
    outdir/backtest_returns.csv   — date, commodity, signal, fwd_return, strat_return
    outdir/summary.json           — per-commodity best lag, correlation, Sharpe
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

def load_ndvi(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "region", "crop", "ndvi_index"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"NDVI CSV missing columns: {missing}")
    df["crop"] = df["crop"].str.lower().str.strip()
    df["ndvi_index"] = pd.to_numeric(df["ndvi_index"], errors="coerce")
    df = df.dropna(subset=["ndvi_index"])
    df = df[(df["ndvi_index"] >= -1.0) & (df["ndvi_index"] <= 1.0)]
    return df.sort_values("date").reset_index(drop=True)


def load_futures(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "commodity", "price"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Futures CSV missing columns: {missing}")
    df["commodity"] = df["commodity"].str.lower().str.strip()
    df["price"] = pd.to_numeric(df["price"], errors="coerce")
    df = df.dropna(subset=["price"])
    return df.sort_values("date").reset_index(drop=True)


# ---------------------------------------------------------------------------
# Signal computation
# ---------------------------------------------------------------------------

def compute_ndvi_zscore(ndvi: pd.DataFrame, roll_window: int, crops: list) -> pd.DataFrame:
    """
    For each crop, aggregate NDVI across regions (area-weighted if needed, here equal-weight),
    then compute rolling z-score.
    """
    ndvi_filtered = ndvi[ndvi["crop"].isin(crops)].copy()
    agg = (
        ndvi_filtered.groupby(["date", "crop"])["ndvi_index"]
        .mean()
        .reset_index()
        .sort_values(["crop", "date"])
    )

    records = []
    for crop, group in agg.groupby("crop"):
        group = group.copy().sort_values("date")
        group["roll_mean"] = group["ndvi_index"].rolling(roll_window, min_periods=2).mean()
        group["roll_std"] = group["ndvi_index"].rolling(roll_window, min_periods=2).std()
        group["z_score"] = (
            (group["ndvi_index"] - group["roll_mean"])
            / group["roll_std"].replace(0, np.nan)
        )
        records.append(group)

    return pd.concat(records, ignore_index=True)


def compute_lead_lag(
    ndvi_agg: pd.DataFrame,
    futures: pd.DataFrame,
    lag_max: int,
) -> pd.DataFrame:
    """
    For each crop/commodity pair, compute correlation at lags 0..lag_max.
    Negative NDVI z (bad crop) should lead to higher futures prices (positive correlation).
    """
    results = []
    for crop, ndvi_grp in ndvi_agg.groupby("crop"):
        fut_grp = futures[futures["commodity"] == crop].copy()
        if fut_grp.empty:
            continue
        merged = pd.merge(
            ndvi_grp[["date", "z_score"]].rename(columns={"z_score": "ndvi_z"}),
            fut_grp[["date", "price"]],
            on="date",
            how="inner",
        ).dropna().sort_values("date")

        for lag in range(0, lag_max + 1):
            if lag == 0:
                x = merged["ndvi_z"].values
                y = merged["price"].values
            else:
                x = merged["ndvi_z"].iloc[:-lag].values
                y = merged["price"].iloc[lag:].values
            if len(x) < 4:
                corr = np.nan
            else:
                corr = float(np.corrcoef(x, y)[0, 1])
            results.append({"commodity": crop, "lag": lag, "correlation": round(corr, 4)})

    return pd.DataFrame(results)


def generate_signals(ndvi_agg: pd.DataFrame, z_threshold: float) -> pd.DataFrame:
    """
    Signal logic (inverted from NDVI z-score):
      NDVI z < -threshold → crop stress → LONG futures (bullish)
      NDVI z > +threshold → healthy crop → SHORT futures (bearish)
    """
    df = ndvi_agg.copy()
    df["signal"] = 0
    df.loc[df["z_score"] < -z_threshold, "signal"] = 1   # below avg NDVI = bullish
    df.loc[df["z_score"] > z_threshold, "signal"] = -1   # above avg NDVI = bearish
    df["signal_label"] = df["signal"].map({1: "LONG", -1: "SHORT", 0: "NEUTRAL"})
    return df


def backtest(signals: pd.DataFrame, futures: pd.DataFrame, best_lags: dict) -> pd.DataFrame:
    """
    For each commodity, shift signal by best_lag periods, compute forward return.
    """
    records = []
    for crop, sig_grp in signals.groupby("crop"):
        fut_grp = futures[futures["commodity"] == crop].copy().sort_values("date")
        lag = best_lags.get(crop, 0)
        sig_shifted = sig_grp[["date", "signal"]].copy()
        sig_shifted["date_target"] = sig_grp["date"].values

        fut_grp["fwd_return"] = fut_grp["price"].pct_change(1).shift(-1)
        merged = pd.merge(sig_shifted, fut_grp[["date", "fwd_return"]], on="date", how="inner")
        merged["strat_return"] = merged["signal"] * merged["fwd_return"]
        merged["commodity"] = crop
        records.append(merged)

    if not records:
        return pd.DataFrame()
    return pd.concat(records, ignore_index=True)


def compute_sharpe(bt: pd.DataFrame, commodity: str) -> float:
    sub = bt[bt["commodity"] == commodity]["strat_return"].dropna()
    if sub.std() == 0 or len(sub) < 3:
        return 0.0
    return float(sub.mean() / sub.std() * np.sqrt(52))


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(
    outdir: str,
    signals: pd.DataFrame,
    lag_df: pd.DataFrame,
    bt: pd.DataFrame,
    summary: dict,
) -> None:
    Path(outdir).mkdir(parents=True, exist_ok=True)

    sig_cols = ["date", "crop", "ndvi_index", "roll_mean", "z_score", "signal", "signal_label"]
    signals[sig_cols].to_csv(os.path.join(outdir, "ndvi_signals.csv"), index=False)
    lag_df.to_csv(os.path.join(outdir, "lead_lag_analysis.csv"), index=False)
    if not bt.empty:
        bt_cols = ["date", "commodity", "signal", "fwd_return", "strat_return"]
        bt[[c for c in bt_cols if c in bt.columns]].to_csv(
            os.path.join(outdir, "backtest_returns.csv"), index=False
        )
    with open(os.path.join(outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)

    print(f"[OK] NDVI signals written     : {outdir}/ndvi_signals.csv")
    print(f"[OK] Lead-lag analysis written : {outdir}/lead_lag_analysis.csv")
    print(f"[OK] Backtest returns written  : {outdir}/backtest_returns.csv")
    print(f"[OK] Summary written           : {outdir}/summary.json")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="NDVI satellite crop yields → agricultural futures signal")
    p.add_argument("--ndvi", required=True, help="Path to ndvi_data.csv")
    p.add_argument("--futures", required=True, help="Path to futures.csv")
    p.add_argument("--outdir", default="./output")
    p.add_argument("--roll-window", type=int, default=6)
    p.add_argument("--z-threshold", type=float, default=1.0)
    p.add_argument("--lag-max", type=int, default=8)
    p.add_argument("--crops", nargs="+", default=["corn", "wheat", "soybeans"])
    return p.parse_args()


def main():
    args = parse_args()

    print(f"[INFO] Loading NDVI data from    : {args.ndvi}")
    ndvi = load_ndvi(args.ndvi)
    print(f"[INFO] Loading futures data from : {args.futures}")
    futures = load_futures(args.futures)

    crops = [c.lower() for c in args.crops]
    ndvi_agg = compute_ndvi_zscore(ndvi, args.roll_window, crops)
    lag_df = compute_lead_lag(ndvi_agg, futures, args.lag_max)
    signals = generate_signals(ndvi_agg, args.z_threshold)

    # Find best lag per commodity
    best_lags = {}
    per_commodity_stats = []
    for crop in crops:
        crop_lags = lag_df[lag_df["commodity"] == crop]
        if crop_lags.empty:
            continue
        best_row = crop_lags.loc[crop_lags["correlation"].abs().idxmax()]
        best_lags[crop] = int(best_row["lag"])
        per_commodity_stats.append({
            "commodity": crop,
            "best_lag": int(best_row["lag"]),
            "best_correlation": float(best_row["correlation"]),
        })

    bt = backtest(signals, futures, best_lags)

    for stat in per_commodity_stats:
        if not bt.empty:
            stat["sharpe_proxy"] = compute_sharpe(bt, stat["commodity"])

    summary = {
        "crops_analyzed": crops,
        "roll_window": args.roll_window,
        "z_threshold": args.z_threshold,
        "lag_max": args.lag_max,
        "per_commodity": per_commodity_stats,
        "date_range_start": str(signals["date"].min().date()) if len(signals) > 0 else "N/A",
        "date_range_end": str(signals["date"].max().date()) if len(signals) > 0 else "N/A",
        "instruments": ["ZC=F", "ZW=F", "ZS=F", "CORN", "WEAT", "SOYB"],
        "signal_logic": "low_NDVI=LONG_futures, high_NDVI=SHORT_futures",
    }

    for stat in per_commodity_stats:
        print(f"  {stat['commodity']:12s}: best_lag={stat['best_lag']}  corr={stat['best_correlation']:.3f}"
              + (f"  sharpe={stat.get('sharpe_proxy', 0):.3f}" if "sharpe_proxy" in stat else ""))

    write_outputs(args.outdir, signals, lag_df, bt, summary)


if __name__ == "__main__":
    main()
