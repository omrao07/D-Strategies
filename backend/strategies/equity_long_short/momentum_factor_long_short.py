#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
momentum_factor_long_short.py — Cross-Sectional Momentum Factor (12-1 Month)

What it does:
    Implements the classic Jegadeesh-Titman cross-sectional price momentum
    factor.  For each stock, the 12-1 month momentum is defined as the
    cumulative return over the 12 months ending one month before the current
    date (i.e., months t-12 through t-2, skipping the most recent month t-1
    to avoid short-term reversal contamination).  Stocks are ranked
    cross-sectionally each month; the top 20% (winners) are held long and
    bottom 20% (losers) are held short, equal-weight, dollar-neutral.

    Additionally, an industry-neutral version is computed: momentum ranks
    are computed within each GICS sector, so the portfolio is also sector-
    neutral (no net sector exposure).

Inputs (CSV):
    returns.csv — columns required:
        date     (YYYY-MM-DD) — daily return date
        ticker   (string)     — stock identifier
        return   (float)      — daily return (decimal, e.g. 0.012)
        sector   (string, optional) — GICS sector for industry-neutral version

CLI:
    python momentum_factor_long_short.py \\
        --returns  returns.csv \\
        --outdir   ./output_momentum \\
        --top-q    0.20 \\
        --bot-q    0.20 \\
        --lookback 12 \\
        --skip     1

Outputs (written to --outdir):
    momentum_signals.csv         — date, ticker, momentum_12_1, rank, quintile
    portfolio_weights.csv        — date, ticker, weight, leg (long/short)
    portfolio_weights_neutral.csv— same but industry-neutral
    factor_returns.csv           — date, ls_ret, ls_ret_neutral
    summary.json                 — Sharpe, CAGR, drawdown, hit-rate (both versions)
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

def load_returns(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    df.columns = [c.strip().lower() for c in df.columns]
    df = df.rename(columns={"return": "ret"})
    df["date"] = pd.to_datetime(df["date"])
    if "sector" not in df.columns:
        df["sector"] = "Unknown"
    return df.sort_values("date")


# ---------------------------------------------------------------------------
# Momentum signal computation
# ---------------------------------------------------------------------------

def compute_monthly_returns(daily: pd.DataFrame) -> pd.DataFrame:
    """Aggregate daily returns to month-end totals, preserving sector."""
    daily = daily.copy()
    daily["ym"] = daily["date"].dt.to_period("M")
    grp_cols = ["ym", "ticker"]
    has_sector = "sector" in daily.columns and daily["sector"].notna().any()
    if has_sector:
        sector_map = daily.groupby("ticker")["sector"].last()
    monthly = (
        daily.groupby(grp_cols)["ret"]
        .apply(lambda x: (1 + x).prod() - 1)
        .reset_index()
    )
    monthly["date"] = monthly["ym"].dt.to_timestamp("M")
    if has_sector:
        monthly["sector"] = monthly["ticker"].map(sector_map)
    return monthly


def compute_momentum_signal(monthly: pd.DataFrame, lookback: int = 12,
                            skip: int = 1) -> pd.DataFrame:
    """
    For each month t and ticker, compute cumulative return over
    months [t - lookback, t - skip - 1] (inclusive).
    lookback=12, skip=1 → classic 12-1 month momentum.
    """
    monthly = monthly.copy()
    monthly = monthly.sort_values(["ticker", "ym"])
    records = []
    pivot = monthly.pivot(index="ym", columns="ticker", values="ret")
    months = sorted(pivot.index)

    for i, ym in enumerate(months):
        # We need lookback months ending at ym - skip
        start_idx = i - lookback - skip + 1
        end_idx = i - skip
        if start_idx < 0 or end_idx < 0:
            continue
        window = pivot.iloc[start_idx: end_idx + 1]
        mom = (1 + window).prod() - 1  # cumulative return over window
        for ticker, val in mom.items():
            if not np.isnan(val):
                row = {"ym": ym, "date": ym.to_timestamp("M"), "ticker": ticker,
                       "momentum_12_1": val}
                if "sector" in monthly.columns:
                    s_map = monthly[monthly["ym"] == ym].set_index("ticker")["sector"]
                    row["sector"] = s_map.get(ticker, "Unknown")
                records.append(row)
    return pd.DataFrame(records)


def rank_signals(signals: pd.DataFrame) -> pd.DataFrame:
    """Add cross-sectional rank and quintile columns."""
    def rank_group(grp):
        grp = grp.copy()
        grp["rank_pct"] = grp["momentum_12_1"].rank(pct=True, method="average")
        grp["quintile"] = pd.qcut(grp["momentum_12_1"], q=5, labels=[1, 2, 3, 4, 5],
                                   duplicates="drop")
        return grp
    return signals.groupby("ym", group_keys=False).apply(rank_group)


# ---------------------------------------------------------------------------
# Portfolio construction
# ---------------------------------------------------------------------------

def build_weights_standard(signals: pd.DataFrame, top_q: float,
                            bot_q: float) -> pd.DataFrame:
    rows = []
    for ym, grp in signals.groupby("ym"):
        scores = grp.set_index("ticker")["momentum_12_1"].dropna()
        if len(scores) < 10:
            continue
        longs = scores[scores >= scores.quantile(1 - top_q)]
        shorts = scores[scores <= scores.quantile(bot_q)]
        if len(longs) == 0 or len(shorts) == 0:
            continue
        dt = ym.to_timestamp("M")
        for t, s in longs.items():
            rows.append({"date": dt, "ticker": t, "weight": 1.0 / len(longs), "leg": "long"})
        for t, s in shorts.items():
            rows.append({"date": dt, "ticker": t, "weight": -1.0 / len(shorts), "leg": "short"})
    return pd.DataFrame(rows)


def build_weights_industry_neutral(signals: pd.DataFrame, top_q: float,
                                   bot_q: float) -> pd.DataFrame:
    """Rank within sector, then construct dollar-neutral within each sector."""
    rows = []
    if "sector" not in signals.columns:
        return pd.DataFrame()
    for ym, grp in signals.groupby("ym"):
        dt = ym.to_timestamp("M")
        for sector, sgrp in grp.groupby("sector"):
            scores = sgrp.set_index("ticker")["momentum_12_1"].dropna()
            if len(scores) < 4:
                continue
            longs = scores[scores >= scores.quantile(1 - top_q)]
            shorts = scores[scores <= scores.quantile(bot_q)]
            if len(longs) == 0 or len(shorts) == 0:
                continue
            n_sectors = grp["sector"].nunique()
            sector_weight = 1.0 / n_sectors if n_sectors > 0 else 1.0
            for t in longs.index:
                rows.append({"date": dt, "ticker": t,
                             "weight": sector_weight / len(longs), "leg": "long", "sector": sector})
            for t in shorts.index:
                rows.append({"date": dt, "ticker": t,
                             "weight": -sector_weight / len(shorts), "leg": "short", "sector": sector})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Factor returns
# ---------------------------------------------------------------------------

def compute_factor_returns(weights: pd.DataFrame, monthly: pd.DataFrame,
                            label: str = "ls_ret") -> pd.DataFrame:
    if weights.empty:
        return pd.DataFrame()
    weights = weights.copy()
    weights["ym"] = pd.to_datetime(weights["date"]).dt.to_period("M")
    monthly = monthly.copy()
    monthly["ym"] = monthly["ym"] if "ym" in monthly.columns else pd.to_datetime(monthly["date"]).dt.to_period("M")
    rows = []
    for ym in sorted(weights["ym"].unique()):
        fwd_ym = ym + 1
        w_slice = weights[weights["ym"] == ym]
        r_slice = monthly[monthly["ym"] == fwd_ym].set_index("ticker")["ret"]
        if r_slice.empty:
            continue
        merged = w_slice.set_index("ticker").join(r_slice, how="inner")
        if merged.empty:
            continue
        long_mask = merged["weight"] > 0
        short_mask = merged["weight"] < 0
        long_ret = (merged.loc[long_mask, "weight"] * merged.loc[long_mask, "ret"]).sum()
        short_ret = (merged.loc[short_mask, "weight"] * merged.loc[short_mask, "ret"]).sum()
        rows.append({"date": fwd_ym.to_timestamp("M"), "long_ret": long_ret,
                     "short_ret": short_ret, label: long_ret + short_ret})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Performance
# ---------------------------------------------------------------------------

def perf_stats(series: pd.Series, label: str = "") -> dict:
    s = series.dropna()
    if s.empty:
        return {}
    periods = 12
    sharpe = (s.mean() / s.std(ddof=1)) * np.sqrt(periods) if s.std(ddof=1) > 0 else np.nan
    cagr = (1 + s).prod() ** (periods / len(s)) - 1 if len(s) > 0 else np.nan
    cum = (1 + s).cumprod()
    dd = ((cum - cum.cummax()) / cum.cummax()).min()
    return {
        f"{label}n_months": len(s),
        f"{label}annualised_sharpe": round(float(sharpe), 4),
        f"{label}cagr": round(float(cagr), 4),
        f"{label}max_drawdown": round(float(dd), 4),
        f"{label}hit_rate": round(float((s > 0).mean()), 4),
        f"{label}mean_monthly_ret": round(float(s.mean()), 6),
    }


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def write_outputs(outdir: str, signals: pd.DataFrame, weights: pd.DataFrame,
                  weights_neutral: pd.DataFrame, factor_returns: pd.DataFrame,
                  summary: dict):
    Path(outdir).mkdir(parents=True, exist_ok=True)
    signals.to_csv(os.path.join(outdir, "momentum_signals.csv"), index=False)
    weights.to_csv(os.path.join(outdir, "portfolio_weights.csv"), index=False)
    weights_neutral.to_csv(os.path.join(outdir, "portfolio_weights_neutral.csv"), index=False)
    factor_returns.to_csv(os.path.join(outdir, "factor_returns.csv"), index=False)
    with open(os.path.join(outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print(f"[momentum_factor_long_short] Outputs written to {outdir}")
    print(json.dumps(summary, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Momentum Factor Long/Short (12-1 Month)")
    p.add_argument("--returns", default="returns.csv")
    p.add_argument("--outdir", default="./output_momentum_ls")
    p.add_argument("--top-q", type=float, default=0.20)
    p.add_argument("--bot-q", type=float, default=0.20)
    p.add_argument("--lookback", type=int, default=12, help="Lookback months (default 12)")
    p.add_argument("--skip", type=int, default=1, help="Skip months (default 1 = skip last month)")
    return p.parse_args()


def main():
    args = parse_args()
    print("[momentum_factor_long_short] Loading returns...")
    daily = load_returns(args.returns)

    print("[momentum_factor_long_short] Aggregating to monthly returns...")
    monthly = compute_monthly_returns(daily)

    print(f"[momentum_factor_long_short] Computing {args.lookback}-{args.skip} month momentum signals...")
    signals = compute_momentum_signal(monthly, args.lookback, args.skip)
    signals = rank_signals(signals)

    print("[momentum_factor_long_short] Building standard portfolio weights...")
    weights = build_weights_standard(signals, args.top_q, args.bot_q)

    print("[momentum_factor_long_short] Building industry-neutral portfolio weights...")
    weights_neutral = build_weights_industry_neutral(signals, args.top_q, args.bot_q)

    print("[momentum_factor_long_short] Computing factor returns...")
    factor_returns = compute_factor_returns(weights, monthly, label="ls_ret")
    factor_returns_neutral = compute_factor_returns(weights_neutral, monthly, label="ls_ret_neutral")

    if not factor_returns.empty and not factor_returns_neutral.empty:
        combined = factor_returns.merge(
            factor_returns_neutral[["date", "ls_ret_neutral"]], on="date", how="outer"
        )
    elif not factor_returns.empty:
        combined = factor_returns
        combined["ls_ret_neutral"] = np.nan
    else:
        combined = pd.DataFrame()

    summary = {}
    if not factor_returns.empty:
        summary.update(perf_stats(factor_returns["ls_ret"], "standard_"))
    if not factor_returns_neutral.empty:
        summary.update(perf_stats(factor_returns_neutral["ls_ret_neutral"], "neutral_"))

    write_outputs(args.outdir, signals, weights, weights_neutral,
                  combined if not combined.empty else pd.DataFrame(), summary)


if __name__ == "__main__":
    main()
