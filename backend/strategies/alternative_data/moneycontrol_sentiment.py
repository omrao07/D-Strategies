#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
moneycontrol_sentiment.py — Moneycontrol.com news sentiment for NSE stocks
===========================================================================
Moneycontrol is India's largest financial news platform. News article sentiment
from Moneycontrol predicts next-day stock returns for NSE stocks, particularly
for mid/small caps where analyst coverage is sparse.

Sentiment scoring:
  - Positive: "strong buy", "outperform", "upgraded", "beat expectations"
  - Negative: "downgrade", "miss", "underperform", "sell", "SEBI probe"
  - Entity extraction: ticker name + sentiment score

India moat: Unlike Bloomberg/Reuters news, Moneycontrol covers tier-2 and tier-3
NSE stocks with editorial context. Local language nuance (regulatory risk,
promoter pledging, RBI action) is not captured by global NLP models.

Inputs (CSV)
------------
--sentiment sentiment.csv   date, ticker, article_count, avg_sentiment_score (-1 to 1),
                            positive_articles, negative_articles
--prices    prices.csv      date, ticker, close

Outputs
-------
outdir/sentiment_signals.csv    date, ticker, sentiment, z_score, signal
outdir/news_impact.csv          ticker, avg_sentiment, correlation_fwd_1d, n_articles
outdir/sentiment_momentum.csv   date, ticker, sentiment_5d_ma, momentum_signal
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd

ZSCORE_WINDOW = 30
ENTRY_Z = 1.5
SENTIMENT_MA = 5          # 5-day MA of sentiment scores
FORWARD_DAYS = [1, 2, 3, 5]
MIN_ARTICLES = 3          # Minimum article count for signal


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    sent = pd.read_csv(cfg.sentiment_file, parse_dates=["date"])
    sent.columns = [c.lower().strip() for c in sent.columns]
    sent_col = "avg_sentiment_score" if "avg_sentiment_score" in sent.columns else "sentiment_score"
    count_col = "article_count" if "article_count" in sent.columns else None

    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]
    prices_wide = prices.pivot_table(index="date", columns="ticker", values="close").sort_index()
    prices_wide.columns = [c.upper() for c in prices_wide.columns]

    signal_records = []
    impact_records = []
    momentum_records = []
    all_port = []

    for ticker in sent["ticker"].unique() if "ticker" in sent.columns else ["aggregate"]:
        if "ticker" in sent.columns:
            tick_sent = sent[sent["ticker"].str.upper() == ticker.upper()].copy()
        else:
            tick_sent = sent.copy()
            ticker = "AGGREGATE"

        tick_sent = tick_sent.set_index("date").sort_index()

        if sent_col not in tick_sent.columns:
            continue

        # Filter by minimum article count
        if count_col and count_col in tick_sent.columns:
            tick_sent = tick_sent[tick_sent[count_col] >= MIN_ARTICLES]

        if len(tick_sent) < 20:
            continue

        # Sentiment rolling stats
        tick_sent["sent_ma5"] = tick_sent[sent_col].rolling(SENTIMENT_MA).mean()
        mu = tick_sent[sent_col].rolling(ZSCORE_WINDOW).mean()
        sigma = tick_sent[sent_col].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
        tick_sent["z_score"] = (tick_sent[sent_col] - mu) / sigma

        # Momentum: change in sentiment trend
        tick_sent["sent_momentum"] = tick_sent[sent_col].diff(5)  # 5-day change

        # Correlate with forward prices
        ticker_upper = str(ticker).upper()
        if ticker_upper in prices_wide.columns:
            px = prices_wide[ticker_upper]
            ret = px.pct_change()
            fwd_rets = {f"fwd_{d}d": ret.rolling(d).sum().shift(-d) for d in FORWARD_DAYS}

            # Correlation at each forward window
            best_corr = best_lag = None
            for lag, fwd in fwd_rets.items():
                aligned = pd.concat([tick_sent[sent_col], fwd], axis=1).dropna()
                if len(aligned) >= 30:
                    corr = float(aligned.iloc[:, 0].corr(aligned.iloc[:, 1]))
                    if best_corr is None or abs(corr) > abs(best_corr):
                        best_corr = corr
                        best_lag = int(lag.replace("fwd_", "").replace("d", ""))

            impact_records.append({
                "ticker": ticker_upper,
                "avg_sentiment": float(tick_sent[sent_col].mean()),
                "sentiment_std": float(tick_sent[sent_col].std()),
                "best_correlation": float(best_corr) if best_corr else None,
                "best_lag_days": best_lag,
                "n_articles_days": len(tick_sent),
            })

            # Signal
            pos = tick_sent["z_score"].shift(1).apply(
                lambda z: 1 if z > ENTRY_Z else (-1 if z < -ENTRY_Z else 0)
            )

            fwd_1d = ret.shift(-1)
            strat_ret = (pos.reindex(ret.index, method="ffill") * ret).dropna()
            if len(strat_ret) >= 20:
                all_port.append(strat_ret.rename(ticker_upper))

            for dt, row in tick_sent.iterrows():
                z = row.get("z_score", np.nan)
                sig = "positive" if z > ENTRY_Z else ("negative" if z < -ENTRY_Z else "neutral")
                signal_records.append({
                    "date": dt.date(),
                    "ticker": ticker_upper,
                    "sentiment_score": float(row[sent_col]),
                    "sentiment_ma5": float(row["sent_ma5"]) if not np.isnan(row["sent_ma5"]) else None,
                    "z_score": float(z) if not np.isnan(z) else None,
                    "article_count": float(row[count_col]) if count_col and count_col in row else None,
                    "signal": sig,
                })
                momentum_records.append({
                    "date": dt.date(),
                    "ticker": ticker_upper,
                    "sent_5d_ma": float(row["sent_ma5"]) if not np.isnan(row["sent_ma5"]) else None,
                    "momentum": float(row["sent_momentum"]) if not np.isnan(row["sent_momentum"]) else None,
                    "momentum_signal": "improving" if row.get("sent_momentum", 0) > 0 else "deteriorating",
                })

    if signal_records:
        pd.DataFrame(signal_records).sort_values(["date", "ticker"]).to_csv(
            os.path.join(cfg.outdir, "sentiment_signals.csv"), index=False
        )
    if impact_records:
        pd.DataFrame(impact_records).sort_values("best_correlation", key=abs, ascending=False).to_csv(
            os.path.join(cfg.outdir, "news_impact.csv"), index=False
        )
    if momentum_records:
        pd.DataFrame(momentum_records).sort_values(["date", "ticker"]).to_csv(
            os.path.join(cfg.outdir, "sentiment_momentum.csv"), index=False
        )

    if all_port:
        portfolio = pd.concat(all_port, axis=1).mean(axis=1).dropna()
        cum = (1 + portfolio).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(portfolio.mean() / portfolio.std() * np.sqrt(252)) if portfolio.std() > 0 else None
    else:
        sharpe = None

    avg_sentiment = float(np.mean([r["avg_sentiment"] for r in impact_records])) if impact_records else None
    summary = {
        "n_tickers_covered": len(impact_records),
        "avg_portfolio_sentiment": avg_sentiment,
        "n_signal_records": len(signal_records),
        "sharpe": sharpe,
        "params": {"entry_z": ENTRY_Z, "min_articles": MIN_ARTICLES, "sentiment_ma": SENTIMENT_MA}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Moneycontrol Sentiment | {len(impact_records)} tickers | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sentiment", required=True, dest="sentiment_file")
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--outdir", default="./artifacts/moneycontrol_sentiment")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
