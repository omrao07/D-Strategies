#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
intermarket_correlations.py — Cross-asset correlation regime detection & trading
==================================================================================
Tracks rolling correlations between asset classes (stocks/bonds, gold/USD,
oil/equities). Correlation regime shifts (e.g., stock-bond correlation turning
positive = stagflation risk) trigger portfolio rebalancing signals.

Inputs (CSV)
------------
--assets   asset_prices.csv
    Columns: date, ticker, price
    tickers expected: SPY, TLT, GLD, USO, DXY, HYG, EEM, VIX

Outputs
-------
outdir/correlation_matrix.csv   rolling correlation matrix snapshots
outdir/regime_signals.csv       date, pair, rolling_corr, regime, signal
outdir/diversification_ratio.csv  portfolio diversification over time
outdir/backtest.csv             regime-adaptive portfolio P&L
outdir/summary.json
"""

import argparse, json, os
from itertools import combinations
import numpy as np
import pandas as pd
from scipy import stats


KEY_PAIRS = [
    ("SPY", "TLT", "stock_bond"),
    ("GLD", "DXY", "gold_dollar"),
    ("SPY", "USO", "equity_oil"),
    ("HYG", "SPY", "credit_equity"),
    ("EEM", "DXY", "em_dollar"),
    ("SPY", "VIX", "equity_vix")
]


def rolling_corr_zscore(s1: pd.Series, s2: pd.Series, window: int) -> pd.Series:
    """Rolling correlation z-score (how extreme current corr is vs history)."""
    rolling_corr = s1.rolling(window).corr(s2)
    corr_ma = rolling_corr.rolling(window * 2).mean()
    corr_std = rolling_corr.rolling(window * 2).std().replace(0, np.nan)
    return (rolling_corr - corr_ma) / corr_std


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    prices = pd.read_csv(cfg.assets_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]
    price_wide = prices.pivot(index="date", columns="ticker", values="price").sort_index()
    ret_wide = price_wide.pct_change().dropna()

    available_pairs = [(t1, t2, label) for t1, t2, label in KEY_PAIRS
                       if t1.lower() in ret_wide.columns or t1 in ret_wide.columns
                       and (t2.lower() in ret_wide.columns or t2 in ret_wide.columns)]

    # Also build all-ticker pairs
    all_tickers = ret_wide.columns.tolist()
    extra_pairs = [(t1, t2, f"{t1}_{t2}") for t1, t2 in combinations(all_tickers[:8], 2)
                   if not any(t1 == p[0] and t2 == p[1] for p in KEY_PAIRS)]

    pair_list = [(t1.lower() if t1.lower() in ret_wide.columns else t1,
                  t2.lower() if t2.lower() in ret_wide.columns else t2, label)
                 for t1, t2, label in KEY_PAIRS + extra_pairs[:10]]

    signal_records = []
    all_corr_records = []

    for t1, t2, label in pair_list:
        if t1 not in ret_wide.columns or t2 not in ret_wide.columns:
            continue

        r = ret_wide[t1].dropna().align(ret_wide[t2].dropna(), join="inner")
        s1, s2 = r[0], r[1]
        rolling_corr = s1.rolling(cfg.corr_window).corr(s2)
        corr_z = rolling_corr_zscore(s1, s2, cfg.corr_window)
        corr_trend = rolling_corr.diff(20)

        for date in rolling_corr.dropna().index:
            c = float(rolling_corr.loc[date])
            z = float(corr_z.loc[date]) if date in corr_z.index and not np.isnan(corr_z.loc[date]) else None

            # Regime classification per pair
            if label == "stock_bond":
                regime = "stagflation_risk" if c > 0.3 else ("normal_negative" if c < -0.3 else "transition")
                signal = "defensive_rebalance" if regime == "stagflation_risk" else \
                         ("risk_on" if regime == "normal_negative" else "neutral")
            elif label == "gold_dollar":
                regime = "risk_off" if c < -0.5 else ("unusual_positive" if c > 0.3 else "normal")
                signal = "buy_gold" if regime == "unusual_positive" else "neutral"
            elif label == "equity_vix":
                regime = "normal_inverse" if c < -0.5 else ("crisis" if c > 0 else "elevated_stress")
                signal = "hedge" if regime in ("crisis", "elevated_stress") else "neutral"
            else:
                regime = "high_corr" if abs(c) > 0.7 else ("low_corr" if abs(c) < 0.3 else "normal")
                signal = "neutral"

            signal_records.append({
                "date": date, "pair": label, "t1": t1, "t2": t2,
                "rolling_corr": c, "corr_zscore": z, "regime": regime, "signal": signal
            })

            all_corr_records.append({"date": date, "pair": label, "corr": c})

    sig_df = pd.DataFrame(signal_records).sort_values(["date", "pair"])
    sig_df.to_csv(os.path.join(cfg.outdir, "regime_signals.csv"), index=False)

    # Rolling correlation matrix snapshots (quarterly)
    corr_snaps = []
    for date in ret_wide.resample("Q").last().index:
        if date in ret_wide.index:
            window_ret = ret_wide.loc[:date].tail(cfg.corr_window)
            if len(window_ret) >= 30:
                cm = window_ret.corr().stack().reset_index()
                cm.columns = ["t1", "t2", "corr"]
                cm["date"] = date
                corr_snaps.append(cm)
    if corr_snaps:
        pd.concat(corr_snaps).to_csv(os.path.join(cfg.outdir, "correlation_matrix.csv"), index=False)

    # Diversification ratio: portfolio vol / weighted-avg asset vol
    div_records = []
    for date in ret_wide.resample("M").last().index:
        window_ret = ret_wide.loc[:date].tail(cfg.corr_window)
        if len(window_ret) < 20:
            continue
        eq_weights = np.ones(len(ret_wide.columns)) / len(ret_wide.columns)
        asset_vols = window_ret.std().values
        port_vol = np.sqrt(eq_weights @ window_ret.cov().values @ eq_weights)
        weighted_avg_vol = (eq_weights * asset_vols).sum()
        div_ratio = weighted_avg_vol / port_vol if port_vol > 0 else np.nan
        div_records.append({"date": date, "diversification_ratio": float(div_ratio),
                             "portfolio_vol_ann": float(port_vol * np.sqrt(252))})
    if div_records:
        pd.DataFrame(div_records).to_csv(os.path.join(cfg.outdir, "diversification_ratio.csv"), index=False)

    # Backtest: regime-adaptive (stock_bond correlation regime drives allocation)
    stock_bond_sig = sig_df[sig_df["pair"] == "stock_bond"][["date", "signal"]].set_index("date")["signal"]
    spy_col = "spy" if "spy" in ret_wide.columns else None
    tlt_col = "tlt" if "tlt" in ret_wide.columns else None

    if spy_col and tlt_col:
        pos_spy = stock_bond_sig.reindex(ret_wide.index, method="ffill").map(
            {"risk_on": 1, "neutral": 0.5, "defensive_rebalance": -0.5}).fillna(0).shift(1)
        pos_tlt = stock_bond_sig.reindex(ret_wide.index, method="ffill").map(
            {"risk_on": -0.5, "neutral": 0.5, "defensive_rebalance": 1}).fillna(0).shift(1)
        port = (pos_spy * ret_wide[spy_col] + pos_tlt * ret_wide[tlt_col]).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_pairs_tracked": len(pair_list), "n_signal_records": len(sig_df),
        "stagflation_risk_days": int((sig_df[sig_df["pair"] == "stock_bond"]["regime"] == "stagflation_risk").sum()) if not sig_df.empty else 0,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Intermarket corr | Pairs: {summary['n_pairs_tracked']} | Stagflation risk days: {summary['stagflation_risk_days']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets", required=True, dest="assets_file")
    ap.add_argument("--corr-window", type=int, default=60)
    ap.add_argument("--outdir", default="./artifacts/intermarket_corr")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
