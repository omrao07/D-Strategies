#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sovereign_cds_vs_bonds.py — Sovereign CDS vs bond yield divergence → arb & risk signal
=========================================================================================
The CDS-bond basis (CDS spread - equivalent bond spread) should be near zero in
efficient markets. Positive basis = CDS expensive vs cash bonds → sell CDS / buy bonds.
Negative basis = CDS cheap → buy CDS / sell bonds. Also tracks CDS as a sovereign
default risk early warning system.

Inputs (CSV)
------------
--cds     sovereign_cds.csv
    Columns: date, country, cds_5y_bps, cds_10y_bps
--bonds   sovereign_bonds.csv
    Columns: date, country, yield_5y_pct, yield_10y_pct, us_treasury_5y_pct
--assets  asset_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/cds_bond_basis.csv       date, country, cds_5y, bond_spread_5y, basis_bps, signal
outdir/sovereign_risk.csv       country risk ranking by CDS level and trajectory
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def compute_bond_spread(bond_yield: float, us_rate: float) -> float:
    """Bond spread over US Treasuries in basis points."""
    return (bond_yield - us_rate) * 100


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    cds = pd.read_csv(cfg.cds_file, parse_dates=["date"])
    cds.columns = [c.lower().strip() for c in cds.columns]
    bonds = pd.read_csv(cfg.bonds_file, parse_dates=["date"])
    bonds.columns = [c.lower().strip() for c in bonds.columns]
    assets = pd.read_csv(cfg.assets_file, parse_dates=["date"])
    assets.columns = [c.lower().strip() for c in assets.columns]
    ret_wide = assets.pivot(index="date", columns="ticker", values="return").sort_index()

    merged = cds.merge(bonds, on=["date", "country"], how="inner").sort_values(["country", "date"])

    basis_records = []
    risk_records = []
    all_daily = []

    for country in merged["country"].unique():
        sub = merged[merged["country"] == country].set_index("date").sort_index()
        if len(sub) < 20:
            continue

        us_rate = sub.get("us_treasury_5y_pct", pd.Series(3.0, index=sub.index))
        sub["bond_spread_5y_bps"] = sub.apply(
            lambda r: compute_bond_spread(r.get("yield_5y_pct", np.nan), us_rate.get(r.name, 3.0)), axis=1
        )
        sub["basis_bps"] = sub.get("cds_5y_bps", pd.Series(np.nan)) - sub["bond_spread_5y_bps"]
        sub["basis_zscore"] = (sub["basis_bps"] - sub["basis_bps"].rolling(60).mean()) / \
                               sub["basis_bps"].rolling(60).std().replace(0, np.nan)

        # CDS trajectory (30d change)
        sub["cds_30d_chg"] = sub.get("cds_5y_bps", pd.Series(np.nan)).diff(30)
        sub["cds_zscore"] = (sub.get("cds_5y_bps", pd.Series(np.nan)) -
                             sub.get("cds_5y_bps", pd.Series(np.nan)).rolling(60).mean()) / \
                            sub.get("cds_5y_bps", pd.Series(np.nan)).rolling(60).std().replace(0, np.nan)

        for date, row in sub.iterrows():
            basis = row.get("basis_bps", np.nan)
            basis_z = row.get("basis_zscore", np.nan)
            cds_z = row.get("cds_zscore", np.nan)

            if not np.isnan(basis_z):
                basis_signal = "sell_cds_buy_bonds" if basis_z > cfg.basis_threshold else \
                               ("buy_cds_sell_bonds" if basis_z < -cfg.basis_threshold else "neutral")
            else:
                basis_signal = "neutral"

            risk_level = "crisis" if (not np.isnan(cds_z) and cds_z > 3) else \
                         ("elevated" if (not np.isnan(cds_z) and cds_z > 1.5) else "normal")

            basis_records.append({
                "date": date, "country": country,
                "cds_5y_bps": float(row.get("cds_5y_bps", np.nan)),
                "bond_spread_5y_bps": float(row.get("bond_spread_5y_bps", np.nan)),
                "basis_bps": float(basis) if not np.isnan(basis) else None,
                "basis_zscore": float(basis_z) if not np.isnan(basis_z) else None,
                "cds_zscore": float(cds_z) if not np.isnan(cds_z) else None,
                "basis_signal": basis_signal, "risk_level": risk_level
            })

        # Risk ranking snapshot (latest)
        latest = sub.iloc[-1]
        risk_records.append({
            "country": country,
            "latest_cds_5y_bps": float(latest.get("cds_5y_bps", np.nan)),
            "cds_30d_chg_bps": float(latest.get("cds_30d_chg", np.nan)),
            "risk_level": basis_records[-1]["risk_level"] if basis_records else "normal"
        })

        # Backtest: fade basis signal on related asset (if available)
        country_upper = country.upper()
        etf_map = {"BRAZIL": "EWZ", "TURKEY": "TUR", "INDIA": "INDA", "MEXICO": "EWW",
                   "SOUTH_AFRICA": "EZA", "ARGENTINA": "ARGT", "ITALY": "EWI", "SPAIN": "EWP"}
        ticker = etf_map.get(country_upper, country_upper)
        if ticker in ret_wide.columns:
            basis_sig_series = sub["basis_zscore"].apply(
                lambda z: -1 if z > cfg.basis_threshold else (1 if z < -cfg.basis_threshold else 0)
            )
            pos_daily = basis_sig_series.reindex(ret_wide.index, method="ffill").shift(1).fillna(0)
            strat = pos_daily * ret_wide[ticker]
            all_daily.append(strat.rename(country))

    basis_df = pd.DataFrame(basis_records).sort_values("date")
    basis_df.to_csv(os.path.join(cfg.outdir, "cds_bond_basis.csv"), index=False)

    risk_df = pd.DataFrame(risk_records).sort_values("latest_cds_5y_bps", ascending=False)
    risk_df.to_csv(os.path.join(cfg.outdir, "sovereign_risk.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    summary = {
        "n_countries": merged["country"].nunique(),
        "n_crisis_risk_days": int((basis_df["risk_level"] == "crisis").sum()) if not basis_df.empty else 0,
        "n_basis_signals": int((basis_df["basis_signal"] != "neutral").sum()) if not basis_df.empty else 0,
        "avg_basis_bps": float(basis_df["basis_bps"].dropna().mean()) if not basis_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"basis_threshold": cfg.basis_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Sovereign CDS | Countries: {summary['n_countries']} | Crisis days: {summary['n_crisis_risk_days']} | Basis signals: {summary['n_basis_signals']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cds", required=True, dest="cds_file")
    ap.add_argument("--bonds", required=True, dest="bonds_file")
    ap.add_argument("--assets", required=True, dest="assets_file")
    ap.add_argument("--basis-threshold", type=float, default=1.5)
    ap.add_argument("--outdir", default="./artifacts/sovereign_cds")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
