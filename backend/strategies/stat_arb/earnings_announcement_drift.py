#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# earnings_announcement_drift.py
#
# Extended PEAD — Post-Earnings Announcement Drift (2-60 day window)
# ------------------------------------------------------------------
# Takes an earnings events CSV with the announcement date, ticker, and
# direction (beat/miss).  Signals long on beat and short on miss; measures
# and backtests the cumulative return from day+2 through day+60.  Tests
# statistical significance of the drift at multiple horizons.
#
# Inputs
# ------
# --events FILE  (CSV, required)
#   date,ticker,direction
#   date: YYYY-MM-DD of the earnings announcement
#   direction: "beat" or "miss"
#
# --prices FILE  (CSV, required)
#   date,ticker,close
#   Daily adjusted close prices for all tickers in the events file.
#
# Outputs
# -------
# outdir/
#   run_params.json
#   events_clean.csv         — cleaned events with entry/exit dates
#   signal_log.csv           — event-level signal, entry_price, exit_price, return
#   drift_by_horizon.csv     — average cumulative return at each horizon day
#   backtest_equity.csv      — date, portfolio_value, daily_pnl
#   stats_summary.json       — t-stats, hit rates, Sharpe at 30d and 60d horizons
#
# Usage
# -----
# python earnings_announcement_drift.py \
#   --events earnings_events.csv \
#   --prices daily_prices.csv \
#   --entry-lag 2 \
#   --hold-days 60 \
#   --capital 1000000 \
#   --max-positions 30 \
#   --outdir ./artifacts
#
# Dependencies: pip install pandas numpy scipy

import argparse
import json
import os
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from scipy import stats


# ----------------------------- Config -----------------------------

@dataclass
class Config:
    events: str
    prices: str
    entry_lag: int
    hold_days: int
    capital: float
    max_positions: int
    outdir: str


# ----------------------------- IO helpers -----------------------------

def ensure_outdir(base: str, tag: str) -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    outdir = os.path.join(base, f"{tag}_{ts}")
    os.makedirs(outdir, exist_ok=True)
    return outdir


def load_events(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = ["date", "ticker", "direction"]
    for c in required:
        if c not in df.columns:
            raise SystemExit(f"events CSV missing column: {c}")
    df["direction"] = df["direction"].str.lower().str.strip()
    valid = df["direction"].isin(["beat", "miss"])
    if not valid.all():
        bad = df[~valid]["direction"].unique().tolist()
        print(f"[WARN] Dropping {(~valid).sum()} rows with unknown direction: {bad}")
    df = df[valid].copy()
    df = df.sort_values(["date", "ticker"]).reset_index(drop=True)
    return df


def load_prices(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = ["date", "ticker", "close"]
    for c in required:
        if c not in df.columns:
            raise SystemExit(f"prices CSV missing column: {c}")
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df = df.dropna(subset=["close"]).sort_values(["ticker", "date"]).reset_index(drop=True)
    return df


# ----------------------------- Price lookup helpers -----------------------------

def build_price_index(prices: pd.DataFrame) -> Dict[str, pd.Series]:
    """Build {ticker: pd.Series(close, index=date)} for fast lookup."""
    return {
        ticker: grp.set_index("date")["close"]
        for ticker, grp in prices.groupby("ticker")
    }


def get_price_on_or_after(price_series: pd.Series, target_date, max_lag: int = 5) -> Optional[float]:
    """Return close price on target_date or the next available trading day (up to max_lag)."""
    for lag in range(max_lag + 1):
        d = target_date + timedelta(days=lag)
        if d in price_series.index:
            return float(price_series.loc[d])
    return None


# ----------------------------- Signal + return computation -----------------------------

def compute_event_returns(
    events: pd.DataFrame,
    price_index: Dict[str, pd.Series],
    entry_lag: int,
    hold_days: int,
) -> pd.DataFrame:
    """
    For each event, compute the return from entry (ann_date + entry_lag) to
    exit (entry_date + hold_days).  Also compute intermediate horizons.
    """
    horizons = [5, 10, 20, 30, 45, hold_days]
    horizons = sorted(set(horizons))

    records = []
    for _, row in events.iterrows():
        ticker = row["ticker"]
        ann_date = row["date"]
        direction = row["direction"]

        if ticker not in price_index:
            continue

        ps = price_index[ticker]
        entry_date = ann_date + timedelta(days=entry_lag)
        entry_price = get_price_on_or_after(ps, entry_date)
        if entry_price is None or entry_price <= 0:
            continue

        signal = 1 if direction == "beat" else -1

        event_row = {
            "ann_date": ann_date,
            "ticker": ticker,
            "direction": direction,
            "signal": signal,
            "entry_date": entry_date,
            "entry_price": entry_price,
        }

        for h in horizons:
            exit_date = entry_date + timedelta(days=h)
            exit_price = get_price_on_or_after(ps, exit_date)
            if exit_price is not None:
                raw_ret = (exit_price - entry_price) / entry_price
                trade_ret = signal * raw_ret
            else:
                raw_ret = np.nan
                trade_ret = np.nan
            event_row[f"raw_ret_{h}d"] = raw_ret
            event_row[f"trade_ret_{h}d"] = trade_ret

        records.append(event_row)

    return pd.DataFrame(records)


# ----------------------------- Drift table -----------------------------

def compute_drift_by_horizon(events_df: pd.DataFrame, hold_days: int) -> pd.DataFrame:
    """Mean cumulative return at each horizon for beat and miss separately."""
    horizons = [5, 10, 20, 30, 45, hold_days]
    horizons = sorted(set(horizons))
    records = []
    for h in horizons:
        col = f"trade_ret_{h}d"
        if col not in events_df.columns:
            continue
        all_rets = events_df[col].dropna()
        beat_rets = events_df[events_df["direction"] == "beat"][col].dropna()
        miss_rets = events_df[events_df["direction"] == "miss"][col].dropna()

        t_all, p_all = stats.ttest_1samp(all_rets, 0.0) if len(all_rets) > 2 else (np.nan, np.nan)
        records.append({
            "horizon_days": h,
            "n_all": len(all_rets),
            "mean_trade_ret_all": round(float(all_rets.mean()) if len(all_rets) else np.nan, 5),
            "n_beat": len(beat_rets),
            "mean_trade_ret_beat": round(float(beat_rets.mean()) if len(beat_rets) else np.nan, 5),
            "n_miss": len(miss_rets),
            "mean_trade_ret_miss": round(float(miss_rets.mean()) if len(miss_rets) else np.nan, 5),
            "t_stat": round(float(t_all), 3) if not np.isnan(t_all) else np.nan,
            "p_value": round(float(p_all), 5) if not np.isnan(p_all) else np.nan,
        })
    return pd.DataFrame(records)


# ----------------------------- Backtest -----------------------------

def backtest(
    events_df: pd.DataFrame,
    price_index: Dict[str, pd.Series],
    capital: float,
    max_positions: int,
    hold_days: int,
) -> pd.DataFrame:
    """
    Event-driven backtest.  Each event opens a position on entry_date,
    closes on exit_date.  Daily P&L is computed from price changes.
    """
    # Build daily position registry
    pos_records: List[Dict] = []
    for _, row in events_df.iterrows():
        if np.isnan(row.get(f"trade_ret_{hold_days}d", np.nan)):
            continue
        pos_records.append({
            "ticker": row["ticker"],
            "signal": int(row["signal"]),
            "entry_date": row["entry_date"],
            "exit_date": row["entry_date"] + timedelta(days=hold_days),
            "entry_price": row["entry_price"],
        })

    all_dates = sorted(set(
        d for ps in price_index.values() for d in ps.index
    ))
    if not all_dates:
        return pd.DataFrame()

    equity = capital
    daily_records = []
    open_positions: List[Dict] = []

    for date in all_dates:
        # Open new positions
        new_pos = [p for p in pos_records if p["entry_date"] <= date <= p["exit_date"]]
        active = [p for p in new_pos if p not in open_positions]
        open_positions = new_pos[:max_positions]  # cap positions

        daily_pnl = 0.0
        alloc = capital / max(len(open_positions), 1)

        for p in open_positions:
            ps = price_index.get(p["ticker"])
            if ps is None:
                continue
            # Daily return contribution
            dates_avail = sorted(ps.index)
            if date not in ps.index:
                continue
            prev_dates = [d for d in dates_avail if d < date]
            if not prev_dates:
                continue
            prev_date = prev_dates[-1]
            prev_px = float(ps.loc[prev_date])
            cur_px = float(ps.loc[date])
            if prev_px <= 0:
                continue
            day_ret = (cur_px - prev_px) / prev_px
            daily_pnl += p["signal"] * day_ret * alloc

        equity += daily_pnl
        daily_records.append({
            "date": date,
            "portfolio_value": equity,
            "daily_pnl": daily_pnl,
            "n_positions": len(open_positions),
        })

    return pd.DataFrame(daily_records)


# ----------------------------- Statistics -----------------------------

def compute_stats(events_df: pd.DataFrame, hold_days: int) -> dict:
    col = f"trade_ret_{hold_days}d"
    rets = events_df[col].dropna() if col in events_df.columns else pd.Series([], dtype=float)
    if len(rets) < 5:
        return {"note": "insufficient data"}
    t_stat, p_val = stats.ttest_1samp(rets, 0.0)
    return {
        "n_events": int(len(rets)),
        "n_beat": int((events_df["direction"] == "beat").sum()),
        "n_miss": int((events_df["direction"] == "miss").sum()),
        f"mean_trade_ret_{hold_days}d": float(rets.mean()),
        f"std_trade_ret_{hold_days}d": float(rets.std()),
        "t_stat": float(t_stat),
        "p_value": float(p_val),
        "hit_rate": float((rets > 0).mean()),
        "annualized_sharpe": float(rets.mean() / max(rets.std(), 1e-9) * np.sqrt(252 / hold_days)),
    }


# ----------------------------- Main -----------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Extended PEAD — buy/sell after earnings, hold 60 days"
    )
    ap.add_argument("--events", required=True,
                    help="CSV: date,ticker,direction (beat/miss)")
    ap.add_argument("--prices", required=True,
                    help="CSV: date,ticker,close (daily adjusted close)")
    ap.add_argument("--entry-lag", type=int, default=2, dest="entry_lag",
                    help="Days after announcement to enter trade (default 2)")
    ap.add_argument("--hold-days", type=int, default=60, dest="hold_days",
                    help="Holding period in calendar days (default 60)")
    ap.add_argument("--capital", type=float, default=1_000_000)
    ap.add_argument("--max-positions", type=int, default=30, dest="max_positions")
    ap.add_argument("--outdir", default="./artifacts")
    args = ap.parse_args()

    cfg = Config(
        events=args.events,
        prices=args.prices,
        entry_lag=args.entry_lag,
        hold_days=args.hold_days,
        capital=args.capital,
        max_positions=args.max_positions,
        outdir=args.outdir,
    )

    outdir = ensure_outdir(cfg.outdir, "earnings_announcement_drift")
    print(f"[INFO] Output directory: {outdir}")

    events = load_events(cfg.events)
    prices = load_prices(cfg.prices)
    price_index = build_price_index(prices)
    print(f"[INFO] Events: {len(events)}, Tickers in price data: {len(price_index)}")

    events_df = compute_event_returns(events, price_index, cfg.entry_lag, cfg.hold_days)
    events_df.to_csv(os.path.join(outdir, "signal_log.csv"), index=False)
    events.to_csv(os.path.join(outdir, "events_clean.csv"), index=False)

    drift_df = compute_drift_by_horizon(events_df, cfg.hold_days)
    drift_df.to_csv(os.path.join(outdir, "drift_by_horizon.csv"), index=False)

    eq_df = backtest(events_df, price_index, cfg.capital, cfg.max_positions, cfg.hold_days)
    eq_df.to_csv(os.path.join(outdir, "backtest_equity.csv"), index=False)

    agg = compute_stats(events_df, cfg.hold_days)
    with open(os.path.join(outdir, "stats_summary.json"), "w") as f:
        json.dump(agg, f, indent=2)

    with open(os.path.join(outdir, "run_params.json"), "w") as f:
        json.dump(asdict(cfg), f, indent=2, default=str)

    print(f"\n=== Summary ===")
    print(f"Events processed: {len(events_df)}")
    if "t_stat" in agg:
        print(f"Mean trade ret ({cfg.hold_days}d): {agg[f'mean_trade_ret_{cfg.hold_days}d']:.4f}")
        print(f"Hit rate: {agg['hit_rate']:.2%}")
        print(f"T-stat: {agg['t_stat']:.2f}  p={agg['p_value']:.4f}")
    if not eq_df.empty:
        final_val = float(eq_df["portfolio_value"].iloc[-1])
        print(f"Final portfolio value: ${final_val:,.0f}")
    print(f"Artifacts written to: {outdir}")


if __name__ == "__main__":
    main()
