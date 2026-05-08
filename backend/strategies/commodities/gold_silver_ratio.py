#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gold_silver_ratio.py — Gold/silver ratio extremes predict precious metals positioning
======================================================================================
The gold/silver ratio (GSR) oscillates between 40x-100x historically. Extreme high
GSR (>90x) → silver extremely cheap → buy silver / sell gold (mean reversion).
Extreme low GSR (<50x) → gold cheap → buy gold / sell silver.

Inputs (CSV)
------------
--metals   metals_prices.csv
    Columns: date, gold_usd, silver_usd, platinum_usd (optional), palladium_usd (optional)

Outputs
-------
outdir/gsr_signals.csv          date, gsr, gsr_zscore, signal, gold_return, silver_return
outdir/ratio_vs_metals.csv      GSR regime analysis
outdir/backtest.csv             cumulative P&L (long silver, short gold or vice versa)
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


GSR_THRESHOLDS = {"extreme_high": 90, "high": 75, "historical_mean": 65, "low": 55, "extreme_low": 45}


def classify_gsr_regime(gsr: float) -> str:
    if gsr > GSR_THRESHOLDS["extreme_high"]:
        return "extreme_high"   # Buy silver, sell gold
    elif gsr > GSR_THRESHOLDS["high"]:
        return "high"
    elif gsr > GSR_THRESHOLDS["low"]:
        return "normal"
    elif gsr > GSR_THRESHOLDS["extreme_low"]:
        return "low"
    return "extreme_low"        # Buy gold, sell silver


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    metals = pd.read_csv(cfg.metals_file, parse_dates=["date"])
    metals.columns = [c.lower().strip() for c in metals.columns]
    metals = metals.set_index("date").sort_index()

    gold_col = "gold_usd" if "gold_usd" in metals.columns else metals.columns[0]
    silver_col = "silver_usd" if "silver_usd" in metals.columns else metals.columns[1]

    metals["gsr"] = metals[gold_col] / metals[silver_col].replace(0, np.nan)
    metals["gsr_ma20"] = metals["gsr"].rolling(20).mean()
    metals["gsr_zscore"] = (metals["gsr"] - metals["gsr"].rolling(252).mean()) / \
                            metals["gsr"].rolling(252).std().replace(0, np.nan)
    metals["gsr_percentile"] = metals["gsr"].rolling(252).rank(pct=True) * 100
    metals["gsr_regime"] = metals["gsr"].apply(classify_gsr_regime)
    metals["gsr_trend"] = metals["gsr"].diff(20)  # Negative = GSR falling = silver outperforming

    gold_ret = metals[gold_col].pct_change()
    silver_ret = metals[silver_col].pct_change()

    signal_records = []
    for date, row in metals.iterrows():
        gsr = row["gsr"]
        z = row.get("gsr_zscore", np.nan)
        regime = row["gsr_regime"]
        trend = row.get("gsr_trend", 0) or 0

        if regime in ("extreme_high",) or (not np.isnan(z) and z > cfg.zscore_threshold and trend > 0):
            signal = "long_silver_short_gold"
        elif regime in ("extreme_low",) or (not np.isnan(z) and z < -cfg.zscore_threshold and trend < 0):
            signal = "long_gold_short_silver"
        elif regime == "high" and trend < 0:
            signal = "light_long_silver"
        elif regime == "low" and trend > 0:
            signal = "light_long_gold"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date, "gsr": float(gsr) if not np.isnan(gsr) else None,
            "gsr_zscore": float(z) if not np.isnan(z) else None,
            "gsr_percentile": float(row.get("gsr_percentile", np.nan)) if not np.isnan(row.get("gsr_percentile", np.nan)) else None,
            "gsr_regime": regime, "gsr_trend_20d": float(trend),
            "gold_price": float(row[gold_col]), "silver_price": float(row[silver_col]),
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "gsr_signals.csv"), index=False)

    # GSR regime analysis: gold vs silver performance by regime
    regime_records = []
    for regime in metals["gsr_regime"].unique():
        mask = metals["gsr_regime"] == regime
        gold_ret_r = gold_ret.reindex(metals[mask].index).dropna()
        silver_ret_r = silver_ret.reindex(metals[mask].index).dropna()
        if len(gold_ret_r) > 5:
            regime_records.append({
                "regime": regime, "n_days": len(gold_ret_r),
                "avg_gsr": float(metals.loc[mask, "gsr"].mean()),
                "gold_ann_ret": float(gold_ret_r.mean() * 252),
                "silver_ann_ret": float(silver_ret_r.mean() * 252),
                "silver_vs_gold": float((silver_ret_r - gold_ret_r).mean() * 252)
            })
    pd.DataFrame(regime_records).to_csv(os.path.join(cfg.outdir, "ratio_vs_metals.csv"), index=False)

    # Backtest: trade the ratio
    SIG_POS = {"long_silver_short_gold": (1, -1), "long_gold_short_silver": (-1, 1),
               "light_long_silver": (0.5, -0.5), "light_long_gold": (-0.5, 0.5), "neutral": (0, 0)}
    gold_pos = metals["gsr_regime"].apply(lambda r: SIG_POS.get(classify_gsr_regime(metals.loc[metals.index == r.name, "gsr"].iloc[0] if isinstance(r, pd.Series) else r), (0, 0))[0] if not isinstance(r, float) else SIG_POS.get("neutral", (0, 0))[0])
    # Simpler approach:
    sig_series = sig_df.set_index("date")["signal"].reindex(metals.index, method="ffill")
    pos_gold = sig_series.map({s: v[0] for s, v in SIG_POS.items()}).fillna(0)
    pos_silver = sig_series.map({s: v[1] for s, v in SIG_POS.items()}).fillna(0)
    strat = (pos_gold.shift(1) * gold_ret + pos_silver.shift(1) * silver_ret).dropna()
    cum = (1 + strat).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
    sharpe = float(strat.mean() / strat.std() * np.sqrt(252)) if strat.std() > 0 else None

    current_gsr = float(metals["gsr"].iloc[-1]) if not metals.empty else None
    summary = {
        "current_gsr": current_gsr,
        "current_regime": str(metals["gsr_regime"].iloc[-1]) if not metals.empty else None,
        "historical_avg_gsr": float(metals["gsr"].mean()),
        "historical_max_gsr": float(metals["gsr"].max()),
        "historical_min_gsr": float(metals["gsr"].min()),
        "pct_extreme_high": float((metals["gsr_regime"] == "extreme_high").mean()),
        "pct_extreme_low": float((metals["gsr_regime"] == "extreme_low").mean()),
        "n_long_silver_signals": int((sig_df["signal"] == "long_silver_short_gold").sum()),
        "ann_return": float(strat.mean() * 252), "sharpe": sharpe,
        "params": {"zscore_threshold": cfg.zscore_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Gold/silver ratio | Current GSR: {current_gsr:.1f}x | Regime: {summary['current_regime']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--metals", required=True, dest="metals_file")
    ap.add_argument("--zscore-threshold", type=float, default=2.0)
    ap.add_argument("--outdir", default="./artifacts/gold_silver_ratio")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
