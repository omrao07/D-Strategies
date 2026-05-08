#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
corporate_bond_cds_basis.py — Bond Spread vs CDS Spread Basis Trade
=====================================================================
What it does:
    Computes the CDS-bond basis for corporate credits and generates signals
    for positive basis trades (buy bond + buy CDS protection) and negative
    basis trades (buy bond + sell CDS protection / receive default premium).

    CDS-Bond Basis = CDS spread - Bond spread (Z-spread or ASW spread)

    Positive basis (basis > +50bps): CDS is cheap relative to bond spread.
        Trade: Short bond / Buy CDS protection (funding basis trade).
    Negative basis (basis < -20bps): Bond spread is cheap relative to CDS.
        Trade: Buy bond / Sell CDS protection (basis package).

Inputs (CSV format):
    bonds.csv — columns: date, ticker, maturity, spread_bps, rating
        date       : YYYY-MM-DD
        ticker     : issuer ticker (e.g. IBM, AAPL)
        maturity   : YYYY-MM-DD bond maturity
        spread_bps : Z-spread or ASW spread in basis points
        rating     : credit rating (e.g. AAA, AA+, BBB-)

    cds.csv — columns: date, ticker, tenor, cds_spread_bps
        date           : YYYY-MM-DD
        ticker         : issuer ticker (must match bonds.csv)
        tenor          : CDS tenor in years (e.g. 5)
        cds_spread_bps : CDS spread in basis points

CLI:
    python corporate_bond_cds_basis.py \\
        --bonds bonds.csv \\
        --cds cds.csv \\
        --positive-threshold 50 \\
        --negative-threshold -20 \\
        --cds-tenor 5 \\
        --outdir ./output

Outputs (written to outdir/):
    cds_bond_basis.csv  — daily CDS-bond basis per name
    signals.csv         — trade signals with direction + sizing
    summary.json        — strategy statistics
"""

import argparse
import json
import os

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_bonds(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date", "maturity"])
    required = {"date", "ticker", "maturity", "spread_bps", "rating"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"bonds.csv missing columns: {missing}")
    df = df.sort_values(["date", "ticker"]).reset_index(drop=True)
    return df


def load_cds(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "ticker", "tenor", "cds_spread_bps"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"cds.csv missing columns: {missing}")
    df = df.sort_values(["date", "ticker"]).reset_index(drop=True)
    return df


# ---------------------------------------------------------------------------
# Rating utilities
# ---------------------------------------------------------------------------

RATING_RANK = {
    "AAA": 1, "AA+": 2, "AA": 3, "AA-": 4,
    "A+": 5, "A": 6, "A-": 7,
    "BBB+": 8, "BBB": 9, "BBB-": 10,
    "BB+": 11, "BB": 12, "BB-": 13,
    "B+": 14, "B": 15, "B-": 16,
    "CCC+": 17, "CCC": 18, "CCC-": 19, "CC": 20, "C": 21, "D": 22,
}

def is_investment_grade(rating: str) -> bool:
    rank = RATING_RANK.get(rating.strip().upper(), 99)
    return rank <= 10  # BBB- and above


def rating_bucket(rating: str) -> str:
    rank = RATING_RANK.get(rating.strip().upper(), 99)
    if rank <= 4:
        return "AAA-AA"
    elif rank <= 7:
        return "A"
    elif rank <= 10:
        return "BBB"
    elif rank <= 13:
        return "BB"
    else:
        return "B-and-below"


# ---------------------------------------------------------------------------
# Core computation
# ---------------------------------------------------------------------------

def match_bond_to_cds(bonds_day: pd.DataFrame, cds_day: pd.DataFrame, cds_tenor: int) -> pd.DataFrame:
    """
    Match bonds to CDS by ticker and nearest maturity to cds_tenor years from today.
    """
    cds_filtered = cds_day[cds_day["tenor"] == cds_tenor].copy()
    merged = bonds_day.merge(cds_filtered[["ticker", "cds_spread_bps"]], on="ticker", how="inner")
    return merged


def compute_basis_metrics(merged: pd.DataFrame) -> pd.DataFrame:
    """
    Compute CDS-bond basis and carry-adjusted basis.
    basis = CDS spread - bond spread
    """
    df = merged.copy()
    df["basis_bps"] = df["cds_spread_bps"] - df["spread_bps"]

    # Carry-adjusted basis: basis net of repo/funding cost (~25bps assumption)
    df["funding_cost_bps"] = 25.0
    df["net_basis_bps"] = df["basis_bps"] - df["funding_cost_bps"]

    # Rolling z-score per ticker (computed cross-sectionally here for single-date)
    if len(df) > 1:
        mean_basis = df["basis_bps"].mean()
        std_basis = df["basis_bps"].std()
        df["basis_zscore"] = (df["basis_bps"] - mean_basis) / (std_basis + 1e-9)
    else:
        df["basis_zscore"] = 0.0

    df["ig_flag"] = df["rating"].apply(is_investment_grade)
    df["rating_bucket"] = df["rating"].apply(rating_bucket)

    return df


def generate_signals(
    basis_df: pd.DataFrame,
    positive_threshold: float,
    negative_threshold: float,
) -> pd.DataFrame:
    """
    Generate trade signals based on basis thresholds.

    POSITIVE BASIS TRADE (basis > threshold):
        - Buy bond (receive spread) + Buy CDS protection (pay CDS spread)
        - Profit if basis tightens / bond spread widens less than CDS
        - Expressed as: SHORT bond risk via CDS vs LONG physical bond carry

    NEGATIVE BASIS TRADE (basis < threshold):
        - Buy bond + Sell CDS protection
        - Profit if basis widens / bond richens vs CDS
    """
    df = basis_df.copy()
    conditions = [
        df["basis_bps"] > positive_threshold,
        df["basis_bps"] < negative_threshold,
    ]
    choices = ["POSITIVE_BASIS_TRADE", "NEGATIVE_BASIS_TRADE"]
    df["signal"] = np.select(conditions, choices, default="NONE")

    # Signal strength (normalized)
    df["signal_strength"] = np.where(
        df["basis_bps"] > positive_threshold,
        (df["basis_bps"] - positive_threshold) / positive_threshold,
        np.where(
            df["basis_bps"] < negative_threshold,
            (negative_threshold - df["basis_bps"]) / abs(negative_threshold),
            0.0,
        ),
    ).round(4)

    # Recommended notional weight (proportional to signal strength, capped at 100%)
    df["notional_weight"] = df["signal_strength"].clip(0, 1.0).round(4)

    return df


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def compute_rolling_basis(basis_df: pd.DataFrame) -> pd.DataFrame:
    """Compute 20-day rolling mean and std of basis per ticker."""
    basis_df = basis_df.sort_values(["ticker", "date"])
    basis_df["basis_roll_20d_mean"] = (
        basis_df.groupby("ticker")["basis_bps"]
        .transform(lambda x: x.rolling(20, min_periods=5).mean())
        .round(2)
    )
    basis_df["basis_roll_20d_std"] = (
        basis_df.groupby("ticker")["basis_bps"]
        .transform(lambda x: x.rolling(20, min_periods=5).std())
        .round(2)
    )
    return basis_df


def write_outputs(
    basis_df: pd.DataFrame,
    outdir: str,
    pos_threshold: float,
    neg_threshold: float,
) -> dict:
    os.makedirs(outdir, exist_ok=True)

    basis_path = os.path.join(outdir, "cds_bond_basis.csv")
    signals_path = os.path.join(outdir, "signals.csv")
    summary_path = os.path.join(outdir, "summary.json")

    basis_df.to_csv(basis_path, index=False)

    signals_df = basis_df[basis_df["signal"] != "NONE"].copy()
    signals_df.to_csv(signals_path, index=False)

    pos_signals = basis_df[basis_df["signal"] == "POSITIVE_BASIS_TRADE"]
    neg_signals = basis_df[basis_df["signal"] == "NEGATIVE_BASIS_TRADE"]

    summary = {
        "strategy": "corporate_bond_cds_basis",
        "total_observations": int(len(basis_df)),
        "positive_threshold_bps": pos_threshold,
        "negative_threshold_bps": neg_threshold,
        "positive_basis_signals": int(len(pos_signals)),
        "negative_basis_signals": int(len(neg_signals)),
        "avg_basis_bps": round(float(basis_df["basis_bps"].mean()), 2) if not basis_df.empty else 0.0,
        "median_basis_bps": round(float(basis_df["basis_bps"].median()), 2) if not basis_df.empty else 0.0,
        "max_basis_bps": round(float(basis_df["basis_bps"].max()), 2) if not basis_df.empty else 0.0,
        "min_basis_bps": round(float(basis_df["basis_bps"].min()), 2) if not basis_df.empty else 0.0,
        "unique_tickers": int(basis_df["ticker"].nunique()) if not basis_df.empty else 0,
        "date_range": {
            "start": str(basis_df["date"].min()) if not basis_df.empty else None,
            "end": str(basis_df["date"].max()) if not basis_df.empty else None,
        },
        "output_files": {
            "cds_bond_basis": basis_path,
            "signals": signals_path,
        },
    }

    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2, default=str)

    print(f"[cds_bond_basis] Wrote {len(basis_df)} rows to {basis_path}")
    print(f"[cds_bond_basis] {len(pos_signals)} positive basis + {len(neg_signals)} negative basis signals")
    print(f"[cds_bond_basis] Summary: {summary_path}")

    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    parser = argparse.ArgumentParser(description="Corporate Bond CDS Basis Trade")
    parser.add_argument("--bonds", required=True, help="Path to bonds.csv")
    parser.add_argument("--cds", required=True, help="Path to cds.csv")
    parser.add_argument("--positive-threshold", type=float, default=50.0,
                        help="Positive basis signal threshold in bps (default: 50)")
    parser.add_argument("--negative-threshold", type=float, default=-20.0,
                        help="Negative basis signal threshold in bps (default: -20)")
    parser.add_argument("--cds-tenor", type=int, default=5,
                        help="CDS tenor to use for matching (default: 5 years)")
    parser.add_argument("--outdir", default="./output_cds_basis", help="Output directory")
    return parser.parse_args()


def main():
    args = parse_args()

    print(f"[cds_bond_basis] Loading bonds from: {args.bonds}")
    bonds_df = load_bonds(args.bonds)

    print(f"[cds_bond_basis] Loading CDS from: {args.cds}")
    cds_df = load_cds(args.cds)

    all_records = []
    dates = sorted(set(bonds_df["date"]) & set(cds_df["date"]))
    print(f"[cds_bond_basis] Processing {len(dates)} dates...")

    for dt in dates:
        bonds_day = bonds_df[bonds_df["date"] == dt]
        cds_day = cds_df[cds_df["date"] == dt]
        matched = match_bond_to_cds(bonds_day, cds_day, args.cds_tenor)
        if matched.empty:
            continue
        with_metrics = compute_basis_metrics(matched)
        with_metrics["date"] = dt
        all_records.append(with_metrics)

    if not all_records:
        print("[cds_bond_basis] No matched data found. Check ticker alignment between bonds and CDS files.")
        return

    basis_df = pd.concat(all_records, ignore_index=True)
    basis_df = compute_rolling_basis(basis_df)
    basis_df = generate_signals(basis_df, args.positive_threshold, args.negative_threshold)

    summary = write_outputs(basis_df, args.outdir, args.positive_threshold, args.negative_threshold)
    print("\n=== STRATEGY SUMMARY ===")
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
