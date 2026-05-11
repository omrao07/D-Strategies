#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
yield_curve_2s10s_inversion.py — 2s10s inversion depth & duration predict recession
======================================================================================
The 2-year vs 10-year Treasury spread is the most reliable recession predictor.
Sustained inversion (>3 months) has preceded every US recession since 1955.
This strategy rotates from equities to bonds/gold as inversion deepens and holds
for re-steepening recovery.

Inputs (CSV)
------------
--yields   treasury_yields.csv
    Columns: date, y2, y10, y3m, y5, y30 (all in %)
--assets   asset_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/yield_curve.csv          date, spread_2s10s, spread_3m10y, inversion_days,
                                 regime, signal
outdir/regime_returns.csv       average asset return by curve regime
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


CURVE_REGIMES = {
    "steep_bull": (50, np.inf),
    "flat_bull": (10, 50),
    "flat_neutral": (-10, 10),
    "flat_bear": (-50, -10),
    "deep_inversion": (-np.inf, -50)
}


def classify_regime(spread_bp: float) -> str:
    for regime, (lo, hi) in CURVE_REGIMES.items():
        if lo <= spread_bp < hi:
            return regime
    return "flat_neutral"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    yields = pd.read_csv(cfg.yields_file, parse_dates=["date"])
    yields.columns = [c.lower().strip() for c in yields.columns]
    yields = yields.set_index("date").sort_index()
    assets = pd.read_csv(cfg.assets_file, parse_dates=["date"])
    assets.columns = [c.lower().strip() for c in assets.columns]
    ret_wide = assets.pivot(index="date", columns="ticker", values="return").sort_index()

    yields["spread_2s10s_bp"] = (yields["y10"] - yields["y2"]) * 100
    if "y3m" in yields.columns:
        yields["spread_3m10y_bp"] = (yields["y10"] - yields["y3m"]) * 100
    else:
        yields["spread_3m10y_bp"] = np.nan

    # Count consecutive inversion days
    inverted = yields["spread_2s10s_bp"] < 0
    inversion_days = []
    count = 0
    for iv in inverted:
        count = count + 1 if iv else 0
        inversion_days.append(count)
    yields["inversion_days"] = inversion_days

    yields["regime"] = yields["spread_2s10s_bp"].apply(classify_regime)
    yields["spread_ma20"] = yields["spread_2s10s_bp"].rolling(20).mean()
    yields["spread_change_20d"] = yields["spread_2s10s_bp"].diff(20)

    # Signal: regime-based
    def make_signal(row):
        regime = row["regime"]
        chg = row.get("spread_change_20d", 0) or 0
        inv_days = row.get("inversion_days", 0)
        if regime == "deep_inversion" and inv_days > cfg.min_inversion_days:
            return "max_defensive"  # Recession imminent → bonds/gold
        elif regime in ("flat_bear", "deep_inversion"):
            return "defensive"
        elif regime == "flat_neutral" and chg > 10:
            return "re_steepening_buy"  # Curve normalizing → equities
        elif regime in ("flat_bull", "steep_bull"):
            return "risk_on"
        return "neutral"

    yields["signal"] = yields.apply(make_signal, axis=1)
    yields_out = yields[["spread_2s10s_bp", "spread_3m10y_bp", "inversion_days", "regime", "signal",
                          "spread_ma20", "spread_change_20d"]].reset_index()
    yields_out.to_csv(os.path.join(cfg.outdir, "yield_curve.csv"), index=False)

    # Regime-average returns
    regime_records = []
    for ticker in ret_wide.columns:
        merged = yields["regime"].reindex(ret_wide.index).ffill().to_frame()
        merged[ticker] = ret_wide[ticker]
        for regime, grp in merged.groupby("regime"):
            regime_records.append({
                "ticker": ticker, "regime": regime,
                "avg_daily_ret": float(grp[ticker].mean()),
                "ann_ret": float(grp[ticker].mean() * 252),
                "sharpe": float(grp[ticker].mean() / grp[ticker].std() * np.sqrt(252)) if grp[ticker].std() > 0 else None,
                "n_days": len(grp)
            })

    regime_df = pd.DataFrame(regime_records)
    if not regime_df.empty:
        regime_df.to_csv(os.path.join(cfg.outdir, "regime_returns.csv"), index=False)

    # Backtest: regime-based allocation
    all_daily = []
    for ticker in ret_wide.columns:
        sig = yields["signal"].reindex(ret_wide.index).ffill()
        pos = sig.map({"max_defensive": -1, "defensive": -0.5, "neutral": 0,
                       "re_steepening_buy": 0.5, "risk_on": 1}).fillna(0)
        strat = pos.shift(1) * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    max_inv = int(yields["inversion_days"].max())
    current_spread = float(yields["spread_2s10s_bp"].iloc[-1])
    summary = {
        "current_spread_2s10s_bp": current_spread,
        "current_regime": str(yields["regime"].iloc[-1]),
        "max_consecutive_inversion_days": max_inv,
        "pct_time_inverted": float((yields["spread_2s10s_bp"] < 0).mean()),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"min_inversion_days": cfg.min_inversion_days}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"2s10s curve | Current: {current_spread:.1f}bp | Regime: {summary['current_regime']} | Max inversion: {max_inv}d | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yields", required=True, dest="yields_file")
    ap.add_argument("--assets", required=True, dest="assets_file")
    ap.add_argument("--min-inversion-days", type=int, default=60)
    ap.add_argument("--outdir", default="./artifacts/yield_curve")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
