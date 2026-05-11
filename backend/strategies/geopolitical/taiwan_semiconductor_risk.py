#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
taiwan_semiconductor_risk.py — Taiwan strait tension vs semiconductor sector
=============================================================================
Taiwan produces ~90% of advanced logic chips (TSMC). Escalating China-Taiwan
tensions → semiconductor supply chain risk → bearish for fabless (NVDA, AMD,
QCOM, AAPL) → bullish for domestic fabs (Intel CHIPS Act beneficiaries) and
equipment makers (AMAT, LRCX, KLAC). TSMC itself → uncertain.

Inputs (CSV)
------------
--tension  taiwan_tension.csv
    Columns: date, event_type, severity (1-10), description,
             china_military_activity (bool), us_response (bool)
--semis    semi_prices.csv
    Columns: date, ticker, close (TSMC, NVDA, AMD, INTC, AMAT, etc.)

Outputs
-------
outdir/taiwan_signals.csv     date, tension_score, signal
outdir/tension_vs_semis.csv   tension events and semi stock impact
outdir/backtest.csv           cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


TAIWAN_DEPENDENT = ["nvda", "amd", "qcom", "aapl", "marvell", "mediatek", "tsm"]
DOMESTIC_FABS = ["intc", "smc", "gfs", "umc"]
EQUIPMENT = ["amat", "lrcx", "klac", "asml", "ter", "entg"]

MILITARY_EVENTS = ["military", "exercise", "incursion", "invasion", "blockade", "missile"]
DIPLOMATIC_EVENTS = ["visit", "statement", "sanction", "arms", "recognition", "treaty"]


def compute_tension_score(events_subset: pd.DataFrame) -> pd.Series:
    all_dates = pd.date_range(events_subset["date"].min(), events_subset["date"].max() + pd.Timedelta(days=60), freq="B")
    score = pd.Series(0.0, index=all_dates)
    for _, row in events_subset.iterrows():
        sev = float(row.get("severity", 5))
        is_military = any(m in str(row.get("event_type", "")).lower() for m in MILITARY_EVENTS)
        multiplier = 1.5 if is_military else 1.0
        us_response = bool(row.get("us_response", False))
        if us_response:
            multiplier *= 0.7  # US deterrence reduces escalation risk
        magnitude = sev * multiplier
        for i in range(40):
            fd = row["date"] + pd.Timedelta(days=i)
            if fd in score.index:
                score.loc[fd] = max(score.loc[fd], magnitude * (1 - i / 40))
    return score


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    tension = pd.read_csv(cfg.tension_file, parse_dates=["date"])
    tension.columns = [c.lower().strip() for c in tension.columns]
    tension = tension.sort_values("date")
    semis = pd.read_csv(cfg.semis_file, parse_dates=["date"])
    semis.columns = [c.lower().strip() for c in semis.columns]
    semi_wide = semis.pivot(index="date", columns="ticker", values="close").sort_index()
    semi_ret = semi_wide.pct_change()

    tension_score = compute_tension_score(tension)
    tension_rolling = tension_score.rolling(5).mean()

    # Tension events vs semi stock impact
    impact_records = []
    for _, ev in tension.iterrows():
        ev_date = ev["date"]
        sev = float(ev.get("severity", 5))
        ev_type = str(ev.get("event_type", ""))
        for ticker in TAIWAN_DEPENDENT[:5]:
            if ticker in semi_ret.columns:
                fwd_30 = semi_ret[ticker].rolling(21).sum().reindex([ev_date + pd.Timedelta(days=30)], method="nearest")
                if len(fwd_30) > 0:
                    impact_records.append({
                        "date": ev_date, "event_type": ev_type, "severity": sev,
                        "ticker": ticker,
                        "30d_return_pct": float(fwd_30.iloc[0] * 100)
                    })

    if impact_records:
        pd.DataFrame(impact_records).sort_values("date").to_csv(
            os.path.join(cfg.outdir, "tension_vs_semis.csv"), index=False)

    # TTension vs semi correlation
    corr_records = []
    for ticker in semi_ret.columns:
        ret_s = semi_ret[ticker].dropna()
        aligned = tension_rolling.align(ret_s, join="inner")
        if len(aligned[0]) > 30:
            r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
            corr_records.append({"ticker": ticker, "tension_corr": float(r), "pvalue": float(p)})

    signal_records = []
    for date in semi_ret.index:
        t_score = float(tension_rolling.reindex([date]).ffill().iloc[0]) if date in tension_rolling.index or len(tension_rolling) > 0 else 0

        if t_score > 7:
            signal = "sell_taiwan_dependent_buy_domestic_fabs"
        elif t_score > 4:
            signal = "underweight_fabless_overweight_equipment"
        elif t_score > 2:
            signal = "mild_underweight_fabless"
        elif t_score < 1:
            signal = "overweight_fabless"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date, "tension_score": float(t_score), "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "taiwan_signals.csv"), index=False)

    # Backtest: long domestic fabs + equipment, short taiwan-dependent on high tension
    SIG_POS = {"sell_taiwan_dependent_buy_domestic_fabs": 1,
               "underweight_fabless_overweight_equipment": 0.5,
               "mild_underweight_fabless": 0.25, "neutral": 0, "overweight_fabless": -0.5}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for ticker in semi_ret.columns:
        t = ticker.lower()
        direction = 1 if any(d in t for d in DOMESTIC_FABS + EQUIPMENT) else \
                    (-1 if any(d in t for d in TAIWAN_DEPENDENT) else 0)
        if direction == 0:
            continue
        pos_daily = (pos * direction).reindex(semi_ret.index).ffill().shift(1).fillna(0)
        all_daily.append((pos_daily * semi_ret[ticker]).rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_events": len(tension),
        "n_military_events": int(tension["event_type"].str.lower().apply(lambda x: any(m in x for m in MILITARY_EVENTS)).sum()),
        "max_tension_score": float(tension_score.max()),
        "current_tension_score": float(tension_score.iloc[-1]) if len(tension_score) > 0 else None,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Taiwan Semi Risk | Events: {summary['n_events']} | Military: {summary['n_military_events']} | Max tension: {summary['max_tension_score']:.1f} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tension", required=True, dest="tension_file")
    ap.add_argument("--semis", required=True, dest="semis_file")
    ap.add_argument("--outdir", default="./artifacts/taiwan_semi")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
