#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
emerging_market_local_debt.py — EM local currency bonds: yield + FX carry signal
==================================================================================
EM local bonds offer high nominal yields (8-15%) but carry FX risk. The total
return = yield + FX change. Strategy: long EM local debt when real yields are
high (>3%), current account is improving, and USD is weakening.

Inputs (CSV)
------------
--yields   em_yields.csv
    Columns: date, country, local_yield_10y_pct, real_yield_pct, inflation_pct
--fx       em_fx.csv
    Columns: date, country, fx_vs_usd, fx_return_pct
--fundamentals em_fundamentals.csv (optional)
    Columns: date, country, ca_pct_gdp, foreign_reserves_months, debt_gdp_pct

Outputs
-------
outdir/em_signals.csv           date, country, total_carry_pct, signal, conviction
outdir/country_rankings.csv     country ranking by composite score
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd


def compute_em_score(row: pd.Series) -> float:
    score = 0.0
    count = 0

    real_yield = row.get("real_yield_pct", np.nan)
    if not np.isnan(real_yield):
        score += min(real_yield / 3, 2)  # Up to 2 points for 6%+ real yield
        count += 1

    ca = row.get("ca_pct_gdp", np.nan)
    if not np.isnan(ca):
        score += 1 if ca > 0 else (-1 if ca < -3 else 0)
        count += 1

    reserves = row.get("foreign_reserves_months", np.nan)
    if not np.isnan(reserves):
        score += 1 if reserves > 4 else (-1 if reserves < 2 else 0)
        count += 1

    debt_gdp = row.get("debt_gdp_pct", np.nan)
    if not np.isnan(debt_gdp):
        score += 1 if debt_gdp < 40 else (-1 if debt_gdp > 70 else 0)
        count += 1

    return score / count if count > 0 else 0.0


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    yields = pd.read_csv(cfg.yields_file, parse_dates=["date"])
    yields.columns = [c.lower().strip() for c in yields.columns]
    fx = pd.read_csv(cfg.fx_file, parse_dates=["date"])
    fx.columns = [c.lower().strip() for c in fx.columns]

    fundamentals = None
    if cfg.fundamentals_file:
        fundamentals = pd.read_csv(cfg.fundamentals_file, parse_dates=["date"])
        fundamentals.columns = [c.lower().strip() for c in fundamentals.columns]

    merged = yields.merge(fx[["date", "country", "fx_vs_usd", "fx_return_pct"]], on=["date", "country"], how="left")
    if fundamentals is not None:
        merged = merged.merge(fundamentals, on=["date", "country"], how="left")

    merged["total_carry_pct"] = merged["local_yield_10y_pct"] + merged.get("fx_return_pct", pd.Series(0, index=merged.index))

    signal_records = []
    all_daily = []

    for country in merged["country"].unique():
        sub = merged[merged["country"] == country].set_index("date").sort_index()
        if len(sub) < 4:
            continue

        sub["em_score"] = sub.apply(compute_em_score, axis=1)
        sub["real_yield_trend"] = sub.get("real_yield_pct", pd.Series(np.nan)).diff(4)

        for date, row in sub.iterrows():
            score = row["em_score"]
            real_yield = row.get("real_yield_pct", np.nan)
            total_carry = row.get("total_carry_pct", np.nan)
            if np.isnan(real_yield):
                signal = "neutral"
            elif real_yield > cfg.min_real_yield and score > cfg.min_score:
                signal = "buy"
            elif real_yield < 0 or score < -0.5:
                signal = "sell"
            else:
                signal = "neutral"

            signal_records.append({
                "date": date, "country": country,
                "local_yield_pct": float(row.get("local_yield_10y_pct", np.nan)),
                "real_yield_pct": float(real_yield) if not np.isnan(real_yield) else None,
                "total_carry_pct": float(total_carry) if not np.isnan(total_carry) else None,
                "em_score": float(score), "signal": signal
            })

        # Backtest: use total carry as return proxy
        pos = sub["em_score"].apply(lambda s: 1 if s > cfg.min_score else (-1 if s < -0.5 else 0))
        carry_ret = sub.get("fx_return_pct", pd.Series(0, index=sub.index)).fillna(0) + \
                    sub.get("local_yield_10y_pct", pd.Series(0, index=sub.index)).fillna(0) / 100 / 252
        strat = pos.shift(1) * carry_ret
        all_daily.append(strat.rename(country))

    sig_df = pd.DataFrame(signal_records).sort_values(["date", "em_score"], ascending=[True, False])
    sig_df.to_csv(os.path.join(cfg.outdir, "em_signals.csv"), index=False)

    # Country rankings (latest)
    latest = sig_df.groupby("country").last().reset_index().sort_values("em_score", ascending=False)
    latest.to_csv(os.path.join(cfg.outdir, "country_rankings.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_countries": merged["country"].nunique(), "n_signals": len(sig_df),
        "n_buy": int((sig_df["signal"] == "buy").sum()) if not sig_df.empty else 0,
        "avg_real_yield_buy": float(sig_df[sig_df["signal"] == "buy"]["real_yield_pct"].dropna().mean()) if not sig_df.empty else None,
        "top_country": str(latest["country"].iloc[0]) if not latest.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"min_real_yield": cfg.min_real_yield, "min_score": cfg.min_score}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"EM local debt | Countries: {summary['n_countries']} | Buy signals: {summary['n_buy']} | Top: {summary['top_country']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yields", required=True, dest="yields_file")
    ap.add_argument("--fx", required=True, dest="fx_file")
    ap.add_argument("--fundamentals", default=None, dest="fundamentals_file")
    ap.add_argument("--min-real-yield", type=float, default=3.0)
    ap.add_argument("--min-score", type=float, default=0.5)
    ap.add_argument("--outdir", default="./artifacts/em_local_debt")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
