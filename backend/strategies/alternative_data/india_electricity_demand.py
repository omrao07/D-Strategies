#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_electricity_demand.py — India electricity demand as economic/equity signal
=================================================================================
India electricity generation/consumption data (from NLDC/POSOCO/MoPNG) is a
high-frequency, real-time economic indicator. Electricity demand leads GDP by
1-2 months and tracks industrial production closely.

Signals:
  - Demand surge (>10% YoY) → positive for industrials, metals, cement
  - Demand slump → negative for industrial/infra stocks
  - Peak hour demand vs base → measure of economic confidence
  - State-wise demand → identify outperforming states → infra/construction stocks

India moat: Electricity is one of the few daily economic indicators in India.
No global macro fund tracks NLDC daily dispatch data systematically.

Inputs (CSV)
------------
--power     power.csv       date, energy_mus (MUs=million units), peak_mw, state (optional)
--stocks    stocks.csv      date, ticker, close
--gdp       gdp.csv         date, gdp_index (quarterly, optional)

Outputs
-------
outdir/power_signals.csv        date, demand_mu, yoy_pct, z_score, regime
outdir/sector_impact.csv        regime, sector, avg_fwd_return_pct
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd

# Industrial/power stocks basket
POWER_SENSITIVE_STOCKS = ["TATASTEEL", "JSPL", "HINDALCO", "VEDL", "ULTRACEMCO",
                           "AMBUJACEMENT", "NHPC", "NTPC", "POWERGRID", "TATAPOWER"]

DEMAND_SURGE_PCT = 10.0     # > 10% YoY growth = demand surge
DEMAND_SLUMP_PCT = -5.0     # < -5% YoY = slump
ZSCORE_WINDOW = 60
MA_WINDOW = 7               # 7-day rolling average (smooth daily noise)
FORWARD_DAYS = 10


def classify_regime(yoy: float) -> str:
    if pd.isna(yoy):
        return "unknown"
    if yoy > DEMAND_SURGE_PCT:
        return "surge"
    elif yoy > 5:
        return "strong"
    elif yoy > 0:
        return "moderate"
    elif yoy > DEMAND_SLUMP_PCT:
        return "weak"
    else:
        return "slump"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    power = pd.read_csv(cfg.power_file, parse_dates=["date"]).set_index("date").sort_index()
    power.columns = [c.lower().strip() for c in power.columns]
    demand_col = "energy_mus" if "energy_mus" in power.columns else power.columns[0]

    stocks = pd.read_csv(cfg.stocks_file, parse_dates=["date"])
    stocks.columns = [c.lower().strip() for c in stocks.columns]
    stocks_wide = stocks.pivot_table(index="date", columns="ticker", values="close").sort_index()
    stocks_wide.columns = [c.upper() for c in stocks_wide.columns]

    # Compute YoY and rolling stats
    power["demand_ma7"] = power[demand_col].rolling(MA_WINDOW).mean()
    power["demand_yoy_pct"] = power[demand_col].pct_change(252) * 100  # ~1 year
    power["demand_yoy_mom"] = power["demand_yoy_pct"].rolling(30).mean()  # 30d momentum of YoY

    mu = power[demand_col].rolling(ZSCORE_WINDOW).mean()
    sigma = power[demand_col].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
    power["z_score"] = (power[demand_col] - mu) / sigma

    power["regime"] = power["demand_yoy_pct"].apply(classify_regime)

    # Forward NIFTY return for regime analysis
    avail = [t for t in POWER_SENSITIVE_STOCKS if t in stocks_wide.columns]
    if avail:
        basket_ret = stocks_wide[avail].pct_change().mean(axis=1)
        basket_fwd = basket_ret.rolling(FORWARD_DAYS).sum().shift(-FORWARD_DAYS) * 100

    signal_records = []
    for dt, row in power.iterrows():
        z = row["z_score"]
        regime = row["regime"]
        yoy = row["demand_yoy_pct"]

        sig = "flat"
        if regime in ("surge", "strong") and z > 1.0:
            sig = "long_industrials"
        elif regime in ("slump", "weak") and z < -1.0:
            sig = "short_industrials"

        signal_records.append({
            "date": dt.date(),
            "demand_mu": float(row[demand_col]),
            "demand_ma7": float(row["demand_ma7"]) if not np.isnan(row["demand_ma7"]) else None,
            "yoy_pct": float(yoy) if not np.isnan(yoy) else None,
            "z_score": float(z) if not np.isnan(z) else None,
            "regime": regime,
            "signal": sig,
        })

    pd.DataFrame(signal_records).to_csv(os.path.join(cfg.outdir, "power_signals.csv"), index=False)

    # Regime vs sector returns
    if avail:
        sig_df = pd.DataFrame(signal_records)
        sig_df["date"] = pd.to_datetime(sig_df["date"])
        sig_df = sig_df.set_index("date")
        sig_df["fwd_return"] = basket_fwd.reindex(sig_df.index)

        regime_impact = sig_df.groupby("regime")["fwd_return"].agg(["mean", "std", "count"]).reset_index()
        regime_impact.columns = ["regime", "avg_fwd_return_pct", "std_pct", "n_obs"]
        regime_impact.to_csv(os.path.join(cfg.outdir, "sector_impact.csv"), index=False)

        # Backtest
        pos = sig_df["signal"].map({"long_industrials": 1, "short_industrials": -1, "flat": 0}).fillna(0)
        pos = pos.shift(1)
        strat_ret = (pos * basket_ret.reindex(pos.index)).dropna()
        cum = (1 + strat_ret).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(252)) if strat_ret.std() > 0 else None
    else:
        sharpe = None

    summary = {
        "avg_demand_mu": float(power[demand_col].mean()),
        "avg_yoy_pct": float(power["demand_yoy_pct"].dropna().mean()),
        "pct_surge_days": float((power["regime"] == "surge").mean() * 100),
        "pct_slump_days": float((power["regime"] == "slump").mean() * 100),
        "sharpe": sharpe,
        "params": {"surge_threshold": DEMAND_SURGE_PCT, "zscore_window": ZSCORE_WINDOW}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India Electricity Demand | Avg YoY: {summary['avg_yoy_pct']:.1f}% | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--power", required=True, dest="power_file")
    ap.add_argument("--stocks", required=True, dest="stocks_file")
    ap.add_argument("--gdp", default=None, dest="gdp_file")
    ap.add_argument("--outdir", default="./artifacts/india_electricity")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
