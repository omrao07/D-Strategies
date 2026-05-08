#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cocoa_political_risk_ivory_coast.py — Ivory Coast political risk vs cocoa supply
==================================================================================
Ivory Coast + Ghana supply ~65% of world cocoa. Political instability (elections,
coups, port strikes) → supply disruption → cocoa price spike. Strategy monitors
political risk indicators and seasonal crop dynamics (main crop: Oct-Mar).

Inputs (CSV)
------------
--cocoa    cocoa_prices.csv
    Columns: date, cocoa_usd_ton, gh_differential_usd (Ghana premium, optional)
--politics political_risk.csv
    Columns: date, country, event_type, risk_score (0-10), description
--stocks   stock_returns.csv
    Columns: date, ticker, return (cocoa ETF or chocolate cos: HSY, MCD, MDLZ)

Outputs
-------
outdir/cocoa_signals.csv        date, cocoa_price, risk_score, season, signal
outdir/political_events.csv     events and 30-day price impact
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


MAIN_CROP_MONTHS = [10, 11, 12, 1, 2, 3]   # Main crop (Ivory Coast): Oct-Mar
MID_CROP_MONTHS = [4, 5, 6, 7, 8, 9]       # Mid crop: Apr-Sep (smaller)
HIGH_RISK_EVENTS = ["coup", "election", "strike", "port_closure", "sanctions", "civil_unrest"]


def get_cocoa_season(month: int) -> str:
    return "main_crop" if month in MAIN_CROP_MONTHS else "mid_crop"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    cocoa = pd.read_csv(cfg.cocoa_file, parse_dates=["date"])
    cocoa.columns = [c.lower().strip() for c in cocoa.columns]
    cocoa = cocoa.set_index("date").sort_index()
    politics = pd.read_csv(cfg.politics_file, parse_dates=["date"])
    politics.columns = [c.lower().strip() for c in politics.columns]
    stocks = pd.read_csv(cfg.stocks_file, parse_dates=["date"])
    stocks.columns = [c.lower().strip() for c in stocks.columns]
    ret_wide = stocks.pivot(index="date", columns="ticker", values="return").sort_index()

    cocoa_col = "cocoa_usd_ton" if "cocoa_usd_ton" in cocoa.columns else cocoa.columns[0]

    # Rolling risk score from political events
    politics_ci = politics[politics.get("country", pd.Series("CI")) == "CI"] if "country" in politics.columns else politics
    risk_daily = pd.Series(0.0, index=cocoa.index)
    event_records = []
    for _, ev in politics_ci.iterrows():
        ev_date = ev["date"]
        ev_type = str(ev.get("event_type", "")).lower()
        risk_score = float(ev.get("risk_score", 5))
        is_high_risk = any(h in ev_type for h in HIGH_RISK_EVENTS)
        if is_high_risk:
            # Risk decays over 60 days
            for i in range(60):
                future_date = ev_date + pd.Timedelta(days=i)
                if future_date in risk_daily.index:
                    decay = risk_score * (1 - i / 60)
                    risk_daily.loc[future_date] = max(risk_daily.loc[future_date], decay)

            # Event impact analysis
            price_at_event = cocoa[cocoa_col].reindex([ev_date], method="nearest")
            price_30d = cocoa[cocoa_col].reindex([ev_date + pd.Timedelta(days=30)], method="nearest")
            impact = None
            if len(price_at_event) > 0 and len(price_30d) > 0:
                p0 = price_at_event.iloc[0]
                p30 = price_30d.iloc[0]
                impact = (p30 - p0) / p0 * 100 if p0 > 0 else None
            event_records.append({
                "date": ev_date, "event_type": ev_type, "risk_score": risk_score,
                "description": str(ev.get("description", "")),
                "price_at_event": float(price_at_event.iloc[0]) if len(price_at_event) > 0 else None,
                "price_impact_30d_pct": float(impact) if impact is not None else None
            })

    cocoa["risk_score"] = risk_daily
    cocoa["season"] = pd.Series(cocoa.index.month, index=cocoa.index).apply(get_cocoa_season)
    cocoa["price_zscore"] = (cocoa[cocoa_col] - cocoa[cocoa_col].rolling(252).mean()) / \
                             cocoa[cocoa_col].rolling(252).std().replace(0, np.nan)
    cocoa["price_mom_pct"] = cocoa[cocoa_col].pct_change(21) * 100

    signal_records = []
    for date, row in cocoa.iterrows():
        risk = row.get("risk_score", 0)
        z = row.get("price_zscore", np.nan)
        season = row["season"]

        # High political risk during main crop → supply disruption → buy
        # Normal low risk + price elevated → sell
        if risk > cfg.risk_threshold and season == "main_crop":
            signal = "buy_cocoa_supply_risk"
        elif risk > cfg.risk_threshold:
            signal = "buy_cocoa_risk"
        elif not np.isnan(z) and z < -1.5:
            signal = "buy_cocoa_cheap"
        elif not np.isnan(z) and z > 2.0 and risk < 2:
            signal = "sell_cocoa_extended"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date, "cocoa_usd_ton": float(row[cocoa_col]),
            "political_risk_score": float(risk),
            "price_zscore": float(z) if not np.isnan(z) else None,
            "season": season, "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "cocoa_signals.csv"), index=False)

    if event_records:
        pd.DataFrame(event_records).sort_values("date").to_csv(os.path.join(cfg.outdir, "political_events.csv"), index=False)

    # Backtest
    cocoa_ret = cocoa[cocoa_col].pct_change().dropna()
    pos = sig_df.set_index("date")["signal"].map(
        {"buy_cocoa_supply_risk": 1.5, "buy_cocoa_risk": 1, "buy_cocoa_cheap": 0.5,
         "neutral": 0, "sell_cocoa_extended": -1}
    ).fillna(0)
    pos_daily = pos.reindex(cocoa_ret.index, method="ffill").shift(1).fillna(0)
    port = (pos_daily * cocoa_ret).dropna()
    cum = (1 + port).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
    sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None

    avg_event_impact = float(np.nanmean([e["price_impact_30d_pct"] for e in event_records if e.get("price_impact_30d_pct") is not None])) if event_records else None
    summary = {
        "n_political_events": len(event_records), "n_high_risk_events": len([e for e in event_records if e["risk_score"] > 7]),
        "avg_30d_price_impact_pct": avg_event_impact,
        "current_cocoa_usd_ton": float(cocoa[cocoa_col].iloc[-1]) if not cocoa.empty else None,
        "n_buy_signals": int((sig_df["signal"].str.startswith("buy")).sum()) if not sig_df.empty else 0,
        "ann_return": float(port.mean() * 252), "sharpe": sharpe,
        "params": {"risk_threshold": cfg.risk_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Cocoa political risk | Events: {summary['n_political_events']} | Avg 30d impact: {summary['avg_30d_price_impact_pct']:.1f}% | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cocoa", required=True, dest="cocoa_file")
    ap.add_argument("--politics", required=True, dest="politics_file")
    ap.add_argument("--stocks", required=True, dest="stocks_file")
    ap.add_argument("--risk-threshold", type=float, default=4.0)
    ap.add_argument("--outdir", default="./artifacts/cocoa_political")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
