#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
usdinr_carry.py — USDINR carry trade and RBI intervention signal
================================================================
The USDINR carry trade exploits the interest rate differential between INR
(repo rate ~6.5%) and USD (fed funds ~4-5%). When carry is positive and vol
is low, the strategy earns the differential. RBI interventions create
predictable USDINR dynamics.

Key signals:
  - Carry (INR rate - USD rate) > 150 bps → long INR carry
  - USDINR momentum > 2 std devs → RBI intervention likely (fade)
  - India CDS spread spike → exit carry
  - EM contagion risk → CBOE VIX spike → exit

India moat: INR carry is one of the highest in EM (2-3% net carry), but
RBI actively manages the corridor. Understanding RBI intervention patterns
gives edge vs pure mechanical carry strategies.

Inputs (CSV)
------------
--usdinr    usdinr.csv      date, usdinr_close, usdinr_1m_forward (optional)
--rates     rates.csv       date, india_repo_rate, us_fed_rate
--vix       vix.csv         date, vix_close (CBOE VIX)
--ivix      ivix.csv        date, ivix_close (optional)

Outputs
-------
outdir/carry_signal.csv         date, carry_bps, carry_z, usdinr_z, carry_regime, signal
outdir/rbi_intervention.csv     date, usdinr_move, intervention_likely, reversal_pct
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

# Carry thresholds (bps annualized)
HIGH_CARRY_BPS = 150        # Long INR carry when > 150 bps
LOW_CARRY_BPS = 75          # Exit carry when < 75 bps

# USDINR momentum for intervention detection
USDINR_MOVE_Z = 2.0         # RBI intervenes when move > 2 std devs
VIX_HIGH = 25.0             # Exit carry when CBOE VIX > 25

# Rolling windows
CARRY_ZSCORE_WINDOW = 60
USDINR_MOMENTUM_WINDOW = 20
CARRY_MA_WINDOW = 10


def compute_carry(india_rate: float, us_rate: float) -> float:
    """Net carry in bps = (India rate - US rate) * 100"""
    if np.isnan(india_rate) or np.isnan(us_rate):
        return np.nan
    return (india_rate - us_rate) * 100  # in bps


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    usdinr = pd.read_csv(cfg.usdinr_file, parse_dates=["date"]).set_index("date").sort_index()
    usdinr.columns = [c.lower().strip() for c in usdinr.columns]
    usdinr_col = "usdinr_close" if "usdinr_close" in usdinr.columns else usdinr.columns[0]

    rates = pd.read_csv(cfg.rates_file, parse_dates=["date"]).set_index("date").sort_index()
    rates.columns = [c.lower().strip() for c in rates.columns]
    india_rate_col = [c for c in rates.columns if "india" in c or "repo" in c][0]
    us_rate_col = [c for c in rates.columns if "us" in c or "fed" in c][0]

    vix = pd.read_csv(cfg.vix_file, parse_dates=["date"]).set_index("date").sort_index()
    vix.columns = [c.lower().strip() for c in vix.columns]
    vix_col = vix.columns[0]

    # Merge all data
    data = usdinr[[usdinr_col]].rename(columns={usdinr_col: "usdinr"})
    data = data.join(rates[[india_rate_col, us_rate_col]].rename(
        columns={india_rate_col: "india_rate", us_rate_col: "us_rate"}
    ), how="left").ffill()
    data = data.join(vix[[vix_col]].rename(columns={vix_col: "vix"}), how="left").ffill()

    if cfg.ivix_file and os.path.exists(cfg.ivix_file):
        ivix = pd.read_csv(cfg.ivix_file, parse_dates=["date"]).set_index("date").sort_index()
        ivix.columns = [c.lower().strip() for c in ivix.columns]
        data = data.join(ivix[[ivix.columns[0]]].rename(columns={ivix.columns[0]: "ivix"}), how="left").ffill()

    data = data.dropna(subset=["usdinr"])

    # Carry computation
    data["carry_bps"] = data.apply(
        lambda r: compute_carry(r.get("india_rate", np.nan), r.get("us_rate", np.nan)), axis=1
    )
    data["carry_ma"] = data["carry_bps"].rolling(CARRY_MA_WINDOW).mean()

    carry_mu = data["carry_bps"].rolling(CARRY_ZSCORE_WINDOW).mean()
    carry_sigma = data["carry_bps"].rolling(CARRY_ZSCORE_WINDOW).std().replace(0, np.nan)
    data["carry_z"] = (data["carry_bps"] - carry_mu) / carry_sigma

    # USDINR momentum (INR depreciation pressure)
    usdinr_ret = data["usdinr"].pct_change()
    usdinr_mu = usdinr_ret.rolling(USDINR_MOMENTUM_WINDOW).mean()
    usdinr_sigma = usdinr_ret.rolling(USDINR_MOMENTUM_WINDOW).std().replace(0, np.nan)
    data["usdinr_z"] = (usdinr_ret - usdinr_mu) / usdinr_sigma

    # RBI intervention signal: large USDINR move → intervention likely → fade
    data["rbi_intervention_likely"] = data["usdinr_z"].abs() > USDINR_MOVE_Z

    # Carry regime
    def carry_regime(carry: float, vix: float, usdinr_z: float) -> str:
        if pd.isna(carry):
            return "unknown"
        if vix > VIX_HIGH or abs(usdinr_z) > USDINR_MOVE_Z:
            return "risk_off"
        elif carry >= HIGH_CARRY_BPS:
            return "high_carry"
        elif carry >= LOW_CARRY_BPS:
            return "moderate_carry"
        else:
            return "low_carry"

    data["carry_regime"] = data.apply(
        lambda r: carry_regime(r.get("carry_bps", np.nan), r.get("vix", 15.0),
                               r.get("usdinr_z", 0.0)), axis=1
    )

    # Strategy signal:
    # Long INR carry (borrow USD, invest in INR instruments) when regime = high_carry
    # Short INR / flat during risk_off
    data["signal"] = data["carry_regime"].map({
        "high_carry": -1.0,        # Long INR (sell USDINR)
        "moderate_carry": -0.5,    # Partial long INR
        "low_carry": 0.0,
        "risk_off": 1.0,           # Reduce/reverse: buy USD (long USDINR)
        "unknown": 0.0,
    })

    # RBI intervention: when USDINR moves > 2 std devs, fade (contrarian)
    data.loc[data["rbi_intervention_likely"] & (data["usdinr_z"] > 0), "signal"] += 0.5  # Fade depreciation
    data.loc[data["rbi_intervention_likely"] & (data["usdinr_z"] < 0), "signal"] -= 0.5  # Fade appreciation
    data["signal"] = data["signal"].clip(-1.5, 1.5)

    # Backtest: long INR = short USDINR (USDINR falls when INR strengthens)
    strat_ret = data["signal"].shift(1) * (-usdinr_ret)  # Negative sign: INR long profits when USDINR falls
    strat_ret = strat_ret.dropna()
    cum = (1 + strat_ret).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    # RBI intervention records
    intervention_records = []
    for dt, row in data.iterrows():
        if row["rbi_intervention_likely"]:
            usdinr_move = float(usdinr_ret.get(dt, np.nan))
            # Check reversal in next 5 days
            post_usdinr = data.loc[dt:]["usdinr"].iloc[:5].pct_change().sum() if len(data.loc[dt:]) >= 5 else np.nan
            intervention_records.append({
                "date": dt.date(),
                "usdinr": float(row["usdinr"]),
                "daily_move_pct": float(usdinr_move * 100) if not np.isnan(usdinr_move) else None,
                "usdinr_z": float(row["usdinr_z"]) if not np.isnan(row.get("usdinr_z", np.nan)) else None,
                "intervention_likely": True,
                "reversal_5d_pct": float(post_usdinr * 100) if not np.isnan(post_usdinr) else None,
            })

    if intervention_records:
        pd.DataFrame(intervention_records).to_csv(os.path.join(cfg.outdir, "rbi_intervention.csv"), index=False)

    # Carry signal records
    carry_records = []
    for dt, row in data.iterrows():
        carry_records.append({
            "date": dt.date(),
            "usdinr": float(row["usdinr"]),
            "india_rate": float(row.get("india_rate", np.nan)),
            "us_rate": float(row.get("us_rate", np.nan)),
            "carry_bps": float(row.get("carry_bps", np.nan)),
            "carry_z": float(row.get("carry_z", np.nan)) if not np.isnan(row.get("carry_z", np.nan)) else None,
            "usdinr_z": float(row.get("usdinr_z", np.nan)) if not np.isnan(row.get("usdinr_z", np.nan)) else None,
            "vix": float(row.get("vix", np.nan)),
            "carry_regime": row["carry_regime"],
            "signal": float(row["signal"]),
        })
    pd.DataFrame(carry_records).to_csv(os.path.join(cfg.outdir, "carry_signal.csv"), index=False)

    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(252)) if strat_ret.std() > 0 else None
    avg_carry = float(data["carry_bps"].dropna().mean())

    summary = {
        "avg_carry_bps": avg_carry,
        "pct_high_carry_regime": float((data["carry_regime"] == "high_carry").mean() * 100),
        "pct_risk_off": float((data["carry_regime"] == "risk_off").mean() * 100),
        "n_rbi_interventions": len(intervention_records),
        "ann_return": float(strat_ret.mean() * 252),
        "sharpe": sharpe,
        "params": {"high_carry_bps": HIGH_CARRY_BPS, "vix_high": VIX_HIGH, "intervention_z": USDINR_MOVE_Z}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"USDINR Carry | Avg carry: {avg_carry:.0f} bps | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--usdinr", required=True, dest="usdinr_file")
    ap.add_argument("--rates", required=True, dest="rates_file")
    ap.add_argument("--vix", required=True, dest="vix_file")
    ap.add_argument("--ivix", default=None, dest="ivix_file")
    ap.add_argument("--outdir", default="./artifacts/usdinr_carry")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
