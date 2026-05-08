#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cpi_vs_core_cpi_divergence.py — Headline vs core CPI divergence → commodity & sector plays
=============================================================================================
When headline CPI (includes food/energy) diverges sharply from core CPI, it signals
commodity-driven inflation vs. persistent demand-side inflation. Large headline > core
→ long energy/agriculture; Large core > headline → Fed tightening risk → short bonds.

Inputs (CSV)
------------
--cpi      cpi_data.csv
    Columns: date, country, headline_yoy_pct, core_yoy_pct, energy_yoy_pct, food_yoy_pct,
             services_yoy_pct, goods_yoy_pct
--assets   asset_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/cpi_divergence.csv       date, country, headline, core, divergence_bp, regime, signal
outdir/asset_regime_returns.csv avg return by inflation regime
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


INFLATION_REGIMES = {
    "commodity_inflation": "headline >> core",   # Energy/food driving
    "demand_inflation": "core >> headline",       # Services/wages driving
    "disinflation": "both declining",
    "deflation": "both negative",
    "stagflation": "high both",
    "balanced": "headline ≈ core"
}

ASSET_REGIME_MAP = {
    "commodity_inflation": {"XLE": 1, "GLD": 1, "DBA": 1, "TLT": -1, "XLK": -0.5},
    "demand_inflation": {"TLT": -1, "XLF": 0.5, "XLK": -0.5, "XLP": 0.5},
    "disinflation": {"TLT": 1, "XLK": 1, "XLY": 0.5},
    "deflation": {"TLT": 1, "XLU": 1, "GLD": 0.5, "XLK": -0.5},
    "stagflation": {"GLD": 1, "XLE": 0.5, "TLT": -1, "XLK": -1},
    "balanced": {}
}


def classify_inflation_regime(headline: float, core: float, energy: float = np.nan) -> str:
    if np.isnan(headline) or np.isnan(core):
        return "balanced"
    div = headline - core
    if headline < 0 and core < 0:
        return "deflation"
    if headline > 5 and core > 4:
        return "stagflation"
    if div > 1.5 and not np.isnan(energy) and energy > 10:
        return "commodity_inflation"
    if div < -1.5:
        return "demand_inflation"
    if headline < 2 and core < 2:
        return "disinflation"
    return "balanced"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    cpi = pd.read_csv(cfg.cpi_file, parse_dates=["date"])
    cpi.columns = [c.lower().strip() for c in cpi.columns]
    assets = pd.read_csv(cfg.assets_file, parse_dates=["date"])
    assets.columns = [c.lower().strip() for c in assets.columns]
    ret_wide = assets.pivot(index="date", columns="ticker", values="return").sort_index()

    cpi_records = []
    for _, row in cpi.iterrows():
        headline = row.get("headline_yoy_pct", np.nan)
        core = row.get("core_yoy_pct", np.nan)
        energy = row.get("energy_yoy_pct", np.nan)
        div = (headline - core) * 100 if not (np.isnan(headline) or np.isnan(core)) else np.nan
        regime = classify_inflation_regime(headline, core, energy)
        asset_biases = ASSET_REGIME_MAP.get(regime, {})
        signal_text = f"long_{'+'.join(k for k,v in asset_biases.items() if v > 0)}_short_{'+'.join(k for k,v in asset_biases.items() if v < 0)}" if asset_biases else "neutral"
        cpi_records.append({
            "date": row["date"], "country": row.get("country", "US"),
            "headline_yoy_pct": float(headline) if not np.isnan(headline) else None,
            "core_yoy_pct": float(core) if not np.isnan(core) else None,
            "energy_yoy_pct": float(energy) if not np.isnan(energy) else None,
            "divergence_bp": float(div) if not np.isnan(div) else None,
            "services_yoy_pct": float(row.get("services_yoy_pct", np.nan)) if not np.isnan(row.get("services_yoy_pct", np.nan)) else None,
            "regime": regime, "signal": signal_text
        })

    cpi_df = pd.DataFrame(cpi_records).sort_values("date")
    cpi_df.to_csv(os.path.join(cfg.outdir, "cpi_divergence.csv"), index=False)

    # Asset returns by regime
    regime_returns = []
    cpi_daily = cpi_df.set_index("date")["regime"].reindex(ret_wide.index, method="ffill")
    for ticker in ret_wide.columns:
        for regime in ASSET_REGIME_MAP:
            regime_mask = cpi_daily == regime
            ret_in = ret_wide.loc[regime_mask, ticker].dropna()
            if len(ret_in) > 5:
                regime_returns.append({
                    "ticker": ticker, "regime": regime,
                    "n_days": len(ret_in), "avg_daily_ret": float(ret_in.mean()),
                    "ann_ret": float(ret_in.mean() * 252)
                })
    if regime_returns:
        pd.DataFrame(regime_returns).to_csv(os.path.join(cfg.outdir, "asset_regime_returns.csv"), index=False)

    # Backtest: regime-based allocation
    all_daily = []
    cpi_regime_daily = cpi_daily.dropna()
    for ticker in ret_wide.columns:
        def get_weight(regime):
            return ASSET_REGIME_MAP.get(regime, {}).get(ticker, 0)
        pos = cpi_regime_daily.apply(get_weight)
        pos_aligned = pos.reindex(ret_wide.index, method="ffill").shift(1).fillna(0)
        strat = pos_aligned * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).sum(axis=1).dropna()  # sum because weights already specify allocation
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    regime_dist = cpi_df["regime"].value_counts().to_dict()
    summary = {
        "n_obs": len(cpi_df), "regime_distribution": regime_dist,
        "current_regime": str(cpi_df["regime"].iloc[-1]),
        "avg_headline_yoy": float(cpi_df["headline_yoy_pct"].dropna().mean()),
        "avg_core_yoy": float(cpi_df["core_yoy_pct"].dropna().mean()),
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"CPI divergence | Regime: {summary['current_regime']} | Headline: {summary['avg_headline_yoy']:.1f}% | Core: {summary['avg_core_yoy']:.1f}% | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cpi", required=True, dest="cpi_file")
    ap.add_argument("--assets", required=True, dest="assets_file")
    ap.add_argument("--outdir", default="./artifacts/cpi_divergence")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
