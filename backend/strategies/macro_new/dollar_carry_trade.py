#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dollar_carry_trade.py — USD carry trade: borrow low-rate currencies, invest high-rate
=======================================================================================
Classic carry trade: borrow in currencies with low interest rates (JPY, CHF),
invest in high-interest rate currencies (AUD, NZD, EM). Unwind when VIX spikes
or USD strengthens sharply (carry unwind risk).

Inputs (CSV)
------------
--rates    interest_rates.csv
    Columns: date, currency, overnight_rate_pct, policy_rate_pct
--fx       fx_rates.csv
    Columns: date, pair (e.g. USDJPY), rate
--vix      vix.csv
    Columns: date, vix_close

Outputs
-------
outdir/carry_rankings.csv       date, currency, carry_vs_usd_pct, rank
outdir/portfolio_weights.csv    date, currency_pair, weight, expected_carry
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def compute_carry_return(fx_series: pd.Series, rate_diff: float) -> pd.Series:
    """
    Daily carry P&L = FX daily return + interest rate differential / 365.
    """
    fx_ret = fx_series.pct_change()
    carry_accrual = rate_diff / 100 / 365
    return fx_ret + carry_accrual


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    rates = pd.read_csv(cfg.rates_file, parse_dates=["date"])
    rates.columns = [c.lower().strip() for c in rates.columns]
    fx = pd.read_csv(cfg.fx_file, parse_dates=["date"])
    fx.columns = [c.lower().strip() for c in fx.columns]
    vix = pd.read_csv(cfg.vix_file, parse_dates=["date"])
    vix.columns = [c.lower().strip() for c in vix.columns]
    vix = vix.set_index("date")["vix_close"].sort_index()

    fx_wide = fx.pivot(index="date", columns="pair", values="rate").sort_index()
    rates_wide = rates.pivot(index="date", columns="currency", values="policy_rate_pct").sort_index()

    # Get USD rate
    usd_rate = rates_wide.get("USD", rates_wide.get("usd", pd.Series(5.0, index=rates_wide.index)))

    rank_records = []
    carry_returns = {}

    for currency in rates_wide.columns:
        if currency.upper() == "USD":
            continue
        rate_series = rates_wide[currency].reindex(fx_wide.index).ffill()
        usd_rate_series = usd_rate.reindex(fx_wide.index).ffill()
        carry_diff = rate_series - usd_rate_series  # positive = higher than USD → invest here

        # Find corresponding FX pair
        pair_options = [f"{currency}USD", f"USD{currency}", currency.upper() + "USD", "USD" + currency.upper()]
        fx_pair = None
        for p in pair_options:
            if p in fx_wide.columns:
                fx_pair = p
                break

        for date in rates_wide.index:
            if date in rate_series.index:
                carry_records_entry = {
                    "date": date, "currency": currency,
                    "policy_rate_pct": float(rate_series.loc[date]) if not np.isnan(rate_series.loc[date]) else None,
                    "carry_vs_usd_pct": float(carry_diff.loc[date]) if date in carry_diff.index and not np.isnan(carry_diff.loc[date]) else None
                }
                rank_records.append(carry_records_entry)

        if fx_pair is None:
            continue

        fx_series = fx_wide[fx_pair].dropna()
        carry_ret = compute_carry_return(fx_series, carry_diff.reindex(fx_series.index).ffill().fillna(0))
        carry_returns[currency] = carry_ret

    rank_df = pd.DataFrame(rank_records).dropna(subset=["carry_vs_usd_pct"])
    rank_df["rank"] = rank_df.groupby("date")["carry_vs_usd_pct"].rank(ascending=False)
    rank_df.sort_values(["date", "rank"]).to_csv(os.path.join(cfg.outdir, "carry_rankings.csv"), index=False)

    if not carry_returns:
        print("No FX pairs found. Check --fx input.")
        return

    # Portfolio: long top N carry, short bottom N carry
    carry_df = pd.DataFrame(carry_returns)
    n_long = min(cfg.n_long, len(carry_df.columns) // 2)

    vix_daily = vix.reindex(carry_df.index).ffill()
    vix_high = vix_daily > cfg.vix_unwind_threshold

    portfolio_daily = []
    weight_records = []
    for date in carry_df.index:
        if vix_high.get(date, False):
            # Carry unwind: flatten
            portfolio_daily.append(0.0)
            continue

        day_carry = carry_df.loc[date].dropna().sort_values(ascending=False)
        longs = day_carry.head(n_long)
        shorts = day_carry.tail(n_long)
        day_ret = longs.mean() - shorts.mean()
        portfolio_daily.append(float(day_ret))

        for cur, w in {**{c: 1 / n_long for c in longs.index}, **{c: -1 / n_long for c in shorts.index}}.items():
            weight_records.append({"date": date, "currency": cur, "weight": w,
                                   "carry_pct": float(day_carry.get(cur, np.nan))})

    port = pd.Series(portfolio_daily, index=carry_df.index).dropna()
    cum = (1 + port).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    pd.DataFrame(weight_records).sort_values(["date", "weight"], ascending=[True, False]).to_csv(
        os.path.join(cfg.outdir, "portfolio_weights.csv"), index=False)

    sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
    summary = {
        "currencies_analyzed": len(carry_returns), "n_long_positions": n_long,
        "avg_daily_carry": float(port.mean()),
        "ann_carry_return": float(port.mean() * 252),
        "sharpe": sharpe,
        "pct_days_in_unwind": float(vix_high.mean()),
        "params": {"n_long": cfg.n_long, "vix_unwind_threshold": cfg.vix_unwind_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Dollar carry | Currencies: {summary['currencies_analyzed']} | Ann carry: {summary['ann_carry_return']:.2%} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rates", required=True, dest="rates_file")
    ap.add_argument("--fx", required=True, dest="fx_file")
    ap.add_argument("--vix", required=True, dest="vix_file")
    ap.add_argument("--n-long", type=int, default=3, help="Number of long (and short) currency positions")
    ap.add_argument("--vix-unwind-threshold", type=float, default=30.0)
    ap.add_argument("--outdir", default="./artifacts/dollar_carry")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
