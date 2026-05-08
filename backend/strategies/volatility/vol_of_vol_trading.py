#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Vol-of-Vol (VVIX) Trading Strategy (Strategy #224)
====================================================
Uses VVIX (the VIX of VIX — the implied vol of VIX options) as a leading
indicator for VIX mean reversion. Extreme VVIX readings signal that VIX
itself is about to move sharply, generating directional VIX trades.

Signal logic:
  - VVIX z-score > 85th pct: spike imminent → long VIX (fear incoming)
  - VVIX z-score < 15th pct: vol exhausted → short VIX (mean reversion)
  - Otherwise: neutral

Inputs
------
vvix_data.csv
    Columns: date, vvix, vix, spy_return
    - date:       YYYY-MM-DD
    - vvix:       VVIX index level
    - vix:        VIX spot index level
    - spy_return: daily SPY return (decimal)

CLI
---
python vol_of_vol_trading.py --input vvix_data.csv --outdir ./out
    [--lookback 30] [--high-pct 85] [--low-pct 15]

Outputs (written to outdir)
---------------------------
vvix_signals.csv   — date, vvix, vix, vvix_zscore, vvix_pct_rank, signal, position
pnl.csv            — date, position, vix_return, daily_pnl, cum_pnl, drawdown
regime_stats.csv   — stats by signal regime
summary.json       — Sharpe, max_dd, win_rate, regime breakdown
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

def load_vvix_data(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "vvix", "vix", "spy_return"}
    missing = required - set(df.columns)
    if missing:
        sys.exit(f"ERROR: Missing columns: {missing}")
    df = df.sort_values("date").reset_index(drop=True)
    num_cols = ["vvix", "vix", "spy_return"]
    df[num_cols] = df[num_cols].apply(pd.to_numeric, errors="coerce")
    df = df.dropna(subset=["vvix", "vix"])
    return df


# ---------------------------------------------------------------------------
# VVIX metrics
# ---------------------------------------------------------------------------

def compute_vvix_metrics(df: pd.DataFrame, lookback: int = 30) -> pd.DataFrame:
    """
    Compute:
      - vvix_rolling_mean / std over lookback window
      - vvix_zscore: (vvix - mean) / std
      - vvix_pct_rank: rolling percentile rank
      - vix_pct_rank: rolling VIX percentile for context
      - vix_return: day-over-day VIX return (next day signal)
    """
    out = df.copy()
    roll = out["vvix"].rolling(window=lookback, min_periods=max(5, lookback // 4))
    out["vvix_mean"] = roll.mean()
    out["vvix_std"] = roll.std()
    out["vvix_zscore"] = (out["vvix"] - out["vvix_mean"]) / out["vvix_std"]
    out["vvix_pct_rank"] = roll.rank(pct=True) * 100

    # Longer-term context
    roll252 = out["vvix"].rolling(window=252, min_periods=60)
    out["vvix_pct_rank_252"] = roll252.rank(pct=True) * 100

    vix_roll = out["vix"].rolling(window=252, min_periods=60)
    out["vix_pct_rank"] = vix_roll.rank(pct=True) * 100

    # VIX return for P&L
    out["vix_return"] = out["vix"].pct_change()

    # VVIX change — momentum of vol-of-vol
    out["vvix_chg"] = out["vvix"].pct_change()
    out["vvix_chg_3d"] = out["vvix"].pct_change(3)
    return out


# ---------------------------------------------------------------------------
# Signal generation
# ---------------------------------------------------------------------------

def generate_signals(df: pd.DataFrame, high_pct: float = 85.0,
                     low_pct: float = 15.0) -> pd.DataFrame:
    """
    Signal:
      +1 (long VIX) when vvix_pct_rank > high_pct
         → VVIX elevated = vol spike imminent
      -1 (short VIX) when vvix_pct_rank < low_pct
         → VVIX depressed = VIX will mean-revert downward
       0 neutral

    Additional filter: don't go short VIX if VIX itself is already very high
    (>80th pct), as further spikes remain possible.
    """
    out = df.copy()
    long_vix = out["vvix_pct_rank"] >= high_pct
    short_vix = (out["vvix_pct_rank"] <= low_pct) & (out["vix_pct_rank"] <= 70)

    out["signal"] = np.select(
        [long_vix, short_vix],
        [1, -1],
        default=0,
    )

    # Signal on close, position next day
    out["position"] = out["signal"].shift(1).fillna(0)

    # Regime label for analysis
    out["regime"] = "neutral"
    out.loc[out["signal"] == 1, "regime"] = "long_vix"
    out.loc[out["signal"] == -1, "regime"] = "short_vix"
    return out


# ---------------------------------------------------------------------------
# P&L simulation
# ---------------------------------------------------------------------------

def simulate_pnl(df: pd.DataFrame) -> pd.DataFrame:
    """
    P&L based on VIX daily return.
    Long VIX (position=+1): profit when VIX rises.
    Short VIX (position=-1): profit when VIX falls.
    """
    out = df.copy()
    out["daily_pnl"] = out["position"] * out["vix_return"]
    out["cum_pnl"] = out["daily_pnl"].cumsum()
    roll_max = out["cum_pnl"].cummax()
    out["drawdown"] = out["cum_pnl"] - roll_max

    # SPY-adjusted alpha
    out["spy_alpha"] = out["daily_pnl"] - out["spy_return"]
    return out


# ---------------------------------------------------------------------------
# Regime statistics
# ---------------------------------------------------------------------------

def compute_regime_stats(df: pd.DataFrame) -> pd.DataFrame:
    """Compute mean/std returns and hit rates by regime."""
    records = []
    for regime in ["long_vix", "short_vix", "neutral"]:
        mask = df["regime"] == regime
        sub = df.loc[mask, "daily_pnl"].dropna()
        records.append({
            "regime": regime,
            "n_days": len(sub),
            "mean_daily_pnl": round(float(sub.mean()), 6) if len(sub) > 0 else None,
            "std_daily_pnl": round(float(sub.std()), 6) if len(sub) > 0 else None,
            "win_rate_pct": round(float((sub > 0).mean() * 100), 2) if len(sub) > 0 else None,
            "total_pnl": round(float(sub.sum()), 6) if len(sub) > 0 else None,
        })
    return pd.DataFrame(records)


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

def compute_summary(df: pd.DataFrame) -> dict:
    daily = df["daily_pnl"].dropna()
    n = len(daily)
    if n == 0:
        return {}
    total = daily.sum()
    std = daily.std()
    sharpe = daily.mean() / std * np.sqrt(252) if std > 0 else 0.0
    max_dd = float(df["drawdown"].min())
    win_rate = float((daily > 0).mean()) * 100

    vvix_long = df[df["position"] == 1]["vvix"].mean()
    vvix_short = df[df["position"] == -1]["vvix"].mean()
    n_trades = int((df["position"].diff().abs() > 0).sum())

    return {
        "total_pnl": round(float(total), 6),
        "sharpe_ratio": round(sharpe, 3),
        "max_drawdown": round(max_dd, 6),
        "win_rate_pct": round(win_rate, 2),
        "n_trading_days": n,
        "n_trades": n_trades,
        "avg_vvix_at_long_entry": round(float(vvix_long), 2) if not np.isnan(vvix_long) else None,
        "avg_vvix_at_short_entry": round(float(vvix_short), 2) if not np.isnan(vvix_short) else None,
        "pct_time_long_vix": round(float((df["position"] == 1).mean()) * 100, 2),
        "pct_time_short_vix": round(float((df["position"] == -1).mean()) * 100, 2),
    }


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(sig_df: pd.DataFrame, pnl_df: pd.DataFrame,
                  regime_df: pd.DataFrame, summary: dict, outdir: str) -> None:
    os.makedirs(outdir, exist_ok=True)

    sig_cols = ["date", "vvix", "vix", "vvix_mean", "vvix_std", "vvix_zscore",
                "vvix_pct_rank", "vvix_pct_rank_252", "vix_pct_rank",
                "regime", "signal", "position"]
    sig_cols = [c for c in sig_cols if c in sig_df.columns]
    sig_df[sig_cols].to_csv(
        os.path.join(outdir, "vvix_signals.csv"), index=False, float_format="%.6f"
    )

    pnl_cols = ["date", "position", "vix_return", "spy_return",
                "daily_pnl", "cum_pnl", "drawdown", "spy_alpha"]
    pnl_cols = [c for c in pnl_cols if c in pnl_df.columns]
    pnl_df[pnl_cols].to_csv(
        os.path.join(outdir, "pnl.csv"), index=False, float_format="%.6f"
    )

    regime_df.to_csv(os.path.join(outdir, "regime_stats.csv"), index=False)

    with open(os.path.join(outdir, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=2)

    print(f"Outputs written to: {outdir}")
    print(json.dumps(summary, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Vol-of-Vol (VVIX) Trading Strategy")
    p.add_argument("--input", required=True, help="Path to vvix_data.csv")
    p.add_argument("--outdir", default="./vvix_out",
                   help="Output directory (default: ./vvix_out)")
    p.add_argument("--lookback", type=int, default=30,
                   help="Rolling lookback for VVIX z-score (default: 30)")
    p.add_argument("--high-pct", type=float, default=85.0,
                   help="High VVIX percentile → long VIX signal (default: 85)")
    p.add_argument("--low-pct", type=float, default=15.0,
                   help="Low VVIX percentile → short VIX signal (default: 15)")
    return p.parse_args()


def main():
    args = parse_args()

    print(f"Loading VVIX data from: {args.input}")
    df = load_vvix_data(args.input)
    print(f"Loaded {len(df)} rows from {df['date'].min().date()} to {df['date'].max().date()}")

    print("Computing VVIX metrics...")
    metrics_df = compute_vvix_metrics(df, lookback=args.lookback)

    print("Generating signals...")
    sig_df = generate_signals(metrics_df, high_pct=args.high_pct, low_pct=args.low_pct)

    print("Simulating P&L...")
    pnl_df = simulate_pnl(sig_df)

    regime_df = compute_regime_stats(pnl_df)
    summary = compute_summary(pnl_df)

    print("Writing outputs...")
    write_outputs(sig_df, pnl_df, regime_df, summary, args.outdir)


if __name__ == "__main__":
    main()
