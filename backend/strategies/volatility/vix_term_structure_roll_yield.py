#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VIX Term Structure Roll Yield Strategy (Strategy #221)
=======================================================
Exploits VIX futures contango to collect roll yield by holding short volatility
positions (equivalent to long XIV/SVXY). When the VIX futures curve is in
contango, short-dated futures roll down toward spot, generating positive carry.

Inputs
------
vix_futures.csv
    Columns: date, VX1, VX2, VX3, VX4, spot_vix
    - date: YYYY-MM-DD
    - VX1..VX4: front through 4th-month VIX futures settlement prices
    - spot_vix: VIX spot index level

CLI
---
python vix_term_structure_roll_yield.py --input vix_futures.csv --outdir ./out
    [--contango-thresh 0.05] [--lookback 252] [--short-size 1.0]

Outputs (written to outdir)
---------------------------
roll_yield_signals.csv   — date, contango_ratio, roll_yield_pct, signal, position
term_structure.csv       — full term structure metrics per date
pnl.csv                  — daily P&L, cumulative P&L, drawdown
summary.json             — CAGR, Sharpe, max drawdown, win rate, trade count
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_vix_futures(path: str) -> pd.DataFrame:
    """Load and validate VIX futures CSV."""
    df = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "VX1", "VX2", "VX3", "VX4", "spot_vix"}
    missing = required - set(df.columns)
    if missing:
        sys.exit(f"ERROR: Missing columns in input: {missing}")
    df = df.sort_values("date").reset_index(drop=True)
    df[["VX1", "VX2", "VX3", "VX4", "spot_vix"]] = df[
        ["VX1", "VX2", "VX3", "VX4", "spot_vix"]
    ].apply(pd.to_numeric, errors="coerce")
    df = df.dropna(subset=["VX1", "VX2", "spot_vix"])
    return df


# ---------------------------------------------------------------------------
# Signal computation
# ---------------------------------------------------------------------------

def compute_term_structure(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute term structure metrics:
      - contango_1_2: (VX2/VX1 - 1) — primary signal
      - contango_1_3: (VX3/VX1 - 1)
      - roll_yield_daily: approx daily roll yield from VX1 rolling to spot
        estimated as (VX1 - spot_vix) / 30  (30 trading days per contract)
      - curve_slope: linear slope across VX1..VX4 tenors
      - backwardation: True when VX1 > VX2
    """
    out = df.copy()
    out["contango_1_2"] = out["VX2"] / out["VX1"] - 1
    out["contango_1_3"] = out["VX3"] / out["VX1"] - 1
    out["roll_yield_daily"] = (out["VX1"] - out["spot_vix"]) / 30.0
    # Annualised roll yield assuming 252 trading days
    out["roll_yield_ann"] = out["roll_yield_daily"] * 252 / out["VX1"] * 100

    # Linear slope of term structure across 4 contracts
    tenors = np.array([1, 2, 3, 4], dtype=float)
    slopes = []
    for _, row in out.iterrows():
        prices = np.array([row["VX1"], row["VX2"], row.get("VX3", np.nan),
                           row.get("VX4", np.nan)], dtype=float)
        mask = ~np.isnan(prices)
        if mask.sum() >= 2:
            slope = np.polyfit(tenors[mask], prices[mask], 1)[0]
        else:
            slope = np.nan
        slopes.append(slope)
    out["curve_slope"] = slopes
    out["backwardation"] = out["VX1"] > out["VX2"]
    return out


def generate_signals(df: pd.DataFrame, contango_thresh: float = 0.05,
                     lookback: int = 252) -> pd.DataFrame:
    """
    Signal logic:
      +1  (short vol / long roll yield) when contango_1_2 > contango_thresh
      -1  (long vol / flight to safety)  when backwardation is True
       0  neutral

    Additionally compute rolling percentile of contango ratio.
    """
    out = df.copy()
    out["contango_pct_rank"] = (
        out["contango_1_2"]
        .rolling(lookback, min_periods=max(1, lookback // 4))
        .rank(pct=True)
    )

    conditions = [
        out["contango_1_2"] > contango_thresh,
        out["backwardation"],
    ]
    choices = [1, -1]
    out["signal"] = np.select(conditions, choices, default=0)

    # Position = previous day's signal (trade on close, execute next open)
    out["position"] = out["signal"].shift(1).fillna(0)
    return out


# ---------------------------------------------------------------------------
# P&L computation
# ---------------------------------------------------------------------------

def compute_pnl(df: pd.DataFrame, short_size: float = 1.0) -> pd.DataFrame:
    """
    Simulate short vol (long roll yield) P&L.
    Daily P&L when position = +1 (short vol):
        roll_component = roll_yield_daily (positive in contango)
        spot_component = (VX1_prev - VX1_today) / VX1_prev  (short = profit when VX1 falls)
    Daily P&L when position = -1 (long vol):
        spot_component = (VX1_today - VX1_prev) / VX1_prev
    """
    out = df.copy()
    out["vx1_ret"] = out["VX1"].pct_change()

    # Short vol: profit when VX1 declines + collect roll yield
    out["daily_pnl"] = np.where(
        out["position"] == 1,
        short_size * (-out["vx1_ret"] + out["roll_yield_daily"] / out["VX1"]),
        np.where(
            out["position"] == -1,
            short_size * out["vx1_ret"],
            0.0,
        ),
    )
    out["cum_pnl"] = out["daily_pnl"].cumsum()

    # Drawdown
    roll_max = out["cum_pnl"].cummax()
    out["drawdown"] = out["cum_pnl"] - roll_max
    return out


# ---------------------------------------------------------------------------
# Summary statistics
# ---------------------------------------------------------------------------

def compute_summary(pnl_df: pd.DataFrame) -> dict:
    """Compute CAGR, Sharpe, max drawdown, win rate from daily P&L series."""
    daily = pnl_df["daily_pnl"].dropna()
    n_days = len(daily)
    if n_days == 0:
        return {}

    trading_days = 252
    total_return = daily.sum()
    years = n_days / trading_days
    cagr = ((1 + total_return) ** (1 / years) - 1) * 100 if years > 0 else 0.0

    mean_ret = daily.mean()
    std_ret = daily.std()
    sharpe = (mean_ret / std_ret * np.sqrt(trading_days)) if std_ret > 0 else 0.0

    max_dd = pnl_df["drawdown"].min()
    win_rate = (daily > 0).mean() * 100

    # Count trades (position changes)
    trades = (pnl_df["position"].diff().abs() > 0).sum()

    return {
        "total_return_pct": round(total_return * 100, 2),
        "cagr_pct": round(cagr, 2),
        "sharpe_ratio": round(sharpe, 3),
        "max_drawdown_pct": round(max_dd * 100, 2),
        "win_rate_pct": round(win_rate, 2),
        "n_trading_days": n_days,
        "n_trades": int(trades),
        "avg_daily_roll_yield_pct": round(
            pnl_df.loc[pnl_df["position"] == 1, "roll_yield_daily"].mean(), 4
        ),
    }


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(ts_df: pd.DataFrame, pnl_df: pd.DataFrame,
                  summary: dict, outdir: str) -> None:
    """Write all output CSVs and JSON summary."""
    os.makedirs(outdir, exist_ok=True)

    # Signal file
    sig_cols = ["date", "contango_1_2", "roll_yield_daily", "roll_yield_ann",
                "contango_pct_rank", "signal", "position"]
    sig_cols = [c for c in sig_cols if c in pnl_df.columns]
    pnl_df[sig_cols].to_csv(
        os.path.join(outdir, "roll_yield_signals.csv"), index=False,
        float_format="%.6f"
    )

    # Full term structure
    ts_cols = ["date", "spot_vix", "VX1", "VX2", "VX3", "VX4",
               "contango_1_2", "contango_1_3", "curve_slope",
               "backwardation", "roll_yield_daily", "roll_yield_ann"]
    ts_cols = [c for c in ts_cols if c in ts_df.columns]
    ts_df[ts_cols].to_csv(
        os.path.join(outdir, "term_structure.csv"), index=False,
        float_format="%.6f"
    )

    # P&L
    pnl_cols = ["date", "position", "vx1_ret", "daily_pnl", "cum_pnl", "drawdown"]
    pnl_cols = [c for c in pnl_cols if c in pnl_df.columns]
    pnl_df[pnl_cols].to_csv(
        os.path.join(outdir, "pnl.csv"), index=False, float_format="%.6f"
    )

    # JSON summary
    with open(os.path.join(outdir, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=2)

    print(f"Outputs written to: {outdir}")
    print(json.dumps(summary, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(
        description="VIX Term Structure Roll Yield Strategy"
    )
    p.add_argument("--input", required=True, help="Path to vix_futures.csv")
    p.add_argument("--outdir", default="./vix_roll_yield_out",
                   help="Output directory (default: ./vix_roll_yield_out)")
    p.add_argument("--contango-thresh", type=float, default=0.05,
                   help="Contango ratio threshold for signal (default: 0.05 = 5%%)")
    p.add_argument("--lookback", type=int, default=252,
                   help="Rolling lookback for percentile rank (default: 252)")
    p.add_argument("--short-size", type=float, default=1.0,
                   help="Notional size of short vol position (default: 1.0)")
    return p.parse_args()


def main():
    args = parse_args()

    print(f"Loading VIX futures data from: {args.input}")
    raw = load_vix_futures(args.input)
    print(f"Loaded {len(raw)} rows spanning {raw['date'].min().date()} "
          f"to {raw['date'].max().date()}")

    print("Computing term structure metrics...")
    ts = compute_term_structure(raw)

    print("Generating signals...")
    sig = generate_signals(ts, contango_thresh=args.contango_thresh,
                           lookback=args.lookback)

    print("Simulating P&L...")
    result = compute_pnl(sig, short_size=args.short_size)

    summary = compute_summary(result)

    print("Writing outputs...")
    write_outputs(ts, result, summary, args.outdir)


if __name__ == "__main__":
    main()
