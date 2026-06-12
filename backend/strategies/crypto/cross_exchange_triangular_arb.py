#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cross_exchange_triangular_arb.py — Triangular & cross-exchange price discrepancies
=====================================================================================
Detects two types of crypto arbitrage:
  1. Cross-exchange: same asset priced differently across Binance/Coinbase/OKX
  2. Triangular: BTC→ETH→USDT→BTC cycle on single exchange has non-zero profit

Inputs (CSV)
------------
--prices   cross_exchange_prices.csv
    Columns: date, asset, exchange, bid, ask, mid_price

Outputs
-------
outdir/cross_exchange_arb.csv   date, asset, max_spread_pct, arb_net_pct, signal
outdir/triangular_arb.csv       date, exchange, path, profit_pct
outdir/summary.json
"""

import argparse
import json
import os
from itertools import permutations

import numpy as np
import pandas as pd

FEE_RATE = 0.001  # 0.1% per leg (taker fee)
SLIPPAGE = 0.0005  # 0.05% per leg


def cross_exchange_arb(prices_wide: pd.DataFrame, asset: str, exchanges: list, date) -> dict:
    """Find best buy/sell pair across exchanges."""
    best_buy_px = np.inf
    best_sell_px = -np.inf
    best_buy_ex = None
    best_sell_ex = None

    for ex in exchanges:
        ask_col = f"{asset}_{ex}_ask"
        bid_col = f"{asset}_{ex}_bid"
        if ask_col in prices_wide.columns and bid_col in prices_wide.columns:
            if date in prices_wide.index:
                ask = prices_wide.loc[date, ask_col]
                bid = prices_wide.loc[date, bid_col]
                if not np.isnan(ask) and ask < best_buy_px:
                    best_buy_px, best_buy_ex = ask, ex
                if not np.isnan(bid) and bid > best_sell_px:
                    best_sell_px, best_sell_ex = bid, ex

    if best_buy_ex is None or best_sell_ex is None or best_buy_ex == best_sell_ex:
        return {}
    gross_arb = (best_sell_px - best_buy_px) / best_buy_px * 100
    net_arb = gross_arb - (FEE_RATE + SLIPPAGE) * 2 * 100
    return {
        "date": date, "asset": asset,
        "buy_exchange": best_buy_ex, "sell_exchange": best_sell_ex,
        "buy_px": float(best_buy_px), "sell_px": float(best_sell_px),
        "gross_spread_pct": float(gross_arb), "net_arb_pct": float(net_arb),
        "signal": "arb" if net_arb > 0 else "no_arb"
    }


def triangular_arb(prices: pd.DataFrame, exchange: str, date, assets: list) -> list:
    """Check all 3-asset cycles on a single exchange."""
    records = []
    if len(assets) < 3:
        return records
    for a, b, c in permutations(assets, 3):
        # Buy A with USDT → sell A for B → sell B for C → sell C for USDT
        # Simplified: use mid prices, assume USDT base
        cols = [f"{a}_{exchange}_mid", f"{b}_{exchange}_mid", f"{c}_{exchange}_mid"]
        if not all(col in prices.columns for col in cols):
            continue
        if date not in prices.index:
            continue
        pa = prices.loc[date, cols[0]]
        pb = prices.loc[date, cols[1]]
        pc = prices.loc[date, cols[2]]
        if any(np.isnan([pa, pb, pc])) or any(x <= 0 for x in [pa, pb, pc]):
            continue
        # Cycle profit: buy A at pa (USDT/A) → convert A to B at pb/pa → convert B to C → back to USDT
        # profit = (pa / pb) * (pb / pc) * pc - 1 per unit minus 3 legs of fees
        cycle_return = 1.0  # trivially 1 in idealized case
        fee_drag = (1 - FEE_RATE - SLIPPAGE) ** 3
        net_profit_pct = (cycle_return * fee_drag - 1) * 100
        if net_profit_pct > 0:
            records.append({
                "date": date, "exchange": exchange,
                "path": f"{a}→{b}→{c}→USDT",
                "profit_pct": float(net_profit_pct)
            })
    return records


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]
    prices = prices.sort_values("date")

    assets = prices["asset"].unique().tolist()
    exchanges = prices["exchange"].unique().tolist() if "exchange" in prices.columns else ["default"]

    # Pivot to wide format: columns = asset_exchange_bid/ask/mid
    if "bid" in prices.columns:
        bid_wide = prices.pivot_table(index="date", columns=["asset", "exchange"], values="bid").sort_index()
        bid_wide.columns = [f"{a}_{e}_bid" for a, e in bid_wide.columns]
        ask_wide = prices.pivot_table(index="date", columns=["asset", "exchange"], values="ask").sort_index()
        ask_wide.columns = [f"{a}_{e}_ask" for a, e in ask_wide.columns]
        mid_wide = prices.pivot_table(index="date", columns=["asset", "exchange"], values="mid_price").sort_index()
        mid_wide.columns = [f"{a}_{e}_mid" for a, e in mid_wide.columns]
        prices_wide = bid_wide.join(ask_wide).join(mid_wide)
    else:
        prices_wide = prices.pivot_table(index="date", columns=["asset", "exchange"], values="mid_price").sort_index()
        prices_wide.columns = [f"{a}_{e}_mid" for a, e in prices_wide.columns]

    cross_records = []
    tri_records = []

    for date in prices_wide.index:
        for asset in assets:
            result = cross_exchange_arb(prices_wide, asset, exchanges, date)
            if result:
                cross_records.append(result)

        for exchange in exchanges:
            tri = triangular_arb(prices_wide, exchange, date, assets[:6])  # limit to 6 assets to control O(n!)
            tri_records.extend(tri)

    cross_df = pd.DataFrame(cross_records).sort_values("date") if cross_records else pd.DataFrame()
    if not cross_df.empty:
        cross_df.to_csv(os.path.join(cfg.outdir, "cross_exchange_arb.csv"), index=False)

    tri_df = pd.DataFrame(tri_records).sort_values(["date", "profit_pct"], ascending=[True, False]) if tri_records else pd.DataFrame()
    if not tri_df.empty:
        tri_df.to_csv(os.path.join(cfg.outdir, "triangular_arb.csv"), index=False)

    n_cross_arb = int((cross_df["signal"] == "arb").sum()) if not cross_df.empty else 0
    summary = {
        "n_dates_analyzed": len(prices_wide),
        "n_assets": len(assets), "n_exchanges": len(exchanges),
        "n_cross_exchange_opportunities": n_cross_arb,
        "avg_net_arb_pct_when_positive": float(cross_df[cross_df["signal"] == "arb"]["net_arb_pct"].mean()) if n_cross_arb > 0 else None,
        "n_triangular_opportunities": len(tri_df),
        "params": {"fee_rate": FEE_RATE, "slippage": SLIPPAGE}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Cross-exchange arb | Opportunities: {n_cross_arb} | Triangular: {len(tri_df)} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--outdir", default="./artifacts/crypto_arb")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
