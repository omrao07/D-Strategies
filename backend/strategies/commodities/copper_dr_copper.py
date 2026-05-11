#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
copper_dr_copper.py — "Dr. Copper" as macro indicator & equity signal
=======================================================================
Copper has a PhD in economics — its price leads global industrial activity by
2-3 months. Copper price relative to gold (Cu/Au ratio) is especially powerful:
rising ratio → risk-on (cyclicals); falling ratio → risk-off (defensives).

Inputs (CSV)
------------
--copper   copper_prices.csv
    Columns: date, copper_lb_usd, copper_lme_usd (optional)
--gold     gold_prices.csv
    Columns: date, gold_usd
--assets   asset_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/copper_signals.csv       date, copper_usd, gold_usd, cu_au_ratio, zscore, signal
outdir/cu_au_vs_equity.csv      Cu/Au ratio vs equity sector returns
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


SECTOR_PREFERRED_RISING = ["XLB", "XLI", "XLE", "XLF"]   # Cyclicals outperform when copper rising
SECTOR_PREFERRED_FALLING = ["XLU", "XLP", "XLV", "TLT"]  # Defensives outperform when copper falling


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    copper = pd.read_csv(cfg.copper_file, parse_dates=["date"])
    copper.columns = [c.lower().strip() for c in copper.columns]
    copper = copper.set_index("date").sort_index()
    gold = pd.read_csv(cfg.gold_file, parse_dates=["date"])
    gold.columns = [c.lower().strip() for c in gold.columns]
    gold = gold.set_index("date").sort_index()
    assets = pd.read_csv(cfg.assets_file, parse_dates=["date"])
    assets.columns = [c.lower().strip() for c in assets.columns]
    ret_wide = assets.pivot(index="date", columns="ticker", values="return").sort_index()

    copper_col = "copper_lb_usd" if "copper_lb_usd" in copper.columns else copper.columns[0]
    gold_col = "gold_usd" if "gold_usd" in gold.columns else gold.columns[0]

    merged = copper[[copper_col]].join(gold[[gold_col]], how="inner")
    # Convert copper to per-troy-oz if needed (1 troy oz ≈ 31.1g; copper in $/lb)
    merged["cu_au_ratio"] = (merged[copper_col] * 1000) / merged[gold_col].replace(0, np.nan)  # per 1000lb vs per oz
    merged["cu_au_zscore"] = (merged["cu_au_ratio"] - merged["cu_au_ratio"].rolling(252).mean()) / \
                               merged["cu_au_ratio"].rolling(252).std().replace(0, np.nan)
    merged["cu_au_trend_60d"] = merged["cu_au_ratio"].pct_change(60)
    merged["copper_yoy"] = merged[copper_col].pct_change(252)
    merged["copper_mom"] = merged[copper_col].pct_change(21)

    copper_ret = merged[copper_col].pct_change().dropna()

    signal_records = []
    for date, row in merged.iterrows():
        z = row.get("cu_au_zscore", np.nan)
        trend = row.get("cu_au_trend_60d", 0) or 0

        if not np.isnan(z) and z > cfg.zscore_threshold and trend > 0:
            signal = "risk_on"   # Cu/Au rising strongly → cyclicals, commodities
        elif not np.isnan(z) and z < -cfg.zscore_threshold and trend < 0:
            signal = "risk_off"  # Cu/Au falling → defensives, bonds
        elif not np.isnan(z) and z > 1 and trend > 0:
            signal = "mild_risk_on"
        elif not np.isnan(z) and z < -1 and trend < 0:
            signal = "mild_risk_off"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date, "copper_usd_lb": float(row[copper_col]),
            "gold_usd": float(row[gold_col]),
            "cu_au_ratio": float(row["cu_au_ratio"]) if not np.isnan(row["cu_au_ratio"]) else None,
            "cu_au_zscore": float(z) if not np.isnan(z) else None,
            "cu_au_trend_60d": float(trend) if not np.isnan(trend) else None,
            "copper_yoy_pct": float(row.get("copper_yoy", np.nan) * 100) if not np.isnan(row.get("copper_yoy", np.nan)) else None,
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "copper_signals.csv"), index=False)

    # Cu/Au ratio vs sector returns
    sector_records = []
    cu_au_sig = sig_df.set_index("date")["signal"].reindex(ret_wide.index).ffill()
    for ticker in ret_wide.columns:
        for sig in ["risk_on", "risk_off", "neutral"]:
            mask = cu_au_sig == sig
            ret_in = ret_wide.loc[mask, ticker].dropna()
            if len(ret_in) > 10:
                sector_records.append({"ticker": ticker, "cu_au_signal": sig,
                                        "avg_daily_ret": float(ret_in.mean()),
                                        "ann_ret": float(ret_in.mean() * 252), "n_days": len(ret_in)})
    if sector_records:
        pd.DataFrame(sector_records).to_csv(os.path.join(cfg.outdir, "cu_au_vs_equity.csv"), index=False)

    # Backtest: sector rotation based on Cu/Au signal
    all_daily = []
    for ticker in ret_wide.columns:
        is_cyclical = ticker in SECTOR_PREFERRED_RISING
        is_defensive = ticker in SECTOR_PREFERRED_FALLING
        pos = cu_au_sig.map({
            "risk_on": 1 if is_cyclical else (-1 if is_defensive else 0),
            "mild_risk_on": 0.5 if is_cyclical else (-0.5 if is_defensive else 0),
            "neutral": 0,
            "mild_risk_off": -0.5 if is_cyclical else (0.5 if is_defensive else 0),
            "risk_off": -1 if is_cyclical else (1 if is_defensive else 0)
        }).fillna(0)
        strat = pos.shift(1) * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    # Copper vs 3M forward equity return correlation
    cu_z_daily = sig_df.set_index("date")["cu_au_zscore"].dropna()
    fwd_eq = ret_wide.mean(axis=1).rolling(63).sum().shift(-63) if len(ret_wide) > 0 else pd.Series()
    if len(fwd_eq) > 20:
        aligned = cu_z_daily.align(fwd_eq.dropna(), join="inner")
        if len(aligned[0]) > 20:
            r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
            corr_eq = float(r)
        else:
            corr_eq = None
    else:
        corr_eq = None

    summary = {
        "current_copper_usd_lb": float(merged[copper_col].iloc[-1]) if not merged.empty else None,
        "current_cu_au_ratio": float(merged["cu_au_ratio"].dropna().iloc[-1]) if not merged.empty else None,
        "current_signal": str(sig_df["signal"].iloc[-1]) if not sig_df.empty else None,
        "corr_cu_au_fwd_equity_3m": corr_eq,
        "pct_risk_on": float((sig_df["signal"] == "risk_on").mean()) if not sig_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"zscore_threshold": cfg.zscore_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Dr. Copper | Cu: ${summary['current_copper_usd_lb']:.2f}/lb | Cu/Au: {summary['current_cu_au_ratio']:.4f} | Signal: {summary['current_signal']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--copper", required=True, dest="copper_file")
    ap.add_argument("--gold", required=True, dest="gold_file")
    ap.add_argument("--assets", required=True, dest="assets_file")
    ap.add_argument("--zscore-threshold", type=float, default=1.5)
    ap.add_argument("--outdir", default="./artifacts/dr_copper")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
