#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Polish Coal Transition Model
============================

Purpose
-------
Model Poland's power system transition from coal to gas + renewables
using a monthly merit-order dispatch approximation.

Outputs
-------
- fleet_enriched.csv
- retire_schedule.csv
- monthly_dispatch.csv
- emissions.csv
- capacity_margin.csv
- summary.json

Design principles
-----------------
- Fuel-bucket level (not unit-commitment)
- Monthly resolution
- Deterministic
- No hidden state
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import pandas as pd


# ─────────────────────────────────────────────────────────────
# Defaults
# ─────────────────────────────────────────────────────────────

DEFAULTS = {
    "eff": {
        "lignite": 0.35,
        "hard_coal": 0.38,
        "ccgt": 0.54,
        "ocgt": 0.35,
        "oil": 0.38,
        "biomass": 0.28,
        "nuclear": 0.90,
        "wind": 1.0,
        "solar": 1.0,
        "hydro": 1.0,
    },
    "co2": {
        "lignite": 1.10,
        "hard_coal": 0.90,
        "ccgt": 0.36,
        "ocgt": 0.56,
        "oil": 0.74,
        "biomass": 0.00,
        "nuclear": 0.00,
        "wind": 0.00,
        "solar": 0.00,
        "hydro": 0.00,
    },
    "avail": {
        "lignite": 0.80,
        "hard_coal": 0.80,
        "ccgt": 0.90,
        "ocgt": 0.85,
        "biomass": 0.85,
        "oil": 0.80,
        "nuclear": 0.90,
        "wind": 0.30,
        "solar": 0.13,
        "hydro": 0.50,
    },
}


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def fuel_norm(x: str) -> str:
    x = str(x).lower()
    if "lignite" in x: return "lignite"
    if "hard" in x or "coal" in x: return "hard_coal"
    if "ccgt" in x or "gas" in x: return "ccgt"
    if "ocgt" in x: return "ocgt"
    if "oil" in x: return "oil"
    if "bio" in x: return "biomass"
    if "nuclear" in x: return "nuclear"
    if "wind" in x: return "wind"
    if "solar" in x: return "solar"
    if "hydro" in x: return "hydro"
    return "other"


def month_range(start: str, end: str) -> pd.DatetimeIndex:
    return pd.period_range(start, end, freq="M").to_timestamp()


# ─────────────────────────────────────────────────────────────
# Loaders
# ─────────────────────────────────────────────────────────────

def load_capacity(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    df.columns = [c.lower() for c in df.columns]
    df["fuel"] = df["fuel"].apply(fuel_norm)
    df["capacity_mw"] = pd.to_numeric(df["capacity_mw"], errors="coerce")
    df["commission_year"] = pd.to_numeric(df.get("commission_year"), errors="coerce")
    df["retirement_year"] = pd.to_numeric(df.get("retirement_year"), errors="coerce")
    return df


def load_demand(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    df["date"] = pd.to_datetime(df["date"]).dt.to_period("M").dt.to_timestamp()
    df["demand_gwh"] = pd.to_numeric(df["demand_gwh"], errors="coerce")
    return df


def load_prices(path: Optional[str]) -> pd.DataFrame:
    if not path:
        return pd.DataFrame()
    df = pd.read_csv(path)
    df["date"] = pd.to_datetime(df["date"]).dt.to_period("M").dt.to_timestamp()
    return df


# ─────────────────────────────────────────────────────────────
# Core logic
# ─────────────────────────────────────────────────────────────

def enrich_fleet(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["efficiency"] = df["fuel"].map(DEFAULTS["eff"])
    df["co2_intensity"] = df["fuel"].map(DEFAULTS["co2"])
    df["availability"] = df["fuel"].map(DEFAULTS["avail"])
    df["retire_year"] = df["retirement_year"].fillna(
        df["commission_year"] + df["fuel"].map({
            "lignite": 45,
            "hard_coal": 45,
            "ccgt": 35,
            "ocgt": 30,
            "biomass": 30,
            "nuclear": 60,
        }).fillna(30)
    )
    return df


def capacity_time_series(
    fleet: pd.DataFrame,
    start: str,
    end: str
) -> pd.DataFrame:
    months = month_range(start, end)
    fuels = fleet["fuel"].unique()

    rows = []
    for d in months:
        y = d.year
        active = fleet[(fleet["commission_year"] <= y) & (fleet["retire_year"] >= y)]
        cap = (
            active.groupby("fuel")["capacity_mw"]
            .sum()
            .reindex(fuels)
            .fillna(0.0)
        )
        for f, v in cap.items():
            rows.append({"date": d, "fuel": f, "capacity_mw": v})

    return pd.DataFrame(rows)


def dispatch(
    demand: pd.DataFrame,
    capacity: pd.DataFrame,
    prices: pd.DataFrame,
    ets_price: float = 80.0
) -> pd.DataFrame:
    rows = []

    for d in demand["date"]:
        load = float(demand.loc[demand["date"] == d, "demand_gwh"])
        cap_m = capacity[capacity["date"] == d]

        stack = []
        for _, r in cap_m.iterrows():
            fuel = r["fuel"]
            cap_gwh = (
                r["capacity_mw"]
                * DEFAULTS["avail"].get(fuel, 0.8)
                * 24 * d.days_in_month / 1000
            )
            cost = (
                prices.get(fuel, 0.0)
                / DEFAULTS["eff"].get(fuel, 0.4)
                + ets_price * DEFAULTS["co2"].get(fuel, 0.0)
            )
            stack.append((fuel, cost, cap_gwh))

        stack.sort(key=lambda x: x[1])

        remaining = load
        for fuel, cost, cap_gwh in stack:
            gen = min(cap_gwh, remaining)
            rows.append({
                "date": d,
                "fuel": fuel,
                "generation_gwh": gen,
                "marginal_cost": cost,
            })
            remaining -= gen
            if remaining <= 0:
                break

    return pd.DataFrame(rows)


def emissions(dispatch_df: pd.DataFrame) -> pd.DataFrame:
    df = dispatch_df.copy()
    df["co2_mt"] = (
        df["generation_gwh"]
        * df["fuel"].map(DEFAULTS["co2"])
        / 1000
    )
    return (
        df.groupby("date", as_index=False)["co2_mt"]
        .sum()
        .rename(columns={"co2_mt": "total_mtco2"})
    )


# ─────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--capacity", required=True)
    ap.add_argument("--demand", required=True)
    ap.add_argument("--prices", default="")
    ap.add_argument("--start", default="2018-01")
    ap.add_argument("--end", default="2035-12")
    ap.add_argument("--outdir", default="out_pl_coal_transition")
    args = ap.parse_args()

    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)

    fleet = enrich_fleet(load_capacity(args.capacity))
    demand = load_demand(args.demand)
    prices = load_prices(args.prices)

    cap_ts = capacity_time_series(fleet, args.start, args.end)
    disp = dispatch(demand, cap_ts, prices)
    emis = emissions(disp)

    fleet.to_csv(out / "fleet_enriched.csv", index=False)
    cap_ts.to_csv(out / "capacity_ts.csv", index=False)
    disp.to_csv(out / "monthly_dispatch.csv", index=False)
    emis.to_csv(out / "emissions.csv", index=False)

    summary = {
        "period": f"{args.start}..{args.end}",
        "total_emissions_mt": float(emis["total_mtco2"].sum()),
        "coal_share_pct": float(
            disp[disp["fuel"].isin(["lignite", "hard_coal"])]["generation_gwh"].sum()
            / disp["generation_gwh"].sum()
            * 100
        ),
    }

    (out / "summary.json").write_text(json.dumps(summary, indent=2))

    print("Polish Coal Transition model complete.")
    print("Outputs in:", out.resolve())


if __name__ == "__main__":
    main()