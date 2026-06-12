#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nse_margin_data.py — NSE margin trading data as leverage/sentiment indicator
=============================================================================
NSE publishes daily margin trading exposure data: total margin funded positions,
MTF (Margin Trading Facility) books, and peak margin used. High leverage in the
market signals speculative excess → contrarian bearish signal. Unwinding creates
forced-selling cascades.

India-specific: MTF rules changed in 2021 (SEBI circular). Retail participation
in F&O is very high (>90% of option buyers are retail). Leverage extremes are
more pronounced than in US/EU markets.

Signals:
  - MTF outstanding > historical 90th percentile → crowded long, reduce
  - F&O open interest surge + high margin utilization → reversal risk
  - Margin call pressure during drawdowns → additional selling pressure

Inputs (CSV)
------------
--margin    margin.csv      date, mtf_outstanding_cr, fo_oi_cr, margin_utilized_pct
--nifty     nifty.csv       date, nifty_close

Outputs
-------
outdir/margin_signals.csv       date, mtf_outstanding, leverage_z, signal
outdir/leverage_extremes.csv    extreme events with forward returns
outdir/backtest.csv             cumulative P&L (contrarian)
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

ZSCORE_WINDOW = 60
HIGH_LEVERAGE_Z = 2.0       # Above 2 std devs = very leveraged
LOW_LEVERAGE_Z = -1.0       # Below -1 std dev = de-leveraged (potential floor)
ENTRY_Z_CONTRARIAN = 2.0    # Enter contrarian short when leverage > this
FORWARD_DAYS = 5


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    margin = pd.read_csv(cfg.margin_file, parse_dates=["date"]).set_index("date").sort_index()
    margin.columns = [c.lower().strip() for c in margin.columns]
    mtf_col = [c for c in margin.columns if "mtf" in c or "outstanding" in c][0]

    nifty = pd.read_csv(cfg.nifty_file, parse_dates=["date"]).set_index("date").sort_index()
    nifty.columns = [c.lower().strip() for c in nifty.columns]
    nifty_col = nifty.columns[0]

    data = margin[[mtf_col]].rename(columns={mtf_col: "mtf"}).join(
        nifty[[nifty_col]].rename(columns={nifty_col: "nifty"})
    ).dropna()

    # Add F&O OI if available
    fo_col = [c for c in margin.columns if "fo" in c or "oi" in c]
    if fo_col:
        data = data.join(margin[[fo_col[0]]].rename(columns={fo_col[0]: "fo_oi"}))

    util_col = [c for c in margin.columns if "utiliz" in c or "pct" in c]
    if util_col:
        data = data.join(margin[[util_col[0]]].rename(columns={util_col[0]: "margin_util_pct"}))

    # Z-score of leverage metrics
    mu = data["mtf"].rolling(ZSCORE_WINDOW).mean()
    sigma = data["mtf"].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
    data["mtf_z"] = (data["mtf"] - mu) / sigma

    if "fo_oi" in data.columns:
        fo_mu = data["fo_oi"].rolling(ZSCORE_WINDOW).mean()
        fo_sigma = data["fo_oi"].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
        data["fo_oi_z"] = (data["fo_oi"] - fo_mu) / fo_sigma
        data["composite_leverage_z"] = (data["mtf_z"].fillna(0) + data["fo_oi_z"].fillna(0)) / 2
    else:
        data["composite_leverage_z"] = data["mtf_z"]

    # Forward returns
    nifty_ret = data["nifty"].pct_change()
    data["nifty_fwd_5d"] = data["nifty"].pct_change(FORWARD_DAYS).shift(-FORWARD_DAYS) * 100

    # Contrarian signal: high leverage → sell (expect correction)
    data["signal"] = data["composite_leverage_z"].shift(1).apply(
        lambda z: -1.0 if z > HIGH_LEVERAGE_Z else (
            0.5 if z < LOW_LEVERAGE_Z else 0.0
        )
    )

    signal_records = []
    extreme_records = []

    for dt, row in data.iterrows():
        z = row["composite_leverage_z"]
        sig = row["signal"]

        rec = {
            "date": dt.date(),
            "mtf_outstanding_cr": float(row["mtf"]),
            "fo_oi_cr": float(row.get("fo_oi", np.nan)) if "fo_oi" in data.columns else None,
            "margin_util_pct": float(row.get("margin_util_pct", np.nan)) if "margin_util_pct" in data.columns else None,
            "leverage_z": float(z) if not np.isnan(z) else None,
            "signal": "short" if sig == -1 else ("mild_long" if sig == 0.5 else "flat"),
            "nifty_close": float(row["nifty"]),
        }
        signal_records.append(rec)

        if not np.isnan(z) and abs(z) > HIGH_LEVERAGE_Z:
            extreme_records.append({
                "date": dt.date(),
                "leverage_z": float(z),
                "direction": "over_leveraged" if z > 0 else "de_leveraged",
                "nifty_fwd_5d_pct": float(row["nifty_fwd_5d"]) if not np.isnan(row.get("nifty_fwd_5d", np.nan)) else None,
            })

    pd.DataFrame(signal_records).to_csv(os.path.join(cfg.outdir, "margin_signals.csv"), index=False)
    if extreme_records:
        pd.DataFrame(extreme_records).to_csv(os.path.join(cfg.outdir, "leverage_extremes.csv"), index=False)

    # Backtest
    pos = data["signal"].shift(1).fillna(0)
    strat_ret = (pos * nifty_ret).dropna()
    cum = (1 + strat_ret).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(252)) if strat_ret.std() > 0 else None

    # Leverage regime vs forward returns
    data_clean = data.dropna(subset=["composite_leverage_z", "nifty_fwd_5d"])
    if len(data_clean) >= 20:
        data_clean = data_clean.copy()
        data_clean["regime"] = data_clean["composite_leverage_z"].apply(
            lambda z: "high" if z > 1 else ("low" if z < -1 else "normal")
        )

    summary = {
        "avg_mtf_cr": float(data["mtf"].mean()),
        "pct_over_leveraged": float((data["composite_leverage_z"] > HIGH_LEVERAGE_Z).mean() * 100),
        "n_extreme_events": len(extreme_records),
        "ann_return": float(strat_ret.mean() * 252),
        "sharpe": sharpe,
        "params": {"high_leverage_z": HIGH_LEVERAGE_Z, "entry_z": ENTRY_Z_CONTRARIAN}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"NSE Margin Data | Avg MTF: ₹{summary['avg_mtf_cr']:.0f}cr | Over-leveraged: {summary['pct_over_leveraged']:.1f}% days | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--margin", required=True, dest="margin_file")
    ap.add_argument("--nifty", required=True, dest="nifty_file")
    ap.add_argument("--outdir", default="./artifacts/nse_margin")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
