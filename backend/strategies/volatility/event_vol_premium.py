#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
event_vol_premium.py — FOMC/elections → sell vol after event, collect risk premium
------------------------------------------------------------------------------------
Measures the IV spike before scheduled macro events (FOMC, NFP, elections) and the
subsequent crush after the event resolves. Backtests selling straddles day-after-event.

Inputs (CSV)
------------
--events  events.csv    REQUIRED: date, event_type (FOMC/NFP/election/etc)
--vol     vol_data.csv  REQUIRED: date, underlying, iv_30d, [rv_30d]

Outputs
-------
outdir/event_vol_analysis.csv   event_date, event_type, pre_iv, post_5d_iv, crush_pct
outdir/backtest.csv             cumulative P&L from selling straddles post-event
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def load_events(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    return df.sort_values("date")


def load_vol(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"]).set_index("date").sort_index()
    df.columns = [c.lower().strip() for c in df.columns]
    return df


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    events = load_events(cfg.events_file)
    vol = load_vol(cfg.vol_file)
    iv_col = [c for c in vol.columns if "iv" in c.lower()][0]

    records = []
    for _, ev in events.iterrows():
        edate = ev["date"]
        pre_start = edate - pd.Timedelta(days=5)
        post_end = edate + pd.Timedelta(days=21)

        pre_mask = (vol.index >= pre_start) & (vol.index < edate)
        post5_mask = (vol.index > edate) & (vol.index <= edate + pd.Timedelta(days=5))
        post21_mask = (vol.index > edate) & (vol.index <= post_end)

        pre_iv = vol.loc[pre_mask, iv_col].mean() if pre_mask.any() else np.nan
        post5_iv = vol.loc[post5_mask, iv_col].mean() if post5_mask.any() else np.nan
        post21_iv = vol.loc[post21_mask, iv_col].mean() if post21_mask.any() else np.nan
        day_of_iv = vol[iv_col].get(edate, np.nan)

        crush_5d = (pre_iv - post5_iv) / pre_iv if pre_iv > 0 and not np.isnan(post5_iv) else np.nan
        crush_21d = (pre_iv - post21_iv) / pre_iv if pre_iv > 0 and not np.isnan(post21_iv) else np.nan

        # Approximate straddle P&L: sell at day_of_iv price, buy back at post5 price
        # Straddle price ≈ 0.8 * iv * sqrt(30/252)
        spot = 100  # normalized
        t = 30 / 252
        sell_price = 0.8 * (day_of_iv if not np.isnan(day_of_iv) else pre_iv) * spot * np.sqrt(t)
        buy_price = 0.8 * post5_iv * spot * np.sqrt(t) if not np.isnan(post5_iv) else np.nan
        pnl = sell_price - buy_price if not np.isnan(buy_price) else np.nan

        records.append({"event_date": edate, "event_type": ev.get("event_type", "unknown"),
                        "pre_iv": pre_iv, "day_of_iv": day_of_iv,
                        "post_5d_iv": post5_iv, "post_21d_iv": post21_iv,
                        "crush_5d_pct": crush_5d, "crush_21d_pct": crush_21d,
                        "straddle_sell": sell_price, "straddle_buy": buy_price, "pnl": pnl})

    df = pd.DataFrame(records)
    df.to_csv(os.path.join(cfg.outdir, "event_vol_analysis.csv"), index=False)

    bt = df.dropna(subset=["pnl"]).copy()
    bt["cumulative_pnl"] = bt["pnl"].cumsum()
    bt[["event_date", "event_type", "pnl", "cumulative_pnl"]].to_csv(
        os.path.join(cfg.outdir, "backtest.csv"), index=False)

    by_type = df.groupby("event_type").agg(
        avg_crush_5d=("crush_5d_pct", "mean"), avg_pnl=("pnl", "mean"), count=("pnl", "count")
    ).reset_index()

    summary = {"n_events": len(df), "avg_crush_5d": float(df["crush_5d_pct"].mean()),
               "avg_crush_21d": float(df["crush_21d_pct"].mean()),
               "win_rate": float((bt["pnl"] > 0).mean()) if len(bt) > 0 else None,
               "total_pnl": float(bt["pnl"].sum()) if len(bt) > 0 else None,
               "by_event_type": by_type.to_dict(orient="records")}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Events: {len(df)} | Avg 5d crush: {summary['avg_crush_5d']:.1%} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", required=True, dest="events_file")
    ap.add_argument("--vol", required=True, dest="vol_file")
    ap.add_argument("--outdir", default="./artifacts/event_vol_premium")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
