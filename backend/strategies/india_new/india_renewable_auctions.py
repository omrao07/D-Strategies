#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_renewable_auctions.py — India renewable energy auction pipeline vs green stocks
======================================================================================
MNRE auctions (solar, wind, hybrid) drive capex for Adani Green, Tata Power, NTPC
Renewables, Greenko. Tariff trends (₹/kWh) signal sector margins. Accelerating
auction pipeline + stable tariffs → buy green energy stocks.

Inputs (CSV)
------------
--auctions auction_data.csv
    Columns: date, capacity_gw, type (solar/wind/hybrid/storage), tariff_inr_kwh,
             developer (optional), state, status (issued/bids_received/awarded/completed)
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/renewable_signals.csv  date, pipeline_gw, avg_tariff, tariff_trend, signal
outdir/auction_summary.csv    capacity by type/status
outdir/backtest.csv           cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

GREEN_TICKERS = ["adanigreen", "tatapower", "ntpc", "greenko", "sjvn", "cesc", "torrent", "acme"]
TARIFF_DECLINE_THRESHOLD = -0.10  # ₹/kWh YoY decline → improving economics
PIPELINE_GW_HIGH = 50  # GW — strong auction pipeline
STATUS_WEIGHTS = {"issued": 0.3, "bids_received": 0.6, "awarded": 0.9, "completed": 1.0}


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    auctions = pd.read_csv(cfg.auctions_file, parse_dates=["date"])
    auctions.columns = [c.lower().strip() for c in auctions.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    cap_col = "capacity_gw" if "capacity_gw" in auctions.columns else auctions.columns[2]
    tariff_col = "tariff_inr_kwh" if "tariff_inr_kwh" in auctions.columns else None

    # Auction summary by type and status
    auction_summary = auctions.groupby(["type", "status"]).agg(
        total_gw=(cap_col, "sum"),
        count=("date", "count")
    ).reset_index() if "type" in auctions.columns and "status" in auctions.columns else pd.DataFrame()
    if not auction_summary.empty:
        auction_summary.to_csv(os.path.join(cfg.outdir, "auction_summary.csv"), index=False)

    # Weighted pipeline: capacity × status weight
    if "status" in auctions.columns:
        auctions["status_weight"] = auctions["status"].str.lower().map(STATUS_WEIGHTS).fillna(0.5)
        auctions["weighted_gw"] = auctions[cap_col] * auctions["status_weight"]
    else:
        auctions["weighted_gw"] = auctions[cap_col]

    # Build cumulative pipeline by date
    auctions_sorted = auctions.sort_values("date")
    pipeline_ts = auctions_sorted.groupby("date")["weighted_gw"].sum().cumsum()
    tariff_ts = auctions_sorted.groupby("date")[tariff_col].mean() if tariff_col else pd.Series(dtype=float)

    signal_records = []
    all_signal_dates = pipeline_ts.index
    for date in all_signal_dates:
        pipeline_gw = float(pipeline_ts.loc[date])
        avg_tariff = float(tariff_ts.loc[date]) if date in tariff_ts.index else np.nan

        # Tariff trend: compare last 12M average
        past_12m = tariff_ts[tariff_ts.index <= date].tail(12)
        tariff_trend = float((past_12m.iloc[-1] - past_12m.iloc[0]) / past_12m.iloc[0]) if len(past_12m) > 1 and past_12m.iloc[0] != 0 else np.nan

        # New capacity added in last 12M
        pipeline_12m_ago = float(pipeline_ts[pipeline_ts.index <= date - pd.DateOffset(months=12)].iloc[-1]) if len(pipeline_ts[pipeline_ts.index <= date - pd.DateOffset(months=12)]) > 0 else 0
        pipeline_add_12m = pipeline_gw - pipeline_12m_ago

        if pipeline_gw > PIPELINE_GW_HIGH and (np.isnan(tariff_trend) or tariff_trend < 0):
            signal = "strong_buy_green"
        elif pipeline_gw > PIPELINE_GW_HIGH * 0.5 and pipeline_add_12m > 5:
            signal = "buy_green"
        elif pipeline_add_12m > 2:
            signal = "mild_buy_green"
        elif pipeline_add_12m < 0:
            signal = "sell_green"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date,
            "cumulative_pipeline_gw": pipeline_gw,
            "pipeline_added_12m_gw": float(pipeline_add_12m),
            "avg_tariff_inr_kwh": float(avg_tariff) if not np.isnan(avg_tariff) else None,
            "tariff_yoy_change": float(tariff_trend) if not np.isnan(tariff_trend) else None,
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "renewable_signals.csv"), index=False)

    # Backtest
    SIG_POS = {"strong_buy_green": 1.5, "buy_green": 1, "mild_buy_green": 0.5, "neutral": 0, "sell_green": -0.5}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for ticker in ret_wide.columns:
        if any(g in ticker.lower() for g in GREEN_TICKERS):
            pos_daily = pos.reindex(ret_wide.index).ffill().shift(1).fillna(0)
            all_daily.append((pos_daily * ret_wide[ticker]).rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    total_gw = float(auctions[cap_col].sum())
    summary = {
        "total_auction_gw": total_gw,
        "total_auctions": len(auctions),
        "solar_gw": float(auctions[auctions.get("type", pd.Series("solar")) == "solar"][cap_col].sum()) if "type" in auctions.columns else None,
        "latest_pipeline_gw": float(sig_df.iloc[-1]["cumulative_pipeline_gw"]) if not sig_df.empty else None,
        "latest_signal": str(sig_df.iloc[-1]["signal"]) if not sig_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India Renewable | Total GW: {total_gw:.1f} | Latest signal: {summary['latest_signal']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--auctions", required=True, dest="auctions_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/india_renewable")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
