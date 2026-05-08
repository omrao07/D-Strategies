#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
defi_tvl_momentum.py — DeFi protocol TVL momentum predicts token performance
==============================================================================
Total Value Locked (TVL) in DeFi protocols is the primary metric for protocol
health. Rising TVL = user adoption + yield demand → token price appreciation.
Falling TVL = capital flight → token underperformance.

Inputs (CSV)
------------
--tvl      defi_tvl.csv
    Columns: date, protocol, tvl_usd, chain, category
--returns  crypto_returns.csv
    Columns: date, ticker, return (maps to protocol token)
--mapping  protocol_token_map.csv (optional)
    Columns: protocol, ticker

Outputs
-------
outdir/tvl_momentum.csv         date, protocol, tvl, tvl_growth_7d/30d, signal
outdir/tvl_vs_returns.csv       TVL growth vs token return correlation
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def compute_tvl_features(series: pd.Series) -> pd.DataFrame:
    df = pd.DataFrame({"tvl": series})
    df["tvl_7d_growth"] = series.pct_change(7)
    df["tvl_30d_growth"] = series.pct_change(30)
    df["tvl_90d_growth"] = series.pct_change(90)
    df["tvl_zscore_30d"] = (series - series.rolling(30).mean()) / series.rolling(30).std().replace(0, np.nan)
    df["tvl_acceleration"] = df["tvl_7d_growth"] - df["tvl_7d_growth"].shift(7)
    return df


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    tvl = pd.read_csv(cfg.tvl_file, parse_dates=["date"])
    tvl.columns = [c.lower().strip() for c in tvl.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    # Load optional mapping
    mapping = {}
    if cfg.mapping_file:
        m = pd.read_csv(cfg.mapping_file)
        m.columns = [c.lower().strip() for c in m.columns]
        mapping = dict(zip(m["protocol"].str.lower(), m["ticker"].str.upper()))

    # Category-level TVL (aggregate)
    if "category" in tvl.columns:
        cat_tvl = tvl.groupby(["date", "category"])["tvl_usd"].sum().reset_index()
    else:
        cat_tvl = pd.DataFrame()

    tvl_records = []
    corr_records = []
    all_daily = []

    for protocol in tvl["protocol"].unique():
        sub = tvl[tvl["protocol"] == protocol].set_index("date").sort_index()
        if len(sub) < 20:
            continue

        feats = compute_tvl_features(sub["tvl_usd"])
        sub = sub.join(feats.drop(columns=["tvl"]))

        ticker = mapping.get(protocol.lower(), protocol.upper())
        has_returns = ticker in ret_wide.columns

        for date, row in sub.iterrows():
            z = row.get("tvl_zscore_30d", np.nan)
            g7 = row.get("tvl_7d_growth", np.nan)
            accel = row.get("tvl_acceleration", np.nan) or 0
            signal = "buy" if (not np.isnan(z) and z > cfg.zscore_threshold and (g7 or 0) > 0) else \
                     ("sell" if (not np.isnan(z) and z < -cfg.zscore_threshold and (g7 or 0) < 0) else "neutral")
            tvl_records.append({
                "date": date, "protocol": protocol,
                "tvl_usd": float(row["tvl_usd"]),
                "tvl_7d_growth": float(g7) if not np.isnan(g7) else None,
                "tvl_30d_growth": float(row.get("tvl_30d_growth", np.nan)) if not np.isnan(row.get("tvl_30d_growth", np.nan)) else None,
                "tvl_zscore": float(z) if not np.isnan(z) else None,
                "tvl_acceleration": float(accel) if not np.isnan(accel) else None,
                "signal": signal
            })

        if not has_returns:
            continue

        fwd7 = ret_wide[ticker].rolling(7).sum().shift(-7)
        tvl_z = sub["tvl_zscore_30d"].dropna()
        aligned = tvl_z.reindex(ret_wide.index, method="ffill").dropna().align(fwd7.dropna(), join="inner")
        if len(aligned[0]) > 15:
            r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
            corr_records.append({"protocol": protocol, "ticker": ticker,
                                  "tvl_fwd7d_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

        pos = sub["tvl_zscore_30d"].apply(lambda z: 1 if z > cfg.zscore_threshold else (-1 if z < -cfg.zscore_threshold else 0))
        pos_daily = pos.reindex(ret_wide.index, method="ffill").shift(1)
        strat = pos_daily * ret_wide[ticker]
        all_daily.append(strat.rename(ticker))

    tvl_df = pd.DataFrame(tvl_records).sort_values("date")
    tvl_df.to_csv(os.path.join(cfg.outdir, "tvl_momentum.csv"), index=False)

    corr_df = pd.DataFrame(corr_records).sort_values("tvl_fwd7d_corr", ascending=False) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "tvl_vs_returns.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(365)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 365)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_protocols": tvl["protocol"].nunique(), "n_signals": len(tvl_df),
        "n_buy": int((tvl_df["signal"] == "buy").sum()) if not tvl_df.empty else 0,
        "avg_tvl_corr_fwd7d": float(corr_df["tvl_fwd7d_corr"].mean()) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"zscore_threshold": cfg.zscore_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"DeFi TVL | Protocols: {summary['n_protocols']} | Buy signals: {summary['n_buy']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tvl", required=True, dest="tvl_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--mapping", default=None, dest="mapping_file")
    ap.add_argument("--zscore-threshold", type=float, default=1.5)
    ap.add_argument("--outdir", default="./artifacts/defi_tvl")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
