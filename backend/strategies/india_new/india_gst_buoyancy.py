#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_gst_buoyancy.py — GST collection buoyancy as economic activity tracker
=============================================================================
India's monthly GST collections are the single best high-frequency proxy for
economic activity. GST buoyancy = GST_growth / GDP_growth > 1 → expanding tax
base → structurally bullish. Surprise beats (actual vs consensus) → short-term
rally in Nifty. Tracks CGST, SGST, IGST, Cess separately for sector insights.

Inputs (CSV)
------------
--gst      gst_collections.csv
    Columns: date, total_gst_cr, cgst_cr, sgst_cr, igst_cr, cess_cr,
             consensus_cr (optional), gdp_growth_pct (optional)
--returns  index_returns.csv
    Columns: date, ticker/index, return

Outputs
-------
outdir/gst_signals.csv      date, total_gst_cr, yoy_pct, surprise_pct, buoyancy, signal
outdir/gst_vs_market.csv    GST surprise vs Nifty forward return
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


GST_GROWTH_STRONG = 15.0    # YoY % growth — strong fiscal
GST_GROWTH_WEAK = 5.0
SURPRISE_POSITIVE = 3.0     # % beat vs consensus → buy signal
SURPRISE_NEGATIVE = -3.0
BUOYANCY_STRONG = 1.2       # GST growth / GDP growth > 1.2 → structural expansion


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    gst = pd.read_csv(cfg.gst_file, parse_dates=["date"])
    gst.columns = [c.lower().strip() for c in gst.columns]
    gst = gst.set_index("date").sort_index()
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return") if "ticker" in returns.columns else \
               returns.set_index("date")

    total_col = "total_gst_cr" if "total_gst_cr" in gst.columns else gst.columns[0]
    consensus_col = "consensus_cr" if "consensus_cr" in gst.columns else None
    gdp_col = "gdp_growth_pct" if "gdp_growth_pct" in gst.columns else None

    gst["gst_yoy_pct"] = gst[total_col].pct_change(12) * 100
    gst["gst_mom_pct"] = gst[total_col].pct_change(1) * 100
    gst["gst_zscore"] = (gst[total_col] - gst[total_col].rolling(12).mean()) / \
                         gst[total_col].rolling(12).std().replace(0, np.nan)
    gst["gst_3m_ma"] = gst[total_col].rolling(3).mean()
    gst["gst_trend"] = gst["gst_3m_ma"] / gst["gst_3m_ma"].shift(3) - 1  # 3M trend

    if consensus_col:
        gst["surprise_pct"] = (gst[total_col] / gst[consensus_col].replace(0, np.nan) - 1) * 100
    else:
        gst["surprise_pct"] = np.nan

    if gdp_col:
        gst["gst_buoyancy"] = gst["gst_yoy_pct"] / gst[gdp_col].replace(0, np.nan)
    else:
        gst["gst_buoyancy"] = np.nan

    # IGST as trade activity indicator
    igst_col = "igst_cr" if "igst_cr" in gst.columns else None
    if igst_col:
        gst["igst_share_pct"] = gst[igst_col] / gst[total_col].replace(0, np.nan) * 100
        gst["igst_yoy_pct"] = gst[igst_col].pct_change(12) * 100

    # GST surprise vs forward return
    gst_market_records = []
    surprise_series = gst["surprise_pct"].dropna()
    for idx_col in ret_wide.columns:
        ret_s = ret_wide[idx_col].dropna()
        for fwd_days in [1, 5, 10, 21]:
            fwd_ret = ret_s.rolling(fwd_days).sum().shift(-fwd_days)
            aligned = surprise_series.align(fwd_ret.dropna(), join="inner")
            if len(aligned[0]) > 10:
                r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
                gst_market_records.append({
                    "index": idx_col, "fwd_days": fwd_days,
                    "surprise_corr": float(r), "pvalue": float(p), "n": len(aligned[0])
                })

    if gst_market_records:
        pd.DataFrame(gst_market_records).to_csv(os.path.join(cfg.outdir, "gst_vs_market.csv"), index=False)

    signal_records = []
    for date, row in gst.iterrows():
        yoy = row.get("gst_yoy_pct", np.nan)
        surprise = row.get("surprise_pct", np.nan)
        buoyancy = row.get("gst_buoyancy", np.nan)
        trend = row.get("gst_trend", np.nan)
        z = row.get("gst_zscore", np.nan)

        has_positive_surprise = not np.isnan(surprise) and surprise > SURPRISE_POSITIVE
        has_negative_surprise = not np.isnan(surprise) and surprise < SURPRISE_NEGATIVE
        is_buoyant = not np.isnan(buoyancy) and buoyancy > BUOYANCY_STRONG

        if has_positive_surprise and (not np.isnan(yoy) and yoy > GST_GROWTH_STRONG):
            signal = "strong_buy_market"
        elif has_positive_surprise or (not np.isnan(yoy) and yoy > GST_GROWTH_STRONG and is_buoyant):
            signal = "buy_market"
        elif has_negative_surprise or (not np.isnan(yoy) and yoy < GST_GROWTH_WEAK):
            signal = "sell_market"
        elif not np.isnan(z) and z > 0.5 and not np.isnan(trend) and trend > 0:
            signal = "mild_buy_market"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date,
            "total_gst_cr": float(row[total_col]) if not np.isnan(row[total_col]) else None,
            "gst_yoy_pct": float(yoy) if not np.isnan(yoy) else None,
            "surprise_pct": float(surprise) if not np.isnan(surprise) else None,
            "gst_buoyancy": float(buoyancy) if not np.isnan(buoyancy) else None,
            "gst_zscore": float(z) if not np.isnan(z) else None,
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "gst_signals.csv"), index=False)

    # Backtest on Nifty/broad market
    SIG_POS = {"strong_buy_market": 1.5, "buy_market": 1, "mild_buy_market": 0.5,
               "neutral": 0, "sell_market": -1}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for col in ret_wide.columns:
        ret_s = ret_wide[col].dropna()
        pos_daily = pos.reindex(ret_s.index, method="ffill").shift(1).fillna(0)
        all_daily.append((pos_daily * ret_s).rename(col))

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
        "latest_gst_cr": float(latest.get("total_gst_cr", 0)) if latest.get("total_gst_cr") else None,
        "latest_yoy_pct": float(latest.get("gst_yoy_pct", np.nan)) if latest.get("gst_yoy_pct") else None,
        "latest_surprise_pct": float(latest.get("surprise_pct", np.nan)) if latest.get("surprise_pct") else None,
        "latest_buoyancy": float(latest.get("gst_buoyancy", np.nan)) if latest.get("gst_buoyancy") else None,
        "latest_signal": str(latest.get("signal", "N/A")),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"growth_strong": GST_GROWTH_STRONG, "surprise_threshold": SURPRISE_POSITIVE}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India GST | Collections: ₹{summary['latest_gst_cr']:,.0f}cr | YoY: {summary['latest_yoy_pct']:.1f}% | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gst", required=True, dest="gst_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/india_gst")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
