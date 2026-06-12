#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
quality_factor_long_short.py — Quality Factor Long/Short Equity Strategy

What it does:
    Constructs a dollar-neutral long/short portfolio by ranking stocks on a
    composite quality score derived from Return on Equity (ROE), Debt-to-Equity
    (D/E), Gross Margin, and Asset Turnover.  Each metric is cross-sectionally
    z-scored on every rebalance date; the composite score is the equal-weighted
    average of the four z-scores (where D/E is negated so lower debt = higher
    quality).  Stocks in the top quintile are held long; stocks in the bottom
    quintile are held short.  The portfolio is dollar-neutral: equal gross
    notional on each leg.  Performance is evaluated monthly.

Inputs (CSV):
    fundamentals.csv — columns required:
        date             (YYYY-MM-DD)  — period end / filing date
        ticker           (string)      — stock identifier
        roe              (float)       — return on equity (decimal, e.g. 0.15)
        debt_to_equity   (float)       — total debt / book equity
        gross_margin     (float)       — gross profit / revenue (decimal)
        asset_turnover   (float)       — revenue / average total assets

    returns.csv — columns required (optional; used for forward-return calc):
        date             (YYYY-MM-DD)
        ticker           (string)
        return           (float)       — daily return (decimal)

CLI:
    python quality_factor_long_short.py \\
        --fundamentals fundamentals.csv \\
        --returns      returns.csv \\
        --outdir       ./output \\
        --top-q        0.20 \\
        --bot-q        0.20

Outputs (written to --outdir):
    portfolio_weights.csv   — date, ticker, weight, leg (long/short), score
    factor_returns.csv      — date, long_ret, short_ret, ls_ret (long-short)
    summary.json            — annualised Sharpe, CAGR, max-drawdown, hit-rate
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
    required = {"date", "ticker", "roe", "debt_to_equity", "gross_margin", "asset_turnover"}
    df = pd.read_csv(path, parse_dates=["date"])
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"fundamentals.csv missing columns: {missing}")
    df = df.dropna(subset=list(required))
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date")


def load_returns(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    df.columns = [c.strip().lower() for c in df.columns]
    df = df.rename(columns={"return": "ret"})
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date")


# ---------------------------------------------------------------------------
# Signal computation
# ---------------------------------------------------------------------------

def zscore_cross_section(series: pd.Series) -> pd.Series:
    """Robust cross-sectional z-score (winsorise at ±3 after scoring)."""
    mu = series.mean()
    sd = series.std(ddof=1)
    if sd == 0 or np.isnan(sd):
        return pd.Series(np.zeros(len(series)), index=series.index)
    z = (series - mu) / sd
    return z.clip(-3, 3)


def compute_quality_score(df: pd.DataFrame) -> pd.DataFrame:
    """Add composite_quality column to fundamentals df per date."""
    records = []
    for dt, grp in df.groupby("date"):
        grp = grp.copy()
        grp["z_roe"] = zscore_cross_section(grp["roe"])
        grp["z_de"] = zscore_cross_section(-grp["debt_to_equity"])   # lower D/E = better
        grp["z_gm"] = zscore_cross_section(grp["gross_margin"])
        grp["z_at"] = zscore_cross_section(grp["asset_turnover"])
        grp["composite_quality"] = (grp["z_roe"] + grp["z_de"] + grp["z_gm"] + grp["z_at"]) / 4.0
        records.append(grp)
    return pd.concat(records, ignore_index=True)


def assign_quintiles(df: pd.DataFrame, score_col: str = "composite_quality") -> pd.DataFrame:
    """Rank stocks into quintiles [1..5] per date; 5 = highest quality."""
    def rank_group(grp):
        grp = grp.copy()
        grp["quintile"] = pd.qcut(grp[score_col], q=5, labels=[1, 2, 3, 4, 5])
        return grp
    return df.groupby("date", group_keys=False).apply(rank_group)


def build_portfolio_weights(df: pd.DataFrame, top_q: float, bot_q: float) -> pd.DataFrame:
    """Construct dollar-neutral weights per date."""
    rows = []
    for dt, grp in df.groupby("date"):
        scores = grp.set_index("ticker")["composite_quality"]
        hi = scores.quantile(1 - top_q)
        lo = scores.quantile(bot_q)
        longs = scores[scores >= hi]
        shorts = scores[scores <= lo]
        if len(longs) == 0 or len(shorts) == 0:
            continue
        # Equal weight within each leg; dollar-neutral => each leg sums to 1
        long_w = pd.Series(1.0 / len(longs), index=longs.index)
        short_w = pd.Series(-1.0 / len(shorts), index=shorts.index)
        for ticker, w in long_w.items():
            rows.append({"date": dt, "ticker": ticker, "weight": w, "leg": "long",
                         "score": scores[ticker]})
        for ticker, w in short_w.items():
            rows.append({"date": dt, "ticker": ticker, "weight": w, "leg": "short",
                         "score": scores[ticker]})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Return calculation
# ---------------------------------------------------------------------------

def compute_monthly_returns(returns_df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate daily returns to month-end total returns."""
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
    """
    For each rebalance date, apply weights to next-month returns.
    weights.date = rebalance date (month-end of signal);
    returns.date = month-end of the forward return period.
    """
    weights = weights.copy()
    weights["ym"] = weights["date"].dt.to_period("M")
    returns = returns.copy()
    returns["ym"] = returns["date"].dt.to_period("M")

    factor_rows = []
    rebal_months = sorted(weights["ym"].unique())

    for ym in rebal_months:
        fwd_ym = ym + 1
        w_slice = weights[weights["ym"] == ym]
        r_slice = returns[returns["ym"] == fwd_ym].set_index("ticker")["ret"]
        if r_slice.empty:
            continue
        merged = w_slice.set_index("ticker").join(r_slice, how="inner")
        if merged.empty:
            continue
        long_ret = (merged[merged["weight"] > 0]["weight"] * merged[merged["weight"] > 0]["ret"]).sum()
        short_ret = (merged[merged["weight"] < 0]["weight"] * merged[merged["weight"] < 0]["ret"]).sum()
        ls_ret = long_ret + short_ret
        factor_rows.append({
            "date": fwd_ym.to_timestamp("M"),
            "long_ret": long_ret,
            "short_ret": short_ret,
            "ls_ret": ls_ret,
        })
    return pd.DataFrame(factor_rows)


# ---------------------------------------------------------------------------
# Performance metrics
# ---------------------------------------------------------------------------

def sharpe(returns: pd.Series, periods_per_year: int = 12) -> float:
    if returns.std() == 0:
        return np.nan
    return (returns.mean() / returns.std()) * np.sqrt(periods_per_year)


def cagr(returns: pd.Series, periods_per_year: int = 12) -> float:
    n = len(returns)
    total = (1 + returns).prod()
    return total ** (periods_per_year / n) - 1


def max_drawdown(returns: pd.Series) -> float:
    cum = (1 + returns).cumprod()
    roll_max = cum.cummax()
    dd = (cum - roll_max) / roll_max
    return dd.min()


def hit_rate(returns: pd.Series) -> float:
    return (returns > 0).mean()


def compute_summary(factor_returns: pd.DataFrame) -> dict:
    ls = factor_returns["ls_ret"].dropna()
    return {
        "n_months": len(ls),
        "annualised_sharpe": round(sharpe(ls), 4),
        "cagr": round(cagr(ls), 4),
        "max_drawdown": round(max_drawdown(ls), 4),
        "hit_rate": round(hit_rate(ls), 4),
        "mean_monthly_ret": round(ls.mean(), 6),
        "vol_monthly": round(ls.std(), 6),
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
    print(f"[quality_factor_long_short] Outputs written to {outdir}")
    print(json.dumps(summary, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Quality Factor Long/Short Strategy")
    p.add_argument("--fundamentals", default="fundamentals.csv", help="Path to fundamentals CSV")
    p.add_argument("--returns", default="returns.csv", help="Path to daily returns CSV")
    p.add_argument("--outdir", default="./output_quality_ls", help="Output directory")
    p.add_argument("--top-q", type=float, default=0.20, help="Top quantile threshold for longs (default 0.20)")
    p.add_argument("--bot-q", type=float, default=0.20, help="Bottom quantile threshold for shorts (default 0.20)")
    return p.parse_args()


def main():
    args = parse_args()

    print("[quality_factor_long_short] Loading fundamentals...")
    fund = load_fundamentals(args.fundamentals)

    print("[quality_factor_long_short] Computing quality scores...")
    fund = compute_quality_score(fund)
    fund = assign_quintiles(fund)

    print("[quality_factor_long_short] Building portfolio weights...")
    weights = build_portfolio_weights(fund, args.top_q, args.bot_q)

    factor_returns = pd.DataFrame(columns=["date", "long_ret", "short_ret", "ls_ret"])
    if os.path.exists(args.returns):
        print("[quality_factor_long_short] Loading returns for performance calc...")
        rets = load_returns(args.returns)
        monthly_rets = compute_monthly_returns(rets)
        factor_returns = compute_factor_returns(weights, monthly_rets)
    else:
        print("[quality_factor_long_short] No returns file found — skipping performance calc.")

    summary = compute_summary(factor_returns) if not factor_returns.empty else {}
    write_outputs(args.outdir, weights, factor_returns, summary)


if __name__ == "__main__":
    main()
