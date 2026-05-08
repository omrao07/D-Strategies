#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
earnings_vol_crush.py — Sell straddle pre-earnings, buy back after — IV crush capture
---------------------------------------------------------------------------------------
Identifies earnings dates, measures IV before and after, quantifies the crush, and
backtests a strategy of selling ATM straddles 2 days before earnings and buying back
1 day after.

Inputs (CSV)
------------
--options  options.csv   REQUIRED: date, ticker, expiry, type (call/put), strike, iv,
                                   underlying_price
--earnings earnings.csv  REQUIRED: date (earnings_date), ticker

Outputs
-------
outdir/iv_crush_analysis.csv   ticker, earnings_date, pre_iv, post_iv, crush_pct, straddle_pnl
outdir/trade_log.csv           entry/exit details per trade
outdir/summary.json            avg crush, win rate, total P&L
"""

import argparse, json, os
import numpy as np
import pandas as pd


def load_options(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    return df


def load_earnings(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    return df


def find_atm_iv(opts: pd.DataFrame, ticker: str, date: pd.Timestamp, opt_type: str) -> float:
    day = opts[(opts["ticker"] == ticker) & (opts["date"] == date) & (opts["type"] == opt_type)]
    if day.empty:
        return np.nan
    day = day.copy()
    day["moneyness"] = abs(day["strike"] - day["underlying_price"])
    atm = day.loc[day["moneyness"].idxmin()]
    return float(atm["iv"])


def straddle_price(call_iv: float, put_iv: float, spot: float, dte: int) -> float:
    # Approximate straddle price: 0.8 * avg_iv * spot * sqrt(dte/252)
    avg_iv = (call_iv + put_iv) / 2
    return 0.8 * avg_iv * spot * np.sqrt(max(dte, 1) / 252)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    opts = load_options(cfg.options_file)
    earnings = load_earnings(cfg.earnings_file)

    trades = []
    for _, row in earnings.iterrows():
        ticker = row["ticker"]
        edate = row["date"]
        pre_date = edate - pd.Timedelta(days=cfg.days_before)
        post_date = edate + pd.Timedelta(days=cfg.days_after)

        # Find nearest available option dates
        ticker_opts = opts[opts["ticker"] == ticker]
        avail_dates = sorted(ticker_opts["date"].unique())
        pre = min(avail_dates, key=lambda d: abs((d - pre_date).days), default=None)
        post = min(avail_dates, key=lambda d: abs((d - post_date).days), default=None)
        if pre is None or post is None:
            continue

        pre_call_iv = find_atm_iv(opts, ticker, pre, "call")
        pre_put_iv = find_atm_iv(opts, ticker, pre, "put")
        post_call_iv = find_atm_iv(opts, ticker, post, "call")
        post_put_iv = find_atm_iv(opts, ticker, post, "put")
        if any(np.isnan(v) for v in [pre_call_iv, pre_put_iv, post_call_iv, post_put_iv]):
            continue

        # Underlying price at entry
        pre_row = opts[(opts["ticker"] == ticker) & (opts["date"] == pre)].iloc[0]
        spot = float(pre_row.get("underlying_price", 100))
        dte_entry = max((edate - pre).days, 1)
        dte_exit = max((edate - post).days + cfg.days_after, 0)

        sell_price = straddle_price(pre_call_iv, pre_put_iv, spot, dte_entry)
        buy_price = straddle_price(post_call_iv, post_put_iv, spot, max(dte_exit, 1))
        pnl = sell_price - buy_price  # sell high IV, buy low IV
        pre_iv = (pre_call_iv + pre_put_iv) / 2
        post_iv = (post_call_iv + post_put_iv) / 2
        crush_pct = (pre_iv - post_iv) / pre_iv if pre_iv > 0 else np.nan

        trades.append({"ticker": ticker, "earnings_date": edate, "entry_date": pre,
                        "exit_date": post, "pre_iv": pre_iv, "post_iv": post_iv,
                        "crush_pct": crush_pct, "straddle_sell": sell_price,
                        "straddle_buy": buy_price, "pnl": pnl, "win": pnl > 0})

    if not trades:
        print("No trades generated — check data coverage.")
        return

    df = pd.DataFrame(trades)
    df.to_csv(os.path.join(cfg.outdir, "iv_crush_analysis.csv"), index=False)

    trade_log = df[["ticker", "earnings_date", "entry_date", "exit_date",
                    "straddle_sell", "straddle_buy", "pnl", "win"]]
    trade_log.to_csv(os.path.join(cfg.outdir, "trade_log.csv"), index=False)

    summary = {"n_trades": len(df), "avg_crush_pct": float(df["crush_pct"].mean()),
               "win_rate": float(df["win"].mean()), "total_pnl": float(df["pnl"].sum()),
               "avg_pnl_per_trade": float(df["pnl"].mean()),
               "avg_pre_iv": float(df["pre_iv"].mean()), "avg_post_iv": float(df["post_iv"].mean())}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Trades: {summary['n_trades']} | Win rate: {summary['win_rate']:.1%} | Avg crush: {summary['avg_crush_pct']:.1%}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--options", required=True, dest="options_file")
    ap.add_argument("--earnings", required=True, dest="earnings_file")
    ap.add_argument("--days-before", type=int, default=2)
    ap.add_argument("--days-after", type=int, default=1)
    ap.add_argument("--outdir", default="./artifacts/earnings_vol_crush")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
