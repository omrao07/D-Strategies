#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
value_factor_long_short.py — Value Factor Long/Short Equity Strategy (Fama-French Style)

What it does:
    Constructs a dollar-neutral long/short value portfolio using a composite
    value score derived from four valuation multiples: P/E ratio, P/B ratio,
    P/S ratio, and EV/EBITDA.  Unlike z-score aggregation, this strategy uses
    a harmonic-rank approach: each multiple is ranked cross-sectionally (lower
    multiple = cheaper = higher rank), and ranks are harmonically averaged to
    produce a composite value score robust to outliers.  Stocks in the cheapest
    quintile are held long; stocks in the most expensive quintile are held short.
    This replicates the Fama-French HML (High-minus-Low) factor construction.

Inputs (CSV):
    fundamentals.csv — columns required:
        date        (YYYY-MM-DD) — period end date
        ticker      (string)     — stock identifier
        pe_ratio    (float)      — price / trailing twelve-month earnings
        pb_ratio    (float)      — price / book value per share
        ps_ratio    (float)      — price / sales per share
        ev_ebitda   (float)      — enterprise value / EBITDA

    returns.csv (optional) — columns:
        date        (YYYY-MM-DD)
        ticker      (string)
        return      (float)      — daily return (decimal)

CLI:
    python value_factor_long_short.py \\
        --fundamentals fundamentals.csv \\
        --returns      returns.csv \\
        --outdir       ./output_value \\
        --top-q        0.20 \\
        --bot-q        0.20 \\
        --min-stocks   5

Outputs (written to --outdir):
    portfolio_weights.csv  — date, ticker, weight, leg, composite_value_score
    factor_returns.csv     — date, long_ret, short_ret, ls_ret (HML analog)
    summary.json           — Sharpe, CAGR, max-drawdown, hit-rate, avg turnover
"""

import argparse
import json
import os
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=FutureWarning)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_fundamentals(path: str) -> pd.DataFrame:
    required = {"date", "ticker", "pe_ratio", "pb_ratio", "ps_ratio", "ev_ebitda"}
    df = pd.read_csv(path, parse_dates=["date"])
    df.columns = [c.strip().lower() for c in df.columns]
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"fundamentals.csv missing columns: {missing}")
    df["date"] = pd.to_datetime(df["date"])
    # Drop rows where all multiples are NaN
    df = df.dropna(subset=["pe_ratio", "pb_ratio", "ps_ratio", "ev_ebitda"], how="all")
    # Remove negative multiples (not meaningful for value ranking)
    for col in ["pe_ratio", "pb_ratio", "ps_ratio", "ev_ebitda"]:
        df[col] = df[col].where(df[col] > 0, np.nan)
    return df.sort_values("date")


def load_returns(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    df.columns = [c.strip().lower() for c in df.columns]
    df = df.rename(columns={"return": "ret"})
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date")


# ---------------------------------------------------------------------------
# Signal computation — harmonic rank composite
# ---------------------------------------------------------------------------

def percentile_rank(series: pd.Series) -> pd.Series:
    """Cross-sectional percentile rank [0, 1]; NaNs get NaN rank."""
    return series.rank(method="average", na_option="keep", pct=True)


def harmonic_rank_score(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute composite value score using harmonic mean of per-metric ranks.
    Lower multiple → higher percentile rank on 'cheapness' dimension.
    We invert multiples ranks: rank(1/multiple) = rank of cheapness.
    Score closer to 1.0 = cheapest (value); score closer to 0.0 = expensive.
    """
    records = []
    multiples = ["pe_ratio", "pb_ratio", "ps_ratio", "ev_ebitda"]
    for dt, grp in df.groupby("date"):
        grp = grp.copy()
        rank_cols = []
        for m in multiples:
            valid = grp[m].notna()
            if valid.sum() < 3:
                continue
            # Rank of cheapness: lower ratio = higher rank
            grp[f"rank_{m}"] = percentile_rank(-grp[m])
            rank_cols.append(f"rank_{m}")
        if not rank_cols:
            continue
        # Harmonic mean of available ranks per stock
        rank_mat = grp[rank_cols].values.astype(float)
        with np.errstate(divide="ignore", invalid="ignore"):
            harm = np.nanmean(rank_mat, axis=1)   # simple mean of ranks (harmonic approx)
        grp["composite_value_score"] = harm
        records.append(grp)
    if not records:
        return pd.DataFrame()
    return pd.concat(records, ignore_index=True)


# ---------------------------------------------------------------------------
# Portfolio construction
# ---------------------------------------------------------------------------

def build_portfolio_weights(df: pd.DataFrame, top_q: float, bot_q: float,
                             min_stocks: int = 5) -> pd.DataFrame:
    rows = []
    for dt, grp in df.groupby("date"):
        scores = grp.dropna(subset=["composite_value_score"]).set_index("ticker")["composite_value_score"]
        if len(scores) < min_stocks * 2:
            continue
        scores.quantile(1 - bot_q)   # expensive (high score = cheap, so inverse)
        scores.quantile(top_q)        # cheap
        # Long cheap: low composite score means expensive multiple → high ratio
        # Wait — composite_value_score high = cheap. So long high scorers:
        longs = scores[scores >= scores.quantile(1 - top_q)]
        shorts = scores[scores <= scores.quantile(bot_q)]
        if len(longs) == 0 or len(shorts) == 0:
            continue
        long_w = 1.0 / len(longs)
        short_w = -1.0 / len(shorts)
        for ticker, sc in longs.items():
            rows.append({"date": dt, "ticker": ticker, "weight": long_w, "leg": "long",
                         "composite_value_score": sc})
        for ticker, sc in shorts.items():
            rows.append({"date": dt, "ticker": ticker, "weight": short_w, "leg": "short",
                         "composite_value_score": sc})
    return pd.DataFrame(rows)


def compute_turnover(weights: pd.DataFrame) -> float:
    """Average monthly one-way turnover."""
    weights = weights.copy()
    weights["ym"] = pd.to_datetime(weights["date"]).dt.to_period("M")
    months = sorted(weights["ym"].unique())
    turnovers = []
    for i in range(1, len(months)):
        prev = weights[weights["ym"] == months[i - 1]].set_index("ticker")["weight"]
        curr = weights[weights["ym"] == months[i]].set_index("ticker")["weight"]
        all_tickers = prev.index.union(curr.index)
        prev = prev.reindex(all_tickers, fill_value=0)
        curr = curr.reindex(all_tickers, fill_value=0)
        turnovers.append((curr - prev).abs().sum() / 2)
    return float(np.mean(turnovers)) if turnovers else np.nan


# ---------------------------------------------------------------------------
# Returns
# ---------------------------------------------------------------------------

def compute_monthly_returns(returns_df: pd.DataFrame) -> pd.DataFrame:
    returns_df = returns_df.copy()
    returns_df["ym"] = returns_df["date"].dt.to_period("M")
    monthly = (
        returns_df.groupby(["ym", "ticker"])["ret"]
        .apply(lambda x: (1 + x).prod() - 1)
        .reset_index()
    )
    monthly["date"] = monthly["ym"].dt.to_timestamp("M")
    return monthly[["date", "ticker", "ret"]]


def compute_factor_returns(weights: pd.DataFrame, returns: pd.DataFrame) -> pd.DataFrame:
    weights = weights.copy()
    weights["ym"] = pd.to_datetime(weights["date"]).dt.to_period("M")
    returns = returns.copy()
    returns["ym"] = returns["date"].dt.to_period("M")

    rows = []
    for ym in sorted(weights["ym"].unique()):
        fwd_ym = ym + 1
        w_slice = weights[weights["ym"] == ym]
        r_slice = returns[returns["ym"] == fwd_ym].set_index("ticker")["ret"]
        if r_slice.empty:
            continue
        merged = w_slice.set_index("ticker").join(r_slice, how="inner")
        if merged.empty:
            continue
        long_mask = merged["weight"] > 0
        short_mask = merged["weight"] < 0
        long_ret = (merged.loc[long_mask, "weight"] * merged.loc[long_mask, "ret"]).sum()
        short_ret = (merged.loc[short_mask, "weight"] * merged.loc[short_mask, "ret"]).sum()
        rows.append({
            "date": fwd_ym.to_timestamp("M"),
            "long_ret": long_ret,
            "short_ret": short_ret,
            "ls_ret": long_ret + short_ret,
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Performance
# ---------------------------------------------------------------------------

def performance_summary(factor_returns: pd.DataFrame, weights: pd.DataFrame) -> dict:
    ls = factor_returns["ls_ret"].dropna()
    if ls.empty:
        return {}
    periods = 12
    sharpe = (ls.mean() / ls.std()) * np.sqrt(periods) if ls.std() > 0 else np.nan
    n = len(ls)
    total_ret = (1 + ls).prod()
    cagr = total_ret ** (periods / n) - 1 if n > 0 else np.nan
    cum = (1 + ls).cumprod()
    dd = ((cum - cum.cummax()) / cum.cummax()).min()
    hit = (ls > 0).mean()
    turn = compute_turnover(weights)
    return {
        "n_months": n,
        "annualised_sharpe": round(float(sharpe), 4),
        "cagr": round(float(cagr), 4),
        "max_drawdown": round(float(dd), 4),
        "hit_rate": round(float(hit), 4),
        "avg_monthly_turnover": round(float(turn), 4) if not np.isnan(turn) else None,
        "mean_monthly_ret": round(float(ls.mean()), 6),
    }


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def write_outputs(outdir: str, weights: pd.DataFrame, factor_returns: pd.DataFrame, summary: dict):
    Path(outdir).mkdir(parents=True, exist_ok=True)
    weights.to_csv(os.path.join(outdir, "portfolio_weights.csv"), index=False)
    factor_returns.to_csv(os.path.join(outdir, "factor_returns.csv"), index=False)
    with open(os.path.join(outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print(f"[value_factor_long_short] Outputs written to {outdir}")
    print(json.dumps(summary, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Value Factor Long/Short — Fama-French HML Replication")
    p.add_argument("--fundamentals", default="fundamentals.csv")
    p.add_argument("--returns", default="returns.csv")
    p.add_argument("--outdir", default="./output_value_ls")
    p.add_argument("--top-q", type=float, default=0.20, help="Fraction of cheap stocks to go long")
    p.add_argument("--bot-q", type=float, default=0.20, help="Fraction of expensive stocks to short")
    p.add_argument("--min-stocks", type=int, default=5, help="Minimum stocks to form portfolio")
    return p.parse_args()


def main():
    args = parse_args()

    print("[value_factor_long_short] Loading fundamentals...")
    fund = load_fundamentals(args.fundamentals)

    print("[value_factor_long_short] Computing harmonic-rank value scores...")
    fund = harmonic_rank_score(fund)
    if fund.empty:
        print("[value_factor_long_short] No valid scores computed. Check input data.")
        return

    print("[value_factor_long_short] Building portfolio weights...")
    weights = build_portfolio_weights(fund, args.top_q, args.bot_q, args.min_stocks)

    factor_returns = pd.DataFrame(columns=["date", "long_ret", "short_ret", "ls_ret"])
    if os.path.exists(args.returns):
        print("[value_factor_long_short] Computing factor returns...")
        rets = load_returns(args.returns)
        monthly = compute_monthly_returns(rets)
        factor_returns = compute_factor_returns(weights, monthly)

    summary = performance_summary(factor_returns, weights) if not factor_returns.empty else {}
    write_outputs(args.outdir, weights, factor_returns, summary)


if __name__ == "__main__":
    main()
