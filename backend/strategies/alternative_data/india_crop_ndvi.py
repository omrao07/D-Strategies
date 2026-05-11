#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_crop_ndvi.py — India satellite NDVI crop signal for FMCG/agri stocks
===========================================================================
NDVI (Normalized Difference Vegetation Index) from satellite data (Sentinel-2,
MODIS) measures crop health across India's agricultural states. Strong NDVI in
major crop belts predicts:
  - Better Kharif/Rabi season → lower food inflation → RBI dovish
  - FMCG rural volume recovery → positive for Hindustan Unilever, ITC, Dabur
  - Lower agri commodity prices (pulses, wheat, rice)
  - Fertilizer demand → positive for COROMANDEL, CHAMBAL, NFL

India moat: India's agriculture is 14% of GDP and drives rural consumption.
Satellite agri data is not used by any major India-focused hedge fund systematically.

Inputs (CSV)
------------
--ndvi      ndvi.csv        date, region, ndvi_value (0-1 scale, 0.5+ = healthy)
--stocks    stocks.csv      date, ticker, close
--rain      rain.csv        date, rainfall_pct_normal (optional, IMD data)

Outputs
-------
outdir/crop_health.csv          date, region, ndvi, season, crop_health_score
outdir/india_agri_index.csv     date, composite_ndvi, yoy_change, signal
outdir/stock_impact.csv         regime, ticker, avg_fwd_return_pct
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd

# India agricultural seasons
KHARIF_MONTHS = [6, 7, 8, 9, 10]   # June - October (paddy, cotton, sugarcane)
RABI_MONTHS = [11, 12, 1, 2, 3]     # November - March (wheat, mustard, gram)

# Agricultural states with NDVI weight
REGION_WEIGHTS = {
    "UP": 0.20,           # Wheat, sugarcane
    "PUNJAB": 0.15,       # Wheat, rice
    "MP": 0.12,           # Wheat, soybean
    "RAJASTHAN": 0.10,    # Mustard, bajra
    "MAHARASHTRA": 0.12,  # Cotton, onion, sugarcane
    "AP_TELANGANA": 0.10, # Rice, cotton
    "GUJARAT": 0.08,      # Cotton, groundnut
    "HARYANA": 0.08,      # Wheat, rice
    "WB": 0.05,           # Rice, jute
    "OTHER": 0.10,
}

# FMCG and agri stocks
FMCG_STOCKS = ["HINDUNILVR", "ITC", "DABUR", "MARICO", "BRITANNIA", "GODREJCP"]
AGRI_STOCKS = ["COROMANDEL", "CHAMBAL", "PIIND", "UPL", "RALLIS"]
NDVI_GOOD = 0.55     # NDVI > 0.55 = healthy crop
NDVI_POOR = 0.35     # NDVI < 0.35 = stressed crop


def get_season(month: int) -> str:
    if month in KHARIF_MONTHS:
        return "kharif"
    elif month in RABI_MONTHS:
        return "rabi"
    return "off_season"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    ndvi = pd.read_csv(cfg.ndvi_file, parse_dates=["date"])
    ndvi.columns = [c.lower().strip() for c in ndvi.columns]
    ndvi_col = "ndvi_value" if "ndvi_value" in ndvi.columns else ndvi.columns[-1]

    stocks = pd.read_csv(cfg.stocks_file, parse_dates=["date"])
    stocks.columns = [c.lower().strip() for c in stocks.columns]
    stocks_wide = stocks.pivot_table(index="date", columns="ticker", values="close").sort_index()
    stocks_wide.columns = [c.upper() for c in stocks_wide.columns]

    rain_df = None
    if cfg.rain_file and os.path.exists(cfg.rain_file):
        rain_df = pd.read_csv(cfg.rain_file, parse_dates=["date"]).set_index("date").sort_index()
        rain_df.columns = [c.lower().strip() for c in rain_df.columns]

    crop_records = []

    if "region" in ndvi.columns:
        for region, grp in ndvi.groupby("region"):
            grp = grp.set_index("date").sort_index()
            weight = REGION_WEIGHTS.get(str(region).upper(), 0.05)
            for dt, row in grp.iterrows():
                ndvi_val = row[ndvi_col]
                health = "good" if ndvi_val > NDVI_GOOD else ("poor" if ndvi_val < NDVI_POOR else "moderate")
                crop_records.append({
                    "date": dt.date(),
                    "region": str(region).upper(),
                    "ndvi": float(ndvi_val),
                    "weight": weight,
                    "season": get_season(dt.month),
                    "crop_health": health,
                })
    else:
        ndvi_agg = ndvi.set_index("date").sort_index()
        for dt, row in ndvi_agg.iterrows():
            crop_records.append({
                "date": dt.date(), "region": "AGGREGATE",
                "ndvi": float(row[ndvi_col]), "weight": 1.0,
                "season": get_season(dt.month),
                "crop_health": "good" if row[ndvi_col] > NDVI_GOOD else "poor",
            })

    pd.DataFrame(crop_records).sort_values("date").to_csv(os.path.join(cfg.outdir, "crop_health.csv"), index=False)

    # Composite India NDVI index (weighted by region importance)
    crop_df = pd.DataFrame(crop_records)
    crop_df["date"] = pd.to_datetime(crop_df["date"])
    composite = crop_df.groupby("date").apply(
        lambda g: float(np.average(g["ndvi"], weights=g["weight"]))
    ).rename("composite_ndvi")

    comp_df = composite.to_frame()
    comp_df["yoy_change"] = comp_df["composite_ndvi"].pct_change(252) * 100
    comp_df["ma30"] = comp_df["composite_ndvi"].rolling(30).mean()

    # Signal
    comp_df["signal"] = comp_df["composite_ndvi"].apply(
        lambda v: "positive_agri" if v > NDVI_GOOD else (
            "negative_agri" if v < NDVI_POOR else "neutral"
        )
    )
    comp_df.to_csv(os.path.join(cfg.outdir, "india_agri_index.csv"))

    # Stock impact
    all_tickers = [(t, "FMCG") for t in FMCG_STOCKS if t in stocks_wide.columns] + \
                  [(t, "AGRI") for t in AGRI_STOCKS if t in stocks_wide.columns]

    stock_ret = stocks_wide[[t for t, _ in all_tickers]].pct_change() if all_tickers else None
    impact_records = []

    if stock_ret is not None:
        sig_aligned = comp_df["signal"].reindex(stock_ret.index).ffill()
        fwd_ret = stock_ret.rolling(10).sum().shift(-10) * 100

        for ticker, cat in all_tickers:
            for regime in ["positive_agri", "negative_agri", "neutral"]:
                mask = sig_aligned == regime
                avg_ret = float(fwd_ret.loc[mask, ticker].mean()) if mask.any() else None
                impact_records.append({
                    "regime": regime, "ticker": ticker, "category": cat,
                    "avg_fwd_10d_pct": avg_ret, "n_obs": int(mask.sum())
                })

        if impact_records:
            pd.DataFrame(impact_records).to_csv(os.path.join(cfg.outdir, "stock_impact.csv"), index=False)

        # Backtest: long FMCG when NDVI strong
        fmcg_avail = [t for t in FMCG_STOCKS if t in stocks_wide.columns]
        if fmcg_avail:
            basket = stocks_wide[fmcg_avail].pct_change().mean(axis=1)
            pos = (comp_df["signal"] == "positive_agri").astype(float).shift(1).reindex(basket.index).ffill()
            strat_ret = (pos * basket).dropna()
            cum = (1 + strat_ret).cumprod()
            cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
            sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(252)) if strat_ret.std() > 0 else None
        else:
            sharpe = None
    else:
        sharpe = None

    summary = {
        "avg_composite_ndvi": float(comp_df["composite_ndvi"].mean()),
        "pct_good_crop_days": float((comp_df["composite_ndvi"] > NDVI_GOOD).mean() * 100),
        "pct_poor_crop_days": float((comp_df["composite_ndvi"] < NDVI_POOR).mean() * 100),
        "n_regions": int(crop_df["region"].nunique()),
        "sharpe": sharpe,
        "params": {"ndvi_good": NDVI_GOOD, "ndvi_poor": NDVI_POOR}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India Crop NDVI | Avg NDVI: {summary['avg_composite_ndvi']:.3f} | Good days: {summary['pct_good_crop_days']:.1f}% | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ndvi", required=True, dest="ndvi_file")
    ap.add_argument("--stocks", required=True, dest="stocks_file")
    ap.add_argument("--rain", default=None, dest="rain_file")
    ap.add_argument("--outdir", default="./artifacts/india_crop_ndvi")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
