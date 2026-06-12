#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# sector_rotation_momentum.py
#
# Sector Rotation Momentum — 11 SPDR sectors ranked by 12-1 month momentum
# -------------------------------------------------------------------------
# Ranks the 11 SPDR sector ETFs (XLK, XLV, XLF, XLE, XLI, XLY, XLP, XLU,
# XLB, XLRE, XLC) by their 12-month minus 1-month total return (standard
# cross-sectional momentum, skipping the most recent month).  At each month
# end, goes long the top 3 sectors and short the bottom 3.  Simulates monthly
# rebalancing and produces a full backtest equity curve.
#
# Inputs
# ------
# --prices FILE  (CSV, required)
#   date,XLK,XLV,XLF,XLE,XLI,XLY,XLP,XLU,XLB,XLRE,XLC
#   Monthly or daily adjusted-close prices. If daily, resampled to month-end.
#
# Outputs
# -------
# outdir/
#   run_params.json
#   monthly_ranks.csv        — month, ticker, momentum_ret, rank, signal
#   rebalance_log.csv        — month, longs, shorts
#   backtest_equity.csv      — date, portfolio_value, monthly_return
#   sector_stats.csv         — per-sector: avg rank, avg monthly ret when long/short
#
# Usage
# -----
# python sector_rotation_momentum.py \
#   --prices sector_prices.csv \
#   --lookback-months 12 \
#   --skip-months 1 \
#   --n-long 3 \
#   --n-short 3 \
#   --capital 1000000 \
#   --outdir ./artifacts
#
# Dependencies: pip install pandas numpy scipy

import argparse
import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime

import numpy as np
import pandas as pd

# ----------------------------- Config -----------------------------

SECTOR_ETFS = ["XLK", "XLV", "XLF", "XLE", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC"]

@dataclass
class Config:
    prices: str
    lookback_months: int
    skip_months: int
    n_long: int
    n_short: int
    capital: float
    outdir: str


# ----------------------------- IO helpers -----------------------------

def ensure_outdir(base: str, tag: str) -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    outdir = os.path.join(base, f"{tag}_{ts}")
    os.makedirs(outdir, exist_ok=True)
    return outdir


def load_prices(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"], index_col="date")
    df = df.apply(pd.to_numeric, errors="coerce").sort_index()
    # Determine which sector tickers are present
    present = [t for t in SECTOR_ETFS if t in df.columns]
    if len(present) < 4:
        raise SystemExit(f"prices CSV must contain at least 4 of: {SECTOR_ETFS}")
    print(f"[INFO] Sector tickers found: {present}")
    return df[present]


def resample_monthly(prices: pd.DataFrame) -> pd.DataFrame:
    """If daily, resample to month-end prices."""
    freq = pd.infer_freq(prices.index[:20])
    if freq is not None and freq.startswith("B"):
        return prices.resample("ME").last()
    if freq in ("M", "MS", "ME", "BM", "BME"):
        return prices
    # Default: assume daily, resample
    return prices.resample("ME").last()


# ----------------------------- Momentum computation -----------------------------

def compute_12_1_momentum(monthly: pd.DataFrame, lookback: int, skip: int) -> pd.DataFrame:
    """
    12-1 momentum: return over the past `lookback` months, skipping the most
    recent `skip` months.
    mom_ret[t] = price[t - skip] / price[t - lookback] - 1
    """
    records = []
    dates = monthly.index.tolist()
    for i in range(lookback, len(dates)):
        current_date = dates[i]
        skip_idx = i - skip
        start_idx = i - lookback
        if skip_idx < 0 or start_idx < 0:
            continue
        for ticker in monthly.columns:
            p_end = monthly.iloc[skip_idx][ticker]
            p_start = monthly.iloc[start_idx][ticker]
            if pd.isna(p_end) or pd.isna(p_start) or p_start <= 0:
                continue
            mom_ret = p_end / p_start - 1
            records.append({
                "month": current_date,
                "ticker": ticker,
                "momentum_ret": mom_ret,
            })
    return pd.DataFrame(records)


def rank_sectors(mom_df: pd.DataFrame, n_long: int, n_short: int) -> pd.DataFrame:
    """Rank tickers by momentum within each month; assign signal."""
    ranked = []
    for month, grp in mom_df.groupby("month"):
        grp = grp.sort_values("momentum_ret", ascending=False).reset_index(drop=True)
        grp["rank"] = grp.index + 1
        n = len(grp)
        grp["signal"] = 0
        grp.iloc[:n_long, grp.columns.get_loc("signal")] = 1
        grp.iloc[max(0, n - n_short):, grp.columns.get_loc("signal")] = -1
        ranked.append(grp)
    return pd.concat(ranked, ignore_index=True) if ranked else pd.DataFrame()


# ----------------------------- Backtest -----------------------------

def backtest(
    monthly: pd.DataFrame,
    ranked_df: pd.DataFrame,
    capital: float,
    n_long: int,
    n_short: int,
) -> tuple:
    """
    Monthly rebalance backtest.  At month t, take signals from ranked_df for
    that month; compute the return over month t+1 for each position.
    Dollar-neutral: each long and short side allocated equally.
    """
    monthly_rets = monthly.pct_change()
    months = sorted(ranked_df["month"].unique())
    equity = capital
    equity_records = []
    rebalance_records = []

    for i, month in enumerate(months[:-1]):
        next_month = months[i + 1] if i + 1 < len(months) else None
        if next_month is None:
            break

        signals = ranked_df[ranked_df["month"] == month].set_index("ticker")["signal"]

        longs = signals[signals == 1].index.tolist()
        shorts = signals[signals == -1].index.tolist()

        rebalance_records.append({
            "month": month,
            "longs": ",".join(longs),
            "shorts": ",".join(shorts),
        })

        # Compute next-month returns
        if next_month not in monthly_rets.index:
            continue
        next_rets = monthly_rets.loc[next_month]

        # Allocate capital equally among longs and shorts
        long_alloc = capital / max(len(longs), 1) if longs else 0
        short_alloc = capital / max(len(shorts), 1) if shorts else 0

        monthly_pnl = 0.0
        for t in longs:
            if t in next_rets.index and not pd.isna(next_rets[t]):
                monthly_pnl += long_alloc * next_rets[t]
        for t in shorts:
            if t in next_rets.index and not pd.isna(next_rets[t]):
                monthly_pnl -= short_alloc * next_rets[t]

        equity += monthly_pnl
        equity_records.append({
            "date": next_month,
            "portfolio_value": equity,
            "monthly_pnl": monthly_pnl,
            "monthly_return": monthly_pnl / max(equity - monthly_pnl, 1.0),
        })

    equity_df = pd.DataFrame(equity_records)
    rebalance_df = pd.DataFrame(rebalance_records)
    return equity_df, rebalance_df


# ----------------------------- Sector statistics -----------------------------

def sector_stats(monthly: pd.DataFrame, ranked_df: pd.DataFrame) -> pd.DataFrame:
    """Per-sector summary: average rank, average monthly return when long/short."""
    monthly_rets = monthly.pct_change()
    rows = []
    for ticker in monthly.columns:
        sub = ranked_df[ranked_df["ticker"] == ticker].copy()
        sub = sub.sort_values("month")

        avg_rank = sub["rank"].mean()
        avg_mom = sub["momentum_ret"].mean()

        long_rets, short_rets = [], []
        for _, row in sub.iterrows():
            next_dates = monthly_rets.index[monthly_rets.index > row["month"]]
            if next_dates.empty:
                continue
            nd = next_dates[0]
            r = monthly_rets.loc[nd, ticker] if ticker in monthly_rets.columns else np.nan
            if pd.isna(r):
                continue
            if row["signal"] == 1:
                long_rets.append(r)
            elif row["signal"] == -1:
                short_rets.append(r)

        rows.append({
            "ticker": ticker,
            "avg_rank": round(avg_rank, 2),
            "avg_momentum_ret": round(avg_mom, 4),
            "n_long": len(long_rets),
            "mean_ret_when_long": round(np.mean(long_rets), 5) if long_rets else np.nan,
            "n_short": len(short_rets),
            "mean_ret_when_short": round(np.mean(short_rets), 5) if short_rets else np.nan,
        })
    return pd.DataFrame(rows).sort_values("avg_rank")


# ----------------------------- Main -----------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Sector rotation momentum — 11 SPDR sectors ranked by 12-1 month momentum"
    )
    ap.add_argument("--prices", required=True,
                    help="CSV with date index + sector ETF columns (adjusted close)")
    ap.add_argument("--lookback-months", type=int, default=12, dest="lookback_months",
                    help="Momentum lookback in months (default 12)")
    ap.add_argument("--skip-months", type=int, default=1, dest="skip_months",
                    help="Months to skip before measuring (default 1)")
    ap.add_argument("--n-long", type=int, default=3, dest="n_long",
                    help="Number of top-ranked sectors to go long (default 3)")
    ap.add_argument("--n-short", type=int, default=3, dest="n_short",
                    help="Number of bottom-ranked sectors to go short (default 3)")
    ap.add_argument("--capital", type=float, default=1_000_000)
    ap.add_argument("--outdir", default="./artifacts")
    args = ap.parse_args()

    cfg = Config(
        prices=args.prices,
        lookback_months=args.lookback_months,
        skip_months=args.skip_months,
        n_long=args.n_long,
        n_short=args.n_short,
        capital=args.capital,
        outdir=args.outdir,
    )

    outdir = ensure_outdir(cfg.outdir, "sector_rotation_momentum")
    print(f"[INFO] Output directory: {outdir}")

    prices = load_prices(cfg.prices)
    monthly = resample_monthly(prices)
    print(f"[INFO] {len(monthly)} monthly observations from {monthly.index[0]} to {monthly.index[-1]}")

    mom_df = compute_12_1_momentum(monthly, cfg.lookback_months, cfg.skip_months)
    print(f"[INFO] Computed momentum scores for {len(mom_df)} ticker-month obs")

    ranked_df = rank_sectors(mom_df, cfg.n_long, cfg.n_short)
    ranked_df.to_csv(os.path.join(outdir, "monthly_ranks.csv"), index=False)

    equity_df, rebalance_df = backtest(monthly, ranked_df, cfg.capital, cfg.n_long, cfg.n_short)
    equity_df.to_csv(os.path.join(outdir, "backtest_equity.csv"), index=False)
    rebalance_df.to_csv(os.path.join(outdir, "rebalance_log.csv"), index=False)

    stats_df = sector_stats(monthly, ranked_df)
    stats_df.to_csv(os.path.join(outdir, "sector_stats.csv"), index=False)

    with open(os.path.join(outdir, "run_params.json"), "w") as f:
        json.dump(asdict(cfg), f, indent=2)

    final_val = float(equity_df["portfolio_value"].iloc[-1]) if not equity_df.empty else cfg.capital
    total_ret = (final_val / cfg.capital - 1) * 100
    monthly_rets = equity_df["monthly_return"].dropna()
    sharpe = float(monthly_rets.mean() / max(monthly_rets.std(), 1e-9) * np.sqrt(12)) if len(monthly_rets) > 1 else 0.0

    print("\n=== Summary ===")
    print(f"Rebalance months: {len(rebalance_df)}")
    print(f"Final portfolio value: ${final_val:,.0f}")
    print(f"Total return: {total_ret:.2f}%")
    print(f"Annualized Sharpe (monthly): {sharpe:.2f}")
    print(f"Artifacts written to: {outdir}")


if __name__ == "__main__":
    main()
