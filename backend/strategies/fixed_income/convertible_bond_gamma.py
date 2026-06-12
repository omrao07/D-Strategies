#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
convertible_bond_gamma.py — Convertible bond gamma trading (delta-hedged arb)
================================================================================
Convertible bonds contain an embedded equity call option. Delta-hedging the
equity exposure extracts the "gamma" (convexity profit). When implied vol in the
convertible exceeds listed options → rich → sell CB vol. When CB vol < listed → buy.

Inputs (CSV)
------------
--converts  convertible_bonds.csv
    Columns: date, ticker, cb_price, face_value, coupon_pct, maturity_years,
             conversion_ratio, credit_spread_bps, implied_vol_pct
--equity    equity_data.csv
    Columns: date, ticker, stock_price, listed_iv_pct, historical_vol_pct

Outputs
-------
outdir/cb_gamma.csv             date, ticker, delta, gamma, cb_iv, listed_iv, vol_gap_pct, signal
outdir/delta_hedged_pnl.csv     daily delta-hedged P&L simulation
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd
from scipy.stats import norm


def black_scholes_delta(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """Delta of call option embedded in convertible."""
    if T <= 0 or sigma <= 0 or S <= 0:
        return 0.5
    d1 = (np.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
    return float(norm.cdf(d1))


def black_scholes_gamma(S: float, K: float, T: float, r: float, sigma: float) -> float:
    if T <= 0 or sigma <= 0 or S <= 0:
        return 0.0
    d1 = (np.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
    return float(norm.pdf(d1) / (S * sigma * np.sqrt(T)))


def compute_conversion_price(face: float, ratio: float) -> float:
    return face / ratio if ratio > 0 else np.nan


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    converts = pd.read_csv(cfg.converts_file, parse_dates=["date"])
    converts.columns = [c.lower().strip() for c in converts.columns]
    equity = pd.read_csv(cfg.equity_file, parse_dates=["date"])
    equity.columns = [c.lower().strip() for c in equity.columns]
    eq_wide = equity.pivot_table(index="date", columns="ticker", values=["stock_price", "listed_iv_pct", "historical_vol_pct"])
    eq_wide.columns = [f"{col}_{ticker}" for col, ticker in eq_wide.columns]

    gamma_records = []
    hedged_pnl = []

    for ticker in converts["ticker"].unique():
        sub_cb = converts[converts["ticker"] == ticker].set_index("date").sort_index()
        price_col = f"stock_price_{ticker}"
        listed_iv_col = f"listed_iv_pct_{ticker}"

        for date in sub_cb.index:
            cb_row = sub_cb.loc[date]
            S = float(eq_wide.get(price_col, pd.Series()).get(date, np.nan)) if price_col in eq_wide.columns else np.nan
            K = compute_conversion_price(float(cb_row.get("face_value", 1000)), float(cb_row.get("conversion_ratio", 20)))
            T = float(cb_row.get("maturity_years", 5))
            r = float(cb_row.get("credit_spread_bps", 200)) / 10000
            cb_iv = float(cb_row.get("implied_vol_pct", np.nan)) / 100 if not np.isnan(cb_row.get("implied_vol_pct", np.nan)) else np.nan
            listed_iv = float(eq_wide.get(listed_iv_col, pd.Series()).get(date, np.nan)) / 100 if listed_iv_col in eq_wide.columns else np.nan

            if np.isnan(S) or np.isnan(K) or np.isnan(cb_iv):
                continue

            delta = black_scholes_delta(S, K, T, r, cb_iv)
            gamma = black_scholes_gamma(S, K, T, r, cb_iv)

            vol_gap = (cb_iv - listed_iv) * 100 if not np.isnan(listed_iv) else np.nan
            # Positive vol gap = CB vol > listed vol → CB embedded option is expensive → sell CB vol
            # Negative vol gap = CB vol < listed → CB is cheap relative to options → buy CB vol
            if np.isnan(vol_gap):
                signal = "neutral"
            elif vol_gap > cfg.vol_gap_threshold:
                signal = "sell_cb_vol_buy_listed"
            elif vol_gap < -cfg.vol_gap_threshold:
                signal = "buy_cb_vol_sell_listed"
            else:
                signal = "neutral"

            gamma_records.append({
                "date": date, "ticker": ticker,
                "stock_price": float(S), "conversion_price": float(K),
                "cb_iv_pct": float(cb_iv * 100),
                "listed_iv_pct": float(listed_iv * 100) if not np.isnan(listed_iv) else None,
                "vol_gap_pct": float(vol_gap) if not np.isnan(vol_gap) else None,
                "delta": float(delta), "gamma": float(gamma), "signal": signal
            })

    gamma_df = pd.DataFrame(gamma_records).sort_values(["date", "ticker"])
    gamma_df.to_csv(os.path.join(cfg.outdir, "cb_gamma.csv"), index=False)

    # Delta-hedged P&L simulation
    if not gamma_df.empty:
        for ticker in gamma_df["ticker"].unique():
            sub = gamma_df[gamma_df["ticker"] == ticker].set_index("date").sort_index()
            price_col = f"stock_price_{ticker}"
            if price_col not in eq_wide.columns:
                continue
            stock = eq_wide[price_col].dropna()
            stock_ret = stock.pct_change().dropna()
            gamma_series = sub["gamma"].reindex(stock_ret.index).ffill().shift(1)
            # Gamma P&L: 0.5 * gamma * S^2 * (Δ ln S)^2 per day
            dS = stock_ret * stock.reindex(stock_ret.index)
            gamma_pnl = 0.5 * gamma_series * (dS ** 2)
            hedged_ret = gamma_pnl.fillna(0)  # simplified: long gamma, short delta continuously
            hedged_pnl.append(hedged_ret.rename(ticker))

    if hedged_pnl:
        port = pd.concat(hedged_pnl, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "delta_hedged_pnl.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_tickers": converts["ticker"].nunique(), "n_observations": len(gamma_df),
        "avg_cb_iv_pct": float(gamma_df["cb_iv_pct"].mean()) if not gamma_df.empty else None,
        "avg_vol_gap_pct": float(gamma_df["vol_gap_pct"].dropna().mean()) if not gamma_df.empty else None,
        "n_buy_signals": int((gamma_df["signal"] == "buy_cb_vol_sell_listed").sum()) if not gamma_df.empty else 0,
        "n_sell_signals": int((gamma_df["signal"] == "sell_cb_vol_buy_listed").sum()) if not gamma_df.empty else 0,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"vol_gap_threshold": cfg.vol_gap_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"CB gamma | Tickers: {summary['n_tickers']} | Buy vol: {summary['n_buy_signals']} | Sell vol: {summary['n_sell_signals']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--converts", required=True, dest="converts_file")
    ap.add_argument("--equity", required=True, dest="equity_file")
    ap.add_argument("--vol-gap-threshold", type=float, default=5.0, help="Vol gap in %% to signal")
    ap.add_argument("--outdir", default="./artifacts/cb_gamma")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
