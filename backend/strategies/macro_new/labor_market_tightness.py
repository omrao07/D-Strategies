#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
labor_market_tightness.py — Labor market tightness drives Fed policy & sector rotation
=======================================================================================
JOLTS job openings / unemployed workers = tightness ratio. Extreme tightness → Fed
hikes → financials/defensives outperform. Cooling labor → Fed cuts → tech/growth
outperform. This strategy uses labor market indicators to time sector rotation.

Inputs (CSV)
------------
--labor    labor_market.csv
    Columns: date, country, unemployment_rate_pct, job_openings_k, labor_force_k,
             nonfarm_payrolls_k, avg_hourly_earnings_yoy_pct, quit_rate_pct
--assets   asset_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/labor_signals.csv        date, tightness_ratio, wage_growth, regime, signal
outdir/sector_by_labor.csv      average sector return by labor regime
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


SECTOR_MAP = {
    "tight_hot": {"XLF": 1, "XLE": 0.5, "XLK": -0.5, "TLT": -1},        # Rate hikes → financials up, tech/bonds down
    "tight_cooling": {"XLK": 0.5, "XLY": 0.5, "XLF": 0, "TLT": 0.5},   # Peak tightness → start rotation to growth
    "normal": {},
    "loose_cooling": {"XLK": 1, "XLY": 0.5, "TLT": 1, "XLF": -0.5},    # Rate cuts → tech/bonds rally
    "slack": {"TLT": 1, "XLU": 0.5, "XLP": 0.5, "XLK": 0.5}             # Recession → defensive + bonds
}


def compute_tightness(row: pd.Series) -> float:
    openings = row.get("job_openings_k", np.nan)
    unemployed = row.get("unemployment_rate_pct", np.nan)
    lf = row.get("labor_force_k", np.nan)
    if np.isnan(openings) or np.isnan(unemployed) or np.isnan(lf):
        return np.nan
    unemployed_k = unemployed / 100 * lf
    return float(openings / max(unemployed_k, 1))


def classify_labor_regime(tightness_z: float, wage_yoy: float) -> str:
    if np.isnan(tightness_z):
        return "normal"
    if tightness_z > 1.5 and (not np.isnan(wage_yoy) and wage_yoy > 5):
        return "tight_hot"
    elif tightness_z > 0.5:
        return "tight_cooling"
    elif tightness_z < -1.5:
        return "slack"
    elif tightness_z < -0.5:
        return "loose_cooling"
    return "normal"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    labor = pd.read_csv(cfg.labor_file, parse_dates=["date"])
    labor.columns = [c.lower().strip() for c in labor.columns]
    assets = pd.read_csv(cfg.assets_file, parse_dates=["date"])
    assets.columns = [c.lower().strip() for c in assets.columns]
    ret_wide = assets.pivot(index="date", columns="ticker", values="return").sort_index()

    labor["tightness_ratio"] = labor.apply(compute_tightness, axis=1)
    labor = labor.set_index("date").sort_index()
    labor["tightness_zscore"] = (labor["tightness_ratio"] - labor["tightness_ratio"].rolling(24, min_periods=6).mean()) / \
                                  labor["tightness_ratio"].rolling(24, min_periods=6).std().replace(0, np.nan)
    wage_col = "avg_hourly_earnings_yoy_pct" if "avg_hourly_earnings_yoy_pct" in labor.columns else None
    labor["regime"] = labor.apply(
        lambda r: classify_labor_regime(r.get("tightness_zscore", np.nan),
                                        r.get(wage_col, np.nan) if wage_col else np.nan), axis=1
    )

    labor_records = []
    for date, row in labor.iterrows():
        labor_records.append({
            "date": date,
            "unemployment_rate_pct": float(row.get("unemployment_rate_pct", np.nan)),
            "tightness_ratio": float(row.get("tightness_ratio", np.nan)) if not np.isnan(row.get("tightness_ratio", np.nan)) else None,
            "tightness_zscore": float(row.get("tightness_zscore", np.nan)) if not np.isnan(row.get("tightness_zscore", np.nan)) else None,
            "wage_growth_yoy": float(row.get(wage_col, np.nan)) if wage_col and not np.isnan(row.get(wage_col, np.nan)) else None,
            "regime": row["regime"]
        })

    labor_df = pd.DataFrame(labor_records).sort_values("date")
    labor_df.to_csv(os.path.join(cfg.outdir, "labor_signals.csv"), index=False)

    # Sector returns by labor regime
    regime_daily = labor["regime"].reindex(ret_wide.index, method="ffill")
    sector_records = []
    for ticker in ret_wide.columns:
        for regime in SECTOR_MAP:
            regime_mask = regime_daily == regime
            ret_in = ret_wide.loc[regime_mask, ticker].dropna()
            if len(ret_in) > 5:
                sector_records.append({
                    "ticker": ticker, "regime": regime,
                    "avg_daily_ret": float(ret_in.mean()),
                    "ann_ret": float(ret_in.mean() * 252), "n_days": len(ret_in)
                })
    if sector_records:
        pd.DataFrame(sector_records).to_csv(os.path.join(cfg.outdir, "sector_by_labor.csv"), index=False)

    # Backtest
    all_daily = []
    for ticker in ret_wide.columns:
        pos = regime_daily.apply(lambda r: SECTOR_MAP.get(r, {}).get(ticker, 0))
        strat = pos.shift(1) * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).sum(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    regime_dist = labor_df["regime"].value_counts().to_dict()
    summary = {
        "n_obs": len(labor_df), "regime_distribution": regime_dist,
        "current_regime": str(labor_df["regime"].iloc[-1]) if not labor_df.empty else None,
        "latest_tightness_ratio": float(labor_df["tightness_ratio"].dropna().iloc[-1]) if not labor_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Labor tightness | Regime: {summary['current_regime']} | Tightness: {f'{summary['latest_tightness_ratio']:.2f}' if summary['latest_tightness_ratio'] else 'N/A'} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labor", required=True, dest="labor_file")
    ap.add_argument("--assets", required=True, dest="assets_file")
    ap.add_argument("--outdir", default="./artifacts/labor_tightness")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
