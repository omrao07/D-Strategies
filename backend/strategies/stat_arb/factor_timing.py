#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
factor_timing.py — Rotate value/momentum/quality by macro regime
=================================================================
Uses macro regime indicators to time factor exposures. In risk-on regimes
favor momentum and growth; in risk-off favor value and quality.

Inputs (CSV)
------------
--factors  factor_returns.csv
    Columns: date, value_ret, mom_ret, quality_ret, low_vol_ret

--macro    macro_regime.csv
    Columns: date, regime (bull/bear/high_vol/low_vol or numeric 1-4)

Outputs
-------
outdir/regime_factor_performance.csv    avg factor return by regime
outdir/timed_portfolio.csv             date, timed_return, equal_weight_return
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

REGIME_WEIGHTS = {
    "bull":     {"value_ret": 0.15, "mom_ret": 0.50, "quality_ret": 0.20, "low_vol_ret": 0.15},
    "bear":     {"value_ret": 0.35, "mom_ret": 0.10, "quality_ret": 0.35, "low_vol_ret": 0.20},
    "high_vol": {"value_ret": 0.20, "mom_ret": 0.15, "quality_ret": 0.30, "low_vol_ret": 0.35},
    "low_vol":  {"value_ret": 0.25, "mom_ret": 0.40, "quality_ret": 0.20, "low_vol_ret": 0.15},
}


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    factors = pd.read_csv(cfg.factors_file, parse_dates=["date"]).set_index("date").sort_index()
    factors.columns = [c.lower().strip() for c in factors.columns]
    macro = pd.read_csv(cfg.macro_file, parse_dates=["date"]).set_index("date").sort_index()
    macro.columns = [c.lower().strip() for c in macro.columns]
    regime_col = macro.columns[0]

    merged = factors.join(macro[[regime_col]], how="inner").dropna()
    factor_cols = [c for c in factors.columns if c in merged.columns]

    # Performance by regime
    regime_perf = merged.groupby(regime_col)[factor_cols].agg(["mean", "std"]).round(6)
    regime_perf.to_csv(os.path.join(cfg.outdir, "regime_factor_performance.csv"))

    # Timed portfolio
    records = []
    for date, row in merged.iterrows():
        regime = str(row[regime_col]).lower()
        weights = REGIME_WEIGHTS.get(regime, {f: 0.25 for f in factor_cols})
        timed_ret = sum(weights.get(f, 0) * row[f] for f in factor_cols if f in row)
        eq_ret = row[factor_cols].mean()
        records.append({"date": date, "regime": regime, "timed_return": timed_ret, "equal_weight_return": eq_ret})

    port = pd.DataFrame(records).set_index("date")
    port.to_csv(os.path.join(cfg.outdir, "timed_portfolio.csv"))

    timed = port["timed_return"].dropna()
    eq = port["equal_weight_return"].dropna()
    summary = {"n_obs": len(port), "regimes_found": merged[regime_col].unique().tolist(),
               "timed_ann_return": float(timed.mean() * 252), "eq_ann_return": float(eq.mean() * 252),
               "timed_sharpe": float(timed.mean() / timed.std() * np.sqrt(252)) if timed.std() > 0 else None,
               "eq_sharpe": float(eq.mean() / eq.std() * np.sqrt(252)) if eq.std() > 0 else None,
               "regime_weights_used": REGIME_WEIGHTS}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Factor timing | Timed Sharpe: {summary['timed_sharpe']:.2f} vs EW: {summary['eq_sharpe']:.2f} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--factors", required=True, dest="factors_file")
    ap.add_argument("--macro", required=True, dest="macro_file")
    ap.add_argument("--outdir", default="./artifacts/factor_timing")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
