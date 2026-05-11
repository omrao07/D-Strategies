#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
liquidation_cascade_detector.py — Large liquidations signal capitulation bottoms
==================================================================================
Mass liquidation events (>$500M in 24h) historically mark short-term bottoms
as forced selling exhausts. The strategy detects liquidation spikes, classifies
whether they are long or short liquidations, and times the reversal entry.

Inputs (CSV)
------------
--liquidations  liquidations.csv
    Columns: date, asset, long_liq_usd, short_liq_usd, total_liq_usd, exchange
--prices        crypto_prices.csv
    Columns: date, ticker, price

Outputs
-------
outdir/liq_events.csv           date, asset, total_liq_usd, liq_zscore, event_type, signal
outdir/cascade_analysis.csv     post-cascade forward returns by size quintile
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def classify_cascade(row: pd.Series) -> str:
    long_liq = row.get("long_liq_usd", 0) or 0
    short_liq = row.get("short_liq_usd", 0) or 0
    total = long_liq + short_liq
    if total == 0:
        return "none"
    ratio = long_liq / total
    if ratio > 0.75:
        return "long_cascade"    # Longs wiped → potential bottom
    elif ratio < 0.25:
        return "short_cascade"   # Shorts wiped → potential top
    return "mixed_cascade"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    liqs = pd.read_csv(cfg.liquidations_file, parse_dates=["date"])
    liqs.columns = [c.lower().strip() for c in liqs.columns]
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]
    price_wide = prices.pivot(index="date", columns="ticker", values="price").sort_index()

    # Aggregate across exchanges
    if "exchange" in liqs.columns:
        agg = liqs.groupby(["date", "asset"]).agg(
            total_liq_usd=("total_liq_usd", "sum"),
            long_liq_usd=("long_liq_usd", "sum"),
            short_liq_usd=("short_liq_usd", "sum")
        ).reset_index()
    else:
        agg = liqs.copy()

    liq_records = []
    cascade_records = []
    all_daily = []

    for asset in agg["asset"].unique():
        sub = agg[agg["asset"] == asset].set_index("date").sort_index()
        if len(sub) < 14:
            continue

        sub["liq_ma7"] = sub["total_liq_usd"].rolling(7).mean()
        sub["liq_zscore"] = (sub["total_liq_usd"] - sub["total_liq_usd"].rolling(30).mean()) / \
                             sub["total_liq_usd"].rolling(30).std().replace(0, np.nan)
        sub["cascade_type"] = sub.apply(classify_cascade, axis=1)
        sub["is_cascade"] = sub["liq_zscore"] > cfg.cascade_zscore

        price_ticker = asset.upper()
        has_price = price_ticker in price_wide.columns
        price_series = price_wide[price_ticker] if has_price else None

        for date, row in sub.iterrows():
            z = row.get("liq_zscore", np.nan)
            ctype = row["cascade_type"]
            is_cascade = row["is_cascade"]

            if is_cascade and ctype == "long_cascade":
                signal = "buy_bottom_long_cascade"
            elif is_cascade and ctype == "short_cascade":
                signal = "sell_top_short_cascade"
            elif is_cascade:
                signal = "caution_mixed_cascade"
            else:
                signal = "neutral"

            liq_records.append({
                "date": date, "asset": asset,
                "total_liq_usd": float(row["total_liq_usd"]),
                "long_liq_usd": float(row.get("long_liq_usd", 0)),
                "short_liq_usd": float(row.get("short_liq_usd", 0)),
                "liq_zscore": float(z) if not np.isnan(z) else None,
                "cascade_type": ctype, "signal": signal
            })

            # Post-cascade forward return analysis
            if is_cascade and has_price and date in price_series.index:
                for fwd_days in [1, 3, 7, 14]:
                    future_idx = price_series.index.searchsorted(date) + fwd_days
                    if future_idx < len(price_series):
                        fwd_ret = price_series.iloc[future_idx] / price_series.loc[date] - 1
                        cascade_records.append({
                            "date": date, "asset": asset, "cascade_type": ctype,
                            "total_liq_usd": float(row["total_liq_usd"]),
                            "liq_zscore": float(z) if not np.isnan(z) else None,
                            "hold_days": fwd_days, "fwd_return": float(fwd_ret)
                        })

        if not has_price:
            continue

        ret = price_series.pct_change().dropna()
        pos = sub.apply(
            lambda r: 1 if r["is_cascade"] and r["cascade_type"] == "long_cascade"
                      else (-1 if r["is_cascade"] and r["cascade_type"] == "short_cascade" else 0), axis=1
        )
        pos_daily = pos.reindex(ret.index).ffill().shift(1)
        strat = pos_daily * ret
        all_daily.append(strat.rename(asset))

    liq_df = pd.DataFrame(liq_records).sort_values("date")
    liq_df.to_csv(os.path.join(cfg.outdir, "liq_events.csv"), index=False)

    casc_df = pd.DataFrame(cascade_records).sort_values(["hold_days", "date"]) if cascade_records else pd.DataFrame()
    if not casc_df.empty:
        casc_df.to_csv(os.path.join(cfg.outdir, "cascade_analysis.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(365)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 365)
    else:
        sharpe, ann_ret = None, None

    long_casc_fwd = casc_df[(casc_df["cascade_type"] == "long_cascade") & (casc_df["hold_days"] == 7)]["fwd_return"].dropna() if not casc_df.empty else pd.Series()
    summary = {
        "n_assets": agg["asset"].nunique(), "n_cascade_events": int((liq_df["signal"] != "neutral").sum()) if not liq_df.empty else 0,
        "avg_fwd7d_long_cascade": float(long_casc_fwd.mean()) if len(long_casc_fwd) > 0 else None,
        "win_rate_7d_long_cascade": float((long_casc_fwd > 0).mean()) if len(long_casc_fwd) > 0 else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"cascade_zscore": cfg.cascade_zscore}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Liquidation cascades | Events: {summary['n_cascade_events']} | Long-casc 7d win rate: {summary['win_rate_7d_long_cascade']:.1%} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--liquidations", required=True, dest="liquidations_file")
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--cascade-zscore", type=float, default=2.5)
    ap.add_argument("--outdir", default="./artifacts/liquidation_cascade")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
