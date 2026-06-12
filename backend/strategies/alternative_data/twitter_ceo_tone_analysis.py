#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
twitter_ceo_tone_analysis.py — Executive tweet tone predicts guidance & sentiment shifts
==========================================================================================
C-suite Twitter/X activity provides unstructured forward guidance. Sudden increase
in confident/optimistic language → positive surprise risk. Defensive/vague language
→ warning flag. Engagement rate changes signal market attention shifts.

Inputs (CSV)
------------
--tweets   ceo_tweets.csv
    Columns: date, ticker, exec_role, tweet_text, likes, retweets, replies,
             sentiment_score (-1 to 1), word_count, confidence_score (0-1)
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/tone_signals.csv         date, ticker, tone_composite, signal
outdir/engagement_trends.csv    engagement velocity by ticker
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

CEO_WEIGHT = 0.50
CFO_WEIGHT = 0.30
OTHER_WEIGHT = 0.20

ROLE_WEIGHTS = {"ceo": CEO_WEIGHT, "cfo": CFO_WEIGHT, "president": 0.35, "coo": 0.20}


def compute_engagement_velocity(sub: pd.DataFrame) -> pd.Series:
    """Likes + retweets per tweet, rolling average."""
    sub = sub.copy()
    sub["engage_per_tweet"] = (sub["likes"] + sub["retweets"]) / sub.groupby("date")["likes"].transform("count").replace(0, 1)
    daily = sub.groupby("date")["engage_per_tweet"].mean()
    velocity = daily / daily.rolling(30, min_periods=5).mean().replace(0, np.nan) - 1
    return velocity


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    tweets = pd.read_csv(cfg.tweets_file, parse_dates=["date"])
    tweets.columns = [c.lower().strip() for c in tweets.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    # Role-weighted sentiment and confidence composite
    if "exec_role" in tweets.columns:
        tweets["role_weight"] = tweets["exec_role"].str.lower().map(ROLE_WEIGHTS).fillna(OTHER_WEIGHT)
    else:
        tweets["role_weight"] = 1.0

    if "sentiment_score" not in tweets.columns:
        tweets["sentiment_score"] = 0.0
    if "confidence_score" not in tweets.columns:
        tweets["confidence_score"] = 0.5

    tweets["tone_raw"] = tweets["sentiment_score"] * 0.6 + (tweets["confidence_score"] - 0.5) * 0.4
    tweets["weighted_tone"] = tweets["tone_raw"] * tweets["role_weight"]

    daily_tone = tweets.groupby(["date", "ticker"]).apply(
        lambda g: np.average(g["tone_raw"], weights=g["role_weight"]) if len(g) > 0 else np.nan
    ).reset_index(name="tone_composite")
    daily_tone = daily_tone.dropna(subset=["tone_composite"])

    signal_records = []
    engage_records = []
    all_daily = []

    for ticker in daily_tone["ticker"].unique():
        sub_tone = daily_tone[daily_tone["ticker"] == ticker].set_index("date").sort_index()
        if len(sub_tone) < 10 or ticker not in ret_wide.columns:
            continue

        sub_tone["tone_zscore"] = (sub_tone["tone_composite"] - sub_tone["tone_composite"].rolling(60, min_periods=10).mean()) / \
                                   sub_tone["tone_composite"].rolling(60, min_periods=10).std().replace(0, np.nan)
        sub_tone["tone_trend"] = sub_tone["tone_composite"].rolling(5).mean() - sub_tone["tone_composite"].rolling(20).mean()

        # Engagement velocity
        sub_tweets = tweets[tweets["ticker"] == ticker]
        engage_vel = compute_engagement_velocity(sub_tweets)
        sub_tone["engage_vel"] = engage_vel.reindex(sub_tone.index)

        for date, row in sub_tone.iterrows():
            z = row.get("tone_zscore", np.nan)
            trend = row.get("tone_trend", 0) or 0
            if np.isnan(z):
                signal = "neutral"
            elif z > cfg.tone_threshold and trend > 0:
                signal = "buy"
            elif z < -cfg.tone_threshold and trend < 0:
                signal = "sell"
            else:
                signal = "neutral"

            signal_records.append({
                "date": date, "ticker": ticker,
                "tone_composite": float(row["tone_composite"]),
                "tone_zscore": float(z) if not np.isnan(z) else None,
                "tone_trend": float(trend),
                "engage_velocity": float(row.get("engage_vel", np.nan)) if not np.isnan(row.get("engage_vel", np.nan)) else None,
                "signal": signal
            })

            ev = row.get("engage_vel", np.nan)
            if not np.isnan(ev):
                engage_records.append({"date": date, "ticker": ticker, "engage_velocity": float(ev)})

        # Backtest
        pos = sub_tone.apply(lambda r: 1 if (not np.isnan(r["tone_zscore"]) and r["tone_zscore"] > cfg.tone_threshold and r["tone_trend"] > 0)
                             else (-1 if (not np.isnan(r["tone_zscore"]) and r["tone_zscore"] < -cfg.tone_threshold and r["tone_trend"] < 0) else 0), axis=1)
        pos_daily = pos.reindex(ret_wide.index).ffill().shift(1)
        strat = pos_daily * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "tone_signals.csv"), index=False)

    engage_df = pd.DataFrame(engage_records).sort_values("date") if engage_records else pd.DataFrame()
    if not engage_df.empty:
        engage_df.to_csv(os.path.join(cfg.outdir, "engagement_trends.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_tickers": daily_tone["ticker"].nunique(), "n_signals": len(sig_df),
        "n_buys": int((sig_df["signal"] == "buy").sum()) if not sig_df.empty else 0,
        "n_sells": int((sig_df["signal"] == "sell").sum()) if not sig_df.empty else 0,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"tone_threshold": cfg.tone_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"CEO tone | Tickers: {summary['n_tickers']} | Buys: {summary['n_buys']} | Sells: {summary['n_sells']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tweets", required=True, dest="tweets_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--tone-threshold", type=float, default=1.5)
    ap.add_argument("--outdir", default="./artifacts/ceo_tone")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
