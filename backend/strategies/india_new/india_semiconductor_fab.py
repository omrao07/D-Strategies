#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_semiconductor_fab.py — India semiconductor fab investment vs tech supply chain
=====================================================================================
India's PLI scheme for semiconductors (ISMC, Micron, Tata-PSMC) signals domestic
chip manufacturing ambition. Announcements → bullish for EMS players (Dixon, Kaynes,
Syrma), PCB manufacturers, and upstream raw material suppliers. Tracks fab capex
announcements, chip import substitution progress, and export momentum.

Inputs (CSV)
------------
--fab      fab_announcements.csv
    Columns: date, company, investment_bn_usd, category (fab/assembly/design),
             phase (announced/approved/construction/production), jobs_created
--imports  chip_imports.csv
    Columns: date, chip_import_value_crore, chip_export_value_crore
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/fab_signals.csv      date, fab_pipeline_bn, import_substitution_pct, signal
outdir/fab_timeline.csv     fab announcements with phase tracking
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


EMS_TICKERS = ["dixon", "kaynes", "syrma", "amber", "pgel", "ideaforge"]
PHASE_WEIGHTS = {"announced": 0.2, "approved": 0.5, "construction": 0.8, "production": 1.0}
SECTOR_WEIGHT = {"fab": 1.0, "assembly": 0.6, "design": 0.4}


def score_fab_pipeline(fab_df: pd.DataFrame, as_of_date) -> float:
    active = fab_df[fab_df["date"] <= as_of_date]
    if active.empty:
        return 0.0
    total = 0.0
    for _, row in active.iterrows():
        phase = str(row.get("phase", "announced")).lower()
        cat = str(row.get("category", "fab")).lower()
        inv = float(row.get("investment_bn_usd", 0))
        total += inv * PHASE_WEIGHTS.get(phase, 0.2) * SECTOR_WEIGHT.get(cat, 0.5)
    return total


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    fab = pd.read_csv(cfg.fab_file, parse_dates=["date"])
    fab.columns = [c.lower().strip() for c in fab.columns]
    fab = fab.sort_values("date")
    imports = pd.read_csv(cfg.imports_file, parse_dates=["date"])
    imports.columns = [c.lower().strip() for c in imports.columns]
    imports = imports.set_index("date").sort_index()
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    imp_col = "chip_import_value_crore" if "chip_import_value_crore" in imports.columns else imports.columns[0]
    exp_col = "chip_export_value_crore" if "chip_export_value_crore" in imports.columns else None

    if exp_col:
        imports["import_substitution_pct"] = imports[exp_col] / imports[imp_col].replace(0, np.nan) * 100
    imports["import_yoy_pct"] = imports[imp_col].pct_change(12) * 100

    # Build fab pipeline score for each date
    fab_timeline = []
    for date, row in fab.iterrows():
        fab_timeline.append({
            "date": date,
            "company": str(row.get("company", "")),
            "investment_bn_usd": float(row.get("investment_bn_usd", 0)),
            "category": str(row.get("category", "fab")),
            "phase": str(row.get("phase", "announced")),
            "jobs_created": int(row.get("jobs_created", 0)) if pd.notna(row.get("jobs_created")) else 0,
            "phase_weight": PHASE_WEIGHTS.get(str(row.get("phase", "announced")).lower(), 0.2)
        })

    fab_timeline_df = pd.DataFrame(fab_timeline)
    fab_timeline_df.to_csv(os.path.join(cfg.outdir, "fab_timeline.csv"), index=False)

    # Signal generation on monthly import data
    signal_records = []
    all_dates = imports.index.union(pd.DatetimeIndex([r["date"] for r in fab_timeline]))
    for date in sorted(imports.index):
        pipeline_score = score_fab_pipeline(fab, date)
        imp_sub = float(imports.loc[date, "import_substitution_pct"]) if "import_substitution_pct" in imports.columns and date in imports.index else np.nan
        import_yoy = float(imports.loc[date, "import_yoy_pct"]) if "import_yoy_pct" in imports.columns and date in imports.index else np.nan

        if pipeline_score > 5 and (np.isnan(imp_sub) or imp_sub > 5):
            signal = "strong_buy_ems"
        elif pipeline_score > 2:
            signal = "buy_ems"
        elif pipeline_score > 0:
            signal = "mild_buy_ems"
        else:
            signal = "neutral"

        # Declining imports signal → domestic production starting
        if not np.isnan(import_yoy) and import_yoy < -10 and pipeline_score > 1:
            signal = "strong_buy_ems"  # Import substitution accelerating

        signal_records.append({
            "date": date,
            "fab_pipeline_score_bn": float(pipeline_score),
            "import_substitution_pct": float(imp_sub) if not np.isnan(imp_sub) else None,
            "chip_import_yoy_pct": float(import_yoy) if not np.isnan(import_yoy) else None,
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "fab_signals.csv"), index=False)

    # Backtest on EMS stocks
    SIG_POS = {"strong_buy_ems": 1.5, "buy_ems": 1, "mild_buy_ems": 0.5, "neutral": 0}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for ticker in ret_wide.columns:
        if any(e in ticker.lower() for e in EMS_TICKERS):
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

    latest_pipeline = score_fab_pipeline(fab, fab["date"].max())
    summary = {
        "total_fab_announcements": len(fab_timeline),
        "total_investment_bn_usd": float(fab["investment_bn_usd"].sum()) if "investment_bn_usd" in fab.columns else None,
        "production_phase_count": int((fab["phase"].str.lower() == "production").sum()) if "phase" in fab.columns else 0,
        "latest_pipeline_score": float(latest_pipeline),
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India Semicon | Announcements: {summary['total_fab_announcements']} | Pipeline: ${latest_pipeline:.1f}bn | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fab", required=True, dest="fab_file")
    ap.add_argument("--imports", required=True, dest="imports_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/india_semicon")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
