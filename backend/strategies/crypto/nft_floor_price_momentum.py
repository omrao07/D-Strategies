#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nft_floor_price_momentum.py — NFT collection floor price momentum trades
=========================================================================
NFT floor prices exhibit strong momentum within bull cycles and cascade
reversals in bear cycles. Rising floor + rising volume = confirmation.
Floor divergence from volume = distribution (smart money exiting).

Inputs (CSV)
------------
--nft     nft_floors.csv
    Columns: date, collection, floor_eth, volume_eth, sales_count,
             unique_buyers, listed_count
--eth     eth_prices.csv
    Columns: date, price

Outputs
-------
outdir/nft_momentum.csv         date, collection, momentum_score, signal
outdir/collection_stats.csv     per-collection performance summary
outdir/backtest.csv             cumulative P&L in ETH terms
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def compute_nft_score(sub: pd.DataFrame) -> pd.DataFrame:
    """Floor + volume momentum composite."""
    sub = sub.copy()
    sub["floor_mom7"] = sub["floor_eth"].pct_change(7)
    sub["floor_mom30"] = sub["floor_eth"].pct_change(30)
    sub["vol_mom7"] = sub["volume_eth"].pct_change(7) if "volume_eth" in sub.columns else 0
    sub["floor_zscore"] = (sub["floor_eth"] - sub["floor_eth"].rolling(30).mean()) / \
                           sub["floor_eth"].rolling(30).std().replace(0, np.nan)
    sub["vol_zscore"] = (sub["volume_eth"] - sub["volume_eth"].rolling(30).mean()) / \
                         sub["volume_eth"].rolling(30).std().replace(0, np.nan) if "volume_eth" in sub.columns else 0

    # Divergence: floor rising but volume falling → distribution
    sub["divergence"] = sub["floor_mom7"].fillna(0) - sub["vol_mom7"].fillna(0)

    # Composite: floor z + volume z - divergence penalty
    sub["momentum_score"] = (0.5 * sub["floor_zscore"].fillna(0) +
                              0.3 * sub["vol_zscore"] if isinstance(sub["vol_zscore"], pd.Series) else 0 +
                              -0.2 * sub["divergence"].clip(-3, 3))
    return sub


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    nft = pd.read_csv(cfg.nft_file, parse_dates=["date"])
    nft.columns = [c.lower().strip() for c in nft.columns]
    eth = pd.read_csv(cfg.eth_file, parse_dates=["date"])
    eth.columns = [c.lower().strip() for c in eth.columns]
    eth = eth.set_index("date")["price"].sort_index()

    nft_records = []
    coll_stats = []
    all_eth_pnl = []

    for collection in nft["collection"].unique():
        sub = nft[nft["collection"] == collection].set_index("date").sort_index()
        if len(sub) < 20:
            continue

        sub = compute_nft_score(sub)

        for date, row in sub.iterrows():
            score = row.get("momentum_score", np.nan)
            if np.isnan(score):
                signal = "neutral"
            elif score > cfg.buy_threshold:
                signal = "buy"
            elif score < -cfg.sell_threshold:
                signal = "sell"
            else:
                signal = "neutral"

            nft_records.append({
                "date": date, "collection": collection,
                "floor_eth": float(row["floor_eth"]),
                "volume_eth": float(row["volume_eth"]) if "volume_eth" in row else None,
                "floor_mom7": float(row["floor_mom7"]) if not np.isnan(row.get("floor_mom7", np.nan)) else None,
                "momentum_score": float(score) if not np.isnan(score) else None,
                "divergence": float(row.get("divergence", 0)),
                "signal": signal
            })

        # Collection-level stats
        buy_dates = sub[sub["momentum_score"].fillna(0) > cfg.buy_threshold].index
        fwd_floor = sub["floor_eth"].shift(-14)
        fwd_ret = fwd_floor / sub["floor_eth"] - 1
        buy_fwd = fwd_ret.reindex(buy_dates).dropna()
        coll_stats.append({
            "collection": collection, "n_observations": len(sub),
            "avg_floor_eth": float(sub["floor_eth"].mean()),
            "max_floor_eth": float(sub["floor_eth"].max()),
            "buy_signal_fwd14d_ret": float(buy_fwd.mean()) if len(buy_fwd) > 0 else None,
            "buy_signal_win_rate": float((buy_fwd > 0).mean()) if len(buy_fwd) > 0 else None
        })

        # P&L in ETH: buy floor, hold, sell
        pos = sub["momentum_score"].fillna(0).apply(lambda s: 1 if s > cfg.buy_threshold else (-1 if s < -cfg.sell_threshold else 0))
        floor_ret = sub["floor_eth"].pct_change()
        strat_eth = pos.shift(1) * floor_ret
        all_eth_pnl.append(strat_eth.rename(collection))

    nft_df = pd.DataFrame(nft_records).sort_values("date")
    nft_df.to_csv(os.path.join(cfg.outdir, "nft_momentum.csv"), index=False)

    coll_df = pd.DataFrame(coll_stats)
    if not coll_df.empty:
        coll_df.to_csv(os.path.join(cfg.outdir, "collection_stats.csv"), index=False)

    if all_eth_pnl:
        port = pd.concat(all_eth_pnl, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative_eth").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(365)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 365)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_collections": nft["collection"].nunique(), "n_signals": len(nft_df),
        "n_buy": int((nft_df["signal"] == "buy").sum()) if not nft_df.empty else 0,
        "avg_buy_fwd14d": float(coll_df["buy_signal_fwd14d_ret"].dropna().mean()) if not coll_df.empty else None,
        "ann_return_eth": ann_ret, "sharpe": sharpe,
        "params": {"buy_threshold": cfg.buy_threshold, "sell_threshold": cfg.sell_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"NFT floor momentum | Collections: {summary['n_collections']} | Buy signals: {summary['n_buy']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nft", required=True, dest="nft_file")
    ap.add_argument("--eth", required=True, dest="eth_file")
    ap.add_argument("--buy-threshold", type=float, default=1.0)
    ap.add_argument("--sell-threshold", type=float, default=1.0)
    ap.add_argument("--outdir", default="./artifacts/nft_momentum")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
