#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_railway_freight.py — Indian Railways freight volumes as industrial activity proxy
========================================================================================
IR freight loadings (coal, cement, steel, food grains, containers) are a leading
indicator of industrial production. Freight loading acceleration → bullish for
industrial stocks, cement (UltraTech, ACC, Shree), steel (SAIL, Tata Steel).
Container traffic tracks trade recovery.

Inputs (CSV)
------------
--freight  railway_freight.csv
    Columns: date, total_mt, coal_mt, cement_mt, steel_mt, food_grains_mt,
             container_teu (optional), fertilizer_mt (optional)
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/freight_signals.csv  date, total_mt, yoy_pct, acceleration, signal
outdir/commodity_freight.csv  commodity-level freight vs sector performance
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


INDUSTRIAL_TICKERS = ["sail", "tatasteel", "jswsteel", "ultracemco", "acc", "shreecem", "ambujacement"]
FREIGHT_GROWTH_STRONG = 8.0   # YoY % — strong industrial activity
FREIGHT_GROWTH_WEAK = 2.0

COMMODITY_SECTOR_MAP = {
    "coal_mt": ["ntpc", "coal_india", "power"],
    "cement_mt": ["ultracemco", "acc", "shreecem", "ambujacement"],
    "steel_mt": ["sail", "tatasteel", "jswsteel", "jindal"],
    "food_grains_mt": ["itc", "fmcg", "agri"]
}


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    freight = pd.read_csv(cfg.freight_file, parse_dates=["date"])
    freight.columns = [c.lower().strip() for c in freight.columns]
    freight = freight.set_index("date").sort_index()
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    total_col = "total_mt" if "total_mt" in freight.columns else freight.columns[0]

    freight["freight_yoy_pct"] = freight[total_col].pct_change(12) * 100
    freight["freight_mom_pct"] = freight[total_col].pct_change(1) * 100
    freight["freight_zscore"] = (freight[total_col] - freight[total_col].rolling(12).mean()) / \
                                 freight[total_col].rolling(12).std().replace(0, np.nan)
    freight["freight_acceleration"] = freight["freight_mom_pct"] - freight["freight_mom_pct"].shift(1)

    # Commodity-level freight vs sector return correlation
    commodity_records = []
    for comm_col, sector_tickers in COMMODITY_SECTOR_MAP.items():
        if comm_col not in freight.columns:
            continue
        comm_yoy = freight[comm_col].pct_change(12) * 100
        for ticker in ret_wide.columns:
            if not any(s in ticker.lower() for s in sector_tickers):
                continue
            ret_s = ret_wide[ticker].dropna()
            for lag_months in [1, 3, 6]:
                fwd_ret = ret_s.rolling(lag_months * 21).sum().shift(-lag_months * 21)
                comm_daily = comm_yoy.reindex(ret_s.index, method="ffill").dropna()
                aligned = comm_daily.align(fwd_ret.dropna(), join="inner")
                if len(aligned[0]) > 15:
                    r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
                    commodity_records.append({
                        "commodity": comm_col, "ticker": ticker, "lag_months": lag_months,
                        "corr": float(r), "pvalue": float(p), "n": len(aligned[0])
                    })

    if commodity_records:
        pd.DataFrame(commodity_records).to_csv(os.path.join(cfg.outdir, "commodity_freight.csv"), index=False)

    signal_records = []
    for date, row in freight.iterrows():
        yoy = row.get("freight_yoy_pct", np.nan)
        accel = row.get("freight_acceleration", np.nan)
        z = row.get("freight_zscore", np.nan)

        # Commodity-level sub-signals
        cement_strong = "cement_mt" in freight.columns and not np.isnan(row.get("cement_mt", np.nan)) and \
                        not np.isnan(freight["cement_mt"].pct_change(12).loc[date] if date in freight.index else np.nan)

        if not np.isnan(yoy) and yoy > FREIGHT_GROWTH_STRONG and not np.isnan(accel) and accel > 0:
            signal = "strong_buy_industrial"
        elif not np.isnan(yoy) and yoy > FREIGHT_GROWTH_STRONG:
            signal = "buy_industrial"
        elif not np.isnan(yoy) and yoy > FREIGHT_GROWTH_WEAK:
            signal = "mild_buy_industrial"
        elif not np.isnan(yoy) and yoy < FREIGHT_GROWTH_WEAK:
            signal = "sell_industrial" if yoy < 0 else "neutral"
        elif not np.isnan(z) and z > 0.5:
            signal = "mild_buy_industrial"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date,
            "total_mt": float(row[total_col]) if not np.isnan(row[total_col]) else None,
            "freight_yoy_pct": float(yoy) if not np.isnan(yoy) else None,
            "freight_acceleration_pp": float(accel) if not np.isnan(accel) else None,
            "freight_zscore": float(z) if not np.isnan(z) else None,
            "coal_mt": float(row.get("coal_mt", np.nan)) if "coal_mt" in freight.columns and not np.isnan(row.get("coal_mt", np.nan)) else None,
            "cement_mt": float(row.get("cement_mt", np.nan)) if "cement_mt" in freight.columns and not np.isnan(row.get("cement_mt", np.nan)) else None,
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "freight_signals.csv"), index=False)

    # Backtest
    SIG_POS = {"strong_buy_industrial": 1.5, "buy_industrial": 1, "mild_buy_industrial": 0.5,
               "neutral": 0, "sell_industrial": -0.5}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for ticker in ret_wide.columns:
        if any(i in ticker.lower() for i in INDUSTRIAL_TICKERS):
            pos_daily = pos.reindex(ret_wide.index, method="ffill").shift(1).fillna(0)
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
        "latest_total_mt": float(latest.get("total_mt", 0)) if latest.get("total_mt") else None,
        "latest_yoy_pct": float(latest.get("freight_yoy_pct", np.nan)) if latest.get("freight_yoy_pct") else None,
        "latest_signal": str(latest.get("signal", "N/A")),
        "n_buy_signals": int(sig_df["signal"].str.contains("buy").sum()),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"growth_strong": FREIGHT_GROWTH_STRONG}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India Railway Freight | Total: {summary['latest_total_mt']:.1f}MT | YoY: {summary['latest_yoy_pct']:.1f}% | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--freight", required=True, dest="freight_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/india_railway")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
