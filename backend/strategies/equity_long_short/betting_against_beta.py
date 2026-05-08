#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
betting_against_beta.py — Long low beta, short high beta — leverage-constrained alpha
---------------------------------------------------------------------------------------
Replicates the Frazzini-Pedersen Betting Against Beta (BAB) factor. Builds a
beta-neutral portfolio: long low-beta stocks (levered up) and short high-beta stocks
(levered down) so total portfolio beta = 0.

Inputs (CSV)
------------
--returns  returns.csv   REQUIRED: date, ticker, return (daily decimal)
                         Must include a column for market return (ticker = "SPY" or "--market")

Outputs
-------
outdir/beta_ranks.csv    ticker, beta, rank, quintile
outdir/bab_returns.csv   date, bab_return, cumulative
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def load_returns(path: str, market: str) -> tuple:
    df = pd.read_csv(path, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    wide = df.pivot(index="date", columns="ticker", values="return").sort_index()
    if market not in wide.columns:
        raise SystemExit(f"Market ticker '{market}' not found in returns file.")
    mkt = wide.pop(market)
    return wide, mkt


def rolling_beta(stock: pd.Series, market: pd.Series, window: int = 252) -> pd.Series:
    cov = stock.rolling(window).cov(market)
    var = market.rolling(window).var()
    return cov / var.replace(0, np.nan)


def compute_betas(wide: pd.DataFrame, market: pd.Series, window: int = 252) -> pd.DataFrame:
    betas = {}
    for ticker in wide.columns:
        b = rolling_beta(wide[ticker], market, window)
        betas[ticker] = b
    return pd.DataFrame(betas)


def build_bab_return(wide: pd.DataFrame, beta_df: pd.DataFrame, market: pd.Series, rebal: int = 21) -> pd.DataFrame:
    dates = wide.index[252:]
    records = []
    longs, shorts, beta_l, beta_h = [], [], 1.0, 1.0
    for i, date in enumerate(dates):
        if i % rebal == 0:
            betas = beta_df.loc[date].dropna()
            if len(betas) < 10:
                continue
            ranked = betas.rank()
            n = len(ranked)
            longs = betas[ranked <= n // 5].index.tolist()
            shorts = betas[ranked > 4 * n // 5].index.tolist()
            beta_l = max(betas[longs].mean(), 0.01)
            beta_h = max(betas[shorts].mean(), 0.01)
        if not longs or not shorts:
            continue
        r_l = wide.loc[date, [t for t in longs if t in wide.columns]].mean()
        r_h = wide.loc[date, [t for t in shorts if t in wide.columns]].mean()
        # Scale: long portfolio levered to beta=1, short portfolio scaled to beta=1
        bab_ret = (r_l / beta_l) - (r_h / beta_h)
        records.append({"date": date, "long_return": r_l, "short_return": r_h,
                        "beta_low": beta_l, "beta_high": beta_h, "bab_return": bab_ret})
    df = pd.DataFrame(records).set_index("date")
    df["cumulative"] = (1 + df["bab_return"]).cumprod()
    return df


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    wide, market = load_returns(cfg.returns_file, cfg.market)
    beta_df = compute_betas(wide, market, cfg.beta_window)

    last_betas = beta_df.iloc[-1].dropna().sort_values()
    ranks = pd.qcut(last_betas.rank(method="first"), 5, labels=False) + 1
    rank_df = pd.DataFrame({"ticker": last_betas.index, "beta": last_betas.values, "quintile": ranks.values})
    rank_df.to_csv(os.path.join(cfg.outdir, "beta_ranks.csv"), index=False)

    bab = build_bab_return(wide, beta_df, market, cfg.rebal_days)
    bab.to_csv(os.path.join(cfg.outdir, "bab_returns.csv"))

    ls = bab["bab_return"].dropna()
    summary = {"n_obs": len(bab), "ann_return": float(ls.mean() * 252),
               "ann_vol": float(ls.std() * np.sqrt(252)),
               "sharpe": float(ls.mean() / ls.std() * np.sqrt(252)) if ls.std() > 0 else None,
               "avg_low_beta": float(rank_df[rank_df["quintile"] == 1]["beta"].mean()),
               "avg_high_beta": float(rank_df[rank_df["quintile"] == 5]["beta"].mean())}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"BAB Sharpe: {summary['sharpe']:.2f} | Low-beta avg: {summary['avg_low_beta']:.2f} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--market", default="SPY")
    ap.add_argument("--beta-window", type=int, default=252)
    ap.add_argument("--rebal-days", type=int, default=21)
    ap.add_argument("--outdir", default="./artifacts/bab")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
