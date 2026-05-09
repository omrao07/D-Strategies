#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
current_account_divergence.py — CA divergence drives FX and equity outperformance
====================================================================================
Countries with improving current account balances see FX appreciation and equity
outperformance. CA surplus countries (Germany, Japan, Korea) → defensive during
global recessions. CA deficit countries → underperform when capital flows reverse.

Inputs (CSV)
------------
--ca       current_account.csv
    Columns: date, country, ca_pct_gdp, ca_balance_usd_bn, trade_balance_usd_bn
--fx       fx_rates.csv
    Columns: date, pair (e.g., EURUSD), rate
--assets   asset_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/ca_signals.csv           date, country, ca_pct_gdp, ca_trend, signal
outdir/ca_vs_fx.csv             CA trend vs FX return correlation
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


COUNTRY_TICKER_MAP = {
    "germany": "EWG", "japan": "EWJ", "korea": "EWY", "china": "MCHI",
    "us": "SPY", "uk": "EWU", "france": "EWQ", "australia": "EWA",
    "india": "INDA", "brazil": "EWZ", "canada": "EWC", "switzerland": "EWL"
}

COUNTRY_FX_MAP = {
    "germany": "EURUSD", "france": "EURUSD", "japan": "USDJPY",
    "uk": "GBPUSD", "australia": "AUDUSD", "korea": "USDKRW",
    "india": "USDINR", "brazil": "USDBRL", "canada": "USDCAD"
}


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    ca = pd.read_csv(cfg.ca_file, parse_dates=["date"])
    ca.columns = [c.lower().strip() for c in ca.columns]
    fx = pd.read_csv(cfg.fx_file, parse_dates=["date"])
    fx.columns = [c.lower().strip() for c in fx.columns]
    fx_wide = fx.pivot(index="date", columns="pair", values="rate").sort_index()
    assets = pd.read_csv(cfg.assets_file, parse_dates=["date"])
    assets.columns = [c.lower().strip() for c in assets.columns]
    ret_wide = assets.pivot(index="date", columns="ticker", values="return").sort_index()

    ca_records = []
    corr_records = []
    all_daily = []

    for country in ca["country"].unique():
        sub = ca[ca["country"] == country].set_index("date").sort_index()
        if len(sub) < 8:
            continue

        sub["ca_trend_4q"] = sub["ca_pct_gdp"].diff(4)
        sub["ca_acceleration"] = sub["ca_trend_4q"] - sub["ca_trend_4q"].shift(2)
        sub["ca_zscore"] = (sub["ca_pct_gdp"] - sub["ca_pct_gdp"].rolling(16, min_periods=4).mean()) / \
                            sub["ca_pct_gdp"].rolling(16, min_periods=4).std().replace(0, np.nan)

        ticker = COUNTRY_TICKER_MAP.get(country.lower())
        fx_pair = COUNTRY_FX_MAP.get(country.lower())

        for date, row in sub.iterrows():
            trend = row.get("ca_trend_4q", np.nan) or 0
            z = row.get("ca_zscore", np.nan)
            signal = "overweight" if (not np.isnan(z) and z > 1 and trend > 0) else \
                     ("underweight" if (not np.isnan(z) and z < -1 and trend < 0) else "neutral")
            ca_records.append({
                "date": date, "country": country,
                "ca_pct_gdp": float(row.get("ca_pct_gdp", np.nan)),
                "ca_trend_4q": float(trend) if not np.isnan(trend) else None,
                "ca_acceleration": float(row.get("ca_acceleration", np.nan)) if not np.isnan(row.get("ca_acceleration", np.nan)) else None,
                "ca_zscore": float(z) if not np.isnan(z) else None,
                "signal": signal
            })

        # Correlation with FX appreciation
        if fx_pair and fx_pair in fx_wide.columns:
            fx_ret = fx_wide[fx_pair].pct_change().dropna()
            ca_z_daily = sub["ca_zscore"].reindex(fx_ret.index, method="ffill").dropna()
            fwd_fx = fx_ret.rolling(63).sum().shift(-63)
            aligned = ca_z_daily.align(fwd_fx.dropna(), join="inner")
            if len(aligned[0]) > 10:
                r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
                corr_records.append({"country": country, "fx_pair": fx_pair,
                                      "ca_fwd_fx_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

        # Backtest on equity ETF
        if ticker and ticker in ret_wide.columns:
            pos = sub["ca_zscore"].apply(lambda z: 1 if (not np.isnan(z) and z > 1) else (-1 if (not np.isnan(z) and z < -1) else 0))
            pos_daily = pos.reindex(ret_wide.index, method="ffill").shift(1).fillna(0)
            strat = pos_daily * ret_wide[ticker]
            all_daily.append(strat.rename(country))

    ca_df = pd.DataFrame(ca_records).sort_values("date")
    ca_df.to_csv(os.path.join(cfg.outdir, "ca_signals.csv"), index=False)

    corr_df = pd.DataFrame(corr_records).sort_values("ca_fwd_fx_corr", ascending=False) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "ca_vs_fx.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_countries": ca["country"].nunique(), "n_signals": len(ca_df),
        "n_overweight": int((ca_df["signal"] == "overweight").sum()) if not ca_df.empty else 0,
        "avg_fx_corr": float(corr_df["ca_fwd_fx_corr"].mean()) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Current account | Countries: {summary['n_countries']} | Overweight signals: {summary['n_overweight']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ca", required=True, dest="ca_file")
    ap.add_argument("--fx", required=True, dest="fx_file")
    ap.add_argument("--assets", required=True, dest="assets_file")
    ap.add_argument("--outdir", default="./artifacts/current_account")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
