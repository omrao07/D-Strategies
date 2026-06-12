#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nifty_vs_sensex_spread.py — NIFTY 50 vs BSE SENSEX 30 spread arbitrage
=======================================================================
NIFTY (NSE) and SENSEX (BSE) track overlapping large-cap universes with
slightly different compositions (50 vs 30 stocks). The spread should
mean-revert around cost-of-carry + composition differences. Temporary
divergence from FII routing via one exchange, or index-specific corporate
events, creates stat-arb opportunities.

Inputs (CSV)
------------
--nifty     nifty.csv       date, nifty_close
--sensex    sensex.csv      date, sensex_close

Outputs
-------
outdir/spread.csv           date, nifty_ret, sensex_ret, spread_ret, z_score, signal
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

ZSCORE_WINDOW = 30
ENTRY_Z = 2.0
EXIT_Z = 0.5
HEDGE_WINDOW = 60  # For rolling hedge ratio estimation


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    nifty = pd.read_csv(cfg.nifty_file, parse_dates=["date"]).set_index("date").sort_index()
    nifty.columns = [c.lower().strip() for c in nifty.columns]
    nc = nifty.columns[0]

    sensex = pd.read_csv(cfg.sensex_file, parse_dates=["date"]).set_index("date").sort_index()
    sensex.columns = [c.lower().strip() for c in sensex.columns]
    sc = sensex.columns[0]

    data = nifty[[nc]].join(sensex[[sc]], how="inner").rename(columns={nc: "nifty", sc: "sensex"}).dropna()

    # Log prices for cointegration
    data["log_nifty"] = np.log(data["nifty"])
    data["log_sensex"] = np.log(data["sensex"])

    # Rolling hedge ratio via OLS
    def rolling_hedge(window: int = HEDGE_WINDOW):
        hrs = []
        for i in range(len(data)):
            if i < window:
                hrs.append(np.nan)
                continue
            y = data["log_nifty"].values[i - window: i]
            x = data["log_sensex"].values[i - window: i]
            X = np.column_stack([x, np.ones(len(x))])
            b = np.linalg.lstsq(X, y, rcond=None)[0]
            hrs.append(b[0])
        return hrs

    data["hedge_ratio"] = rolling_hedge()
    data["spread"] = data["log_nifty"] - data["hedge_ratio"] * data["log_sensex"]

    mu = data["spread"].rolling(ZSCORE_WINDOW).mean()
    sigma = data["spread"].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
    data["z_score"] = (data["spread"] - mu) / sigma

    data["signal"] = data["z_score"].shift(1).apply(
        lambda z: -1 if z > ENTRY_Z else (1 if z < -ENTRY_Z else (0 if abs(z) < EXIT_Z else np.nan))
    ).ffill().fillna(0)

    data["nifty_ret"] = data["nifty"].pct_change()
    data["sensex_ret"] = data["sensex"].pct_change()
    data["pair_ret"] = data["signal"] * (data["nifty_ret"] - data["hedge_ratio"] * data["sensex_ret"])

    records = []
    for dt, row in data.iterrows():
        records.append({
            "date": dt.date(),
            "nifty": float(row["nifty"]),
            "sensex": float(row["sensex"]),
            "spread": float(row["spread"]) if not np.isnan(row["spread"]) else None,
            "z_score": float(row["z_score"]) if not np.isnan(row["z_score"]) else None,
            "signal": float(row["signal"]),
            "pair_ret_pct": float(row["pair_ret"] * 100) if not np.isnan(row["pair_ret"]) else None,
        })
    pd.DataFrame(records).to_csv(os.path.join(cfg.outdir, "spread.csv"), index=False)

    port = data["pair_ret"].dropna()
    cum = (1 + port).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
    sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None

    summary = {
        "avg_spread": float(data["spread"].mean()),
        "spread_std": float(data["spread"].std()),
        "n_trade_days": int((data["signal"] != 0).sum()),
        "ann_return": float(port.mean() * 252),
        "sharpe": sharpe,
        "params": {"entry_z": ENTRY_Z, "exit_z": EXIT_Z, "zscore_window": ZSCORE_WINDOW}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"NIFTY/SENSEX Spread | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nifty", required=True, dest="nifty_file")
    ap.add_argument("--sensex", required=True, dest="sensex_file")
    ap.add_argument("--outdir", default="./artifacts/nifty_sensex_spread")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
