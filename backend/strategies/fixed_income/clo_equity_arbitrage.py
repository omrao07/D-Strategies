#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
clo_equity_arbitrage.py — CLO equity tranche vs leveraged loan spread arb
===========================================================================
CLO equity tranches receive residual cash flows after paying senior tranches.
The equity IRR depends on: (1) leveraged loan spread, (2) SOFR, (3) default rates,
(4) CLO spread compression. When CLO equity implied spread > leveraged loan market
spread, equity is cheap → buy. Reverse → sell.

Inputs (CSV)
------------
--clo      clo_data.csv
    Columns: date, clo_id, equity_irr_pct, equity_nav, bb_tranche_spread_bps,
             aaa_tranche_spread_bps, loan_portfolio_spread_bps, reinvestment_period_yr
--loans    leveraged_loans.csv
    Columns: date, loan_spread_bps, default_rate_pct, recovery_rate_pct, sofr_pct

Outputs
-------
outdir/clo_signals.csv          date, clo_id, arb_spread_bps, signal, conviction
outdir/market_conditions.csv    date, market spread, implied default, signal
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy.optimize import brentq


def compute_clo_equity_irr(loan_spread_bps: float, aaa_spread_bps: float, bb_spread_bps: float,
                             sofr: float, default_rate: float, recovery: float = 0.65,
                             leverage: float = 9.0) -> float:
    """
    Simplified CLO equity return:
    Equity receives: loan portfolio spread - weighted cost of debt liabilities - expected losses
    Levered return = (loan spread - weighted funding cost - expected loss) * leverage / equity_pct
    """
    equity_pct = 1.0 / (1 + leverage)  # typically ~10% equity
    debt_pct = 1 - equity_pct

    # Weighted average liability spread (simplified: 80% AAA, 20% BB)
    weighted_liab_spread = 0.8 * aaa_spread_bps + 0.2 * bb_spread_bps
    total_funding_cost = sofr + weighted_liab_spread / 10000

    # Expected loss
    expected_loss = default_rate * (1 - recovery)

    # Equity spread (excess over funding) — leveraged
    equity_spread = (loan_spread_bps / 10000 - weighted_liab_spread / 10000 - expected_loss) * (1 / equity_pct)
    return float(equity_spread * 100)  # in pct


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    clo = pd.read_csv(cfg.clo_file, parse_dates=["date"])
    clo.columns = [c.lower().strip() for c in clo.columns]
    loans = pd.read_csv(cfg.loans_file, parse_dates=["date"])
    loans.columns = [c.lower().strip() for c in loans.columns]
    loans = loans.set_index("date").sort_index()

    signal_records = []
    all_daily = []

    for clo_id in clo["clo_id"].unique():
        sub = clo[clo["clo_id"] == clo_id].set_index("date").sort_index()
        if len(sub) < 4:
            continue

        for date, row in sub.iterrows():
            loan_row = loans.reindex(method="ffill").loc[:date].iloc[-1] if len(loans) > 0 else pd.Series()
            loan_spread = float(row.get("loan_portfolio_spread_bps", loan_row.get("loan_spread_bps", 400)))
            aaa_spread = float(row.get("aaa_tranche_spread_bps", 150))
            bb_spread = float(row.get("bb_tranche_spread_bps", 550))
            sofr = float(loan_row.get("sofr_pct", 5.0)) / 100
            default_rate = float(loan_row.get("default_rate_pct", 2.0)) / 100
            recovery = float(loan_row.get("recovery_rate_pct", 65.0)) / 100
            reported_irr = float(row.get("equity_irr_pct", np.nan))

            implied_irr = compute_clo_equity_irr(loan_spread, aaa_spread, bb_spread, sofr, default_rate, recovery)
            irr_gap = implied_irr - reported_irr if not np.isnan(reported_irr) else 0

            # Arb: implied IRR > market loan spread → CLO equity cheaper than direct lending
            market_loan_irr = (loan_spread / 10000 - default_rate * (1 - recovery)) * 100
            arb_spread_bps = (implied_irr - market_loan_irr) * 100

            signal = "buy_clo_equity" if arb_spread_bps > cfg.arb_threshold_bps else \
                     ("sell_clo_equity" if arb_spread_bps < -cfg.arb_threshold_bps else "neutral")

            signal_records.append({
                "date": date, "clo_id": clo_id,
                "loan_spread_bps": float(loan_spread),
                "implied_equity_irr_pct": float(implied_irr),
                "reported_equity_irr_pct": float(reported_irr) if not np.isnan(reported_irr) else None,
                "market_loan_irr_pct": float(market_loan_irr),
                "arb_spread_bps": float(arb_spread_bps),
                "signal": signal, "conviction": min(abs(arb_spread_bps) / 100, 3.0)
            })

    sig_df = pd.DataFrame(signal_records).sort_values(["date", "arb_spread_bps"], ascending=[True, False])
    sig_df.to_csv(os.path.join(cfg.outdir, "clo_signals.csv"), index=False)

    # Market conditions over time
    market_records = []
    for date, loan_row in loans.iterrows():
        ls = float(loan_row.get("loan_spread_bps", np.nan))
        dr = float(loan_row.get("default_rate_pct", np.nan))
        signal = "buy_risk" if ls > 450 else ("sell_risk" if ls < 350 else "neutral")
        market_records.append({"date": date, "loan_spread_bps": ls, "default_rate_pct": dr, "signal": signal})
    pd.DataFrame(market_records).sort_values("date").to_csv(os.path.join(cfg.outdir, "market_conditions.csv"), index=False)

    # Backtest: simulated CLO equity returns
    if not sig_df.empty:
        port = sig_df.groupby("date").apply(
            lambda g: (g[g["signal"] == "buy_clo_equity"]["conviction"].sum() -
                       g[g["signal"] == "sell_clo_equity"]["conviction"].sum()) * 0.002  # 0.2% per conviction point
        )
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_clos": clo["clo_id"].nunique(), "n_signals": len(sig_df),
        "n_buy_signals": int((sig_df["signal"] == "buy_clo_equity").sum()) if not sig_df.empty else 0,
        "avg_arb_spread_bps": float(sig_df["arb_spread_bps"].mean()) if not sig_df.empty else None,
        "avg_implied_irr_pct": float(sig_df["implied_equity_irr_pct"].mean()) if not sig_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"arb_threshold_bps": cfg.arb_threshold_bps}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"CLO equity arb | CLOs: {summary['n_clos']} | Buy signals: {summary['n_buy_signals']} | Avg implied IRR: {summary['avg_implied_irr_pct']:.1f}% | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clo", required=True, dest="clo_file")
    ap.add_argument("--loans", required=True, dest="loans_file")
    ap.add_argument("--arb-threshold-bps", type=float, default=100.0)
    ap.add_argument("--outdir", default="./artifacts/clo_arb")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
