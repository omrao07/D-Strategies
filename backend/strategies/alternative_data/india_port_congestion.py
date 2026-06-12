#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_port_congestion.py — India port congestion signal for shipping/logistics stocks
======================================================================================
Tracks congestion at India's major ports (JNPT, Mundra, Chennai, Vizag, Kolkata)
using vessel traffic data, dwell times, and import/export throughput. Port congestion
signals:
  - Import backlog → inflation pressure (commodities, electronics)
  - Export delay → corporate revenue at risk
  - Container throughput → PMI/GDP leading indicator

India moat: India ports handle 95% of trade by value. Port data is public (JNPT
publishes daily throughput) but not systematically analyzed by global funds.

Signals:
  - JNPT/Mundra congestion → positive for logistics stocks (Concor, GPPL, Adani Ports)
  - Congestion + commodity imports backed up → positive for domestic substitutes

Inputs (CSV)
------------
--ports     ports.csv       date, port, vessels_waiting, avg_dwell_days, teus_handled
--stocks    stocks.csv      date, ticker, close
--macro     macro.csv       date, india_imports_cr, india_exports_cr (optional)

Outputs
-------
outdir/congestion_index.csv     date, port, congestion_score, z_score
outdir/stock_correlation.csv    ticker, congestion_correlation, lag_days
outdir/trade_signals.csv        date, congestion_index, signal, logistics_basket
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

# Port weights for composite index
PORT_WEIGHTS = {
    "JNPT": 0.35,
    "MUNDRA": 0.30,
    "CHENNAI": 0.15,
    "VIZAG": 0.10,
    "KOLKATA": 0.10,
}

# Logistics/port-exposed stocks
LOGISTICS_BASKET = ["ADANIPORTS", "CONCOR", "GPPL", "JSPL", "BLUESTARCO"]

ZSCORE_WINDOW = 60
ENTRY_Z = 1.5
MA_WINDOW = 10


def compute_congestion_score(row: pd.Series) -> float:
    """Normalize congestion metrics to 0-100 score."""
    score = 0.0
    if not np.isnan(row.get("vessels_waiting", np.nan)):
        score += row["vessels_waiting"] * 5  # More vessels = more congested
    if not np.isnan(row.get("avg_dwell_days", np.nan)):
        score += max(0, row["avg_dwell_days"] - 3) * 10  # Normal dwell = 3 days
    return min(score, 100.0)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    ports = pd.read_csv(cfg.ports_file, parse_dates=["date"])
    ports.columns = [c.lower().strip() for c in ports.columns]

    stocks = pd.read_csv(cfg.stocks_file, parse_dates=["date"])
    stocks.columns = [c.lower().strip() for c in stocks.columns]
    stocks_wide = stocks.pivot_table(index="date", columns="ticker", values="close").sort_index()
    stocks_wide.columns = [c.upper() for c in stocks_wide.columns]

    congestion_records = []

    # Compute per-port congestion score
    if "port" in ports.columns:
        for port, grp in ports.groupby("port"):
            grp = grp.set_index("date").sort_index()
            grp["congestion_score"] = grp.apply(compute_congestion_score, axis=1)
            mu = grp["congestion_score"].rolling(ZSCORE_WINDOW).mean()
            sigma = grp["congestion_score"].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
            grp["z_score"] = (grp["congestion_score"] - mu) / sigma

            weight = PORT_WEIGHTS.get(str(port).upper(), 0.1)
            for dt, row in grp.iterrows():
                congestion_records.append({
                    "date": dt.date(),
                    "port": str(port).upper(),
                    "vessels_waiting": float(row.get("vessels_waiting", np.nan)),
                    "avg_dwell_days": float(row.get("avg_dwell_days", np.nan)),
                    "teus_handled": float(row.get("teus_handled", np.nan)),
                    "congestion_score": float(row["congestion_score"]),
                    "z_score": float(row["z_score"]) if not np.isnan(row["z_score"]) else None,
                    "weight": weight,
                })
    else:
        # No port column — treat as aggregate
        ports_grp = ports.set_index("date").sort_index()
        ports_grp["congestion_score"] = ports_grp.apply(compute_congestion_score, axis=1)
        for dt, row in ports_grp.iterrows():
            congestion_records.append({
                "date": dt.date(), "port": "AGGREGATE",
                "congestion_score": float(row["congestion_score"]),
                "weight": 1.0,
            })

    pd.DataFrame(congestion_records).sort_values("date").to_csv(
        os.path.join(cfg.outdir, "congestion_index.csv"), index=False
    )

    # Composite index (weighted average of port z-scores)
    cong_df = pd.DataFrame(congestion_records)
    cong_df["date"] = pd.to_datetime(cong_df["date"])
    composite = cong_df.groupby("date").apply(
        lambda g: np.average(g["z_score"].fillna(0), weights=g["weight"])
    ).rename("composite_z")

    composite.rolling(MA_WINDOW).mean()

    # Stock correlation with congestion index
    corr_records = []
    for ticker in LOGISTICS_BASKET:
        if ticker not in stocks_wide.columns:
            continue
        stock_ret = stocks_wide[ticker].pct_change()
        aligned = pd.concat([composite, stock_ret.rename("stock")], axis=1).dropna()
        if len(aligned) >= 30:
            for lag in [0, 1, 2, 5]:
                corr = float(aligned["composite_z"].corr(aligned["stock"].shift(-lag).dropna()))
                corr_records.append({"ticker": ticker, "lag_days": lag, "correlation": corr})

    if corr_records:
        pd.DataFrame(corr_records).to_csv(os.path.join(cfg.outdir, "stock_correlation.csv"), index=False)

    # Trading signals
    signal_records = []
    pos_list = []

    for dt, z in composite.items():
        if pd.isna(z):
            sig = "flat"; pos = 0.0
        elif z > ENTRY_Z:
            sig = "long_logistics"; pos = 1.0   # High congestion → good for logistics stocks
        elif z < -ENTRY_Z:
            sig = "flat"; pos = 0.0
        else:
            sig = "flat"; pos = 0.0

        signal_records.append({
            "date": dt.date(),
            "composite_congestion_z": float(z),
            "signal": sig,
        })
        pos_list.append(pos)

    pd.DataFrame(signal_records).to_csv(os.path.join(cfg.outdir, "trade_signals.csv"), index=False)

    # Backtest: long logistics basket when congestion high
    avail_basket = [t for t in LOGISTICS_BASKET if t in stocks_wide.columns]
    if avail_basket and pos_list:
        basket_ret = stocks_wide[avail_basket].pct_change().mean(axis=1)
        pos_s = pd.Series(pos_list, index=composite.index).shift(1).reindex(basket_ret.index).ffill().fillna(0)
        strat_ret = (pos_s * basket_ret).dropna()
        cum = (1 + strat_ret).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(252)) if strat_ret.std() > 0 else None
    else:
        sharpe = None

    summary = {
        "n_ports": int(cong_df["port"].nunique()),
        "avg_composite_z": float(composite.mean()),
        "pct_high_congestion": float((composite > ENTRY_Z).mean() * 100),
        "logistics_basket": avail_basket,
        "sharpe": sharpe,
        "params": {"entry_z": ENTRY_Z, "port_weights": PORT_WEIGHTS}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India Port Congestion | {summary['n_ports']} ports | High congestion: {summary['pct_high_congestion']:.1f}% days | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ports", required=True, dest="ports_file")
    ap.add_argument("--stocks", required=True, dest="stocks_file")
    ap.add_argument("--macro", default=None, dest="macro_file")
    ap.add_argument("--outdir", default="./artifacts/india_port_congestion")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
