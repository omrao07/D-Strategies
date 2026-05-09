#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
kimchi_premium_korea.py — Korean exchange premium vs global price → arb signal
================================================================================
Korean crypto exchanges (Upbit, Bithumb) periodically trade at premiums of 5-30%
over global prices due to capital controls. The premium expands in bull markets
and collapses rapidly. This strategy uses premium extremes as sentiment indicators
and arb triggers when capital flow normalizes.

Inputs (CSV)
------------
--prices   kimchi_prices.csv
    Columns: date, ticker, global_price_usd, korean_price_krw, usd_krw_rate

Outputs
-------
outdir/kimchi_premium.csv       date, ticker, premium_pct, zscore, signal
outdir/premium_vs_global.csv    premium rolling stats
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    df = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    df = df.sort_values("date")

    # Compute Korean price in USD
    df["korean_price_usd"] = df["korean_price_krw"] / df["usd_krw_rate"]
    df["premium_pct"] = (df["korean_price_usd"] / df["global_price_usd"] - 1) * 100

    records = []
    backtest_by_ticker = {}

    for ticker in df["ticker"].unique():
        sub = df[df["ticker"] == ticker].set_index("date").sort_index()
        if len(sub) < 30:
            continue

        sub["premium_zscore"] = (sub["premium_pct"] - sub["premium_pct"].rolling(60).mean()) / \
                                  sub["premium_pct"].rolling(60).std().replace(0, np.nan)
        sub["premium_ma20"] = sub["premium_pct"].rolling(20).mean()
        sub["premium_trend"] = sub["premium_ma20"] - sub["premium_pct"].rolling(60).mean()

        ret_global = sub["global_price_usd"].pct_change()

        for date, row in sub.iterrows():
            z = row.get("premium_zscore", np.nan)
            prem = row["premium_pct"]
            # High premium = Korean retail FOMO → global market may follow (short-term) then reverse
            # Very high premium = mean reversion trade: short KRW / long USD (if permitted)
            if not np.isnan(z):
                if z > cfg.high_premium_zscore:
                    signal = "fade_premium_short_global"  # premium unsustainable
                elif z < cfg.low_premium_zscore:
                    signal = "buy_global_premium_discount"  # global undervalued vs Korea
                elif prem > cfg.absolute_premium_pct:
                    signal = "soft_fade"  # elevated but not extreme
                else:
                    signal = "neutral"
            else:
                signal = "neutral"

            records.append({
                "date": date, "ticker": ticker,
                "global_price_usd": float(row["global_price_usd"]),
                "korean_price_usd": float(row["korean_price_usd"]),
                "premium_pct": float(prem),
                "premium_zscore": float(z) if not np.isnan(z) else None,
                "premium_ma20": float(row["premium_ma20"]) if not np.isnan(row["premium_ma20"]) else None,
                "signal": signal
            })

        # Backtest: fade premium signal on global price
        pos = sub.apply(
            lambda r: -1 if r.get("premium_zscore", 0) > cfg.high_premium_zscore
                      else (1 if r.get("premium_zscore", 0) < cfg.low_premium_zscore else 0), axis=1
        )
        strat = pos.shift(1) * ret_global
        backtest_by_ticker[ticker] = strat

    out = pd.DataFrame(records).sort_values("date")
    out.to_csv(os.path.join(cfg.outdir, "kimchi_premium.csv"), index=False)

    # Rolling premium stats
    premium_stats = out.groupby("ticker")["premium_pct"].agg(
        ["mean", "std", "max", "min"]).round(4).reset_index()
    premium_stats.to_csv(os.path.join(cfg.outdir, "premium_vs_global.csv"), index=False)

    if backtest_by_ticker:
        port = pd.concat(backtest_by_ticker.values(), axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(365)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 365)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_tickers": df["ticker"].nunique(), "n_records": len(out),
        "avg_premium_pct": float(out["premium_pct"].mean()),
        "max_premium_pct": float(out["premium_pct"].max()),
        "pct_time_positive_premium": float((out["premium_pct"] > 0).mean()),
        "n_fade_signals": int((out["signal"] == "fade_premium_short_global").sum()),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"high_premium_zscore": cfg.high_premium_zscore,
                   "low_premium_zscore": cfg.low_premium_zscore,
                   "absolute_premium_pct": cfg.absolute_premium_pct}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Kimchi premium | Avg: {summary['avg_premium_pct']:.2f}% | Max: {summary['max_premium_pct']:.2f}% | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--high-premium-zscore", type=float, default=2.0)
    ap.add_argument("--low-premium-zscore", type=float, default=-1.5)
    ap.add_argument("--absolute-premium-pct", type=float, default=10.0)
    ap.add_argument("--outdir", default="./artifacts/kimchi_premium")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
