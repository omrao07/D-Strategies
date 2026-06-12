#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
activist_investor_tracking.py — Activist campaigns → target stock CAR analysis
"""
import argparse
import json
import os

import pandas as pd


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    events = pd.read_csv(cfg.events_file, parse_dates=["announce_date"])
    events.columns = [c.lower().strip() for c in events.columns]

    if cfg.returns_file:
        rets = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        rets.columns = [c.lower().strip() for c in rets.columns]
        wide = rets.pivot(index="date", columns="ticker", values="return").sort_index()
        mkt_col = [c for c in wide.columns if c.lower() in ("spy", "nifty", "market")][0] if any(c.lower() in ("spy", "nifty", "market") for c in wide.columns) else wide.columns[0]
        mkt = wide[mkt_col]

        records = []
        for _, ev in events.iterrows():
            t = ev["target_ticker"]
            d = ev["announce_date"]
            if t not in wide.columns:
                continue
            windows = {}
            for horizon in [5, 20, 60]:
                fut = wide.loc[wide.index >= d, t].dropna().iloc[:horizon]
                mkt_fut = mkt.loc[mkt.index >= d].dropna().iloc[:horizon]
                if len(fut) < horizon // 2:
                    continue
                car = float((1 + fut).prod() - 1 - ((1 + mkt_fut).prod() - 1))
                windows[f"car_{horizon}d"] = car
            records.append({"announce_date": d, "activist": ev.get("activist", ""), "target": t,
                            "demand": ev.get("demand", ""), **windows})
        df = pd.DataFrame(records)
        df.to_csv(os.path.join(cfg.outdir, "activist_cars.csv"), index=False)
        by_demand = df.groupby("demand")[["car_5d", "car_20d", "car_60d"]].mean().reset_index() if "demand" in df.columns else pd.DataFrame()
        if not by_demand.empty:
            by_demand.to_csv(os.path.join(cfg.outdir, "by_demand_type.csv"), index=False)
        summary = {"n_events": len(df), "avg_car_5d": float(df["car_5d"].mean()) if "car_5d" in df else None,
                   "avg_car_60d": float(df["car_60d"].mean()) if "car_60d" in df else None}
    else:
        events.to_csv(os.path.join(cfg.outdir, "events.csv"), index=False)
        summary = {"n_events": len(events)}

    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Activist tracking | Events: {summary['n_events']} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", required=True, dest="events_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/activist")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
