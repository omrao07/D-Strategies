#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
smart_beta_arbitrage.py — Smart beta ETFs vs manual replication → collect spread
==================================================================================
Smart beta ETFs often trade at a premium or discount to the NAV implied by their
constituent weights. This strategy detects the mispricing and signals arb trades.

Inputs (CSV)
------------
--etf         etf_prices.csv       Columns: date, etf, price
--weights     weights.csv          Columns: date, etf, ticker, weight
--constituents constituent_prices.csv  Columns: date, ticker, price

Outputs
-------
outdir/nav_vs_etf.csv     date, etf, nav, etf_price, premium_pct, signal
outdir/arb_backtest.csv   cumulative arb P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def compute_nav(weights: pd.DataFrame, constituent_prices: pd.DataFrame, date: pd.Timestamp, etf: str) -> float:
    w = weights[(weights["etf"] == etf) & (weights["date"] == date)]
    if w.empty:
        return np.nan
    nav = 0.0
    for _, row in w.iterrows():
        t = row["ticker"]
        wt = row["weight"]
        if date in constituent_prices.index and t in constituent_prices.columns:
            nav += wt * constituent_prices.loc[date, t]
    return nav if nav > 0 else np.nan


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    etf_prices = pd.read_csv(cfg.etf_file, parse_dates=["date"])
    etf_prices.columns = [c.lower().strip() for c in etf_prices.columns]
    weights = pd.read_csv(cfg.weights_file, parse_dates=["date"])
    weights.columns = [c.lower().strip() for c in weights.columns]
    cons = pd.read_csv(cfg.constituents_file, parse_dates=["date"])
    cons.columns = [c.lower().strip() for c in cons.columns]
    cons_wide = cons.pivot(index="date", columns="ticker", values="price").sort_index()

    # Get unique dates and ETFs with weight data
    weight_dates = weights["date"].unique()

    records = []
    for _, row in etf_prices.iterrows():
        date, etf, etf_price = row["date"], row["etf"], row["price"]
        # Find nearest weight date
        avail = weight_dates[weight_dates <= date]
        if len(avail) == 0:
            continue
        w_date = avail[-1]
        nav = compute_nav(weights, cons_wide, date, etf)
        if np.isnan(nav) or nav == 0:
            continue
        premium_pct = (etf_price - nav) / nav * 100
        signal = "sell_etf_buy_basket" if premium_pct > cfg.threshold else \
                 ("buy_etf_sell_basket" if premium_pct < -cfg.threshold else "neutral")
        records.append({"date": date, "etf": etf, "nav": nav, "etf_price": etf_price,
                        "premium_pct": premium_pct, "signal": signal})

    df = pd.DataFrame(records).sort_values("date")
    df.to_csv(os.path.join(cfg.outdir, "nav_vs_etf.csv"), index=False)

    # Arb backtest: when signal fires, next-day spread should close
    df["arb_return"] = df.apply(
        lambda r: -r["premium_pct"] / 100 if r["signal"] != "neutral" else 0, axis=1
    ).shift(-1)
    bt = df.groupby("date")["arb_return"].mean().dropna()
    cum = (1 + bt).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "arb_backtest.csv"))

    signals = df[df["signal"] != "neutral"]
    summary = {"n_observations": len(df), "n_arb_signals": len(signals),
               "avg_premium_pct": float(df["premium_pct"].mean()),
               "pct_premium": float((df["premium_pct"] > 0).mean()),
               "avg_premium_on_signal": float(signals["premium_pct"].abs().mean()) if len(signals) > 0 else None,
               "ann_arb_return": float(bt.mean() * 252), "threshold_pct": cfg.threshold}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Smart beta arb | Signals: {len(signals)} | Avg premium: {summary['avg_premium_pct']:.3f}% | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--etf", required=True, dest="etf_file")
    ap.add_argument("--weights", required=True, dest="weights_file")
    ap.add_argument("--constituents", required=True, dest="constituents_file")
    ap.add_argument("--threshold", type=float, default=0.5, help="Min premium/discount %% to signal")
    ap.add_argument("--outdir", default="./artifacts/smart_beta_arb")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
