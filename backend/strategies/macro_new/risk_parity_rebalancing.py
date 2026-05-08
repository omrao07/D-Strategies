#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
risk_parity_rebalancing.py — Risk parity allocation with dynamic rebalancing signals
======================================================================================
Risk parity allocates equal risk (not equal capital) across asset classes.
When one asset's volatility spikes, its weight is cut → systematic rebalancing
creates predictable order flow. This strategy detects risk parity rebalancing
flows and positions accordingly.

Inputs (CSV)
------------
--assets   asset_returns.csv
    Columns: date, ticker, return
    Expected tickers: equities (SPY), bonds (TLT), gold (GLD), commodities (DJP)

Outputs
-------
outdir/risk_parity_weights.csv  date, ticker, vol_weight, prev_weight, rebal_direction
outdir/rebalancing_signals.csv  date, ticker, expected_flow, signal
outdir/backtest.csv             risk parity portfolio vs 60/40 P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy.optimize import minimize


def compute_risk_parity_weights(cov_matrix: np.ndarray) -> np.ndarray:
    """Solve for weights such that each asset contributes equally to portfolio risk."""
    n = cov_matrix.shape[0]
    def risk_contribution_eq(w):
        w = np.array(w)
        port_var = w @ cov_matrix @ w
        rc = w * (cov_matrix @ w) / port_var
        return rc - 1.0 / n

    x0 = np.ones(n) / n
    bounds = [(0.01, 1.0)] * n
    constraints = {"type": "eq", "fun": lambda w: np.sum(w) - 1.0}
    result = minimize(lambda w: np.sum(risk_contribution_eq(w) ** 2),
                      x0, bounds=bounds, constraints=constraints, method="SLSQP")
    return result.x if result.success else x0


def compute_inverse_vol_weights(vols: np.ndarray) -> np.ndarray:
    """Simpler: weights proportional to 1/volatility."""
    inv_vol = 1.0 / np.where(vols > 0, vols, 1e-6)
    return inv_vol / inv_vol.sum()


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    rets = pd.read_csv(cfg.assets_file, parse_dates=["date"])
    rets.columns = [c.lower().strip() for c in rets.columns]
    ret_wide = rets.pivot(index="date", columns="ticker", values="return").sort_index().dropna()
    tickers = ret_wide.columns.tolist()
    n = len(tickers)

    if n < 2:
        print("Need at least 2 tickers.")
        return

    weight_records = []
    signal_records = []
    rp_daily = []
    eq60_40_daily = []

    for i in range(cfg.vol_window, len(ret_wide)):
        date = ret_wide.index[i]
        window_ret = ret_wide.iloc[i - cfg.vol_window:i]
        vols = window_ret.std().values * np.sqrt(252)

        # Risk parity weights
        if cfg.use_full_rp and n <= 8:
            cov = window_ret.cov().values * 252
            try:
                rp_weights = compute_risk_parity_weights(cov)
            except Exception:
                rp_weights = compute_inverse_vol_weights(vols)
        else:
            rp_weights = compute_inverse_vol_weights(vols)

        # Previous day's weights
        if len(weight_records) > 0:
            prev_w = np.array([weight_records[-1].get(t, 0) for t in tickers])
        else:
            prev_w = rp_weights.copy()

        weight_chg = rp_weights - prev_w
        day_ret_rp = float((rp_weights * ret_wide.iloc[i].values).sum())
        rp_daily.append(day_ret_rp)

        rec = {"date": date}
        rec.update({t: float(rp_weights[j]) for j, t in enumerate(tickers)})
        weight_records.append(rec)

        # Rebalancing signal: tickers with weight increasing → expected buying pressure → buy
        for j, ticker in enumerate(tickers):
            chg = float(weight_chg[j])
            if abs(chg) > cfg.rebal_threshold:
                signal_records.append({
                    "date": date, "ticker": ticker,
                    "rp_weight": float(rp_weights[j]),
                    "prev_weight": float(prev_w[j]),
                    "weight_change": chg,
                    "expected_flow": "buy" if chg > 0 else "sell",
                    "signal": "buy" if chg > 0 else "sell"  # fade rebalancing or follow?
                })

    weight_df = pd.DataFrame(weight_records).set_index("date")
    weight_df.to_csv(os.path.join(cfg.outdir, "risk_parity_weights.csv"))

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "rebalancing_signals.csv"), index=False)

    # Backtest: RP vs simple 60/40
    rp_series = pd.Series(rp_daily, index=ret_wide.index[cfg.vol_window:])
    spy = "spy" if "spy" in ret_wide.columns else tickers[0]
    tlt = "tlt" if "tlt" in ret_wide.columns else tickers[-1]
    eq6040 = (0.6 * ret_wide[spy] + 0.4 * ret_wide[tlt]).reindex(rp_series.index)

    rp_cum = (1 + rp_series).cumprod()
    eq_cum = (1 + eq6040).cumprod()
    pd.DataFrame({"rp_cumulative": rp_cum, "eq_6040_cumulative": eq_cum}).to_csv(
        os.path.join(cfg.outdir, "backtest.csv"))

    def sharpe(s): return float(s.mean() / s.std() * np.sqrt(252)) if s.std() > 0 else None
    summary = {
        "tickers": tickers, "vol_window_days": cfg.vol_window,
        "rp_ann_return": float(rp_series.mean() * 252),
        "rp_sharpe": sharpe(rp_series),
        "eq_6040_ann_return": float(eq6040.mean() * 252),
        "eq_6040_sharpe": sharpe(eq6040),
        "n_rebalancing_signals": len(sig_df),
        "avg_weight_change_on_rebal": float(sig_df["weight_change"].abs().mean()) if not sig_df.empty else None
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Risk parity | RP Sharpe: {summary['rp_sharpe']:.2f if summary['rp_sharpe'] else 'N/A'} vs 60/40: {summary['eq_6040_sharpe']:.2f if summary['eq_6040_sharpe'] else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets", required=True, dest="assets_file")
    ap.add_argument("--vol-window", type=int, default=60)
    ap.add_argument("--rebal-threshold", type=float, default=0.02, help="Min weight change to flag rebalancing")
    ap.add_argument("--use-full-rp", action="store_true", default=False, help="Use full covariance RP (slower)")
    ap.add_argument("--outdir", default="./artifacts/risk_parity")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
