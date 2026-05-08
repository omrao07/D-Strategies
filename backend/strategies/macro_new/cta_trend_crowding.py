#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cta_trend_crowding.py — CTA trend crowding detection → fade when overly crowded
==================================================================================
CTA (commodity trading advisors) are systematic trend-followers. When they are
all positioned the same way (crowded), the trade is at risk of reversal. This
strategy detects crowding via COT data and fades extreme positioning.

Inputs (CSV)
------------
--cot      cot_positioning.csv
    Columns: date, asset, managed_money_long, managed_money_short, open_interest,
             commercial_net, noncommercial_net
--prices   futures_prices.csv
    Columns: date, asset, price

Outputs
-------
outdir/crowding_signals.csv     date, asset, net_position_pct, crowding_zscore, signal
outdir/crowding_vs_returns.csv  crowding score vs forward returns
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def compute_net_position_pct(long_mm: float, short_mm: float, oi: float) -> float:
    """Managed money net position as % of open interest."""
    if oi <= 0 or np.isnan(oi):
        return np.nan
    net = long_mm - short_mm
    return net / oi * 100


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    cot = pd.read_csv(cfg.cot_file, parse_dates=["date"])
    cot.columns = [c.lower().strip() for c in cot.columns]
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]
    price_wide = prices.pivot(index="date", columns="asset", values="price").sort_index()

    signal_records = []
    corr_records = []
    all_daily = []

    for asset in cot["asset"].unique():
        sub = cot[cot["asset"] == asset].set_index("date").sort_index()
        if len(sub) < 20:
            continue

        sub["net_mm_pct"] = sub.apply(
            lambda r: compute_net_position_pct(
                r.get("managed_money_long", 0) or 0,
                r.get("managed_money_short", 0) or 0,
                r.get("open_interest", 1) or 1
            ), axis=1
        )
        sub["crowding_zscore"] = (sub["net_mm_pct"] - sub["net_mm_pct"].rolling(52, min_periods=13).mean()) / \
                                  sub["net_mm_pct"].rolling(52, min_periods=13).std().replace(0, np.nan)
        sub["position_trend"] = sub["net_mm_pct"].diff(4)  # weekly change

        has_price = asset in price_wide.columns
        price_series = price_wide[asset] if has_price else None

        for date, row in sub.iterrows():
            z = row.get("crowding_zscore", np.nan)
            net = row.get("net_mm_pct", np.nan)
            trend = row.get("position_trend", 0) or 0
            if np.isnan(z):
                signal = "neutral"
            elif z > cfg.extreme_long and trend > 0:
                signal = "fade_crowded_long"   # CTA very long → reversal risk
            elif z < -cfg.extreme_long and trend < 0:
                signal = "fade_crowded_short"  # CTA very short → reversal risk
            elif z > cfg.moderate_threshold:
                signal = "caution_long_crowded"
            elif z < -cfg.moderate_threshold:
                signal = "caution_short_crowded"
            else:
                signal = "neutral"

            signal_records.append({
                "date": date, "asset": asset,
                "net_mm_pct": float(net) if not np.isnan(net) else None,
                "crowding_zscore": float(z) if not np.isnan(z) else None,
                "position_trend_4w": float(trend) if not np.isnan(trend) else None,
                "signal": signal
            })

        if not has_price:
            continue

        ret = price_series.pct_change().dropna()
        fwd4w = ret.rolling(20).sum().shift(-20)
        crowd_z = sub["crowding_zscore"].reindex(ret.index, method="ffill").dropna()
        aligned = crowd_z.align(fwd4w.dropna(), join="inner")
        if len(aligned[0]) > 10:
            r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
            corr_records.append({"asset": asset, "crowding_fwd4w_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

        # Backtest: fade crowded positioning
        pos = sub["crowding_zscore"].apply(
            lambda z: -1 if z > cfg.extreme_long else (1 if z < -cfg.extreme_long else 0)
        )
        pos_daily = pos.reindex(ret.index, method="ffill").shift(5)  # 5-day lag for COT release
        strat = pos_daily * ret
        all_daily.append(strat.rename(asset))

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "crowding_signals.csv"), index=False)

    corr_df = pd.DataFrame(corr_records).sort_values("crowding_fwd4w_corr") if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "crowding_vs_returns.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_assets": cot["asset"].nunique(), "n_signals": len(sig_df),
        "n_fade_long": int((sig_df["signal"] == "fade_crowded_long").sum()) if not sig_df.empty else 0,
        "n_fade_short": int((sig_df["signal"] == "fade_crowded_short").sum()) if not sig_df.empty else 0,
        "avg_corr_fwd4w": float(corr_df["crowding_fwd4w_corr"].mean()) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"extreme_long": cfg.extreme_long, "moderate_threshold": cfg.moderate_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"CTA crowding | Assets: {summary['n_assets']} | Fade long: {summary['n_fade_long']} | Fade short: {summary['n_fade_short']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cot", required=True, dest="cot_file")
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--extreme-long", type=float, default=2.0)
    ap.add_argument("--moderate-threshold", type=float, default=1.0)
    ap.add_argument("--outdir", default="./artifacts/cta_crowding")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
