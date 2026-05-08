#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
glassdoor_review_sentiment.py — Employee reviews predict culture health & retention
====================================================================================
Glassdoor ratings (overall, CEO approval, culture, work-life) are leading
indicators of management quality. Sustained decline → talent drain → future
revenue miss. Rising ratings → improving execution → potential beat.

Inputs (CSV)
------------
--reviews   glassdoor_reviews.csv
    Columns: date, ticker, overall_rating, ceo_approval, culture_rating,
             work_life_rating, recommend_pct, review_count
--returns   stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/sentiment_signals.csv    date, ticker, composite_score, signal, percentile
outdir/score_vs_returns.csv     correlation of Glassdoor composite vs forward returns
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


WEIGHTS = {"overall_rating": 0.30, "ceo_approval": 0.20, "culture_rating": 0.25,
           "work_life_rating": 0.10, "recommend_pct": 0.15}

REQUIRED = list(WEIGHTS.keys())


def compute_composite(row: pd.Series) -> float:
    score = 0.0
    total_w = 0.0
    for col, w in WEIGHTS.items():
        if col in row and not np.isnan(row[col]):
            score += w * row[col]
            total_w += w
    return score / total_w if total_w > 0 else np.nan


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    reviews = pd.read_csv(cfg.reviews_file, parse_dates=["date"])
    reviews.columns = [c.lower().strip() for c in reviews.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    # Normalize ceo_approval and recommend_pct to 0-5 scale if they are in 0-100 range
    if "ceo_approval" in reviews.columns and reviews["ceo_approval"].max() > 10:
        reviews["ceo_approval"] = reviews["ceo_approval"] / 100 * 5
    if "recommend_pct" in reviews.columns and reviews["recommend_pct"].max() > 10:
        reviews["recommend_pct"] = reviews["recommend_pct"] / 100 * 5

    reviews["composite"] = reviews.apply(compute_composite, axis=1)
    reviews = reviews.dropna(subset=["composite"]).sort_values("date")

    # Cross-sectional rank and z-score per date
    reviews["cs_zscore"] = reviews.groupby("date")["composite"].transform(
        lambda x: (x - x.mean()) / x.std() if x.std() > 0 else 0
    )
    reviews["percentile"] = reviews.groupby("date")["composite"].transform(
        lambda x: x.rank(pct=True) * 100
    )

    signal_records = []
    corr_records = []
    all_daily = []

    tickers = reviews["ticker"].unique()
    for ticker in tickers:
        sub = reviews[reviews["ticker"] == ticker].set_index("date").sort_index()
        if len(sub) < 4 or ticker not in ret_wide.columns:
            continue

        sub["composite_chg"] = sub["composite"].diff()
        sub["composite_ma"] = sub["composite"].rolling(cfg.smoothing_window, min_periods=1).mean()
        sub["trend"] = sub["composite_ma"].diff(cfg.smoothing_window)

        for date, row in sub.iterrows():
            signal = "buy" if row["percentile"] > cfg.top_pct else \
                     ("sell" if row["percentile"] < (100 - cfg.top_pct) else "neutral")
            signal_records.append({"date": date, "ticker": ticker,
                                   "composite": float(row["composite"]),
                                   "cs_zscore": float(row["cs_zscore"]) if not np.isnan(row["cs_zscore"]) else 0,
                                   "percentile": float(row["percentile"]),
                                   "trend": float(row["trend"]) if not np.isnan(row["trend"]) else 0,
                                   "signal": signal})

        # Correlation with 21-day forward returns
        fwd21 = ret_wide[ticker].rolling(21).sum().shift(-21)
        aligned_cs = sub["cs_zscore"].dropna()
        aligned_fwd = fwd21.reindex(aligned_cs.index).dropna()
        common_idx = aligned_cs.index.intersection(aligned_fwd.index)
        if len(common_idx) > 6:
            r, p = stats.pearsonr(aligned_cs.loc[common_idx].values, aligned_fwd.loc[common_idx].values)
            corr_records.append({"ticker": ticker, "corr_cs_zscore_fwd21d": float(r), "pvalue": float(p), "n": len(common_idx)})

        # Backtest: percentile-based long/short
        pos = sub["percentile"].apply(lambda pct: 1 if pct > cfg.top_pct else (-1 if pct < (100 - cfg.top_pct) else 0))
        stk_ret = ret_wide[ticker].reindex(sub.index)
        strat = pos.shift(1) * stk_ret
        all_daily.append(strat.rename(ticker))

    sig_df = pd.DataFrame(signal_records).sort_values(["date", "percentile"], ascending=[True, False])
    sig_df.to_csv(os.path.join(cfg.outdir, "sentiment_signals.csv"), index=False)

    corr_df = pd.DataFrame(corr_records).sort_values("pvalue") if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "score_vs_returns.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_tickers": len(tickers), "n_signals": len(sig_df),
        "avg_corr_fwd21d": float(corr_df["corr_cs_zscore_fwd21d"].mean()) if not corr_df.empty else None,
        "pct_positive_corr": float((corr_df["corr_cs_zscore_fwd21d"] > 0).mean()) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"top_pct": cfg.top_pct, "smoothing_window": cfg.smoothing_window}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Glassdoor sentiment | Tickers: {len(tickers)} | Avg corr: {summary['avg_corr_fwd21d']:.3f if summary['avg_corr_fwd21d'] else 'N/A'} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reviews", required=True, dest="reviews_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--top-pct", type=float, default=75.0, help="Percentile above which to go long")
    ap.add_argument("--smoothing-window", type=int, default=3, help="Quarters to smooth composite")
    ap.add_argument("--outdir", default="./artifacts/glassdoor_sentiment")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
