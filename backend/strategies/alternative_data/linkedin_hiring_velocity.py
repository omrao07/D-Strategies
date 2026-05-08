#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
linkedin_hiring_velocity.py — Job posting growth predicts capex & revenue acceleration
========================================================================================
LinkedIn job postings are a real-time proxy for corporate growth intentions.
Rapid headcount expansion in engineering/sales leads revenue growth by 2-3 quarters.
Sudden posting slowdown signals guidance cut risk.

Inputs (CSV)
------------
--postings  linkedin_postings.csv
    Columns: date, ticker, role_category, job_count
    role_category: engineering, sales, ops, finance, other
--returns   stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/hiring_signals.csv       date, ticker, total_postings, yoy_growth, eng_share, signal
outdir/hiring_vs_returns.csv    lead-lag correlation analysis
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def compute_lead_lag_corr(series_a: pd.Series, series_b: pd.Series, max_lag: int = 90) -> dict:
    """Find optimal lead lag (in days) where series_a leads series_b."""
    best_r, best_lag, best_p = 0, 0, 1.0
    lags = range(-max_lag, max_lag + 1, 5)
    for lag in lags:
        b_shifted = series_b.shift(-lag)
        common = series_a.dropna().align(b_shifted.dropna(), join="inner")
        if len(common[0]) < 10:
            continue
        r, p = stats.pearsonr(common[0].values, common[1].values)
        if abs(r) > abs(best_r):
            best_r, best_lag, best_p = r, lag, p
    return {"best_corr": best_r, "best_lag_days": best_lag, "pvalue": best_p}


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    postings = pd.read_csv(cfg.postings_file, parse_dates=["date"])
    postings.columns = [c.lower().strip() for c in postings.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    # Aggregate by ticker and date
    total = postings.groupby(["date", "ticker"])["job_count"].sum().reset_index().rename(columns={"job_count": "total_postings"})
    if "role_category" in postings.columns:
        eng = postings[postings["role_category"] == "engineering"].groupby(["date", "ticker"])["job_count"].sum().reset_index().rename(columns={"job_count": "eng_postings"})
        total = total.merge(eng, on=["date", "ticker"], how="left")
        total["eng_share"] = total["eng_postings"] / total["total_postings"].replace(0, np.nan)
    else:
        total["eng_share"] = np.nan

    signal_records = []
    corr_records = []
    all_daily = []

    for ticker in total["ticker"].unique():
        sub = total[total["ticker"] == ticker].set_index("date").sort_index()
        if len(sub) < 8 or ticker not in ret_wide.columns:
            continue

        # YoY and MoM growth
        sub["yoy_growth"] = sub["total_postings"].pct_change(252)
        sub["mom_growth"] = sub["total_postings"].pct_change(21)
        sub["posting_zscore"] = (sub["total_postings"] - sub["total_postings"].rolling(252).mean()) / \
                                 sub["total_postings"].rolling(252).std().replace(0, np.nan)

        for date, row in sub.iterrows():
            sig = "buy" if row.get("posting_zscore", np.nan) > cfg.zscore_buy else \
                  ("sell" if row.get("posting_zscore", np.nan) < cfg.zscore_sell else "neutral")
            signal_records.append({
                "date": date, "ticker": ticker,
                "total_postings": float(row["total_postings"]),
                "yoy_growth": float(row["yoy_growth"]) if not np.isnan(row["yoy_growth"]) else None,
                "eng_share": float(row["eng_share"]) if not np.isnan(row.get("eng_share", np.nan)) else None,
                "posting_zscore": float(row["posting_zscore"]) if not np.isnan(row["posting_zscore"]) else None,
                "signal": sig
            })

        # Lead-lag correlation
        fwd_ret = ret_wide[ticker].rolling(63).sum()
        ll = compute_lead_lag_corr(sub["total_postings"].dropna(), fwd_ret.dropna(), max_lag=90)
        corr_records.append({"ticker": ticker, **ll})

        # Backtest on posting z-score signal
        pos = sub["posting_zscore"].apply(lambda z: 1 if z > cfg.zscore_buy else (-1 if z < cfg.zscore_sell else 0))
        strat = pos.shift(1) * ret_wide[ticker].reindex(sub.index)
        all_daily.append(strat.rename(ticker))

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "hiring_signals.csv"), index=False)

    corr_df = pd.DataFrame(corr_records).sort_values("best_corr", ascending=False) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "hiring_vs_returns.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_tickers": len(signal_records) > 0 and sig_df["ticker"].nunique() or 0,
        "n_buy_signals": int((sig_df["signal"] == "buy").sum()) if not sig_df.empty else 0,
        "avg_best_lead_lag_days": float(corr_df["best_lag_days"].mean()) if not corr_df.empty else None,
        "avg_best_corr": float(corr_df["best_corr"].mean()) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"zscore_buy": cfg.zscore_buy, "zscore_sell": cfg.zscore_sell}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"LinkedIn hiring | Signals: {len(sig_df)} | Avg lead-lag: {summary['avg_best_lead_lag_days']} days | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--postings", required=True, dest="postings_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--zscore-buy", type=float, default=1.0)
    ap.add_argument("--zscore-sell", type=float, default=-1.0)
    ap.add_argument("--outdir", default="./artifacts/linkedin_hiring")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
