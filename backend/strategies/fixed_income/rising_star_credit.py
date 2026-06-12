#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rising_star_credit.py — Rising stars (HY→IG upgrades) → pre-upgrade long alpha
=================================================================================
Rising stars are HY bonds upgraded to investment grade. IG-constrained funds must
buy upon upgrade. Pre-positioning 3-6 months before expected upgrades captures
the spread tightening as upgrade probability increases.

Inputs (CSV)
------------
--bonds    hy_bonds.csv
    Columns: date, issuer, ticker, rating, rating_outlook, spread_bps,
             leverage_ratio, interest_coverage, revenue_growth_pct, sector
--upgrades upgrade_history.csv (optional, for backtesting signal quality)
    Columns: date, issuer, old_rating, new_rating

Outputs
-------
outdir/upgrade_candidates.csv   date, issuer, upgrade_score, signal
outdir/pre_upgrade_returns.csv  return analysis pre/post upgrade
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd


def compute_upgrade_score(row: pd.Series) -> float:
    """
    Score = composite of credit fundamentals that predict upgrade.
    Higher = more likely to be upgraded.
    """
    score = 0.0
    count = 0

    # Rating near IG boundary
    bb_plus_ratings = {"BB+", "BB", "ba1"}
    if str(row.get("rating", "")).upper() in {r.upper() for r in bb_plus_ratings}:
        score += 2
        count += 1

    # Positive outlook
    outlook = str(row.get("rating_outlook", "")).lower()
    if "positive" in outlook or "upgrade" in outlook:
        score += 2
        count += 1
    elif "stable" in outlook:
        score += 0.5
        count += 1
    elif "negative" in outlook:
        score -= 1
        count += 1

    # Low leverage (< 3x) is IG-like
    lev = row.get("leverage_ratio", np.nan)
    if not np.isnan(lev) and lev > 0:
        score += max(3 - min(lev, 6), 0)
        count += 1

    # High interest coverage (> 4x)
    ic = row.get("interest_coverage", np.nan)
    if not np.isnan(ic) and ic > 0:
        score += min(ic / 4, 2)
        count += 1

    # Positive revenue growth
    rev_g = row.get("revenue_growth_pct", np.nan)
    if not np.isnan(rev_g):
        score += 1 if rev_g > 5 else (0 if rev_g > 0 else -0.5)
        count += 1

    # Tight spread for HY (< 300bp)
    sp = row.get("spread_bps", np.nan)
    if not np.isnan(sp):
        score += max(3 - sp / 100, 0)
        count += 1

    return score / count if count > 0 else 0.0


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    bonds = pd.read_csv(cfg.bonds_file, parse_dates=["date"])
    bonds.columns = [c.lower().strip() for c in bonds.columns]

    upgrade_history = None
    if cfg.upgrades_file:
        upgrade_history = pd.read_csv(cfg.upgrades_file, parse_dates=["date"])
        upgrade_history.columns = [c.lower().strip() for c in upgrade_history.columns]

    bonds["upgrade_score"] = bonds.apply(compute_upgrade_score, axis=1)
    bonds["upgrade_score_zscore"] = bonds.groupby("date")["upgrade_score"].transform(
        lambda x: (x - x.mean()) / x.std() if x.std() > 0 else 0
    )

    candidate_records = []
    for _, row in bonds.iterrows():
        score = row["upgrade_score"]
        z = row.get("upgrade_score_zscore", 0) or 0
        signal = "strong_buy" if score > cfg.score_threshold * 1.5 else \
                 ("buy" if score > cfg.score_threshold else "neutral")
        candidate_records.append({
            "date": row["date"], "issuer": row.get("issuer", row.get("ticker", "Unknown")),
            "rating": row.get("rating", "BB"), "rating_outlook": row.get("rating_outlook", "stable"),
            "spread_bps": float(row.get("spread_bps", np.nan)) if not np.isnan(row.get("spread_bps", np.nan)) else None,
            "leverage_ratio": float(row.get("leverage_ratio", np.nan)) if not np.isnan(row.get("leverage_ratio", np.nan)) else None,
            "upgrade_score": float(score), "upgrade_score_zscore": float(z), "signal": signal
        })

    cand_df = pd.DataFrame(candidate_records).sort_values(["date", "upgrade_score"], ascending=[True, False])
    cand_df.to_csv(os.path.join(cfg.outdir, "upgrade_candidates.csv"), index=False)

    # Pre-upgrade return analysis (if upgrade history available)
    upgrade_ret_records = []
    if upgrade_history is not None:
        for _, upg in upgrade_history.iterrows():
            issuer = upg.get("issuer", "")
            dg_date = upg["date"]
            # Look up pre-upgrade candidate score
            pre = bonds[(bonds.get("issuer", pd.Series()) == issuer) if "issuer" in bonds.columns else (bonds["ticker"] == issuer)] if "issuer" in bonds.columns or "ticker" in bonds.columns else pd.DataFrame()
            if not pre.empty:
                pre = pre.set_index("date").sort_index()
                pre_score = pre.ffill()["upgrade_score"].get(dg_date, np.nan)
            else:
                pre_score = np.nan
            upgrade_ret_records.append({
                "issuer": issuer, "upgrade_date": dg_date,
                "old_rating": upg.get("old_rating", "BB"), "new_rating": upg.get("new_rating", "BBB-"),
                "pre_upgrade_score": float(pre_score) if not np.isnan(pre_score) else None
            })

    if upgrade_ret_records:
        pd.DataFrame(upgrade_ret_records).to_csv(os.path.join(cfg.outdir, "pre_upgrade_returns.csv"), index=False)

    # Backtest: systematic rising star pre-positioning
    buys = cand_df[cand_df["signal"].isin(["buy", "strong_buy"])].copy()
    # Simulated spread tightening return: 10bp tightening = ~0.7% price appreciation for 7yr duration
    buys["sim_return"] = buys["upgrade_score"] * 0.002  # 0.2% per score point
    cum_ret = (1 + buys.set_index("date")["sim_return"].sort_index()).cumprod()
    cum_ret.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    summary = {
        "n_bonds_analyzed": len(bonds), "n_candidates": int((cand_df["signal"] != "neutral").sum()),
        "n_strong_buy": int((cand_df["signal"] == "strong_buy").sum()),
        "avg_score_buy_signals": float(cand_df[cand_df["signal"] != "neutral"]["upgrade_score"].mean()) if not cand_df.empty else None,
        "avg_spread_buy_candidates_bps": float(cand_df[cand_df["signal"] != "neutral"]["spread_bps"].dropna().mean()) if not cand_df.empty else None,
        "params": {"score_threshold": cfg.score_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Rising stars | Analyzed: {summary['n_bonds_analyzed']} | Candidates: {summary['n_candidates']} | Strong buy: {summary['n_strong_buy']} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bonds", required=True, dest="bonds_file")
    ap.add_argument("--upgrades", default=None, dest="upgrades_file")
    ap.add_argument("--score-threshold", type=float, default=3.0)
    ap.add_argument("--outdir", default="./artifacts/rising_stars")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
