#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
exchange_net_flows.py — Exchange net inflows/outflows predict short-term price pressure
=========================================================================================
Large net inflows to exchanges = selling pressure (coins moving to sell).
Large net outflows = accumulation (coins being withdrawn to cold storage).
This strategy uses 7-day rolling net flow z-scores as directional signals.

Inputs (CSV)
------------
--flows    exchange_flows.csv
    Columns: date, asset, exchange, inflow_coins, outflow_coins,
             inflow_usd, outflow_usd
--prices   crypto_prices.csv
    Columns: date, ticker, price

Outputs
-------
outdir/flow_signals.csv         date, asset, net_flow_usd, flow_zscore, signal
outdir/flow_vs_returns.csv      net flow vs 1/3/7 day forward return
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    flows = pd.read_csv(cfg.flows_file, parse_dates=["date"])
    flows.columns = [c.lower().strip() for c in flows.columns]
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]
    price_wide = prices.pivot(index="date", columns="ticker", values="price").sort_index()

    # Aggregate across exchanges
    agg = flows.groupby(["date", "asset"]).agg(
        total_inflow_usd=("inflow_usd", "sum"),
        total_outflow_usd=("outflow_usd", "sum"),
        total_inflow_coins=("inflow_coins", "sum") if "inflow_coins" in flows.columns else ("inflow_usd", "count"),
        total_outflow_coins=("outflow_coins", "sum") if "outflow_coins" in flows.columns else ("outflow_usd", "count")
    ).reset_index()
    agg["net_flow_usd"] = agg["total_outflow_usd"] - agg["total_inflow_usd"]  # positive = net outflow (bullish)
    agg["flow_ratio"] = agg["total_outflow_usd"] / agg["total_inflow_usd"].replace(0, np.nan)

    signal_records = []
    corr_records = []
    all_daily = []

    for asset in agg["asset"].unique():
        sub = agg[agg["asset"] == asset].set_index("date").sort_index()
        if len(sub) < 20:
            continue

        sub["net_flow_ma7"] = sub["net_flow_usd"].rolling(7).mean()
        sub["flow_zscore"] = (sub["net_flow_usd"] - sub["net_flow_usd"].rolling(30).mean()) / \
                              sub["net_flow_usd"].rolling(30).std().replace(0, np.nan)

        # Inflow surge: large inflows → selling pressure → bearish
        sub["inflow_zscore"] = (sub["total_inflow_usd"] - sub["total_inflow_usd"].rolling(30).mean()) / \
                                sub["total_inflow_usd"].rolling(30).std().replace(0, np.nan)

        price_ticker = asset.upper()
        has_price = price_ticker in price_wide.columns

        for date, row in sub.iterrows():
            z = row.get("flow_zscore", np.nan)
            inflow_z = row.get("inflow_zscore", np.nan)
            if np.isnan(z):
                signal = "neutral"
            elif z > cfg.zscore_threshold:
                signal = "buy"  # net outflow from exchanges → accumulation
            elif z < -cfg.zscore_threshold or (not np.isnan(inflow_z) and inflow_z > cfg.zscore_threshold * 1.5):
                signal = "sell"  # large net inflows → impending selling
            else:
                signal = "neutral"

            signal_records.append({
                "date": date, "asset": asset,
                "net_flow_usd": float(row["net_flow_usd"]),
                "total_inflow_usd": float(row["total_inflow_usd"]),
                "total_outflow_usd": float(row["total_outflow_usd"]),
                "flow_zscore": float(z) if not np.isnan(z) else None,
                "inflow_zscore": float(inflow_z) if not np.isnan(inflow_z) else None,
                "signal": signal
            })

        if not has_price:
            continue

        price_series = price_wide[price_ticker]
        ret = price_series.pct_change().dropna()

        # Correlation with 1/3/7 day forward returns
        for horizon in [1, 3, 7]:
            fwd = ret.rolling(horizon).sum().shift(-horizon)
            flow_z_daily = sub["flow_zscore"].reindex(ret.index, method="ffill").dropna()
            aligned = flow_z_daily.align(fwd.dropna(), join="inner")
            if len(aligned[0]) > 15:
                r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
                corr_records.append({"asset": asset, "horizon_days": horizon,
                                      "corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

        # Backtest
        pos = sub["flow_zscore"].apply(lambda z: 1 if z > cfg.zscore_threshold else (-1 if z < -cfg.zscore_threshold else 0))
        pos_daily = pos.reindex(ret.index, method="ffill").shift(1)
        strat = pos_daily * ret
        all_daily.append(strat.rename(asset))

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "flow_signals.csv"), index=False)

    corr_df = pd.DataFrame(corr_records).sort_values(["horizon_days", "corr"]) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "flow_vs_returns.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(365)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 365)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_assets": agg["asset"].nunique(), "n_signals": len(sig_df),
        "n_buy_signals": int((sig_df["signal"] == "buy").sum()) if not sig_df.empty else 0,
        "n_sell_signals": int((sig_df["signal"] == "sell").sum()) if not sig_df.empty else 0,
        "avg_corr_1d": float(corr_df[corr_df["horizon_days"] == 1]["corr"].mean()) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"zscore_threshold": cfg.zscore_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Exchange flows | Assets: {summary['n_assets']} | Buy: {summary['n_buy_signals']} | Sell: {summary['n_sell_signals']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flows", required=True, dest="flows_file")
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--zscore-threshold", type=float, default=1.5)
    ap.add_argument("--outdir", default="./artifacts/exchange_flows")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
