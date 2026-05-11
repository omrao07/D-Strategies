#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
us_china_trade_war.py — US-China trade war tariff events vs sector rotation
=============================================================================
Tariff escalation events → bearish for US companies with China revenue exposure
(semiconductors, luxury, agriculture) → bullish for domestic alternatives.
De-escalation → reverse rotation. Tracks tariff rates, trade volumes, diplomatic
events, and supply chain diversification signals.

Inputs (CSV)
------------
--tariffs  tariff_events.csv
    Columns: date, event_type (hike/cut/threat/deal), tariff_rate_pct,
             goods_category, description, sentiment_score (-1 to 1)
--trade    trade_data.csv
    Columns: date, us_exports_china_bn, china_exports_us_bn, trade_deficit_bn
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/trade_war_signals.csv  date, tariff_escalation_score, signal
outdir/event_impact.csv       tariff events and 30-day sector impact
outdir/backtest.csv           cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


CHINA_EXPOSED = ["aapl", "nke", "qcom", "tsm", "intc", "nvda", "amd", "cat", "de"]
DOMESTIC_ALT = ["domestic", "onshoring", "reshoring", "usa_mfg"]
ESCALATION_EVENTS = ["hike", "threat", "sanction", "ban", "restriction"]
DE_ESCALATION_EVENTS = ["cut", "deal", "exemption", "pause", "rollback"]


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    tariffs = pd.read_csv(cfg.tariffs_file, parse_dates=["date"])
    tariffs.columns = [c.lower().strip() for c in tariffs.columns]
    tariffs = tariffs.sort_values("date")
    trade = pd.read_csv(cfg.trade_file, parse_dates=["date"])
    trade.columns = [c.lower().strip() for c in trade.columns]
    trade = trade.set_index("date").sort_index()
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    rate_col = "tariff_rate_pct" if "tariff_rate_pct" in tariffs.columns else None
    sent_col = "sentiment_score" if "sentiment_score" in tariffs.columns else None

    # Build daily escalation score (decaying over 30 days)
    all_dates = pd.date_range(tariffs["date"].min(), tariffs["date"].max(), freq="B")
    escalation_score = pd.Series(0.0, index=all_dates)

    event_records = []
    for _, ev in tariffs.iterrows():
        ev_date = ev["date"]
        ev_type = str(ev.get("event_type", "")).lower()
        rate = float(ev.get(rate_col, 0)) if rate_col else 0
        sent = float(ev.get(sent_col, 0)) if sent_col else 0

        is_escalation = any(e in ev_type for e in ESCALATION_EVENTS)
        is_de_escalation = any(d in ev_type for d in DE_ESCALATION_EVENTS)

        magnitude = (rate / 25 + abs(sent)) * (1 if is_escalation else (-1 if is_de_escalation else 0))
        magnitude = max(-3, min(3, magnitude))

        for i in range(30):
            future_date = ev_date + pd.Timedelta(days=i)
            if future_date in escalation_score.index:
                decay = magnitude * (1 - i / 30)
                escalation_score.loc[future_date] += decay

        # Event impact
        price_at = None
        price_30d = None
        for ticker in CHINA_EXPOSED[:3]:
            if ticker in ret_wide.columns:
                fwd = ret_wide[ticker].rolling(21).sum().reindex([ev_date + pd.Timedelta(days=30)], method="nearest")
                if len(fwd) > 0:
                    price_30d = float(fwd.iloc[0])
                    break

        event_records.append({
            "date": ev_date, "event_type": ev_type,
            "tariff_rate_pct": rate,
            "is_escalation": bool(is_escalation),
            "magnitude": float(magnitude),
            "30d_china_exposed_return": price_30d,
            "description": str(ev.get("description", ""))[:200]
        })

    if event_records:
        pd.DataFrame(event_records).sort_values("date").to_csv(os.path.join(cfg.outdir, "event_impact.csv"), index=False)

    # Trade volume features
    deficit_col = "trade_deficit_bn" if "trade_deficit_bn" in trade.columns else trade.columns[0]
    trade["deficit_yoy"] = trade[deficit_col].pct_change(12) * 100
    trade["deficit_zscore"] = (trade[deficit_col] - trade[deficit_col].rolling(12).mean()) / \
                               trade[deficit_col].rolling(12).std().replace(0, np.nan)

    esc_rolling = escalation_score.rolling(5).mean()
    signal_records = []
    for date in all_dates:
        esc = float(esc_rolling.loc[date]) if date in esc_rolling.index else 0
        deficit_z = float(trade["deficit_zscore"].reindex([date]).ffill().iloc[0]) if len(trade["deficit_zscore"].dropna()) > 0 else np.nan

        if esc > 1.5:
            signal = "sell_china_exposed_buy_domestic"
        elif esc > 0.5:
            signal = "mild_underweight_china_exposed"
        elif esc < -1.0:
            signal = "buy_china_exposed"
        elif esc < -0.3:
            signal = "mild_overweight_china_exposed"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date, "tariff_escalation_score": esc,
            "trade_deficit_zscore": float(deficit_z) if not np.isnan(deficit_z) else None,
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "trade_war_signals.csv"), index=False)

    # Backtest: long domestic, short China-exposed on escalation
    SIG_POS = {"sell_china_exposed_buy_domestic": -1, "mild_underweight_china_exposed": -0.5,
               "neutral": 0, "mild_overweight_china_exposed": 0.5, "buy_china_exposed": 1}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for ticker in ret_wide.columns:
        is_exposed = any(c in ticker.lower() for c in CHINA_EXPOSED)
        if not is_exposed:
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

    summary = {
        "n_tariff_events": len(event_records),
        "n_escalation_events": int(sum(e["is_escalation"] for e in event_records)),
        "n_de_escalation_events": int(sum(not e["is_escalation"] and e["magnitude"] < 0 for e in event_records)),
        "max_escalation_score": float(escalation_score.max()),
        "current_escalation_score": float(escalation_score.iloc[-1]) if len(escalation_score) > 0 else None,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"US-China Trade War | Events: {summary['n_tariff_events']} | Escalations: {summary['n_escalation_events']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tariffs", required=True, dest="tariffs_file")
    ap.add_argument("--trade", required=True, dest="trade_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/us_china_trade")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
