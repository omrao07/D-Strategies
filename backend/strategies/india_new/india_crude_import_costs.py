#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_crude_import_costs.py — India crude import bill vs CAD/INR/sector impact
================================================================================
India imports ~85% of crude needs. Rising crude (USD/bbl) + weak INR = double
whammy on import bill → wider CAD → INR depreciation pressure → bearish for
rate-sensitive sectors (banking, FMCG, autos) → bullish for oil PSUs (ONGC, OIL).

Inputs (CSV)
------------
--crude    crude_prices.csv
    Columns: date, brent_usd, wti_usd (optional), basket_usd (India basket, optional)
--inr      inr_rates.csv
    Columns: date, usdinr
--returns  sector_returns.csv
    Columns: date, ticker, return (ONGC, RELIANCE, BPCL, HPCL, IOCL, BANKEX, etc.)

Outputs
-------
outdir/import_cost_signals.csv  date, brent, usdinr, import_cost_idx, signal
outdir/sector_impact.csv        sector returns by import cost regime
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

OIL_BENEFICIARIES = ["ongc", "oil", "cairn", "vedl"]
OIL_IMPACTED = ["bpcl", "hpcl", "iocl", "aviation", "paint"]
FX_IMPACTED = ["bankex", "banking", "fmcg", "auto"]

IMPORT_COST_HIGH = 1.3  # z-score
IMPORT_COST_LOW = -1.0


def compute_import_cost_index(brent: float, usdinr: float, base_brent: float = 60, base_inr: float = 70) -> float:
    if np.isnan(brent) or np.isnan(usdinr):
        return np.nan
    return (brent / base_brent) * (usdinr / base_inr)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    crude = pd.read_csv(cfg.crude_file, parse_dates=["date"])
    crude.columns = [c.lower().strip() for c in crude.columns]
    crude = crude.set_index("date").sort_index()
    inr = pd.read_csv(cfg.inr_file, parse_dates=["date"])
    inr.columns = [c.lower().strip() for c in inr.columns]
    inr = inr.set_index("date").sort_index()
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    brent_col = "brent_usd" if "brent_usd" in crude.columns else \
                ("basket_usd" if "basket_usd" in crude.columns else crude.columns[0])
    inr_col = "usdinr" if "usdinr" in inr.columns else inr.columns[0]

    merged = crude[[brent_col]].join(inr[[inr_col]], how="outer").ffill().dropna()

    base_brent = float(merged[brent_col].iloc[:252].mean()) if len(merged) > 252 else 70.0
    base_inr = float(merged[inr_col].iloc[:252].mean()) if len(merged) > 252 else 70.0

    merged["import_cost_idx"] = merged.apply(
        lambda r: compute_import_cost_index(r[brent_col], r[inr_col], base_brent, base_inr), axis=1
    )
    merged["import_cost_yoy"] = merged["import_cost_idx"].pct_change(252) * 100
    merged["import_cost_zscore"] = (merged["import_cost_idx"] - merged["import_cost_idx"].rolling(252).mean()) / \
                                    merged["import_cost_idx"].rolling(252).std().replace(0, np.nan)
    merged["brent_mom"] = merged[brent_col].pct_change(21) * 100
    merged["inr_mom"] = merged[inr_col].pct_change(21) * 100  # positive = depreciation

    # Sector impact analysis
    sector_records = []
    for regime_label, regime_mask in [
        ("high_import_cost", merged["import_cost_zscore"] > IMPORT_COST_HIGH),
        ("low_import_cost", merged["import_cost_zscore"] < IMPORT_COST_LOW),
        ("normal", (merged["import_cost_zscore"] >= IMPORT_COST_LOW) & (merged["import_cost_zscore"] <= IMPORT_COST_HIGH))
    ]:
        regime_dates = merged[regime_mask].index
        for ticker in ret_wide.columns:
            sub = ret_wide[ticker].reindex(regime_dates).dropna()
            if len(sub) > 20:
                sector_records.append({
                    "ticker": ticker, "regime": regime_label,
                    "avg_daily_return": float(sub.mean()),
                    "ann_return": float(sub.mean() * 252),
                    "n_days": len(sub)
                })

    if sector_records:
        pd.DataFrame(sector_records).to_csv(os.path.join(cfg.outdir, "sector_impact.csv"), index=False)

    signal_records = []
    for date, row in merged.iterrows():
        z = row.get("import_cost_zscore", np.nan)
        brent = row.get(brent_col, np.nan)
        inr_val = row.get(inr_col, np.nan)
        brent_rising = row.get("brent_mom", 0) > 5

        if not np.isnan(z):
            if z > IMPORT_COST_HIGH and brent_rising:
                signal = "buy_oil_producers_sell_importers"
            elif z > IMPORT_COST_HIGH:
                signal = "mild_buy_oil_producers"
            elif z < IMPORT_COST_LOW:
                signal = "buy_oil_marketers_sell_producers"
            else:
                signal = "neutral"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date,
            "brent_usd": float(brent) if not np.isnan(brent) else None,
            "usdinr": float(inr_val) if not np.isnan(inr_val) else None,
            "import_cost_idx": float(row["import_cost_idx"]) if not np.isnan(row["import_cost_idx"]) else None,
            "import_cost_zscore": float(z) if not np.isnan(z) else None,
            "brent_mom_pct": float(row.get("brent_mom", np.nan)) if not np.isnan(row.get("brent_mom", np.nan)) else None,
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "import_cost_signals.csv"), index=False)

    # Backtest on oil producers vs importers
    all_daily = []
    SIG_POS = {"buy_oil_producers_sell_importers": 1, "mild_buy_oil_producers": 0.5,
               "neutral": 0, "buy_oil_marketers_sell_producers": -0.5}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    for ticker in ret_wide.columns:
        is_beneficiary = any(ob in ticker.lower() for ob in OIL_BENEFICIARIES)
        is_impacted = any(oi in ticker.lower() for oi in OIL_IMPACTED)
        if not (is_beneficiary or is_impacted):
            continue
        direction = 1 if is_beneficiary else -1
        pos_daily = (pos * direction).reindex(ret_wide.index).ffill().shift(1).fillna(0)
        all_daily.append((pos_daily * ret_wide[ticker]).rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "current_brent_usd": float(merged[brent_col].iloc[-1]) if not merged.empty else None,
        "current_usdinr": float(merged[inr_col].iloc[-1]) if not merged.empty else None,
        "current_import_cost_idx": float(merged["import_cost_idx"].iloc[-1]) if not merged.empty else None,
        "n_high_cost_days": int((sig_df["signal"] == "buy_oil_producers_sell_importers").sum()),
        "ann_return": ann_ret, "sharpe": sharpe,
        "base_brent": base_brent, "base_inr": base_inr
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India Crude | Brent: ${summary['current_brent_usd']:.1f} | USDINR: {summary['current_usdinr']:.2f} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--crude", required=True, dest="crude_file")
    ap.add_argument("--inr", required=True, dest="inr_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/india_crude")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
