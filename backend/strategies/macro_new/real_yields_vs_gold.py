#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
real_yields_vs_gold.py — Real yields (TIPS) vs gold price divergence trading
==============================================================================
Gold has a strong inverse relationship with US real yields (10Y TIPS).
When real yields fall → gold outperforms. When real yields rise → gold underperforms.
Divergence from this relationship creates mean-reversion opportunities.

Inputs (CSV)
------------
--real_yields  tips_yields.csv
    Columns: date, tips_10y_pct, tips_5y_pct, breakeven_10y_pct, nominal_10y_pct
--gold         gold_prices.csv
    Columns: date, gold_usd, silver_usd (optional)
--assets       asset_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/real_yield_signals.csv   date, tips_10y, gold_fair_value, divergence_pct, signal
outdir/regime_analysis.csv      gold return by real yield regime
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def estimate_gold_fair_value(tips_series: pd.Series, gold_series: pd.Series,
                              window: int = 252) -> pd.Series:
    """Rolling OLS: gold = a + b * tips → implied fair value."""
    fair_values = pd.Series(np.nan, index=gold_series.index)
    for i in range(window, len(gold_series)):
        y = gold_series.iloc[i - window:i].values
        x = tips_series.iloc[i - window:i].values
        mask = ~(np.isnan(x) | np.isnan(y))
        if mask.sum() < 30:
            continue
        X = np.column_stack([x[mask], np.ones(mask.sum())])
        b = np.linalg.lstsq(X, y[mask], rcond=None)[0]
        tips_now = tips_series.iloc[i]
        if not np.isnan(tips_now):
            fair_values.iloc[i] = b[0] * tips_now + b[1]
    return fair_values


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    ry = pd.read_csv(cfg.real_yields_file, parse_dates=["date"])
    ry.columns = [c.lower().strip() for c in ry.columns]
    ry = ry.set_index("date").sort_index()
    gold = pd.read_csv(cfg.gold_file, parse_dates=["date"])
    gold.columns = [c.lower().strip() for c in gold.columns]
    gold = gold.set_index("date").sort_index()
    assets = pd.read_csv(cfg.assets_file, parse_dates=["date"])
    assets.columns = [c.lower().strip() for c in assets.columns]
    ret_wide = assets.pivot(index="date", columns="ticker", values="return").sort_index()

    tips_col = "tips_10y_pct" if "tips_10y_pct" in ry.columns else ry.columns[0]
    gold_col = "gold_usd" if "gold_usd" in gold.columns else gold.columns[0]

    aligned = ry[[tips_col]].join(gold[[gold_col]], how="inner").dropna()
    aligned["gold_fair_value"] = estimate_gold_fair_value(aligned[tips_col], aligned[gold_col], window=cfg.window)
    aligned["gold_divergence_pct"] = (aligned[gold_col] - aligned["gold_fair_value"]) / aligned["gold_fair_value"].replace(0, np.nan) * 100
    aligned["gold_zscore"] = (aligned["gold_divergence_pct"] - aligned["gold_divergence_pct"].rolling(60).mean()) / \
                               aligned["gold_divergence_pct"].rolling(60).std().replace(0, np.nan)

    # Real yield regime
    aligned["tips_regime"] = pd.cut(aligned[tips_col], bins=[-np.inf, -1, 0, 1, 2, np.inf],
                                    labels=["deeply_neg", "negative", "low_pos", "moderate", "high"])

    # Signal: gold undervalued vs real yields → buy gold
    aligned["signal"] = aligned["gold_zscore"].apply(
        lambda z: "buy_gold" if z < -cfg.zscore_threshold else
                  ("sell_gold" if z > cfg.zscore_threshold else "neutral")
    )

    out_cols = [tips_col, gold_col, "gold_fair_value", "gold_divergence_pct", "gold_zscore", "tips_regime", "signal"]
    aligned[out_cols].reset_index().to_csv(os.path.join(cfg.outdir, "real_yield_signals.csv"), index=False)

    # Regime analysis: gold return by real yield regime
    gold_ret = aligned[gold_col].pct_change().dropna()
    regime_records = []
    for regime in aligned["tips_regime"].dropna().unique():
        mask = aligned["tips_regime"] == regime
        ret_in_regime = gold_ret.reindex(aligned[mask].index).dropna()
        if len(ret_in_regime) > 0:
            regime_records.append({
                "regime": str(regime), "n_days": len(ret_in_regime),
                "avg_daily_ret": float(ret_in_regime.mean()),
                "ann_ret": float(ret_in_regime.mean() * 252),
                "avg_tips_pct": float(aligned.loc[aligned["tips_regime"] == regime, tips_col].mean())
            })
    pd.DataFrame(regime_records).to_csv(os.path.join(cfg.outdir, "regime_analysis.csv"), index=False)

    # Backtest: use signal to trade gold and assets
    all_daily = []
    gold_ret_series = aligned[gold_col].pct_change().dropna()
    pos = aligned["signal"].map({"buy_gold": 1, "sell_gold": -1, "neutral": 0}).fillna(0)
    strat_gold = pos.shift(1) * gold_ret_series.reindex(pos.index)
    all_daily.append(strat_gold.rename("gold"))

    for ticker in ret_wide.columns:
        pos_asset = aligned["signal"].map({"buy_gold": -0.5, "sell_gold": 0.5, "neutral": 0}).fillna(0)
        pos_daily = pos_asset.reindex(ret_wide.index, method="ffill").shift(1)
        strat = pos_daily * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
    cum = (1 + port).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
    sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None

    summary = {
        "current_tips_10y": float(aligned[tips_col].iloc[-1]),
        "current_gold_usd": float(aligned[gold_col].iloc[-1]),
        "current_gold_divergence_pct": float(aligned["gold_divergence_pct"].iloc[-1]) if not np.isnan(aligned["gold_divergence_pct"].iloc[-1]) else None,
        "current_signal": str(aligned["signal"].iloc[-1]),
        "corr_tips_gold": float(stats.pearsonr(aligned[tips_col].dropna().values, aligned[gold_col].reindex(aligned[tips_col].dropna().index).dropna().values)[0]),
        "ann_return": float(port.mean() * 252), "sharpe": sharpe,
        "params": {"window": cfg.window, "zscore_threshold": cfg.zscore_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Real yields vs gold | TIPS: {summary['current_tips_10y']:.2f}% | Gold: ${summary['current_gold_usd']:.0f} | Signal: {summary['current_signal']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--real-yields", required=True, dest="real_yields_file")
    ap.add_argument("--gold", required=True, dest="gold_file")
    ap.add_argument("--assets", required=True, dest="assets_file")
    ap.add_argument("--window", type=int, default=252)
    ap.add_argument("--zscore-threshold", type=float, default=1.5)
    ap.add_argument("--outdir", default="./artifacts/real_yields_gold")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
