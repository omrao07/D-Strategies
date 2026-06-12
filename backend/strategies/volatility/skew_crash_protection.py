#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Skew Crash Protection Strategy (Strategy #222)
===============================================
Buys OTM puts as tail-hedge protection when the implied volatility skew
collapses below its historical 5th percentile. A collapsing skew indicates
the market is under-pricing downside risk — an opportune moment to acquire
cheap tail protection.

Inputs
------
options_data.csv
    Columns: date, strike, expiry, type, iv, delta, underlying_price
    - date:            trade date (YYYY-MM-DD)
    - strike:          option strike price
    - expiry:          option expiry date (YYYY-MM-DD)
    - type:            'call' or 'put'
    - iv:              implied volatility (decimal, e.g. 0.20 = 20%)
    - delta:           option delta (absolute value, e.g. 0.25 for 25-delta)
    - underlying_price: spot price of underlying

CLI
---
python skew_crash_protection.py --input options_data.csv --outdir ./out
    [--skew-pct 5] [--lookback 252] [--target-delta 0.25]

Outputs (written to outdir)
---------------------------
skew_timeseries.csv  — date, iv_25p, iv_atm, skew_25p, skew_pct_rank, signal
signal_dates.csv     — dates where buy signal triggered with skew level
hedge_cost.csv       — estimated hedge cost and annualised cost per signal
summary.json         — signal stats, avg skew at buy, avg hedge cost
"""

import argparse
import json
import os
import sys

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_options(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date", "expiry"])
    required = {"date", "strike", "expiry", "type", "iv", "delta", "underlying_price"}
    missing = required - set(df.columns)
    if missing:
        sys.exit(f"ERROR: Missing columns: {missing}")
    df["type"] = df["type"].str.lower().str.strip()
    num_cols = ["strike", "iv", "delta", "underlying_price"]
    df[num_cols] = df[num_cols].apply(pd.to_numeric, errors="coerce")
    df = df.dropna(subset=["iv", "delta", "underlying_price"])
    df = df.sort_values("date").reset_index(drop=True)
    return df


# ---------------------------------------------------------------------------
# Skew computation helpers
# ---------------------------------------------------------------------------

def get_nearest_expiry_options(day_df: pd.DataFrame, trade_date: pd.Timestamp,
                                min_dte: int = 20, max_dte: int = 45) -> pd.DataFrame:
    """Filter to the nearest expiry within [min_dte, max_dte] trading days."""
    day_df = day_df.copy()
    day_df["dte"] = (day_df["expiry"] - trade_date).dt.days
    valid = day_df[(day_df["dte"] >= min_dte) & (day_df["dte"] <= max_dte)]
    if valid.empty:
        return pd.DataFrame()
    nearest_exp = valid["expiry"].min()
    return valid[valid["expiry"] == nearest_exp]


def find_iv_by_delta(opts: pd.DataFrame, option_type: str,
                     target_delta: float, tol: float = 0.05) -> float:
    """
    Find the implied vol of the option whose |delta| is closest to target_delta.
    Returns NaN if no option is within tolerance.
    """
    subset = opts[opts["type"] == option_type].copy()
    if subset.empty:
        return np.nan
    subset["delta_abs"] = subset["delta"].abs()
    subset["dist"] = (subset["delta_abs"] - target_delta).abs()
    best = subset.loc[subset["dist"].idxmin()]
    if best["dist"] > tol:
        return np.nan
    return best["iv"]


def find_atm_iv(opts: pd.DataFrame, option_type: str = "put") -> float:
    """Find ATM IV: option whose delta is closest to 0.50."""
    return find_iv_by_delta(opts, option_type, 0.50, tol=0.15)


# ---------------------------------------------------------------------------
# Build daily skew time series
# ---------------------------------------------------------------------------

def compute_skew_series(df: pd.DataFrame, target_delta: float = 0.25) -> pd.DataFrame:
    """
    For each date compute:
      iv_25p   — IV of 25-delta put
      iv_atm   — IV of 50-delta put (ATM proxy)
      skew_25p — iv_25p - iv_atm  (positive = normal skew)
    """
    records = []
    for date, day_df in df.groupby("date"):
        near = get_nearest_expiry_options(day_df, date)
        if near.empty:
            continue
        iv_25p = find_iv_by_delta(near, "put", target_delta)
        iv_atm = find_atm_iv(near, "put")
        if np.isnan(iv_25p) or np.isnan(iv_atm):
            continue
        skew = iv_25p - iv_atm
        records.append({
            "date": date,
            "iv_25p": iv_25p,
            "iv_atm": iv_atm,
            "skew_25p": skew,
        })

    if not records:
        sys.exit("ERROR: No valid skew observations computed. Check input data.")

    skew_df = pd.DataFrame(records).sort_values("date").reset_index(drop=True)
    return skew_df


# ---------------------------------------------------------------------------
# Signal generation
# ---------------------------------------------------------------------------

def generate_signals(skew_df: pd.DataFrame, lookback: int = 252,
                     skew_pct: float = 5.0) -> pd.DataFrame:
    """
    Signal: buy OTM puts when skew_25p < rolling skew_pct-th percentile.
    """
    out = skew_df.copy()
    roll = out["skew_25p"].rolling(window=lookback, min_periods=max(1, lookback // 4))
    out["skew_pct_rank"] = roll.rank(pct=True) * 100

    # Threshold: skew is in lowest skew_pct % of history
    out["skew_threshold"] = roll.quantile(skew_pct / 100.0)
    out["signal"] = (out["skew_25p"] <= out["skew_threshold"]).astype(int)

    # Avoid repeated signals on consecutive days — flag only first day of entry
    out["signal_new"] = ((out["signal"] == 1) & (out["signal"].shift(1) != 1)).astype(int)
    return out


# ---------------------------------------------------------------------------
# Hedge cost analysis
# ---------------------------------------------------------------------------

def estimate_hedge_cost(df_orig: pd.DataFrame, signal_df: pd.DataFrame,
                        target_delta: float = 0.25, hold_days: int = 30) -> pd.DataFrame:
    """
    For each signal date, estimate the cost of buying a 25-delta put.
    Cost proxy: option premium approximated via Black-Scholes simplified:
        premium ≈ IV * sqrt(T) * S * 0.4  (rough ATM approximation adjusted for delta)
    Also estimate annualised hedge cost as % of notional.
    """
    signal_dates = signal_df[signal_df["signal_new"] == 1]["date"].tolist()
    records = []
    for sd in signal_dates:
        day = df_orig[df_orig["date"] == sd].copy()
        near = get_nearest_expiry_options(day, sd)
        if near.empty:
            continue
        put_row = near[near["type"] == "put"].copy()
        if put_row.empty:
            continue
        put_row["delta_abs"] = put_row["delta"].abs()
        put_row["dist"] = (put_row["delta_abs"] - target_delta).abs()
        best = put_row.loc[put_row["dist"].idxmin()]

        S = best["underlying_price"]
        K = best["strike"]
        iv = best["iv"]
        dte = max((best["expiry"] - sd).days, 1)
        T = dte / 365.0

        # Black-Scholes put premium (simplified via delta approximation)
        moneyness = K / S
        # Approximate premium: IV * sqrt(T) * S * 0.4 * delta_factor
        delta_factor = best["delta_abs"] / 0.5  # scale relative to ATM
        premium_est = iv * np.sqrt(T) * S * 0.4 * delta_factor

        ann_cost_pct = (premium_est / S) * (365 / dte) * 100

        skew_val = signal_df.loc[signal_df["date"] == sd, "skew_25p"].values
        skew_val = float(skew_val[0]) if len(skew_val) else np.nan

        records.append({
            "signal_date": sd,
            "strike": K,
            "underlying_price": S,
            "moneyness": round(moneyness, 4),
            "dte": dte,
            "iv_25p": round(iv, 4),
            "skew_at_signal": round(skew_val, 4),
            "est_premium": round(premium_est, 4),
            "est_premium_pct": round(premium_est / S * 100, 4),
            "ann_cost_pct": round(ann_cost_pct, 4),
        })

    return pd.DataFrame(records)


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(skew_sig: pd.DataFrame, signal_dates: pd.DataFrame,
                  hedge_cost: pd.DataFrame, outdir: str) -> None:
    os.makedirs(outdir, exist_ok=True)

    skew_cols = ["date", "iv_25p", "iv_atm", "skew_25p",
                 "skew_pct_rank", "skew_threshold", "signal", "signal_new"]
    skew_cols = [c for c in skew_cols if c in skew_sig.columns]
    skew_sig[skew_cols].to_csv(
        os.path.join(outdir, "skew_timeseries.csv"), index=False, float_format="%.6f"
    )

    signal_df_out = skew_sig[skew_sig["signal_new"] == 1][
        ["date", "skew_25p", "skew_pct_rank", "iv_atm", "iv_25p"]
    ].copy()
    signal_df_out.to_csv(
        os.path.join(outdir, "signal_dates.csv"), index=False, float_format="%.6f"
    )

    if not hedge_cost.empty:
        hedge_cost.to_csv(
            os.path.join(outdir, "hedge_cost.csv"), index=False, float_format="%.6f"
        )

    n_signals = int(skew_sig["signal_new"].sum())
    summary = {
        "total_signal_days": n_signals,
        "avg_skew_at_signal": round(
            float(skew_sig.loc[skew_sig["signal_new"] == 1, "skew_25p"].mean()), 4
        ) if n_signals > 0 else None,
        "avg_skew_overall": round(float(skew_sig["skew_25p"].mean()), 4),
        "skew_5th_pct": round(float(skew_sig["skew_25p"].quantile(0.05)), 4),
        "avg_ann_hedge_cost_pct": round(
            float(hedge_cost["ann_cost_pct"].mean()), 4
        ) if not hedge_cost.empty else None,
        "total_observations": len(skew_sig),
    }

    with open(os.path.join(outdir, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=2)

    print(f"Outputs written to: {outdir}")
    print(json.dumps(summary, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Skew Crash Protection Strategy")
    p.add_argument("--input", required=True, help="Path to options_data.csv")
    p.add_argument("--outdir", default="./skew_crash_out",
                   help="Output directory (default: ./skew_crash_out)")
    p.add_argument("--skew-pct", type=float, default=5.0,
                   help="Percentile threshold for low-skew signal (default: 5)")
    p.add_argument("--lookback", type=int, default=252,
                   help="Rolling window for percentile (default: 252)")
    p.add_argument("--target-delta", type=float, default=0.25,
                   help="Target delta for OTM put (default: 0.25)")
    return p.parse_args()


def main():
    args = parse_args()

    print(f"Loading options data from: {args.input}")
    df = load_options(args.input)
    print(f"Loaded {len(df)} option records")

    print("Computing skew time series...")
    skew_df = compute_skew_series(df, target_delta=args.target_delta)
    print(f"Computed skew for {len(skew_df)} dates")

    print("Generating signals...")
    sig_df = generate_signals(skew_df, lookback=args.lookback, skew_pct=args.skew_pct)

    print("Estimating hedge costs...")
    hc_df = estimate_hedge_cost(df, sig_df, target_delta=args.target_delta)

    print("Writing outputs...")
    write_outputs(sig_df, sig_df[sig_df["signal_new"] == 1], hc_df, args.outdir)


if __name__ == "__main__":
    main()
