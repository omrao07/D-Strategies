#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
crude_oil_time_spreads.py — WTI/Brent time spread trading (calendar spreads)
==============================================================================
Oil market structure (contango/backwardation) drives roll yield for energy ETFs.
Backwardation (prompt > deferred) → positive roll yield → long futures profitable.
Contango → negative roll yield → short or avoid. Strategy trades calendar spreads
and estimates roll yield impact.

Inputs (CSV)
------------
--futures  oil_futures.csv
    Columns: date, contract (e.g. CL1, CL2, CL3, CL6, CL12), price, grade (WTI/Brent)

Outputs
-------
outdir/spread_signals.csv       date, grade, m1m2_spread, m1m6_spread, structure, roll_yield_ann, signal
outdir/roll_yield_analysis.csv  historical roll yield vs spot return
outdir/backtest.csv             cumulative P&L from calendar spread
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd
from scipy import stats

STRUCTURE_THRESHOLDS = {
    "strong_backwardation": 2.0,   # M1-M6 spread > $2
    "mild_backwardation": 0.5,
    "flat": 0.0,
    "mild_contango": -0.5,
    "deep_contango": -2.0
}


def classify_structure(m1m6_spread: float) -> str:
    if m1m6_spread > STRUCTURE_THRESHOLDS["strong_backwardation"]:
        return "strong_backwardation"
    elif m1m6_spread > STRUCTURE_THRESHOLDS["mild_backwardation"]:
        return "mild_backwardation"
    elif m1m6_spread > STRUCTURE_THRESHOLDS["flat"]:
        return "flat_backwardation"
    elif m1m6_spread > STRUCTURE_THRESHOLDS["deep_contango"]:
        return "contango"
    return "deep_contango"


def compute_roll_yield_ann(m1_price: float, m2_price: float, days_to_roll: int = 30) -> float:
    """Annualized roll yield from rolling M1 to M2."""
    if m1_price <= 0 or m2_price <= 0 or days_to_roll <= 0:
        return np.nan
    roll_yield = (m1_price - m2_price) / m1_price
    return float(roll_yield * 365 / days_to_roll * 100)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    futures = pd.read_csv(cfg.futures_file, parse_dates=["date"])
    futures.columns = [c.lower().strip() for c in futures.columns]

    grade_col = "grade" if "grade" in futures.columns else None
    grades = futures["grade"].unique() if grade_col else ["default"]

    spread_records = []
    roll_records = []
    all_daily = []

    for grade in grades:
        if grade_col:
            sub = futures[futures["grade"] == grade].copy()
        else:
            sub = futures.copy()
            sub["grade"] = "WTI"
            grade = "WTI"

        wide = sub.pivot(index="date", columns="contract", values="price").sort_index()

        # Identify front month and deferred contracts
        contracts = sorted(wide.columns.tolist())
        if len(contracts) < 2:
            continue

        m1_col = contracts[0]
        m2_col = contracts[1] if len(contracts) > 1 else contracts[0]
        m6_col = contracts[min(5, len(contracts) - 1)]
        m12_col = contracts[min(11, len(contracts) - 1)]

        wide["m1m2_spread"] = wide[m1_col] - wide[m2_col]
        wide["m1m6_spread"] = wide[m1_col] - wide[m6_col]
        wide["m1m12_spread"] = wide[m1_col] - wide[m12_col] if m12_col != m1_col else np.nan
        wide["structure"] = wide["m1m6_spread"].apply(classify_structure)
        wide["roll_yield_ann"] = wide.apply(
            lambda r: compute_roll_yield_ann(r[m1_col], r[m2_col]), axis=1
        )
        wide["roll_yield_zscore"] = (wide["roll_yield_ann"] - wide["roll_yield_ann"].rolling(252).mean()) / \
                                     wide["roll_yield_ann"].rolling(252).std().replace(0, np.nan)

        for date, row in wide.iterrows():
            m1m6 = float(row["m1m6_spread"])
            struct = row["structure"]
            ry = row.get("roll_yield_ann", np.nan)
            ry_z = row.get("roll_yield_zscore", np.nan)

            signal = "long_m1_short_m6" if struct in ("strong_backwardation", "mild_backwardation") else \
                     ("short_m1_long_m6" if struct in ("contango", "deep_contango") else "neutral")

            spread_records.append({
                "date": date, "grade": grade,
                "m1_price": float(row[m1_col]),
                "m1m2_spread": float(row["m1m2_spread"]),
                "m1m6_spread": float(m1m6),
                "structure": struct,
                "roll_yield_ann_pct": float(ry) if not np.isnan(ry) else None,
                "roll_yield_zscore": float(ry_z) if not np.isnan(ry_z) else None,
                "signal": signal
            })

        # Roll yield vs spot return
        m1_ret = wide[m1_col].pct_change().dropna()
        roll_yield_daily = wide["roll_yield_ann"].reindex(m1_ret.index) / 100 / 365
        m1_ret + roll_yield_daily.fillna(0)

        fwd5 = m1_ret.rolling(5).sum().shift(-5)
        ry_series = wide["roll_yield_zscore"].reindex(m1_ret.index).ffill().dropna()
        aligned = ry_series.align(fwd5.dropna(), join="inner")
        if len(aligned[0]) > 20:
            r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
            roll_records.append({"grade": grade, "roll_yield_fwd5d_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

        # Calendar spread backtest: long M1 short M6 or vice versa
        pos = wide["structure"].map(
            {"strong_backwardation": 1, "mild_backwardation": 0.5, "flat_backwardation": 0,
             "contango": -0.5, "deep_contango": -1}
        ).fillna(0)
        m6_ret = wide[m6_col].pct_change().dropna()
        spread_ret = pos.shift(1) * (m1_ret.reindex(pos.index) - m6_ret.reindex(pos.index))
        all_daily.append(spread_ret.rename(grade))

    spread_df = pd.DataFrame(spread_records).sort_values("date")
    spread_df.to_csv(os.path.join(cfg.outdir, "spread_signals.csv"), index=False)

    roll_df = pd.DataFrame(roll_records) if roll_records else pd.DataFrame()
    if not roll_df.empty:
        roll_df.to_csv(os.path.join(cfg.outdir, "roll_yield_analysis.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    current_struct = str(spread_df["structure"].iloc[-1]) if not spread_df.empty else None
    summary = {
        "grades_analyzed": list(grades), "n_obs": len(spread_df),
        "current_structure": current_struct,
        "avg_m1m6_spread": float(spread_df["m1m6_spread"].mean()) if not spread_df.empty else None,
        "pct_backwardation": float((spread_df["m1m6_spread"] > 0).mean()) if not spread_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Oil time spreads | Structure: {current_struct} | Backwardation: {summary['pct_backwardation']:.1%} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--futures", required=True, dest="futures_file")
    ap.add_argument("--outdir", default="./artifacts/oil_time_spreads")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
