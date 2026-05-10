#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
coffee_sugar_brazil_correlation.py — Brazil FX/weather drives coffee & sugar pairs
====================================================================================
Brazil produces ~35% of world coffee (arabica) and ~20% of sugar. BRL depreciation
makes Brazilian exports more competitive → prices fall. BRL appreciation → supply
tightens → prices rise. Frost risk in Brazil (June-August) → coffee spike.

Inputs (CSV)
------------
--coffee   coffee_prices.csv
    Columns: date, arabica_usd_lb, robusta_usd_ton
--sugar    sugar_prices.csv
    Columns: date, sugar_no11_usd_lb, white_sugar_usd_ton
--brl      brl_rates.csv
    Columns: date, usdbrl

Outputs
-------
outdir/coffee_sugar_signals.csv date, brl_rate, arabica, sugar, brl_zscore,
                                 arabica_sugar_spread, signal
outdir/brl_vs_prices.csv        BRL vs coffee/sugar correlation analysis
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


FROST_SEASON_MONTHS = [6, 7, 8]  # Brazil winter frost risk


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    coffee = pd.read_csv(cfg.coffee_file, parse_dates=["date"])
    coffee.columns = [c.lower().strip() for c in coffee.columns]
    coffee = coffee.set_index("date").sort_index()
    sugar = pd.read_csv(cfg.sugar_file, parse_dates=["date"])
    sugar.columns = [c.lower().strip() for c in sugar.columns]
    sugar = sugar.set_index("date").sort_index()
    brl = pd.read_csv(cfg.brl_file, parse_dates=["date"])
    brl.columns = [c.lower().strip() for c in brl.columns]
    brl = brl.set_index("date").sort_index()

    brl_col = "usdbrl" if "usdbrl" in brl.columns else brl.columns[0]
    arabica_col = "arabica_usd_lb" if "arabica_usd_lb" in coffee.columns else coffee.columns[0]
    sugar_col = "sugar_no11_usd_lb" if "sugar_no11_usd_lb" in sugar.columns else sugar.columns[0]

    merged = brl[[brl_col]].join(coffee[[arabica_col]], how="outer").join(sugar[[sugar_col]], how="outer").ffill().dropna()

    merged["brl_yoy_pct"] = merged[brl_col].pct_change(252) * 100
    merged["brl_zscore"] = (merged[brl_col] - merged[brl_col].rolling(252).mean()) / \
                            merged[brl_col].rolling(252).std().replace(0, np.nan)

    merged["arabica_zscore"] = (merged[arabica_col] - merged[arabica_col].rolling(252).mean()) / \
                                merged[arabica_col].rolling(252).std().replace(0, np.nan)
    merged["sugar_zscore"] = (merged[sugar_col] - merged[sugar_col].rolling(252).mean()) / \
                              merged[sugar_col].rolling(252).std().replace(0, np.nan)

    merged["arabica_sugar_spread"] = merged["arabica_zscore"] - merged["sugar_zscore"]
    merged["is_frost_season"] = merged.index.month.isin(FROST_SEASON_MONTHS)

    signal_records = []
    for date, row in merged.iterrows():
        brl_z = row.get("brl_zscore", np.nan)
        arabica_z = row.get("arabica_zscore", np.nan)
        sugar_z = row.get("sugar_zscore", np.nan)
        frost = row.get("is_frost_season", False)

        # BRL strong (high USDBRL z) → exports more competitive → bearish for prices
        # BRL weak (low USDBRL z) → exports less competitive → bullish for prices
        coffee_signal = "buy" if (not np.isnan(brl_z) and brl_z < -1 or (frost and not np.isnan(arabica_z) and arabica_z < 0)) else \
                        ("sell" if (not np.isnan(brl_z) and brl_z > 1.5) else "neutral")
        sugar_signal = "buy" if (not np.isnan(brl_z) and brl_z < -1) else \
                       ("sell" if (not np.isnan(brl_z) and brl_z > 1.5) else "neutral")

        spread_signal = "long_arabica_short_sugar" if row.get("arabica_sugar_spread", 0) < -1.5 else \
                        ("long_sugar_short_arabica" if row.get("arabica_sugar_spread", 0) > 1.5 else "neutral")

        signal_records.append({
            "date": date, "brl_rate": float(row[brl_col]),
            "arabica_usd_lb": float(row[arabica_col]),
            "sugar_no11_usd_lb": float(row[sugar_col]),
            "brl_zscore": float(brl_z) if not np.isnan(brl_z) else None,
            "arabica_zscore": float(arabica_z) if not np.isnan(arabica_z) else None,
            "arabica_sugar_spread": float(row.get("arabica_sugar_spread", np.nan)),
            "is_frost_season": bool(frost),
            "coffee_signal": coffee_signal, "sugar_signal": sugar_signal, "spread_signal": spread_signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "coffee_sugar_signals.csv"), index=False)

    # BRL vs prices correlation
    corr_records = []
    brl_ret = merged[brl_col].pct_change().dropna()
    for commodity, col in [("arabica", arabica_col), ("sugar", sugar_col)]:
        comm_ret = merged[col].pct_change().dropna()
        for lag in [5, 21, 63]:
            fwd = comm_ret.rolling(lag).sum().shift(-lag)
            aligned = brl_ret.align(fwd.dropna(), join="inner")
            if len(aligned[0]) > 20:
                r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
                corr_records.append({"commodity": commodity, "lag_days": lag, "brl_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

    corr_df = pd.DataFrame(corr_records) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "brl_vs_prices.csv"), index=False)

    # Backtest: trade arabica and sugar based on BRL signal
    arabica_ret = merged[arabica_col].pct_change().dropna()
    sugar_ret = merged[sugar_col].pct_change().dropna()
    pos_arabica = sig_df.set_index("date")["coffee_signal"].map({"buy": 1, "neutral": 0, "sell": -1}).fillna(0)
    pos_sugar = sig_df.set_index("date")["sugar_signal"].map({"buy": 1, "neutral": 0, "sell": -1}).fillna(0)
    port = (pos_arabica.shift(1).reindex(arabica_ret.index, method="ffill") * arabica_ret +
            pos_sugar.shift(1).reindex(sugar_ret.index, method="ffill") * sugar_ret).dropna() / 2
    cum = (1 + port).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
    sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None

    summary = {
        "current_brl": float(merged[brl_col].iloc[-1]) if not merged.empty else None,
        "current_arabica_usd_lb": float(merged[arabica_col].iloc[-1]) if not merged.empty else None,
        "current_sugar_usd_lb": float(merged[sugar_col].iloc[-1]) if not merged.empty else None,
        "n_frost_season_days": int(merged["is_frost_season"].sum()),
        "avg_brl_arabica_corr": float(corr_df[corr_df["commodity"] == "arabica"]["brl_corr"].mean()) if not corr_df.empty else None,
        "ann_return": float(port.mean() * 252), "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Coffee/Sugar/BRL | BRL: {summary['current_brl']:.2f} | Arabica: ${summary['current_arabica_usd_lb']:.2f}/lb | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--coffee", required=True, dest="coffee_file")
    ap.add_argument("--sugar", required=True, dest="sugar_file")
    ap.add_argument("--brl", required=True, dest="brl_file")
    ap.add_argument("--outdir", default="./artifacts/coffee_sugar_brazil")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
