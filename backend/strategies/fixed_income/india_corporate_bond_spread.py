#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_corporate_bond_spread.py — India corporate bond vs G-Sec credit spread
=============================================================================
Tracks credit spreads for Indian corporate bonds vs equivalent G-Sec yield.
Spread widening occurs during credit stress (RBI NPA recognition, SEBI actions,
liquidity crises like IL&FS 2018, Yes Bank 2020). Spread compression occurs
during easy liquidity and strong corporate earnings.

Trades:
  - AAA corporate spread widening → buy corporates (short G-Sec equivalent)
  - Credit cycle turning → reduce exposure
  - NBFC vs Bank divergence → pairs trade

Inputs (CSV)
------------
--corp      corp.csv        date, issuer, rating (AAA/AA+/AA), tenor_yr, yield_pct
--gsec      gsec.csv        date, tenor_yr, gsec_yield_pct
--rbi       rbi.csv         date, repo_rate (optional)

Outputs
-------
outdir/credit_spreads.csv       date, rating, tenor, spread_bps, z_score, signal
outdir/rating_curve.csv         date, aaa_spread, aa_spread, rating_gap_bps
outdir/credit_cycle.csv         quarter, avg_spread_bps, credit_regime
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

PRIMARY_TENOR = 3    # 3-year corporate bond (most liquid in India)
RATINGS = ["AAA", "AA+", "AA", "AA-", "A+", "A"]
ZSCORE_WINDOW = 60
ENTRY_Z = 2.0
EXIT_Z = 0.5

# Historical spread ranges for Indian corporates (bps over G-Sec)
TYPICAL_SPREADS = {
    "AAA":  (50, 120),
    "AA+":  (80, 160),
    "AA":   (120, 250),
    "AA-":  (160, 350),
    "A+":   (200, 450),
    "A":    (250, 550),
}


def credit_regime(aaa_spread: float) -> str:
    if pd.isna(aaa_spread):
        return "unknown"
    if aaa_spread < 60:
        return "compressed"       # Rich — reduce positions
    elif aaa_spread < 90:
        return "normal"
    elif aaa_spread < 150:
        return "wide"             # Attractive — buy
    else:
        return "distressed"       # Systemic stress — be careful


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    corp = pd.read_csv(cfg.corp_file, parse_dates=["date"])
    corp.columns = [c.lower().strip() for c in corp.columns]

    gsec = pd.read_csv(cfg.gsec_file, parse_dates=["date"])
    gsec.columns = [c.lower().strip() for c in gsec.columns]
    gsec_pivot = gsec.pivot_table(index="date", columns="tenor_yr", values="gsec_yield_pct").sort_index()

    spread_records = []
    portfolio_rets = []

    for rating in RATINGS:
        if "rating" not in corp.columns:
            rating_corp = corp.copy()
        else:
            rating_corp = corp[corp["rating"].str.upper() == rating].copy()

        if rating_corp.empty:
            continue

        # Average yield by date for this rating and PRIMARY_TENOR
        if "tenor_yr" in rating_corp.columns:
            rating_corp = rating_corp[rating_corp["tenor_yr"].between(PRIMARY_TENOR - 1, PRIMARY_TENOR + 1)]

        corp_avg = rating_corp.groupby("date")["yield_pct"].mean()

        # Get G-Sec yield at matching tenor
        gsec_col = PRIMARY_TENOR if PRIMARY_TENOR in gsec_pivot.columns else \
                   min(gsec_pivot.columns, key=lambda c: abs(c - PRIMARY_TENOR))
        gsec_yield = gsec_pivot[gsec_col]

        common = corp_avg.index.intersection(gsec_yield.index)
        if len(common) < 30:
            continue

        merged = pd.DataFrame({
            "corp_yield": corp_avg.reindex(common),
            "gsec_yield": gsec_yield.reindex(common),
        }).dropna()

        merged["spread_bps"] = (merged["corp_yield"] - merged["gsec_yield"]) * 100

        mu = merged["spread_bps"].rolling(ZSCORE_WINDOW).mean()
        sigma = merged["spread_bps"].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
        merged["z_score"] = (merged["spread_bps"] - mu) / sigma

        pos = merged["z_score"].shift(1).apply(
            lambda z: 1 if z > ENTRY_Z else (0 if abs(z) < EXIT_Z else np.nan)
        ).ffill().fillna(0)

        duration_approx = PRIMARY_TENOR * 0.85
        spread_change = merged["spread_bps"].diff()
        pnl = pos * (-spread_change / 10000 * duration_approx)
        portfolio_rets.append(pnl.rename(f"{rating}_{PRIMARY_TENOR}Y"))

        for dt, row in merged.iterrows():
            spread_records.append({
                "date": dt.date(),
                "rating": rating,
                "tenor_yr": PRIMARY_TENOR,
                "corp_yield_pct": float(row["corp_yield"]),
                "gsec_yield_pct": float(row["gsec_yield"]),
                "spread_bps": float(row["spread_bps"]),
                "z_score": float(row["z_score"]) if not np.isnan(row["z_score"]) else None,
                "signal": "buy_corp" if pos.get(dt, 0) == 1 else "flat",
                "credit_regime": credit_regime(float(row["spread_bps"])),
            })

    pd.DataFrame(spread_records).sort_values(["date", "rating"]).to_csv(
        os.path.join(cfg.outdir, "credit_spreads.csv"), index=False
    )

    # Rating curve (AAA vs AA spread gap)
    sr_df = pd.DataFrame(spread_records)
    if "rating" in sr_df.columns and not sr_df.empty:
        sr_df["date"] = pd.to_datetime(sr_df["date"])
        aaa = sr_df[sr_df["rating"] == "AAA"].set_index("date")["spread_bps"]
        aa = sr_df[sr_df["rating"] == "AA"].set_index("date")["spread_bps"]
        rc = pd.DataFrame({"aaa_spread_bps": aaa, "aa_spread_bps": aa}).dropna()
        rc["rating_gap_bps"] = rc["aa_spread_bps"] - rc["aaa_spread_bps"]
        rc.to_csv(os.path.join(cfg.outdir, "rating_curve.csv"))

        # Quarterly credit regime
        sr_df["quarter"] = sr_df["date"].dt.to_period("Q")
        cycle = sr_df[sr_df["rating"] == "AAA"].groupby("quarter")["spread_bps"].mean().reset_index()
        cycle.columns = ["quarter", "avg_aaa_spread_bps"]
        cycle["credit_regime"] = cycle["avg_aaa_spread_bps"].apply(credit_regime)
        cycle.to_csv(os.path.join(cfg.outdir, "credit_cycle.csv"), index=False)

    if portfolio_rets:
        portfolio = pd.concat(portfolio_rets, axis=1).mean(axis=1).dropna()
        cum = (1 + portfolio).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(portfolio.mean() / portfolio.std() * np.sqrt(252)) if portfolio.std() > 0 else None
    else:
        sharpe = None
        portfolio = pd.Series(dtype=float)

    summary = {
        "n_ratings_tracked": len(portfolio_rets),
        "avg_aaa_spread_bps": float(sr_df[sr_df["rating"] == "AAA"]["spread_bps"].mean()) if not sr_df.empty and "rating" in sr_df.columns else None,
        "ann_return": float(portfolio.mean() * 252) if len(portfolio) > 0 else None,
        "sharpe": sharpe,
        "params": {"primary_tenor": PRIMARY_TENOR, "entry_z": ENTRY_Z}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India Corporate Bond Spread | {len(portfolio_rets)} ratings | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corp", required=True, dest="corp_file")
    ap.add_argument("--gsec", required=True, dest="gsec_file")
    ap.add_argument("--rbi", default=None, dest="rbi_file")
    ap.add_argument("--outdir", default="./artifacts/india_credit_spread")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
