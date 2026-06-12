#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nifty_etf_futures_arb.py — NIFTY ETF vs Futures basis arbitrage
================================================================
Tracks the spread between NIFTYBEES (ETF) and NIFTY50 futures (near-month).
The ETF should trade at NAV; persistent discounts/premiums vs futures basis
create arbitrage opportunities. Also captures roll-yield on monthly futures.

India moat: NSE F&O settlement creates predictable basis compression at
expiry. ETF creation/redemption friction creates dislocation windows of
20-50 bps, far larger than US ETF arb windows (~1-2 bps).

Inputs (CSV)
------------
--etf       etf.csv         date, etf_close, etf_volume, etf_nav (optional)
--futures   futures.csv     date, fut_close, expiry_date, days_to_expiry
--nifty     nifty.csv       date, nifty_close (underlying spot)

Outputs
-------
outdir/basis.csv             date, basis_pct, carry_pct, signal, z_score
outdir/roll_yield.csv        expiry, roll_yield_pct, hold_pct
outdir/backtest.csv          cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

# Basis thresholds (ETF premium/discount to implied fair value)
BASIS_ENTRY_BPS = 15     # Enter arb when basis > 15 bps
BASIS_EXIT_BPS = 5       # Exit when basis < 5 bps
CARRY_WINDOW = 20        # Days for rolling carry estimation
ZSCORE_WINDOW = 30       # Days for z-score normalization
RISK_FREE_RATE = 0.065   # India 91-day T-bill rate (annualised)


def compute_fair_value(spot: float, rate: float, dte: float) -> float:
    """Cost-of-carry fair value for futures."""
    return spot * np.exp(rate * dte / 365)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    etf = pd.read_csv(cfg.etf_file, parse_dates=["date"]).set_index("date").sort_index()
    etf.columns = [c.lower().strip() for c in etf.columns]
    fut = pd.read_csv(cfg.futures_file, parse_dates=["date", "expiry_date"]).set_index("date").sort_index()
    fut.columns = [c.lower().strip() for c in fut.columns]
    nifty = pd.read_csv(cfg.nifty_file, parse_dates=["date"]).set_index("date").sort_index()
    nifty.columns = [c.lower().strip() for c in nifty.columns]
    nifty_col = [c for c in nifty.columns if "nifty" in c or "close" in c][0]

    merged = etf[["etf_close"]].join(
        fut[["fut_close", "days_to_expiry"]], how="inner"
    ).join(nifty[[nifty_col]].rename(columns={nifty_col: "spot"}), how="inner").dropna()

    # Theoretical fair value and basis
    merged["fair_futures"] = merged.apply(
        lambda r: compute_fair_value(r["spot"], RISK_FREE_RATE, r["days_to_expiry"]), axis=1
    )
    merged["basis_pct"] = (merged["fut_close"] / merged["fair_futures"] - 1) * 100
    merged["etf_discount"] = (merged["etf_close"] / merged["spot"] - 1) * 100  # ETF vs spot
    merged["arb_spread"] = merged["basis_pct"] - merged["etf_discount"]  # Net arb opportunity

    # Rolling z-score of arb spread
    mu = merged["arb_spread"].rolling(ZSCORE_WINDOW).mean()
    sigma = merged["arb_spread"].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
    merged["z_score"] = (merged["arb_spread"] - mu) / sigma

    # Carry: futures premium decays linearly toward expiry
    merged["implied_carry_pct"] = merged["basis_pct"] / merged["days_to_expiry"].replace(0, 1) * 365

    # Signal generation
    entry_threshold_pct = BASIS_ENTRY_BPS / 100

    records = []
    for dt, row in merged.iterrows():
        spread = row["arb_spread"]
        z = row["z_score"]
        dte = row["days_to_expiry"]

        # Positive spread: futures rich → sell futures, buy ETF
        # Negative spread: futures cheap → buy futures, sell ETF
        if abs(spread) > entry_threshold_pct and not np.isnan(z):
            signal = "sell_futures_buy_etf" if spread > 0 else "buy_futures_sell_etf"
            strength = min(abs(z) / 2.0, 1.0)
        else:
            signal = "neutral"
            strength = 0.0

        # Close arb near expiry (within 2 days)
        if dte <= 2:
            signal = "close_near_expiry"

        records.append({
            "date": dt,
            "spot": float(row["spot"]),
            "etf_close": float(row["etf_close"]),
            "fut_close": float(row["fut_close"]),
            "basis_pct": float(row["basis_pct"]),
            "etf_discount_pct": float(row["etf_discount"]),
            "arb_spread_pct": float(spread),
            "z_score": float(z) if not np.isnan(z) else None,
            "days_to_expiry": int(dte),
            "signal": signal,
            "strength": float(strength),
        })

    basis_df = pd.DataFrame(records)
    basis_df.to_csv(os.path.join(cfg.outdir, "basis.csv"), index=False)

    # Backtest: capture arb spread when signal active
    sig_map = {"sell_futures_buy_etf": -1, "buy_futures_sell_etf": 1, "neutral": 0, "close_near_expiry": 0}
    pos = basis_df.set_index("date")["signal"].map(sig_map).fillna(0)
    merged["spot"].pct_change()
    futures_ret = merged["fut_close"].pct_change()
    etf_ret = merged["etf_close"].pct_change()

    # P&L: arb leg = -futures + ETF (or reverse)
    arb_ret = pos.shift(1) * (etf_ret - futures_ret)
    arb_ret = arb_ret.dropna()
    cum = (1 + arb_ret).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    # Roll yield analysis
    roll_records = []
    expiry_groups = merged.groupby(merged.index.to_period("M"))
    for period, grp in expiry_groups:
        if len(grp) < 5:
            continue
        roll_yield = float(grp["basis_pct"].iloc[-1] - grp["basis_pct"].iloc[0])
        roll_records.append({"period": str(period), "roll_yield_pct": roll_yield,
                              "avg_basis_pct": float(grp["basis_pct"].mean())})
    pd.DataFrame(roll_records).to_csv(os.path.join(cfg.outdir, "roll_yield.csv"), index=False)

    sharpe = float(arb_ret.mean() / arb_ret.std() * np.sqrt(252)) if arb_ret.std() > 0 else None
    summary = {
        "avg_basis_pct": float(merged["basis_pct"].mean()),
        "avg_etf_discount_pct": float(merged["etf_discount"].mean()),
        "n_arb_days": int((basis_df["signal"] != "neutral").sum()),
        "ann_return": float(arb_ret.mean() * 252),
        "sharpe": sharpe,
        "params": {"entry_bps": BASIS_ENTRY_BPS, "exit_bps": BASIS_EXIT_BPS}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"NIFTY ETF Arb | Avg basis: {summary['avg_basis_pct']:.3f}% | Arb days: {summary['n_arb_days']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--etf", required=True, dest="etf_file")
    ap.add_argument("--futures", required=True, dest="futures_file")
    ap.add_argument("--nifty", required=True, dest="nifty_file")
    ap.add_argument("--outdir", default="./artifacts/nifty_etf_arb")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
