#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
failed_breakout_fade.py — Breakout fails to hold → fade to origin
===================================================================
Detects when price breaks above an N-day high but then closes back below it
within 3 bars. Signals short (fade). Target is the 20-day moving average.

Inputs (CSV)
------------
--prices  prices.csv
    Columns: date, ticker, open, high, low, close, volume

Outputs
-------
outdir/failed_breakouts.csv     date, ticker, breakout_level, fade_signal, fwd_returns
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def detect_failed_breakouts(close: pd.Series, high: pd.Series, window: int = 20, confirm_bars: int = 3) -> pd.Series:
    """Returns series of -1 (short signal) on failed breakout bars, else 0."""
    n_day_high = close.rolling(window).max().shift(1)
    ma20 = close.rolling(window).mean()
    signals = pd.Series(0, index=close.index)
    for i in range(window + confirm_bars, len(close)):
        # Check if any of the past confirm_bars broke out
        for j in range(1, confirm_bars + 1):
            if close.iloc[i - j] > n_day_high.iloc[i - j]:
                # Breakout happened; did it fail (close back below)?
                if close.iloc[i] < n_day_high.iloc[i - j]:
                    signals.iloc[i] = -1
                    break
    return signals, ma20


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    df = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]

    tickers = df["ticker"].unique() if "ticker" in df.columns else ["default"]
    all_signals = []
    equity_curve = pd.Series(dtype=float)

    for ticker in tickers:
        sub = df[df["ticker"] == ticker].set_index("date").sort_index() if "ticker" in df.columns else df.set_index("date").sort_index()
        if "close" not in sub.columns or len(sub) < cfg.window + 10:
            continue
        close = sub["close"].astype(float)
        high = sub["high"].astype(float) if "high" in sub.columns else close
        signals, ma20 = detect_failed_breakouts(close, high, cfg.window, cfg.confirm_bars)

        for i, (date, sig) in enumerate(signals.items()):
            if sig != -1:
                continue
            price = close.loc[date]
            target = ma20.loc[date]
            potential_gain_pct = (price - target) / price  # short from price to MA

            fut_rets = close.iloc[close.index.get_loc(date) + 1: close.index.get_loc(date) + cfg.hold_days + 1]
            fwd = float((fut_rets.iloc[-1] / price - 1) * -1) if len(fut_rets) > 0 else np.nan  # short return

            all_signals.append({"date": date, "ticker": ticker, "close": price,
                                 "ma20_target": target, "potential_gain_pct": potential_gain_pct,
                                 "fwd_return_short": fwd, "win": fwd > 0 if not np.isnan(fwd) else None})

    if not all_signals:
        print("No failed breakouts detected.")
        return

    sdf = pd.DataFrame(all_signals).sort_values("date")
    sdf.to_csv(os.path.join(cfg.outdir, "failed_breakouts.csv"), index=False)

    bt = sdf.dropna(subset=["fwd_return_short"])
    bt = bt.set_index("date")["fwd_return_short"]
    cum = (1 + bt).cumprod()
    cum.to_frame("cumulative_pnl").to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    summary = {"n_signals": len(sdf), "win_rate": float(sdf["win"].mean()) if "win" in sdf.columns else None,
               "avg_fwd_return": float(sdf["fwd_return_short"].mean()),
               "avg_potential_gain_pct": float(sdf["potential_gain_pct"].mean()),
               "params": {"window": cfg.window, "confirm_bars": cfg.confirm_bars, "hold_days": cfg.hold_days}}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Failed breakouts: {len(sdf)} signals | Win rate: {summary['win_rate']:.1%} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--window", type=int, default=20)
    ap.add_argument("--confirm-bars", type=int, default=3)
    ap.add_argument("--hold-days", type=int, default=10)
    ap.add_argument("--outdir", default="./artifacts/failed_breakout")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
