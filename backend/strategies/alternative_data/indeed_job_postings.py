#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
indeed_job_postings.py — Indeed postings as macro & sector employment leading indicator
=========================================================================================
Indeed job postings are published weekly and lead official employment data by 4-6 weeks.
Sector-level posting growth predicts sector ETF performance; company-level postings
predict individual stock earnings surprises.

Inputs (CSV)
------------
--postings    indeed_postings.csv
    Columns: date, ticker_or_sector, category (company/sector), job_count
--returns     returns.csv
    Columns: date, ticker_or_sector, return

Outputs
-------
outdir/posting_growth.csv     date, entity, 4wk_growth, 13wk_growth, yoy_growth, signal
outdir/sector_signals.csv     sector-level signals only
outdir/backtest.csv           cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def compute_growth_features(series: pd.Series) -> pd.DataFrame:
    df = pd.DataFrame({"postings": series})
    df["wk4_growth"] = series.pct_change(4)
    df["wk13_growth"] = series.pct_change(13)
    df["yoy_growth"] = series.pct_change(52)
    df["zscore_52w"] = (series - series.rolling(52).mean()) / series.rolling(52).std().replace(0, np.nan)
    df["acceleration"] = df["wk4_growth"] - df["wk13_growth"]
    return df


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    postings = pd.read_csv(cfg.postings_file, parse_dates=["date"])
    postings.columns = [c.lower().strip() for c in postings.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]

    entity_col = "ticker_or_sector" if "ticker_or_sector" in postings.columns else postings.columns[1]
    ret_col = "ticker_or_sector" if "ticker_or_sector" in returns.columns else returns.columns[1]
    ret_wide = returns.pivot(index="date", columns=ret_col, values="return").sort_index()

    growth_records = []
    sector_records = []
    all_daily = []

    for entity, grp in postings.groupby(entity_col):
        sub = grp.set_index("date").sort_index()["job_count"]
        if len(sub) < 20:
            continue

        feats = compute_growth_features(sub)
        is_sector = "category" in grp.columns and grp["category"].iloc[0] == "sector"

        for date, row in feats.iterrows():
            signal = "buy" if row["zscore_52w"] > cfg.zscore_threshold else \
                     ("sell" if row["zscore_52w"] < -cfg.zscore_threshold else "neutral")
            rec = {"date": date, "entity": entity, "postings": float(row["postings"]),
                   "wk4_growth": float(row["wk4_growth"]) if not np.isnan(row["wk4_growth"]) else None,
                   "wk13_growth": float(row["wk13_growth"]) if not np.isnan(row["wk13_growth"]) else None,
                   "yoy_growth": float(row["yoy_growth"]) if not np.isnan(row["yoy_growth"]) else None,
                   "acceleration": float(row["acceleration"]) if not np.isnan(row["acceleration"]) else None,
                   "zscore_52w": float(row["zscore_52w"]) if not np.isnan(row["zscore_52w"]) else None,
                   "signal": signal}
            growth_records.append(rec)
            if is_sector:
                sector_records.append(rec)

        if entity not in ret_wide.columns:
            continue

        pos = feats["zscore_52w"].apply(lambda z: 1 if z > cfg.zscore_threshold else (-1 if z < -cfg.zscore_threshold else 0))
        # Weekly postings → need to forward-fill to daily return series
        pos_daily = pos.reindex(ret_wide.index, method="ffill")
        strat = pos_daily.shift(5) * ret_wide[entity]  # 5-day execution lag
        all_daily.append(strat.rename(entity))

    growth_df = pd.DataFrame(growth_records).sort_values("date")
    growth_df.to_csv(os.path.join(cfg.outdir, "posting_growth.csv"), index=False)

    if sector_records:
        pd.DataFrame(sector_records).sort_values("date").to_csv(
            os.path.join(cfg.outdir, "sector_signals.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    n_buy = int((growth_df["signal"] == "buy").sum()) if not growth_df.empty else 0
    summary = {
        "n_entities": postings[entity_col].nunique(), "n_signals": len(growth_df),
        "n_buy_signals": n_buy, "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"zscore_threshold": cfg.zscore_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Indeed postings | Entities: {summary['n_entities']} | Buy signals: {n_buy} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--postings", required=True, dest="postings_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--zscore-threshold", type=float, default=1.5)
    ap.add_argument("--outdir", default="./artifacts/indeed_postings")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
