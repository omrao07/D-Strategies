#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# intraday_momentum_continuation.py
#
# Intraday Momentum Continuation — First 30-min momentum → continuation 2–4h
# ---------------------------------------------------------------------------
# Computes the return during the first 30 minutes of each trading day.
# If the 30-min return exceeds a threshold, signals continuation; tracks the
# return from the 30-min mark to the 2h mark and the 4h mark (or market close).
# Tests whether the continuation effect is statistically significant vs zero.
#
# Inputs
# ------
# --prices FILE  (CSV, required)
#   datetime,open,high,low,close,volume
#   Intraday OHLCV bars at any sub-daily frequency (e.g., 5m, 15m, 30m).
#   datetime must be parseable; market timezone is assumed consistent.
#
# Outputs
# -------
# outdir/
#   run_params.json
#   session_summary.csv     — date, open30_ret, ret_30m_to_2h, ret_30m_to_4h, signal
#   signal_log.csv          — date, signal, threshold_used, open30_ret
#   backtest_equity.csv     — date, portfolio_value, daily_pnl
#   stats_summary.json      — t-stats, means, hit rates for 2h and 4h windows
#
# Usage
# -----
# python intraday_momentum_continuation.py \
#   --prices intraday_ohlcv.csv \
#   --threshold 0.002 \
#   --open-minutes 30 \
#   --target-hours 2 4 \
#   --capital 1000000 \
#   --outdir ./artifacts
#
# Dependencies: pip install pandas numpy scipy

import argparse
import json
import os
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

import numpy as np
import pandas as pd
from scipy import stats


# ----------------------------- Config -----------------------------

@dataclass
class Config:
    prices: str
    threshold: float
    open_minutes: int
    target_hours: List[int]
    capital: float
    outdir: str


# ----------------------------- IO helpers -----------------------------

def ensure_outdir(base: str, tag: str) -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    outdir = os.path.join(base, f"{tag}_{ts}")
    os.makedirs(outdir, exist_ok=True)
    return outdir


def load_intraday(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["datetime"])
    required = ["datetime", "open", "high", "low", "close", "volume"]
    for c in required:
        if c not in df.columns:
            raise SystemExit(f"prices CSV missing column: {c}")
    for c in ["open", "high", "low", "close", "volume"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.sort_values("datetime").reset_index(drop=True)
    return df


# ----------------------------- Session partitioning -----------------------------

def split_sessions(df: pd.DataFrame) -> dict:
    """Group bars by trading date (date portion of datetime)."""
    df = df.copy()
    df["date"] = df["datetime"].dt.date
    return {date: grp.reset_index(drop=True) for date, grp in df.groupby("date")}


def compute_session_returns(
    session: pd.DataFrame,
    open_minutes: int,
    target_hours: List[int],
) -> Optional[dict]:
    """
    For one session, compute:
      - open30_ret: return from session open to open_minutes mark
      - ret_30m_to_Xh: return from open_minutes mark to X hours later
    Returns None if session has insufficient bars.
    """
    if session.empty:
        return None

    session_start = session["datetime"].iloc[0]
    open_cutoff = session_start + timedelta(minutes=open_minutes)

    # Open-period bars
    open_bars = session[session["datetime"] <= open_cutoff]
    if open_bars.empty:
        return None

    price_at_open = session["open"].iloc[0]
    price_at_open_end = open_bars["close"].iloc[-1]

    if price_at_open <= 0:
        return None

    open30_ret = (price_at_open_end - price_at_open) / price_at_open

    result = {
        "date": session["date"].iloc[0],
        "price_at_open": price_at_open,
        "price_at_open_end": price_at_open_end,
        "open30_ret": open30_ret,
    }

    for h in target_hours:
        target_cutoff = open_cutoff + timedelta(hours=h)
        target_bars = session[
            (session["datetime"] > open_cutoff) & (session["datetime"] <= target_cutoff)
        ]
        if target_bars.empty:
            # Fall back to session close
            price_at_target = session["close"].iloc[-1]
        else:
            price_at_target = target_bars["close"].iloc[-1]

        ret = (price_at_target - price_at_open_end) / price_at_open_end
        result[f"ret_30m_to_{h}h"] = ret

    return result


# ----------------------------- Signal generation -----------------------------

def generate_signals(
    session_df: pd.DataFrame, threshold: float
) -> pd.DataFrame:
    """
    Signal +1 (long) if open30_ret > threshold (positive momentum).
    Signal -1 (short) if open30_ret < -threshold (negative momentum).
    Signal 0 otherwise.
    """
    df = session_df.copy()
    df["signal"] = 0
    df.loc[df["open30_ret"] > threshold, "signal"] = 1
    df.loc[df["open30_ret"] < -threshold, "signal"] = -1
    return df


# ----------------------------- Backtest -----------------------------

def backtest(
    session_df: pd.DataFrame,
    target_col: str,
    capital: float,
) -> pd.DataFrame:
    """
    Simple backtest: enter after open30 per signal, exit at target window.
    Each day uses full capital; daily PnL = signal * target_return * capital.
    """
    df = session_df.copy()
    df = df.dropna(subset=["signal", target_col])

    df["daily_pnl"] = df["signal"] * df[target_col] * capital
    df["portfolio_value"] = capital + df["daily_pnl"].cumsum()
    return df[["date", "signal", target_col, "daily_pnl", "portfolio_value"]].copy()


# ----------------------------- Statistics -----------------------------

def compute_stats(session_df: pd.DataFrame, target_cols: List[str]) -> dict:
    """T-tests and hit rates for each target window."""
    result = {}
    for col in target_cols:
        sub = session_df.dropna(subset=[col, "signal"])
        active = sub[sub["signal"] != 0].copy()
        if len(active) < 5:
            result[col] = {"n": len(active), "note": "insufficient data"}
            continue
        # Signed return (aligning direction with signal)
        signed_ret = active["signal"] * active[col]
        t_stat, p_val = stats.ttest_1samp(signed_ret, 0.0)
        hit_rate = float((signed_ret > 0).mean())
        result[col] = {
            "n": int(len(active)),
            "mean_signed_ret": float(signed_ret.mean()),
            "std_signed_ret": float(signed_ret.std()),
            "t_stat": float(t_stat),
            "p_value": float(p_val),
            "hit_rate": round(hit_rate, 4),
            "annualized_sharpe": float(signed_ret.mean() / max(signed_ret.std(), 1e-9) * np.sqrt(252)),
        }
    return result


# ----------------------------- Main -----------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Intraday momentum continuation — first 30-min into 2h/4h"
    )
    ap.add_argument("--prices", required=True,
                    help="Intraday OHLCV CSV with datetime,open,high,low,close,volume")
    ap.add_argument("--threshold", type=float, default=0.002,
                    help="Minimum |open30_ret| to signal (default 0.002 = 20bps)")
    ap.add_argument("--open-minutes", type=int, default=30, dest="open_minutes",
                    help="Length of opening momentum window in minutes (default 30)")
    ap.add_argument("--target-hours", nargs="+", type=int, default=[2, 4],
                    dest="target_hours", help="Return measurement horizons in hours (default: 2 4)")
    ap.add_argument("--capital", type=float, default=1_000_000,
                    help="Starting capital in USD (default 1000000)")
    ap.add_argument("--outdir", default="./artifacts")
    args = ap.parse_args()

    cfg = Config(
        prices=args.prices,
        threshold=args.threshold,
        open_minutes=args.open_minutes,
        target_hours=args.target_hours,
        capital=args.capital,
        outdir=args.outdir,
    )

    outdir = ensure_outdir(cfg.outdir, "intraday_momentum_continuation")
    print(f"[INFO] Output directory: {outdir}")

    df = load_intraday(cfg.prices)
    print(f"[INFO] Loaded {len(df)} bars from {df['datetime'].min()} to {df['datetime'].max()}")

    sessions = split_sessions(df)
    print(f"[INFO] Found {len(sessions)} trading sessions")

    session_rows = []
    for date, session in sessions.items():
        row = compute_session_returns(session, cfg.open_minutes, cfg.target_hours)
        if row:
            session_rows.append(row)

    if not session_rows:
        print("[WARN] No sessions could be processed. Check date format and bar frequency.")
        return

    session_df = pd.DataFrame(session_rows)
    session_df = generate_signals(session_df, cfg.threshold)

    target_cols = [f"ret_30m_to_{h}h" for h in cfg.target_hours]
    stats_dict = compute_stats(session_df, target_cols)

    session_df.to_csv(os.path.join(outdir, "session_summary.csv"), index=False)

    signal_log = session_df[["date", "open30_ret", "signal"]].copy()
    signal_log["threshold_used"] = cfg.threshold
    signal_log.to_csv(os.path.join(outdir, "signal_log.csv"), index=False)

    # Backtest on first target hour by default
    primary_target = target_cols[0] if target_cols else None
    if primary_target and primary_target in session_df.columns:
        eq_df = backtest(session_df, primary_target, cfg.capital)
        eq_df.to_csv(os.path.join(outdir, "backtest_equity.csv"), index=False)

    with open(os.path.join(outdir, "stats_summary.json"), "w") as f:
        json.dump(stats_dict, f, indent=2)

    with open(os.path.join(outdir, "run_params.json"), "w") as f:
        json.dump(asdict(cfg), f, indent=2)

    print(f"\n=== Summary ===")
    print(f"Sessions processed: {len(session_df)}")
    n_signals = int((session_df["signal"] != 0).sum())
    print(f"Active signal days: {n_signals} ({n_signals/len(session_df)*100:.1f}%)")
    for col, s in stats_dict.items():
        if "t_stat" in s:
            print(f"  {col}: mean={s['mean_signed_ret']:.4f}, t={s['t_stat']:.2f}, "
                  f"p={s['p_value']:.4f}, hit={s['hit_rate']:.2%}")
    print(f"Artifacts written to: {outdir}")


if __name__ == "__main__":
    main()
