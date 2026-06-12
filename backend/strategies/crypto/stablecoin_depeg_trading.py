#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stablecoin_depeg_trading.py — Stablecoin peg deviation signals systemic risk or arb
======================================================================================
When USDT/USDC/DAI/FRAX trade away from $1.00, it signals either:
  (a) Liquidity crisis → systemic risk → sell crypto broadly
  (b) Temporary arb opportunity → buy the dip and wait for re-peg

This strategy distinguishes between severe depeg (>2%) vs minor arb (0.1%-0.5%).

Inputs (CSV)
------------
--prices   stablecoin_prices.csv
    Columns: date, ticker, price (USDT, USDC, DAI, FRAX, etc.)
--crypto   crypto_prices.csv
    Columns: date, ticker, price (BTC, ETH, broad market)

Outputs
-------
outdir/depeg_events.csv         date, ticker, deviation_pct, severity, signal
outdir/depeg_vs_btc.csv         depeg events vs BTC next-day performance
outdir/arb_backtest.csv         re-peg arb P&L
outdir/summary.json
"""

import argparse
import json
import os

import pandas as pd

SEVERITY_THRESHOLDS = {"minor": 0.10, "moderate": 0.50, "severe": 2.00, "crisis": 5.00}


def classify_depeg(deviation_abs_pct: float) -> str:
    if deviation_abs_pct < SEVERITY_THRESHOLDS["minor"]:
        return "pegged"
    elif deviation_abs_pct < SEVERITY_THRESHOLDS["moderate"]:
        return "minor"
    elif deviation_abs_pct < SEVERITY_THRESHOLDS["severe"]:
        return "moderate"
    elif deviation_abs_pct < SEVERITY_THRESHOLDS["crisis"]:
        return "severe"
    return "crisis"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    stable = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    stable.columns = [c.lower().strip() for c in stable.columns]
    crypto = pd.read_csv(cfg.crypto_file, parse_dates=["date"])
    crypto.columns = [c.lower().strip() for c in crypto.columns]
    crypto_wide = crypto.pivot(index="date", columns="ticker", values="price").sort_index()

    stable["deviation_pct"] = (stable["price"] - 1.0) * 100
    stable["deviation_abs"] = stable["deviation_pct"].abs()
    stable["severity"] = stable["deviation_abs"].apply(classify_depeg)
    stable["direction"] = stable["deviation_pct"].apply(lambda d: "premium" if d > 0 else "discount")

    depeg_events = []
    arb_records = []

    for ticker in stable["ticker"].unique():
        sub = stable[stable["ticker"] == ticker].set_index("date").sort_index()

        for date, row in sub.iterrows():
            sev = row["severity"]
            dev = float(row["deviation_pct"])
            abs_dev = abs(dev)

            # Arb signal: minor/moderate discount → buy stablecoin → hold until re-peg
            # Systemic signal: severe/crisis → risk-off for all crypto
            if sev in ("severe", "crisis"):
                signal = "risk_off_sell_crypto"
            elif sev in ("minor", "moderate") and dev < 0:
                signal = "arb_buy_discounted_stable"
            elif sev in ("minor", "moderate") and dev > 0:
                signal = "arb_sell_premium_stable"
            else:
                signal = "neutral"

            depeg_events.append({
                "date": date, "ticker": ticker, "price": float(row["price"]),
                "deviation_pct": dev, "deviation_abs": abs_dev,
                "severity": sev, "direction": row["direction"], "signal": signal
            })

            # Arb return: next 1-5 days return toward $1
            for hold in [1, 3, 5]:
                future_date_idx = sub.index.searchsorted(date) + hold
                if future_date_idx < len(sub):
                    future_price = sub.iloc[future_date_idx]["price"]
                    arb_ret = (min(future_price, 1.0) - row["price"]) / row["price"] if dev < 0 else \
                              (row["price"] - max(future_price, 1.0)) / row["price"]
                    arb_records.append({"date": date, "ticker": ticker, "severity": sev,
                                        "hold_days": hold, "arb_return": float(arb_ret),
                                        "initial_deviation": dev})

    depeg_df = pd.DataFrame(depeg_events).sort_values("date")
    depeg_df.to_csv(os.path.join(cfg.outdir, "depeg_events.csv"), index=False)

    # BTC performance on depeg days
    if "BTC" in crypto_wide.columns or "btc" in crypto_wide.columns:
        btc_col = "BTC" if "BTC" in crypto_wide.columns else "btc"
        btc_ret = crypto_wide[btc_col].pct_change()
        severe_dates = depeg_df[depeg_df["severity"].isin(["severe", "crisis"])]["date"].unique()
        btc_on_depeg = btc_ret.reindex(severe_dates).dropna()
        btc_fwd = btc_ret.shift(-1).reindex(severe_dates).dropna()
        pd.DataFrame({"date": btc_fwd.index, "btc_next_day_ret": btc_fwd.values,
                      "btc_same_day_ret": btc_on_depeg.reindex(btc_fwd.index).values}
                     ).to_csv(os.path.join(cfg.outdir, "depeg_vs_btc.csv"), index=False)

    arb_df = pd.DataFrame(arb_records) if arb_records else pd.DataFrame()
    if not arb_df.empty:
        arb_df.to_csv(os.path.join(cfg.outdir, "arb_backtest.csv"), index=False)

    arb_3d = arb_df[arb_df["hold_days"] == 3]["arb_return"].dropna() if not arb_df.empty else pd.Series()
    summary = {
        "n_observations": len(depeg_df), "n_depeg_events": int((depeg_df["severity"] != "pegged").sum()),
        "n_severe_crisis": int(depeg_df["severity"].isin(["severe", "crisis"]).sum()),
        "tickers_analyzed": depeg_df["ticker"].nunique(),
        "avg_arb_return_3d": float(arb_3d.mean()) if len(arb_3d) > 0 else None,
        "arb_win_rate_3d": float((arb_3d > 0).mean()) if len(arb_3d) > 0 else None,
        "severity_distribution": depeg_df["severity"].value_counts().to_dict()
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Stablecoin depeg | Events: {summary['n_depeg_events']} | Severe/Crisis: {summary['n_severe_crisis']} | Arb 3d win rate: {summary['arb_win_rate_3d']:.1%} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--crypto", required=True, dest="crypto_file")
    ap.add_argument("--outdir", default="./artifacts/stablecoin_depeg")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
