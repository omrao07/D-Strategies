#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nifty_bank_nifty_divergence.py — Nifty vs BankNifty Relative Strength Rotation Strategy

Description:
    Computes rolling 20-day relative strength of BankNifty vs Nifty50. A z-score
    of the RS ratio identifies when BankNifty is significantly outperforming or
    underperforming Nifty. Signals long BankNifty futures when z > 1.5 (BankNifty
    leading), signals long Nifty when z < -1.5 (Nifty leading). Also incorporates
    Nifty IT and Nifty Pharma for sector rotation context.

Inputs:
    indices.csv — columns: date, nifty50, banknifty, nifty_it, nifty_pharma
    Date format: YYYY-MM-DD. All values are index closing levels.

CLI:
    python nifty_bank_nifty_divergence.py \\
        --input indices.csv \\
        --outdir ./output_nifty_divergence \\
        --rs_window 20 \\
        --z_entry 1.5 \\
        --z_exit 0.5

Outputs (written to outdir):
    rs_series.csv       — rolling RS ratio and z-score per date
    signals.csv         — long/short/flat signals with entry/exit dates
    backtest_pnl.csv    — daily P&L, cumulative returns, drawdown
    summary.json        — Sharpe ratio, total return, max drawdown, win rate
"""

import argparse
import json
import os
import sys
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_indices(path: str) -> pd.DataFrame:
    """Load and validate indices CSV."""
    required = {"date", "nifty50", "banknifty", "nifty_it", "nifty_pharma"}
    df = pd.read_csv(path, parse_dates=["date"])
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Missing columns in indices.csv: {missing}")
    df = df.sort_values("date").reset_index(drop=True)
    df[["nifty50", "banknifty", "nifty_it", "nifty_pharma"]] = (
        df[["nifty50", "banknifty", "nifty_it", "nifty_pharma"]].apply(pd.to_numeric, errors="coerce")
    )
    df = df.dropna(subset=["nifty50", "banknifty"])
    return df


# ---------------------------------------------------------------------------
# Signal computation
# ---------------------------------------------------------------------------

def compute_relative_strength(df: pd.DataFrame, window: int) -> pd.DataFrame:
    """
    Compute rolling relative strength of BankNifty vs Nifty50.

    RS = BankNifty / Nifty50
    RS_momentum = RS / RS.rolling(window).mean() — 1   (relative momentum)
    z_score = (RS - RS.rolling.mean) / RS.rolling.std
    """
    df = df.copy()

    # Raw ratio
    df["rs_ratio"] = df["banknifty"] / df["nifty50"]

    # Rolling statistics over window
    df["rs_roll_mean"] = df["rs_ratio"].rolling(window).mean()
    df["rs_roll_std"] = df["rs_ratio"].rolling(window).std()

    # Z-score: how many stddevs current RS is from rolling mean
    df["rs_zscore"] = (df["rs_ratio"] - df["rs_roll_mean"]) / df["rs_roll_std"]

    # Supplementary: IT and Pharma RS vs Nifty
    df["it_rs"] = df["nifty_it"] / df["nifty50"]
    df["pharma_rs"] = df["nifty_pharma"] / df["nifty50"]
    df["it_rs_zscore"] = (
        (df["it_rs"] - df["it_rs"].rolling(window).mean())
        / df["it_rs"].rolling(window).std()
    )
    df["pharma_rs_zscore"] = (
        (df["pharma_rs"] - df["pharma_rs"].rolling(window).mean())
        / df["pharma_rs"].rolling(window).std()
    )

    # Daily returns for each index
    df["nifty_ret"] = df["nifty50"].pct_change()
    df["banknifty_ret"] = df["banknifty"].pct_change()

    return df


def generate_signals(df: pd.DataFrame, z_entry: float, z_exit: float) -> pd.DataFrame:
    """
    Generate long/flat/short signals based on RS z-score.

    Signal logic:
        z > +z_entry  → LONG_BANKNIFTY (BankNifty futures, short Nifty hedge)
        z < -z_entry  → LONG_NIFTY     (Nifty futures, short BankNifty hedge)
        |z| < z_exit  → FLAT           (exit any position)
    """
    df = df.copy()
    df["signal"] = "FLAT"
    df["position"] = 0  # +1 long BankNifty, -1 long Nifty, 0 flat

    position = 0
    positions = []

    for i, row in df.iterrows():
        z = row["rs_zscore"]
        if pd.isna(z):
            positions.append(0)
            continue

        if position == 0:
            if z > z_entry:
                position = 1   # long BankNifty
            elif z < -z_entry:
                position = -1  # long Nifty
        elif position == 1:
            if z < z_exit:
                position = 0
        elif position == -1:
            if z > -z_exit:
                position = 0

        positions.append(position)

    df["position"] = positions
    df["signal"] = df["position"].map({1: "LONG_BANKNIFTY", -1: "LONG_NIFTY", 0: "FLAT"})

    return df


def compute_backtest(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute strategy P&L:
        - LONG_BANKNIFTY (+1): earns BankNifty return
        - LONG_NIFTY (-1): earns Nifty return
    Position is taken next bar after signal (1-bar delay).
    """
    df = df.copy()
    df["next_banknifty_ret"] = df["banknifty_ret"].shift(-1)
    df["next_nifty_ret"] = df["nifty_ret"].shift(-1)

    def daily_pnl(row):
        pos = row["position"]
        if pos == 1:
            return row["next_banknifty_ret"]
        elif pos == -1:
            return row["next_nifty_ret"]
        return 0.0

    df["strategy_return"] = df.apply(daily_pnl, axis=1)
    df["strategy_return"] = df["strategy_return"].fillna(0.0)

    # Cumulative returns
    df["cum_strategy"] = (1 + df["strategy_return"]).cumprod()
    df["cum_banknifty"] = (1 + df["banknifty_ret"].fillna(0)).cumprod()
    df["cum_nifty"] = (1 + df["nifty_ret"].fillna(0)).cumprod()

    # Drawdown
    rolling_max = df["cum_strategy"].cummax()
    df["drawdown"] = df["cum_strategy"] / rolling_max - 1

    return df


# ---------------------------------------------------------------------------
# Performance summary
# ---------------------------------------------------------------------------

def compute_summary(df: pd.DataFrame) -> dict:
    """Compute performance statistics."""
    rets = df["strategy_return"].dropna()
    if len(rets) < 2:
        return {}

    total_return = float(df["cum_strategy"].iloc[-1] - 1)
    annual_factor = 252
    mean_ret = rets.mean() * annual_factor
    std_ret = rets.std() * np.sqrt(annual_factor)
    sharpe = mean_ret / std_ret if std_ret > 0 else 0.0

    max_dd = float(df["drawdown"].min())
    trades = df[df["position"].diff().fillna(0) != 0]
    n_trades = len(trades)

    # Win rate: days when strategy return > 0 among non-flat days
    active = df[df["position"] != 0]["strategy_return"]
    win_rate = float((active > 0).sum() / len(active)) if len(active) > 0 else 0.0

    return {
        "total_return_pct": round(total_return * 100, 2),
        "annualized_sharpe": round(sharpe, 3),
        "max_drawdown_pct": round(max_dd * 100, 2),
        "win_rate_pct": round(win_rate * 100, 2),
        "n_signals": n_trades,
        "active_days": int((df["position"] != 0).sum()),
        "banknifty_buy_hold_return_pct": round(float(df["cum_banknifty"].iloc[-1] - 1) * 100, 2),
        "nifty_buy_hold_return_pct": round(float(df["cum_nifty"].iloc[-1] - 1) * 100, 2),
    }


# ---------------------------------------------------------------------------
# Output writers
# ---------------------------------------------------------------------------

def write_outputs(df: pd.DataFrame, summary: dict, outdir: str) -> None:
    """Write all output CSVs and JSON summary."""
    os.makedirs(outdir, exist_ok=True)

    rs_cols = ["date", "nifty50", "banknifty", "rs_ratio", "rs_roll_mean",
               "rs_roll_std", "rs_zscore", "it_rs_zscore", "pharma_rs_zscore"]
    df[rs_cols].to_csv(os.path.join(outdir, "rs_series.csv"), index=False)

    sig_cols = ["date", "rs_zscore", "signal", "position"]
    df[sig_cols].to_csv(os.path.join(outdir, "signals.csv"), index=False)

    pnl_cols = ["date", "strategy_return", "cum_strategy", "cum_banknifty",
                "cum_nifty", "drawdown", "position"]
    df[pnl_cols].to_csv(os.path.join(outdir, "backtest_pnl.csv"), index=False)

    with open(os.path.join(outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)

    print(f"[nifty_bank_nifty_divergence] Outputs written to: {outdir}")
    print(json.dumps(summary, indent=2))


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Nifty vs BankNifty RS Rotation Strategy")
    p.add_argument("--input", default="indices.csv", help="Path to indices.csv")
    p.add_argument("--outdir", default="./output_nifty_divergence")
    p.add_argument("--rs_window", type=int, default=20, help="Rolling window for RS z-score")
    p.add_argument("--z_entry", type=float, default=1.5, help="Z-score threshold for entry")
    p.add_argument("--z_exit", type=float, default=0.5, help="Z-score threshold for exit")
    return p.parse_args()


def main():
    args = parse_args()

    if not os.path.exists(args.input):
        print(f"[ERROR] Input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    df = load_indices(args.input)
    print(f"[INFO] Loaded {len(df)} rows from {args.input}")

    df = compute_relative_strength(df, args.rs_window)
    df = generate_signals(df, args.z_entry, args.z_exit)
    df = compute_backtest(df)
    summary = compute_summary(df)
    write_outputs(df, summary, args.outdir)


if __name__ == "__main__":
    main()
