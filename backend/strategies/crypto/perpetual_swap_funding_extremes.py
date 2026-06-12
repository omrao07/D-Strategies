#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
perpetual_swap_funding_extremes.py — Extreme funding rates predict reversal
============================================================================
Perpetual swap funding rates reflect the market's directional bias. When funding
is extremely positive (longs paying shorts), the market is over-levered long →
short squeeze risk. Extreme negative funding → over-levered short → short squeeze.

Inputs (CSV)
------------
--funding  funding_rates.csv
    Columns: date, asset, exchange, funding_rate_8h, open_interest_usd
--prices   crypto_prices.csv
    Columns: date, ticker, price

Outputs
-------
outdir/funding_signals.csv      date, asset, funding_ann_pct, funding_zscore, signal
outdir/funding_vs_returns.csv   funding extreme vs next-period return
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd
from scipy import stats


def annualize_funding(rate_8h: float) -> float:
    """8-hour funding rate → annualized %."""
    return rate_8h * 3 * 365 * 100


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    funding = pd.read_csv(cfg.funding_file, parse_dates=["date"])
    funding.columns = [c.lower().strip() for c in funding.columns]
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]
    price_wide = prices.pivot(index="date", columns="ticker", values="price").sort_index()

    # OI-weighted average funding per asset per date
    if "open_interest_usd" in funding.columns:
        def oi_weighted_funding(g):
            oi = g["open_interest_usd"].fillna(1)
            return (g["funding_rate_8h"] * oi).sum() / oi.sum()
        agg = funding.groupby(["date", "asset"]).apply(oi_weighted_funding).reset_index(name="funding_rate_8h")
    else:
        agg = funding.groupby(["date", "asset"])["funding_rate_8h"].mean().reset_index()

    agg["funding_ann_pct"] = agg["funding_rate_8h"].apply(annualize_funding)

    signal_records = []
    corr_records = []
    all_daily = []

    for asset in agg["asset"].unique():
        sub = agg[agg["asset"] == asset].set_index("date").sort_index()
        if len(sub) < 20:
            continue

        sub["funding_ma7"] = sub["funding_ann_pct"].rolling(7).mean()
        sub["funding_zscore"] = (sub["funding_ann_pct"] - sub["funding_ann_pct"].rolling(30).mean()) / \
                                  sub["funding_ann_pct"].rolling(30).std().replace(0, np.nan)
        sub["funding_extreme"] = sub["funding_zscore"].abs() > cfg.extreme_zscore

        price_ticker = asset.upper()
        has_price = price_ticker in price_wide.columns

        for date, row in sub.iterrows():
            z = row.get("funding_zscore", np.nan)
            f_ann = row["funding_ann_pct"]
            if np.isnan(z):
                signal = "neutral"
            elif z > cfg.extreme_zscore:
                signal = "contrarian_short"  # over-levered longs → fade
            elif z < -cfg.extreme_zscore:
                signal = "contrarian_long"   # over-levered shorts → fade
            elif z > cfg.moderate_zscore:
                signal = "soft_short"
            elif z < -cfg.moderate_zscore:
                signal = "soft_long"
            else:
                signal = "neutral"

            signal_records.append({
                "date": date, "asset": asset,
                "funding_rate_8h": float(row["funding_rate_8h"]),
                "funding_ann_pct": float(f_ann),
                "funding_zscore": float(z) if not np.isnan(z) else None,
                "signal": signal
            })

        if not has_price:
            continue

        ret = price_wide[price_ticker].pct_change().dropna()

        # Correlation: funding z-score vs 1/3-day forward return (contrarian)
        for horizon in [1, 3]:
            fwd = ret.rolling(horizon).sum().shift(-horizon)
            f_z = sub["funding_zscore"].reindex(ret.index).ffill().dropna()
            aligned = f_z.align(fwd.dropna(), join="inner")
            if len(aligned[0]) > 20:
                r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
                corr_records.append({"asset": asset, "horizon_days": horizon,
                                      "funding_vs_fwd_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

        # Backtest: contrarian on funding extremes
        pos = sub["funding_zscore"].apply(
            lambda z: -1 if z > cfg.extreme_zscore else (1 if z < -cfg.extreme_zscore else 0)
        )
        pos_daily = pos.reindex(ret.index).ffill().shift(1)
        strat = pos_daily * ret
        all_daily.append(strat.rename(asset))

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "funding_signals.csv"), index=False)

    corr_df = pd.DataFrame(corr_records) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "funding_vs_returns.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(365)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 365)
    else:
        sharpe, ann_ret = None, None

    avg_funding = float(sig_df["funding_ann_pct"].mean()) if not sig_df.empty else None
    summary = {
        "n_assets": agg["asset"].nunique(), "n_signals": len(sig_df),
        "n_contrarian_short": int((sig_df["signal"] == "contrarian_short").sum()) if not sig_df.empty else 0,
        "n_contrarian_long": int((sig_df["signal"] == "contrarian_long").sum()) if not sig_df.empty else 0,
        "avg_funding_ann_pct": avg_funding,
        "avg_1d_corr": float(corr_df[corr_df["horizon_days"] == 1]["funding_vs_fwd_corr"].mean()) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"extreme_zscore": cfg.extreme_zscore, "moderate_zscore": cfg.moderate_zscore}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Perp funding | Assets: {summary['n_assets']} | Contrarian short: {summary['n_contrarian_short']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--funding", required=True, dest="funding_file")
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--extreme-zscore", type=float, default=2.5)
    ap.add_argument("--moderate-zscore", type=float, default=1.5)
    ap.add_argument("--outdir", default="./artifacts/perp_funding")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
