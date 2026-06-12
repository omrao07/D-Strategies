#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nse_adr_pairs.py — NSE stocks vs their US ADR price divergence strategy
=======================================================================
Several Indian companies have dual-listed ADRs in the US (INFY, WIT, HDB, IBN,
RDY, SIF). The ADR price (USD, US session) should equal the NSE price adjusted
for USDINR and ADR ratio. Divergences create arbitrage opportunities.

Common sources of divergence:
  - US earnings reactions before Indian market opens
  - Currency moves (USDINR) creating overnight gaps
  - US-listed index rebalances (S&P Global / MSCI) affecting ADR supply

Inputs (CSV)
------------
--nse       nse.csv         date, ticker, nse_close_inr
--adr       adr.csv         date, ticker, adr_close_usd, adr_ratio (NSE shares per ADR)
--usdinr    usdinr.csv      date, usdinr_close

Outputs
-------
outdir/adr_premium.csv          date, ticker, nse_price_usd, adr_price_usd, premium_pct, signal
outdir/divergence_events.csv    event summary with forward returns
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

# ADR pairs (NSE ticker → US ADR ticker, conversion ratio)
ADR_PAIRS = {
    "INFY":     ("INFY_US",  1),    # 1 ADR = 1 NSE share
    "WIPRO":    ("WIT",      5),    # 1 ADR = 5 NSE shares
    "HDFCBANK": ("HDB",      3),    # 1 ADR = 3 NSE shares
    "ICICIBANK":("IBN",      2),    # 1 ADR = 2 NSE shares
    "DRREDDY":  ("RDY",      1),
    "TATAMOTORS":("TTM",     1),
    "MPHASIS":  ("MPhsS",    1),
}

ENTRY_PREMIUM_PCT = 1.0   # Enter when ADR/NSE diverges > 1%
EXIT_PREMIUM_PCT = 0.2    # Exit when premium < 0.2%
ZSCORE_WINDOW = 30


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    nse = pd.read_csv(cfg.nse_file, parse_dates=["date"])
    nse.columns = [c.lower().strip() for c in nse.columns]
    nse_wide = nse.pivot_table(index="date", columns="ticker", values="nse_close_inr").sort_index()
    nse_wide.columns = [c.upper() for c in nse_wide.columns]

    adr = pd.read_csv(cfg.adr_file, parse_dates=["date"])
    adr.columns = [c.lower().strip() for c in adr.columns]

    usdinr = pd.read_csv(cfg.usdinr_file, parse_dates=["date"]).set_index("date").sort_index()
    usdinr.columns = [c.lower().strip() for c in usdinr.columns]
    usdinr_col = usdinr.columns[0]

    premium_records = []
    divergence_events = []
    all_port = []

    for nse_ticker, (adr_ticker, ratio) in ADR_PAIRS.items():
        if nse_ticker not in nse_wide.columns:
            continue

        ticker_adr = adr[adr["ticker"].str.upper() == adr_ticker.upper()].copy() if "ticker" in adr.columns else adr.copy()

        if ticker_adr.empty:
            continue

        ticker_adr = ticker_adr.set_index("date").sort_index()
        adr_col = "adr_close_usd" if "adr_close_usd" in ticker_adr.columns else ticker_adr.columns[0]

        # Merge NSE + ADR + USDINR
        merged = pd.DataFrame({
            "nse_inr": nse_wide[nse_ticker],
            "adr_usd": ticker_adr[adr_col],
            "usdinr": usdinr[usdinr_col].reindex(nse_wide.index).ffill(),
        }).dropna()

        if len(merged) < 30:
            continue

        # Convert NSE price to USD for comparison
        merged["nse_usd"] = merged["nse_inr"] / merged["usdinr"] * ratio  # Per ADR equivalent
        merged["adr_premium_pct"] = (merged["adr_usd"] / merged["nse_usd"] - 1) * 100

        # Z-score of premium
        mu = merged["adr_premium_pct"].rolling(ZSCORE_WINDOW).mean()
        sigma = merged["adr_premium_pct"].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
        merged["premium_z"] = (merged["adr_premium_pct"] - mu) / sigma

        # Signal: when ADR premium is extreme vs NSE equivalent
        merged["signal"] = merged["premium_z"].shift(1).apply(
            lambda z: "short_adr_buy_nse" if z > 2.0 else (
                "long_adr_sell_nse" if z < -2.0 else "neutral"
            )
        )

        # Backtest: capture premium reversion
        pos = merged["signal"].map({"short_adr_buy_nse": -1, "long_adr_sell_nse": 1, "neutral": 0}).fillna(0)
        premium_ret = merged["adr_premium_pct"].diff() / 100  # Premium change as return
        strat_ret = pos * (-premium_ret)  # Short when premium > 0, profit when it narrows
        strat_ret = strat_ret.dropna()

        if len(strat_ret) >= 20:
            all_port.append(strat_ret.rename(nse_ticker))

        # Record premium data
        for dt, row in merged.iterrows():
            premium_records.append({
                "date": dt.date(),
                "ticker": nse_ticker,
                "nse_price_usd": float(row["nse_usd"]),
                "adr_price_usd": float(row["adr_usd"]),
                "premium_pct": float(row["adr_premium_pct"]),
                "z_score": float(row["premium_z"]) if not np.isnan(row["premium_z"]) else None,
                "signal": row["signal"],
            })

        # Large divergence events
        extreme = merged[merged["adr_premium_pct"].abs() > ENTRY_PREMIUM_PCT]
        for dt, row in extreme.iterrows():
            divergence_events.append({
                "date": dt.date(),
                "ticker": nse_ticker,
                "premium_pct": float(row["adr_premium_pct"]),
                "nse_price_usd": float(row["nse_usd"]),
                "adr_price_usd": float(row["adr_usd"]),
            })

    pd.DataFrame(premium_records).sort_values(["date", "ticker"]).to_csv(
        os.path.join(cfg.outdir, "adr_premium.csv"), index=False
    )
    if divergence_events:
        pd.DataFrame(divergence_events).sort_values("date").to_csv(
            os.path.join(cfg.outdir, "divergence_events.csv"), index=False
        )

    if all_port:
        portfolio = pd.concat(all_port, axis=1).mean(axis=1).dropna()
        cum = (1 + portfolio).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(portfolio.mean() / portfolio.std() * np.sqrt(252)) if portfolio.std() > 0 else None
    else:
        sharpe = None

    avg_premium = float(np.mean([r["premium_pct"] for r in premium_records])) if premium_records else None
    summary = {
        "n_pairs": len(all_port),
        "avg_adr_premium_pct": avg_premium,
        "n_divergence_events": len(divergence_events),
        "sharpe": sharpe,
        "params": {"entry_premium_pct": ENTRY_PREMIUM_PCT, "zscore_window": ZSCORE_WINDOW}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"NSE ADR Pairs | {len(all_port)} pairs | Avg premium: {avg_premium:.2f if avg_premium else 'N/A'}% | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nse", required=True, dest="nse_file")
    ap.add_argument("--adr", required=True, dest="adr_file")
    ap.add_argument("--usdinr", required=True, dest="usdinr_file")
    ap.add_argument("--outdir", default="./artifacts/nse_adr_pairs")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
