#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sgx_gift_nifty_vs_nse.py — SGX/GIFT Nifty premium vs NSE Nifty arbitrage
==========================================================================
GIFT Nifty (formerly SGX Nifty) trades overnight and pre-market, reflecting
global risk sentiment. A large premium/discount to NSE close predicts NSE open
direction. Persistent divergence creates intraday mean-reversion opportunities.

Inputs (CSV)
------------
--gift     gift_nifty.csv
    Columns: date, time (optional), gift_close, gift_volume
--nse      nse_nifty.csv
    Columns: date, nse_close, nse_open (optional)
--global   global_indices.csv (optional)
    Columns: date, spx_return, vix, dxy_return

Outputs
-------
outdir/gift_nifty_signals.csv   date, gift_close, nse_close, premium_pct, signal
outdir/premium_vs_open.csv      premium vs NSE open gap analysis
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


PREMIUM_BUY_THRESHOLD = 0.3   # % premium → expect gap-up → buy ahead
PREMIUM_SELL_THRESHOLD = -0.3  # % discount → expect gap-down → short
EXTREME_FADE_THRESHOLD = 0.8   # % extreme → fade (overreaction)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    gift = pd.read_csv(cfg.gift_file, parse_dates=["date"])
    gift.columns = [c.lower().strip() for c in gift.columns]
    gift = gift.groupby("date").last().sort_index()  # last observation per day

    nse = pd.read_csv(cfg.nse_file, parse_dates=["date"])
    nse.columns = [c.lower().strip() for c in nse.columns]
    nse = nse.set_index("date").sort_index()

    gift_col = "gift_close" if "gift_close" in gift.columns else gift.columns[0]
    nse_col = "nse_close" if "nse_close" in nse.columns else nse.columns[0]

    merged = gift[[gift_col]].join(nse[[nse_col] + (["nse_open"] if "nse_open" in nse.columns else [])], how="inner")
    merged["premium_pct"] = (merged[gift_col] / merged[nse_col].shift(1) - 1) * 100
    merged["premium_zscore"] = (merged["premium_pct"] - merged["premium_pct"].rolling(20).mean()) / \
                                merged["premium_pct"].rolling(20).std().replace(0, np.nan)

    global_data = None
    if cfg.global_file:
        gdf = pd.read_csv(cfg.global_file, parse_dates=["date"])
        gdf.columns = [c.lower().strip() for c in gdf.columns]
        global_data = gdf.set_index("date").sort_index()
        if "vix" in global_data.columns:
            merged = merged.join(global_data[["vix"]], how="left")

    # Gap analysis: premium vs next-day open
    open_gap_records = []
    if "nse_open" in merged.columns:
        merged["open_gap_pct"] = (merged["nse_open"] / merged[nse_col].shift(1) - 1) * 100
        merged["premium_to_gap"] = merged["open_gap_pct"] - merged["premium_pct"].shift(1)
        for q in [5, 4, 3, 2, 1]:
            mask = pd.qcut(merged["premium_pct"].dropna(), q=5, labels=False, duplicates="drop")
            pass  # handled below

        df_corr = merged[["premium_pct", "open_gap_pct"]].dropna()
        if len(df_corr) > 10:
            r, p = stats.pearsonr(df_corr["premium_pct"].values, df_corr["open_gap_pct"].values)
            open_gap_records.append({"metric": "premium_vs_open_gap", "correlation": float(r), "pvalue": float(p), "n": len(df_corr)})

        # Quintile analysis
        df_corr["prem_q"] = pd.qcut(df_corr["premium_pct"], q=5, labels=False, duplicates="drop")
        q_ret = df_corr.groupby("prem_q")["open_gap_pct"].mean().reset_index()
        q_ret.columns = ["quintile", "avg_open_gap_pct"]
        open_gap_records += q_ret.to_dict(orient="records")

    if open_gap_records:
        pd.DataFrame(open_gap_records).to_csv(os.path.join(cfg.outdir, "premium_vs_open.csv"), index=False)

    signal_records = []
    for date, row in merged.iterrows():
        prem = row.get("premium_pct", np.nan)
        prem_z = row.get("premium_zscore", np.nan)
        vix = row.get("vix", np.nan)
        high_vix = not np.isnan(vix) and vix > 25

        if np.isnan(prem):
            signal = "no_data"
        elif prem >= EXTREME_FADE_THRESHOLD and not high_vix:
            signal = "fade_gap_up"  # extreme premium may not fully close
        elif prem <= -EXTREME_FADE_THRESHOLD and not high_vix:
            signal = "fade_gap_down"
        elif prem >= PREMIUM_BUY_THRESHOLD:
            signal = "follow_gap_up"
        elif prem <= PREMIUM_SELL_THRESHOLD:
            signal = "follow_gap_down"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date,
            "gift_close": float(row[gift_col]),
            "nse_prev_close": float(row[nse_col]),
            "premium_pct": float(prem) if not np.isnan(prem) else None,
            "premium_zscore": float(prem_z) if not np.isnan(prem_z) else None,
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "gift_nifty_signals.csv"), index=False)

    # Backtest: follow signals on NSE returns
    nse_ret = merged[nse_col].pct_change().dropna()
    SIG_POS = {"follow_gap_up": 1, "fade_gap_up": -0.5, "neutral": 0,
               "fade_gap_down": 0.5, "follow_gap_down": -1}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    pos_daily = pos.reindex(nse_ret.index).ffill().shift(1).fillna(0)
    port = (pos_daily * nse_ret).dropna()
    cum = (1 + port).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
    sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None

    summary = {
        "avg_premium_pct": float(merged["premium_pct"].mean()) if "premium_pct" in merged else None,
        "premium_std_pct": float(merged["premium_pct"].std()) if "premium_pct" in merged else None,
        "n_gap_up_days": int((sig_df["signal"].str.contains("gap_up")).sum()),
        "n_gap_down_days": int((sig_df["signal"].str.contains("gap_down")).sum()),
        "ann_return": float(port.mean() * 252), "sharpe": sharpe,
        "params": {"buy_threshold": PREMIUM_BUY_THRESHOLD, "sell_threshold": PREMIUM_SELL_THRESHOLD}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"GIFT Nifty | Avg premium: {summary['avg_premium_pct']:.2f}% | Gap-ups: {summary['n_gap_up_days']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gift", required=True, dest="gift_file")
    ap.add_argument("--nse", required=True, dest="nse_file")
    ap.add_argument("--global", default=None, dest="global_file")
    ap.add_argument("--outdir", default="./artifacts/gift_nifty")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
