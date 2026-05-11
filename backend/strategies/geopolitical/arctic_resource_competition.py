#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
arctic_resource_competition.py — Arctic resource race vs energy/mining sector
==============================================================================
Arctic warming opens Northern Sea Route and new resource access. Russia, Canada,
Norway, US, Denmark compete for Arctic shelf rights. Arctic LNG projects (Novatek
Arctic LNG 2), rare earth deposits (Greenland), and shipping route monetization.
Tracks Arctic sovereignty events, ice extent data, and project capex announcements.

Inputs (CSV)
------------
--arctic   arctic_events.csv
    Columns: date, country, event_type (sovereignty/project/treaty/military),
             description, investment_bn_usd (optional), category (lng/mining/shipping/military)
--ice      sea_ice_extent.csv
    Columns: date, extent_mn_sqkm, anomaly_pct (vs 1981-2010 baseline)
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/arctic_signals.csv   date, arctic_openness_score, investment_pipeline_bn, signal
outdir/ice_trend.csv        sea ice extent trend and route accessibility
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


ARCTIC_BENEFICIARIES = {
    "lng": ["novatek", "lng", "lngg", "cqp", "total", "shell"],
    "mining": ["freeport", "rio", "bhp", "vale", "glencore", "first_solar", "mp"],
    "shipping": ["dsx", "sblk", "gnk", "safe_bulkers", "nordic"],
    "defense": ["lmt", "rtx", "noc", "kongsberg"]
}

ROUTE_OPEN_ICE_THRESHOLD = -15  # % anomaly below baseline → route more accessible
SUMMER_MONTHS = [7, 8, 9]  # Arctic navigation season


def compute_arctic_openness(ice_anomaly_pct: float, month: int) -> float:
    base = max(0, -ice_anomaly_pct / 30)  # 30% deficit → openness = 1.0
    seasonal = 1.5 if month in SUMMER_MONTHS else 0.5
    return float(np.clip(base * seasonal, 0, 2))


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    events = pd.read_csv(cfg.arctic_file, parse_dates=["date"])
    events.columns = [c.lower().strip() for c in events.columns]
    events = events.sort_values("date")
    ice = pd.read_csv(cfg.ice_file, parse_dates=["date"])
    ice.columns = [c.lower().strip() for c in ice.columns]
    ice = ice.set_index("date").sort_index()
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    extent_col = "extent_mn_sqkm" if "extent_mn_sqkm" in ice.columns else ice.columns[0]
    anomaly_col = "anomaly_pct" if "anomaly_pct" in ice.columns else None

    # Compute ice trend
    ice["extent_yoy_pct"] = ice[extent_col].pct_change(12) * 100
    ice["extent_5yr_trend"] = ice[extent_col].rolling(60).apply(
        lambda x: stats.linregress(range(len(x)), x)[0] if len(x) >= 60 else np.nan, raw=True
    )
    if anomaly_col:
        ice["openness_score"] = ice.apply(
            lambda r: compute_arctic_openness(r[anomaly_col], r.name.month), axis=1
        )
    else:
        ice["openness_score"] = ice["extent_yoy_pct"].apply(lambda x: max(0, -x / 20) if not np.isnan(x) else 0)

    ice_records = []
    for date, row in ice.iterrows():
        ice_records.append({
            "date": date,
            "extent_mn_sqkm": float(row[extent_col]) if not np.isnan(row[extent_col]) else None,
            "anomaly_pct": float(row[anomaly_col]) if anomaly_col and not np.isnan(row[anomaly_col]) else None,
            "openness_score": float(row["openness_score"]) if not np.isnan(row["openness_score"]) else None,
            "is_navigation_season": bool(date.month in SUMMER_MONTHS)
        })
    pd.DataFrame(ice_records).sort_values("date").to_csv(os.path.join(cfg.outdir, "ice_trend.csv"), index=False)

    # Investment pipeline by category
    investment_pipeline = pd.Series(0.0, index=ret_wide.index)
    for _, ev in events.iterrows():
        ev_date = ev["date"]
        inv = float(ev.get("investment_bn_usd", 0)) if pd.notna(ev.get("investment_bn_usd")) else 0
        category = str(ev.get("category", "other")).lower()
        # Long-lived investment signal (3 years)
        for i in range(756):
            fd = ev_date + pd.Timedelta(days=i)
            if fd in investment_pipeline.index:
                investment_pipeline.loc[fd] += inv * (1 - i / 756)

    signal_records = []
    for date in ret_wide.index:
        openness = float(ice["openness_score"].reindex([date]).ffill().iloc[0]) \
                   if len(ice["openness_score"].dropna()) > 0 and date >= ice.index.min() else 0
        inv_pipeline = float(investment_pipeline.loc[date]) if date in investment_pipeline.index else 0
        is_nav_season = date.month in SUMMER_MONTHS

        # Score = openness + investment momentum
        score = openness + min(inv_pipeline / 50, 2)  # cap pipeline contribution at $100bn → 2pts

        if score > 2.5 and is_nav_season:
            signal = "strong_buy_arctic_lng_shipping"
        elif score > 1.5:
            signal = "buy_arctic_beneficiaries"
        elif score > 0.5:
            signal = "mild_buy_arctic_mining"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date,
            "arctic_openness_score": float(openness),
            "investment_pipeline_bn": float(inv_pipeline),
            "combined_score": float(score),
            "is_navigation_season": bool(is_nav_season),
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "arctic_signals.csv"), index=False)

    # Backtest: buy arctic beneficiaries on high openness score
    SIG_POS = {"strong_buy_arctic_lng_shipping": 1.5, "buy_arctic_beneficiaries": 1,
               "mild_buy_arctic_mining": 0.5, "neutral": 0}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for ticker in ret_wide.columns:
        t = ticker.lower()
        is_beneficiary = any(b in t for beneficiaries in ARCTIC_BENEFICIARIES.values() for b in beneficiaries)
        if not is_beneficiary:
            continue
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

    total_investment = float(events["investment_bn_usd"].sum()) if "investment_bn_usd" in events.columns else None
    latest = sig_df.iloc[-1] if not sig_df.empty else {}
    summary = {
        "n_arctic_events": len(events),
        "total_investment_bn_usd": total_investment,
        "avg_openness_summer": float(sig_df[sig_df["is_navigation_season"]]["arctic_openness_score"].mean()) if not sig_df.empty else None,
        "current_openness": float(latest.get("arctic_openness_score", 0)),
        "current_signal": str(latest.get("signal", "N/A")),
        "ice_5yr_trend": float(ice["extent_5yr_trend"].dropna().iloc[-1]) if "extent_5yr_trend" in ice.columns and len(ice["extent_5yr_trend"].dropna()) > 0 else None,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Arctic Resources | Events: {summary['n_arctic_events']} | Investment: ${total_investment:.1f}bn | Current: {summary['current_signal']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arctic", required=True, dest="arctic_file")
    ap.add_argument("--ice", required=True, dest="ice_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/arctic_resources")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
