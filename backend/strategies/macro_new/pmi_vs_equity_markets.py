#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pmi_vs_equity_markets.py — PMI regime drives sector & equity market rotation
==============================================================================
ISM/Markit PMI crossing 50 (expansion/contraction) is a reliable leading
indicator for equity markets. PMI momentum (accelerating expansion vs decelerating)
drives sector rotation: Materials/Industrials outperform in PMI acceleration;
Defensives outperform in PMI deceleration.

Inputs (CSV)
------------
--pmi      pmi_data.csv
    Columns: date, country, pmi_composite, pmi_manufacturing, pmi_services
--returns  asset_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/pmi_regime.csv           date, country, pmi, regime, signal
outdir/sector_vs_pmi.csv        average return by sector and PMI regime
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


PMI_REGIMES = {
    "strong_expansion": (55, np.inf),
    "expansion": (50, 55),
    "contraction": (45, 50),
    "deep_contraction": (-np.inf, 45)
}

SECTOR_PREFERENCES = {
    "strong_expansion": ["XLB", "XLI", "XLE", "XLK"],     # Materials, Industrials, Energy, Tech
    "expansion": ["XLK", "XLY", "XLF"],                    # Tech, Discretionary, Financials
    "contraction": ["XLU", "XLP", "XLV", "TLT"],           # Utilities, Staples, Healthcare, Bonds
    "deep_contraction": ["XLU", "XLP", "GLD", "TLT"]       # Max defensive
}


def classify_pmi_regime(pmi: float) -> str:
    for regime, (lo, hi) in PMI_REGIMES.items():
        if lo <= pmi < hi:
            return regime
    return "contraction"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    pmi = pd.read_csv(cfg.pmi_file, parse_dates=["date"])
    pmi.columns = [c.lower().strip() for c in pmi.columns]
    rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    rets.columns = [c.lower().strip() for c in rets.columns]
    ret_wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()

    pmi_col = "pmi_composite" if "pmi_composite" in pmi.columns else \
              "pmi_manufacturing" if "pmi_manufacturing" in pmi.columns else pmi.columns[2]

    pmi_records = []
    all_daily = []

    for country in pmi["country"].unique():
        sub = pmi[pmi["country"] == country].set_index("date").sort_index()
        if len(sub) < 6:
            continue

        sub["regime"] = sub[pmi_col].apply(classify_pmi_regime)
        sub["pmi_mom"] = sub[pmi_col].diff(1)
        sub["pmi_3m_chg"] = sub[pmi_col].diff(3)

        # Resteepening vs. decelerating within expansion
        sub["signal"] = sub.apply(
            lambda r: "accelerating_expansion" if (r["regime"] in ("expansion", "strong_expansion") and r["pmi_mom"] > 0)
                      else ("decelerating_expansion" if (r["regime"] in ("expansion", "strong_expansion") and r["pmi_mom"] < 0)
                            else ("recovery" if (r["regime"] == "contraction" and r["pmi_mom"] > 0)
                                  else ("recession" if r["regime"] == "deep_contraction" else "stable_contraction"))), axis=1
        )

        for date, row in sub.iterrows():
            pmi_records.append({
                "date": date, "country": country,
                "pmi": float(row[pmi_col]),
                "pmi_mom": float(row["pmi_mom"]) if not np.isnan(row["pmi_mom"]) else None,
                "pmi_3m_chg": float(row["pmi_3m_chg"]) if not np.isnan(row["pmi_3m_chg"]) else None,
                "regime": row["regime"], "signal": row["signal"]
            })

        # Backtest on preferred sectors for this country's PMI
        pmi_daily = sub["regime"].reindex(ret_wide.index).ffill()
        for ticker in ret_wide.columns:
            preferred_regimes = [r for r, tickers in SECTOR_PREFERENCES.items() if ticker in tickers]
            if preferred_regimes:
                pos = pmi_daily.apply(lambda r: 1 if r in preferred_regimes else 0)
                strat = pos.shift(1) * ret_wide[ticker]
                all_daily.append(strat.rename(f"{ticker}_{country}"))

    pmi_df = pd.DataFrame(pmi_records).sort_values("date")
    pmi_df.to_csv(os.path.join(cfg.outdir, "pmi_regime.csv"), index=False)

    # Sector vs PMI regime returns
    sector_records = []
    for ticker in ret_wide.columns:
        for regime in PMI_REGIMES:
            regime_dates = pmi_df[pmi_df["regime"] == regime]["date"].unique()
            ret_in_regime = ret_wide[ticker].reindex(pd.DatetimeIndex(regime_dates)).dropna()
            if len(ret_in_regime) > 5:
                sector_records.append({
                    "ticker": ticker, "regime": regime,
                    "avg_daily_ret": float(ret_in_regime.mean()),
                    "ann_ret": float(ret_in_regime.mean() * 252), "n": len(ret_in_regime)
                })
    if sector_records:
        pd.DataFrame(sector_records).to_csv(os.path.join(cfg.outdir, "sector_vs_pmi.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    regime_dist = pmi_df["regime"].value_counts().to_dict() if not pmi_df.empty else {}
    summary = {
        "countries_analyzed": pmi["country"].nunique(), "n_pmi_obs": len(pmi_df),
        "regime_distribution": regime_dist, "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"PMI regime | Countries: {summary['countries_analyzed']} | Regimes: {regime_dist} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pmi", required=True, dest="pmi_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/pmi_equity")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
