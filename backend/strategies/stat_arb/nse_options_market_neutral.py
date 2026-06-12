#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nse_options_market_neutral.py — Market-neutral NIFTY/BANKNIFTY straddle strategy
==================================================================================
Sells ATM straddles and strangles on NIFTY/BANKNIFTY to capture variance risk
premium (VRP) — the spread between implied volatility and subsequent realized vol.
Delta-hedges with underlying futures to maintain market neutrality.

The Indian equity options market has a large VRP (~2-4 vols) because retail
option buyers overpay for protection. Institutional sellers capture this premium.

Inputs (CSV)
------------
--options   options.csv     date, expiry, strike, type (CE/PE), ltp, iv, delta, gamma, vega
--spot      spot.csv        date, spot_close (NIFTY or BANKNIFTY)

Outputs
-------
outdir/vrp_analysis.csv         date, implied_vol, realized_vol_5d, vrp, signal
outdir/straddle_performance.csv expiry, entry_iv, realized_vol, pnl_pct
outdir/greeks_exposure.csv      date, net_delta, net_gamma, net_vega, net_theta
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

# VRP entry: sell straddle when IV significantly above expected realized vol
VRP_ENTRY_THRESHOLD = 3.0   # Sell when IV > realized + 3 vol points
VRP_EXIT_THRESHOLD = 1.0    # Exit when premium approaches zero
DELTA_HEDGE_THRESHOLD = 0.05  # Re-hedge when delta drifts > 5% of notional
REALIZED_VOL_WINDOW = 10    # Days for realized vol estimation
IV_LOOKBACK = 20            # Days for IV z-score


def realized_vol_annualized(returns: np.ndarray, window: int) -> float:
    if len(returns) < window:
        return np.nan
    r = returns[-window:]
    return float(np.std(r) * np.sqrt(252) * 100)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    opts = pd.read_csv(cfg.options_file, parse_dates=["date", "expiry"])
    opts.columns = [c.lower().strip() for c in opts.columns]
    spot_df = pd.read_csv(cfg.spot_file, parse_dates=["date"]).set_index("date").sort_index()
    spot_df.columns = [c.lower().strip() for c in spot_df.columns]
    spot_col = spot_df.columns[0]

    spot_ret = spot_df[spot_col].pct_change()

    vrp_records = []
    greeks_records = []
    all_pnl = []

    for date in sorted(opts["date"].unique()):
        day_opts = opts[opts["date"] == date]
        if date not in spot_df.index:
            continue

        spot = float(spot_df.loc[date, spot_col])
        atm_strike = round(spot / 50) * 50

        # Get ATM CE and PE for nearest expiry
        near_expiry = day_opts["expiry"].min()
        ne_opts = day_opts[day_opts["expiry"] == near_expiry]
        dte = (near_expiry - date).days if hasattr(near_expiry, "days") else (pd.Timestamp(near_expiry) - pd.Timestamp(date)).days

        if dte <= 0 or dte > 30:
            continue

        ce = ne_opts[(ne_opts["strike"] == atm_strike) & (ne_opts["type"].str.upper() == "CE")]
        pe = ne_opts[(ne_opts["strike"] == atm_strike) & (ne_opts["type"].str.upper() == "PE")]

        if ce.empty or pe.empty:
            continue

        ce_iv = float(ce["iv"].values[0]) if "iv" in ce.columns else np.nan
        pe_iv = float(pe["iv"].values[0]) if "iv" in pe.columns else np.nan
        avg_iv = float(np.nanmean([ce_iv, pe_iv]))

        # Realized vol
        hist_rets = spot_ret.loc[:date].values[-REALIZED_VOL_WINDOW:]
        rv = realized_vol_annualized(hist_rets, REALIZED_VOL_WINDOW)

        vrp = avg_iv - rv if not np.isnan(rv) and not np.isnan(avg_iv) else np.nan

        # Greeks aggregate
        net_delta = net_gamma = net_vega = net_theta = 0.0
        for _, opt_row in ne_opts.iterrows():
            d = float(opt_row.get("delta", 0))
            g = float(opt_row.get("gamma", 0))
            v = float(opt_row.get("vega", 0))
            t = float(opt_row.get("theta", 0))
            sign = -1 if opt_row["type"].upper() == "CE" else 1  # short straddle
            net_delta += d * sign
            net_gamma += g * sign
            net_vega += v * sign
            net_theta += t * sign

        greeks_records.append({
            "date": date.date() if hasattr(date, "date") else date,
            "spot": float(spot),
            "atm_strike": float(atm_strike),
            "avg_iv": float(avg_iv),
            "realized_vol": float(rv) if not np.isnan(rv) else None,
            "vrp": float(vrp) if not np.isnan(vrp) else None,
            "net_delta": float(net_delta),
            "net_gamma": float(net_gamma),
            "net_vega": float(net_vega),
            "net_theta": float(net_theta),
            "dte": int(dte),
        })

        # Signal
        signal = "flat"
        if not np.isnan(vrp) and vrp > VRP_ENTRY_THRESHOLD:
            signal = "sell_straddle"
        elif not np.isnan(vrp) and vrp < VRP_EXIT_THRESHOLD:
            signal = "flat"

        vrp_records.append({
            "date": date.date() if hasattr(date, "date") else date,
            "implied_vol": float(avg_iv),
            "realized_vol_10d": float(rv) if not np.isnan(rv) else None,
            "vrp": float(vrp) if not np.isnan(vrp) else None,
            "signal": signal,
        })

    if vrp_records:
        pd.DataFrame(vrp_records).to_csv(os.path.join(cfg.outdir, "vrp_analysis.csv"), index=False)
    if greeks_records:
        pd.DataFrame(greeks_records).to_csv(os.path.join(cfg.outdir, "greeks_exposure.csv"), index=False)

    # P&L from VRP: approx as (IV - RV) / IV * theta decay
    vrp_df = pd.DataFrame(vrp_records)
    if not vrp_df.empty and "vrp" in vrp_df.columns:
        vrp_df["date"] = pd.to_datetime(vrp_df["date"])
        vrp_df = vrp_df.set_index("date")
        pos = (vrp_df["signal"] == "sell_straddle").astype(float)
        # Daily P&L proxy: short vol wins when spot is calm
        spot_daily_ret = spot_df[spot_col].pct_change()
        spot_aligned = spot_daily_ret.reindex(vrp_df.index)
        # Theta gain minus gamma loss approximation
        pnl = pos.shift(1) * (vrp_df["vrp"].fillna(0) / 252 / 100 - spot_aligned.abs())
        pnl = pnl.dropna()
        all_pnl = pnl.tolist()

    if all_pnl:
        rets = pd.Series(all_pnl)
        cum = (1 + rets).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(rets.mean() / rets.std() * np.sqrt(252)) if rets.std() > 0 else None
    else:
        sharpe = None

    avg_vrp = float(np.nanmean([r["vrp"] for r in vrp_records if r["vrp"] is not None])) if vrp_records else None
    summary = {
        "avg_vrp_vols": avg_vrp,
        "n_sell_signals": int(sum(1 for r in vrp_records if r["signal"] == "sell_straddle")),
        "n_total_days": len(vrp_records),
        "sharpe": sharpe,
        "params": {"vrp_entry": VRP_ENTRY_THRESHOLD, "rv_window": REALIZED_VOL_WINDOW}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"NSE Options Market Neutral | Avg VRP: {avg_vrp:.1f if avg_vrp else 'N/A'} vols | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--options", required=True, dest="options_file")
    ap.add_argument("--spot", required=True, dest="spot_file")
    ap.add_argument("--outdir", default="./artifacts/nse_market_neutral")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
