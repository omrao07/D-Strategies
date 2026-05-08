#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
btc_futures_basis_trading.py — BTC spot/futures basis capture (cash-and-carry)
================================================================================
When BTC futures trade at a premium to spot, borrow USD, buy BTC spot, short
futures → harvest the basis. When futures trade at a discount (backwardation),
do the reverse. This strategy measures annualized basis and signals when it
exceeds transaction/funding costs.

Inputs (CSV)
------------
--basis    btc_basis.csv
    Columns: date, spot_price, futures_price, futures_expiry (days),
             funding_rate_8h (perpetual), exchange (optional)

Outputs
-------
outdir/basis_signals.csv        date, annualized_basis_pct, signal, carry_net
outdir/carry_backtest.csv       cumulative carry P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


ANNUALIZE = 365.0


def compute_annualized_basis(spot: float, futures: float, days_to_expiry: float) -> float:
    if days_to_expiry <= 0 or spot <= 0:
        return np.nan
    return (futures / spot - 1) * (ANNUALIZE / days_to_expiry) * 100


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    df = pd.read_csv(cfg.basis_file, parse_dates=["date"])
    df.columns = [c.lower().strip() for c in df.columns]
    df = df.sort_values("date").reset_index(drop=True)

    records = []
    for _, row in df.iterrows():
        spot = row["spot_price"]
        fut = row["futures_price"]
        dte = row.get("futures_expiry", 30)
        funding_8h = row.get("funding_rate_8h", 0) or 0

        ann_basis = compute_annualized_basis(spot, fut, dte)
        # Perpetual funding annualized: 3 payments/day × 365
        funding_ann = funding_8h * 3 * 365 * 100

        # Effective carry = basis - funding cost (for futures short) - transaction cost
        net_carry = ann_basis - cfg.funding_cost_pct - cfg.transaction_cost_pct
        perp_carry = funding_ann - cfg.transaction_cost_pct

        signal = "cash_and_carry" if ann_basis > cfg.min_basis_threshold else \
                 ("reverse_carry" if ann_basis < -cfg.min_basis_threshold else "neutral")
        perp_signal = "long_perp_harvest_funding" if funding_ann < -cfg.min_basis_threshold else \
                      ("short_perp_harvest_funding" if funding_ann > cfg.min_basis_threshold else "neutral")

        records.append({
            "date": row["date"],
            "spot_price": float(spot), "futures_price": float(fut),
            "annualized_basis_pct": float(ann_basis) if not np.isnan(ann_basis) else None,
            "funding_ann_pct": float(funding_ann),
            "net_carry_pct": float(net_carry) if not np.isnan(ann_basis) else None,
            "perp_carry_pct": float(perp_carry),
            "signal": signal, "perp_signal": perp_signal
        })

    out = pd.DataFrame(records)
    out.to_csv(os.path.join(cfg.outdir, "basis_signals.csv"), index=False)

    # Backtest: daily carry accrual when signal is active
    out_clean = out.dropna(subset=["net_carry_pct"])
    out_clean = out_clean.set_index("date").sort_index()
    # Carry accrues daily at annualized rate / 365
    carry_daily = out_clean.apply(
        lambda r: r["net_carry_pct"] / 100 / ANNUALIZE if r["signal"] == "cash_and_carry"
                  else (-r["net_carry_pct"] / 100 / ANNUALIZE if r["signal"] == "reverse_carry" else 0), axis=1
    )
    perp_daily = out_clean.apply(
        lambda r: abs(r["perp_carry_pct"]) / 100 / (365 * 3) if r["perp_signal"] != "neutral" else 0, axis=1
    )
    total_carry = (carry_daily + perp_daily)
    cum = (1 + total_carry).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "carry_backtest.csv"))

    active = out[out["signal"] != "neutral"]
    summary = {
        "n_observations": len(out), "n_active_carry_days": len(active),
        "avg_annualized_basis_pct": float(out["annualized_basis_pct"].dropna().mean()),
        "max_basis_pct": float(out["annualized_basis_pct"].dropna().max()),
        "avg_net_carry_pct": float(out_clean["net_carry_pct"].mean()),
        "ann_carry_return": float(total_carry.mean() * ANNUALIZE),
        "params": {"min_basis_threshold": cfg.min_basis_threshold,
                   "funding_cost_pct": cfg.funding_cost_pct,
                   "transaction_cost_pct": cfg.transaction_cost_pct}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"BTC basis | Active days: {len(active)} | Avg basis: {summary['avg_annualized_basis_pct']:.2f}% | Ann carry: {summary['ann_carry_return']:.2%} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--basis", required=True, dest="basis_file")
    ap.add_argument("--min-basis-threshold", type=float, default=5.0, help="Annualized basis %% to trigger signal")
    ap.add_argument("--funding-cost-pct", type=float, default=2.0, help="Annualized funding/borrowing cost %%")
    ap.add_argument("--transaction-cost-pct", type=float, default=0.5, help="Round-trip transaction cost %%")
    ap.add_argument("--outdir", default="./artifacts/btc_basis")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
