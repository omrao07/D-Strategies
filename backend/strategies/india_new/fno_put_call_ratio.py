#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fno_put_call_ratio.py — India F&O Put-Call Ratio sentiment indicator
=====================================================================
NSE F&O PCR > 1.2 → extreme bearishness → contrarian buy signal for Nifty.
PCR < 0.7 → extreme bullishness → contrarian sell. OI-weighted PCR is more
reliable than volume PCR. Tracks Nifty/BankNifty separately.

Inputs (CSV)
------------
--pcr      pcr_data.csv
    Columns: date, index (NIFTY/BANKNIFTY), pcr_oi, pcr_volume,
             put_oi, call_oi, put_volume, call_volume
--returns  index_returns.csv
    Columns: date, index, return

Outputs
-------
outdir/pcr_signals.csv      date, index, pcr_oi, pcr_volume, regime, signal
outdir/pcr_forward_returns.csv  PCR quintile vs forward return
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


PCR_EXTREME_HIGH = 1.3   # Bearish extreme → contrarian buy
PCR_EXTREME_LOW  = 0.75  # Bullish extreme → contrarian sell
PCR_HIGH = 1.1
PCR_LOW  = 0.85

INDEX_MAP = {"NIFTY": "nifty", "BANKNIFTY": "banknifty"}


def classify_pcr_regime(pcr: float) -> str:
    if pcr >= PCR_EXTREME_HIGH:
        return "extreme_fear"
    elif pcr >= PCR_HIGH:
        return "fear"
    elif pcr <= PCR_EXTREME_LOW:
        return "extreme_greed"
    elif pcr <= PCR_LOW:
        return "greed"
    else:
        return "neutral"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    pcr = pd.read_csv(cfg.pcr_file, parse_dates=["date"])
    pcr.columns = [c.lower().strip() for c in pcr.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="index", values="return").sort_index()

    signal_records = []
    for idx_name in pcr["index"].str.upper().unique():
        sub = pcr[pcr["index"].str.upper() == idx_name].set_index("date").sort_index()
        if sub.empty:
            continue

        pcr_oi_col = "pcr_oi" if "pcr_oi" in sub.columns else "pcr_volume"
        pcr_vol_col = "pcr_volume" if "pcr_volume" in sub.columns else pcr_oi_col

        sub["pcr_oi_ma5"] = sub[pcr_oi_col].rolling(5).mean()
        sub["pcr_oi_ma20"] = sub[pcr_oi_col].rolling(20).mean()
        sub["pcr_oi_zscore"] = (sub[pcr_oi_col] - sub[pcr_oi_col].rolling(60).mean()) / \
                                sub[pcr_oi_col].rolling(60).std().replace(0, np.nan)
        sub["pcr_trend"] = sub[pcr_oi_col] - sub["pcr_oi_ma5"]  # positive = rising fear

        for date, row in sub.iterrows():
            pcr_val = row.get(pcr_oi_col, np.nan)
            pcr_z = row.get("pcr_oi_zscore", np.nan)
            regime = classify_pcr_regime(pcr_val) if not np.isnan(pcr_val) else "unknown"

            if regime in ("extreme_fear",) or (not np.isnan(pcr_z) and pcr_z > 2.0):
                signal = "contrarian_buy"
            elif regime in ("extreme_greed",) or (not np.isnan(pcr_z) and pcr_z < -2.0):
                signal = "contrarian_sell"
            elif regime == "fear":
                signal = "mild_buy"
            elif regime == "greed":
                signal = "mild_sell"
            else:
                signal = "neutral"

            signal_records.append({
                "date": date, "index": idx_name,
                "pcr_oi": float(pcr_val) if not np.isnan(pcr_val) else None,
                "pcr_volume": float(row.get(pcr_vol_col, np.nan)) if not np.isnan(row.get(pcr_vol_col, np.nan)) else None,
                "pcr_oi_zscore": float(pcr_z) if not np.isnan(pcr_z) else None,
                "regime": regime, "signal": signal
            })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "pcr_signals.csv"), index=False)

    # Forward return analysis by PCR quintile
    fwd_records = []
    for idx_name in sig_df["index"].unique():
        sub_sig = sig_df[sig_df["index"] == idx_name].set_index("date")
        idx_col = idx_name.upper() if idx_name.upper() in ret_wide.columns else \
                  (idx_name.lower() if idx_name.lower() in ret_wide.columns else None)
        if idx_col is None:
            continue
        ret_series = ret_wide[idx_col].dropna()
        for fwd in [1, 5, 10]:
            fwd_ret = ret_series.rolling(fwd).sum().shift(-fwd)
            aligned = sub_sig["pcr_oi"].dropna().align(fwd_ret.dropna(), join="inner")
            if len(aligned[0]) < 20:
                continue
            df_a = pd.DataFrame({"pcr": aligned[0], "fwd": aligned[1]})
            df_a["quintile"] = pd.qcut(df_a["pcr"], q=5, labels=False, duplicates="drop")
            q_summary = df_a.groupby("quintile")["fwd"].mean().reset_index()
            q_summary["index"] = idx_name
            q_summary["fwd_days"] = fwd
            fwd_records.append(q_summary)

    if fwd_records:
        pd.concat(fwd_records).to_csv(os.path.join(cfg.outdir, "pcr_forward_returns.csv"), index=False)

    # Backtest
    all_daily = []
    SIG_POS = {"contrarian_buy": 1.5, "mild_buy": 0.5, "neutral": 0, "mild_sell": -0.5, "contrarian_sell": -1.5}
    for idx_name in sig_df["index"].unique():
        sub_sig = sig_df[sig_df["index"] == idx_name].set_index("date")["signal"].map(SIG_POS).fillna(0)
        idx_col = idx_name.upper() if idx_name.upper() in ret_wide.columns else \
                  (idx_name.lower() if idx_name.lower() in ret_wide.columns else None)
        if idx_col is None:
            continue
        ret_series = ret_wide[idx_col].dropna()
        pos_daily = sub_sig.reindex(ret_series.index, method="ffill").shift(1).fillna(0)
        all_daily.append((pos_daily * ret_series).rename(idx_name))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    latest = sig_df.groupby("index").last().reset_index()
    summary = {
        "indices_tracked": sig_df["index"].unique().tolist(),
        "latest_signals": latest[["index", "pcr_oi", "regime", "signal"]].to_dict(orient="records"),
        "n_contrarian_buy": int((sig_df["signal"] == "contrarian_buy").sum()),
        "n_contrarian_sell": int((sig_df["signal"] == "contrarian_sell").sum()),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"pcr_extreme_high": PCR_EXTREME_HIGH, "pcr_extreme_low": PCR_EXTREME_LOW}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"PCR | Indices: {summary['indices_tracked']} | Contrarian buys: {summary['n_contrarian_buy']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pcr", required=True, dest="pcr_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/fno_pcr")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
