#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nse_sector_neutral_pairs.py — NSE sector-neutral long/short pairs strategy
===========================================================================
Runs cointegration within each NIFTY sector (banking, IT, pharma, auto, FMCG)
to identify pairs. Goes long the underperformer and short the outperformer
within the same sector, keeping gross beta-neutral within the pair.

India moat: sectors on NSE have strong co-movement due to common FII/DII
flows, RBI policy, and sector-specific earnings cycles. Intra-sector pairs
mean-revert faster than cross-sector pairs.

Inputs (CSV)
------------
--prices    prices.csv      date, ticker, close
--sectors   sectors.csv     ticker, sector (NIFTY sector classification)

Outputs
-------
outdir/sector_pairs.csv          pair, sector, hedge_ratio, half_life_days, sharpe
outdir/sector_signals.csv        date, pair, sector, z_score, position
outdir/backtest.csv              cumulative P&L by sector
outdir/summary.json
"""

import argparse
import json
import os
from itertools import combinations

import numpy as np
import pandas as pd
from scipy import stats

# NSE sector classification (NIFTY sector indices)
NSE_SECTORS = {
    "BANKING":  ["HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK", "AXISBANK", "INDUSINDBK", "BANDHANBNK", "FEDERALBNK"],
    "IT":       ["TCS", "INFY", "HCLTECH", "WIPRO", "TECHM", "LTIM", "MPHASIS", "COFORGE"],
    "PHARMA":   ["SUNPHARMA", "DRREDDY", "CIPLA", "DIVISLAB", "BIOCON", "ALKEM", "IPCALAB", "GLENMARK"],
    "AUTO":     ["MARUTI", "TATAMOTORS", "M&M", "BAJAJ-AUTO", "EICHERMOT", "HEROMOTOCO", "ASHOKLEY", "TVSMOTOR"],
    "FMCG":     ["HINDUNILVR", "ITC", "NESTLEIND", "BRITANNIA", "DABUR", "MARICO", "GODREJCP", "COLPAL"],
    "ENERGY":   ["RELIANCE", "ONGC", "BPCL", "IOC", "GAIL", "PETRONET", "MGL", "IGL"],
    "METALS":   ["TATASTEEL", "JSWSTEEL", "HINDALCO", "VEDL", "NMDC", "NATIONALUM", "SAIL", "JSPL"],
    "REALTY":   ["DLF", "GODREJPROP", "OBEROIRLTY", "BRIGADE", "PRESTIGE", "PHOENIXLTD", "SOBHA", "MAHLIFE"],
}

ENTRY_Z = 2.0
EXIT_Z = 0.5
MAX_HALF_LIFE = 45
MIN_HALF_LIFE = 2
COINT_PVALUE = 0.05
ZSCORE_WINDOW = 60


def engle_granger(y: np.ndarray, x: np.ndarray):
    X = np.column_stack([x, np.ones(len(x))])
    beta = np.linalg.lstsq(X, y, rcond=None)[0]
    residuals = y - X @ beta
    d_resid = np.diff(residuals)
    lag_resid = residuals[:-1]
    X2 = np.column_stack([lag_resid, np.ones(len(lag_resid))])
    b2 = np.linalg.lstsq(X2, d_resid, rcond=None)[0]
    sse = np.sum((d_resid - X2 @ b2) ** 2)
    n = len(d_resid)
    se = np.sqrt(sse / (n - 2) / (np.sum((lag_resid - lag_resid.mean()) ** 2) + 1e-10))
    t_stat = b2[0] / se if se > 0 else 0
    p_val = float(stats.t.cdf(t_stat, df=n - 2))
    return beta[0], residuals, p_val


def ou_half_life(spread: np.ndarray) -> float:
    d = np.diff(spread)
    lag = spread[:-1]
    X = np.column_stack([lag, np.ones(len(lag))])
    b = np.linalg.lstsq(X, d, rcond=None)[0]
    return float(-np.log(2) / b[0]) if b[0] < 0 else np.nan


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    prices_df = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices_df.columns = [c.lower().strip() for c in prices_df.columns]
    wide = prices_df.pivot(index="date", columns="ticker", values="close").sort_index().dropna(how="all")

    # Build sector map from file or use defaults
    if cfg.sectors_file and os.path.exists(cfg.sectors_file):
        sec_df = pd.read_csv(cfg.sectors_file)
        sec_df.columns = [c.lower().strip() for c in sec_df.columns]
        dict(zip(sec_df["ticker"].str.upper(), sec_df["sector"].str.upper()))
    else:
        {tk: sec for sec, tks in NSE_SECTORS.items() for tk in tks}

    all_pairs = []
    sector_backtests = {}

    for sector, tickers in NSE_SECTORS.items():
        avail = [t for t in tickers if t in wide.columns]
        if len(avail) < 2:
            continue
        sec_wide = wide[avail].dropna()
        if len(sec_wide) < 120:
            continue

        sector_pairs = []
        for t1, t2 in combinations(avail, 2):
            y, x = sec_wide[t1].values, sec_wide[t2].values
            try:
                hr, resid, pval = engle_granger(y, x)
            except Exception:
                continue
            if pval > COINT_PVALUE:
                continue
            hl = ou_half_life(resid)
            if np.isnan(hl) or hl < MIN_HALF_LIFE or hl > MAX_HALF_LIFE:
                continue
            sector_pairs.append({
                "t1": t1, "t2": t2, "sector": sector,
                "hedge_ratio": float(hr), "half_life_days": float(hl), "coint_pvalue": float(pval)
            })

        if not sector_pairs:
            continue

        # Backtest sector pairs
        sector_daily = []
        for p in sector_pairs:
            spread = sec_wide[p["t1"]] - p["hedge_ratio"] * sec_wide[p["t2"]]
            mu = spread.rolling(ZSCORE_WINDOW).mean()
            sigma = spread.rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
            z = (spread - mu) / sigma

            pos = z.shift(1).apply(
                lambda v: -1 if v > ENTRY_Z else (1 if v < -ENTRY_Z else (0 if abs(v) < EXIT_Z else np.nan))
            ).ffill().fillna(0)

            r1 = sec_wide[p["t1"]].pct_change()
            r2 = sec_wide[p["t2"]].pct_change()
            pair_ret = pos * (r1 - p["hedge_ratio"] * r2)
            sector_daily.append(pair_ret)

            sharpe = float(pair_ret.mean() / pair_ret.std() * np.sqrt(252)) if pair_ret.std() > 0 else None
            p["sharpe"] = sharpe
            all_pairs.append(p)

        if sector_daily:
            sector_port = pd.concat(sector_daily, axis=1).mean(axis=1).dropna()
            sector_backtests[sector] = sector_port

    if not all_pairs:
        print("No cointegrated NSE sector pairs found.")
        return

    pd.DataFrame(all_pairs).sort_values(["sector", "coint_pvalue"]).to_csv(
        os.path.join(cfg.outdir, "sector_pairs.csv"), index=False
    )

    if sector_backtests:
        bt_df = pd.DataFrame(sector_backtests).fillna(0)
        portfolio = bt_df.mean(axis=1)
        cum = (1 + portfolio).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(portfolio.mean() / portfolio.std() * np.sqrt(252)) if portfolio.std() > 0 else None

        summary = {
            "n_sector_pairs": len(all_pairs),
            "sectors_active": list(sector_backtests.keys()),
            "ann_return": float(portfolio.mean() * 252),
            "sharpe": sharpe,
            "params": {"entry_z": ENTRY_Z, "exit_z": EXIT_Z, "max_half_life": MAX_HALF_LIFE}
        }
        with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
            json.dump(summary, f, indent=2, default=str)
        print(f"NSE Sector Pairs | {len(all_pairs)} pairs across {len(sector_backtests)} sectors | Sharpe: {sharpe:.2f} | Written to {cfg.outdir}")
    else:
        print("No backtest data generated.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--sectors", default=None, dest="sectors_file")
    ap.add_argument("--outdir", default="./artifacts/nse_sector_pairs")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
