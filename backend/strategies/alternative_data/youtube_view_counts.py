#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
youtube_view_counts.py — Product launch video views predict consumer demand
=============================================================================
YouTube view counts for product launch/review videos are a direct proxy for
consumer interest. Viral product videos (>10M views in 48h) signal demand
surprises. Applies to consumer electronics, gaming, automotive, media companies.

Inputs (CSV)
------------
--videos   youtube_videos.csv
    Columns: date, ticker, video_id, views_24h, views_48h, views_7d,
             views_30d, likes, comments, category
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/view_signals.csv         date, ticker, viral_score, signal
outdir/viral_vs_returns.csv     view velocity vs forward return correlation
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd
from scipy import stats


def compute_viral_score(row: pd.Series) -> float:
    """Composite virality: weighted blend of view velocity, engagement ratio."""
    v24 = row.get("views_24h", 0) or 0
    v48 = row.get("views_48h", 0) or 0
    v7 = row.get("views_7d", 0) or 0
    likes = row.get("likes", 0) or 0
    comments = row.get("comments", 0) or 0
    # View acceleration (48h incremental over 24h)
    accel = max(v48 - v24, 0) / max(v24, 1)
    # Engagement rate
    engage = (likes + comments) / max(v48, 1)
    # Normalize: log views for scale
    log_views = np.log1p(v7)
    return float(0.4 * log_views + 0.3 * accel + 0.3 * engage * 100)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    videos = pd.read_csv(cfg.videos_file, parse_dates=["date"])
    videos.columns = [c.lower().strip() for c in videos.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    videos["viral_score"] = videos.apply(compute_viral_score, axis=1)

    # Aggregate per ticker per date (max viral score of all videos that day)
    agg = videos.groupby(["date", "ticker"]).agg(
        viral_score=("viral_score", "max"),
        total_views_7d=("views_7d", "sum"),
        n_videos=("viral_score", "count")
    ).reset_index()

    signal_records = []
    corr_records = []
    all_daily = []

    for ticker in agg["ticker"].unique():
        sub = agg[agg["ticker"] == ticker].set_index("date").sort_index()
        if len(sub) < 5 or ticker not in ret_wide.columns:
            continue

        sub["score_zscore"] = (sub["viral_score"] - sub["viral_score"].rolling(30, min_periods=5).mean()) / \
                               sub["viral_score"].rolling(30, min_periods=5).std().replace(0, np.nan)
        sub["views_zscore"] = (sub["total_views_7d"] - sub["total_views_7d"].rolling(30, min_periods=5).mean()) / \
                               sub["total_views_7d"].rolling(30, min_periods=5).std().replace(0, np.nan)

        for date, row in sub.iterrows():
            z = row.get("score_zscore", np.nan)
            threshold_met = not np.isnan(z) and z > cfg.viral_zscore
            views_above = row.get("total_views_7d", 0) > cfg.min_views_threshold
            signal = "buy" if (threshold_met and views_above) else "neutral"
            signal_records.append({
                "date": date, "ticker": ticker,
                "viral_score": float(row["viral_score"]),
                "score_zscore": float(z) if not np.isnan(z) else None,
                "total_views_7d": float(row["total_views_7d"]),
                "n_videos": int(row["n_videos"]),
                "signal": signal
            })

        # Correlation: viral score vs 10-day forward return
        fwd10 = ret_wide[ticker].rolling(10).sum().shift(-10)
        vs_daily = sub["score_zscore"].reindex(ret_wide.index).ffill().dropna()
        aligned = vs_daily.align(fwd10.dropna(), join="inner")
        if len(aligned[0]) > 8:
            r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
            corr_records.append({"ticker": ticker, "viral_fwd10d_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

        # Backtest: long on viral signal
        sig_series = sub["score_zscore"].apply(
            lambda z: 1 if (not np.isnan(z) and z > cfg.viral_zscore) else 0
        )
        sig_daily = sig_series.reindex(ret_wide.index).ffill().shift(1)
        strat = sig_daily * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "view_signals.csv"), index=False)

    corr_df = pd.DataFrame(corr_records).sort_values("viral_fwd10d_corr", ascending=False) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "viral_vs_returns.csv"), index=False)

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
        "avg_corr_fwd10d": float(corr_df["viral_fwd10d_corr"].mean()) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"viral_zscore": cfg.viral_zscore, "min_views_threshold": cfg.min_views_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"YouTube views | Tickers: {summary['n_tickers']} | Buy signals: {summary['n_buy_signals']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", required=True, dest="videos_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--viral-zscore", type=float, default=2.0)
    ap.add_argument("--min-views-threshold", type=float, default=1e6, help="Minimum 7-day views to qualify")
    ap.add_argument("--outdir", default="./artifacts/youtube_views")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
