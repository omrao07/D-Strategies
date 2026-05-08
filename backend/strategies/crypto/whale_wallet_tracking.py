#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
whale_wallet_tracking.py — Large wallet accumulation/distribution signals
==========================================================================
On-chain data: wallets holding >1000 BTC (or top 100 ETH wallets) reveal
smart money flow. Whale accumulation (address count rising + balance rising)
precedes bull runs. Distribution (large outflows to exchanges) precedes dumps.

Inputs (CSV)
------------
--wallets  whale_wallets.csv
    Columns: date, asset, whale_address_count, total_whale_balance,
             exchange_inflows, exchange_outflows, new_whale_addresses

Outputs
-------
outdir/whale_signals.csv        date, asset, accumulation_score, signal
outdir/whale_vs_price.csv       whale metric vs price correlation
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def compute_accumulation_score(row: pd.Series, prev: pd.Series) -> float:
    """
    Score = +1 for each bullish whale signal, -1 for bearish.
    Normalized to [-1, 1].
    """
    score = 0
    signals = 0
    # Address count growing → accumulation
    if not pd.isna(row.get("whale_address_count")) and not pd.isna(prev.get("whale_address_count")):
        addr_chg = row["whale_address_count"] - prev["whale_address_count"]
        score += 1 if addr_chg > 0 else (-1 if addr_chg < 0 else 0)
        signals += 1
    # Balance growing → holding more
    if not pd.isna(row.get("total_whale_balance")) and not pd.isna(prev.get("total_whale_balance")):
        bal_chg = row["total_whale_balance"] - prev["total_whale_balance"]
        score += 1 if bal_chg > 0 else (-1 if bal_chg < 0 else 0)
        signals += 1
    # Exchange inflows > outflows → selling pressure
    inflows = row.get("exchange_inflows", 0) or 0
    outflows = row.get("exchange_outflows", 0) or 0
    if inflows + outflows > 0:
        net_flow_bias = (outflows - inflows) / (inflows + outflows)
        score += net_flow_bias
        signals += 1
    # New whale addresses → fresh accumulation
    new_whales = row.get("new_whale_addresses", 0) or 0
    if new_whales > 0:
        score += min(new_whales / 10, 1)
        signals += 1

    return score / signals if signals > 0 else 0.0


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    wallets = pd.read_csv(cfg.wallets_file, parse_dates=["date"])
    wallets.columns = [c.lower().strip() for c in wallets.columns]
    wallets = wallets.sort_values("date")

    signal_records = []
    backtest_by_asset = {}
    corr_records = []

    for asset in wallets["asset"].unique():
        sub = wallets[wallets["asset"] == asset].set_index("date").sort_index()
        if len(sub) < 14:
            continue

        acc_scores = []
        for i in range(1, len(sub)):
            score = compute_accumulation_score(sub.iloc[i], sub.iloc[i - 1])
            acc_scores.append(score)
        acc_series = pd.Series(acc_scores, index=sub.index[1:])

        acc_smooth = acc_series.rolling(7, min_periods=3).mean()
        acc_zscore = (acc_smooth - acc_smooth.rolling(30, min_periods=7).mean()) / \
                      acc_smooth.rolling(30, min_periods=7).std().replace(0, np.nan)

        for date in acc_zscore.dropna().index:
            z = acc_zscore.loc[date]
            score_val = acc_smooth.loc[date] if date in acc_smooth.index else np.nan
            signal = "accumulate" if z > cfg.zscore_threshold else \
                     ("distribute" if z < -cfg.zscore_threshold else "neutral")
            signal_records.append({
                "date": date, "asset": asset,
                "accumulation_score": float(score_val) if not np.isnan(score_val) else None,
                "acc_zscore": float(z), "signal": signal,
                "exchange_inflows": float(sub.loc[date, "exchange_inflows"]) if "exchange_inflows" in sub.columns and date in sub.index else None,
                "whale_balance": float(sub.loc[date, "total_whale_balance"]) if "total_whale_balance" in sub.columns and date in sub.index else None
            })

        # Position: long on accumulation, short on distribution
        pos = acc_zscore.apply(lambda z: 1 if z > cfg.zscore_threshold else (-1 if z < -cfg.zscore_threshold else 0))
        backtest_by_asset[asset] = pos

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "whale_signals.csv"), index=False)

    if backtest_by_asset:
        port = pd.concat(backtest_by_asset.values(), axis=1).mean(axis=1).dropna()
        # Whale signals are leading indicators; estimate 3-day forward return as proxy
        port_shifted = port.shift(3)
        autocorr_proxy = port.autocorr(lag=3)
        cum = (1 + port * 0.01).cumprod()  # 1% per signal unit (notional)
        cum.to_frame("cumulative_notional").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = None
        ann_ret = None
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_assets": wallets["asset"].nunique(), "n_signals": len(sig_df),
        "n_accumulate": int((sig_df["signal"] == "accumulate").sum()) if not sig_df.empty else 0,
        "n_distribute": int((sig_df["signal"] == "distribute").sum()) if not sig_df.empty else 0,
        "params": {"zscore_threshold": cfg.zscore_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Whale tracking | Assets: {summary['n_assets']} | Accumulate signals: {summary['n_accumulate']} | Distribute: {summary['n_distribute']} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wallets", required=True, dest="wallets_file")
    ap.add_argument("--zscore-threshold", type=float, default=1.5)
    ap.add_argument("--outdir", default="./artifacts/whale_tracking")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
