#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_current_account.py — India CAD/current account as macro regime signal
=============================================================================
India's Current Account Deficit (CAD) is a key macro variable driven by:
  - Oil imports (India imports ~87% of crude)
  - Gold imports (seasonal, Q4 high)
  - Services exports (IT, BPO surplus)
  - Remittances (inflows from Gulf, US, UK)

CAD widening:
  - Higher oil prices → INR pressure → import inflation → RBI hawkish
  - Wide CAD + low reserves → risk of EM contagion (2013 taper tantrum)

CAD narrowing:
  - IT services boom → USD inflows → INR strong
  - Oil price crash → import compression → RBI dovish space

Inputs (CSV)
------------
--cad       cad.csv         date, current_account_bn_usd, gdp_bn_usd (quarterly)
--oil       oil.csv         date, brent_usd (monthly/daily)
--remit     remit.csv       date, remittances_bn_usd (quarterly, optional)
--nifty     nifty.csv       date, nifty_close
--usdinr    usdinr.csv      date, usdinr_close

Outputs
-------
outdir/cad_signals.csv          date, cad_gdp_pct, oil_import_impact, cad_regime
outdir/oil_cad_nifty.csv        date, oil_price, implied_cad, nifty_impact_score
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

# CAD regimes (% of GDP)
CAD_COMFORTABLE = -1.5   # CAD < 1.5% GDP = comfortable
CAD_MODERATE = -2.5      # 1.5-2.5% = moderate
CAD_STRESS = -4.0        # > 4% = stress (2013 taper tantrum was 5%)

# Oil price impact on CAD (approximate: $10 oil rise → ~0.3% GDP CAD widening)
OIL_CAD_SENSITIVITY = -0.03  # $1 oil rise → 0.03% GDP CAD widening

FORWARD_QUARTERS = 2


def estimate_quarterly_cad(oil_price: float, base_cad_gdp: float) -> float:
    """Rough oil-adjusted CAD estimate."""
    oil_deviation = oil_price - 80  # Assume $80 = "normal" oil
    oil_impact = oil_deviation * OIL_CAD_SENSITIVITY
    return base_cad_gdp + oil_impact


def classify_cad_regime(cad_pct: float) -> str:
    if pd.isna(cad_pct):
        return "unknown"
    if cad_pct > CAD_COMFORTABLE:  # Less negative = better CAD
        return "surplus_or_comfortable"
    elif cad_pct > CAD_MODERATE:
        return "moderate_deficit"
    elif cad_pct > CAD_STRESS:
        return "wide_deficit"
    else:
        return "stress"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    cad = pd.read_csv(cfg.cad_file, parse_dates=["date"])
    cad.columns = [c.lower().strip() for c in cad.columns]
    ca_col = "current_account_bn_usd" if "current_account_bn_usd" in cad.columns else cad.columns[1]
    gdp_col = "gdp_bn_usd" if "gdp_bn_usd" in cad.columns else None

    oil = pd.read_csv(cfg.oil_file, parse_dates=["date"]).set_index("date").sort_index()
    oil.columns = [c.lower().strip() for c in oil.columns]
    oil_col = [c for c in oil.columns if "brent" in c or "crude" in c or "oil" in c][0]

    nifty = pd.read_csv(cfg.nifty_file, parse_dates=["date"]).set_index("date").sort_index()
    nifty.columns = [c.lower().strip() for c in nifty.columns]
    nifty_col = nifty.columns[0]

    usdinr = pd.read_csv(cfg.usdinr_file, parse_dates=["date"]).set_index("date").sort_index()
    usdinr.columns = [c.lower().strip() for c in usdinr.columns]
    usdinr_col = usdinr.columns[0]

    # Quarterly CAD data interpolated to monthly
    cad_quarterly = cad.set_index("date").sort_index()
    if gdp_col:
        cad_quarterly["cad_gdp_pct"] = (cad_quarterly[ca_col] / cad_quarterly[gdp_col] * 100)
    else:
        cad_quarterly["cad_gdp_pct"] = cad_quarterly[ca_col]  # Use absolute if no GDP

    cad_monthly = cad_quarterly["cad_gdp_pct"].resample("MS").interpolate(method="linear")

    # Daily oil + NIFTY data
    daily_oil = oil[[oil_col]].rename(columns={oil_col: "brent"})
    daily_nifty = nifty[[nifty_col]].rename(columns={nifty_col: "nifty"})
    daily_usdinr = usdinr[[usdinr_col]].rename(columns={usdinr_col: "usdinr"})

    data = daily_nifty.join(daily_usdinr).join(daily_oil)
    data["cad_gdp"] = cad_monthly.reindex(data.index).ffill()
    data["oil_implied_cad"] = data.apply(
        lambda r: estimate_quarterly_cad(r["brent"], r.get("cad_gdp", -2.0)), axis=1
    )
    data["cad_regime"] = data["cad_gdp"].apply(classify_cad_regime)
    data["oil_cad_regime"] = data["oil_implied_cad"].apply(classify_cad_regime)

    # NIFTY impact score: worse CAD = negative for NIFTY
    regime_nifty_map = {
        "surplus_or_comfortable": 0.5,
        "moderate_deficit": 0.0,
        "wide_deficit": -0.3,
        "stress": -1.0,
        "unknown": 0.0,
    }
    data["nifty_impact_score"] = data["oil_cad_regime"].map(regime_nifty_map).fillna(0)

    cad_records = []
    for dt, row in data.iterrows():
        cad_records.append({
            "date": dt.date(),
            "brent_usd": float(row["brent"]) if not np.isnan(row.get("brent", np.nan)) else None,
            "cad_gdp_pct": float(row["cad_gdp"]) if not np.isnan(row.get("cad_gdp", np.nan)) else None,
            "oil_implied_cad_gdp_pct": float(row["oil_implied_cad"]),
            "cad_regime": row["cad_regime"],
            "oil_cad_regime": row["oil_cad_regime"],
            "nifty_impact_score": float(row["nifty_impact_score"]),
            "usdinr": float(row["usdinr"]) if not np.isnan(row.get("usdinr", np.nan)) else None,
        })

    pd.DataFrame(cad_records).to_csv(os.path.join(cfg.outdir, "cad_signals.csv"), index=False)

    # Oil → CAD → NIFTY chain
    oil_cad_nifty = pd.DataFrame(cad_records).dropna(subset=["brent_usd"])
    oil_cad_nifty.to_csv(os.path.join(cfg.outdir, "oil_cad_nifty.csv"), index=False)

    # Backtest: use CAD regime to tilt NIFTY exposure
    pos = data["nifty_impact_score"].shift(1).fillna(0)
    nifty_ret = data["nifty"].pct_change()
    strat_ret = (pos * nifty_ret).dropna()
    cum = (1 + strat_ret).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(252)) if strat_ret.std() > 0 else None

    # Quarterly CAD analysis
    qtrly_analysis = data.resample("QS").agg({
        "cad_gdp": "mean",
        "brent": "mean",
        "nifty": "last",
    }).dropna()
    qtrly_analysis["nifty_qtr_return"] = qtrly_analysis["nifty"].pct_change() * 100
    qtrly_analysis["cad_regime"] = qtrly_analysis["cad_gdp"].apply(classify_cad_regime)

    summary = {
        "avg_cad_gdp_pct": float(data["cad_gdp"].dropna().mean()),
        "pct_comfortable": float((data["cad_regime"] == "surplus_or_comfortable").mean() * 100),
        "pct_stress": float((data["cad_regime"] == "stress").mean() * 100),
        "avg_brent": float(data["brent"].dropna().mean()),
        "ann_return": float(strat_ret.mean() * 252),
        "sharpe": sharpe,
        "params": {"cad_comfortable": CAD_COMFORTABLE, "cad_stress": CAD_STRESS}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India CAD Signal | Avg CAD: {summary['avg_cad_gdp_pct']:.1f}% GDP | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cad", required=True, dest="cad_file")
    ap.add_argument("--oil", required=True, dest="oil_file")
    ap.add_argument("--nifty", required=True, dest="nifty_file")
    ap.add_argument("--usdinr", required=True, dest="usdinr_file")
    ap.add_argument("--remit", default=None, dest="remit_file")
    ap.add_argument("--outdir", default="./artifacts/india_cad")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
