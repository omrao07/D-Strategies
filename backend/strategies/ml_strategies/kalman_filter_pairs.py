#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
kalman_filter_pairs.py — Kalman filter dynamic hedge ratio for pairs trading
=============================================================================
Uses a Kalman filter to estimate a time-varying hedge ratio (beta) between two
assets. Spread = Y - beta*X. When spread z-score exceeds threshold, mean
reversion bet is placed. More adaptive than OLS rolling regression — handles
regime shifts in correlation.

Inputs (CSV)
------------
--prices   prices.csv
    Columns: date, ticker, close
--pairs    pairs.csv (optional)
    Columns: asset_y, asset_x, sector

Outputs
-------
outdir/kf_pairs_signals.csv date, pair, beta, spread, spread_zscore, signal
outdir/pair_stats.csv       pair-level performance: half-life, Sharpe, correlation
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd
from scipy import stats


def kalman_filter_hedge_ratio(y: np.ndarray, x: np.ndarray,
                               delta: float = 1e-5,
                               ve: float = 0.001) -> tuple:
    n = len(y)
    beta = np.zeros(n)
    P = np.ones(n)
    beta[0] = y[0] / (x[0] + 1e-10)

    for t in range(1, n):
        # Predict
        beta_pred = beta[t-1]
        P_pred = P[t-1] + delta

        # Update
        xt = x[t]
        innov = y[t] - beta_pred * xt
        S = xt**2 * P_pred + ve
        K = P_pred * xt / (S + 1e-10)
        beta[t] = beta_pred + K * innov
        P[t] = (1 - K * xt) * P_pred

    return beta, P


def compute_half_life(spread: pd.Series) -> float:
    spread_lag = spread.shift(1).dropna()
    spread_diff = spread.diff().dropna()
    spread_lag, spread_diff = spread_lag.align(spread_diff, join="inner")
    if len(spread_lag) < 20:
        return np.nan
    slope, _, _, _, _ = stats.linregress(spread_lag.values, spread_diff.values)
    if slope >= 0:
        return np.nan
    return -np.log(2) / slope


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]
    price_wide = prices.pivot(index="date", columns="ticker", values="close").sort_index()

    # Load or auto-generate pairs
    if cfg.pairs_file:
        pairs_df = pd.read_csv(cfg.pairs_file)
        pairs_df.columns = [c.lower().strip() for c in pairs_df.columns]
        pairs = [(str(r["asset_y"]), str(r["asset_x"])) for _, r in pairs_df.iterrows()]
    else:
        tickers = list(price_wide.columns)
        pairs = [(tickers[i], tickers[j]) for i in range(len(tickers)) for j in range(i+1, len(tickers))
                 if i != j][:50]  # limit auto-generation

    all_signals = []
    pair_stats = []

    for y_ticker, x_ticker in pairs:
        if y_ticker not in price_wide.columns or x_ticker not in price_wide.columns:
            continue
        df = price_wide[[y_ticker, x_ticker]].dropna()
        if len(df) < 100:
            continue

        y = df[y_ticker].values
        x = df[x_ticker].values

        beta, P = kalman_filter_hedge_ratio(y, x, delta=cfg.delta, ve=cfg.ve)
        spread = y - beta * x

        spread_s = pd.Series(spread, index=df.index)
        spread_mean = spread_s.rolling(cfg.lookback).mean()
        spread_std = spread_s.rolling(cfg.lookback).std().replace(0, np.nan)
        spread_zscore = (spread_s - spread_mean) / spread_std

        half_life = compute_half_life(spread_s.dropna())

        for date, z in spread_zscore.dropna().items():
            idx = df.index.get_loc(date)
            beta_val = beta[idx]
            signal = "long_y_short_x" if z < -cfg.entry_z else \
                     ("short_y_long_x" if z > cfg.entry_z else "neutral")
            if abs(z) < cfg.exit_z:
                signal = "exit"
            all_signals.append({
                "date": date,
                "pair": f"{y_ticker}_{x_ticker}",
                "y_ticker": y_ticker, "x_ticker": x_ticker,
                "beta": float(beta_val),
                "spread": float(spread_s[date]),
                "spread_zscore": float(z),
                "signal": signal
            })

        # Pair stats
        pair_ret_y = df[y_ticker].pct_change()
        pair_ret_x = df[x_ticker].pct_change()
        pos = spread_zscore.apply(
            lambda z: (1 if z < -cfg.entry_z else (-1 if z > cfg.entry_z else 0))
        ).shift(1).fillna(0)
        hedge_ret = pos * (pair_ret_y - pd.Series(beta, index=df.index) * pair_ret_x)
        hedge_ret_clean = hedge_ret.dropna()

        pair_sharpe = float(hedge_ret_clean.mean() / hedge_ret_clean.std() * np.sqrt(252)) if len(hedge_ret_clean) > 30 and hedge_ret_clean.std() > 0 else None
        pair_stats.append({
            "pair": f"{y_ticker}_{x_ticker}",
            "half_life_days": float(half_life) if not np.isnan(half_life) else None,
            "spread_std": float(np.std(spread)),
            "pair_sharpe": pair_sharpe
        })

    if not all_signals:
        print("No signals — check pairs data")
        return

    sig_df = pd.DataFrame(all_signals).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "kf_pairs_signals.csv"), index=False)
    pd.DataFrame(pair_stats).to_csv(os.path.join(cfg.outdir, "pair_stats.csv"), index=False)

    # Backtest: portfolio of all pair positions
    pair_daily = {}
    for pair_name in sig_df["pair"].unique():
        sub = sig_df[sig_df["pair"] == pair_name]
        y_t = sub["y_ticker"].iloc[0]
        x_t = sub["x_ticker"].iloc[0]
        if y_t not in price_wide.columns or x_t not in price_wide.columns:
            continue
        pair_prices = price_wide[[y_t, x_t]].dropna()
        ret_y = pair_prices[y_t].pct_change()
        ret_x = pair_prices[x_t].pct_change()
        pos_series = sub.set_index("date")["signal"].map(
            {"long_y_short_x": 1, "neutral": 0, "exit": 0, "short_y_long_x": -1}
        ).fillna(0)
        beta_series = sub.set_index("date")["beta"]
        pos_d = pos_series.reindex(ret_y.index).ffill().shift(1).fillna(0)
        beta_d = beta_series.reindex(ret_y.index).ffill().fillna(1)
        pair_ret = pos_d * (ret_y - beta_d * ret_x)
        pair_daily[pair_name] = pair_ret

    if pair_daily:
        port = pd.concat(pair_daily.values(), axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    ps_df = pd.DataFrame(pair_stats)
    summary = {
        "n_pairs": len(pairs),
        "n_tradeable_pairs": len(pair_stats),
        "avg_half_life_days": float(ps_df["half_life_days"].mean()) if not ps_df.empty else None,
        "best_pair": str(ps_df.loc[ps_df["pair_sharpe"].dropna().idxmax(), "pair"]) if not ps_df.empty and ps_df["pair_sharpe"].notna().any() else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"entry_z": cfg.entry_z, "delta": cfg.delta, "ve": cfg.ve, "lookback": cfg.lookback}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Kalman Pairs | Pairs: {summary['n_pairs']} | Avg half-life: {summary['avg_half_life_days']:.1f}d | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--pairs", default=None, dest="pairs_file")
    ap.add_argument("--entry-z", type=float, default=2.0)
    ap.add_argument("--exit-z", type=float, default=0.5)
    ap.add_argument("--delta", type=float, default=1e-5)
    ap.add_argument("--ve", type=float, default=0.001)
    ap.add_argument("--lookback", type=int, default=60)
    ap.add_argument("--outdir", default="./artifacts/kalman_pairs")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
