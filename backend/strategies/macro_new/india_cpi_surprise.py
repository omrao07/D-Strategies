#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_cpi_surprise.py — India CPI surprise vs expectations for RBI/NIFTY signal
=================================================================================
India CPI (Consumer Price Index) is released monthly by MoSPI. When CPI
comes in above/below market expectations, it signals RBI policy direction:
  - CPI surprise UP: hawkish → NIFTY negative, bond yields rise, INR weaker
  - CPI surprise DOWN: dovish → NIFTY positive, bonds rally, INR stronger

The surprise effect is asymmetric: upside surprises in India (food-driven)
are more persistent than downside surprises due to structural factors.

Key sub-components:
  - Food inflation (50% weight): seasonal, volatile, drives headline
  - Core inflation (excl. food/fuel): more persistent, RBI-relevant
  - Rural vs Urban CPI divergence: leads consumption

Inputs (CSV)
------------
--cpi       cpi.csv         date, cpi_actual, cpi_estimate, core_cpi, food_cpi, rural_cpi, urban_cpi
--nifty     nifty.csv       date, nifty_close
--usdinr    usdinr.csv      date, usdinr_close
--gsec10    gsec10.csv      date, gsec10y_yield (optional)

Outputs
-------
outdir/cpi_surprise_events.csv      date, actual, estimate, surprise_bps, nifty_reaction
outdir/surprise_regime_returns.csv  surprise_quartile, avg_nifty_fwd_return
outdir/core_vs_food.csv             date, core_cpi, food_cpi, divergence, signal
outdir/backtest.csv                 cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd

SURPRISE_MATERIAL_BPS = 20  # Surprise > 20 bps considered significant
FORWARD_WINDOWS = [1, 3, 5, 10, 20]  # Trading days after release
CORE_FOOD_DIVERGE_THRESHOLD = 2.0   # Core vs Food divergence > 2% = structural signal


def classify_surprise(surprise_bps: float) -> str:
    if pd.isna(surprise_bps):
        return "unknown"
    if surprise_bps > 50:
        return "large_upside"
    elif surprise_bps > SURPRISE_MATERIAL_BPS:
        return "modest_upside"
    elif surprise_bps < -50:
        return "large_downside"
    elif surprise_bps < -SURPRISE_MATERIAL_BPS:
        return "modest_downside"
    return "in_line"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    cpi = pd.read_csv(cfg.cpi_file, parse_dates=["date"])
    cpi.columns = [c.lower().strip() for c in cpi.columns]

    nifty = pd.read_csv(cfg.nifty_file, parse_dates=["date"]).set_index("date").sort_index()
    nifty.columns = [c.lower().strip() for c in nifty.columns]
    nifty_col = nifty.columns[0]

    usdinr = pd.read_csv(cfg.usdinr_file, parse_dates=["date"]).set_index("date").sort_index()
    usdinr.columns = [c.lower().strip() for c in usdinr.columns]
    usdinr_col = usdinr.columns[0]

    gsec10 = None
    if cfg.gsec10_file and os.path.exists(cfg.gsec10_file):
        gsec10 = pd.read_csv(cfg.gsec10_file, parse_dates=["date"]).set_index("date").sort_index()
        gsec10.columns = [c.lower().strip() for c in gsec10.columns]
        gsec10_col = gsec10.columns[0]

    event_records = []
    trade_pnls = []

    has_estimate = "cpi_estimate" in cpi.columns

    for _, row in cpi.iterrows():
        release_date = row["date"]
        actual = float(row["cpi_actual"]) if "cpi_actual" in row else float(row.iloc[1])
        estimate = float(row["cpi_estimate"]) if has_estimate else np.nan

        surprise_bps = (actual - estimate) * 100 if not np.isnan(estimate) else np.nan
        surprise_type = classify_surprise(surprise_bps)

        # Asset reactions
        nifty_react = {}
        usdinr_react = {}
        gsec_react = {}

        for window in FORWARD_WINDOWS:
            post_date = release_date + pd.Timedelta(days=window)
            ref_nifty = float(nifty[nifty_col].asof(release_date)) if not nifty.empty else np.nan
            post_nifty = float(nifty[nifty_col].asof(post_date)) if not nifty.empty else np.nan
            if ref_nifty > 0 and post_nifty > 0:
                nifty_react[f"nifty_{window}d_pct"] = float((post_nifty / ref_nifty - 1) * 100)

            ref_usdinr = float(usdinr[usdinr_col].asof(release_date)) if not usdinr.empty else np.nan
            post_usdinr = float(usdinr[usdinr_col].asof(post_date)) if not usdinr.empty else np.nan
            if ref_usdinr > 0 and post_usdinr > 0:
                usdinr_react[f"usdinr_{window}d_pct"] = float((post_usdinr / ref_usdinr - 1) * 100)

        # Strategy: short NIFTY when CPI surprises to upside
        if not np.isnan(surprise_bps):
            direction = -1 if surprise_bps > SURPRISE_MATERIAL_BPS else (1 if surprise_bps < -SURPRISE_MATERIAL_BPS else 0)
        else:
            direction = 0

        if direction != 0:
            nifty_entry = float(nifty[nifty_col].asof(release_date)) if not nifty.empty else np.nan
            nifty_exit = float(nifty[nifty_col].asof(release_date + pd.Timedelta(days=5))) if not nifty.empty else np.nan
            if nifty_entry > 0 and nifty_exit > 0:
                pnl = direction * (nifty_exit / nifty_entry - 1)
                trade_pnls.append(pnl)

        record = {
            "date": release_date.date(),
            "cpi_actual": float(actual),
            "cpi_estimate": float(estimate) if not np.isnan(estimate) else None,
            "surprise_bps": float(surprise_bps) if not np.isnan(surprise_bps) else None,
            "surprise_type": surprise_type,
            "core_cpi": float(row.get("core_cpi", np.nan)) if "core_cpi" in row.index else None,
            "food_cpi": float(row.get("food_cpi", np.nan)) if "food_cpi" in row.index else None,
        }
        record.update(nifty_react)
        record.update(usdinr_react)
        event_records.append(record)

    if event_records:
        ev_df = pd.DataFrame(event_records)
        ev_df.sort_values("date").to_csv(os.path.join(cfg.outdir, "cpi_surprise_events.csv"), index=False)

        # Surprise quartile analysis
        if has_estimate:
            ev_df["surprise_quartile"] = pd.qcut(ev_df["surprise_bps"].dropna(), q=4,
                                                  labels=["Q1_downside", "Q2", "Q3", "Q4_upside"],
                                                  duplicates="drop")
            fwd_col = "nifty_5d_pct" if "nifty_5d_pct" in ev_df.columns else None
            if fwd_col:
                regime = ev_df.groupby("surprise_quartile")[fwd_col].agg(["mean", "std", "count"]).reset_index()
                regime.columns = ["surprise_quartile", "avg_nifty_fwd_5d_pct", "std", "n_obs"]
                regime.to_csv(os.path.join(cfg.outdir, "surprise_regime_returns.csv"), index=False)

        # Core vs Food divergence
        if "core_cpi" in ev_df.columns and "food_cpi" in ev_df.columns:
            ev_df["core_food_gap"] = ev_df["core_cpi"] - ev_df["food_cpi"]
            ev_df["divergence_signal"] = ev_df["core_food_gap"].apply(
                lambda g: "core_led" if g > CORE_FOOD_DIVERGE_THRESHOLD else (
                    "food_led" if g < -CORE_FOOD_DIVERGE_THRESHOLD else "balanced"
                )
            )
            ev_df[["date", "core_cpi", "food_cpi", "core_food_gap", "divergence_signal"]].dropna().to_csv(
                os.path.join(cfg.outdir, "core_vs_food.csv"), index=False
            )

    if trade_pnls:
        rets = pd.Series(trade_pnls)
        cum = (1 + rets).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(rets.mean() / rets.std() * np.sqrt(12)) if rets.std() > 0 else None
        win_rate = float((rets > 0).mean())
    else:
        sharpe = win_rate = None

    summary = {
        "n_cpi_releases": len(event_records),
        "avg_cpi_actual": float(np.mean([r["cpi_actual"] for r in event_records])),
        "n_upside_surprises": int(sum(1 for r in event_records if (r.get("surprise_bps") or 0) > SURPRISE_MATERIAL_BPS)),
        "n_downside_surprises": int(sum(1 for r in event_records if (r.get("surprise_bps") or 0) < -SURPRISE_MATERIAL_BPS)),
        "win_rate": win_rate,
        "sharpe": sharpe,
        "params": {"surprise_threshold_bps": SURPRISE_MATERIAL_BPS}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India CPI Surprise | {len(event_records)} releases | Win rate: {win_rate:.1% if win_rate else 'N/A'} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cpi", required=True, dest="cpi_file")
    ap.add_argument("--nifty", required=True, dest="nifty_file")
    ap.add_argument("--usdinr", required=True, dest="usdinr_file")
    ap.add_argument("--gsec10", default=None, dest="gsec10_file")
    ap.add_argument("--outdir", default="./artifacts/india_cpi_surprise")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
