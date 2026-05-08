#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
treasury_futures_basis.py — Cash vs Futures Basis / CTD Bond Arbitrage
=======================================================================
What it does:
    Computes the gross basis and net basis between Treasury cash bonds and
    Treasury futures contracts. Identifies the cheapest-to-deliver (CTD)
    bond for each futures contract and generates signals when the net basis
    exceeds 10 ticks (1 tick = 1/32 of a point).

Inputs (CSV format):
    treasury_cash.csv  — columns: date, cusip, coupon, maturity, price, ytm
        date      : YYYY-MM-DD
        cusip     : 9-character CUSIP identifier
        coupon    : annual coupon rate in percent (e.g. 2.5)
        maturity  : YYYY-MM-DD maturity date
        price     : clean price per $100 face value
        ytm       : yield to maturity in percent

    futures.csv — columns: date, contract, price, delivery_date, conversion_factor
        date              : YYYY-MM-DD
        contract          : e.g. TYU24 (10Y Sep 2024)
        price             : futures price per $100
        delivery_date     : YYYY-MM-DD last delivery date
        conversion_factor : CF for bond vs futures (float ~0.7-1.3)

CLI:
    python treasury_futures_basis.py \\
        --cash treasury_cash.csv \\
        --futures futures.csv \\
        --repo-rate 5.30 \\
        --outdir ./output \\
        --signal-threshold 10

Outputs (written to outdir/):
    basis_signals.csv   — daily basis calculations + signals
    ctd_bonds.csv       — identified CTD bond per contract per day
    summary.json        — strategy summary statistics
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_cash(path: str) -> pd.DataFrame:
    """Load and validate treasury cash bond data."""
    df = pd.read_csv(path, parse_dates=["date", "maturity"])
    required = {"date", "cusip", "coupon", "maturity", "price", "ytm"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"treasury_cash.csv missing columns: {missing}")
    df = df.sort_values(["date", "cusip"]).reset_index(drop=True)
    return df


def load_futures(path: str) -> pd.DataFrame:
    """Load and validate futures data."""
    df = pd.read_csv(path, parse_dates=["date", "delivery_date"])
    required = {"date", "contract", "price", "delivery_date", "conversion_factor"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"futures.csv missing columns: {missing}")
    df = df.sort_values(["date", "contract"]).reset_index(drop=True)
    return df


# ---------------------------------------------------------------------------
# Core calculations
# ---------------------------------------------------------------------------

def compute_accrued_interest(coupon: float, days_since_coupon: int, coupon_period_days: int = 182) -> float:
    """
    Compute accrued interest using actual/actual day count.
    coupon: annual coupon rate in percent
    """
    semi_annual_coupon = coupon / 2.0
    accrued = semi_annual_coupon * (days_since_coupon / coupon_period_days)
    return accrued


def compute_carry(
    clean_price: float,
    accrued: float,
    coupon: float,
    repo_rate: float,
    days_to_delivery: int,
) -> float:
    """
    Carry = coupon income - repo cost, per $100 face over holding period.
    carry = (coupon × days/365) - (full_price × repo_rate × days/360)
    """
    full_price = clean_price + accrued
    coupon_income = coupon * (days_to_delivery / 365.0)
    repo_cost = full_price * (repo_rate / 100.0) * (days_to_delivery / 360.0)
    return coupon_income - repo_cost


def price_to_ticks(price_diff: float) -> float:
    """Convert price difference (per $100) to ticks (32nds of a point)."""
    return price_diff * 32.0


def identify_ctd(group: pd.DataFrame) -> pd.Series:
    """
    Identify CTD bond as the one with the lowest net basis.
    Returns the row corresponding to the CTD.
    """
    if group.empty:
        return None
    idx = group["net_basis"].idxmin()
    return group.loc[idx]


def compute_basis(
    cash_df: pd.DataFrame,
    futures_df: pd.DataFrame,
    repo_rate: float,
    signal_threshold_ticks: float,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Main computation: gross basis, net basis, CTD identification, signals.

    gross_basis = cash_price - futures_price × CF
    net_basis   = gross_basis - carry (in price terms)
    """
    records = []
    ctd_records = []

    dates = sorted(set(cash_df["date"]) & set(futures_df["date"]))

    for dt in dates:
        cash_day = cash_df[cash_df["date"] == dt].copy()
        fut_day = futures_df[futures_df["date"] == dt].copy()

        for _, fut_row in fut_day.iterrows():
            contract = fut_row["contract"]
            fut_price = fut_row["price"]
            delivery_date = fut_row["delivery_date"]
            cf = fut_row["conversion_factor"]

            days_to_delivery = max((delivery_date - dt).days, 1)

            for _, bond_row in cash_day.iterrows():
                # Estimate accrued interest (assume last coupon 91 days ago for simplicity)
                accrued = compute_accrued_interest(bond_row["coupon"], days_since_coupon=91)
                carry = compute_carry(
                    clean_price=bond_row["price"],
                    accrued=accrued,
                    coupon=bond_row["coupon"],
                    repo_rate=repo_rate,
                    days_to_delivery=days_to_delivery,
                )

                gross_basis = bond_row["price"] - (fut_price * cf)
                net_basis = gross_basis - carry
                net_basis_ticks = price_to_ticks(net_basis)

                records.append(
                    {
                        "date": dt,
                        "contract": contract,
                        "cusip": bond_row["cusip"],
                        "coupon": bond_row["coupon"],
                        "cash_price": bond_row["price"],
                        "futures_price": fut_price,
                        "conversion_factor": cf,
                        "accrued_interest": round(accrued, 4),
                        "carry": round(carry, 4),
                        "gross_basis": round(gross_basis, 6),
                        "net_basis": round(net_basis, 6),
                        "net_basis_ticks": round(net_basis_ticks, 4),
                        "days_to_delivery": days_to_delivery,
                        "signal": "ARBIT" if net_basis_ticks > signal_threshold_ticks else "NONE",
                    }
                )

        # Identify CTD: minimum net basis per contract
        contract_groups = [g for _, g in pd.DataFrame(records).groupby("contract") if (pd.DataFrame(records)["date"] == dt).any()]
        day_records = [r for r in records if r["date"] == dt]
        if day_records:
            day_df = pd.DataFrame(day_records)
            for contract, grp in day_df.groupby("contract"):
                ctd_row = grp.loc[grp["net_basis"].idxmin()]
                ctd_records.append(
                    {
                        "date": dt,
                        "contract": contract,
                        "ctd_cusip": ctd_row["cusip"],
                        "ctd_coupon": ctd_row["coupon"],
                        "ctd_cash_price": ctd_row["cash_price"],
                        "ctd_net_basis": ctd_row["net_basis"],
                        "ctd_net_basis_ticks": ctd_row["net_basis_ticks"],
                    }
                )

    basis_df = pd.DataFrame(records)
    ctd_df = pd.DataFrame(ctd_records)
    return basis_df, ctd_df


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_outputs(basis_df: pd.DataFrame, ctd_df: pd.DataFrame, outdir: str, signal_threshold: float) -> dict:
    """Write CSVs and JSON summary."""
    os.makedirs(outdir, exist_ok=True)

    basis_path = os.path.join(outdir, "basis_signals.csv")
    ctd_path = os.path.join(outdir, "ctd_bonds.csv")
    summary_path = os.path.join(outdir, "summary.json")

    basis_df.to_csv(basis_path, index=False)
    ctd_df.to_csv(ctd_path, index=False)

    signals = basis_df[basis_df["signal"] == "ARBIT"]
    summary = {
        "strategy": "treasury_futures_basis",
        "total_observations": int(len(basis_df)),
        "signal_threshold_ticks": signal_threshold,
        "total_signals": int(len(signals)),
        "signal_rate_pct": round(len(signals) / max(len(basis_df), 1) * 100, 2),
        "avg_net_basis_ticks": round(float(basis_df["net_basis_ticks"].mean()), 4) if not basis_df.empty else 0.0,
        "max_net_basis_ticks": round(float(basis_df["net_basis_ticks"].max()), 4) if not basis_df.empty else 0.0,
        "min_net_basis_ticks": round(float(basis_df["net_basis_ticks"].min()), 4) if not basis_df.empty else 0.0,
        "unique_contracts": int(basis_df["contract"].nunique()) if not basis_df.empty else 0,
        "unique_cusips": int(basis_df["cusip"].nunique()) if not basis_df.empty else 0,
        "date_range": {
            "start": str(basis_df["date"].min()) if not basis_df.empty else None,
            "end": str(basis_df["date"].max()) if not basis_df.empty else None,
        },
        "output_files": {
            "basis_signals": basis_path,
            "ctd_bonds": ctd_path,
        },
    }

    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2, default=str)

    print(f"[treasury_futures_basis] Wrote {len(basis_df)} rows to {basis_path}")
    print(f"[treasury_futures_basis] Wrote {len(ctd_df)} CTD records to {ctd_path}")
    print(f"[treasury_futures_basis] {len(signals)} ARBIT signals (threshold={signal_threshold} ticks)")
    print(f"[treasury_futures_basis] Summary: {summary_path}")

    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    parser = argparse.ArgumentParser(
        description="Treasury Futures Basis — CTD Bond Arbitrage"
    )
    parser.add_argument("--cash", required=True, help="Path to treasury_cash.csv")
    parser.add_argument("--futures", required=True, help="Path to futures.csv")
    parser.add_argument(
        "--repo-rate", type=float, default=5.30,
        help="Overnight repo rate in percent (default: 5.30)"
    )
    parser.add_argument(
        "--signal-threshold", type=float, default=10.0,
        help="Net basis signal threshold in ticks (default: 10)"
    )
    parser.add_argument("--outdir", default="./output_treasury_basis", help="Output directory")
    return parser.parse_args()


def main():
    args = parse_args()

    print(f"[treasury_futures_basis] Loading cash bonds from: {args.cash}")
    cash_df = load_cash(args.cash)

    print(f"[treasury_futures_basis] Loading futures from: {args.futures}")
    futures_df = load_futures(args.futures)

    print(f"[treasury_futures_basis] Computing basis (repo={args.repo_rate}%, threshold={args.signal_threshold} ticks)...")
    basis_df, ctd_df = compute_basis(cash_df, futures_df, args.repo_rate, args.signal_threshold)

    summary = write_outputs(basis_df, ctd_df, args.outdir, args.signal_threshold)

    print("\n=== STRATEGY SUMMARY ===")
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
