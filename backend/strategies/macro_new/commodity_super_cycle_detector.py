#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
commodity_super_cycle_detector.py — Identify & trade commodity super-cycles
=============================================================================
Commodity super-cycles are decade-long price surges driven by EM industrialization,
supply underinvestment, or energy transitions. Detecting the early phase (rising
prices + rising EM demand + underinvestment in capex) generates outsized long returns.

Inputs (CSV)
------------
--commodities  commodity_prices.csv
    Columns: date, commodity, price
--capex        capex_data.csv (optional)
    Columns: date, sector, capex_growth_yoy_pct
--em_demand    em_demand.csv (optional)
    Columns: date, indicator, value

Outputs
-------
outdir/super_cycle_score.csv    date, commodity, cycle_score, cycle_phase, signal
outdir/cycle_phases.csv         phase analysis with forward returns
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


CYCLE_PHASES = {
    "early_bull": "rising prices, still-low but accelerating demand",
    "mid_bull": "strong prices, high demand, capex lag",
    "late_bull": "peak prices, high demand, capex ramping",
    "early_bear": "price plateau/decline, demand slowing",
    "mid_bear": "falling prices, demand weak",
    "trough": "depressed prices, capex collapse, EM demand bottoming"
}


def compute_cycle_features(prices: pd.Series) -> pd.DataFrame:
    df = pd.DataFrame({"price": prices})
    df["ma12"] = prices.rolling(12).mean()
    df["ma36"] = prices.rolling(36).mean()
    df["ma60"] = prices.rolling(60).mean()
    df["price_vs_ma36"] = (prices / df["ma36"] - 1) * 100
    df["price_vs_ma60"] = (prices / df["ma60"] - 1) * 100
    df["mom12"] = prices.pct_change(12) * 100
    df["mom36"] = prices.pct_change(36) * 100
    df["mom60"] = prices.pct_change(60) * 100
    df["acceleration"] = df["mom12"] - df["mom36"]
    # Cycle phase score: weighted composite
    df["cycle_score"] = (0.3 * df["price_vs_ma36"].fillna(0) +
                         0.3 * df["mom12"].fillna(0) +
                         0.2 * df["acceleration"].fillna(0) +
                         0.2 * df["price_vs_ma60"].fillna(0))
    return df


def classify_phase(score: float, acceleration: float) -> str:
    if score > 40 and acceleration > 0:
        return "late_bull"
    elif score > 20 and acceleration > 0:
        return "mid_bull"
    elif score > 0 and acceleration > 0:
        return "early_bull"
    elif score > 0 and acceleration < 0:
        return "early_bear"
    elif score < -20 and acceleration < 0:
        return "mid_bear"
    elif score < -30:
        return "trough"
    return "transition"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    comms = pd.read_csv(cfg.commodities_file, parse_dates=["date"])
    comms.columns = [c.lower().strip() for c in comms.columns]
    comm_wide = comms.pivot(index="date", columns="commodity", values="price").sort_index()

    cycle_records = []
    all_daily = []

    for comm in comm_wide.columns:
        series = comm_wide[comm].dropna()
        if len(series) < 60:
            continue

        feats = compute_cycle_features(series)

        for date, row in feats.dropna(subset=["cycle_score"]).iterrows():
            score = row["cycle_score"]
            accel = row.get("acceleration", 0) or 0
            phase = classify_phase(score, accel)
            signal = "strong_buy" if phase in ("trough", "early_bull") else \
                     ("buy" if phase == "mid_bull" else ("reduce" if phase in ("late_bull", "early_bear") else ("sell" if phase in ("mid_bear",) else "neutral")))
            cycle_records.append({
                "date": date, "commodity": comm,
                "price": float(row["price"]),
                "cycle_score": float(score),
                "mom12_pct": float(row.get("mom12", np.nan)) if not np.isnan(row.get("mom12", np.nan)) else None,
                "price_vs_ma60_pct": float(row.get("price_vs_ma60", np.nan)) if not np.isnan(row.get("price_vs_ma60", np.nan)) else None,
                "acceleration": float(accel),
                "cycle_phase": phase, "signal": signal
            })

        # Backtest
        phase_series = pd.Series({d: classify_phase(feats.loc[d, "cycle_score"], feats.loc[d, "acceleration"] or 0)
                                   for d in feats.dropna(subset=["cycle_score"]).index})
        pos = phase_series.map({"trough": 2, "early_bull": 1.5, "mid_bull": 1, "late_bull": 0,
                                 "early_bear": -0.5, "mid_bear": -1, "transition": 0}).fillna(0)
        ret = series.pct_change().dropna()
        pos_aligned = pos.reindex(ret.index, method="ffill").shift(1).fillna(0)
        strat = pos_aligned * ret
        all_daily.append(strat.rename(comm))

    cycle_df = pd.DataFrame(cycle_records).sort_values(["commodity", "date"])
    cycle_df.to_csv(os.path.join(cfg.outdir, "super_cycle_score.csv"), index=False)

    # Phase-level forward returns
    phase_fwd = []
    for comm in comm_wide.columns:
        sub_c = cycle_df[cycle_df["commodity"] == comm].set_index("date")
        if sub_c.empty:
            continue
        price = comm_wide[comm].dropna()
        fwd12m = price.pct_change(252).shift(-252)
        for phase in CYCLE_PHASES:
            phase_dates = sub_c[sub_c["cycle_phase"] == phase].index
            fwd_rets = fwd12m.reindex(phase_dates).dropna()
            if len(fwd_rets) > 0:
                phase_fwd.append({"commodity": comm, "phase": phase,
                                   "avg_fwd12m_ret": float(fwd_rets.mean()), "n": len(fwd_rets)})
    if phase_fwd:
        pd.DataFrame(phase_fwd).to_csv(os.path.join(cfg.outdir, "cycle_phases.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    current_phases = cycle_df.groupby("commodity")["cycle_phase"].last().to_dict() if not cycle_df.empty else {}
    summary = {
        "n_commodities": comm_wide.shape[1], "n_records": len(cycle_df),
        "current_phases": current_phases,
        "n_in_trough": sum(1 for v in current_phases.values() if v == "trough"),
        "n_in_bull": sum(1 for v in current_phases.values() if "bull" in v),
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Commodity super-cycle | Commodities: {summary['n_commodities']} | In bull: {summary['n_in_bull']} | In trough: {summary['n_in_trough']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commodities", required=True, dest="commodities_file")
    ap.add_argument("--capex", default=None, dest="capex_file")
    ap.add_argument("--em-demand", default=None, dest="em_demand_file")
    ap.add_argument("--outdir", default="./artifacts/commodity_super_cycle")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
