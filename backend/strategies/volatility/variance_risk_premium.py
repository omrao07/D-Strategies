#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Variance Risk Premium Strategy (Strategy #223)
===============================================
Exploits the persistent premium that implied volatility commands over
realized volatility. Sells variance (short straddle / short variance swap
equivalent) when the VRP exceeds its 75th percentile, collecting the spread
between implied and realized vol as P&L.

Inputs
------
vol_data.csv
    Columns: date, implied_vol_30d, realized_vol_30d, underlying
    - date:             YYYY-MM-DD
    - implied_vol_30d:  30-day ATM implied vol (annualised, decimal)
    - realized_vol_30d: 30-day realized/historical vol (annualised, decimal)
    - underlying:       underlying price (used for position sizing)

CLI
---
python variance_risk_premium.py --input vol_data.csv --outdir ./out
    [--vrp-pct 75] [--lookback 252] [--hold-days 21]

Outputs (written to outdir)
---------------------------
vrp_signals.csv   — date, iv, rv, vrp, vrp_pct_rank, signal, position
backtest_pnl.csv  — date, position, daily_pnl, cum_pnl, drawdown
summary.json      — CAGR, Sharpe, max drawdown, avg VRP at entry
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

def load_vol_data(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "implied_vol_30d", "realized_vol_30d", "underlying"}
    missing = required - set(df.columns)
    if missing:
        sys.exit(f"ERROR: Missing columns: {missing}")
    df = df.sort_values("date").reset_index(drop=True)
    num_cols = ["implied_vol_30d", "realized_vol_30d", "underlying"]
    df[num_cols] = df[num_cols].apply(pd.to_numeric, errors="coerce")
    df = df.dropna(subset=["implied_vol_30d", "realized_vol_30d"])
    return df


# ---------------------------------------------------------------------------
# VRP computation
# ---------------------------------------------------------------------------

def compute_vrp(df: pd.DataFrame, lookback: int = 252) -> pd.DataFrame:
    """
    VRP = implied_vol_30d - realized_vol_30d
    Also compute:
      - vrp_rolling_mean, vrp_rolling_std (for z-score)
      - vrp_z_score
      - vrp_pct_rank (percentile in rolling window)
      - vrp_75th (75th percentile threshold)
    """
    out = df.copy()
    out["vrp"] = out["implied_vol_30d"] - out["realized_vol_30d"]

    roll = out["vrp"].rolling(window=lookback, min_periods=max(1, lookback // 4))
    out["vrp_rolling_mean"] = roll.mean()
    out["vrp_rolling_std"] = roll.std()
    out["vrp_z_score"] = (out["vrp"] - out["vrp_rolling_mean"]) / out["vrp_rolling_std"]
    out["vrp_pct_rank"] = roll.rank(pct=True) * 100
    out["vrp_75th"] = roll.quantile(0.75)
    out["vrp_25th"] = roll.quantile(0.25)
    return out


# ---------------------------------------------------------------------------
# Signal generation
# ---------------------------------------------------------------------------

def generate_signals(vrp_df: pd.DataFrame, vrp_pct: float = 75.0) -> pd.DataFrame:
    """
    Signal:
      +1 (sell variance) when VRP > vrp_pct-th percentile
      -1 (buy variance / long vol hedge) when VRP < 25th percentile (IV cheap vs RV)
       0 neutral

    Position is previous day's signal (signal on close, execute next day).
    """
    out = vrp_df.copy()
    conditions = [
        out["vrp_pct_rank"] >= vrp_pct,
        out["vrp_pct_rank"] <= (100 - vrp_pct),
    ]
    choices = [1, -1]
    out["signal"] = np.select(conditions, choices, default=0)
    out["position"] = out["signal"].shift(1).fillna(0)
    return out


# ---------------------------------------------------------------------------
# Backtest P&L
# ---------------------------------------------------------------------------

def backtest_pnl(df: pd.DataFrame, hold_days: int = 21) -> pd.DataFrame:
    """
    Simulate selling variance:
    - When position = +1 (short variance): enter short variance swap at IV.
      Over next hold_days, P&L = (IV_entry - RV_realised) normalised daily.
    - Simplified daily P&L:
        short_var_pnl = (iv_entry - rv_today) / sqrt(252)  each day in trade
    - Long vol (position = -1): P&L = (rv_today - iv_entry) / sqrt(252)

    For simplicity, use current-day RV as proxy for realised vol over holding period.
    """
    out = df.copy()
    out["iv_entry"] = np.where(out["position"] != 0, out["implied_vol_30d"], np.nan)
    out["iv_entry"] = out["iv_entry"].ffill()

    # Daily P&L per unit notional
    daily_scale = 1.0 / np.sqrt(252)
    out["daily_pnl"] = np.where(
        out["position"] == 1,
        (out["iv_entry"] - out["realized_vol_30d"]) * daily_scale,
        np.where(
            out["position"] == -1,
            (out["realized_vol_30d"] - out["iv_entry"]) * daily_scale,
            0.0,
        ),
    )

    # Normalise by implied vol to get % return
    out["daily_pnl_pct"] = out["daily_pnl"] / out["implied_vol_30d"].replace(0, np.nan)
    out["cum_pnl"] = out["daily_pnl"].cumsum()

    roll_max = out["cum_pnl"].cummax()
    out["drawdown"] = out["cum_pnl"] - roll_max
    return out


# ---------------------------------------------------------------------------
# Summary statistics
# ---------------------------------------------------------------------------

def compute_summary(df: pd.DataFrame) -> dict:
    daily = df["daily_pnl"].dropna()
    n_days = len(daily)
    if n_days == 0:
        return {}

    total = daily.sum()
    years = n_days / 252
    cagr = ((1 + total) ** (1 / max(years, 1e-6)) - 1) * 100

    std = daily.std()
    sharpe = daily.mean() / std * np.sqrt(252) if std > 0 else 0.0
    max_dd = df["drawdown"].min()
    win_rate = (daily > 0).mean() * 100

    short_var_days = df[df["position"] == 1]
    avg_vrp_entry = float(
        short_var_days["vrp"].mean()
    ) if not short_var_days.empty else None

    n_trades = int((df["position"].diff().abs() > 0).sum())

    return {
        "total_pnl_vol_pts": round(total, 6),
        "cagr_vol_pts": round(cagr, 4),
        "sharpe_ratio": round(sharpe, 3),
        "max_drawdown_vol_pts": round(float(max_dd), 6),
        "win_rate_pct": round(win_rate, 2),
        "avg_vrp_at_entry": round(avg_vrp_entry * 100, 4) if avg_vrp_entry else None,
        "avg_vrp_overall_pct": round(float(df["vrp"].mean()) * 100, 4),
        "n_trading_days": n_days,
        "n_trades": n_trades,
        "pct_time_short_variance": round(
            (df["position"] == 1).mean() * 100, 2
        ),
    }


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(sig_df: pd.DataFrame, pnl_df: pd.DataFrame,
                  summary: dict, outdir: str) -> None:
    os.makedirs(outdir, exist_ok=True)

    sig_cols = ["date", "implied_vol_30d", "realized_vol_30d", "vrp",
                "vrp_rolling_mean", "vrp_rolling_std", "vrp_z_score",
                "vrp_pct_rank", "vrp_75th", "signal", "position"]
    sig_cols = [c for c in sig_cols if c in sig_df.columns]
    sig_df[sig_cols].to_csv(
        os.path.join(outdir, "vrp_signals.csv"), index=False, float_format="%.6f"
    )

    pnl_cols = ["date", "position", "iv_entry", "realized_vol_30d",
                "daily_pnl", "daily_pnl_pct", "cum_pnl", "drawdown"]
    pnl_cols = [c for c in pnl_cols if c in pnl_df.columns]
    pnl_df[pnl_cols].to_csv(
        os.path.join(outdir, "backtest_pnl.csv"), index=False, float_format="%.6f"
    )

    with open(os.path.join(outdir, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=2)

    print(f"Outputs written to: {outdir}")
    print(json.dumps(summary, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Variance Risk Premium Strategy")
    p.add_argument("--input", required=True, help="Path to vol_data.csv")
    p.add_argument("--outdir", default="./vrp_out",
                   help="Output directory (default: ./vrp_out)")
    p.add_argument("--vrp-pct", type=float, default=75.0,
                   help="VRP percentile threshold for sell signal (default: 75)")
    p.add_argument("--lookback", type=int, default=252,
                   help="Rolling lookback window in days (default: 252)")
    p.add_argument("--hold-days", type=int, default=21,
                   help="Holding period for variance swap (default: 21)")
    return p.parse_args()


def main():
    args = parse_args()

    print(f"Loading vol data from: {args.input}")
    df = load_vol_data(args.input)
    print(f"Loaded {len(df)} rows from {df['date'].min().date()} to {df['date'].max().date()}")

    print("Computing VRP metrics...")
    vrp_df = compute_vrp(df, lookback=args.lookback)

    print("Generating signals...")
    sig_df = generate_signals(vrp_df, vrp_pct=args.vrp_pct)

    print("Running backtest...")
    pnl_df = backtest_pnl(sig_df, hold_days=args.hold_days)

    summary = compute_summary(pnl_df)

    print("Writing outputs...")
    write_outputs(sig_df, pnl_df, summary, args.outdir)


if __name__ == "__main__":
    main()
