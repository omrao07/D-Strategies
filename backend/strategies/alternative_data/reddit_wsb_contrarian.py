#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
reddit_wsb_contrarian.py — WallStreetBets sentiment extremes → contrarian signal
==================================================================================
When retail sentiment on WSB reaches euphoric extremes (top 5% post count +
bullish ratio), smart money fades the crowd. At fear extremes (bottom 5%),
institutions accumulate. This strategy fades retail sentiment extremes.

Inputs (CSV)
------------
--wsb     wsb_sentiment.csv
    Columns: date, ticker, mention_count, bullish_mentions, bearish_mentions,
             upvotes, unique_authors
--returns stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/wsb_signals.csv          date, ticker, sentiment_ratio, mention_zscore, signal
outdir/contrarian_analysis.csv  post-signal average returns by quintile
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    wsb = pd.read_csv(cfg.wsb_file, parse_dates=["date"])
    wsb.columns = [c.lower().strip() for c in wsb.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    wsb["sentiment_ratio"] = wsb["bullish_mentions"] / \
                              (wsb["bullish_mentions"] + wsb["bearish_mentions"]).replace(0, np.nan)
    wsb["author_normalized_mentions"] = wsb["mention_count"] / wsb["unique_authors"].replace(0, 1)

    signal_records = []
    contrast_records = []
    all_daily = []

    for ticker in wsb["ticker"].unique():
        sub = wsb[wsb["ticker"] == ticker].set_index("date").sort_index()
        if len(sub) < 20 or ticker not in ret_wide.columns:
            continue

        sub["mention_zscore"] = (sub["mention_count"] - sub["mention_count"].rolling(60).mean()) / \
                                 sub["mention_count"].rolling(60).std().replace(0, np.nan)
        sub["sentiment_zscore"] = (sub["sentiment_ratio"] - sub["sentiment_ratio"].rolling(60).mean()) / \
                                   sub["sentiment_ratio"].rolling(60).std().replace(0, np.nan)
        sub["frenzy_score"] = sub["mention_zscore"].fillna(0) + sub["sentiment_zscore"].fillna(0)

        for date, row in sub.iterrows():
            fs = row.get("frenzy_score", np.nan)
            if np.isnan(fs):
                signal = "neutral"
            elif fs > cfg.frenzy_threshold:
                signal = "sell"  # Contrarian: fade extreme bullishness
            elif fs < -cfg.frenzy_threshold:
                signal = "buy"   # Contrarian: fade extreme bearishness
            else:
                signal = "neutral"
            signal_records.append({
                "date": date, "ticker": ticker,
                "mention_count": float(row.get("mention_count", 0)),
                "sentiment_ratio": float(row.get("sentiment_ratio", np.nan)) if not np.isnan(row.get("sentiment_ratio", np.nan)) else None,
                "mention_zscore": float(row.get("mention_zscore", np.nan)) if not np.isnan(row.get("mention_zscore", np.nan)) else None,
                "frenzy_score": float(fs) if not np.isnan(fs) else None,
                "signal": signal
            })

        # Post-signal return analysis: quintile breakdown
        fwd5 = ret_wide[ticker].rolling(5).sum().shift(-5)
        for q_low, q_high, label in [(0, 0.2, "Q1_very_bearish"), (0.2, 0.4, "Q2_bearish"),
                                      (0.4, 0.6, "Q3_neutral"), (0.6, 0.8, "Q4_bullish"), (0.8, 1.0, "Q5_very_bullish")]:
            q_l = sub["frenzy_score"].dropna().quantile(q_low)
            q_h = sub["frenzy_score"].dropna().quantile(q_high)
            mask = (sub["frenzy_score"] >= q_l) & (sub["frenzy_score"] < q_h)
            dates_in_q = sub[mask].index
            fwd_in_q = fwd5.reindex(dates_in_q).dropna()
            if len(fwd_in_q) > 0:
                contrast_records.append({"ticker": ticker, "quintile": label,
                                          "avg_fwd5d_ret": float(fwd_in_q.mean()), "n": len(fwd_in_q)})

        # Backtest: contrarian signal
        pos = sub["frenzy_score"].apply(lambda z: -1 if z > cfg.frenzy_threshold else (1 if z < -cfg.frenzy_threshold else 0))
        pos_daily = pos.reindex(ret_wide.index).ffill().shift(1)
        strat = pos_daily * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "wsb_signals.csv"), index=False)

    contrast_df = pd.DataFrame(contrast_records) if contrast_records else pd.DataFrame()
    if not contrast_df.empty:
        contrast_df.to_csv(os.path.join(cfg.outdir, "contrarian_analysis.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_tickers": wsb["ticker"].nunique(), "n_signals": len(sig_df),
        "n_contrarian_sells": int((sig_df["signal"] == "sell").sum()) if not sig_df.empty else 0,
        "n_contrarian_buys": int((sig_df["signal"] == "buy").sum()) if not sig_df.empty else 0,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"frenzy_threshold": cfg.frenzy_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"WSB contrarian | Tickers: {summary['n_tickers']} | Sells: {summary['n_contrarian_sells']} | Buys: {summary['n_contrarian_buys']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wsb", required=True, dest="wsb_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--frenzy-threshold", type=float, default=2.0, help="Z-score threshold to flag frenzy")
    ap.add_argument("--outdir", default="./artifacts/wsb_contrarian")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
