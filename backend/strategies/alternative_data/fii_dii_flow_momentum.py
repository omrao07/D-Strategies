#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fii_dii_flow_momentum.py — FII/DII net flow momentum strategy
==============================================================
Foreign Institutional Investors (FII) and Domestic Institutional Investors (DII)
net buy/sell data is published daily by NSE/SEBI. FII flows have historically
driven NIFTY direction, especially in trending markets. DII often acts as a
countercyclical buyer (buying when FII sells), creating a tug-of-war signal.

India moat: This data is not standardised globally. Bridgewater doesn't track
Indian FII/DII flows systematically. The FII-to-DII ratio signal is unique to
Indian equity markets and has predictive power over 2-10 day horizons.

Key signals:
  - Sustained FII buying for 5+ days → long NIFTY
  - FII selling + DII buying divergence → mean-reversion signal
  - FII/DII ratio extremes → contrarian entry

Inputs (CSV)
------------
--flows     flows.csv       date, fii_net_cr, dii_net_cr (crore INR)
--nifty     nifty.csv       date, nifty_close, nifty_volume

Outputs
-------
outdir/flow_signals.csv         date, fii_5d, dii_5d, fii_dii_ratio, signal, z_score
outdir/regime_analysis.csv      flow_regime, avg_nifty_return, n_obs
outdir/flow_impact.csv          fii_net_quartile vs forward_nifty_5d_return
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

# Rolling windows for flow signals
SHORT_WINDOW = 5      # 5-day net flow (momentum)
MEDIUM_WINDOW = 10    # 10-day net flow (trend confirmation)
LONG_WINDOW = 30      # 30-day net flow (structural trend)
ZSCORE_WINDOW = 60    # For z-scoring flows

# Entry thresholds (z-score of net flows)
FLOW_ENTRY_Z = 1.5
FLOW_EXIT_Z = 0.3

# Divergence threshold: FII and DII moving in opposite directions
DIVERGENCE_THRESHOLD = 0.7  # FII vs DII correlation < -0.7 over 10 days


def compute_flow_regime(fii_5d: float, dii_5d: float, fii_z: float) -> str:
    """Classify flow regime based on net flows."""
    if pd.isna(fii_5d) or pd.isna(fii_z):
        return "unknown"

    fii_buying = fii_5d > 0
    dii_buying = dii_5d > 0 if not pd.isna(dii_5d) else True

    if fii_z > 2.0 and fii_buying:
        return "strong_fii_inflow"
    elif fii_z > 1.0 and fii_buying:
        return "moderate_fii_inflow"
    elif fii_z < -2.0 and not fii_buying:
        return "strong_fii_outflow"
    elif fii_z < -1.0 and not fii_buying:
        return "moderate_fii_outflow"
    elif not fii_buying and dii_buying:
        return "fii_sell_dii_buy"
    elif fii_buying and not dii_buying:
        return "fii_buy_dii_sell"
    else:
        return "neutral"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    flows = pd.read_csv(cfg.flows_file, parse_dates=["date"]).set_index("date").sort_index()
    flows.columns = [c.lower().strip() for c in flows.columns]
    fii_col = [c for c in flows.columns if "fii" in c][0]
    dii_col = [c for c in flows.columns if "dii" in c][0] if any("dii" in c for c in flows.columns) else None

    nifty = pd.read_csv(cfg.nifty_file, parse_dates=["date"]).set_index("date").sort_index()
    nifty.columns = [c.lower().strip() for c in nifty.columns]
    nifty_col = [c for c in nifty.columns if "close" in c or "nifty" in c][0]

    data = flows[[fii_col]].copy()
    if dii_col:
        data = data.join(flows[[dii_col]])
    data = data.join(nifty[[nifty_col]].rename(columns={nifty_col: "nifty"})).dropna(subset=["nifty"])

    # Rolling sums
    data["fii_5d"] = data[fii_col].rolling(SHORT_WINDOW).sum()
    data["fii_10d"] = data[fii_col].rolling(MEDIUM_WINDOW).sum()
    data["fii_30d"] = data[fii_col].rolling(LONG_WINDOW).sum()

    if dii_col:
        data["dii_5d"] = data[dii_col].rolling(SHORT_WINDOW).sum()
        data["net_flow_5d"] = data["fii_5d"] + data["dii_5d"]
    else:
        data["dii_5d"] = 0.0
        data["net_flow_5d"] = data["fii_5d"]

    # FII/DII ratio
    data["fii_dii_ratio"] = data["fii_5d"] / (data["dii_5d"].abs().replace(0, np.nan)) if dii_col else np.nan

    # Z-score of FII flows
    fii_mu = data["fii_5d"].rolling(ZSCORE_WINDOW).mean()
    fii_std = data["fii_5d"].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
    data["fii_z"] = (data["fii_5d"] - fii_mu) / fii_std

    # Divergence: rolling correlation of daily FII vs DII
    if dii_col:
        corr_window = 10
        data["fii_dii_corr"] = data[fii_col].rolling(corr_window).corr(data[dii_col])
        data["divergence"] = data["fii_dii_corr"] < -DIVERGENCE_THRESHOLD
    else:
        data["divergence"] = False

    # Flow regime
    data["regime"] = data.apply(
        lambda r: compute_flow_regime(r["fii_5d"], r.get("dii_5d", 0), r["fii_z"]), axis=1
    )

    # Forward returns for analysis
    nifty_ret = data["nifty"].pct_change()
    data["nifty_fwd_5d"] = data["nifty"].pct_change(5).shift(-5) * 100

    # Signal generation
    def flow_signal(row) -> float:
        fii_z = row["fii_z"]
        regime = row["regime"]
        div = row["divergence"]
        if pd.isna(fii_z):
            return 0.0
        # Primary: FII momentum
        if fii_z > FLOW_ENTRY_Z:
            return 1.0  # Long NIFTY
        elif fii_z < -FLOW_ENTRY_Z:
            return -1.0  # Short NIFTY
        # Divergence: contrarian (FII sell + DII buy = expect bounce)
        elif div and regime == "fii_sell_dii_buy":
            return 0.5  # Mild long
        elif abs(fii_z) < FLOW_EXIT_Z:
            return 0.0
        return np.nan

    data["signal"] = data.apply(flow_signal, axis=1)
    pos = data["signal"].ffill().fillna(0).shift(1)

    # Backtest
    strat_ret = pos * nifty_ret
    strat_ret = strat_ret.dropna()
    cum = (1 + strat_ret).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    # Flow impact analysis (FII quartile vs forward return)
    data_clean = data.dropna(subset=["fii_5d", "nifty_fwd_5d"])
    if len(data_clean) >= 20:
        data_clean["fii_quartile"] = pd.qcut(data_clean["fii_5d"], q=4, labels=["Q1", "Q2", "Q3", "Q4"],
                                               duplicates="drop")
        impact = data_clean.groupby("fii_quartile")["nifty_fwd_5d"].agg(["mean", "std", "count"]).reset_index()
        impact.to_csv(os.path.join(cfg.outdir, "flow_impact.csv"), index=False)

    # Regime analysis
    regime_analysis = data.dropna(subset=["regime", "nifty_fwd_5d"]).groupby("regime")["nifty_fwd_5d"].agg(
        ["mean", "std", "count"]
    ).reset_index()
    regime_analysis.columns = ["flow_regime", "avg_nifty_fwd_5d_pct", "std", "n_obs"]
    regime_analysis.to_csv(os.path.join(cfg.outdir, "regime_analysis.csv"), index=False)

    # Signal records
    signal_records = []
    for dt, row in data.iterrows():
        signal_records.append({
            "date": dt.date(),
            "fii_daily": float(row[fii_col]) if not np.isnan(row[fii_col]) else None,
            "fii_5d_cr": float(row["fii_5d"]) if not np.isnan(row["fii_5d"]) else None,
            "dii_5d_cr": float(row["dii_5d"]) if not np.isnan(row.get("dii_5d", np.nan)) else None,
            "fii_z_score": float(row["fii_z"]) if not np.isnan(row["fii_z"]) else None,
            "fii_dii_ratio": float(row["fii_dii_ratio"]) if not np.isnan(row.get("fii_dii_ratio", np.nan)) else None,
            "regime": row["regime"],
            "signal": float(row["signal"]) if not np.isnan(row.get("signal", np.nan)) else 0,
            "nifty_close": float(row["nifty"]),
        })
    pd.DataFrame(signal_records).to_csv(os.path.join(cfg.outdir, "flow_signals.csv"), index=False)

    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(252)) if strat_ret.std() > 0 else None
    summary = {
        "avg_daily_fii_cr": float(data[fii_col].mean()),
        "fii_positive_days_pct": float((data[fii_col] > 0).mean() * 100),
        "n_divergence_days": int(data["divergence"].sum()),
        "n_trade_days": int((pos != 0).sum()),
        "ann_return": float(strat_ret.mean() * 252),
        "sharpe": sharpe,
        "params": {"short_window": SHORT_WINDOW, "medium_window": MEDIUM_WINDOW, "entry_z": FLOW_ENTRY_Z}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"FII/DII Flow Momentum | Avg FII: ₹{summary['avg_daily_fii_cr']:.0f}cr | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flows", required=True, dest="flows_file")
    ap.add_argument("--nifty", required=True, dest="nifty_file")
    ap.add_argument("--outdir", default="./artifacts/fii_dii_flows")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
