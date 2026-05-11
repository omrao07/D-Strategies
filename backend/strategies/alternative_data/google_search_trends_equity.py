#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
google_search_trends_equity.py — Search interest predicts product demand & stock moves
========================================================================================
Google Trends data provides weekly search volume indices (SVI) for product/company terms.
Rising consumer search interest leads sales acceleration by 4-8 weeks. SVI spikes
(>2σ) predict positive earnings surprises for consumer-facing companies.

Inputs (CSV)
------------
--trends    search_trends.csv
    Columns: date, ticker, keyword, svi (0-100 normalized)
--returns   stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/svi_signals.csv         date, ticker, svi, svi_zscore, signal, seasonal_adj_svi
outdir/svi_vs_returns.csv      lead-lag correlation by ticker
outdir/backtest.csv            cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def seasonal_adjust(series: pd.Series, period: int = 52) -> pd.Series:
    """Remove seasonal pattern by subtracting same-week-of-year mean."""
    df = series.to_frame("svi")
    df["week"] = df.index.isocalendar().week.astype(int)
    week_means = df.groupby("week")["svi"].mean()
    df["seasonal"] = df["week"].map(week_means)
    return (df["svi"] - df["seasonal"]).rename("adj_svi")


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    trends = pd.read_csv(cfg.trends_file, parse_dates=["date"])
    trends.columns = [c.lower().strip() for c in trends.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    # Average across keywords per ticker per date
    svi_agg = trends.groupby(["date", "ticker"])["svi"].mean().reset_index()
    svi_wide = svi_agg.pivot(index="date", columns="ticker", values="svi").sort_index()

    signal_records = []
    corr_records = []
    all_daily = []

    for ticker in svi_wide.columns:
        series = svi_wide[ticker].dropna()
        if len(series) < 26 or ticker not in ret_wide.columns:
            continue

        adj_svi = seasonal_adjust(series)
        zscore = (adj_svi - adj_svi.rolling(52, min_periods=12).mean()) / \
                 adj_svi.rolling(52, min_periods=12).std().replace(0, np.nan)
        momentum = adj_svi.pct_change(4)  # 4-week growth

        for date in zscore.dropna().index:
            z = zscore.loc[date]
            sig = "buy" if z > cfg.zscore_threshold else ("sell" if z < -cfg.zscore_threshold else "neutral")
            signal_records.append({
                "date": date, "ticker": ticker,
                "svi": float(series.loc[date]) if date in series.index else None,
                "adj_svi": float(adj_svi.loc[date]) if date in adj_svi.index else None,
                "svi_zscore": float(z),
                "momentum_4w": float(momentum.loc[date]) if date in momentum.index and not np.isnan(momentum.loc[date]) else None,
                "signal": sig
            })

        # Lead-lag: SVI leads stock return by 4-8 weeks
        fwd8 = ret_wide[ticker].rolling(40).sum()
        svi_daily = adj_svi.reindex(ret_wide.index).ffill()
        aligned = svi_daily.dropna().align(fwd8.dropna(), join="inner")
        if len(aligned[0]) > 20:
            r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
            corr_records.append({"ticker": ticker, "svi_fwd8wk_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

        # Backtest: long on SVI spike, short on crash
        pos_weekly = zscore.apply(lambda z: 1 if z > cfg.zscore_threshold else (-1 if z < -cfg.zscore_threshold else 0))
        pos_daily = pos_weekly.reindex(ret_wide.index).ffill().shift(5)
        strat = pos_daily * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "svi_signals.csv"), index=False)

    corr_df = pd.DataFrame(corr_records).sort_values("svi_fwd8wk_corr", ascending=False) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "svi_vs_returns.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_tickers": svi_wide.shape[1], "n_signals": len(sig_df),
        "n_buy_signals": int((sig_df["signal"] == "buy").sum()) if not sig_df.empty else 0,
        "avg_corr_fwd8wk": float(corr_df["svi_fwd8wk_corr"].mean()) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"zscore_threshold": cfg.zscore_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Google Trends | Tickers: {svi_wide.shape[1]} | Buy signals: {summary['n_buy_signals']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trends", required=True, dest="trends_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--zscore-threshold", type=float, default=2.0)
    ap.add_argument("--outdir", default="./artifacts/google_trends")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
