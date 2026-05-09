#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
central_bank_balance_sheets.py — CB balance sheet expansion/contraction vs asset prices
=========================================================================================
Central bank balance sheet growth (QE) correlates strongly with equity P/E multiple
expansion and gold prices. QT (balance sheet contraction) → multiple compression.
Strategy: long risk assets when global CB balance sheets accelerating; defensive when decelerating.

Inputs (CSV)
------------
--balance   cb_balance_sheets.csv
    Columns: date, central_bank, balance_sheet_usd_bn
--assets    asset_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/cb_signals.csv           date, global_bs_bn, yoy_growth_pct, regime, signal
outdir/bs_vs_returns.csv        balance sheet growth vs asset return correlation
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


CB_WEIGHTS = {
    "FED": 0.40, "ECB": 0.30, "BOJ": 0.20, "PBOC": 0.10,
    "fed": 0.40, "ecb": 0.30, "boj": 0.20, "pboc": 0.10
}


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    bs = pd.read_csv(cfg.balance_file, parse_dates=["date"])
    bs.columns = [c.lower().strip() for c in bs.columns]
    assets = pd.read_csv(cfg.assets_file, parse_dates=["date"])
    assets.columns = [c.lower().strip() for c in assets.columns]
    ret_wide = assets.pivot(index="date", columns="ticker", values="return").sort_index()

    # Aggregate to global balance sheet (weighted)
    bs["weight"] = bs["central_bank"].map(CB_WEIGHTS).fillna(0.05)
    global_bs = bs.groupby("date").apply(
        lambda g: (g["balance_sheet_usd_bn"] * g["weight"]).sum() / g["weight"].sum()
    ).rename("global_bs_bn").reset_index()
    global_bs = global_bs.set_index("date").sort_index()

    global_bs["yoy_growth_pct"] = global_bs["global_bs_bn"].pct_change(12) * 100
    global_bs["mom_growth_pct"] = global_bs["global_bs_bn"].pct_change(1) * 100
    global_bs["acceleration"] = global_bs["mom_growth_pct"] - global_bs["mom_growth_pct"].shift(3)
    global_bs["bs_zscore"] = (global_bs["yoy_growth_pct"] - global_bs["yoy_growth_pct"].rolling(36, min_periods=12).mean()) / \
                               global_bs["yoy_growth_pct"].rolling(36, min_periods=12).std().replace(0, np.nan)

    def classify_regime(row):
        yoy = row.get("yoy_growth_pct", np.nan) or 0
        accel = row.get("acceleration", np.nan) or 0
        if yoy > 10 and accel > 0:
            return "aggressive_qe"
        elif yoy > 5:
            return "moderate_qe"
        elif yoy > 0:
            return "tapering"
        elif yoy < -5:
            return "qt_aggressive"
        elif yoy < 0:
            return "qt_mild"
        return "stable"

    global_bs["regime"] = global_bs.apply(classify_regime, axis=1)
    REGIME_POS = {"aggressive_qe": 1, "moderate_qe": 0.5, "tapering": 0, "stable": 0, "qt_mild": -0.5, "qt_aggressive": -1}
    global_bs["signal"] = global_bs["regime"].map(
        lambda r: "risk_on" if REGIME_POS.get(r, 0) > 0 else ("risk_off" if REGIME_POS.get(r, 0) < 0 else "neutral")
    )

    global_bs.reset_index().to_csv(os.path.join(cfg.outdir, "cb_signals.csv"), index=False)

    # Correlation: BS growth vs asset returns
    corr_records = []
    for ticker in ret_wide.columns:
        fwd_21 = ret_wide[ticker].rolling(21).sum().shift(-21)
        bs_z = global_bs["bs_zscore"].reindex(ret_wide.index, method="ffill").dropna()
        aligned = bs_z.align(fwd_21.dropna(), join="inner")
        if len(aligned[0]) > 20:
            r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
            corr_records.append({"ticker": ticker, "bs_growth_fwd21d_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

    corr_df = pd.DataFrame(corr_records).sort_values("bs_growth_fwd21d_corr", ascending=False) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "bs_vs_returns.csv"), index=False)

    # Backtest
    all_daily = []
    for ticker in ret_wide.columns:
        pos_val = global_bs["regime"].map(REGIME_POS).fillna(0)
        pos_daily = pos_val.reindex(ret_wide.index, method="ffill").shift(1).fillna(0)
        strat = pos_daily * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    current_regime = str(global_bs["regime"].iloc[-1]) if not global_bs.empty else None
    summary = {
        "n_obs": len(global_bs), "current_regime": current_regime,
        "current_global_bs_bn": float(global_bs["global_bs_bn"].iloc[-1]) if not global_bs.empty else None,
        "avg_corr_fwd21d": float(corr_df["bs_growth_fwd21d_corr"].mean()) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"CB balance sheets | Regime: {current_regime} | Global BS: ${summary['current_global_bs_bn']:.1f}B | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--balance", required=True, dest="balance_file")
    ap.add_argument("--assets", required=True, dest="assets_file")
    ap.add_argument("--outdir", default="./artifacts/cb_balance_sheets")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
