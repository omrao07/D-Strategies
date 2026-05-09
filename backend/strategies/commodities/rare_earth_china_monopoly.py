#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rare_earth_china_monopoly.py — China rare earth export quotas vs supply disruption
=====================================================================================
China controls ~60% of rare earth mining and ~90% of processing. Export quota
reductions → supply shock → price surge for REE-dependent sectors (EVs, defense,
wind turbines, electronics). Strategy monitors China quota signals and REE prices.

Inputs (CSV)
------------
--ree      ree_prices.csv
    Columns: date, element (neodymium/dysprosium/lanthanum/cerium/etc.), price_usd_kg
--quotas   china_quotas.csv (optional)
    Columns: date, quota_mt, yoy_change_pct, quota_type (mining/smelting/export)
--stocks   stock_returns.csv
    Columns: date, ticker, return (MP, NOVN, MKTS for Western REE stocks)

Outputs
-------
outdir/ree_signals.csv          date, element, price, zscore, quota_signal, signal
outdir/quota_analysis.csv       quota change events and price impact
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


REE_STOCK_TICKERS = ["mp", "novn", "mkts", "arafura", "lyc", "iluka"]
HIGH_VALUE_REE = ["neodymium", "dysprosium", "praseodymium", "terbium"]  # Used in EV motors


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    ree = pd.read_csv(cfg.ree_file, parse_dates=["date"])
    ree.columns = [c.lower().strip() for c in ree.columns]
    stocks = pd.read_csv(cfg.stocks_file, parse_dates=["date"])
    stocks.columns = [c.lower().strip() for c in stocks.columns]
    ret_wide = stocks.pivot(index="date", columns="ticker", values="return").sort_index()

    quotas = None
    if cfg.quotas_file:
        quotas = pd.read_csv(cfg.quotas_file, parse_dates=["date"])
        quotas.columns = [c.lower().strip() for c in quotas.columns]
        quotas = quotas.set_index("date").sort_index()

    price_col = "price_usd_kg" if "price_usd_kg" in ree.columns else ree.columns[2]
    element_col = "element" if "element" in ree.columns else ree.columns[1]

    # Compute price composite for high-value REE
    ree_wide = ree.pivot(index="date", columns=element_col, values=price_col).sort_index()
    hv_cols = [c for c in HIGH_VALUE_REE if c in ree_wide.columns]
    if hv_cols:
        ree_wide["hv_composite"] = ree_wide[hv_cols].mean(axis=1)
    else:
        ree_wide["hv_composite"] = ree_wide.mean(axis=1)

    ree_wide["hv_yoy_pct"] = ree_wide["hv_composite"].pct_change(252) * 100
    ree_wide["hv_zscore"] = (ree_wide["hv_composite"] - ree_wide["hv_composite"].rolling(252).mean()) / \
                             ree_wide["hv_composite"].rolling(252).std().replace(0, np.nan)
    ree_wide["hv_mom_pct"] = ree_wide["hv_composite"].pct_change(21) * 100

    # Quota signals
    quota_signals = pd.Series("no_data", index=ree_wide.index)
    quota_records = []
    if quotas is not None and "quota_mt" in quotas.columns:
        quotas["quota_yoy"] = quotas["quota_mt"].pct_change(4) * 100  # quarterly
        for date, row in quotas.iterrows():
            yoy = row.get("quota_yoy", np.nan)
            q_sig = "reduction" if (not np.isnan(yoy) and yoy < -5) else \
                    ("increase" if (not np.isnan(yoy) and yoy > 5) else "stable")
            quota_signals.loc[date:] = q_sig
            if q_sig == "reduction":
                quota_records.append({"date": date, "quota_mt": float(row["quota_mt"]),
                                       "yoy_change_pct": float(yoy) if not np.isnan(yoy) else None,
                                       "price_impact": "bullish"})

    if quota_records:
        pd.DataFrame(quota_records).to_csv(os.path.join(cfg.outdir, "quota_analysis.csv"), index=False)

    signal_records = []
    for date, row in ree_wide.iterrows():
        z = row.get("hv_zscore", np.nan)
        mom = row.get("hv_mom_pct", np.nan)
        q_sig = quota_signals.loc[date] if date in quota_signals.index else "no_data"

        if not np.isnan(z) and (z > cfg.zscore_threshold or q_sig == "reduction"):
            signal = "buy_ree_miners"
        elif not np.isnan(z) and z < -cfg.zscore_threshold and q_sig != "reduction":
            signal = "sell_ree_miners"
        elif q_sig == "reduction" and not np.isnan(z) and z > 0:
            signal = "buy_ree_miners"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date,
            "hv_ree_composite_usd_kg": float(row["hv_composite"]) if not np.isnan(row["hv_composite"]) else None,
            "hv_yoy_pct": float(row.get("hv_yoy_pct", np.nan)) if not np.isnan(row.get("hv_yoy_pct", np.nan)) else None,
            "hv_zscore": float(z) if not np.isnan(z) else None,
            "quota_signal": q_sig, "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "ree_signals.csv"), index=False)

    # Backtest
    all_daily = []
    for ticker in ret_wide.columns:
        if any(m in ticker.lower() for m in REE_STOCK_TICKERS):
            pos = sig_df.set_index("date")["signal"].map(
                {"buy_ree_miners": 1, "neutral": 0, "sell_ree_miners": -1}
            ).fillna(0)
            pos_daily = pos.reindex(ret_wide.index, method="ffill").shift(1).fillna(0)
            strat = pos_daily * ret_wide[ticker]
            all_daily.append(strat.rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "elements_tracked": list(ree_wide.columns.drop("hv_composite", errors="ignore")),
        "high_value_elements": hv_cols,
        "n_quota_reduction_events": len(quota_records),
        "n_buy_signals": int((sig_df["signal"] == "buy_ree_miners").sum()) if not sig_df.empty else 0,
        "current_hv_composite": float(ree_wide["hv_composite"].dropna().iloc[-1]) if not ree_wide.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"zscore_threshold": cfg.zscore_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Rare earth | Elements: {len(summary['elements_tracked'])} | Quota reductions: {summary['n_quota_reduction_events']} | Buy signals: {summary['n_buy_signals']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ree", required=True, dest="ree_file")
    ap.add_argument("--quotas", default=None, dest="quotas_file")
    ap.add_argument("--stocks", required=True, dest="stocks_file")
    ap.add_argument("--zscore-threshold", type=float, default=1.5)
    ap.add_argument("--outdir", default="./artifacts/rare_earth")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
