#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app_download_rankings.py — App store rank changes predict revenue beats
========================================================================
Mobile app download rank is a high-frequency leading indicator of user
acquisition. Rank improvement ahead of earnings → revenue upside.

Inputs (CSV)
------------
--ranks    app_ranks.csv     Columns: date, ticker, app_name, rank, store (ios/android)
--returns  stock_returns.csv Columns: date, ticker, return

Outputs
-------
outdir/rank_signals.csv        date, ticker, rank_change_pct, signal
outdir/rank_vs_returns.csv     correlation analysis
outdir/backtest.csv            cumulative strategy P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def compute_rank_momentum(ranks: pd.DataFrame, ticker: str, short_window: int, long_window: int) -> pd.DataFrame:
    sub = ranks[ranks["ticker"] == ticker].copy()
    if sub.empty:
        return pd.DataFrame()
    sub = sub.sort_values("date").set_index("date")
    # Lower rank = better (rank 1 is top). Invert so higher = better.
    sub["inv_rank"] = 1 / sub["rank"].clip(lower=1)
    sub["short_ma"] = sub["inv_rank"].rolling(short_window).mean()
    sub["long_ma"] = sub["inv_rank"].rolling(long_window).mean()
    sub["rank_momentum"] = (sub["short_ma"] - sub["long_ma"]) / sub["long_ma"].replace(0, np.nan)
    sub["rank_zscore"] = (sub["inv_rank"] - sub["inv_rank"].rolling(long_window).mean()) / \
                         sub["inv_rank"].rolling(long_window).std().replace(0, np.nan)
    return sub[["inv_rank", "rank_momentum", "rank_zscore"]].dropna()


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    ranks = pd.read_csv(cfg.ranks_file, parse_dates=["date"])
    ranks.columns = [c.lower().strip() for c in ranks.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    tickers = ranks["ticker"].unique()
    signal_records = []
    corr_records = []
    all_daily = []

    for ticker in tickers:
        mom = compute_rank_momentum(ranks, ticker, cfg.short_window, cfg.long_window)
        if mom.empty or ticker not in ret_wide.columns:
            continue

        # Align with returns
        aligned = mom.join(ret_wide[[ticker]].rename(columns={ticker: "fwd_ret"}), how="inner")
        aligned["fwd_ret"] = aligned[ticker] if ticker in aligned.columns else aligned["fwd_ret"]
        aligned["fwd_ret"] = ret_wide[ticker].reindex(aligned.index).shift(-1)

        for date, row in mom.iterrows():
            sig = "buy" if row["rank_zscore"] > cfg.zscore_threshold else \
                  ("sell" if row["rank_zscore"] < -cfg.zscore_threshold else "neutral")
            signal_records.append({"date": date, "ticker": ticker,
                                   "rank_zscore": float(row["rank_zscore"]),
                                   "rank_momentum": float(row["rank_momentum"]),
                                   "signal": sig})

        # Correlation: rank zscore vs next-week return
        if len(aligned) > 20:
            fwd = ret_wide[ticker].reindex(aligned.index).rolling(5).sum().shift(-5)
            common = aligned["rank_zscore"].dropna().align(fwd.dropna(), join="inner")
            if len(common[0]) > 10:
                r, p = stats.pearsonr(common[0].values, common[1].values)
                corr_records.append({"ticker": ticker, "corr_rank_vs_fwd5d": float(r), "pvalue": float(p), "n_obs": len(common[0])})

        # Backtest: go long when rank zscore > threshold
        pos = mom["rank_zscore"].apply(lambda z: 1 if z > cfg.zscore_threshold else (-1 if z < -cfg.zscore_threshold else 0))
        stk_ret = ret_wide[ticker].reindex(mom.index)
        strategy_ret = pos.shift(1) * stk_ret
        all_daily.append(strategy_ret.rename(ticker))

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "rank_signals.csv"), index=False)

    corr_df = pd.DataFrame(corr_records).sort_values("pvalue") if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "rank_vs_returns.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
    else:
        port = pd.Series(dtype=float)
        sharpe = None

    summary = {
        "n_tickers": len(tickers), "n_signals": len(sig_df),
        "buy_signals": int((sig_df["signal"] == "buy").sum()) if not sig_df.empty else 0,
        "avg_corr_rank_fwd": float(corr_df["corr_rank_vs_fwd5d"].mean()) if not corr_df.empty else None,
        "ann_return": float(port.mean() * 252) if len(port) > 0 else None,
        "sharpe": sharpe,
        "params": {"short_window": cfg.short_window, "long_window": cfg.long_window, "zscore_threshold": cfg.zscore_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"App ranks | Tickers: {len(tickers)} | Signals: {len(sig_df)} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ranks", required=True, dest="ranks_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--short-window", type=int, default=7)
    ap.add_argument("--long-window", type=int, default=30)
    ap.add_argument("--zscore-threshold", type=float, default=1.5)
    ap.add_argument("--outdir", default="./artifacts/app_download_rankings")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
