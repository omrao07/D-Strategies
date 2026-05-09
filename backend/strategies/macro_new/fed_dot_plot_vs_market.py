#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fed_dot_plot_vs_market.py — Fed dot plot vs market-implied rates → positioning signal
=======================================================================================
The Fed dot plot (FOMC member rate projections) vs OIS-implied market path reveals
policy surprise risk. When dots are hawkish vs market → rate-sensitive assets
underperform. When dots are dovish vs market → reflation trade.

Inputs (CSV)
------------
--dots      fed_dots.csv
    Columns: meeting_date, year, dot_median_pct, dot_mean_pct, n_participants
--market    market_rates.csv
    Columns: date, ois_1y_pct, ois_2y_pct, ff_rate_pct, sofr_pct
--assets    asset_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/dot_vs_market.csv        meeting_date, dot_1y, market_1y, surprise_bp, signal
outdir/surprise_vs_returns.csv  rate surprise vs equity/bond returns
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def interpolate_market_rate(market: pd.DataFrame, as_of_date: pd.Timestamp, horizon_year: int) -> float:
    """Get market-implied rate for a given horizon from OIS data."""
    row = market[market.index <= as_of_date]
    if row.empty:
        return np.nan
    row = row.iloc[-1]
    if horizon_year == 1 and "ois_1y_pct" in row.index:
        return float(row["ois_1y_pct"])
    elif horizon_year == 2 and "ois_2y_pct" in row.index:
        return float(row["ois_2y_pct"])
    return np.nan


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    dots = pd.read_csv(cfg.dots_file, parse_dates=["meeting_date"])
    dots.columns = [c.lower().strip() for c in dots.columns]
    market = pd.read_csv(cfg.market_file, parse_dates=["date"])
    market.columns = [c.lower().strip() for c in market.columns]
    market = market.set_index("date").sort_index()
    assets = pd.read_csv(cfg.assets_file, parse_dates=["date"])
    assets.columns = [c.lower().strip() for c in assets.columns]
    ret_wide = assets.pivot(index="date", columns="ticker", values="return").sort_index()

    surprise_records = []
    for _, row in dots.iterrows():
        meet_date = row["meeting_date"]
        year = int(row.get("year", meet_date.year + 1))
        dot_median = float(row["dot_median_pct"])
        horizon = year - meet_date.year
        market_rate = interpolate_market_rate(market, meet_date, max(horizon, 1))
        surprise_bp = (dot_median - market_rate) * 100 if not np.isnan(market_rate) else np.nan
        signal = "hawkish_surprise" if (not np.isnan(surprise_bp) and surprise_bp > cfg.surprise_threshold_bp) else \
                 ("dovish_surprise" if (not np.isnan(surprise_bp) and surprise_bp < -cfg.surprise_threshold_bp) else "neutral")
        surprise_records.append({
            "meeting_date": meet_date, "year": year,
            "dot_median_pct": dot_median,
            "market_implied_pct": float(market_rate) if not np.isnan(market_rate) else None,
            "surprise_bp": float(surprise_bp) if not np.isnan(surprise_bp) else None,
            "signal": signal
        })

    surp_df = pd.DataFrame(surprise_records).sort_values("meeting_date")
    surp_df.to_csv(os.path.join(cfg.outdir, "dot_vs_market.csv"), index=False)

    # Surprise vs asset return correlation (next 5/21 trading days)
    corr_records = []
    for ticker in ret_wide.columns:
        for horizon in [5, 21]:
            fwd_ret = ret_wide[ticker].rolling(horizon).sum().shift(-horizon)
            for _, surp_row in surp_df.dropna(subset=["surprise_bp"]).iterrows():
                meet_date = surp_row["meeting_date"]
                if meet_date in fwd_ret.index:
                    corr_records.append({
                        "ticker": ticker, "horizon_days": horizon,
                        "surprise_bp": float(surp_row["surprise_bp"]),
                        "fwd_return": float(fwd_ret.loc[meet_date]) if not np.isnan(fwd_ret.loc[meet_date]) else None
                    })

    corr_df = pd.DataFrame(corr_records).dropna(subset=["fwd_return"])
    if not corr_df.empty:
        corr_summary = corr_df.groupby(["ticker", "horizon_days"]).apply(
            lambda g: pd.Series({"corr": stats.pearsonr(g["surprise_bp"].values, g["fwd_return"].values)[0],
                                  "pvalue": stats.pearsonr(g["surprise_bp"].values, g["fwd_return"].values)[1],
                                  "n": len(g)}) if len(g) > 3 else pd.Series({"corr": np.nan, "pvalue": np.nan, "n": len(g)})
        ).reset_index()
        corr_summary.to_csv(os.path.join(cfg.outdir, "surprise_vs_returns.csv"), index=False)

    # Backtest: on surprise dates, position based on signal
    all_daily = []
    for ticker in ret_wide.columns:
        sig_series = pd.Series(index=ret_wide.index, dtype=float).fillna(0)
        for _, surp_row in surp_df.iterrows():
            dt = surp_row["meeting_date"]
            sig = surp_row["signal"]
            # Position for 5 days after meeting
            idx_start = ret_wide.index.searchsorted(dt)
            idx_end = min(idx_start + 5, len(ret_wide.index))
            pos_val = -1 if sig == "hawkish_surprise" else (1 if sig == "dovish_surprise" else 0)
            sig_series.iloc[idx_start:idx_end] = pos_val
        strat = sig_series.shift(1) * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_meetings": len(surp_df), "n_hawkish": int((surp_df["signal"] == "hawkish_surprise").sum()),
        "n_dovish": int((surp_df["signal"] == "dovish_surprise").sum()),
        "avg_surprise_bp": float(surp_df["surprise_bp"].dropna().mean()),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"surprise_threshold_bp": cfg.surprise_threshold_bp}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Fed dots | Meetings: {summary['n_meetings']} | Hawkish: {summary['n_hawkish']} | Dovish: {summary['n_dovish']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dots", required=True, dest="dots_file")
    ap.add_argument("--market", required=True, dest="market_file")
    ap.add_argument("--assets", required=True, dest="assets_file")
    ap.add_argument("--surprise-threshold-bp", type=float, default=10.0)
    ap.add_argument("--outdir", default="./artifacts/fed_dot_plot")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
