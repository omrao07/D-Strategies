#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
psu_vs_private_sector_pairs.py — PSU vs Private sector pairs (banking, oil, metals)
=====================================================================================
Indian PSU (Public Sector Undertaking) stocks react differently to policy events
(RBI, budget, capex cycles) than private-sector peers. Long private / short PSU
during privatization tailwinds; reverse during policy support phases.

Tracks pairs:
  - SBIN (PSU) vs HDFCBANK (private)       Banking
  - ONGC (PSU) vs RELIANCE (private)        Energy
  - SAIL (PSU) vs TATASTEEL (private)       Metals
  - PNB (PSU) vs AXISBANK (private)         Banking 2
  - IOC (PSU) vs BPCL (private-ish)         Refining
  - BHEL (PSU) vs SIEMENS (MNC)             Capital goods
  - NTPC (PSU) vs TATAPOWER (private)       Power

Inputs (CSV)
------------
--prices    prices.csv      date, ticker, close

Outputs
-------
outdir/psu_private_pairs.csv    pair, half_life, correlation, coint_pvalue
outdir/pair_signals.csv         date, pair, z_score, signal, position
outdir/backtest.csv             cumulative P&L per pair and portfolio
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats

PSU_PRIVATE_PAIRS = [
    ("SBIN",  "HDFCBANK", "banking"),
    ("ONGC",  "RELIANCE", "energy"),
    ("SAIL",  "TATASTEEL", "metals"),
    ("PNB",   "AXISBANK", "banking"),
    ("IOC",   "BPCL", "refining"),
    ("BHEL",  "SIEMENS", "capex"),
    ("NTPC",  "TATAPOWER", "power"),
    ("COALINDIA", "ADANIPOWER", "coal_power"),
]

ENTRY_Z = 1.5
EXIT_Z = 0.3
ZSCORE_WINDOW = 40
MIN_OBS = 120


def estimate_hedge_ratio_and_spread(y: np.ndarray, x: np.ndarray):
    X = np.column_stack([x, np.ones(len(x))])
    beta = np.linalg.lstsq(X, y, rcond=None)[0]
    return beta[0], y - X @ beta


def ou_half_life(spread: np.ndarray) -> float:
    d = np.diff(spread)
    lag = spread[:-1]
    X = np.column_stack([lag, np.ones(len(lag))])
    b = np.linalg.lstsq(X, d, rcond=None)[0]
    return float(-np.log(2) / b[0]) if b[0] < 0 else np.nan


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    df = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    wide = df.pivot(index="date", columns="ticker", values="close").sort_index()

    pair_records = []
    signal_records = []
    all_port = []

    for psu, priv, sector in PSU_PRIVATE_PAIRS:
        if psu not in wide.columns or priv not in wide.columns:
            continue
        sub = wide[[psu, priv]].dropna()
        if len(sub) < MIN_OBS:
            continue

        psu_px = sub[psu].values
        priv_px = sub[priv].values

        # Hedge ratio: PSU = beta * Private + alpha (regress PSU on Private)
        hr, spread = estimate_hedge_ratio_and_spread(psu_px, priv_px)
        hl = ou_half_life(spread)

        # Rolling z-score of spread
        spread_s = pd.Series(spread, index=sub.index)
        mu = spread_s.rolling(ZSCORE_WINDOW).mean()
        sigma = spread_s.rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
        z = (spread_s - mu) / sigma

        # Correlation
        corr = float(pd.Series(psu_px).corr(pd.Series(priv_px)))

        # ADF p-value approximation
        d_s = np.diff(spread)
        lag_s = spread[:-1]
        X2 = np.column_stack([lag_s, np.ones(len(lag_s))])
        b2 = np.linalg.lstsq(X2, d_s, rcond=None)[0]
        sse = np.sum((d_s - X2 @ b2) ** 2)
        n = len(d_s)
        se = np.sqrt(sse / (n - 2) / (np.sum((lag_s - lag_s.mean()) ** 2) + 1e-10))
        t_stat = b2[0] / se if se > 0 else 0
        pval = float(stats.t.cdf(t_stat, df=n - 2))

        pair_records.append({
            "psu": psu, "private": priv, "sector": sector,
            "hedge_ratio": float(hr),
            "half_life_days": float(hl) if not np.isnan(hl) else None,
            "correlation": corr,
            "coint_pvalue": pval,
        })

        # Signals: z-score of PSU vs Private spread
        # z > ENTRY_Z: PSU is rich relative to Private → short PSU, long Private
        # z < -ENTRY_Z: PSU is cheap → long PSU, short Private
        pos = z.shift(1).apply(
            lambda v: -1 if v > ENTRY_Z else (1 if v < -ENTRY_Z else (0 if abs(v) < EXIT_Z else np.nan))
        ).ffill().fillna(0)

        ret_psu = sub[psu].pct_change()
        ret_priv = sub[priv].pct_change()
        pair_ret = pos * (ret_psu - hr * ret_priv)

        sharpe = float(pair_ret.mean() / pair_ret.std() * np.sqrt(252)) if pair_ret.std() > 0 else None

        for dt in sub.index:
            signal_records.append({
                "date": dt,
                "pair": f"{psu}/{priv}",
                "sector": sector,
                "z_score": float(z.get(dt, np.nan)),
                "signal": "short_psu" if pos.get(dt, 0) == -1 else ("long_psu" if pos.get(dt, 0) == 1 else "flat"),
                "position": float(pos.get(dt, 0)),
            })

        all_port.append(pair_ret.rename(f"{psu}/{priv}"))
        pair_records[-1]["sharpe"] = sharpe

    if not pair_records:
        print("No PSU/private pairs found in data.")
        return

    pd.DataFrame(pair_records).to_csv(os.path.join(cfg.outdir, "psu_private_pairs.csv"), index=False)
    pd.DataFrame(signal_records).sort_values("date").to_csv(os.path.join(cfg.outdir, "pair_signals.csv"), index=False)

    if all_port:
        portfolio = pd.concat(all_port, axis=1).mean(axis=1).dropna()
        cum = (1 + portfolio).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(portfolio.mean() / portfolio.std() * np.sqrt(252)) if portfolio.std() > 0 else None
    else:
        sharpe = None

    summary = {
        "n_pairs": len(pair_records),
        "pairs_active": [f"{p['psu']}/{p['private']}" for p in pair_records],
        "ann_return": float(portfolio.mean() * 252) if all_port else None,
        "sharpe": sharpe,
        "params": {"entry_z": ENTRY_Z, "exit_z": EXIT_Z, "zscore_window": ZSCORE_WINDOW}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"PSU/Private Pairs | {len(pair_records)} pairs | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--outdir", default="./artifacts/psu_private_pairs")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
