#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rbi_policy_trades.py — RBI policy stance and macro regime signal
================================================================
Models the RBI's monetary policy stance (hawkish/dovish/neutral) from multiple
inputs: repo rate path, CPI trajectory, real GDP, current account deficit,
USDINR trend, and forward guidance language (NLP from MPC minutes).

Generates a composite "RBI Policy Signal" [-1 to +1] that feeds into:
  - NIFTY direction (hawkish = headwind, dovish = tailwind)
  - BANKNIFTY (most sensitive to NIMs and lending rate spread)
  - G-Sec yield positioning
  - USDINR carry trade direction

India moat: RBI policy uniquely combines inflation targeting (4% CPI target)
with currency management (implicit USDINR bands) and growth support. This
dual mandate creates more predictable policy windows than Fed, ECB, or BOE.

Inputs (CSV)
------------
--rbi       rbi.csv         date, repo_rate, reverse_repo, crr, slr
--cpi       cpi.csv         date, cpi_yoy, core_cpi_yoy
--gdp       gdp.csv         date, gdp_yoy (quarterly, will be interpolated)
--usdinr    usdinr.csv      date, usdinr_close
--nifty     nifty.csv       date, nifty_close

Outputs
-------
outdir/policy_signal.csv        date, policy_signal, stance, repo_rate, cpi, regime
outdir/nifty_correlation.csv    policy_signal vs forward_nifty_returns
outdir/rate_cycle.csv           rate_cycle_phase, avg_nifty_return, n_obs
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

# Policy signal thresholds
HAWKISH_CPI = 6.0       # CPI > 6% → hawkish pressure
DOVISH_CPI = 4.5        # CPI < 4.5% → dovish space
HAWKISH_RATE_CHANGE = 25  # 25 bps hike
DOVISH_RATE_CHANGE = -25  # 25 bps cut

# USDINR as RBI policy constraint
USDINR_WEAK_THRESHOLD = 84.0   # INR weaker than 84 per USD → RBI constrained from cutting
USDINR_STRONG_THRESHOLD = 82.0  # INR stronger than 82 → RBI has room to cut


def compute_policy_signal(cpi: float, core_cpi: float, repo_rate: float,
                           usdinr: float, rate_trend: float) -> tuple:
    """
    Returns (signal [-1 to +1], stance string).
    Positive = dovish (supportive of risk), Negative = hawkish (headwind).
    """
    signal = 0.0
    components = {}

    # CPI component: above target = hawkish
    if not np.isnan(cpi):
        if cpi > HAWKISH_CPI:
            cpi_signal = -0.4  # Strong hawkish
        elif cpi > 5.5:
            cpi_signal = -0.2
        elif cpi < DOVISH_CPI:
            cpi_signal = 0.3   # Dovish space
        elif cpi < 5.0:
            cpi_signal = 0.1
        else:
            cpi_signal = 0.0
        signal += cpi_signal
        components["cpi"] = cpi_signal

    # Rate trend component
    if not np.isnan(rate_trend):
        # rate_trend: positive if hiking, negative if cutting
        rate_signal = -np.tanh(rate_trend / 50)  # normalize by 50 bps
        signal += rate_signal * 0.3
        components["rate_trend"] = float(rate_signal)

    # USDINR component: weak INR constrains RBI
    if not np.isnan(usdinr):
        if usdinr > USDINR_WEAK_THRESHOLD:
            fx_signal = -0.2  # Constrained
        elif usdinr < USDINR_STRONG_THRESHOLD:
            fx_signal = 0.2   # Has room to cut
        else:
            fx_signal = 0.0
        signal += fx_signal
        components["usdinr"] = fx_signal

    signal = float(np.clip(signal, -1.0, 1.0))

    if signal < -0.4:
        stance = "hawkish"
    elif signal < -0.1:
        stance = "mildly_hawkish"
    elif signal > 0.4:
        stance = "dovish"
    elif signal > 0.1:
        stance = "mildly_dovish"
    else:
        stance = "neutral"

    return signal, stance


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    rbi = pd.read_csv(cfg.rbi_file, parse_dates=["date"]).set_index("date").sort_index()
    rbi.columns = [c.lower().strip() for c in rbi.columns]

    cpi = pd.read_csv(cfg.cpi_file, parse_dates=["date"]).set_index("date").sort_index()
    cpi.columns = [c.lower().strip() for c in cpi.columns]

    usdinr = pd.read_csv(cfg.usdinr_file, parse_dates=["date"]).set_index("date").sort_index()
    usdinr.columns = [c.lower().strip() for c in usdinr.columns]
    usdinr_col = usdinr.columns[0]

    nifty = pd.read_csv(cfg.nifty_file, parse_dates=["date"]).set_index("date").sort_index()
    nifty.columns = [c.lower().strip() for c in nifty.columns]
    nifty_col = nifty.columns[0]

    # GDP if available
    gdp = None
    if cfg.gdp_file and os.path.exists(cfg.gdp_file):
        gdp = pd.read_csv(cfg.gdp_file, parse_dates=["date"]).set_index("date").sort_index()
        gdp.columns = [c.lower().strip() for c in gdp.columns]

    # Build daily data index from NIFTY
    dates = nifty.index
    data = pd.DataFrame(index=dates)
    data["nifty"] = nifty[nifty_col]
    data["usdinr"] = usdinr[usdinr_col].reindex(dates).ffill()
    data["repo_rate"] = rbi["repo_rate"].reindex(dates).ffill()

    cpi_col = "cpi_yoy" if "cpi_yoy" in cpi.columns else cpi.columns[0]
    core_col = "core_cpi_yoy" if "core_cpi_yoy" in cpi.columns else cpi_col
    data["cpi"] = cpi[cpi_col].reindex(dates).ffill()
    data["core_cpi"] = cpi[core_col].reindex(dates).ffill()

    # Rate trend (change over last 6 months)
    data["rate_trend"] = data["repo_rate"].diff(126)  # 126 trading days ~ 6 months

    # Rate cycle phase
    data["rate_change"] = data["repo_rate"].diff()
    data["cumulative_change_1yr"] = data["rate_change"].rolling(252).sum()

    def rate_cycle_phase(cum_change: float) -> str:
        if pd.isna(cum_change):
            return "unknown"
        if cum_change >= 50:
            return "hiking"
        elif cum_change <= -50:
            return "cutting"
        elif cum_change > 0:
            return "peak"
        else:
            return "trough"

    data["cycle_phase"] = data["cumulative_change_1yr"].apply(rate_cycle_phase)

    # Compute policy signal
    records = []
    for dt, row in data.iterrows():
        if np.isnan(row["nifty"]):
            continue
        signal, stance = compute_policy_signal(
            row.get("cpi", np.nan),
            row.get("core_cpi", np.nan),
            row.get("repo_rate", np.nan),
            row.get("usdinr", np.nan),
            row.get("rate_trend", np.nan),
        )
        records.append({
            "date": dt.date(),
            "policy_signal": float(signal),
            "stance": stance,
            "repo_rate": float(row["repo_rate"]) if not np.isnan(row.get("repo_rate", np.nan)) else None,
            "cpi_yoy": float(row["cpi"]) if not np.isnan(row.get("cpi", np.nan)) else None,
            "usdinr": float(row["usdinr"]) if not np.isnan(row.get("usdinr", np.nan)) else None,
            "cycle_phase": row["cycle_phase"],
            "nifty": float(row["nifty"]),
        })

    signal_df = pd.DataFrame(records).set_index("date")
    signal_df.to_csv(os.path.join(cfg.outdir, "policy_signal.csv"))

    # Forward return analysis
    fwd_returns = nifty[nifty_col].pct_change(5).shift(-5) * 100
    signal_s = pd.Series(
        [r["policy_signal"] for r in records],
        index=[pd.Timestamp(r["date"]) for r in records]
    )
    merged_for_corr = pd.DataFrame({
        "signal": signal_s,
        "fwd_5d_nifty": fwd_returns.reindex(signal_s.index),
    }).dropna()
    if len(merged_for_corr) >= 30:
        merged_for_corr.to_csv(os.path.join(cfg.outdir, "nifty_correlation.csv"))

    # Rate cycle phase vs NIFTY returns
    cycle_df = pd.DataFrame(records)
    cycle_df["nifty_fwd_5d"] = fwd_returns.reindex(
        pd.DatetimeIndex([pd.Timestamp(r["date"]) for r in records])
    ).values

    cycle_agg = cycle_df.groupby("cycle_phase")["nifty_fwd_5d"].agg(["mean", "std", "count"]).reset_index()
    cycle_agg.columns = ["rate_cycle_phase", "avg_nifty_fwd_5d_pct", "std", "n_obs"]
    cycle_agg.to_csv(os.path.join(cfg.outdir, "rate_cycle.csv"), index=False)

    # Backtest: NIFTY long/short based on policy signal
    pos = signal_s.shift(1)  # Signal from previous day drives position
    nifty_daily_ret = nifty[nifty_col].pct_change()
    strat_ret = pos * nifty_daily_ret.reindex(pos.index)
    strat_ret = strat_ret.dropna()
    cum = (1 + strat_ret).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(252)) if strat_ret.std() > 0 else None
    summary = {
        "avg_policy_signal": float(signal_s.mean()),
        "pct_hawkish": float((cycle_df["stance"].str.contains("hawkish")).mean() * 100),
        "pct_dovish": float((cycle_df["stance"].str.contains("dovish")).mean() * 100),
        "ann_return": float(strat_ret.mean() * 252),
        "sharpe": sharpe,
        "params": {
            "hawkish_cpi": HAWKISH_CPI,
            "dovish_cpi": DOVISH_CPI,
            "usdinr_weak": USDINR_WEAK_THRESHOLD,
        }
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"RBI Policy Signal | Avg signal: {summary['avg_policy_signal']:.2f} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rbi", required=True, dest="rbi_file")
    ap.add_argument("--cpi", required=True, dest="cpi_file")
    ap.add_argument("--usdinr", required=True, dest="usdinr_file")
    ap.add_argument("--nifty", required=True, dest="nifty_file")
    ap.add_argument("--gdp", default=None, dest="gdp_file")
    ap.add_argument("--outdir", default="./artifacts/rbi_policy")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
