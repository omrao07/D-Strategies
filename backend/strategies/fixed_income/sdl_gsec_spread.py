#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sdl_gsec_spread.py — State Development Loans vs Central G-Sec spread
=====================================================================
State Development Loans (SDLs) are bonds issued by Indian state governments.
They trade at a spread over equivalent-maturity Central Government Securities
(G-Secs). This SDL-G-Sec spread reflects:
  - State fiscal health (FRBM compliance, revenue/fiscal deficit)
  - RBI OMO calendar (Centre vs State bond supply)
  - Investor preference for G-Sec SLR vs SDL SLR treatment
  - Liquidity premium (SDLs are less liquid than G-Secs)

Trading strategy: When SDL spread widens beyond historical norms, buy SDLs
(higher yield) and short equivalent G-Sec futures. Spread reverts as state
borrowing completes.

Inputs (CSV)
------------
--sdl       sdl.csv     date, state, tenor_yr, sdl_yield_pct
--gsec      gsec.csv    date, tenor_yr, gsec_yield_pct

Outputs
-------
outdir/sdl_gsec_spread.csv      date, state, tenor, sdl_yield, gsec_yield, spread_bps, z_score
outdir/state_comparison.csv     state, avg_spread_bps, spread_volatility, fiscal_rating
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd

PRIMARY_TENOR = 10
ZSCORE_WINDOW = 60
ENTRY_Z = 2.0
EXIT_Z = 0.5

# Approximate fiscal ratings for Indian states (2024)
STATE_FISCAL_RATING = {
    "MAHARASHTRA": "A",
    "GUJARAT": "A",
    "KARNATAKA": "A",
    "TAMILNADU": "B+",
    "RAJASTHAN": "B",
    "PUNJAB": "B-",
    "KERALA": "B",
    "ANDHRA": "B+",
    "TELANGANA": "B+",
    "WESTBENGAL": "B-",
    "UP": "B",
    "MP": "B+",
}


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    sdl = pd.read_csv(cfg.sdl_file, parse_dates=["date"])
    sdl.columns = [c.lower().strip() for c in sdl.columns]

    gsec = pd.read_csv(cfg.gsec_file, parse_dates=["date"])
    gsec.columns = [c.lower().strip() for c in gsec.columns]
    gsec_pivot = gsec.pivot_table(index="date", columns="tenor_yr", values="gsec_yield_pct").sort_index()

    spread_records = []
    state_stats = {}
    all_port = []

    for state in sdl["state"].unique() if "state" in sdl.columns else ["aggregate"]:
        if "state" in sdl.columns:
            state_sdl = sdl[sdl["state"] == state].copy()
        else:
            state_sdl = sdl.copy()

        # Focus on primary tenor
        if "tenor_yr" in state_sdl.columns:
            state_sdl = state_sdl[state_sdl["tenor_yr"] == PRIMARY_TENOR]

        state_sdl = state_sdl.set_index("date").sort_index()
        sdl_col = "sdl_yield_pct" if "sdl_yield_pct" in state_sdl.columns else state_sdl.columns[0]

        # Align with G-Sec
        if PRIMARY_TENOR not in gsec_pivot.columns:
            avail = [c for c in gsec_pivot.columns if abs(c - PRIMARY_TENOR) <= 2]
            if not avail:
                continue
            gsec_tenor = min(avail, key=lambda c: abs(c - PRIMARY_TENOR))
        else:
            gsec_tenor = PRIMARY_TENOR

        common = state_sdl.index.intersection(gsec_pivot.index)
        if len(common) < 60:
            continue

        merged = pd.DataFrame({
            "sdl_yield": state_sdl.loc[common, sdl_col],
            "gsec_yield": gsec_pivot.loc[common, gsec_tenor],
        }).dropna()

        merged["spread_bps"] = (merged["sdl_yield"] - merged["gsec_yield"]) * 100

        mu = merged["spread_bps"].rolling(ZSCORE_WINDOW).mean()
        sigma = merged["spread_bps"].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
        merged["z_score"] = (merged["spread_bps"] - mu) / sigma

        for dt, row in merged.iterrows():
            spread_records.append({
                "date": dt.date(),
                "state": state,
                "tenor_yr": PRIMARY_TENOR,
                "sdl_yield_pct": float(row["sdl_yield"]),
                "gsec_yield_pct": float(row["gsec_yield"]),
                "spread_bps": float(row["spread_bps"]),
                "z_score": float(row["z_score"]) if not np.isnan(row["z_score"]) else None,
            })

        # Strategy: buy SDL (short G-Sec futures) when spread is wide
        pos = merged["z_score"].shift(1).apply(
            lambda z: 1 if z > ENTRY_Z else (0 if abs(z) < EXIT_Z else np.nan)
        ).ffill().fillna(0)

        # Spread change P&L (bps → approximate % return via duration)
        duration_approx = PRIMARY_TENOR * 0.85  # Modified duration approx
        spread_change = merged["spread_bps"].diff()
        pnl = pos * (-spread_change / 10000 * duration_approx)  # Long SDL: gain when spread narrows
        all_port.append(pnl.rename(f"{state}_{PRIMARY_TENOR}Y"))

        state_stats[state] = {
            "state": state,
            "avg_spread_bps": float(merged["spread_bps"].mean()),
            "spread_std_bps": float(merged["spread_bps"].std()),
            "fiscal_rating": STATE_FISCAL_RATING.get(str(state).upper(), "N/A"),
            "n_obs": len(merged),
        }

    pd.DataFrame(spread_records).sort_values("date").to_csv(
        os.path.join(cfg.outdir, "sdl_gsec_spread.csv"), index=False
    )

    if state_stats:
        pd.DataFrame(state_stats.values()).sort_values("avg_spread_bps", ascending=False).to_csv(
            os.path.join(cfg.outdir, "state_comparison.csv"), index=False
        )

    if all_port:
        portfolio = pd.concat(all_port, axis=1).mean(axis=1).dropna()
        cum = (1 + portfolio).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(portfolio.mean() / portfolio.std() * np.sqrt(252)) if portfolio.std() > 0 else None
    else:
        sharpe = None
        portfolio = pd.Series(dtype=float)

    avg_spread = float(np.mean([s["avg_spread_bps"] for s in state_stats.values()])) if state_stats else None
    summary = {
        "n_states": len(state_stats),
        "avg_sdl_spread_bps": avg_spread,
        "primary_tenor_yr": PRIMARY_TENOR,
        "ann_return": float(portfolio.mean() * 252) if len(portfolio) > 0 else None,
        "sharpe": sharpe,
        "params": {"entry_z": ENTRY_Z, "exit_z": EXIT_Z, "zscore_window": ZSCORE_WINDOW}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"SDL/G-Sec Spread | {len(state_stats)} states | Avg spread: {avg_spread:.1f if avg_spread else 'N/A'} bps | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sdl", required=True, dest="sdl_file")
    ap.add_argument("--gsec", required=True, dest="gsec_file")
    ap.add_argument("--outdir", default="./artifacts/sdl_gsec_spread")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
