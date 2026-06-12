#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Correlation Dispersion Strategy (Strategy #225)
================================================
Exploits the difference between index implied volatility and the weighted
average implied volatility of individual constituents. When implied correlation
is high, sell index vol and buy single-stock vol (dispersion trade). When
correlation is low, do the reverse.

Implied correlation formula:
    rho_implied = (sigma_index)^2 / sum_i sum_j w_i * w_j * sigma_i * sigma_j

Inputs
------
vol_data.csv
    Columns: date, index_iv, stock1_iv, stock2_iv, ... (any number of stock columns)
    - date:      YYYY-MM-DD
    - index_iv:  30-day ATM implied vol of the index (decimal)
    - stockN_iv: 30-day ATM implied vol of constituent N (decimal)
    Optional: weights.csv (stock, weight) — equal weights used if absent

CLI
---
python correlation_dispersion.py --input vol_data.csv --outdir ./out
    [--weights weights.csv] [--corr-pct 70] [--lookback 252]

Outputs (written to outdir)
---------------------------
implied_correlation.csv  — date, index_iv, avg_stock_iv, implied_corr, signal
dispersion_pnl.csv       — date, position, index_pnl, stock_pnl, net_pnl, cum_pnl
summary.json             — Sharpe, max drawdown, avg implied corr at entry
"""

import argparse
import json
import os
import sys
from typing import Dict, Optional

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_vol_data(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    if "date" not in df.columns or "index_iv" not in df.columns:
        sys.exit("ERROR: vol_data.csv must have 'date' and 'index_iv' columns")
    df = df.sort_values("date").reset_index(drop=True)
    num_cols = [c for c in df.columns if c != "date"]
    df[num_cols] = df[num_cols].apply(pd.to_numeric, errors="coerce")
    return df


def load_weights(path: Optional[str], stock_cols: list) -> Dict[str, float]:
    """Load weights from file or default to equal weights."""
    if path and os.path.exists(path):
        w_df = pd.read_csv(path)
        w_df.columns = [c.lower() for c in w_df.columns]
        if "stock" in w_df.columns and "weight" in w_df.columns:
            w = dict(zip(w_df["stock"], w_df["weight"]))
            total = sum(w.get(s, 0) for s in stock_cols)
            if total > 0:
                return {s: w.get(s, 0) / total for s in stock_cols}
    n = len(stock_cols)
    return {s: 1.0 / n for s in stock_cols} if n > 0 else {}


# ---------------------------------------------------------------------------
# Implied correlation
# ---------------------------------------------------------------------------

def compute_implied_correlation(df: pd.DataFrame,
                                weights: Dict[str, float]) -> pd.DataFrame:
    """
    Compute implied correlation using the portfolio variance identity.
    For a portfolio: sigma_p^2 = sum_i sum_j w_i w_j rho_ij sigma_i sigma_j
    Assuming a single implied correlation rho for all pairs:
        rho_implied = (sigma_index^2 - sum_i w_i^2 * sigma_i^2)
                      / (sum_i sum_j (i!=j) w_i w_j sigma_i sigma_j)

    This is the Derman (2004) formula for implied correlation.
    """
    stock_cols = [c for c in df.columns if c.startswith("stock") and c.endswith("_iv")]
    if not stock_cols:
        sys.exit("ERROR: No stock IV columns found (expected columns like 'stock1_iv')")

    # Recompute equal weights if not provided for all stocks
    active_weights = {s: weights.get(s, 1.0 / len(stock_cols)) for s in stock_cols}
    total_w = sum(active_weights.values())
    active_weights = {s: v / total_w for s, v in active_weights.items()}

    records = []
    for _, row in df.iterrows():
        sig_idx = row["index_iv"]
        if pd.isna(sig_idx):
            continue

        sig = {s: row[s] for s in stock_cols if not pd.isna(row[s])}
        w = {s: active_weights[s] for s in sig}
        if len(sig) < 2:
            continue

        # Normalise weights for available stocks
        tw = sum(w.values())
        w = {s: v / tw for s, v in w.items()}

        # Numerator: sigma_p^2 - sum_i w_i^2 * sigma_i^2
        var_index = sig_idx ** 2
        diag_term = sum(w[s] ** 2 * sig[s] ** 2 for s in sig)
        # Denominator: sum_i sum_j (i!=j) w_i w_j sigma_i sigma_j
        stocks = list(sig.keys())
        cross_term = 0.0
        for i, si in enumerate(stocks):
            for j, sj in enumerate(stocks):
                if i != j:
                    cross_term += w[si] * w[sj] * sig[si] * sig[sj]

        rho = (var_index - diag_term) / cross_term if cross_term > 0 else np.nan
        rho = max(min(rho, 1.0), -1.0)  # clip to valid range

        avg_stock_iv = sum(w[s] * sig[s] for s in sig)
        weighted_stock_var = sum(w[s] * sig[s] ** 2 for s in sig)

        records.append({
            "date": row["date"],
            "index_iv": sig_idx,
            "avg_stock_iv": avg_stock_iv,
            "weighted_stock_var": np.sqrt(weighted_stock_var),
            "implied_corr": rho,
            "n_stocks": len(sig),
        })

    return pd.DataFrame(records)


# ---------------------------------------------------------------------------
# Signals
# ---------------------------------------------------------------------------

def generate_signals(corr_df: pd.DataFrame, lookback: int = 252,
                     corr_pct: float = 70.0) -> pd.DataFrame:
    """
    Signal:
      +1 (sell index vol, buy stock vol) when implied_corr > corr_pct-th pct
         → high corr = index vol overpriced relative to single stocks
      -1 (buy index vol, sell stock vol) when implied_corr < (100-corr_pct)-th pct
       0 neutral
    """
    out = corr_df.copy()
    roll = out["implied_corr"].rolling(window=lookback, min_periods=max(1, lookback // 4))
    out["corr_pct_rank"] = roll.rank(pct=True) * 100
    out["corr_high_thresh"] = roll.quantile(corr_pct / 100.0)
    out["corr_low_thresh"] = roll.quantile((100 - corr_pct) / 100.0)

    out["signal"] = np.select(
        [out["corr_pct_rank"] >= corr_pct, out["corr_pct_rank"] <= (100 - corr_pct)],
        [1, -1],
        default=0,
    )
    out["position"] = out["signal"].shift(1).fillna(0)
    return out


# ---------------------------------------------------------------------------
# P&L simulation
# ---------------------------------------------------------------------------

def simulate_pnl(sig_df: pd.DataFrame) -> pd.DataFrame:
    """
    Dispersion trade P&L:
    - Index vol P&L: when position=+1 (short index vol), profit = -(delta_index_iv)
    - Stock vol P&L: when position=+1 (long stock vol), profit = +(delta_avg_stock_iv)
    - Net P&L = -delta_index_iv + delta_avg_stock_iv  (per unit notional)

    For position=-1: reverse.
    """
    out = sig_df.copy()
    out["delta_index_iv"] = out["index_iv"].diff()
    out["delta_stock_iv"] = out["avg_stock_iv"].diff()

    # Short index vol, long stock vol
    out["index_pnl"] = out["position"] * (-out["delta_index_iv"])
    out["stock_pnl"] = out["position"] * out["delta_stock_iv"]
    out["net_pnl"] = out["index_pnl"] + out["stock_pnl"]

    # Correlation trade also benefits from realized correlation being lower than implied
    out["corr_realised_proxy"] = out["implied_corr"].shift(21)  # use lagged corr as proxy
    out["corr_pnl"] = np.where(
        out["position"] == 1,
        (out["implied_corr"].shift(1) - out["implied_corr"]) * 0.1,
        np.where(out["position"] == -1,
                 (out["implied_corr"] - out["implied_corr"].shift(1)) * 0.1, 0.0),
    )

    out["total_pnl"] = out["net_pnl"] + out["corr_pnl"]
    out["cum_pnl"] = out["total_pnl"].cumsum()
    roll_max = out["cum_pnl"].cummax()
    out["drawdown"] = out["cum_pnl"] - roll_max
    return out


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

def compute_summary(df: pd.DataFrame) -> dict:
    daily = df["total_pnl"].dropna()
    n = len(daily)
    if n == 0:
        return {}
    std = daily.std()
    sharpe = daily.mean() / std * np.sqrt(252) if std > 0 else 0.0
    max_dd = float(df["drawdown"].min())
    win_rate = float((daily > 0).mean()) * 100

    disp_entries = df[df["position"] == 1]
    avg_corr_entry = float(disp_entries["implied_corr"].mean()) if not disp_entries.empty else None

    return {
        "total_pnl_vol_pts": round(float(daily.sum()), 6),
        "sharpe_ratio": round(sharpe, 3),
        "max_drawdown": round(max_dd, 6),
        "win_rate_pct": round(win_rate, 2),
        "n_trading_days": n,
        "avg_implied_corr_at_entry": round(avg_corr_entry, 4) if avg_corr_entry else None,
        "avg_implied_corr_overall": round(float(df["implied_corr"].mean()), 4),
        "pct_time_in_dispersion": round(float((df["position"] == 1).mean()) * 100, 2),
    }


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(sig_df: pd.DataFrame, pnl_df: pd.DataFrame,
                  summary: dict, outdir: str) -> None:
    os.makedirs(outdir, exist_ok=True)

    corr_cols = ["date", "index_iv", "avg_stock_iv", "implied_corr",
                 "corr_pct_rank", "corr_high_thresh", "signal", "position"]
    corr_cols = [c for c in corr_cols if c in sig_df.columns]
    sig_df[corr_cols].to_csv(
        os.path.join(outdir, "implied_correlation.csv"), index=False, float_format="%.6f"
    )

    pnl_cols = ["date", "position", "index_pnl", "stock_pnl",
                "net_pnl", "corr_pnl", "total_pnl", "cum_pnl", "drawdown"]
    pnl_cols = [c for c in pnl_cols if c in pnl_df.columns]
    pnl_df[pnl_cols].to_csv(
        os.path.join(outdir, "dispersion_pnl.csv"), index=False, float_format="%.6f"
    )

    with open(os.path.join(outdir, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=2)

    print(f"Outputs written to: {outdir}")
    print(json.dumps(summary, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Correlation Dispersion Strategy")
    p.add_argument("--input", required=True, help="Path to vol_data.csv")
    p.add_argument("--outdir", default="./dispersion_out",
                   help="Output directory (default: ./dispersion_out)")
    p.add_argument("--weights", default=None, help="Optional weights.csv (stock, weight)")
    p.add_argument("--corr-pct", type=float, default=70.0,
                   help="Implied correlation percentile for signal (default: 70)")
    p.add_argument("--lookback", type=int, default=252,
                   help="Rolling lookback window (default: 252)")
    return p.parse_args()


def main():
    args = parse_args()

    print(f"Loading vol data from: {args.input}")
    df = load_vol_data(args.input)
    stock_cols = [c for c in df.columns if c.startswith("stock") and c.endswith("_iv")]
    print(f"Found {len(stock_cols)} single-stock IV series")

    weights = load_weights(args.weights, stock_cols)

    print("Computing implied correlation...")
    corr_df = compute_implied_correlation(df, weights)
    print(f"Computed {len(corr_df)} daily correlation observations")

    print("Generating signals...")
    sig_df = generate_signals(corr_df, lookback=args.lookback, corr_pct=args.corr_pct)

    print("Simulating P&L...")
    pnl_df = simulate_pnl(sig_df)

    summary = compute_summary(pnl_df)

    print("Writing outputs...")
    write_outputs(sig_df, pnl_df, summary, args.outdir)


if __name__ == "__main__":
    main()
