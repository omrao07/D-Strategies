#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
russia_europe_gas.py — Russia-Europe gas supply disruption vs energy sector
=============================================================================
Russia's gas supply to Europe (via Nord Stream, TurkStream, Ukraine transit)
drives TTF natural gas prices and European energy sector returns. Supply cuts →
TTF spike → bearish for European industrials (BASF, ThyssenKrupp) → bullish for
LNG importers and renewables (ENPH, FSLR, RWE, Enel). US LNG exporters benefit.

Inputs (CSV)
------------
--gas      gas_data.csv
    Columns: date, ttf_eur_mwh, lcg_usd_mmbtu (US Henry Hub), storage_pct_full,
             russia_flow_gwh (optional)
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/gas_risk_signals.csv   date, ttf_price, ttf_zscore, storage_pct, signal
outdir/ttf_vs_sectors.csv     TTF z-score vs sector correlation
outdir/backtest.csv           cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


LNG_EXPORTERS = ["lng", "cqp", "ctl", "tellurian", "nfg"]
RENEWABLES = ["enph", "fslr", "rwe", "enel", "orsted", "iberdrola", "edf"]
EU_INDUSTRIALS = ["basf", "tksteel", "thyssenkrupp", "voestalpine"]
EU_UTILITIES = ["rwe", "eon", "uniper", "engie"]

TTF_HIGH_THRESHOLD = 2.0   # z-score
STORAGE_LOW_THRESHOLD = 60  # % full → supply risk if below
WINTER_MONTHS = [10, 11, 12, 1, 2, 3]


def classify_gas_regime(ttf_z: float, storage_pct: float, is_winter: bool) -> str:
    high_ttf = not np.isnan(ttf_z) and ttf_z > TTF_HIGH_THRESHOLD
    low_storage = not np.isnan(storage_pct) and storage_pct < STORAGE_LOW_THRESHOLD

    if high_ttf and low_storage and is_winter:
        return "acute_crisis"
    elif high_ttf and is_winter:
        return "winter_stress"
    elif high_ttf:
        return "price_spike"
    elif not np.isnan(ttf_z) and ttf_z < -1.5:
        return "abundant_supply"
    else:
        return "normal"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    gas = pd.read_csv(cfg.gas_file, parse_dates=["date"])
    gas.columns = [c.lower().strip() for c in gas.columns]
    gas = gas.set_index("date").sort_index()
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    ttf_col = "ttf_eur_mwh" if "ttf_eur_mwh" in gas.columns else gas.columns[0]
    storage_col = "storage_pct_full" if "storage_pct_full" in gas.columns else None
    russia_col = "russia_flow_gwh" if "russia_flow_gwh" in gas.columns else None

    gas["ttf_yoy_pct"] = gas[ttf_col].pct_change(252) * 100
    gas["ttf_mom_21d"] = gas[ttf_col].pct_change(21) * 100
    gas["ttf_zscore"] = (gas[ttf_col] - gas[ttf_col].rolling(252).mean()) / \
                         gas[ttf_col].rolling(252).std().replace(0, np.nan)

    if russia_col:
        gas["russia_yoy_pct"] = gas[russia_col].pct_change(252) * 100
        gas["russia_disruption"] = gas["russia_yoy_pct"] < -20  # >20% YoY drop

    # TTF vs sector correlation
    ttf_z = gas["ttf_zscore"].dropna()
    corr_records = []
    for ticker in ret_wide.columns:
        ret_s = ret_wide[ticker].dropna()
        for lag in [0, 5, 21]:
            fwd = ret_s.rolling(max(1, lag)).sum().shift(-lag) if lag > 0 else ret_s
            aligned = ttf_z.align(fwd.dropna(), join="inner")
            if len(aligned[0]) > 30:
                r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
                corr_records.append({"ticker": ticker, "lag_days": lag,
                                      "ttf_corr": float(r), "pvalue": float(p)})

    if corr_records:
        pd.DataFrame(corr_records).to_csv(os.path.join(cfg.outdir, "ttf_vs_sectors.csv"), index=False)

    signal_records = []
    for date, row in gas.iterrows():
        ttf_z_val = row.get("ttf_zscore", np.nan)
        storage = row.get(storage_col, np.nan) if storage_col else np.nan
        is_winter = date.month in WINTER_MONTHS
        russia_disrupted = bool(row.get("russia_disruption", False)) if russia_col else False

        regime = classify_gas_regime(ttf_z_val, storage, is_winter)

        if regime == "acute_crisis":
            signal = "strong_buy_lng_renewables_sell_eu_industrials"
        elif regime == "winter_stress":
            signal = "buy_lng_sell_eu_industrials"
        elif regime == "price_spike":
            signal = "buy_lng_exporters"
        elif regime == "abundant_supply":
            signal = "buy_eu_industrials_sell_lng"
        else:
            signal = "neutral"

        if russia_disrupted and regime != "abundant_supply":
            signal = "buy_lng_renewables_sell_eu_industrials"

        signal_records.append({
            "date": date,
            "ttf_eur_mwh": float(row[ttf_col]) if not np.isnan(row[ttf_col]) else None,
            "ttf_zscore": float(ttf_z_val) if not np.isnan(ttf_z_val) else None,
            "storage_pct_full": float(storage) if not np.isnan(storage) else None,
            "is_winter": bool(is_winter),
            "gas_regime": regime,
            "russia_disrupted": bool(russia_disrupted),
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "gas_risk_signals.csv"), index=False)

    # Backtest: LNG exporters + renewables vs EU industrials
    SIG_POS = {"strong_buy_lng_renewables_sell_eu_industrials": 1.5,
               "buy_lng_sell_eu_industrials": 1, "buy_lng_exporters": 0.5,
               "neutral": 0, "buy_eu_industrials_sell_lng": -0.5,
               "buy_lng_renewables_sell_eu_industrials": 1}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for ticker in ret_wide.columns:
        t = ticker.lower()
        direction = 1 if any(l in t for l in LNG_EXPORTERS + RENEWABLES) else \
                    (-1 if any(i in t for i in EU_INDUSTRIALS + EU_UTILITIES) else 0)
        if direction == 0:
            continue
        pos_daily = (pos * direction).reindex(ret_wide.index, method="ffill").shift(1).fillna(0)
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
        "current_ttf": float(latest.get("ttf_eur_mwh", np.nan)) if latest.get("ttf_eur_mwh") else None,
        "current_storage_pct": float(latest.get("storage_pct_full", np.nan)) if latest.get("storage_pct_full") else None,
        "current_regime": str(latest.get("gas_regime", "N/A")),
        "acute_crisis_days": int((sig_df["gas_regime"] == "acute_crisis").sum()),
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Russia-EU Gas | TTF: €{summary['current_ttf']:.1f}/MWh | Regime: {summary['current_regime']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gas", required=True, dest="gas_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/russia_europe_gas")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
