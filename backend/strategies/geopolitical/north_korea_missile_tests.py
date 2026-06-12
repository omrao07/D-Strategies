#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
north_korea_missile_tests.py — DPRK missile tests vs Korean/Japanese asset reaction
=====================================================================================
North Korea missile tests create short-term risk-off in Korean (KOSPI) and Japanese
(Nikkei) assets. South Korean defense stocks (LIG Nex1, Hanwha, Korea Aerospace)
rally. JPY strengthens (safe haven). Pattern: spike → mean reversion within 2-5 days.
US defense contractors (LMT, RTX, NOC) benefit on escalation cycles.

Inputs (CSV)
------------
--tests    missile_tests.csv
    Columns: date, test_type (ICBM/SRBM/IRBM/submarine/nuclear), severity (1-10),
             range_km, description, un_response (bool)
--returns  stock_returns.csv
    Columns: date, ticker, return (KOSPI, EWY, EWJ, LMT, RTX, NOC, JPY, etc.)

Outputs
-------
outdir/dprk_signals.csv         date, test_severity, dprk_risk_score, signal
outdir/test_market_reaction.csv  test event → 1/3/5/10-day market reaction
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

DEFENSE_TICKERS = ["lmt", "rtx", "noc", "ba", "lig", "hanwha", "kai"]
RISK_OFF_TICKERS = ["ewy", "ewj", "kospi", "krw", "yen", "jpy"]  # sell on tests
SAFE_HAVEN = ["jpy", "yen", "usdkrw", "gold", "tlt"]

TEST_SEVERITY_MAP = {
    "icbm": 9, "nuclear": 10, "irbm": 7, "submarine": 8,
    "srbm": 5, "ballistic": 6, "cruise": 4
}
DECAY_DAYS = 10  # market impact decays over ~10 trading days


def classify_test_severity(test_type: str, base_severity: float) -> float:
    test_lower = str(test_type).lower()
    for key, sev in TEST_SEVERITY_MAP.items():
        if key in test_lower:
            return max(base_severity, sev)
    return base_severity


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    tests = pd.read_csv(cfg.tests_file, parse_dates=["date"])
    tests.columns = [c.lower().strip() for c in tests.columns]
    tests = tests.sort_values("date")
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    # Build DPRK risk score
    all_dates = ret_wide.index
    dprk_risk = pd.Series(0.0, index=all_dates)

    market_reaction_records = []
    for _, ev in tests.iterrows():
        ev_date = ev["date"]
        base_sev = float(ev.get("severity", 5))
        test_type = str(ev.get("test_type", "ballistic"))
        sev = classify_test_severity(test_type, base_sev)
        un_response = bool(ev.get("un_response", False))
        if un_response:
            sev *= 1.2  # escalation with UN response

        for i in range(DECAY_DAYS):
            fd = ev_date + pd.Timedelta(days=i)
            if fd in dprk_risk.index:
                decay = sev * (1 - i / DECAY_DAYS)
                dprk_risk.loc[fd] = max(dprk_risk.loc[fd], decay)

        # Market reaction analysis
        for fwd_days in [1, 3, 5, 10]:
            for ticker in list(ret_wide.columns)[:8]:
                fwd_ret = ret_wide[ticker].rolling(fwd_days).sum().reindex(
                    [ev_date + pd.Timedelta(days=fwd_days)], method="nearest"
                )
                if len(fwd_ret) > 0:
                    market_reaction_records.append({
                        "date": ev_date, "test_type": test_type,
                        "severity": sev, "ticker": ticker,
                        "fwd_days": fwd_days,
                        "return_pct": float(fwd_ret.iloc[0] * 100)
                    })

    if market_reaction_records:
        pd.DataFrame(market_reaction_records).sort_values("date").to_csv(
            os.path.join(cfg.outdir, "test_market_reaction.csv"), index=False)

    # Reaction pattern: mean reversion timing
    reaction_df = pd.DataFrame(market_reaction_records) if market_reaction_records else pd.DataFrame()

    signal_records = []
    for date in all_dates:
        risk = float(dprk_risk.loc[date]) if date in dprk_risk.index else 0
        (risk - dprk_risk.rolling(252).mean().reindex([date]).ffill().iloc[0]) / \
                 (dprk_risk.rolling(252).std().reindex([date]).ffill().iloc[0] + 1e-10) \
                 if date in dprk_risk.index else 0

        is_test_day = bool((tests["date"] - date).abs().min() <= pd.Timedelta(days=1)) if len(tests) > 0 else False
        days_since_test = int((date - tests["date"][tests["date"] <= date].max()).days) if len(tests[tests["date"] <= date]) > 0 else 999

        if is_test_day or days_since_test <= 1:
            signal = "sell_ewy_ewj_buy_defense"
        elif days_since_test <= 5 and risk > 3:
            signal = "hold_defense_underweight_korea_japan"
        elif days_since_test <= DECAY_DAYS and risk < 2:
            signal = "mean_revert_buy_ewy_ewj"
        elif risk < 1:
            signal = "overweight_korea_japan"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date,
            "dprk_risk_score": float(risk),
            "days_since_test": days_since_test if days_since_test < 999 else None,
            "is_test_day": bool(is_test_day),
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "dprk_signals.csv"), index=False)

    # Backtest: sell Korean/Japanese ETFs on test, buy defense
    SIG_POS = {"sell_ewy_ewj_buy_defense": 1, "hold_defense_underweight_korea_japan": 0.5,
               "neutral": 0, "mean_revert_buy_ewy_ewj": -0.5, "overweight_korea_japan": -0.5}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for ticker in ret_wide.columns:
        t = ticker.lower()
        is_defense = any(d in t for d in DEFENSE_TICKERS)
        is_risk_off = any(r in t for r in RISK_OFF_TICKERS)
        direction = 1 if is_defense else (-1 if is_risk_off else 0)
        if direction == 0:
            continue
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

    icbm_count = int(tests["test_type"].str.lower().str.contains("icbm").sum()) if "test_type" in tests.columns else 0
    summary = {
        "n_tests": len(tests),
        "n_icbm_tests": icbm_count,
        "avg_severity": float(tests.get("severity", pd.Series([5])).mean()),
        "max_dprk_risk_score": float(dprk_risk.max()),
        "avg_1d_defense_return_on_test": float(reaction_df[(reaction_df["fwd_days"] == 1) & (reaction_df["ticker"].str.lower().isin(DEFENSE_TICKERS))]["return_pct"].mean()) if not reaction_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"DPRK Missiles | Tests: {summary['n_tests']} | ICBMs: {icbm_count} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tests", required=True, dest="tests_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/dprk_missiles")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
