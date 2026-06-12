#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tips_breakeven_inflation.py — TIPS breakeven vs realized CPI → inflation mispricing
======================================================================================
10-year breakeven inflation = nominal Treasury yield - TIPS yield. When breakeven
is significantly above or below realized CPI trajectory, mispricing exists.
Low breakeven + rising CPI → buy TIPS (undervalued inflation protection).
High breakeven + falling CPI → sell TIPS / buy nominal Treasuries.

Inputs (CSV)
------------
--tips     tips_breakeven.csv
    Columns: date, nominal_10y_pct, tips_10y_pct, breakeven_10y_pct,
             breakeven_5y_pct, tips_5y_pct
--cpi      cpi_data.csv
    Columns: date, cpi_yoy_pct, core_cpi_yoy_pct

Outputs
-------
outdir/breakeven_signals.csv    date, breakeven, realized_cpi, gap_bp, signal
outdir/tips_vs_nominal.csv      cumulative TIPS vs nominal bond P&L
outdir/backtest.csv             strategy P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    tips = pd.read_csv(cfg.tips_file, parse_dates=["date"])
    tips.columns = [c.lower().strip() for c in tips.columns]
    tips = tips.set_index("date").sort_index()
    cpi = pd.read_csv(cfg.cpi_file, parse_dates=["date"])
    cpi.columns = [c.lower().strip() for c in cpi.columns]
    cpi = cpi.set_index("date").sort_index()

    merged = tips.join(cpi[["cpi_yoy_pct", "core_cpi_yoy_pct"]], how="left").ffill()

    be_col = "breakeven_10y_pct" if "breakeven_10y_pct" in merged.columns else merged.columns[0]
    merged["breakeven_5y5y"] = merged.get("breakeven_5y_pct", pd.Series(np.nan, index=merged.index))

    # Gap: breakeven - realized CPI (positive = breakevens pricing in more inflation than realized)
    merged["gap_pct"] = merged[be_col] - merged["cpi_yoy_pct"]
    merged["gap_zscore"] = (merged["gap_pct"] - merged["gap_pct"].rolling(252).mean()) / \
                            merged["gap_pct"].rolling(252).std().replace(0, np.nan)

    merged["be_trend"] = merged[be_col].diff(20)  # Rising → inflation expectations increasing
    merged["cpi_trend"] = merged["cpi_yoy_pct"].diff(3)

    def make_signal(row):
        z = row.get("gap_zscore", np.nan)
        be_trend = row.get("be_trend", 0) or 0
        cpi_trend = row.get("cpi_trend", 0) or 0
        if np.isnan(z):
            return "neutral"
        if z < -1.5 and cpi_trend > 0:
            return "buy_tips_sell_nominal"  # Breakevens too low vs rising CPI
        elif z > 1.5 and cpi_trend < 0:
            return "sell_tips_buy_nominal"  # Breakevens too high vs falling CPI
        elif z < -1.0 and be_trend > 0:
            return "buy_tips"  # Breakevens rising from undervalued → momentum
        elif z > 1.0 and be_trend < 0:
            return "sell_tips"
        return "neutral"

    merged["signal"] = merged.apply(make_signal, axis=1)

    records = []
    for date, row in merged.iterrows():
        records.append({
            "date": date,
            "nominal_10y_pct": float(row.get("nominal_10y_pct", np.nan)),
            "tips_10y_pct": float(row.get("tips_10y_pct", np.nan)),
            "breakeven_10y_pct": float(row.get(be_col, np.nan)),
            "realized_cpi_yoy": float(row.get("cpi_yoy_pct", np.nan)) if not np.isnan(row.get("cpi_yoy_pct", np.nan)) else None,
            "gap_pct": float(row.get("gap_pct", np.nan)) if not np.isnan(row.get("gap_pct", np.nan)) else None,
            "gap_zscore": float(row.get("gap_zscore", np.nan)) if not np.isnan(row.get("gap_zscore", np.nan)) else None,
            "signal": row["signal"]
        })

    sig_df = pd.DataFrame(records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "breakeven_signals.csv"), index=False)

    # Simplified duration-adjusted backtest
    # TIPS return ≈ -modified_duration * Δyield + realized_inflation_accrual
    # Proxy: use 10Y real yield change as TIPS return driver
    merged["tips_proxy_ret"] = -7.0 * merged["tips_10y_pct"].diff() / 100  # modified duration ~7yr
    merged["nominal_proxy_ret"] = -8.0 * merged["nominal_10y_pct"].diff() / 100  # nominal 10Y duration ~8yr

    SIGNAL_MAP = {"buy_tips_sell_nominal": (1, -1), "sell_tips_buy_nominal": (-1, 1),
                  "buy_tips": (1, 0), "sell_tips": (-1, 0), "neutral": (0, 0)}
    strategy_ret = merged.apply(
        lambda r: SIGNAL_MAP.get(r["signal"], (0, 0))[0] * (r.get("tips_proxy_ret", 0) or 0) +
                  SIGNAL_MAP.get(r["signal"], (0, 0))[1] * (r.get("nominal_proxy_ret", 0) or 0), axis=1
    ).shift(1)

    cum = (1 + strategy_ret.dropna()).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    tips_cum = (1 + merged["tips_proxy_ret"].shift(1).dropna()).cumprod()
    nom_cum = (1 + merged["nominal_proxy_ret"].shift(1).dropna()).cumprod()
    pd.DataFrame({"tips_cumulative": tips_cum, "nominal_cumulative": nom_cum}).to_csv(
        os.path.join(cfg.outdir, "tips_vs_nominal.csv"))

    sharpe = float(strategy_ret.dropna().mean() / strategy_ret.dropna().std() * np.sqrt(252)) if strategy_ret.dropna().std() > 0 else None
    summary = {
        "current_breakeven_pct": float(merged[be_col].iloc[-1]),
        "current_realized_cpi_pct": float(merged["cpi_yoy_pct"].iloc[-1]) if not np.isnan(merged["cpi_yoy_pct"].iloc[-1]) else None,
        "current_gap_pct": float(merged["gap_pct"].iloc[-1]) if not np.isnan(merged["gap_pct"].iloc[-1]) else None,
        "current_signal": str(merged["signal"].iloc[-1]),
        "n_buy_tips_signals": int((sig_df["signal"] == "buy_tips_sell_nominal").sum()) if not sig_df.empty else 0,
        "avg_breakeven_pct": float(merged[be_col].mean()),
        "ann_return": float(strategy_ret.dropna().mean() * 252), "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"TIPS breakeven | BE: {summary['current_breakeven_pct']:.2f}% | CPI: {format(summary['current_realized_cpi_pct'], '.2f') if summary['current_realized_cpi_pct'] else 'N/A'}% | Signal: {summary['current_signal']} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tips", required=True, dest="tips_file")
    ap.add_argument("--cpi", required=True, dest="cpi_file")
    ap.add_argument("--outdir", default="./artifacts/tips_breakeven")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
