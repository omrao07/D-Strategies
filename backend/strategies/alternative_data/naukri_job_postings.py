#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
naukri_job_postings.py — India job posting trends as sector/equity signal
=========================================================================
Naukri.com is India's largest job portal. Monthly job posting counts by sector
act as a leading indicator for:
  - IT sector hiring → TCS/INFY/WIPRO revenue growth (2-3 quarter lead)
  - Banking hiring → HDFC/ICICI expansion signals
  - Manufacturing hiring → India PMI, auto sector outlook
  - Startup hiring → venture environment, fintech/edtech sentiment

India moat: LinkedIn India job data is available but noisy. Naukri sector data
(published monthly) is India-specific and highly correlated with NSE sector returns.
No global fund uses Naukri systematically.

Inputs (CSV)
------------
--jobs      jobs.csv        date, sector, job_count, job_count_yoy_pct
--stocks    stocks.csv      date, ticker, close

Outputs
-------
outdir/job_trends.csv           date, sector, job_count, yoy_pct, z_score
outdir/sector_correlation.csv   sector, nifty_sector_correlation, lead_lag_days
outdir/sector_signals.csv       date, sector, signal, strength
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

# Sector → NSE stocks mapping
SECTOR_STOCKS = {
    "IT": ["TCS", "INFY", "HCLTECH", "WIPRO", "TECHM"],
    "BANKING": ["HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK", "AXISBANK"],
    "MANUFACTURING": ["MARUTI", "M&M", "TATAMOTORS", "SIEMENS", "ABB"],
    "PHARMA": ["SUNPHARMA", "DRREDDY", "CIPLA", "DIVISLAB"],
    "FMCG": ["HINDUNILVR", "ITC", "NESTLEIND", "BRITANNIA"],
    "RETAIL": ["DMART", "TRENT", "SHOPPERSSTOP"],
    "REALESTATE": ["DLF", "GODREJPROP", "OBEROIRLTY"],
    "STARTUPS": ["NYKAA", "ZOMATO", "PAYTM", "POLICYBZR"],
}

ENTRY_Z = 1.5
MA_WINDOW = 3       # Months
ZSCORE_WINDOW = 24  # Months (2 years)
FORWARD_MONTHS = 2  # Lead time for job data → sector returns


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    jobs = pd.read_csv(cfg.jobs_file, parse_dates=["date"])
    jobs.columns = [c.lower().strip() for c in jobs.columns]
    job_col = "job_count" if "job_count" in jobs.columns else jobs.columns[1]

    stocks = pd.read_csv(cfg.stocks_file, parse_dates=["date"])
    stocks.columns = [c.lower().strip() for c in stocks.columns]
    stocks_wide = stocks.pivot_table(index="date", columns="ticker", values="close").sort_index()
    stocks_wide.columns = [c.upper() for c in stocks_wide.columns]

    job_records = []
    corr_records = []
    signal_records = []
    all_port = []

    for sector in jobs["sector"].unique() if "sector" in jobs.columns else ["aggregate"]:
        if "sector" in jobs.columns:
            sec_jobs = jobs[jobs["sector"].str.upper() == sector.upper()].copy()
        else:
            sec_jobs = jobs.copy()

        sec_jobs = sec_jobs.set_index("date").sort_index()
        yoy_col = "job_count_yoy_pct" if "job_count_yoy_pct" in sec_jobs.columns else None

        sec_jobs["job_count_ma"] = sec_jobs[job_col].rolling(MA_WINDOW).mean()
        mu = sec_jobs[job_col].rolling(ZSCORE_WINDOW).mean()
        sigma = sec_jobs[job_col].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
        sec_jobs["z_score"] = (sec_jobs[job_col] - mu) / sigma

        for dt, row in sec_jobs.iterrows():
            job_records.append({
                "date": dt.date(),
                "sector": str(sector).upper(),
                "job_count": float(row[job_col]),
                "job_count_ma3": float(row["job_count_ma"]) if not np.isnan(row["job_count_ma"]) else None,
                "yoy_pct": float(row[yoy_col]) if yoy_col and not np.isnan(row.get(yoy_col, np.nan)) else None,
                "z_score": float(row["z_score"]) if not np.isnan(row["z_score"]) else None,
            })

        # Get stocks for this sector
        sector_key = str(sector).upper().replace(" ", "")
        tickers = SECTOR_STOCKS.get(sector_key, [])
        avail = [t for t in tickers if t in stocks_wide.columns]
        if not avail:
            continue

        basket_ret = stocks_wide[avail].pct_change().resample("MS").sum()  # Monthly returns
        job_ret = sec_jobs[job_col].pct_change().reindex(basket_ret.index, method="nearest")

        if len(basket_ret) >= 12:
            for lag in [0, 1, 2, 3]:
                corr = float(job_ret.corr(basket_ret.mean(axis=1).shift(-lag)))
                corr_records.append({
                    "sector": sector_key,
                    "lag_months": lag,
                    "correlation": corr,
                    "n_obs": len(basket_ret),
                })

        # Signal
        best_lag = FORWARD_MONTHS
        pos = sec_jobs["z_score"].apply(
            lambda z: 1 if z > ENTRY_Z else (-1 if z < -ENTRY_Z else 0)
        )

        monthly_ret = stocks_wide[avail].pct_change().resample("MS").sum().mean(axis=1)
        pos_monthly = pos.resample("MS").last().shift(best_lag)
        pos_aligned = pos_monthly.reindex(monthly_ret.index, method="nearest")
        strat_ret = (pos_aligned * monthly_ret).dropna()

        if len(strat_ret) >= 6:
            all_port.append(strat_ret.rename(sector_key))

        for dt, row in sec_jobs.iterrows():
            zi = row.get("z_score", np.nan)
            sig = "long" if zi > ENTRY_Z else ("short" if zi < -ENTRY_Z else "flat")
            signal_records.append({
                "date": dt.date(),
                "sector": sector_key,
                "signal": sig,
                "strength": float(zi) if not np.isnan(zi) else 0,
            })

    pd.DataFrame(job_records).sort_values("date").to_csv(os.path.join(cfg.outdir, "job_trends.csv"), index=False)
    if corr_records:
        pd.DataFrame(corr_records).sort_values(["sector", "lag_months"]).to_csv(
            os.path.join(cfg.outdir, "sector_correlation.csv"), index=False
        )
    pd.DataFrame(signal_records).sort_values("date").to_csv(os.path.join(cfg.outdir, "sector_signals.csv"), index=False)

    if all_port:
        portfolio = pd.concat(all_port, axis=1).mean(axis=1).dropna()
        cum = (1 + portfolio).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(portfolio.mean() / portfolio.std() * np.sqrt(12)) if portfolio.std() > 0 else None  # Monthly
    else:
        sharpe = None

    summary = {
        "n_sectors": int(jobs["sector"].nunique()) if "sector" in jobs.columns else 1,
        "n_jobs_observations": len(job_records),
        "sectors_with_stock_data": len(all_port),
        "sharpe": sharpe,
        "params": {"entry_z": ENTRY_Z, "forward_months": FORWARD_MONTHS, "ma_window": MA_WINDOW}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Naukri Job Postings | {len(job_records)} obs | {len(all_port)} sector portfolios | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", required=True, dest="jobs_file")
    ap.add_argument("--stocks", required=True, dest="stocks_file")
    ap.add_argument("--outdir", default="./artifacts/naukri_jobs")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
