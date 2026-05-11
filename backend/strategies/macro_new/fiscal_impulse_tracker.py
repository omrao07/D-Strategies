#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fiscal_impulse_tracker.py — Government fiscal impulse drives nominal growth & sectors
=======================================================================================
Fiscal impulse (year-on-year change in structural deficit as % of GDP) is a powerful
driver of nominal growth. Large positive impulse → infrastructure, defense, healthcare
outperform. Fiscal tightening → value/quality outperform as growth slows.

Inputs (CSV)
------------
--fiscal   fiscal_data.csv
    Columns: date, country, deficit_pct_gdp, gdp_growth_pct, spending_growth_pct,
             tax_revenue_growth_pct
--assets   asset_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/fiscal_signals.csv       date, country, fiscal_impulse_pct, regime, signal
outdir/sector_fiscal_returns.csv avg return by fiscal regime and ticker
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


FISCAL_REGIMES = {
    "large_stimulus": 2.0,     # Impulse > 2% of GDP
    "moderate_stimulus": 0.5,  # 0.5-2% of GDP
    "neutral": 0.0,
    "mild_tightening": -0.5,
    "large_tightening": -2.0
}

SECTOR_FISCAL_MAP = {
    "large_stimulus": {"XLI": 1, "XLB": 0.5, "XLV": 0.5, "XLK": 0.5, "TLT": -0.5},
    "moderate_stimulus": {"XLI": 0.5, "XLK": 0.5, "XLF": 0.5},
    "neutral": {},
    "mild_tightening": {"XLU": 0.5, "XLP": 0.5, "XLV": 0.5},
    "large_tightening": {"TLT": 1, "XLU": 1, "XLP": 0.5, "XLK": -0.5}
}


def classify_fiscal_regime(impulse_pct: float) -> str:
    if np.isnan(impulse_pct):
        return "neutral"
    if impulse_pct > FISCAL_REGIMES["large_stimulus"]:
        return "large_stimulus"
    elif impulse_pct > FISCAL_REGIMES["moderate_stimulus"]:
        return "moderate_stimulus"
    elif impulse_pct > FISCAL_REGIMES["neutral"]:
        return "neutral"
    elif impulse_pct > FISCAL_REGIMES["mild_tightening"]:
        return "mild_tightening"
    return "large_tightening"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    fiscal = pd.read_csv(cfg.fiscal_file, parse_dates=["date"])
    fiscal.columns = [c.lower().strip() for c in fiscal.columns]
    assets = pd.read_csv(cfg.assets_file, parse_dates=["date"])
    assets.columns = [c.lower().strip() for c in assets.columns]
    ret_wide = assets.pivot(index="date", columns="ticker", values="return").sort_index()

    fiscal["fiscal_impulse_pct"] = fiscal["deficit_pct_gdp"].diff(-1)  # Year-over-year change, sign convention
    if "spending_growth_pct" in fiscal.columns and "tax_revenue_growth_pct" in fiscal.columns:
        fiscal["spending_impulse"] = fiscal["spending_growth_pct"] - fiscal["spending_growth_pct"].shift(4)
        fiscal["revenue_drag"] = fiscal["tax_revenue_growth_pct"] - fiscal["tax_revenue_growth_pct"].shift(4)
    fiscal["regime"] = fiscal["fiscal_impulse_pct"].apply(classify_fiscal_regime)

    fiscal_records = []
    for _, row in fiscal.iterrows():
        fiscal_records.append({
            "date": row["date"], "country": row.get("country", "US"),
            "deficit_pct_gdp": float(row.get("deficit_pct_gdp", np.nan)),
            "fiscal_impulse_pct": float(row.get("fiscal_impulse_pct", np.nan)) if not np.isnan(row.get("fiscal_impulse_pct", np.nan)) else None,
            "gdp_growth_pct": float(row.get("gdp_growth_pct", np.nan)) if not np.isnan(row.get("gdp_growth_pct", np.nan)) else None,
            "regime": row["regime"]
        })

    fiscal_df = pd.DataFrame(fiscal_records).sort_values("date")
    fiscal_df.to_csv(os.path.join(cfg.outdir, "fiscal_signals.csv"), index=False)

    # Sector returns by fiscal regime
    regime_daily = fiscal_df.set_index("date")["regime"].reindex(ret_wide.index).ffill()
    sector_records = []
    for ticker in ret_wide.columns:
        for regime in SECTOR_FISCAL_MAP:
            mask = regime_daily == regime
            ret_in = ret_wide.loc[mask, ticker].dropna()
            if len(ret_in) > 10:
                sector_records.append({
                    "ticker": ticker, "regime": regime,
                    "avg_daily_ret": float(ret_in.mean()),
                    "ann_ret": float(ret_in.mean() * 252), "n_days": len(ret_in)
                })
    if sector_records:
        pd.DataFrame(sector_records).to_csv(os.path.join(cfg.outdir, "sector_fiscal_returns.csv"), index=False)

    # Backtest
    all_daily = []
    for ticker in ret_wide.columns:
        pos = regime_daily.apply(lambda r: SECTOR_FISCAL_MAP.get(r, {}).get(ticker, 0))
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

    regime_dist = fiscal_df["regime"].value_counts().to_dict()
    summary = {
        "n_obs": len(fiscal_df), "regime_distribution": regime_dist,
        "current_regime": str(fiscal_df["regime"].iloc[-1]) if not fiscal_df.empty else None,
        "avg_fiscal_impulse": float(fiscal_df["fiscal_impulse_pct"].dropna().mean()) if not fiscal_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Fiscal impulse | Regime: {summary['current_regime']} | Ann return: {ann_ret:.2%} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fiscal", required=True, dest="fiscal_file")
    ap.add_argument("--assets", required=True, dest="assets_file")
    ap.add_argument("--outdir", default="./artifacts/fiscal_impulse")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
