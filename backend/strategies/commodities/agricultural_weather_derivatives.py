#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
agricultural_weather_derivatives.py — Weather anomalies predict crop price spikes
==================================================================================
ENSO (El Niño/La Niña) and drought indices predict agricultural commodity prices
6-12 months in advance. La Niña → drought in Brazil/Argentina → soy/corn supply shock.
El Niño → floods in SE Asia → palm oil disruption.

Inputs (CSV)
------------
--weather  weather_indices.csv
    Columns: date, enso_index, pdo_index, drought_index_us, drought_index_brazil,
             temperature_anomaly_c, precipitation_anomaly_pct
--crops    crop_prices.csv
    Columns: date, crop, price_usd

Outputs
-------
outdir/weather_signals.csv      date, enso_phase, drought_level, crop_signals
outdir/crop_weather_corr.csv    lagged correlation between weather and crop prices
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


ENSO_THRESHOLDS = {"strong_el_nino": 1.5, "weak_el_nino": 0.5, "neutral": -0.5, "weak_la_nina": -1.5}
CROP_WEATHER_EXPOSURE = {
    "corn": {"la_nina": "bearish", "el_nino": "bullish", "us_drought": "bullish"},
    "soybeans": {"la_nina": "bullish_brazil_drought", "el_nino": "bearish", "us_drought": "bullish"},
    "wheat": {"la_nina": "bullish_australia", "el_nino": "bullish_aus_drought", "us_drought": "bullish"},
    "coffee": {"la_nina": "bullish_brazil", "el_nino": "bullish_vietnam", "us_drought": "neutral"},
    "palm_oil": {"el_nino": "bullish", "la_nina": "bearish", "us_drought": "neutral"},
    "sugar": {"la_nina": "bearish_brazil_wet", "el_nino": "bullish", "us_drought": "neutral"}
}


def classify_enso(index: float) -> str:
    if index > ENSO_THRESHOLDS["strong_el_nino"]:
        return "strong_el_nino"
    elif index > ENSO_THRESHOLDS["weak_el_nino"]:
        return "weak_el_nino"
    elif index > ENSO_THRESHOLDS["neutral"]:
        return "neutral"
    elif index > ENSO_THRESHOLDS["weak_la_nina"]:
        return "weak_la_nina"
    return "strong_la_nina"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    weather = pd.read_csv(cfg.weather_file, parse_dates=["date"])
    weather.columns = [c.lower().strip() for c in weather.columns]
    weather = weather.set_index("date").sort_index()
    crops = pd.read_csv(cfg.crops_file, parse_dates=["date"])
    crops.columns = [c.lower().strip() for c in crops.columns]
    crop_wide = crops.pivot(index="date", columns="crop", values="price_usd").sort_index()

    enso_col = "enso_index" if "enso_index" in weather.columns else weather.columns[0]
    weather["enso_phase"] = weather[enso_col].apply(classify_enso)

    us_drought = weather.get("drought_index_us", pd.Series(0, index=weather.index))
    brazil_drought = weather.get("drought_index_brazil", pd.Series(0, index=weather.index))
    weather["drought_level_us"] = us_drought.apply(lambda d: "severe" if d > 3 else ("moderate" if d > 2 else "normal"))
    weather["drought_level_brazil"] = brazil_drought.apply(lambda d: "severe" if d > 3 else ("moderate" if d > 2 else "normal"))

    signal_records = []
    for date, row in weather.iterrows():
        enso_phase = row["enso_phase"]
        drought_us = row["drought_level_us"]
        drought_brazil = row["drought_level_brazil"]
        crop_signals = {}
        for crop, exposures in CROP_WEATHER_EXPOSURE.items():
            if crop not in crop_wide.columns:
                continue
            signals = []
            if "la_nina" in enso_phase and exposures.get("la_nina", "neutral") != "neutral":
                signals.append(exposures["la_nina"])
            if "el_nino" in enso_phase and exposures.get("el_nino", "neutral") != "neutral":
                signals.append(exposures["el_nino"])
            if drought_us in ("severe", "moderate") and "bullish" in exposures.get("us_drought", "neutral"):
                signals.append("bullish")
            crop_signals[crop] = "bullish" if any("bullish" in s for s in signals) else \
                                  ("bearish" if any("bearish" in s for s in signals) else "neutral")

        record = {"date": date, "enso_index": float(row.get(enso_col, np.nan)),
                  "enso_phase": enso_phase, "drought_us": drought_us, "drought_brazil": drought_brazil}
        record.update({f"signal_{k}": v for k, v in crop_signals.items()})
        signal_records.append(record)

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "weather_signals.csv"), index=False)

    # Lagged correlations (ENSO leads crop prices by 3-12 months)
    corr_records = []
    enso_series = weather[enso_col].dropna()
    for crop in crop_wide.columns:
        crop_ret = crop_wide[crop].pct_change().dropna()
        for lag_months in [3, 6, 9, 12]:
            lag_days = lag_months * 21
            fwd_ret = crop_ret.rolling(lag_days).sum().shift(-lag_days)
            enso_aligned = enso_series.reindex(crop_ret.index, method="ffill").dropna()
            aligned = enso_aligned.align(fwd_ret.dropna(), join="inner")
            if len(aligned[0]) > 20:
                r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
                corr_records.append({"crop": crop, "lag_months": lag_months,
                                      "enso_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})
    if corr_records:
        pd.DataFrame(corr_records).sort_values(["crop", "lag_months"]).to_csv(
            os.path.join(cfg.outdir, "crop_weather_corr.csv"), index=False)

    # Backtest: trade crops based on ENSO signal
    all_daily = []
    for crop in crop_wide.columns:
        sig_col = f"signal_{crop}"
        if sig_col not in sig_df.columns:
            continue
        crop_ret = crop_wide[crop].pct_change().dropna()
        pos_series = sig_df.set_index("date")[sig_col].reindex(crop_ret.index, method="ffill")
        pos = pos_series.map({"bullish": 1, "neutral": 0, "bearish": -1}).fillna(0)
        strat = pos.shift(1) * crop_ret
        all_daily.append(strat.rename(crop))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    current_enso = float(weather[enso_col].iloc[-1]) if not weather.empty else None
    summary = {
        "current_enso_index": current_enso,
        "current_enso_phase": str(weather["enso_phase"].iloc[-1]) if not weather.empty else None,
        "crops_analyzed": list(crop_wide.columns),
        "n_weather_records": len(sig_df),
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Agri weather | ENSO: {current_enso:.2f} ({summary['current_enso_phase']}) | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weather", required=True, dest="weather_file")
    ap.add_argument("--crops", required=True, dest="crops_file")
    ap.add_argument("--outdir", default="./artifacts/agri_weather")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
