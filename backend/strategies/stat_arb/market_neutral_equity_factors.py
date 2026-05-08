#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# market_neutral_equity_factors.py
#
# Market-Neutral Equity Factors — Long top 50 value+momentum, short bottom 50
# ---------------------------------------------------------------------------
# Takes a factor score CSV with per-ticker value and momentum scores, computes
# a composite factor score, ranks the universe, longs the top 50 names and
# shorts the bottom 50 names in a dollar-neutral construction.  Backtests with
# monthly rebalancing using forward 1-month returns.
#
# Inputs
# ------
# --factors FILE  (CSV, required)
#   date,ticker,value_score,mom_score
#   One row per ticker per rebalance date.  Scores can be raw or pre-z-scored.
#
# --returns FILE  (CSV, required)
#   date,ticker,monthly_ret
#   Forward 1-month return for each ticker.  Dates must align with factor dates.
#
# Outputs
# -------
# outdir/
#   run_params.json
#   composite_scores.csv     — date, ticker, value_score, mom_score, composite, rank, signal
#   rebalance_log.csv        — date, longs (comma-sep), shorts (comma-sep)
#   backtest_equity.csv      — date, portfolio_value, monthly_pnl, monthly_return
#   factor_ic.csv            — date, IC_value, IC_mom, IC_composite (information coefficients)
#
# Usage
# -----
# python market_neutral_equity_factors.py \
#   --factors factor_scores.csv \
#   --returns monthly_returns.csv \
#   --value-weight 0.5 \
#   --mom-weight 0.5 \
#   --n-long 50 \
#   --n-short 50 \
#   --capital 10000000 \
#   --outdir ./artifacts
#
# Dependencies: pip install pandas numpy scipy

import argparse
import json
import os
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import List, Optional

import numpy as np
import pandas as pd
from scipy import stats


# ----------------------------- Config -----------------------------

@dataclass
class Config:
    factors: str
    returns: str
    value_weight: float
    mom_weight: float
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


def load_factors(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = ["date", "ticker", "value_score", "mom_score"]
    for c in required:
        if c not in df.columns:
            raise SystemExit(f"factors CSV missing column: {c}")
    df["value_score"] = pd.to_numeric(df["value_score"], errors="coerce")
    df["mom_score"] = pd.to_numeric(df["mom_score"], errors="coerce")
    return df.dropna(subset=["value_score", "mom_score"]).sort_values(["date", "ticker"])


def load_returns(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = ["date", "ticker", "monthly_ret"]
    for c in required:
        if c not in df.columns:
            raise SystemExit(f"returns CSV missing column: {c}")
    df["monthly_ret"] = pd.to_numeric(df["monthly_ret"], errors="coerce")
    return df.dropna(subset=["monthly_ret"]).sort_values(["date", "ticker"])


# ----------------------------- Factor scoring -----------------------------

def cross_sectional_zscore(series: pd.Series) -> pd.Series:
    """Z-score within a cross-section (one rebalance date)."""
    mu = series.mean()
    sd = series.std()
    if sd < 1e-10:
        return series - mu
    return (series - mu) / sd


def compute_composite_scores(
    factors: pd.DataFrame, value_weight: float, mom_weight: float
) -> pd.DataFrame:
    """
    Per rebalance date: z-score each factor cross-sectionally, then combine.
    composite = value_weight * z(value) + mom_weight * z(mom)
    Rank and assign signals.
    """
    records = []
    for date, grp in factors.groupby("date"):
        grp = grp.copy()
        grp["z_value"] = cross_sectional_zscore(grp["value_score"])
        grp["z_mom"] = cross_sectional_zscore(grp["mom_score"])
        grp["composite"] = value_weight * grp["z_value"] + mom_weight * grp["z_mom"]
        grp = grp.sort_values("composite", ascending=False).reset_index(drop=True)
        grp["rank"] = grp.index + 1
        records.append(grp)
    return pd.concat(records, ignore_index=True) if records else pd.DataFrame()


def assign_signals(scored: pd.DataFrame, n_long: int, n_short: int) -> pd.DataFrame:
    """Assign +1 to top-N composite, -1 to bottom-N per rebalance date."""
    results = []
    for date, grp in scored.groupby("date"):
        grp = grp.sort_values("rank")
        grp["signal"] = 0
        top_n = min(n_long, len(grp))
        bot_n = min(n_short, len(grp))
        grp.iloc[:top_n, grp.columns.get_loc("signal")] = 1
        grp.iloc[max(0, len(grp) - bot_n):, grp.columns.get_loc("signal")] = -1
        results.append(grp)
    return pd.concat(results, ignore_index=True) if results else pd.DataFrame()


# ----------------------------- Information Coefficient -----------------------------

def compute_ic(scored: pd.DataFrame, returns: pd.DataFrame) -> pd.DataFrame:
    """
    Rank IC: Spearman correlation between composite score at date t and
    forward return at date t+1.
    """
    rets_dict = {(row["date"], row["ticker"]): row["monthly_ret"]
                 for _, row in returns.iterrows()}
    dates = sorted(scored["date"].unique())
    ic_records = []

    for i, date in enumerate(dates[:-1]):
        sub = scored[scored["date"] == date].copy()
        # Forward returns are needed from next period
        next_dates = [d for d in dates if d > date]
        if not next_dates:
            continue
        next_date = next_dates[0]

        sub["fwd_ret"] = sub["ticker"].map(
            lambda t: rets_dict.get((next_date, t), np.nan)
        )
        sub = sub.dropna(subset=["composite", "fwd_ret"])
        if len(sub) < 5:
            continue

        ic_composite, _ = stats.spearmanr(sub["composite"], sub["fwd_ret"])
        ic_value, _ = stats.spearmanr(sub["z_value"], sub["fwd_ret"])
        ic_mom, _ = stats.spearmanr(sub["z_mom"], sub["fwd_ret"])

        ic_records.append({
            "date": date,
            "IC_composite": round(float(ic_composite), 4),
            "IC_value": round(float(ic_value), 4),
            "IC_mom": round(float(ic_mom), 4),
        })

    return pd.DataFrame(ic_records)


# ----------------------------- Backtest -----------------------------

def backtest(
    scored: pd.DataFrame,
    returns: pd.DataFrame,
    capital: float,
    n_long: int,
    n_short: int,
) -> tuple:
    """
    Monthly rebalance.  At each date, take long/short signals from scored;
    compute portfolio return using next-period returns from returns.
    Dollar neutral: long book = short book = capital / 2.
    """
    rets_pivot = returns.pivot(index="date", columns="ticker", values="monthly_ret")
    dates = sorted(scored["date"].unique())

    equity = capital
    equity_records = []
    rebalance_records = []

    for i, date in enumerate(dates):
        sub = scored[scored["date"] == date]
        longs = sub[sub["signal"] == 1]["ticker"].tolist()
        shorts = sub[sub["signal"] == -1]["ticker"].tolist()

        rebalance_records.append({
            "date": date,
            "longs": ",".join(longs[:n_long]),
            "shorts": ",".join(shorts[-n_short:]),
        })

        # Find next period return date
        next_dates = rets_pivot.index[rets_pivot.index > date]
        if next_dates.empty:
            continue
        next_date = next_dates[0]
        if next_date not in rets_pivot.index:
            continue

        next_rets = rets_pivot.loc[next_date]
        half_capital = capital / 2.0

        long_alloc = half_capital / max(len(longs), 1)
        short_alloc = half_capital / max(len(shorts), 1)

        monthly_pnl = 0.0
        for t in longs:
            r = next_rets.get(t, np.nan)
            if not np.isnan(r):
                monthly_pnl += long_alloc * r
        for t in shorts:
            r = next_rets.get(t, np.nan)
            if not np.isnan(r):
                monthly_pnl -= short_alloc * r

        equity += monthly_pnl
        equity_records.append({
            "date": next_date,
            "portfolio_value": equity,
            "monthly_pnl": monthly_pnl,
            "monthly_return": monthly_pnl / max(equity - monthly_pnl, 1.0),
        })

    equity_df = pd.DataFrame(equity_records)
    rebalance_df = pd.DataFrame(rebalance_records)
    return equity_df, rebalance_df


# ----------------------------- Main -----------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Market-neutral equity factors — long top 50 value+momentum, short bottom 50"
    )
    ap.add_argument("--factors", required=True,
                    help="CSV: date,ticker,value_score,mom_score")
    ap.add_argument("--returns", required=True,
                    help="CSV: date,ticker,monthly_ret (forward 1-month returns)")
    ap.add_argument("--value-weight", type=float, default=0.5, dest="value_weight",
                    help="Weight on value factor in composite score (default 0.5)")
    ap.add_argument("--mom-weight", type=float, default=0.5, dest="mom_weight",
                    help="Weight on momentum factor in composite score (default 0.5)")
    ap.add_argument("--n-long", type=int, default=50, dest="n_long",
                    help="Number of tickers to go long (default 50)")
    ap.add_argument("--n-short", type=int, default=50, dest="n_short",
                    help="Number of tickers to go short (default 50)")
    ap.add_argument("--capital", type=float, default=10_000_000,
                    help="Starting capital in USD (default 10000000)")
    ap.add_argument("--outdir", default="./artifacts")
    args = ap.parse_args()

    cfg = Config(
        factors=args.factors,
        returns=args.returns,
        value_weight=args.value_weight,
        mom_weight=args.mom_weight,
        n_long=args.n_long,
        n_short=args.n_short,
        capital=args.capital,
        outdir=args.outdir,
    )

    outdir = ensure_outdir(cfg.outdir, "market_neutral_equity_factors")
    print(f"[INFO] Output directory: {outdir}")

    factors = load_factors(cfg.factors)
    returns = load_returns(cfg.returns)
    print(f"[INFO] Factor rows: {len(factors)}, Return rows: {len(returns)}")

    scored = compute_composite_scores(factors, cfg.value_weight, cfg.mom_weight)
    scored = assign_signals(scored, cfg.n_long, cfg.n_short)
    scored.to_csv(os.path.join(outdir, "composite_scores.csv"), index=False)

    ic_df = compute_ic(scored, returns)
    ic_df.to_csv(os.path.join(outdir, "factor_ic.csv"), index=False)

    equity_df, rebalance_df = backtest(scored, returns, cfg.capital, cfg.n_long, cfg.n_short)
    equity_df.to_csv(os.path.join(outdir, "backtest_equity.csv"), index=False)
    rebalance_df.to_csv(os.path.join(outdir, "rebalance_log.csv"), index=False)

    with open(os.path.join(outdir, "run_params.json"), "w") as f:
        json.dump(asdict(cfg), f, indent=2)

    final_val = float(equity_df["portfolio_value"].iloc[-1]) if not equity_df.empty else cfg.capital
    total_ret = (final_val / cfg.capital - 1) * 100
    m_rets = equity_df["monthly_return"].dropna()
    sharpe = float(m_rets.mean() / max(m_rets.std(), 1e-9) * np.sqrt(12)) if len(m_rets) > 1 else 0.0

    print(f"\n=== Summary ===")
    print(f"Rebalance dates: {len(rebalance_df)}")
    if not ic_df.empty:
        print(f"Mean IC (composite): {ic_df['IC_composite'].mean():.4f}")
        print(f"IC hit rate: {(ic_df['IC_composite'] > 0).mean():.2%}")
    print(f"Final portfolio value: ${final_val:,.0f}")
    print(f"Total return: {total_ret:.2f}%")
    print(f"Annualized Sharpe: {sharpe:.2f}")
    print(f"Artifacts written to: {outdir}")


if __name__ == "__main__":
    main()
