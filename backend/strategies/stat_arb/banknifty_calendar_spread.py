#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
banknifty_calendar_spread.py — BANKNIFTY near/far futures calendar spread
==========================================================================
Captures the roll yield between near-month (M1) and mid-month (M2) BANKNIFTY
futures. The spread reflects cost-of-carry + lending rate expectations.
RBI rate signals create predictable calendar spread mispricing.

BANKNIFTY is NSE's most liquid derivative — avg daily turnover > ₹1.5 lakh crore.
Calendar spreads have bid-ask friction of ~0.1-0.2 index points vs 2-5 points for
outright. Lower gamma risk than straddles.

Inputs (CSV)
------------
--m1        m1.csv      date, m1_close, m1_oi, m1_volume, days_to_expiry
--m2        m2.csv      date, m2_close, m2_oi, m2_volume, days_to_expiry
--spot      spot.csv    date, banknifty_close
--rbi       rbi.csv     date, repo_rate (optional, for carry calibration)

Outputs
-------
outdir/calendar_spread.csv      date, spread, carry_fair, basis_error, signal
outdir/oi_analysis.csv          date, m1_oi, m2_oi, oi_ratio, rollover_pct
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd

RISK_FREE = 0.065     # RBI repo rate fallback
ENTRY_BPS = 8         # Enter when spread vs fair > 8 bps
EXIT_BPS = 2          # Exit when spread vs fair < 2 bps
ZSCORE_WINDOW = 20
ROLLOVER_OI_THRESHOLD = 0.65  # Start rolling when M2 OI > 65% of M1 OI


def fair_calendar_spread(spot: float, r: float, dte_m1: float, dte_m2: float) -> float:
    """Theoretical M2 - M1 spread under cost-of-carry."""
    f1 = spot * np.exp(r * dte_m1 / 365)
    f2 = spot * np.exp(r * dte_m2 / 365)
    return float(f2 - f1)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    m1 = pd.read_csv(cfg.m1_file, parse_dates=["date"]).set_index("date").sort_index()
    m1.columns = [c.lower().strip() for c in m1.columns]
    m2 = pd.read_csv(cfg.m2_file, parse_dates=["date"]).set_index("date").sort_index()
    m2.columns = [c.lower().strip() for c in m2.columns]
    spot = pd.read_csv(cfg.spot_file, parse_dates=["date"]).set_index("date").sort_index()
    spot.columns = [c.lower().strip() for c in spot.columns]
    spot_col = spot.columns[0]

    rbi_rate = RISK_FREE
    if cfg.rbi_file and os.path.exists(cfg.rbi_file):
        rbi_df = pd.read_csv(cfg.rbi_file, parse_dates=["date"]).set_index("date").sort_index()
        rbi_df.columns = [c.lower().strip() for c in rbi_df.columns]
        rate_col = [c for c in rbi_df.columns if "rate" in c or "repo" in c][0]

    merged = m1[["m1_close", "days_to_expiry"]].rename(columns={
        "m1_close": "m1", "days_to_expiry": "dte_m1"
    }).join(m2[["m2_close", "days_to_expiry"]].rename(columns={
        "m2_close": "m2", "days_to_expiry": "dte_m2"
    })).join(spot[[spot_col]].rename(columns={spot_col: "spot"})).dropna()

    # Add OI if available
    if "m1_oi" in m1.columns and "m2_oi" in m2.columns:
        merged = merged.join(m1[["m1_oi"]]).join(m2[["m2_oi"]])

    # Observed and fair spreads
    merged["spread"] = merged["m2"] - merged["m1"]

    if cfg.rbi_file and os.path.exists(cfg.rbi_file):
        rbi_daily = rbi_df[rate_col].reindex(merged.index).ffill()
        merged["fair_spread"] = merged.apply(
            lambda r: fair_calendar_spread(r["spot"], float(rbi_daily.get(r.name, RISK_FREE)),
                                            r["dte_m1"], r["dte_m2"]), axis=1
        )
    else:
        merged["fair_spread"] = merged.apply(
            lambda r: fair_calendar_spread(r["spot"], RISK_FREE, r["dte_m1"], r["dte_m2"]), axis=1
        )

    merged["basis_error"] = merged["spread"] - merged["fair_spread"]

    # Z-score
    mu = merged["basis_error"].rolling(ZSCORE_WINDOW).mean()
    sigma = merged["basis_error"].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
    merged["z_score"] = (merged["basis_error"] - mu) / sigma

    entry_bps = ENTRY_BPS / 10000 * merged["spot"].mean()
    exit_bps = EXIT_BPS / 10000 * merged["spot"].mean()

    records = []
    for dt, row in merged.iterrows():
        be = row["basis_error"]
        z = row["z_score"]

        if abs(be) > entry_bps and not np.isnan(z):
            # Spread too wide: sell M2, buy M1 (or vice versa)
            signal = "sell_m2_buy_m1" if be > 0 else "buy_m2_sell_m1"
        else:
            signal = "neutral"

        records.append({
            "date": dt,
            "m1_close": float(row["m1"]),
            "m2_close": float(row["m2"]),
            "spot": float(row["spot"]),
            "spread": float(row["spread"]),
            "fair_spread": float(row["fair_spread"]),
            "basis_error": float(be),
            "z_score": float(z) if not np.isnan(z) else None,
            "dte_m1": int(row["dte_m1"]),
            "dte_m2": int(row["dte_m2"]),
            "signal": signal,
        })

    spread_df = pd.DataFrame(records)
    spread_df.to_csv(os.path.join(cfg.outdir, "calendar_spread.csv"), index=False)

    # OI rollover analysis
    if "m1_oi" in merged.columns and "m2_oi" in merged.columns:
        merged["oi_ratio"] = merged["m2_oi"] / (merged["m1_oi"] + merged["m2_oi"] + 1e-10)
        merged["rollover_pct"] = merged["oi_ratio"] * 100
        merged[["m1_oi", "m2_oi", "oi_ratio", "rollover_pct"]].to_csv(
            os.path.join(cfg.outdir, "oi_analysis.csv")
        )

    # Backtest: capture basis error
    sig_map = {"sell_m2_buy_m1": -1, "buy_m2_sell_m1": 1, "neutral": 0}
    pos = spread_df.set_index("date")["signal"].map(sig_map).fillna(0).shift(1)
    spread_ret = merged["spread"].pct_change()
    strat_ret = pos * spread_ret
    strat_ret = strat_ret.dropna()
    cum = (1 + strat_ret).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(252)) if strat_ret.std() > 0 else None
    summary = {
        "avg_spread": float(merged["spread"].mean()),
        "avg_fair_spread": float(merged["fair_spread"].mean()),
        "avg_basis_error": float(merged["basis_error"].mean()),
        "n_trade_days": int((spread_df["signal"] != "neutral").sum()),
        "ann_return": float(strat_ret.mean() * 252),
        "sharpe": sharpe,
        "params": {"entry_bps": ENTRY_BPS, "exit_bps": EXIT_BPS, "risk_free": RISK_FREE}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"BANKNIFTY Calendar Spread | Avg basis error: {summary['avg_basis_error']:.2f} pts | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--m1", required=True, dest="m1_file")
    ap.add_argument("--m2", required=True, dest="m2_file")
    ap.add_argument("--spot", required=True, dest="spot_file")
    ap.add_argument("--rbi", default=None, dest="rbi_file")
    ap.add_argument("--outdir", default="./artifacts/banknifty_calendar")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
