#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pcr_vol_regime.py — NSE Put/Call Ratio as volatility regime detector
=====================================================================
The NSE Put/Call Ratio (PCR-OI) reflects the ratio of put open interest to call
open interest. Extreme PCR readings signal sentiment extremes:
  - PCR > 1.5: too many puts → contrarian BULLISH (fear capitulation)
  - PCR < 0.7: too many calls → contrarian BEARISH (complacency)
  - PCR near 1.0: balanced → trend-following regime

Unlike CBOE PCR, NSE PCR includes significant retail hedging activity and
weekly options churn, making extreme readings more reliable contrarian signals.

Inputs (CSV)
------------
--pcr       pcr.csv         date, pcr_oi, pcr_volume (optional)
--nifty     nifty.csv       date, nifty_close
--ivix      ivix.csv        date, ivix_close (optional)

Outputs
-------
outdir/pcr_signals.csv      date, pcr_oi, pcr_ma, pcr_z, signal, regime
outdir/pcr_backtest.csv     date, signal, nifty_return, strategy_return
outdir/regime_stats.csv     pcr_regime, avg_fwd_5d_return, win_rate, n_obs
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

PCR_BULLISH = 1.4    # PCR > 1.4: extreme fear, contrarian buy
PCR_BEARISH = 0.75   # PCR < 0.75: complacency, contrarian sell
PCR_NEUTRAL_HIGH = 1.2
PCR_NEUTRAL_LOW = 0.9
PCR_MA_SHORT = 5
PCR_MA_LONG = 20
ZSCORE_WINDOW = 60


def classify_pcr_regime(pcr: float, pcr_z: float) -> str:
    if pd.isna(pcr) or pd.isna(pcr_z):
        return "unknown"
    if pcr > PCR_BULLISH:
        return "extreme_fear"  # Contrarian bullish
    elif pcr > PCR_NEUTRAL_HIGH:
        return "fear"
    elif pcr < PCR_BEARISH:
        return "extreme_complacency"  # Contrarian bearish
    elif pcr < PCR_NEUTRAL_LOW:
        return "complacency"
    else:
        return "neutral"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    pcr_df = pd.read_csv(cfg.pcr_file, parse_dates=["date"]).set_index("date").sort_index()
    pcr_df.columns = [c.lower().strip() for c in pcr_df.columns]
    pcr_col = "pcr_oi" if "pcr_oi" in pcr_df.columns else pcr_df.columns[0]

    nifty = pd.read_csv(cfg.nifty_file, parse_dates=["date"]).set_index("date").sort_index()
    nifty.columns = [c.lower().strip() for c in nifty.columns]
    nifty_col = nifty.columns[0]

    data = pcr_df[[pcr_col]].rename(columns={pcr_col: "pcr"}).join(
        nifty[[nifty_col]].rename(columns={nifty_col: "nifty"})
    ).dropna()

    if cfg.ivix_file and os.path.exists(cfg.ivix_file):
        ivix = pd.read_csv(cfg.ivix_file, parse_dates=["date"]).set_index("date").sort_index()
        ivix.columns = [c.lower().strip() for c in ivix.columns]
        ivix_col = ivix.columns[0]
        data = data.join(ivix[[ivix_col]].rename(columns={ivix_col: "ivix"}))

    # PCR rolling stats
    data["pcr_ma5"] = data["pcr"].rolling(PCR_MA_SHORT).mean()
    data["pcr_ma20"] = data["pcr"].rolling(PCR_MA_LONG).mean()
    data["pcr_std"] = data["pcr"].rolling(ZSCORE_WINDOW).std()
    data["pcr_z"] = (data["pcr"] - data["pcr"].rolling(ZSCORE_WINDOW).mean()) / data["pcr_std"].replace(0, np.nan)
    data["pcr_momentum"] = data["pcr"] - data["pcr"].shift(5)  # 5-day PCR change

    # Regime classification
    data["regime"] = data.apply(
        lambda r: classify_pcr_regime(r["pcr"], r["pcr_z"]), axis=1
    )

    # Forward NIFTY returns
    nifty_ret = data["nifty"].pct_change()
    data["nifty_fwd_5d"] = data["nifty"].pct_change(5).shift(-5) * 100

    # Signal: contrarian regime signal
    def pcr_signal(row) -> float:
        regime = row["regime"]
        pcr_z = row["pcr_z"]
        if pd.isna(pcr_z):
            return 0.0
        if regime == "extreme_fear":
            return 1.0    # Contrarian long
        elif regime == "fear" and pcr_z > 1.5:
            return 0.5    # Mild long
        elif regime == "extreme_complacency":
            return -1.0   # Contrarian short
        elif regime == "complacency" and pcr_z < -1.5:
            return -0.5   # Mild short
        return 0.0

    data["signal"] = data.apply(pcr_signal, axis=1)
    pos = data["signal"].shift(1).fillna(0)
    strat_ret = pos * nifty_ret
    strat_ret = strat_ret.dropna()

    cum = (1 + strat_ret).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "pcr_backtest.csv"))

    # PCR signal records
    records = []
    for dt, row in data.iterrows():
        records.append({
            "date": dt.date(),
            "pcr_oi": float(row["pcr"]),
            "pcr_ma5": float(row["pcr_ma5"]) if not np.isnan(row["pcr_ma5"]) else None,
            "pcr_ma20": float(row["pcr_ma20"]) if not np.isnan(row["pcr_ma20"]) else None,
            "pcr_z_score": float(row["pcr_z"]) if not np.isnan(row["pcr_z"]) else None,
            "ivix": float(row["ivix"]) if "ivix" in row and not np.isnan(row.get("ivix", np.nan)) else None,
            "regime": row["regime"],
            "signal": float(row["signal"]),
            "nifty": float(row["nifty"]),
        })
    pd.DataFrame(records).to_csv(os.path.join(cfg.outdir, "pcr_signals.csv"), index=False)

    # Regime performance stats
    regime_stats = data.dropna(subset=["regime", "nifty_fwd_5d"]).groupby("regime").apply(
        lambda g: pd.Series({
            "avg_fwd_5d_pct": float(g["nifty_fwd_5d"].mean()),
            "win_rate": float((g["nifty_fwd_5d"] > 0).mean()),
            "n_obs": len(g),
        })
    ).reset_index()
    regime_stats.to_csv(os.path.join(cfg.outdir, "regime_stats.csv"), index=False)

    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(252)) if strat_ret.std() > 0 else None
    summary = {
        "avg_pcr": float(data["pcr"].mean()),
        "pct_extreme_fear": float((data["regime"] == "extreme_fear").mean() * 100),
        "pct_extreme_complacency": float((data["regime"] == "extreme_complacency").mean() * 100),
        "n_trade_days": int((data["signal"] != 0).sum()),
        "ann_return": float(strat_ret.mean() * 252),
        "sharpe": sharpe,
        "params": {"pcr_bullish": PCR_BULLISH, "pcr_bearish": PCR_BEARISH, "zscore_window": ZSCORE_WINDOW}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"NSE PCR Regime | Avg PCR: {summary['avg_pcr']:.2f} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pcr", required=True, dest="pcr_file")
    ap.add_argument("--nifty", required=True, dest="nifty_file")
    ap.add_argument("--ivix", default=None, dest="ivix_file")
    ap.add_argument("--outdir", default="./artifacts/pcr_vol_regime")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
