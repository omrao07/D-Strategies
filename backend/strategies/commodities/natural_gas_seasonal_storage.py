#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
natural_gas_seasonal_storage.py — Natural gas storage vs seasonal norm predicts price
======================================================================================
EIA weekly natural gas storage reports (injection season Apr-Oct, withdrawal Nov-Mar).
Storage above 5-year average → bearish; below → bullish. Combined with seasonal
demand patterns and weather-degree-day forecasts.

Inputs (CSV)
------------
--storage  ng_storage.csv
    Columns: date, storage_bcf, yoy_pct, vs_5yr_avg_pct, vs_5yr_avg_bcf,
             region (total/east/midwest/mountain/pacific/south_central)
--prices   ng_prices.csv
    Columns: date, price_mmbtu

Outputs
-------
outdir/storage_signals.csv      date, storage_bcf, surplus_deficit_bcf, season, signal
outdir/seasonal_analysis.csv    historical price return by storage quintile and season
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def get_season(month: int) -> str:
    if month in [11, 12, 1, 2]:
        return "winter_peak"
    elif month in [3, 4]:
        return "shoulder_spring"
    elif month in [5, 6, 7, 8, 9]:
        return "injection_summer"
    return "shoulder_fall"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    storage = pd.read_csv(cfg.storage_file, parse_dates=["date"])
    storage.columns = [c.lower().strip() for c in storage.columns]
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]
    prices = prices.set_index("date").sort_index()

    # Use total only
    if "region" in storage.columns:
        storage = storage[storage["region"].str.lower().isin(["total", ""])]

    storage = storage.sort_values("date").set_index("date")
    storage["season"] = storage.index.month.map(get_season)

    vs_col = "vs_5yr_avg_pct" if "vs_5yr_avg_pct" in storage.columns else None
    vs_bcf_col = "vs_5yr_avg_bcf" if "vs_5yr_avg_bcf" in storage.columns else None
    storage_col = "storage_bcf" if "storage_bcf" in storage.columns else storage.columns[0]

    # Compute surplus/deficit if not available
    if vs_col is None:
        storage["rolling_5yr"] = storage[storage_col].shift(52).rolling(5 * 52, min_periods=52).mean()
        storage["vs_5yr_avg_pct"] = (storage[storage_col] / storage["rolling_5yr"] - 1) * 100
        vs_col = "vs_5yr_avg_pct"

    price_col = "price_mmbtu" if "price_mmbtu" in prices.columns else prices.columns[0]
    ng_price = prices[price_col]
    ng_ret = ng_price.pct_change().dropna()

    signal_records = []
    for date, row in storage.iterrows():
        vs_avg = row.get(vs_col, np.nan)
        season = row["season"]
        storage_bcf = row.get(storage_col, np.nan)

        # Signal: bearish if storage well above avg, especially heading into winter
        if np.isnan(vs_avg):
            signal = "neutral"
        elif vs_avg > cfg.surplus_pct and season == "shoulder_fall":
            signal = "sell_strong"   # Full storage going into winter → bearish
        elif vs_avg > cfg.surplus_pct:
            signal = "sell"
        elif vs_avg < -cfg.deficit_pct and season in ("winter_peak", "shoulder_spring"):
            signal = "buy_strong"   # Low storage in winter → bullish spike risk
        elif vs_avg < -cfg.deficit_pct:
            signal = "buy"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date, "storage_bcf": float(storage_bcf) if not np.isnan(storage_bcf) else None,
            "vs_5yr_avg_pct": float(vs_avg) if not np.isnan(vs_avg) else None,
            "season": season, "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "storage_signals.csv"), index=False)

    # Seasonal analysis: NG return by storage quintile × season
    seasonal_records = []
    vs_series = sig_df.set_index("date")["vs_5yr_avg_pct"].dropna()
    quintiles = pd.qcut(vs_series, q=5, labels=["Q1_surplus", "Q2", "Q3", "Q4", "Q5_deficit"])
    for q in quintiles.unique():
        for season in ["winter_peak", "injection_summer", "shoulder_fall", "shoulder_spring"]:
            mask_q = quintiles == q
            mask_s = sig_df.set_index("date").reindex(vs_series.index)["season"] == season
            dates_in = vs_series[mask_q & mask_s].index
            ret_in = ng_ret.reindex(dates_in).dropna()
            if len(ret_in) > 5:
                seasonal_records.append({"quintile": str(q), "season": season,
                                          "avg_weekly_ret": float(ret_in.mean()),
                                          "ann_ret": float(ret_in.mean() * 52), "n": len(ret_in)})
    if seasonal_records:
        pd.DataFrame(seasonal_records).to_csv(os.path.join(cfg.outdir, "seasonal_analysis.csv"), index=False)

    # Backtest
    SIG_POS = {"buy_strong": 2, "buy": 1, "neutral": 0, "sell": -1, "sell_strong": -2}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    pos_daily = pos.reindex(ng_ret.index, method="ffill").shift(1).fillna(0)
    strat = pos_daily * ng_ret
    cum = (1 + strat.dropna()).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
    sharpe = float(strat.dropna().mean() / strat.dropna().std() * np.sqrt(252)) if strat.dropna().std() > 0 else None

    current_vs = float(sig_df["vs_5yr_avg_pct"].dropna().iloc[-1]) if not sig_df.empty else None
    summary = {
        "current_vs_5yr_avg_pct": current_vs, "current_season": str(sig_df["season"].iloc[-1]) if not sig_df.empty else None,
        "current_signal": str(sig_df["signal"].iloc[-1]) if not sig_df.empty else None,
        "n_buy_signals": int((sig_df["signal"].isin(["buy", "buy_strong"])).sum()) if not sig_df.empty else 0,
        "n_sell_signals": int((sig_df["signal"].isin(["sell", "sell_strong"])).sum()) if not sig_df.empty else 0,
        "ann_return": float(strat.dropna().mean() * 252), "sharpe": sharpe,
        "params": {"surplus_pct": cfg.surplus_pct, "deficit_pct": cfg.deficit_pct}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"NatGas storage | vs 5yr avg: {current_vs:.1f}% | Season: {summary['current_season']} | Signal: {summary['current_signal']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--storage", required=True, dest="storage_file")
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--surplus-pct", type=float, default=10.0)
    ap.add_argument("--deficit-pct", type=float, default=10.0)
    ap.add_argument("--outdir", default="./artifacts/ng_storage")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
