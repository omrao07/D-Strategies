#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_gsec_ois_spread.py — India G-Sec vs OIS (Overnight Index Swap) basis
===========================================================================
The spread between India Government Securities (G-Sec) yield and OIS rate
of the same tenor reflects:
  - Liquidity premium (G-Sec is less liquid than OIS)
  - Credit risk (sovereign vs interbank)
  - RBI monetary policy signaling

When G-Sec yields diverge significantly from OIS, it signals mispricings
that revert as bond auctions, FII flows, or RBI OMO/GSAP operations normalize.

India moat: India's OIS market (MIFOR-based) is small but growing. The G-Sec/OIS
basis blows out during RBI rate hike cycles and compresses post-cuts. No global
fund has systematic India G-Sec/OIS basis trades at institutional scale.

Inputs (CSV)
------------
--gsec      gsec.csv        date, tenor_yr, yield_pct   (G-Sec yields by tenor)
--ois       ois.csv         date, tenor_yr, rate_pct    (OIS rates by tenor)
--rbi       rbi.csv         date, repo_rate, crr, slr (optional, policy rates)
--liq       liquidity.csv   date, net_liquidity_cr (optional, RBI liquidity)

Outputs
-------
outdir/basis_by_tenor.csv       date, tenor, gsec_yield, ois_rate, basis_bps
outdir/basis_zscore.csv         date, tenor, basis_zscore, signal
outdir/rbi_correlation.csv      rbi_rate_change, basis_response
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

TENORS = [1, 2, 3, 5, 7, 10, 14, 30]  # years
ENTRY_Z = 2.0
EXIT_Z = 0.5
ZSCORE_WINDOW = 60
POSITION_TENOR = 10  # Primary trading tenor (10Y benchmark)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    gsec = pd.read_csv(cfg.gsec_file, parse_dates=["date"])
    gsec.columns = [c.lower().strip() for c in gsec.columns]
    ois = pd.read_csv(cfg.ois_file, parse_dates=["date"])
    ois.columns = [c.lower().strip() for c in ois.columns]

    # Pivot to wide format by tenor
    gsec_wide = gsec.pivot_table(index="date", columns="tenor_yr", values="yield_pct").sort_index()
    ois_wide = ois.pivot_table(index="date", columns="tenor_yr", values="rate_pct").sort_index()

    # Load optional data
    rbi_df = None
    if cfg.rbi_file and os.path.exists(cfg.rbi_file):
        rbi_df = pd.read_csv(cfg.rbi_file, parse_dates=["date"]).set_index("date").sort_index()
        rbi_df.columns = [c.lower().strip() for c in rbi_df.columns]

    liq_df = None
    if cfg.liq_file and os.path.exists(cfg.liq_file):
        liq_df = pd.read_csv(cfg.liq_file, parse_dates=["date"]).set_index("date").sort_index()
        liq_df.columns = [c.lower().strip() for c in liq_df.columns]

    # Compute basis (G-Sec yield - OIS rate) for each available tenor
    common_dates = gsec_wide.index.intersection(ois_wide.index)
    gsec_aligned = gsec_wide.reindex(common_dates)
    ois_aligned = ois_wide.reindex(common_dates)

    # Basis in bps
    basis = (gsec_aligned - ois_aligned) * 100  # convert % to bps

    basis_records = []
    for dt in common_dates:
        for tenor in TENORS:
            g = gsec_aligned.loc[dt, tenor] if tenor in gsec_aligned.columns else np.nan
            o = ois_aligned.loc[dt, tenor] if tenor in ois_aligned.columns else np.nan
            b = (g - o) * 100 if not (np.isnan(g) or np.isnan(o)) else np.nan
            if not np.isnan(b):
                basis_records.append({
                    "date": dt.date(),
                    "tenor_yr": tenor,
                    "gsec_yield_pct": float(g),
                    "ois_rate_pct": float(o),
                    "basis_bps": float(b),
                })

    basis_df = pd.DataFrame(basis_records)
    basis_df.to_csv(os.path.join(cfg.outdir, "basis_by_tenor.csv"), index=False)

    # Focus on primary trading tenor (10Y)
    if POSITION_TENOR in basis.columns:
        basis_10y = basis[POSITION_TENOR].dropna()
    else:
        avail_tenors = [c for c in basis.columns if c in TENORS]
        if not avail_tenors:
            print("No matching tenors found in data.")
            return
        basis_10y = basis[max(avail_tenors)].dropna()

    # Z-score based entry/exit
    mu = basis_10y.rolling(ZSCORE_WINDOW).mean()
    sigma = basis_10y.rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
    z = (basis_10y - mu) / sigma

    signal_records = []
    positions = []
    for dt in basis_10y.index:
        zi = z.get(dt, np.nan)
        bi = basis_10y.get(dt, np.nan)
        if np.isnan(zi):
            sig = "neutral"
            pos = 0.0
        elif zi > ENTRY_Z:
            # G-Sec rich vs OIS → G-Sec overpriced → short G-Sec (sell bond), buy OIS
            sig = "short_gsec_long_ois"
            pos = -1.0
        elif zi < -ENTRY_Z:
            # G-Sec cheap vs OIS → long G-Sec, short OIS
            sig = "long_gsec_short_ois"
            pos = 1.0
        elif abs(zi) < EXIT_Z:
            sig = "neutral"
            pos = 0.0
        else:
            sig = "hold"
            pos = np.nan

        signal_records.append({
            "date": dt.date(),
            "tenor_yr": POSITION_TENOR,
            "basis_bps": float(bi) if not np.isnan(bi) else None,
            "basis_zscore": float(zi) if not np.isnan(zi) else None,
            "signal": sig,
        })
        positions.append(pos)

    pd.DataFrame(signal_records).to_csv(os.path.join(cfg.outdir, "basis_zscore.csv"), index=False)

    # Backtest: P&L from mean-reversion of basis
    pos_s = pd.Series(positions, index=basis_10y.index).ffill().fillna(0).shift(1)
    basis_change = basis_10y.diff()  # bps/day
    strat_ret = pos_s * (-basis_change / 10000)  # Approximate duration effect (1 bps move ≈ 10-yr DV01)
    strat_ret = strat_ret.dropna()
    cum = (1 + strat_ret).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    # RBI policy correlation analysis
    if rbi_df is not None and "repo_rate" in rbi_df.columns:
        rbi_changes = rbi_df["repo_rate"].diff().dropna()
        rbi_changes = rbi_changes[rbi_changes != 0]
        rbi_corr = []
        for dt, chg in rbi_changes.items():
            # G-Sec/OIS basis response in 5-day window post change
            post_window = basis_10y.loc[dt:dt + pd.Timedelta(days=10)]
            if len(post_window) >= 3:
                basis_response = float(post_window.iloc[-1] - post_window.iloc[0])
                rbi_corr.append({"rbi_date": dt.date(), "rate_change_bps": float(chg * 100),
                                  "basis_response_5d_bps": basis_response})
        if rbi_corr:
            pd.DataFrame(rbi_corr).to_csv(os.path.join(cfg.outdir, "rbi_correlation.csv"), index=False)

    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(252)) if strat_ret.std() > 0 else None
    summary = {
        "avg_basis_bps": float(basis_10y.mean()),
        "basis_std_bps": float(basis_10y.std()),
        "pct_time_positive": float((basis_10y > 0).mean() * 100),
        "n_trade_days": int((pd.Series(positions) != 0).sum()),
        "ann_return": float(strat_ret.mean() * 252),
        "sharpe": sharpe,
        "params": {"entry_z": ENTRY_Z, "exit_z": EXIT_Z, "primary_tenor_yr": POSITION_TENOR}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India G-Sec/OIS Basis | Avg: {summary['avg_basis_bps']:.1f} bps | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gsec", required=True, dest="gsec_file")
    ap.add_argument("--ois", required=True, dest="ois_file")
    ap.add_argument("--rbi", default=None, dest="rbi_file")
    ap.add_argument("--liq", default=None, dest="liq_file")
    ap.add_argument("--outdir", default="./artifacts/gsec_ois_spread")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
