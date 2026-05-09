#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_monsoon_insurance.py — India monsoon deficit vs agri/FMCG/insurance sectors
====================================================================================
India's ~75% of farmland is rain-fed. Below-normal monsoon (< 94% LPA) → crop
failure → rural income squeeze → bearish for FMCG, auto two-wheelers, microfinance.
Catastrophic drought → insurance claims surge. Good monsoon (> 106%) → bullish cycle.

Inputs (CSV)
------------
--monsoon  monsoon_data.csv
    Columns: date, actual_mm, lpa_mm, departure_pct, phase (all_india/northwest/northeast/central/south)
--returns  sector_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/monsoon_signals.csv  date, departure_pct, season_phase, classification, signal
outdir/sector_monsoon.csv   monsoon classification vs sector forward returns
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


MONSOON_MONTHS = [6, 7, 8, 9]  # June-September
ONSET_MONTH = 6
WITHDRAWAL_MONTH = 10

MONSOON_CLASSES = {
    "excess": (106, float("inf")),
    "above_normal": (104, 106),
    "normal": (96, 104),
    "below_normal": (90, 96),
    "deficient": (float("-inf"), 90)
}

SECTOR_MONSOON_MAP = {
    "excess": {"bullish": ["fmcg", "agri", "mfi", "rural", "tractor", "2wheeler"],
               "bearish": ["insurance", "irrigation"]},
    "normal": {"bullish": ["fmcg", "2wheeler", "rural"], "bearish": []},
    "below_normal": {"bullish": ["insurance", "drip_irrigation"], "bearish": ["fmcg", "mfi", "rural", "2wheeler"]},
    "deficient": {"bullish": ["insurance"], "bearish": ["fmcg", "mfi", "rural", "2wheeler", "agri"]}
}


def classify_monsoon(departure_pct: float) -> str:
    for label, (lo, hi) in MONSOON_CLASSES.items():
        if lo <= departure_pct < hi:
            return label
    return "normal"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    monsoon = pd.read_csv(cfg.monsoon_file, parse_dates=["date"])
    monsoon.columns = [c.lower().strip() for c in monsoon.columns]
    monsoon = monsoon.set_index("date").sort_index()
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    dep_col = "departure_pct" if "departure_pct" in monsoon.columns else \
              (None if "actual_mm" not in monsoon.columns else None)

    if dep_col is None and "actual_mm" in monsoon.columns and "lpa_mm" in monsoon.columns:
        monsoon["departure_pct"] = (monsoon["actual_mm"] / monsoon["lpa_mm"] - 1) * 100
        dep_col = "departure_pct"

    monsoon["monsoon_class"] = monsoon[dep_col].apply(classify_monsoon)
    monsoon["is_monsoon_season"] = monsoon.index.month.isin(MONSOON_MONTHS)
    monsoon["cumulative_departure_pct"] = monsoon.groupby(monsoon.index.year)[dep_col].cumsum()
    monsoon["dep_momentum"] = monsoon[dep_col].rolling(4).mean()  # 4-week trend

    # Sector performance by monsoon classification
    sector_records = []
    for cls in MONSOON_CLASSES:
        class_dates = monsoon[monsoon["monsoon_class"] == cls].index
        for ticker in ret_wide.columns:
            sub = ret_wide[ticker].reindex(class_dates).dropna()
            fwd_30 = ret_wide[ticker].rolling(21).sum().shift(-21).reindex(class_dates).dropna()
            if len(sub) > 10:
                sector_records.append({
                    "ticker": ticker, "monsoon_class": cls,
                    "avg_contemporaneous_return": float(sub.mean()),
                    "avg_forward_30d_return": float(fwd_30.mean()) if len(fwd_30) > 0 else None,
                    "n_observations": len(sub)
                })

    if sector_records:
        pd.DataFrame(sector_records).to_csv(os.path.join(cfg.outdir, "sector_monsoon.csv"), index=False)

    signal_records = []
    for date, row in monsoon.iterrows():
        dep = row.get(dep_col, np.nan)
        cls = row.get("monsoon_class", "normal")
        is_season = row.get("is_monsoon_season", False)
        dep_mom = row.get("dep_momentum", np.nan)

        if not is_season:
            signal = "off_season"
        elif cls == "excess":
            signal = "buy_fmcg_rural"
        elif cls == "above_normal":
            signal = "overweight_rural"
        elif cls == "normal":
            signal = "neutral"
        elif cls == "below_normal":
            signal = "underweight_fmcg_rural"
        elif cls == "deficient":
            signal = "sell_fmcg_rural_buy_insurance"
        else:
            signal = "neutral"

        # Momentum overlay: improving within season
        if is_season and not np.isnan(dep_mom) and dep_mom > 0 and cls in ("below_normal", "deficient"):
            signal = "improving_" + signal  # deficit improving → partial recovery

        signal_records.append({
            "date": date,
            "departure_pct": float(dep) if not np.isnan(dep) else None,
            "monsoon_class": cls,
            "is_monsoon_season": bool(is_season),
            "dep_momentum": float(dep_mom) if not np.isnan(dep_mom) else None,
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "monsoon_signals.csv"), index=False)

    # Backtest: buy FMCG in normal/excess, sell in deficit
    all_daily = []
    SIG_POS = {"buy_fmcg_rural": 1, "overweight_rural": 0.5, "neutral": 0,
               "off_season": 0, "underweight_fmcg_rural": -0.5, "sell_fmcg_rural_buy_insurance": -1}
    pos_map = {s: v for s, v in SIG_POS.items()}
    # Handle improving_ prefixed signals
    for base_sig, base_val in SIG_POS.items():
        pos_map[f"improving_{base_sig}"] = base_val * 0.5 if base_val < 0 else base_val

    pos = sig_df.set_index("date")["signal"].map(pos_map).fillna(0)
    for ticker in ret_wide.columns:
        is_fmcg = any(f in ticker.lower() for f in ["fmcg", "hul", "idf", "rural"])
        if not is_fmcg:
            continue
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

    monsoon_years = monsoon.groupby(monsoon.index.year).agg(
        avg_departure=(dep_col, "mean"), dominant_class=("monsoon_class", lambda x: x.mode()[0])
    ).reset_index()
    summary = {
        "years_analyzed": len(monsoon_years),
        "pct_excess_years": float((monsoon_years["dominant_class"] == "excess").mean() * 100),
        "pct_deficient_years": float((monsoon_years["dominant_class"] == "deficient").mean() * 100),
        "current_class": str(sig_df.iloc[-1]["monsoon_class"]) if not sig_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India Monsoon | Deficient years: {summary['pct_deficient_years']:.0f}% | Current: {summary['current_class']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--monsoon", required=True, dest="monsoon_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/india_monsoon")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
