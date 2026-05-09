#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
high_yield_credit_cycle.py — HY credit cycle timing via spreads & fundamentals
================================================================================
High yield credit spreads are a leading indicator of the credit cycle.
OAS < 300bp + tightening trend → risk-on (lever up). OAS > 700bp + widening →
credit stress → risk-off. Strategy times entry/exit in HY bonds and equities.

Inputs (CSV)
------------
--spreads  hy_spreads.csv
    Columns: date, oas_bp, ig_oas_bp, hy_ig_ratio, default_rate_pct
--assets   asset_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/credit_cycle.csv         date, oas_bp, zscore, cycle_phase, signal
outdir/spread_vs_returns.csv    spread changes vs forward equity/HY returns
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


HY_PHASES = {
    "tightening_bull": (0, 300),
    "fair_value": (300, 500),
    "moderate_stress": (500, 700),
    "distress": (700, 1000),
    "crisis": (1000, np.inf)
}


def classify_hy_phase(oas: float) -> str:
    for phase, (lo, hi) in HY_PHASES.items():
        if lo <= oas < hi:
            return phase
    return "crisis"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    spreads = pd.read_csv(cfg.spreads_file, parse_dates=["date"])
    spreads.columns = [c.lower().strip() for c in spreads.columns]
    spreads = spreads.set_index("date").sort_index()
    assets = pd.read_csv(cfg.assets_file, parse_dates=["date"])
    assets.columns = [c.lower().strip() for c in assets.columns]
    ret_wide = assets.pivot(index="date", columns="ticker", values="return").sort_index()

    oas_col = "oas_bp" if "oas_bp" in spreads.columns else spreads.columns[0]
    spreads["phase"] = spreads[oas_col].apply(classify_hy_phase)
    spreads["oas_zscore"] = (spreads[oas_col] - spreads[oas_col].rolling(252).mean()) / \
                             spreads[oas_col].rolling(252).std().replace(0, np.nan)
    spreads["oas_30d_chg"] = spreads[oas_col].diff(30)
    spreads["oas_ma20"] = spreads[oas_col].rolling(20).mean()
    spreads["oas_trend"] = spreads["oas_ma20"].diff(20)  # tightening if negative

    def make_signal(row):
        phase = row["phase"]
        trend = row.get("oas_trend", 0) or 0
        oas = row[oas_col]
        if phase == "tightening_bull" and trend < 0:
            return "max_risk_on"
        elif phase in ("tightening_bull", "fair_value") and trend < 0:
            return "risk_on"
        elif phase in ("fair_value", "moderate_stress") and trend > 0:
            return "reduce_risk"
        elif phase in ("distress", "crisis"):
            return "risk_off" if trend > 0 else "distressed_buy"  # mean reversion in crisis
        return "neutral"

    spreads["signal"] = spreads.apply(make_signal, axis=1)

    cycle_records = []
    for date, row in spreads.iterrows():
        cycle_records.append({
            "date": date, "oas_bp": float(row[oas_col]),
            "ig_oas_bp": float(row.get("ig_oas_bp", np.nan)) if not np.isnan(row.get("ig_oas_bp", np.nan)) else None,
            "oas_zscore": float(row.get("oas_zscore", np.nan)) if not np.isnan(row.get("oas_zscore", np.nan)) else None,
            "oas_trend": float(row.get("oas_trend", np.nan)) if not np.isnan(row.get("oas_trend", np.nan)) else None,
            "default_rate_pct": float(row.get("default_rate_pct", np.nan)) if not np.isnan(row.get("default_rate_pct", np.nan)) else None,
            "cycle_phase": row["phase"], "signal": row["signal"]
        })

    cycle_df = pd.DataFrame(cycle_records).sort_values("date")
    cycle_df.to_csv(os.path.join(cfg.outdir, "credit_cycle.csv"), index=False)

    # Spread changes vs forward returns
    corr_records = []
    for ticker in ret_wide.columns:
        for horizon in [5, 21, 63]:
            fwd = ret_wide[ticker].rolling(horizon).sum().shift(-horizon)
            oas_chg = spreads["oas_30d_chg"].reindex(ret_wide.index, method="ffill").dropna()
            aligned = oas_chg.align(fwd.dropna(), join="inner")
            if len(aligned[0]) > 20:
                r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
                corr_records.append({"ticker": ticker, "horizon_days": horizon, "oas_chg_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

    corr_df = pd.DataFrame(corr_records) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "spread_vs_returns.csv"), index=False)

    # Backtest
    SIGNAL_POS = {"max_risk_on": 1, "risk_on": 0.5, "neutral": 0, "reduce_risk": -0.5, "risk_off": -1, "distressed_buy": 1}
    all_daily = []
    for ticker in ret_wide.columns:
        pos = spreads["signal"].map(SIGNAL_POS).fillna(0).reindex(ret_wide.index, method="ffill").shift(1).fillna(0)
        strat = pos * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    current_oas = float(spreads[oas_col].iloc[-1])
    summary = {
        "current_oas_bp": current_oas, "current_phase": str(spreads["phase"].iloc[-1]),
        "avg_oas_bp": float(spreads[oas_col].mean()), "max_oas_bp": float(spreads[oas_col].max()),
        "pct_in_distress_crisis": float(spreads["phase"].isin(["distress", "crisis"]).mean()),
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"HY credit cycle | OAS: {current_oas:.0f}bp | Phase: {summary['current_phase']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spreads", required=True, dest="spreads_file")
    ap.add_argument("--assets", required=True, dest="assets_file")
    ap.add_argument("--outdir", default="./artifacts/hy_credit_cycle")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
