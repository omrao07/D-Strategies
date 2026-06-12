#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# overnight_reversal.py
#
# Overnight Reversal — stocks up >N% intraday → short at close, cover at open
# ---------------------------------------------------------------------------
# Identifies stocks whose intraday return (open-to-close) exceeds a threshold.
# Signals a short at the close of that day; measures the overnight return
# (close-to-next-open) as the trade P&L.  Tests whether the reversal effect
# is statistically significant and backtests a dollar-neutral portfolio.
#
# Inputs
# ------
# --prices FILE  (CSV, required)
#   date,ticker,open,high,low,close,volume
#   One row per ticker per day.  Must include both open and close columns.
#
# Outputs
# -------
# outdir/
#   run_params.json
#   signal_log.csv          — date, ticker, intraday_ret, signal, overnight_ret
#   performance_summary.csv — per-ticker stats: hit_rate, mean_overnight_ret, t_stat
#   backtest_equity.csv     — date, portfolio_value, daily_pnl, n_positions
#   stats_summary.json      — aggregate t-test, Sharpe, win rate
#
# Usage
# -----
# python overnight_reversal.py \
#   --prices daily_ohlcv.csv \
#   --threshold 0.03 \
#   --capital 1000000 \
#   --max-positions 20 \
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
from scipy import stats

# ----------------------------- Config -----------------------------

@dataclass
class Config:
    prices: str
    threshold: float
    capital: float
    max_positions: int
    outdir: str


# ----------------------------- IO helpers -----------------------------

def ensure_outdir(base: str, tag: str) -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    outdir = os.path.join(base, f"{tag}_{ts}")
    os.makedirs(outdir, exist_ok=True)
    return outdir


def load_prices(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = ["date", "ticker", "open", "close"]
    for c in required:
        if c not in df.columns:
            raise SystemExit(f"prices CSV missing column: {c}")
    for c in ["open", "high", "low", "close", "volume"]:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.sort_values(["ticker", "date"]).reset_index(drop=True)
    return df


# ----------------------------- Signal + return computation -----------------------------

def compute_signals_and_returns(df: pd.DataFrame, threshold: float) -> pd.DataFrame:
    """
    For each ticker-day, compute:
      intraday_ret = (close - open) / open
      signal = -1 if intraday_ret > threshold (short at close)
      overnight_ret = (next_day_open - close) / close  — the trade P&L
    """
    df = df.copy()
    df = df.dropna(subset=["open", "close"])
    df["intraday_ret"] = (df["close"] - df["open"]) / df["open"].replace(0, np.nan)

    # Compute next-day open per ticker
    df_sorted = df.sort_values(["ticker", "date"])
    df_sorted["next_open"] = df_sorted.groupby("ticker")["open"].shift(-1)
    df_sorted["next_date"] = df_sorted.groupby("ticker")["date"].shift(-1)

    df_sorted["overnight_ret"] = (df_sorted["next_open"] - df_sorted["close"]) / df_sorted["close"].replace(0, np.nan)

    # Signal: -1 (short) when intraday return > threshold (mean reversion bet)
    df_sorted["signal"] = 0
    mask = df_sorted["intraday_ret"] > threshold
    df_sorted.loc[mask, "signal"] = -1

    # Trade return: overnight_ret when short → negate to get P&L direction
    df_sorted["trade_ret"] = df_sorted["signal"] * (-df_sorted["overnight_ret"])

    return df_sorted[df_sorted["signal"] != 0].dropna(subset=["overnight_ret"]).reset_index(drop=True)


# ----------------------------- Per-ticker performance -----------------------------

def per_ticker_stats(signal_df: pd.DataFrame) -> pd.DataFrame:
    """Summarize trade statistics per ticker."""
    rows = []
    for ticker, grp in signal_df.groupby("ticker"):
        n = len(grp)
        if n < 3:
            continue
        trade_rets = grp["trade_ret"].dropna()
        mean_ret = float(trade_rets.mean())
        std_ret = float(trade_rets.std())
        hit_rate = float((trade_rets > 0).mean())
        t_stat, p_val = stats.ttest_1samp(trade_rets, 0.0)
        sharpe = mean_ret / max(std_ret, 1e-9) * np.sqrt(252)
        rows.append({
            "ticker": ticker,
            "n_trades": n,
            "mean_intraday_ret": round(float(grp["intraday_ret"].mean()), 5),
            "mean_overnight_ret": round(float(grp["overnight_ret"].mean()), 5),
            "mean_trade_ret": round(mean_ret, 5),
            "hit_rate": round(hit_rate, 4),
            "t_stat": round(float(t_stat), 3),
            "p_value": round(float(p_val), 5),
            "annualized_sharpe": round(float(sharpe), 3),
        })
    return pd.DataFrame(rows).sort_values("t_stat", ascending=False)


# ----------------------------- Backtest -----------------------------

def backtest(signal_df: pd.DataFrame, capital: float, max_positions: int) -> pd.DataFrame:
    """
    Each day, take up to max_positions shorts (ranked by intraday_ret descending).
    Equal-dollar allocation per position.  P&L = trade_ret * alloc.
    """
    daily_records = []
    for date, grp in signal_df.groupby("date"):
        # Take top-N by intraday_ret (largest movers = best fade candidates)
        grp = grp.nlargest(max_positions, "intraday_ret")
        n = len(grp)
        if n == 0:
            continue
        alloc = capital / max(n, 1)
        day_pnl = float((grp["trade_ret"] * alloc).sum())
        daily_records.append({
            "date": date,
            "n_positions": n,
            "daily_pnl": day_pnl,
        })

    if not daily_records:
        return pd.DataFrame(columns=["date", "n_positions", "daily_pnl", "portfolio_value"])

    eq = pd.DataFrame(daily_records).sort_values("date")
    eq["portfolio_value"] = capital + eq["daily_pnl"].cumsum()
    return eq


# ----------------------------- Statistics -----------------------------

def aggregate_stats(signal_df: pd.DataFrame) -> dict:
    trade_rets = signal_df["trade_ret"].dropna()
    if len(trade_rets) < 5:
        return {"note": "insufficient data"}
    t_stat, p_val = stats.ttest_1samp(trade_rets, 0.0)
    return {
        "n_trades": int(len(trade_rets)),
        "mean_trade_ret": float(trade_rets.mean()),
        "std_trade_ret": float(trade_rets.std()),
        "t_stat": float(t_stat),
        "p_value": float(p_val),
        "hit_rate": float((trade_rets > 0).mean()),
        "annualized_sharpe": float(trade_rets.mean() / max(trade_rets.std(), 1e-9) * np.sqrt(252)),
        "max_trade_ret": float(trade_rets.max()),
        "min_trade_ret": float(trade_rets.min()),
    }


# ----------------------------- Main -----------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Overnight reversal — stocks up >N% intraday → short at close, cover at open"
    )
    ap.add_argument("--prices", required=True,
                    help="Daily OHLCV CSV with date,ticker,open,high,low,close,volume")
    ap.add_argument("--threshold", type=float, default=0.03,
                    help="Minimum intraday gain to trigger short signal (default 0.03 = 3%%)")
    ap.add_argument("--capital", type=float, default=1_000_000,
                    help="Starting capital in USD (default 1000000)")
    ap.add_argument("--max-positions", type=int, default=20, dest="max_positions",
                    help="Max simultaneous short positions per day (default 20)")
    ap.add_argument("--outdir", default="./artifacts")
    args = ap.parse_args()

    cfg = Config(
        prices=args.prices,
        threshold=args.threshold,
        capital=args.capital,
        max_positions=args.max_positions,
        outdir=args.outdir,
    )

    outdir = ensure_outdir(cfg.outdir, "overnight_reversal")
    print(f"[INFO] Output directory: {outdir}")

    df = load_prices(cfg.prices)
    tickers = df["ticker"].nunique()
    dates = df["date"].nunique()
    print(f"[INFO] Loaded {len(df)} rows, {tickers} tickers, {dates} dates")

    signal_df = compute_signals_and_returns(df, cfg.threshold)
    print(f"[INFO] {len(signal_df)} signal events (intraday_ret > {cfg.threshold:.1%})")

    signal_log = signal_df[
        ["date", "ticker", "intraday_ret", "signal", "overnight_ret", "trade_ret"]
    ].copy()
    signal_log.to_csv(os.path.join(outdir, "signal_log.csv"), index=False)

    perf_df = per_ticker_stats(signal_df)
    perf_df.to_csv(os.path.join(outdir, "performance_summary.csv"), index=False)

    eq_df = backtest(signal_df, cfg.capital, cfg.max_positions)
    eq_df.to_csv(os.path.join(outdir, "backtest_equity.csv"), index=False)

    agg = aggregate_stats(signal_df)
    with open(os.path.join(outdir, "stats_summary.json"), "w") as f:
        json.dump(agg, f, indent=2)

    with open(os.path.join(outdir, "run_params.json"), "w") as f:
        json.dump(asdict(cfg), f, indent=2, default=str)

    final_val = float(eq_df["portfolio_value"].iloc[-1]) if not eq_df.empty else cfg.capital
    print("\n=== Summary ===")
    print(f"Signal events: {len(signal_df)}")
    if "t_stat" in agg:
        print(f"Mean trade ret: {agg['mean_trade_ret']:.4f}")
        print(f"Hit rate: {agg['hit_rate']:.2%}")
        print(f"T-stat: {agg['t_stat']:.2f}  p={agg['p_value']:.4f}")
        print(f"Sharpe: {agg['annualized_sharpe']:.2f}")
    print(f"Final portfolio value: ${final_val:,.0f}")
    print(f"Artifacts written to: {outdir}")


if __name__ == "__main__":
    main()
