#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_auto_scrappage.py — India vehicle scrappage policy vs auto sector cycle
==============================================================================
India's vehicle scrappage policy (mandatory fitness tests for >15yr commercial,
>20yr private vehicles) creates replacement demand. Tracks scrappage registrations,
new vehicle sales, fleet age profiles. Bullish for Maruti, M&M, Tata Motors,
Eicher, Ashok Leyland. Bearish for used vehicle financiers if scrappage accelerates.

Inputs (CSV)
------------
--scrappage scrappage_data.csv
    Columns: date, vehicles_scrapped, vehicle_type (CV/PV/2W/3W), state
--sales    vehicle_sales.csv
    Columns: date, category, units_sold
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/scrappage_signals.csv  date, scrapped_units, replacement_ratio, signal
outdir/vehicle_cycle.csv      scrappage vs new sales by category
outdir/backtest.csv           cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

AUTO_TICKERS = ["maruti", "tatamotors", "mm", "eichermot", "ashokley", "bajaj", "heromotoco", "tvs"]
CV_TICKERS = ["ashokley", "eichermot", "tatamotors", "volvo"]

REPLACEMENT_RATIO_HIGH = 1.5   # scrapped/sold > 1.5 → strong replacement demand pull
SCRAPPAGE_GROWTH_HIGH = 20.0   # YoY % growth in scrappage


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    scrap = pd.read_csv(cfg.scrappage_file, parse_dates=["date"])
    scrap.columns = [c.lower().strip() for c in scrap.columns]
    sales = pd.read_csv(cfg.sales_file, parse_dates=["date"])
    sales.columns = [c.lower().strip() for c in sales.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    scrap_col = "vehicles_scrapped" if "vehicles_scrapped" in scrap.columns else scrap.columns[2]
    sales_col = "units_sold" if "units_sold" in sales.columns else sales.columns[2]

    # Aggregate monthly scrappage nationally
    scrap_nat = scrap.groupby("date")[scrap_col].sum().sort_index()
    scrap_nat_df = scrap_nat.to_frame("total_scrapped")
    scrap_nat_df["scrap_yoy_pct"] = scrap_nat_df["total_scrapped"].pct_change(12) * 100
    scrap_nat_df["scrap_zscore"] = (scrap_nat_df["total_scrapped"] - scrap_nat_df["total_scrapped"].rolling(12).mean()) / \
                                    scrap_nat_df["total_scrapped"].rolling(12).std().replace(0, np.nan)

    # Aggregate sales
    sales_nat = sales.groupby("date")[sales_col].sum().sort_index()

    # Replacement ratio: scrapped / new sales (1M lag)
    merged = scrap_nat_df.join(sales_nat.rename("new_sales"), how="outer").ffill()
    merged["replacement_ratio"] = merged["total_scrapped"] / merged["new_sales"].shift(1).replace(0, np.nan)

    # Vehicle cycle: scrappage by category vs sales
    cycle_records = []
    if "vehicle_type" in scrap.columns and "category" in sales.columns:
        for vtype in scrap["vehicle_type"].unique():
            sub_scrap = scrap[scrap["vehicle_type"] == vtype].groupby("date")[scrap_col].sum()
            sub_sales = sales[sales["category"].str.upper() == str(vtype).upper()].groupby("date")[sales_col].sum()
            if len(sub_scrap) > 6 and len(sub_sales) > 6:
                aligned = sub_scrap.align(sub_sales, join="inner")
                ratio = aligned[0] / aligned[1].replace(0, np.nan)
                cycle_records.append({
                    "vehicle_type": vtype,
                    "avg_replacement_ratio": float(ratio.mean()),
                    "trend_direction": "rising" if ratio.iloc[-1] > ratio.mean() else "falling",
                    "n_months": len(ratio)
                })

    if cycle_records:
        pd.DataFrame(cycle_records).to_csv(os.path.join(cfg.outdir, "vehicle_cycle.csv"), index=False)

    signal_records = []
    for date, row in merged.iterrows():
        scrap_val = row.get("total_scrapped", np.nan)
        scrap_yoy = row.get("scrap_yoy_pct", np.nan)
        z = row.get("scrap_zscore", np.nan)
        repl_ratio = row.get("replacement_ratio", np.nan)

        if not np.isnan(scrap_yoy) and scrap_yoy > SCRAPPAGE_GROWTH_HIGH and not np.isnan(repl_ratio) and repl_ratio > REPLACEMENT_RATIO_HIGH:
            signal = "strong_buy_auto"
        elif not np.isnan(scrap_yoy) and scrap_yoy > SCRAPPAGE_GROWTH_HIGH:
            signal = "buy_auto"
        elif not np.isnan(repl_ratio) and repl_ratio > REPLACEMENT_RATIO_HIGH:
            signal = "mild_buy_auto"
        elif not np.isnan(scrap_yoy) and scrap_yoy < 0:
            signal = "neutral"  # scrappage declining → less replacement pull
        else:
            signal = "neutral"

        signal_records.append({
            "date": date,
            "scrapped_units": int(scrap_val) if not np.isnan(scrap_val) else None,
            "scrap_yoy_pct": float(scrap_yoy) if not np.isnan(scrap_yoy) else None,
            "replacement_ratio": float(repl_ratio) if not np.isnan(repl_ratio) else None,
            "scrap_zscore": float(z) if not np.isnan(z) else None,
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "scrappage_signals.csv"), index=False)

    # Backtest on auto stocks
    SIG_POS = {"strong_buy_auto": 1.5, "buy_auto": 1, "mild_buy_auto": 0.5, "neutral": 0}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for ticker in ret_wide.columns:
        if any(a in ticker.lower() for a in AUTO_TICKERS):
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

    latest = sig_df.iloc[-1] if not sig_df.empty else {}
    summary = {
        "latest_scrapped_units": int(latest.get("scrapped_units", 0)) if latest.get("scrapped_units") else 0,
        "latest_yoy_pct": float(latest.get("scrap_yoy_pct", np.nan)) if latest.get("scrap_yoy_pct") else None,
        "latest_replacement_ratio": float(latest.get("replacement_ratio", np.nan)) if latest.get("replacement_ratio") else None,
        "latest_signal": str(latest.get("signal", "N/A")),
        "vehicle_cycle": cycle_records,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India Auto Scrappage | Scrapped: {summary['latest_scrapped_units']:,} | Replacement ratio: {format(summary['latest_replacement_ratio'], '.2f') if summary['latest_replacement_ratio'] else 'N/A'} | Sharpe: {format(sharpe, '.2f') if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scrappage", required=True, dest="scrappage_file")
    ap.add_argument("--sales", required=True, dest="sales_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/india_auto_scrap")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
