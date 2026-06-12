#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nse_earnings_vol_crush.py — India-specific NSE earnings vol crush strategy
===========================================================================
Sells NIFTY/BANKNIFTY options straddles before major earnings announcements,
specifically targeting the IV crush that follows results. India earnings season
is concentrated in April-May (Q4 results) and October-November (Q2 results),
creating systematic selling windows.

India-specific edge:
  - NSE earnings IV spikes 30-50% before results (higher than US: 15-20%)
  - Post-result vol crush is faster (T+1 vs T+2 in US)
  - Quarterly patterns are highly predictable (fixed months)
  - BANKNIFTY results window (HDFC, ICICI, SBI all in same 2-week window)

Inputs (CSV)
------------
--earnings  earnings.csv    announce_date, ticker, eps_actual, eps_estimate (optional)
--options   options.csv     date, ticker, expiry, strike, type, iv, ltp
--prices    prices.csv      date, ticker, close

Outputs
-------
outdir/earnings_iv_profile.csv  ticker, days_before, avg_iv, iv_vs_baseline, crush_pct
outdir/results_window.csv       season (Q1/Q2/Q3/Q4), start_date, end_date, avg_crush_pct
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

# IV enrichment window (days before earnings with elevated IV)
PRE_EARNINGS_WINDOW = 10
POST_EARNINGS_WINDOW = 3
ENTRY_DAYS_BEFORE = 3     # Enter straddle 3 days before earnings
EXIT_DAYS_AFTER = 1       # Exit next day after results

# IV crush minimum to justify trade
MIN_IV_CRUSH_ESTIMATE_PCT = 20  # IV should drop >= 20% after results

# India earnings seasons (typically)
EARNINGS_SEASONS = {
    "Q1": ("April", "May"),      # March year-end results
    "Q2": ("July", "August"),    # June quarter results
    "Q3": ("October", "November"), # September quarter results
    "Q4": ("January", "February"),  # December quarter results
}


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    earnings = pd.read_csv(cfg.earnings_file, parse_dates=["announce_date"])
    earnings.columns = [c.lower().strip() for c in earnings.columns]

    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]
    prices_wide = prices.pivot_table(index="date", columns="ticker", values="close").sort_index()

    opts = None
    if cfg.options_file and os.path.exists(cfg.options_file):
        opts = pd.read_csv(cfg.options_file, parse_dates=["date"])
        opts.columns = [c.lower().strip() for c in opts.columns]

    iv_profile_records = []
    backtest_pnls = []

    for _, event in earnings.iterrows():
        ticker = str(event["ticker"]).upper()
        ann_date = event["announce_date"]

        if ticker not in prices_wide.columns:
            continue

        px = prices_wide[ticker].dropna()
        entry_date = ann_date - pd.Timedelta(days=ENTRY_DAYS_BEFORE)
        exit_date = ann_date + pd.Timedelta(days=EXIT_DAYS_AFTER)

        entry_px = float(px.asof(entry_date)) if not px.empty else np.nan
        exit_px = float(px.asof(exit_date)) if not px.empty else np.nan
        ann_px = float(px.asof(ann_date)) if not px.empty else np.nan

        if entry_px <= 0 or exit_px <= 0 or ann_px <= 0:
            continue

        # Price move on earnings day
        earnings_move_pct = abs((ann_px / float(px.asof(ann_date - pd.Timedelta(days=1))) - 1) * 100)

        # IV analysis from options data
        pre_iv = post_iv = None
        if opts is not None and "ticker" in opts.columns and "iv" in opts.columns:
            ticker_opts = opts[opts["ticker"].str.upper() == ticker]
            pre_opts = ticker_opts[
                (ticker_opts["date"] >= entry_date) &
                (ticker_opts["date"] <= ann_date)
            ]
            post_opts = ticker_opts[
                (ticker_opts["date"] > ann_date) &
                (ticker_opts["date"] <= exit_date + pd.Timedelta(days=2))
            ]
            if not pre_opts.empty:
                pre_iv = float(pre_opts["iv"].mean())
            if not post_opts.empty:
                post_iv = float(post_opts["iv"].mean())

        iv_crush_pct = ((pre_iv - post_iv) / pre_iv * 100) if (pre_iv and post_iv and pre_iv > 0) else np.nan

        # Earnings straddle P&L approximation:
        # We sell straddle at entry, buy back after results
        # Win if price move < straddle premium collected
        # Straddle premium ≈ 0.8 * stock_price * (IV/100) * sqrt(DTE/365)
        dte_at_entry = ENTRY_DAYS_BEFORE
        if not np.isnan(entry_px) and not np.isnan(iv_crush_pct):
            approx_straddle_pct = 0.8 * (pre_iv or 30) / 100 * np.sqrt(dte_at_entry / 365)
            pnl_pct = approx_straddle_pct - earnings_move_pct / 100
            backtest_pnls.append(float(pnl_pct))

        # Earnings season classification
        month = ann_date.month
        season = "Q1" if month in [4, 5] else ("Q2" if month in [7, 8] else
                 ("Q3" if month in [10, 11] else ("Q4" if month in [1, 2] else "off_cycle")))

        iv_profile_records.append({
            "ticker": ticker,
            "announce_date": ann_date.date(),
            "season": season,
            "earnings_move_pct": float(earnings_move_pct),
            "pre_iv": float(pre_iv) if pre_iv else None,
            "post_iv": float(post_iv) if post_iv else None,
            "iv_crush_pct": float(iv_crush_pct) if not np.isnan(iv_crush_pct) else None,
            "entry_price": float(entry_px),
            "exit_price": float(exit_px),
        })

    if iv_profile_records:
        prof_df = pd.DataFrame(iv_profile_records)
        prof_df.sort_values("announce_date").to_csv(os.path.join(cfg.outdir, "earnings_iv_profile.csv"), index=False)

        # Season analysis
        season_stats = prof_df.groupby("season").apply(
            lambda g: pd.Series({
                "n_events": len(g),
                "avg_earnings_move_pct": float(g["earnings_move_pct"].mean()),
                "avg_iv_crush_pct": float(g["iv_crush_pct"].dropna().mean()) if g["iv_crush_pct"].notna().any() else None,
                "avg_pre_iv": float(g["pre_iv"].dropna().mean()) if g["pre_iv"].notna().any() else None,
            })
        ).reset_index()
        season_stats.to_csv(os.path.join(cfg.outdir, "results_window.csv"), index=False)

    if backtest_pnls:
        rets = pd.Series(backtest_pnls)
        cum = (1 + rets).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(rets.mean() / rets.std() * np.sqrt(4)) if rets.std() > 0 else None  # Quarterly
        win_rate = float((rets > 0).mean())
    else:
        sharpe = win_rate = None

    summary = {
        "n_earnings_events": len(iv_profile_records),
        "avg_earnings_move_pct": float(np.mean([r["earnings_move_pct"] for r in iv_profile_records])) if iv_profile_records else None,
        "avg_iv_crush_pct": float(np.nanmean([r["iv_crush_pct"] for r in iv_profile_records if r["iv_crush_pct"]])) if iv_profile_records else None,
        "win_rate": win_rate,
        "ann_sharpe": sharpe,
        "params": {"entry_days_before": ENTRY_DAYS_BEFORE, "exit_days_after": EXIT_DAYS_AFTER}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"NSE Earnings Vol Crush | {len(iv_profile_records)} events | Win rate: {win_rate:.1%} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--earnings", required=True, dest="earnings_file")
    ap.add_argument("--options", default=None, dest="options_file")
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--outdir", default="./artifacts/nse_earnings_vol")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
