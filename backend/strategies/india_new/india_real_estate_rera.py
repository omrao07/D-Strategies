#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_real_estate_rera.py — RERA registration trends vs real estate sector returns
====================================================================================
RERA (Real Estate Regulation Act) project registrations track new supply pipeline
and developer confidence. Rising registrations + falling inventory overhang →
bullish for DLF, Godrej Properties, Oberoi, Prestige, Brigade. Home loan growth
(HDFC, LIC Housing) follows with 3-6M lag.

Inputs (CSV)
------------
--rera     rera_data.csv
    Columns: date, state, new_registrations, completed_projects, complaints_filed,
             inventory_units (optional)
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/rera_signals.csv     date, registrations_yoy_pct, complaints_ratio, signal
outdir/state_analysis.csv   state-level RERA momentum
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


REALTY_TICKERS = ["dlf", "godrejprop", "oberoirealty", "prestige", "brigade", "sobha", "sunteck", "mahindralife"]
HOME_LOAN_TICKERS = ["hdfcltd", "lichf", "can_fin", "repco"]
REGISTRATION_GROWTH_HIGH = 20.0  # YoY % growth considered strong
COMPLAINT_RATIO_HIGH = 0.15      # complaints / registrations — high stress


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    rera = pd.read_csv(cfg.rera_file, parse_dates=["date"])
    rera.columns = [c.lower().strip() for c in rera.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    reg_col = "new_registrations" if "new_registrations" in rera.columns else rera.columns[2]
    comp_col = "complaints_filed" if "complaints_filed" in rera.columns else None
    inv_col = "inventory_units" if "inventory_units" in rera.columns else None

    # Aggregate nationally
    national = rera.groupby("date").agg(
        total_registrations=(reg_col, "sum"),
        **({comp_col: (comp_col, "sum")} if comp_col else {}),
        **({inv_col: (inv_col, "sum")} if inv_col else {})
    ).sort_index()

    national["reg_yoy_pct"] = national["total_registrations"].pct_change(12) * 100
    national["reg_mom_pct"] = national["total_registrations"].pct_change(1) * 100
    national["reg_zscore"] = (national["total_registrations"] - national["total_registrations"].rolling(12).mean()) / \
                              national["total_registrations"].rolling(12).std().replace(0, np.nan)
    if comp_col:
        national["complaint_ratio"] = national[comp_col] / national["total_registrations"].replace(0, np.nan)
    if inv_col:
        national["inv_mom_pct"] = national[inv_col].pct_change(3) * 100  # quarterly inventory change

    # State-level analysis
    state_records = []
    if "state" in rera.columns:
        state_agg = rera.groupby(["state", pd.Grouper(key="date", freq="QE")])[reg_col].sum().reset_index()
        state_agg["reg_yoy"] = state_agg.groupby("state")[reg_col].pct_change(4) * 100
        top_states = state_agg.groupby("state")[reg_col].sum().nlargest(10).index.tolist()
        for state in top_states:
            sub = state_agg[state_agg["state"] == state].tail(4)
            if not sub.empty:
                state_records.append({
                    "state": state,
                    "total_registrations_1yr": float(sub[reg_col].sum()),
                    "avg_yoy_growth": float(sub["reg_yoy"].mean()) if not sub["reg_yoy"].isna().all() else None
                })

    if state_records:
        pd.DataFrame(state_records).sort_values("total_registrations_1yr", ascending=False).to_csv(
            os.path.join(cfg.outdir, "state_analysis.csv"), index=False)

    signal_records = []
    for date, row in national.iterrows():
        yoy = row.get("reg_yoy_pct", np.nan)
        z = row.get("reg_zscore", np.nan)
        comp_ratio = row.get("complaint_ratio", np.nan) if comp_col else np.nan
        inv_mom = row.get("inv_mom_pct", np.nan) if inv_col else np.nan

        high_stress = not np.isnan(comp_ratio) and comp_ratio > COMPLAINT_RATIO_HIGH
        inventory_rising = not np.isnan(inv_mom) and inv_mom > 5

        if not np.isnan(yoy) and yoy > REGISTRATION_GROWTH_HIGH and not high_stress and not inventory_rising:
            signal = "strong_buy_realty"
        elif not np.isnan(yoy) and yoy > 10 and not high_stress:
            signal = "buy_realty"
        elif high_stress or inventory_rising:
            signal = "sell_realty"
        elif not np.isnan(yoy) and yoy < -10:
            signal = "sell_realty"
        elif not np.isnan(z) and z > 0.5:
            signal = "mild_buy_realty"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date,
            "total_registrations": int(row["total_registrations"]),
            "reg_yoy_pct": float(yoy) if not np.isnan(yoy) else None,
            "reg_zscore": float(z) if not np.isnan(z) else None,
            "complaint_ratio": float(comp_ratio) if not np.isnan(comp_ratio) else None,
            "high_stress": bool(high_stress),
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "rera_signals.csv"), index=False)

    # Backtest
    SIG_POS = {"strong_buy_realty": 1.5, "buy_realty": 1, "mild_buy_realty": 0.5,
               "neutral": 0, "sell_realty": -1}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for ticker in ret_wide.columns:
        if any(r in ticker.lower() for r in REALTY_TICKERS + HOME_LOAN_TICKERS):
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
        "latest_registrations": int(latest.get("total_registrations", 0)) if latest.get("total_registrations") else 0,
        "latest_yoy_pct": float(latest.get("reg_yoy_pct", np.nan)) if latest.get("reg_yoy_pct") else None,
        "latest_signal": str(latest.get("signal", "N/A")),
        "n_buy_signals": int(sig_df["signal"].str.contains("buy").sum()),
        "top_states": [s["state"] for s in state_records[:5]],
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India RERA | Registrations YoY: {summary['latest_yoy_pct']:.1f}% | Signal: {summary['latest_signal']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rera", required=True, dest="rera_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/india_rera")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
