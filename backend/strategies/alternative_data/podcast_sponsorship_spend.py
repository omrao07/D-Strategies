#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
podcast_sponsorship_spend.py — Ad spend on podcasts signals product confidence
================================================================================
Companies ramping podcast ad spend are investing in brand/growth ahead of revenue
acceleration. Sudden pullback signals budget tightening (revenue miss risk).
Spend share (% of total ad budget) reveals management conviction.

Inputs (CSV)
------------
--spend    podcast_spend.csv
    Columns: date, ticker, podcast_name, ad_spend, category, impressions
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/spend_signals.csv        date, ticker, total_spend, spend_growth_qoq, signal
outdir/spend_vs_returns.csv     spend acceleration vs forward return correlation
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd
from scipy import stats


def compute_spend_features(series: pd.Series) -> pd.DataFrame:
    """Quarterly spend features: growth, acceleration, z-score."""
    df = pd.DataFrame({"spend": series})
    df["qoq_growth"] = series.pct_change(63)      # ~1 quarter
    df["yoy_growth"] = series.pct_change(252)
    df["acceleration"] = df["qoq_growth"] - df["qoq_growth"].shift(63)
    rolling_mean = series.rolling(252, min_periods=40).mean()
    rolling_std = series.rolling(252, min_periods=40).std().replace(0, np.nan)
    df["spend_zscore"] = (series - rolling_mean) / rolling_std
    df["cpm"] = series / df["spend"].shift(1)  # efficiency proxy
    return df


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    spend = pd.read_csv(cfg.spend_file, parse_dates=["date"])
    spend.columns = [c.lower().strip() for c in spend.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    # Aggregate to total spend per ticker per date
    agg = spend.groupby(["date", "ticker"]).agg(
        total_spend=("ad_spend", "sum"),
        total_impressions=("impressions", "sum") if "impressions" in spend.columns else ("ad_spend", "count"),
        n_podcasts=("ad_spend", "count")
    ).reset_index()

    signal_records = []
    corr_records = []
    all_daily = []

    for ticker in agg["ticker"].unique():
        sub = agg[agg["ticker"] == ticker].set_index("date").sort_index()
        if len(sub) < 20 or ticker not in ret_wide.columns:
            continue

        feats = compute_spend_features(sub["total_spend"])
        sub = sub.join(feats.drop(columns=["spend"]))

        for date, row in sub.iterrows():
            z = row.get("spend_zscore", np.nan)
            accel = row.get("acceleration", np.nan) or 0
            signal = "buy" if (not np.isnan(z) and z > cfg.zscore_threshold and accel > 0) else \
                     ("sell" if (not np.isnan(z) and z < -cfg.zscore_threshold and accel < 0) else "neutral")
            signal_records.append({
                "date": date, "ticker": ticker,
                "total_spend": float(row["total_spend"]),
                "qoq_growth": float(row.get("qoq_growth", np.nan)) if not np.isnan(row.get("qoq_growth", np.nan)) else None,
                "yoy_growth": float(row.get("yoy_growth", np.nan)) if not np.isnan(row.get("yoy_growth", np.nan)) else None,
                "spend_zscore": float(z) if not np.isnan(z) else None,
                "acceleration": float(accel) if not np.isnan(accel) else None,
                "n_podcasts": int(row["n_podcasts"]),
                "signal": signal
            })

        # Correlation: spend growth vs 21-day forward return
        fwd21 = ret_wide[ticker].rolling(21).sum().shift(-21)
        spend_z = sub["spend_zscore"].dropna()
        aligned = spend_z.align(fwd21.dropna(), join="inner")
        if len(aligned[0]) > 10:
            r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
            corr_records.append({"ticker": ticker, "spend_fwd21d_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

        # Backtest
        pos = sub.apply(
            lambda r: 1 if (not np.isnan(r.get("spend_zscore", np.nan)) and r.get("spend_zscore", 0) > cfg.zscore_threshold and (r.get("acceleration", 0) or 0) > 0)
                      else (-1 if (not np.isnan(r.get("spend_zscore", np.nan)) and r.get("spend_zscore", 0) < -cfg.zscore_threshold and (r.get("acceleration", 0) or 0) < 0) else 0), axis=1
        )
        pos_daily = pos.reindex(ret_wide.index).ffill().shift(1)
        strat = pos_daily * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "spend_signals.csv"), index=False)

    corr_df = pd.DataFrame(corr_records).sort_values("spend_fwd21d_corr", ascending=False) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "spend_vs_returns.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_tickers": agg["ticker"].nunique(), "n_signals": len(sig_df),
        "n_buy_signals": int((sig_df["signal"] == "buy").sum()) if not sig_df.empty else 0,
        "avg_corr_fwd21d": float(corr_df["spend_fwd21d_corr"].mean()) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"zscore_threshold": cfg.zscore_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Podcast spend | Tickers: {summary['n_tickers']} | Buy signals: {summary['n_buy_signals']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spend", required=True, dest="spend_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--zscore-threshold", type=float, default=1.5)
    ap.add_argument("--outdir", default="./artifacts/podcast_spend")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
