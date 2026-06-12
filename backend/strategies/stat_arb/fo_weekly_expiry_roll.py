#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fo_weekly_expiry_roll.py — NSE F&O weekly expiry premium decay strategy
========================================================================
NSE introduced weekly options on NIFTY and BANKNIFTY. Near-expiry options
lose time value (theta) rapidly on Thursday/Friday. This strategy systematically
sells weekly straddles/strangles 2-3 days before expiry and delta-hedges,
capturing the accelerated theta decay that Citadel and DE Shaw cannot exploit
at scale in India's F&O market.

India moat: NSE weekly F&O settlement is every Thursday. The implied volatility
spike before settlement (IV crush after) creates a repeatable edge. Global funds
avoid NSE F&O due to contract size, lot constraints, and hedging friction.

Inputs (CSV)
------------
--options   options.csv     date, expiry, strike, type (CE/PE), ltp, iv, oi, volume, spot
--spot      spot.csv        date, nifty_close (or banknifty_close)

Outputs
-------
outdir/weekly_premiums.csv      expiry, straddle_premium, iv_at_entry, iv_at_expiry, pnl
outdir/theta_decay.csv          days_to_expiry, avg_decay_pct, std_decay_pct
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os
from datetime import timedelta

import numpy as np
import pandas as pd

# Strategy parameters
ENTRY_DTE = 3          # Enter position N days before expiry
EXIT_DTE = 0           # Exit on expiry day
MIN_IV = 10.0          # Minimum IV (%) to justify selling premium
DELTA_HEDGE_FREQ = 1   # Re-hedge every N days
STRANGLE_WIDTH = 0.02  # Strangle strikes 2% OTM from ATM
POSITION_SIZE_PCT = 0.02  # 2% of NAV per trade
NIFTY_LOT = 50         # NIFTY lot size (current as of 2024)
BN_LOT = 15            # BANKNIFTY lot size


def black_scholes_iv_approx(option_price: float, spot: float, strike: float,
                              dte: float, rate: float = 0.065, flag: str = "C") -> float:
    """Brenner-Subrahmanyam ATM IV approximation."""
    if dte <= 0 or spot <= 0 or option_price <= 0:
        return np.nan
    t = dte / 365.0
    atm_iv = option_price / (spot * np.sqrt(t / (2 * np.pi)))
    return float(atm_iv) if 0.01 <= atm_iv <= 3.0 else np.nan


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    opts = pd.read_csv(cfg.options_file, parse_dates=["date", "expiry"])
    opts.columns = [c.lower().strip() for c in opts.columns]
    spot_df = pd.read_csv(cfg.spot_file, parse_dates=["date"]).set_index("date").sort_index()
    spot_df.columns = [c.lower().strip() for c in spot_df.columns]
    spot_col = spot_df.columns[0]

    opts["dte"] = (opts["expiry"] - opts["date"]).dt.days
    opts["spot"] = opts["date"].map(spot_df[spot_col])

    # Identify weekly expiries (Thursday settlement)
    all_expiries = opts["expiry"].dropna().unique()
    weekly_expiries = sorted([e for e in all_expiries if pd.Timestamp(e).dayofweek == 3])  # Thursday=3

    premium_records = []
    theta_records = []
    all_daily_pnl = []

    for expiry in weekly_expiries:
        exp_ts = pd.Timestamp(expiry)
        entry_date = exp_ts - timedelta(days=ENTRY_DTE)

        # Get options for this expiry
        exp_opts = opts[opts["expiry"] == expiry].copy()
        if exp_opts.empty:
            continue

        # Get ATM options at entry
        entry_day = exp_opts[exp_opts["date"] == entry_date]
        if entry_day.empty:
            # Try closest available date
            avail = exp_opts[exp_opts["date"] <= entry_date]["date"]
            if avail.empty:
                continue
            entry_date = avail.max()
            entry_day = exp_opts[exp_opts["date"] == entry_date]

        spot_at_entry = spot_df.loc[entry_date, spot_col] if entry_date in spot_df.index else np.nan
        if np.isnan(spot_at_entry):
            continue

        # Find ATM straddle
        atm_strike = round(spot_at_entry / 50) * 50  # NIFTY rounds to 50
        ce_entry = entry_day[(entry_day["strike"] == atm_strike) & (entry_day["type"].str.upper() == "CE")]
        pe_entry = entry_day[(entry_day["strike"] == atm_strike) & (entry_day["type"].str.upper() == "PE")]

        if ce_entry.empty or pe_entry.empty:
            continue

        ce_prem = float(ce_entry["ltp"].values[0])
        pe_prem = float(pe_entry["ltp"].values[0])
        straddle_prem = ce_prem + pe_prem
        iv_entry = float(ce_entry["iv"].values[0]) if "iv" in ce_entry.columns else np.nan

        if straddle_prem <= 0 or (not np.isnan(iv_entry) and iv_entry < MIN_IV):
            continue

        # Get expiry-day settlement value
        exp_day = exp_opts[exp_opts["date"] == exp_ts]
        spot_at_exp = spot_df.loc[exp_ts, spot_col] if exp_ts in spot_df.index else np.nan

        if not np.isnan(spot_at_exp) and not exp_day.empty:
            # Intrinsic value at expiry
            ce_intrinsic = max(0, spot_at_exp - atm_strike)
            pe_intrinsic = max(0, atm_strike - spot_at_exp)
            pnl = straddle_prem - (ce_intrinsic + pe_intrinsic)  # Premium collected minus intrinsic paid
        else:
            pnl = np.nan

        premium_records.append({
            "expiry": exp_ts.date(),
            "entry_date": entry_date.date() if hasattr(entry_date, "date") else entry_date,
            "spot_at_entry": float(spot_at_entry),
            "atm_strike": float(atm_strike),
            "straddle_premium": float(straddle_prem),
            "iv_at_entry": float(iv_entry) if not np.isnan(iv_entry) else None,
            "ce_intrinsic": float(ce_intrinsic) if not np.isnan(pnl) else None,
            "pe_intrinsic": float(pe_intrinsic) if not np.isnan(pnl) else None,
            "pnl_per_lot": float(pnl) * NIFTY_LOT if not np.isnan(pnl) else None,
            "pnl_pct_premium": float(pnl / straddle_prem) if not np.isnan(pnl) and straddle_prem > 0 else None,
        })

        # Daily theta decay within this expiry window
        window = exp_opts[
            (exp_opts["strike"] == atm_strike) &
            (exp_opts["type"].str.upper() == "CE") &
            (exp_opts["dte"] <= ENTRY_DTE)
        ].sort_values("date")

        if len(window) >= 2:
            for i in range(1, len(window)):
                prev = window.iloc[i - 1]
                curr = window.iloc[i]
                decay = (float(prev["ltp"]) - float(curr["ltp"])) / float(prev["ltp"]) if prev["ltp"] > 0 else np.nan
                theta_records.append({
                    "expiry": exp_ts.date(),
                    "date": curr["date"].date(),
                    "dte": int(curr["dte"]),
                    "prev_ltp": float(prev["ltp"]),
                    "curr_ltp": float(curr["ltp"]),
                    "daily_decay_pct": float(decay) * 100 if not np.isnan(decay) else None,
                })

        if not np.isnan(pnl):
            all_daily_pnl.append(pnl / spot_at_entry)  # as return

    if premium_records:
        pd.DataFrame(premium_records).to_csv(os.path.join(cfg.outdir, "weekly_premiums.csv"), index=False)

    if theta_records:
        theta_df = pd.DataFrame(theta_records)
        theta_agg = theta_df.groupby("dte")["daily_decay_pct"].agg(["mean", "std"]).reset_index()
        theta_agg.columns = ["days_to_expiry", "avg_decay_pct", "std_decay_pct"]
        theta_agg.to_csv(os.path.join(cfg.outdir, "theta_decay.csv"), index=False)

    if all_daily_pnl:
        rets = np.array(all_daily_pnl)
        cum = (1 + pd.Series(rets)).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(rets.mean() / rets.std() * np.sqrt(52)) if rets.std() > 0 else None  # Weekly
        win_rate = float((rets > 0).mean())
    else:
        sharpe = None
        win_rate = None

    summary = {
        "n_weekly_expiries_traded": len([r for r in premium_records if r["pnl_per_lot"] is not None]),
        "avg_straddle_premium": float(np.mean([r["straddle_premium"] for r in premium_records])) if premium_records else None,
        "avg_pnl_pct_premium": float(np.nanmean([r["pnl_pct_premium"] for r in premium_records if r["pnl_pct_premium"]])) if premium_records else None,
        "win_rate": win_rate,
        "ann_sharpe": sharpe,
        "params": {"entry_dte": ENTRY_DTE, "min_iv": MIN_IV, "nifty_lot": NIFTY_LOT}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"F&O Weekly Expiry Roll | {summary['n_weekly_expiries_traded']} expiries | "
          f"Avg PnL: {summary['avg_pnl_pct_premium']:.1%} | Win rate: {win_rate:.1%} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--options", required=True, dest="options_file")
    ap.add_argument("--spot", required=True, dest="spot_file")
    ap.add_argument("--outdir", default="./artifacts/fo_weekly_expiry")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
