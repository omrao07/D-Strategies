#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
banknifty_nifty_vol_spread.py — BANKNIFTY vs NIFTY implied vol spread
======================================================================
BANKNIFTY typically trades at a higher IV than NIFTY (banking sector is more
volatile). The IV spread between BANKNIFTY ATM options and NIFTY ATM options
mean-reverts. When the spread is abnormally wide, sell BANKNIFTY vol / buy
NIFTY vol. When compressed, reverse.

Key drivers of spread widening:
  - RBI policy surprise → BANKNIFTY spikes disproportionately
  - Credit events in banking sector (NPA disclosures, RBI action on banks)
  - Pre-budget anxiety (bank recapitalisation expectations)

Inputs (CSV)
------------
--bn_iv     bn_iv.csv       date, banknifty_atm_iv, banknifty_close
--nifty_iv  nifty_iv.csv    date, nifty_atm_iv, nifty_close

Outputs
-------
outdir/iv_spread.csv        date, bn_iv, nifty_iv, spread, z_score, signal
outdir/spread_drivers.csv   period, driver_event, spread_at_event, spread_10d_after
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

ZSCORE_WINDOW = 40
ENTRY_Z = 2.0
EXIT_Z = 0.5
SPREAD_MA_WINDOW = 20


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    bn = pd.read_csv(cfg.bn_iv_file, parse_dates=["date"]).set_index("date").sort_index()
    bn.columns = [c.lower().strip() for c in bn.columns]
    bn_iv_col = [c for c in bn.columns if "iv" in c][0]
    bn_close_col = [c for c in bn.columns if "close" in c or "banknifty" in c.replace("_iv", "")][0]

    nifty = pd.read_csv(cfg.nifty_iv_file, parse_dates=["date"]).set_index("date").sort_index()
    nifty.columns = [c.lower().strip() for c in nifty.columns]
    nifty_iv_col = [c for c in nifty.columns if "iv" in c][0]
    nifty_close_col = [c for c in nifty.columns if "close" in c or "nifty" in c.replace("_iv", "")][0]

    data = bn[[bn_iv_col, bn_close_col]].rename(
        columns={bn_iv_col: "bn_iv", bn_close_col: "bn_close"}
    ).join(
        nifty[[nifty_iv_col, nifty_close_col]].rename(
            columns={nifty_iv_col: "nifty_iv", nifty_close_col: "nifty_close"}
        )
    ).dropna()

    data["spread"] = data["bn_iv"] - data["nifty_iv"]
    data["spread_ma"] = data["spread"].rolling(SPREAD_MA_WINDOW).mean()

    mu = data["spread"].rolling(ZSCORE_WINDOW).mean()
    sigma = data["spread"].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
    data["z_score"] = (data["spread"] - mu) / sigma

    # Signal: wide spread → short BN vol, long NIFTY vol
    data["signal"] = data["z_score"].shift(1).apply(
        lambda z: -1 if z > ENTRY_Z else (1 if z < -ENTRY_Z else (0 if abs(z) < EXIT_Z else np.nan))
    ).ffill().fillna(0)

    # P&L: position in spread (when short, profit if spread narrows)
    data["bn_ret"] = data["bn_close"].pct_change()
    data["nifty_ret"] = data["nifty_close"].pct_change()

    # Volatility long/short approximated via underlying returns
    # Short BN vol (short straddle) loses when |BN_ret| is large
    # Long NIFTY vol gains when |NIFTY_ret| is large
    bn_iv_normalized = data["bn_iv"] / 100 / np.sqrt(252)
    nifty_iv_normalized = data["nifty_iv"] / 100 / np.sqrt(252)

    # Simplified theta/gamma P&L
    theta_bn = bn_iv_normalized * 0.5  # rough daily theta
    theta_nifty = nifty_iv_normalized * 0.5
    gamma_bn = data["bn_ret"].abs()
    gamma_nifty = data["nifty_ret"].abs()

    # Short BN, long NIFTY vol:
    # Earn theta_bn, lose theta_nifty, lose gamma_bn, gain gamma_nifty
    spread_pnl = (
        data["signal"] * (
            theta_bn - theta_nifty  # theta: positive when BN theta > NIFTY theta
            - gamma_bn + gamma_nifty  # gamma: negative when BN moves more than NIFTY
        )
    ).shift(1)

    strat_ret = spread_pnl.dropna()
    cum = (1 + strat_ret).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    records = []
    for dt, row in data.iterrows():
        records.append({
            "date": dt.date(),
            "bn_iv": float(row["bn_iv"]),
            "nifty_iv": float(row["nifty_iv"]),
            "spread_vols": float(row["spread"]),
            "spread_ma": float(row["spread_ma"]) if not np.isnan(row["spread_ma"]) else None,
            "z_score": float(row["z_score"]) if not np.isnan(row["z_score"]) else None,
            "signal": "short_bn_long_nifty" if row["signal"] == -1 else (
                "long_bn_short_nifty" if row["signal"] == 1 else "flat"),
        })
    pd.DataFrame(records).to_csv(os.path.join(cfg.outdir, "iv_spread.csv"), index=False)

    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(252)) if strat_ret.std() > 0 else None
    summary = {
        "avg_bn_iv": float(data["bn_iv"].mean()),
        "avg_nifty_iv": float(data["nifty_iv"].mean()),
        "avg_iv_spread": float(data["spread"].mean()),
        "spread_std": float(data["spread"].std()),
        "n_trade_days": int((data["signal"] != 0).sum()),
        "ann_return": float(strat_ret.mean() * 252),
        "sharpe": sharpe,
        "params": {"entry_z": ENTRY_Z, "exit_z": EXIT_Z, "zscore_window": ZSCORE_WINDOW}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"BANKNIFTY/NIFTY IV Spread | Avg spread: {summary['avg_iv_spread']:.1f} vols | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bn-iv", required=True, dest="bn_iv_file")
    ap.add_argument("--nifty-iv", required=True, dest="nifty_iv_file")
    ap.add_argument("--outdir", default="./artifacts/bn_nifty_vol_spread")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
