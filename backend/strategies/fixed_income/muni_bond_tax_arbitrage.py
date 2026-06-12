#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
muni_bond_tax_arbitrage.py — Muni bond tax-equivalent yield vs Treasury arb
==============================================================================
Municipal bonds are tax-exempt. Tax-equivalent yield (TEY) = muni yield / (1 - tax rate).
When TEY exceeds Treasury yield by > 50bp → munis are cheap on tax-adjusted basis → buy.
Strategy also exploits muni/Treasury spread cycles and state-specific credit risks.

Inputs (CSV)
------------
--munis    muni_yields.csv
    Columns: date, state, maturity_yr, muni_yield_pct, rating, sector
--treasury treasury_yields.csv
    Columns: date, y5, y10, y30
--tax      tax_rates.csv (optional)
    Columns: date, marginal_rate_pct (federal + state)

Outputs
-------
outdir/muni_tey.csv             date, state, maturity, tey_pct, treasury_yield, spread_bp, signal
outdir/state_rankings.csv       state-level opportunity ranking
outdir/backtest.csv             cumulative simulated P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

DEFAULT_TAX_RATE = 0.37  # Top federal rate


def compute_tey(muni_yield: float, tax_rate: float) -> float:
    """Tax-equivalent yield: muni rate that equals taxable yield after tax."""
    return muni_yield / (1 - tax_rate)


def get_treasury_yield(row: pd.Series, treasury: pd.DataFrame, date) -> float:
    maturity = row.get("maturity_yr", 10)
    tsy = treasury.ffill().loc[:date].iloc[-1] if date in treasury.index or len(treasury) > 0 else pd.Series()
    if maturity <= 7:
        return float(tsy.get("y5", np.nan))
    elif maturity <= 15:
        return float(tsy.get("y10", np.nan))
    return float(tsy.get("y30", np.nan))


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    munis = pd.read_csv(cfg.munis_file, parse_dates=["date"])
    munis.columns = [c.lower().strip() for c in munis.columns]
    treasury = pd.read_csv(cfg.treasury_file, parse_dates=["date"])
    treasury.columns = [c.lower().strip() for c in treasury.columns]
    treasury = treasury.set_index("date").sort_index()

    tax_rate = DEFAULT_TAX_RATE
    if cfg.tax_file:
        tax_df = pd.read_csv(cfg.tax_file, parse_dates=["date"])
        tax_df.columns = [c.lower().strip() for c in tax_df.columns]
        tax_rate = float(tax_df["marginal_rate_pct"].mean()) / 100

    signal_records = []
    all_daily = []

    for state in munis["state"].unique():
        sub = munis[munis["state"] == state].set_index("date").sort_index()
        if len(sub) < 4:
            continue

        for date, row in sub.iterrows():
            muni_yield = row.get("muni_yield_pct", np.nan)
            if np.isnan(muni_yield):
                continue

            tey = compute_tey(muni_yield, tax_rate)
            tsy_yield = get_treasury_yield(row, treasury, date)
            spread_bp = (tey - tsy_yield) * 100 if not np.isnan(tsy_yield) else np.nan

            signal = "buy" if (not np.isnan(spread_bp) and spread_bp > cfg.min_spread_bp) else \
                     ("sell" if (not np.isnan(spread_bp) and spread_bp < -cfg.min_spread_bp) else "neutral")

            signal_records.append({
                "date": date, "state": state,
                "maturity_yr": int(row.get("maturity_yr", 10)),
                "rating": str(row.get("rating", "AA")),
                "muni_yield_pct": float(muni_yield),
                "tey_pct": float(tey), "treasury_yield_pct": float(tsy_yield) if not np.isnan(tsy_yield) else None,
                "spread_bp": float(spread_bp) if not np.isnan(spread_bp) else None,
                "tax_rate_used": float(tax_rate), "signal": signal
            })

        # Return proxy: spread change × duration
        spread_series = pd.Series({r["date"]: r.get("spread_bp", 0) for r in signal_records if r["state"] == state}, dtype=float)
        spread_chg = spread_series.diff().dropna()
        duration = 7.0  # proxy 10Y muni duration
        price_ret = -spread_chg / 10000 * duration
        sig = pd.Series({r["date"]: r["signal"] for r in signal_records if r["state"] == state}, dtype=str)
        pos = sig.map({"buy": 1, "sell": -1, "neutral": 0}).fillna(0)
        strat = pos.shift(1) * price_ret.reindex(pos.index).fillna(0)
        all_daily.append(strat.rename(state))

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "muni_tey.csv"), index=False)

    # State rankings (latest)
    latest = sig_df.groupby("state").last().sort_values("spread_bp", ascending=False).reset_index()
    latest.to_csv(os.path.join(cfg.outdir, "state_rankings.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    avg_spread = float(sig_df["spread_bp"].dropna().mean()) if not sig_df.empty else None
    summary = {
        "n_states": munis["state"].nunique(), "n_signals": len(sig_df),
        "n_buy": int((sig_df["signal"] == "buy").sum()) if not sig_df.empty else 0,
        "avg_tey_spread_bp": avg_spread,
        "tax_rate_used": float(tax_rate),
        "top_state": str(latest["state"].iloc[0]) if not latest.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"min_spread_bp": cfg.min_spread_bp}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Muni arb | States: {summary['n_states']} | Buy signals: {summary['n_buy']} | Avg TEY spread: {avg_spread:.1f}bp | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--munis", required=True, dest="munis_file")
    ap.add_argument("--treasury", required=True, dest="treasury_file")
    ap.add_argument("--tax", default=None, dest="tax_file")
    ap.add_argument("--min-spread-bp", type=float, default=50.0)
    ap.add_argument("--outdir", default="./artifacts/muni_arb")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
