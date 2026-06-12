#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_vix_term_structure.py — India VIX term structure roll yield strategy
==========================================================================
India VIX (IVIX) measures 30-day implied volatility from NIFTY options.
Unlike CBOE VIX, India VIX is computed from near- and mid-month options and
is typically in contango (near < far) during calm markets. This strategy
captures roll yield when the term structure is steep, and pivots to long
volatility during inversion (backwardation).

India moat: IVIX futures were launched by NSE in 2014 but delisted. Traders
now replicate via NIFTY options straddles. This strategy identifies
carry-rich environments using the term structure of NIFTY IV across DTE.

Inputs (CSV)
------------
--ivix      ivix.csv          date, ivix_close, ivix_open (optional)
--options   options.csv       date, expiry, type, strike, iv, dte (optional, for term structure)
--nifty     nifty.csv         date, nifty_close

Outputs
-------
outdir/ivix_regimes.csv         date, ivix, 20d_ma, regime, z_score
outdir/term_structure.csv       date, m1_iv, m2_iv, ts_slope, contango
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

# India VIX thresholds (historically calibrated)
IVIX_LOW = 12.0       # IVIX < 12: very low vol, sell premium
IVIX_MODERATE = 18.0  # 12-18: normal
IVIX_HIGH = 25.0      # 18-25: elevated, reduce shorts
IVIX_SPIKE = 35.0     # > 35: crisis, long vol only
MA_WINDOW = 20
STD_WINDOW = 60
CONTANGO_THRESHOLD = 1.5  # bps/day slope to qualify as steep contango


def compute_regime(ivix: float, ma: float, std: float) -> str:
    z = (ivix - ma) / std if std > 0 else 0.0
    if ivix < IVIX_LOW:
        return "very_low"
    elif ivix < IVIX_MODERATE:
        return "low" if z < 0.5 else "low_rising"
    elif ivix < IVIX_HIGH:
        return "moderate"
    elif ivix < IVIX_SPIKE:
        return "elevated"
    else:
        return "crisis"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    ivix = pd.read_csv(cfg.ivix_file, parse_dates=["date"]).set_index("date").sort_index()
    ivix.columns = [c.lower().strip() for c in ivix.columns]
    ivix_col = "ivix_close" if "ivix_close" in ivix.columns else ivix.columns[0]

    nifty = pd.read_csv(cfg.nifty_file, parse_dates=["date"]).set_index("date").sort_index()
    nifty.columns = [c.lower().strip() for c in nifty.columns]
    nifty_col = nifty.columns[0]

    data = ivix[[ivix_col]].rename(columns={ivix_col: "ivix"}).join(
        nifty[[nifty_col]].rename(columns={nifty_col: "nifty"})
    ).dropna()

    # IVIX rolling stats
    data["ma20"] = data["ivix"].rolling(MA_WINDOW).mean()
    data["std60"] = data["ivix"].rolling(STD_WINDOW).std()
    data["z_score"] = (data["ivix"] - data["ma20"]) / data["std60"].replace(0, np.nan)
    data["ivix_1d_change"] = data["ivix"].diff()
    data["ivix_5d_change"] = data["ivix"].diff(5)

    # Regime classification
    data["regime"] = data.apply(
        lambda r: compute_regime(r["ivix"], r["ma20"], r["std60"]) if not np.isnan(r["ma20"]) else "unknown",
        axis=1
    )

    regime_records = []
    for dt, row in data.iterrows():
        regime_records.append({
            "date": dt.date(),
            "ivix": float(row["ivix"]),
            "ma20": float(row["ma20"]) if not np.isnan(row["ma20"]) else None,
            "z_score": float(row["z_score"]) if not np.isnan(row["z_score"]) else None,
            "ivix_1d_change": float(row["ivix_1d_change"]) if not np.isnan(row["ivix_1d_change"]) else None,
            "ivix_5d_change": float(row["ivix_5d_change"]) if not np.isnan(row["ivix_5d_change"]) else None,
            "regime": row["regime"],
            "nifty": float(row["nifty"]),
        })
    pd.DataFrame(regime_records).to_csv(os.path.join(cfg.outdir, "ivix_regimes.csv"), index=False)

    # Term structure from options (if available)
    ts_records = []
    if cfg.options_file and os.path.exists(cfg.options_file):
        opts = pd.read_csv(cfg.options_file, parse_dates=["date", "expiry"])
        opts.columns = [c.lower().strip() for c in opts.columns]

        for date, day_opts in opts.groupby("date"):
            # Get ATM IV for each expiry (use CE closest to ATM)
            if "nifty" in data.columns and date in data.index:
                spot = data.loc[date, "nifty"]
                atm_strike = round(spot / 50) * 50

                expiry_ivs = {}
                for expiry, exp_grp in day_opts.groupby("expiry"):
                    atm_ce = exp_grp[(exp_grp["strike"].between(atm_strike - 100, atm_strike + 100)) &
                                     (exp_grp["type"].str.upper() == "CE")]
                    if not atm_ce.empty and "iv" in atm_ce.columns:
                        expiry_ivs[expiry] = float(atm_ce["iv"].mean())

                if len(expiry_ivs) >= 2:
                    sorted_exp = sorted(expiry_ivs.items())
                    m1_exp, m1_iv = sorted_exp[0]
                    m2_exp, m2_iv = sorted_exp[1]
                    dte_diff = (pd.Timestamp(m2_exp) - pd.Timestamp(m1_exp)).days

                    ts_slope = (m2_iv - m1_iv) / dte_diff if dte_diff > 0 else 0
                    contango = m2_iv > m1_iv

                    ts_records.append({
                        "date": date.date() if hasattr(date, "date") else date,
                        "m1_expiry": str(m1_exp.date()),
                        "m2_expiry": str(m2_exp.date()),
                        "m1_iv": float(m1_iv),
                        "m2_iv": float(m2_iv),
                        "ts_slope_bps_per_day": float(ts_slope * 100),
                        "contango": bool(contango),
                    })

        if ts_records:
            pd.DataFrame(ts_records).to_csv(os.path.join(cfg.outdir, "term_structure.csv"), index=False)

    # Strategy: sell NIFTY premium when IVIX is low/contango; buy when IVIX spikes
    # Signal: -1 = short vol (sell straddle), +1 = long vol (buy straddle), 0 = flat
    def ivix_signal(regime: str, z: float) -> float:
        if pd.isna(z):
            return 0.0
        if regime in ("very_low",) and z < -0.5:
            return -1.0  # Sell premium
        elif regime in ("low",) and z < 0:
            return -0.5  # Light short vol
        elif regime in ("elevated",) and z > 1.0:
            return 0.5   # Light long vol
        elif regime in ("crisis",):
            return 1.0   # Long vol
        return 0.0

    data["signal"] = data.apply(lambda r: ivix_signal(r["regime"], r["z_score"]), axis=1)

    # P&L proxy: short vol → negative when realized vol > IV (use NIFTY actual vol)
    nifty_ret = data["nifty"].pct_change()
    realized_vol = nifty_ret.rolling(5).std() * np.sqrt(252) * 100  # annualised

    # Simple P&L: positive when we sell premium AND realized vol < IVIX
    # Negative when realized vol surprises
    vol_diff = data["ivix"] - realized_vol  # + when selling was profitable
    strat_ret = data["signal"].shift(1) * vol_diff / data["ivix"].replace(0, np.nan) * nifty_ret.abs()
    strat_ret = strat_ret.dropna() / 100  # scale to return

    cum = (1 + strat_ret).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))

    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(252)) if strat_ret.std() > 0 else None

    regime_counts = data["regime"].value_counts().to_dict()
    summary = {
        "avg_ivix": float(data["ivix"].mean()),
        "ivix_pct_below_low": float((data["ivix"] < IVIX_LOW).mean() * 100),
        "ivix_pct_crisis": float((data["ivix"] > IVIX_SPIKE).mean() * 100),
        "regime_distribution": {str(k): int(v) for k, v in regime_counts.items()},
        "n_term_structure_obs": len(ts_records),
        "ann_return": float(strat_ret.mean() * 252),
        "sharpe": sharpe,
        "params": {"ivix_low": IVIX_LOW, "ivix_spike": IVIX_SPIKE, "ma_window": MA_WINDOW}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"India VIX Term Structure | Avg IVIX: {summary['avg_ivix']:.1f} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ivix", required=True, dest="ivix_file")
    ap.add_argument("--nifty", required=True, dest="nifty_file")
    ap.add_argument("--options", default=None, dest="options_file")
    ap.add_argument("--outdir", default="./artifacts/india_vix_ts")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
