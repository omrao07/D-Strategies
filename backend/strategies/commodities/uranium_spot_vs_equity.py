#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
uranium_spot_vs_equity.py — Uranium spot price vs nuclear equity premium
=========================================================================
Uranium spot price (U3O8) drives uranium mining equity (CCJ, UEC, UUUU) performance
with a 3-6 month lag as contracts are negotiated. When spot surges above long-term
contract price, utilities rush to lock in → miner upside. Physical trusts (SPUT)
provide flow-through to spot.

Inputs (CSV)
------------
--uranium  uranium_prices.csv
    Columns: date, spot_usd_lb, ltc_price_usd_lb (long-term contract), volume_mlb
--stocks   stock_returns.csv
    Columns: date, ticker, return (CCJ, UEC, UUUU, NXE, etc.)

Outputs
-------
outdir/uranium_signals.csv      date, spot, ltc, spot_premium_pct, signal
outdir/spot_vs_miners.csv       spot price vs miner return correlation
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd
from scipy import stats

URANIUM_MINER_TICKERS = ["ccj", "uec", "uuuu", "nxe", "dnn", "ura", "sput"]


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    uranium = pd.read_csv(cfg.uranium_file, parse_dates=["date"])
    uranium.columns = [c.lower().strip() for c in uranium.columns]
    uranium = uranium.set_index("date").sort_index()
    stocks = pd.read_csv(cfg.stocks_file, parse_dates=["date"])
    stocks.columns = [c.lower().strip() for c in stocks.columns]
    ret_wide = stocks.pivot(index="date", columns="ticker", values="return").sort_index()

    spot_col = "spot_usd_lb" if "spot_usd_lb" in uranium.columns else uranium.columns[0]
    ltc_col = "ltc_price_usd_lb" if "ltc_price_usd_lb" in uranium.columns else None

    uranium["spot_yoy_pct"] = uranium[spot_col].pct_change(52) * 100
    uranium["spot_mom_pct"] = uranium[spot_col].pct_change(4) * 100
    uranium["spot_zscore"] = (uranium[spot_col] - uranium[spot_col].rolling(104, min_periods=26).mean()) / \
                              uranium[spot_col].rolling(104, min_periods=26).std().replace(0, np.nan)

    if ltc_col:
        uranium["spot_premium_pct"] = (uranium[spot_col] / uranium[ltc_col].replace(0, np.nan) - 1) * 100
    else:
        uranium["spot_premium_pct"] = np.nan  # can't compute without LTC

    signal_records = []
    for date, row in uranium.iterrows():
        spot = row.get(spot_col, np.nan)
        z = row.get("spot_zscore", np.nan)
        prem = row.get("spot_premium_pct", np.nan)
        yoy = row.get("spot_yoy_pct", np.nan)
        mom = row.get("spot_mom_pct", np.nan)

        if not np.isnan(z):
            if z > cfg.zscore_threshold and (not np.isnan(mom) and mom > 0):
                signal = "buy_miners"
            elif z > 1.0:
                signal = "mild_buy"
            elif z < -cfg.zscore_threshold:
                signal = "sell_miners"
            else:
                signal = "neutral"
        else:
            signal = "neutral"

        # Premium signal: spot >> LTC → utilities need to buy more in spot → bullish
        if not np.isnan(prem) and prem > cfg.premium_threshold:
            signal = "strong_buy" if signal in ("buy_miners", "mild_buy") else "buy_miners"

        signal_records.append({
            "date": date, "spot_usd_lb": float(spot) if not np.isnan(spot) else None,
            "ltc_price_usd_lb": float(row.get(ltc_col, np.nan)) if ltc_col and not np.isnan(row.get(ltc_col, np.nan)) else None,
            "spot_premium_pct": float(prem) if not np.isnan(prem) else None,
            "spot_zscore": float(z) if not np.isnan(z) else None,
            "spot_yoy_pct": float(yoy) if not np.isnan(yoy) else None,
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "uranium_signals.csv"), index=False)

    # Correlation: uranium spot vs miner returns (with lag)
    uranium_ret = uranium[spot_col].pct_change().dropna()
    corr_records = []
    for ticker in ret_wide.columns:
        if any(m in ticker.lower() for m in URANIUM_MINER_TICKERS):
            for lag_weeks in [4, 12, 24]:
                fwd_miner = ret_wide[ticker].rolling(lag_weeks * 5).sum().shift(-lag_weeks * 5)
                ur_weekly = uranium_ret.resample("W").sum()
                ur_daily = ur_weekly.reindex(fwd_miner.index).ffill().dropna()
                aligned = ur_daily.align(fwd_miner.dropna(), join="inner")
                if len(aligned[0]) > 15:
                    r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
                    corr_records.append({"ticker": ticker, "lag_weeks": lag_weeks,
                                          "spot_miner_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

    corr_df = pd.DataFrame(corr_records) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "spot_vs_miners.csv"), index=False)

    # Backtest
    all_daily = []
    SIG_POS = {"strong_buy": 2, "buy_miners": 1, "mild_buy": 0.5, "neutral": 0, "sell_miners": -1}
    for ticker in ret_wide.columns:
        if any(m in ticker.lower() for m in URANIUM_MINER_TICKERS):
            pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
            pos_daily = pos.reindex(ret_wide.index).ffill().shift(1).fillna(0)
            strat = pos_daily * ret_wide[ticker]
            all_daily.append(strat.rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    current_spot = float(uranium[spot_col].iloc[-1]) if not uranium.empty else None
    summary = {
        "current_spot_usd_lb": current_spot,
        "current_signal": str(sig_df["signal"].iloc[-1]) if not sig_df.empty else None,
        "n_buy_signals": int((sig_df["signal"].isin(["buy_miners", "strong_buy", "mild_buy"])).sum()) if not sig_df.empty else 0,
        "avg_miner_corr_12w": float(corr_df[corr_df["lag_weeks"] == 12]["spot_miner_corr"].mean()) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"zscore_threshold": cfg.zscore_threshold, "premium_threshold": cfg.premium_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Uranium | Spot: ${current_spot:.2f}/lb | Signal: {summary['current_signal']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--uranium", required=True, dest="uranium_file")
    ap.add_argument("--stocks", required=True, dest="stocks_file")
    ap.add_argument("--zscore-threshold", type=float, default=1.5)
    ap.add_argument("--premium-threshold", type=float, default=20.0, help="Spot premium over LTC in %% to add signal")
    ap.add_argument("--outdir", default="./artifacts/uranium")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
