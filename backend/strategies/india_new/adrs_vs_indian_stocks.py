#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
adrs_vs_indian_stocks.py — India ADR premium/discount vs domestic stock arbitrage
==================================================================================
Indian ADRs (INFY, WIT, HDB, IBN, SIFY) trade on NYSE and reflect after-hours
sentiment. ADR premium/discount to NSE equivalent (adjusted for FX) predicts
domestic open direction. Persistent discount → mean reversion opportunity.

Inputs (CSV)
------------
--adrs     adr_prices.csv
    Columns: date, ticker, adr_price_usd, domestic_price_inr, usdinr,
             adr_ratio (shares per ADR)
--returns  stock_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/adr_signals.csv      date, ticker, adr_premium_pct, signal
outdir/arbitrage_analysis.csv  premium persistence and mean reversion stats
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


ADR_TICKERS = {
    "INFY": "Infosys", "WIT": "Wipro", "HDB": "HDFC Bank",
    "IBN": "ICICI Bank", "SIFY": "Sify", "VEDL": "Vedanta", "TTM": "Tata Motors"
}
PREMIUM_THRESHOLD = 1.5    # % premium over parity
DISCOUNT_THRESHOLD = -1.5  # % discount below parity


def compute_adr_parity(adr_price_usd: float, domestic_inr: float, usdinr: float, ratio: float) -> float:
    if ratio <= 0 or usdinr <= 0:
        return np.nan
    implied_usd = (domestic_inr / usdinr) * ratio
    return (adr_price_usd / implied_usd - 1) * 100  # premium %


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    adrs = pd.read_csv(cfg.adrs_file, parse_dates=["date"])
    adrs.columns = [c.lower().strip() for c in adrs.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    usdinr_col = "usdinr" if "usdinr" in adrs.columns else None
    ratio_col = "adr_ratio" if "adr_ratio" in adrs.columns else None
    adr_col = "adr_price_usd" if "adr_price_usd" in adrs.columns else "adr_price"
    dom_col = "domestic_price_inr" if "domestic_price_inr" in adrs.columns else "domestic_price"

    signal_records = []
    arb_records = []

    for ticker in adrs["ticker"].str.upper().unique():
        sub = adrs[adrs["ticker"].str.upper() == ticker].set_index("date").sort_index()
        if sub.empty:
            continue

        if usdinr_col and ratio_col:
            sub["adr_premium_pct"] = sub.apply(
                lambda r: compute_adr_parity(
                    r.get(adr_col, np.nan),
                    r.get(dom_col, np.nan),
                    r.get(usdinr_col, np.nan),
                    r.get(ratio_col, 1)
                ), axis=1
            )
        elif usdinr_col:
            sub["adr_premium_pct"] = (sub[adr_col] / (sub[dom_col] / sub[usdinr_col]) - 1) * 100
        else:
            sub["adr_premium_pct"] = np.nan

        sub["premium_ma5"] = sub["adr_premium_pct"].rolling(5).mean()
        sub["premium_zscore"] = (sub["adr_premium_pct"] - sub["adr_premium_pct"].rolling(60).mean()) / \
                                 sub["adr_premium_pct"].rolling(60).std().replace(0, np.nan)

        # Arbitrage statistics: how long does premium persist?
        prem = sub["adr_premium_pct"].dropna()
        if len(prem) > 30:
            autocorr_1d = float(prem.autocorr(1))
            mean_rev_speed = 1 - autocorr_1d  # proxy
            arb_records.append({
                "ticker": ticker,
                "avg_premium_pct": float(prem.mean()),
                "std_premium_pct": float(prem.std()),
                "autocorr_1d": autocorr_1d,
                "mean_rev_speed": mean_rev_speed,
                "n_premium_days": int((prem > PREMIUM_THRESHOLD).sum()),
                "n_discount_days": int((prem < DISCOUNT_THRESHOLD).sum())
            })

        for date, row in sub.iterrows():
            prem_val = row.get("adr_premium_pct", np.nan)
            prem_z = row.get("premium_zscore", np.nan)

            if np.isnan(prem_val):
                signal = "no_data"
            elif prem_val > PREMIUM_THRESHOLD * 2:
                signal = "strong_sell_domestic"  # ADR expensive → domestic expected to catch up
            elif prem_val > PREMIUM_THRESHOLD:
                signal = "mild_sell_domestic"
            elif prem_val < DISCOUNT_THRESHOLD * 2:
                signal = "strong_buy_domestic"   # ADR cheap → domestic expected to fall or ADR to rise
            elif prem_val < DISCOUNT_THRESHOLD:
                signal = "mild_buy_domestic"
            else:
                signal = "neutral"

            signal_records.append({
                "date": date, "ticker": ticker,
                "adr_price_usd": float(row.get(adr_col, np.nan)) if not np.isnan(row.get(adr_col, np.nan)) else None,
                "adr_premium_pct": float(prem_val) if not np.isnan(prem_val) else None,
                "premium_zscore": float(prem_z) if not np.isnan(prem_z) else None,
                "signal": signal
            })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "adr_signals.csv"), index=False)

    if arb_records:
        pd.DataFrame(arb_records).to_csv(os.path.join(cfg.outdir, "arbitrage_analysis.csv"), index=False)

    # Backtest
    SIG_POS = {"strong_buy_domestic": 1.5, "mild_buy_domestic": 0.5, "neutral": 0,
               "mild_sell_domestic": -0.5, "strong_sell_domestic": -1.5}
    all_daily = []
    for ticker in sig_df["ticker"].unique():
        ticker_upper = ticker.upper()
        if ticker_upper not in ret_wide.columns:
            continue
        pos = sig_df[sig_df["ticker"] == ticker].set_index("date")["signal"].map(SIG_POS).fillna(0)
        ret_s = ret_wide[ticker_upper].dropna()
        pos_daily = pos.reindex(ret_s.index).ffill().shift(1).fillna(0)
        all_daily.append((pos_daily * ret_s).rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "tickers_tracked": sig_df["ticker"].unique().tolist(),
        "n_buy_signals": int(sig_df["signal"].str.contains("buy").sum()),
        "n_sell_signals": int(sig_df["signal"].str.contains("sell").sum()),
        "arbitrage_stats": arb_records,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"premium_threshold": PREMIUM_THRESHOLD, "discount_threshold": DISCOUNT_THRESHOLD}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"ADR Arb | Tickers: {len(summary['tickers_tracked'])} | Buy: {summary['n_buy_signals']} | Sell: {summary['n_sell_signals']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adrs", required=True, dest="adrs_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/adr_arb")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
