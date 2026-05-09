#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_defense_indigenization.py — India defense Atmanirbhar vs defense stocks
==============================================================================
India targets 70% domestic procurement in defense by 2027. Defense budget growth
+ positive indigenization list announcements → bullish for HAL, BEL, BEML, Paras,
MTAR, Ideaforge, Data Patterns. Tracks budget allocation, import embargo lists,
and export order momentum.

Inputs (CSV)
------------
--defense  defense_data.csv
    Columns: date, defense_budget_cr, indigenization_target_pct, pil_items_count
             (Positive Indigenization List), export_orders_cr, import_embargo_items
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/defense_signals.csv  date, budget_yoy_pct, pil_count, indigenization_pct, signal
outdir/defense_vs_budget.csv  budget growth vs defense stock returns
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


DEFENSE_TICKERS = ["hal", "bel", "beml", "paras", "mtar", "dpsl", "ideaforge", "bhel_defense", "cochin", "grse", "mazagon"]
BUDGET_GROWTH_HIGH = 12.0  # % YoY — strong defense spending
BUDGET_GROWTH_LOW = 5.0


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    defense = pd.read_csv(cfg.defense_file, parse_dates=["date"])
    defense.columns = [c.lower().strip() for c in defense.columns]
    defense = defense.set_index("date").sort_index()
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    budget_col = "defense_budget_cr" if "defense_budget_cr" in defense.columns else defense.columns[0]
    pil_col = "pil_items_count" if "pil_items_count" in defense.columns else None
    indig_col = "indigenization_target_pct" if "indigenization_target_pct" in defense.columns else None
    export_col = "export_orders_cr" if "export_orders_cr" in defense.columns else None

    defense["budget_yoy_pct"] = defense[budget_col].pct_change(1) * 100  # annual data → 1yr
    defense["budget_zscore"] = (defense[budget_col] - defense[budget_col].rolling(5).mean()) / \
                                defense[budget_col].rolling(5).std().replace(0, np.nan)

    if export_col:
        defense["export_growth_pct"] = defense[export_col].pct_change(1) * 100

    if pil_col:
        defense["pil_acceleration"] = defense[pil_col].diff()  # new items added per period

    # Budget vs defense stock returns correlation
    budget_records = []
    budget_yoy = defense["budget_yoy_pct"].dropna()
    for ticker in ret_wide.columns:
        if not any(d in ticker.lower() for d in DEFENSE_TICKERS):
            continue
        ret_s = ret_wide[ticker].dropna()
        for lag in [1, 3, 6, 12]:
            fwd_ret = ret_s.rolling(lag * 21).sum().shift(-lag * 21)
            budget_daily = budget_yoy.reindex(ret_s.index, method="ffill").dropna()
            aligned = budget_daily.align(fwd_ret.dropna(), join="inner")
            if len(aligned[0]) > 10:
                r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
                budget_records.append({"ticker": ticker, "lag_months": lag,
                                        "budget_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

    if budget_records:
        pd.DataFrame(budget_records).to_csv(os.path.join(cfg.outdir, "defense_vs_budget.csv"), index=False)

    signal_records = []
    for date, row in defense.iterrows():
        budget_yoy_val = row.get("budget_yoy_pct", np.nan)
        pil_count = row.get(pil_col, np.nan) if pil_col else np.nan
        pil_accel = row.get("pil_acceleration", np.nan) if pil_col else np.nan
        indig = row.get(indig_col, np.nan) if indig_col else np.nan
        export_growth = row.get("export_growth_pct", np.nan) if export_col else np.nan

        score = 0
        if not np.isnan(budget_yoy_val):
            score += 1 if budget_yoy_val >= BUDGET_GROWTH_HIGH else (-1 if budget_yoy_val < BUDGET_GROWTH_LOW else 0)
        if not np.isnan(pil_accel) and pil_accel > 10:
            score += 1
        if not np.isnan(export_growth) and export_growth > 20:
            score += 1
        if not np.isnan(indig) and indig > 60:
            score += 0.5

        signal = "strong_buy_defense" if score >= 2 else \
                 ("buy_defense" if score >= 1 else \
                  ("neutral" if score >= 0 else "sell_defense"))

        signal_records.append({
            "date": date,
            "defense_budget_cr": float(row[budget_col]) if not np.isnan(row[budget_col]) else None,
            "budget_yoy_pct": float(budget_yoy_val) if not np.isnan(budget_yoy_val) else None,
            "pil_items_count": int(pil_count) if not np.isnan(pil_count) else None,
            "indigenization_target_pct": float(indig) if not np.isnan(indig) else None,
            "export_growth_pct": float(export_growth) if not np.isnan(export_growth) else None,
            "signal_score": float(score), "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "defense_signals.csv"), index=False)

    # Backtest
    SIG_POS = {"strong_buy_defense": 1.5, "buy_defense": 1, "neutral": 0, "sell_defense": -0.5}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for ticker in ret_wide.columns:
        if any(d in ticker.lower() for d in DEFENSE_TICKERS):
            pos_daily = pos.reindex(ret_wide.index, method="ffill").shift(1).fillna(0)
            all_daily.append((pos_daily * ret_wide[ticker]).rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    latest = sig_df.iloc[-1] if not sig_df.empty else {}
    summary = {
        "latest_budget_cr": float(latest.get("defense_budget_cr", np.nan)) if latest.get("defense_budget_cr") else None,
        "latest_budget_yoy": float(latest.get("budget_yoy_pct", np.nan)) if latest.get("budget_yoy_pct") else None,
        "latest_pil_count": int(latest.get("pil_items_count", 0)) if latest.get("pil_items_count") else 0,
        "latest_signal": str(latest.get("signal", "N/A")),
        "n_buy_signals": int((sig_df["signal"].str.contains("buy")).sum()),
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India Defense | Budget YoY: {summary['latest_budget_yoy']:.1f}% | PIL items: {summary['latest_pil_count']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--defense", required=True, dest="defense_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/india_defense")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
