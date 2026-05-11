#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lithium_carbonate_ev_demand.py — Lithium price vs EV sales demand signal
==========================================================================
Lithium carbonate/hydroxide prices are driven by EV battery demand (lagged 6-12M).
Rising EV sales → rising lithium demand → bullish for lithium miners (ALB, SQM, LTHM).
Supply: concentrated in Chile's Atacama salt flats + Australia hard rock.

Inputs (CSV)
------------
--lithium  lithium_prices.csv
    Columns: date, lce_price_usd_ton, loh_price_usd_ton (optional), source
--ev_sales ev_sales.csv
    Columns: date, country, ev_sales_k, total_auto_sales_k, ev_penetration_pct
--stocks   stock_returns.csv
    Columns: date, ticker, return (ALB, SQM, LTHM, PLL, etc.)

Outputs
-------
outdir/lithium_signals.csv      date, lce_price, ev_sales_yoy_pct, demand_score, signal
outdir/ev_vs_lithium.csv        EV sales lead-lag vs lithium price
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


LITHIUM_MINER_TICKERS = ["alb", "sqm", "lthm", "pll", "lac", "li", "lithium"]


def compute_demand_score(ev_yoy: float, ev_pen: float, li_zscore: float) -> float:
    score = 0
    if not np.isnan(ev_yoy):
        score += min(ev_yoy / 20, 2)  # 40%+ YoY growth → max score
    if not np.isnan(ev_pen):
        score += ev_pen / 10  # 10% penetration → 1 pt
    if not np.isnan(li_zscore):
        score += li_zscore * 0.5  # Price momentum
    return score


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    lithium = pd.read_csv(cfg.lithium_file, parse_dates=["date"])
    lithium.columns = [c.lower().strip() for c in lithium.columns]
    lithium = lithium.set_index("date").sort_index()
    ev = pd.read_csv(cfg.ev_sales_file, parse_dates=["date"])
    ev.columns = [c.lower().strip() for c in ev.columns]
    stocks = pd.read_csv(cfg.stocks_file, parse_dates=["date"])
    stocks.columns = [c.lower().strip() for c in stocks.columns]
    ret_wide = stocks.pivot(index="date", columns="ticker", values="return").sort_index()

    li_col = "lce_price_usd_ton" if "lce_price_usd_ton" in lithium.columns else lithium.columns[0]
    lithium["li_yoy_pct"] = lithium[li_col].pct_change(252) * 100
    lithium["li_mom_pct"] = lithium[li_col].pct_change(21) * 100
    lithium["li_zscore"] = (lithium[li_col] - lithium[li_col].rolling(252).mean()) / \
                            lithium[li_col].rolling(252).std().replace(0, np.nan)

    # Aggregate EV sales globally
    ev_global = ev.groupby("date").agg(
        total_ev_k=("ev_sales_k", "sum"),
        avg_penetration=("ev_penetration_pct", "mean")
    ).sort_index()
    ev_global["ev_yoy_pct"] = ev_global["total_ev_k"].pct_change(12) * 100  # monthly YoY

    merged = lithium.join(ev_global, how="outer").ffill()

    signal_records = []
    for date, row in merged.iterrows():
        li_price = row.get(li_col, np.nan)
        li_z = row.get("li_zscore", np.nan)
        ev_yoy = row.get("ev_yoy_pct", np.nan)
        ev_pen = row.get("avg_penetration", np.nan)
        demand_score = compute_demand_score(ev_yoy, ev_pen, li_z)

        signal = "buy_miners" if demand_score > cfg.buy_threshold else \
                 ("sell_miners" if demand_score < -cfg.buy_threshold else "neutral")

        signal_records.append({
            "date": date,
            "lce_price_usd_ton": float(li_price) if not np.isnan(li_price) else None,
            "li_yoy_pct": float(row.get("li_yoy_pct", np.nan)) if not np.isnan(row.get("li_yoy_pct", np.nan)) else None,
            "li_zscore": float(li_z) if not np.isnan(li_z) else None,
            "ev_yoy_pct": float(ev_yoy) if not np.isnan(ev_yoy) else None,
            "ev_penetration_pct": float(ev_pen) if not np.isnan(ev_pen) else None,
            "demand_score": float(demand_score), "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "lithium_signals.csv"), index=False)

    # EV sales vs lithium price lead-lag
    corr_records = []
    li_ret = lithium[li_col].pct_change().dropna()
    ev_yoy_series = ev_global["ev_yoy_pct"].dropna()
    for lag_months in [3, 6, 9, 12]:
        fwd_li = li_ret.rolling(lag_months * 21).sum().shift(-lag_months * 21)
        ev_aligned = ev_yoy_series.reindex(li_ret.index).ffill().dropna()
        aligned = ev_aligned.align(fwd_li.dropna(), join="inner")
        if len(aligned[0]) > 15:
            r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
            corr_records.append({"lag_months": lag_months, "ev_vs_li_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

    corr_df = pd.DataFrame(corr_records) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "ev_vs_lithium.csv"), index=False)

    # Backtest on lithium miner stocks
    all_daily = []
    for ticker in ret_wide.columns:
        if any(m in ticker.lower() for m in LITHIUM_MINER_TICKERS):
            pos = sig_df.set_index("date")["signal"].map({"buy_miners": 1, "neutral": 0, "sell_miners": -1}).fillna(0)
            pos_daily = pos.reindex(ret_wide.index).ffill().shift(1).fillna(0)
            strat = pos_daily * ret_wide[ticker]
            all_daily.append(strat.rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    current_li = float(lithium[li_col].iloc[-1]) if not lithium.empty else None
    summary = {
        "current_lce_price_usd_ton": current_li,
        "current_signal": str(sig_df["signal"].iloc[-1]) if not sig_df.empty else None,
        "n_buy_signals": int((sig_df["signal"] == "buy_miners").sum()) if not sig_df.empty else 0,
        "best_ev_lead_lag_months": int(corr_df.loc[corr_df["ev_vs_li_corr"].abs().idxmax(), "lag_months"]) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"buy_threshold": cfg.buy_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Lithium/EV | LCE: ${current_li:,.0f}/ton | Signal: {summary['current_signal']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lithium", required=True, dest="lithium_file")
    ap.add_argument("--ev-sales", required=True, dest="ev_sales_file")
    ap.add_argument("--stocks", required=True, dest="stocks_file")
    ap.add_argument("--buy-threshold", type=float, default=1.0)
    ap.add_argument("--outdir", default="./artifacts/lithium_ev")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
