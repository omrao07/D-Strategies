#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
middle_east_oil_disruptions.py — Middle East conflict vs oil supply shock strategy
====================================================================================
Strait of Hormuz handles ~20% of global oil. Conflict escalation → supply shock →
oil spike → buy energy stocks/ETFs (XLE, CVX, XOM), short airlines, auto. Tracks
geopolitical risk index, tanker insurance rates, and Brent/WTI spread changes.

Inputs (CSV)
------------
--events   geopolitical_events.csv
    Columns: date, region, event_type, severity (1-10), description
--oil      oil_prices.csv
    Columns: date, brent_usd, wti_usd, brent_wti_spread (optional)
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/oil_risk_signals.csv  date, geo_risk_score, brent_zscore, signal
outdir/event_oil_impact.csv  event → 30-day oil price impact
outdir/backtest.csv          cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

MENA_REGIONS = ["iran", "iraq", "saudi", "uae", "yemen", "qatar", "oman", "bahrain", "hormuz", "israel", "gaza"]
HIGH_RISK_EVENT_TYPES = ["conflict", "attack", "blockade", "sanctions", "missile", "war", "coup"]
OIL_BENEFICIARIES = ["xle", "xom", "cvx", "cop", "oxy", "psx", "vlo", "ric", "slb"]
OIL_LOSERS = ["dal", "aal", "ual", "luv", "f", "gm", "tsla"]


def classify_severity(event_type: str, severity: float) -> float:
    base = float(severity) if not np.isnan(severity) else 5.0
    multiplier = 1.5 if any(h in str(event_type).lower() for h in HIGH_RISK_EVENT_TYPES) else 0.8
    return base * multiplier


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    events = pd.read_csv(cfg.events_file, parse_dates=["date"])
    events.columns = [c.lower().strip() for c in events.columns]
    events = events.sort_values("date")
    oil = pd.read_csv(cfg.oil_file, parse_dates=["date"])
    oil.columns = [c.lower().strip() for c in oil.columns]
    oil = oil.set_index("date").sort_index()
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    brent_col = "brent_usd" if "brent_usd" in oil.columns else oil.columns[0]
    oil["brent_yoy_pct"] = oil[brent_col].pct_change(252) * 100
    oil["brent_zscore"] = (oil[brent_col] - oil[brent_col].rolling(252).mean()) / \
                           oil[brent_col].rolling(252).std().replace(0, np.nan)
    oil["brent_mom_21d"] = oil[brent_col].pct_change(21) * 100

    # Build geo-risk score from MENA events
    all_dates = oil.index
    geo_risk = pd.Series(0.0, index=all_dates)
    event_impact_records = []

    mena_events = events[events.apply(
        lambda r: any(m in str(r.get("region", "")).lower() for m in MENA_REGIONS), axis=1
    )]

    for _, ev in mena_events.iterrows():
        ev_date = ev["date"]
        sev = classify_severity(ev.get("event_type", ""), float(ev.get("severity", 5)))
        for i in range(45):
            fd = ev_date + pd.Timedelta(days=i)
            if fd in geo_risk.index:
                decay = sev * (1 - i / 45)
                geo_risk.loc[fd] = max(geo_risk.loc[fd], decay)

        # Oil impact
        brent_at = oil[brent_col].reindex([ev_date], method="nearest")
        brent_30d = oil[brent_col].reindex([ev_date + pd.Timedelta(days=30)], method="nearest")
        if len(brent_at) > 0 and len(brent_30d) > 0 and brent_at.iloc[0] > 0:
            impact_pct = (brent_30d.iloc[0] - brent_at.iloc[0]) / brent_at.iloc[0] * 100
        else:
            impact_pct = None

        event_impact_records.append({
            "date": ev_date, "region": str(ev.get("region", "")),
            "event_type": str(ev.get("event_type", "")), "severity": float(ev.get("severity", 5)),
            "brent_at_event": float(brent_at.iloc[0]) if len(brent_at) > 0 else None,
            "brent_30d_impact_pct": float(impact_pct) if impact_pct is not None else None
        })

    if event_impact_records:
        pd.DataFrame(event_impact_records).sort_values("date").to_csv(
            os.path.join(cfg.outdir, "event_oil_impact.csv"), index=False)

    geo_risk_rolling = geo_risk.rolling(5).mean()
    signal_records = []
    for date in all_dates:
        risk = float(geo_risk_rolling.loc[date]) if date in geo_risk_rolling.index else 0
        brent_z = float(oil["brent_zscore"].reindex([date]).ffill().iloc[0]) if date in oil.index else np.nan
        brent_mom = float(oil["brent_mom_21d"].reindex([date]).ffill().iloc[0]) if date in oil.index else np.nan

        if risk > 7 and not np.isnan(brent_mom) and brent_mom > 5:
            signal = "strong_buy_energy"
        elif risk > 4:
            signal = "buy_energy"
        elif risk > 2:
            signal = "mild_buy_energy"
        elif risk < 1 and not np.isnan(brent_z) and brent_z > 2:
            signal = "sell_energy"  # risk fading with high price → mean revert
        else:
            signal = "neutral"

        signal_records.append({
            "date": date, "geo_risk_score": float(risk),
            "brent_usd": float(oil[brent_col].reindex([date]).ffill().iloc[0]) if date in oil.index else None,
            "brent_zscore": float(brent_z) if not np.isnan(brent_z) else None,
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "oil_risk_signals.csv"), index=False)

    # Backtest on energy stocks
    SIG_POS = {"strong_buy_energy": 1.5, "buy_energy": 1, "mild_buy_energy": 0.5,
               "neutral": 0, "sell_energy": -0.5}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for ticker in ret_wide.columns:
        if any(e in ticker.lower() for e in OIL_BENEFICIARIES):
            pos_daily = pos.reindex(ret_wide.index).ffill().shift(1).fillna(0)
            all_daily.append((pos_daily * ret_wide[ticker]).rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    ev_df = pd.DataFrame(event_impact_records) if event_impact_records else pd.DataFrame()
    summary = {
        "n_mena_events": len(event_impact_records),
        "avg_30d_oil_impact_pct": float(ev_df["brent_30d_impact_pct"].mean()) if not ev_df.empty and "brent_30d_impact_pct" in ev_df else None,
        "max_geo_risk_score": float(geo_risk.max()),
        "current_brent_usd": float(oil[brent_col].iloc[-1]) if not oil.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Middle East Oil | MENA Events: {summary['n_mena_events']} | Avg oil impact: {summary['avg_30d_oil_impact_pct']:.1f}% | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", required=True, dest="events_file")
    ap.add_argument("--oil", required=True, dest="oil_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/middle_east_oil")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
