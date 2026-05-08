#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
realized_vol_forecasting.py — GARCH(1,1) volatility forecast → options pricing edge
-------------------------------------------------------------------------------------
Fits a GARCH(1,1) model via MLE to a return series, produces 1/5/21-day annualized
vol forecasts, and compares against an implied-vol column to identify pricing edge.

Inputs (CSV)
------------
--returns  returns.csv      REQUIRED: date, return (daily, decimal e.g. 0.01)
--iv       iv.csv           OPTIONAL: date, implied_vol (annualized, e.g. 0.20)

Outputs
-------
outdir/garch_params.json      omega, alpha, beta, log-likelihood
outdir/vol_forecasts.csv      date, realized_vol_22d, garch_1d, garch_5d, garch_21d
outdir/edge_analysis.csv      date, iv, garch_21d, vrp (iv-garch), signal
outdir/summary.json
"""

import argparse, json, os
from dataclasses import dataclass, asdict
from typing import Optional
import numpy as np
import pandas as pd
from scipy.optimize import minimize


@dataclass
class GARCHParams:
    omega: float
    alpha: float
    beta: float
    log_likelihood: float


def load_returns(path: str) -> pd.Series:
    df = pd.read_csv(path, parse_dates=["date"]).set_index("date").sort_index()
    col = [c for c in df.columns if "return" in c.lower() or "ret" in c.lower()][0]
    return df[col].dropna().astype(float)


def load_iv(path: str) -> pd.Series:
    df = pd.read_csv(path, parse_dates=["date"]).set_index("date").sort_index()
    col = [c for c in df.columns if "iv" in c.lower() or "impl" in c.lower()][0]
    return df[col].dropna().astype(float)


def garch_log_likelihood(params, returns):
    omega, alpha, beta = params
    if omega <= 0 or alpha < 0 or beta < 0 or alpha + beta >= 1:
        return 1e10
    n = len(returns)
    sigma2 = np.zeros(n)
    sigma2[0] = np.var(returns)
    for t in range(1, n):
        sigma2[t] = omega + alpha * returns[t-1]**2 + beta * sigma2[t-1]
    sigma2 = np.maximum(sigma2, 1e-10)
    ll = -0.5 * np.sum(np.log(2 * np.pi * sigma2) + returns**2 / sigma2)
    return -ll


def fit_garch(returns: np.ndarray) -> GARCHParams:
    long_run_var = np.var(returns)
    x0 = [long_run_var * 0.05, 0.08, 0.88]
    bounds = [(1e-8, None), (1e-6, 0.5), (1e-6, 0.9999)]
    res = minimize(garch_log_likelihood, x0, args=(returns,), method="L-BFGS-B", bounds=bounds)
    omega, alpha, beta = res.x
    ll = -res.fun
    return GARCHParams(omega=omega, alpha=alpha, beta=beta, log_likelihood=ll)


def garch_variance_path(returns: np.ndarray, params: GARCHParams):
    n = len(returns)
    sigma2 = np.zeros(n)
    sigma2[0] = np.var(returns)
    for t in range(1, n):
        sigma2[t] = params.omega + params.alpha * returns[t-1]**2 + params.beta * sigma2[t-1]
    return np.maximum(sigma2, 1e-10)


def garch_forecast(sigma2_last: float, r_last: float, params: GARCHParams, h: int) -> float:
    long_run = params.omega / max(1 - params.alpha - params.beta, 1e-8)
    persistence = params.alpha + params.beta
    # h-step ahead forecast
    sigma2_next = params.omega + params.alpha * r_last**2 + params.beta * sigma2_last
    forecast = long_run + persistence**(h-1) * (sigma2_next - long_run)
    return max(forecast, 1e-10)


def realized_vol(returns: pd.Series, window: int = 22) -> pd.Series:
    return returns.rolling(window).std() * np.sqrt(252)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    rets = load_returns(cfg.returns_file)
    r = rets.values

    params = fit_garch(r)
    sigma2 = garch_variance_path(r, params)

    # Build forecast series
    records = []
    for i in range(21, len(r)):
        s2_i = sigma2[i]
        r_i = r[i]
        f1 = np.sqrt(garch_forecast(s2_i, r_i, params, 1) * 252)
        f5 = np.sqrt(garch_forecast(s2_i, r_i, params, 5) * 252)
        f21 = np.sqrt(garch_forecast(s2_i, r_i, params, 21) * 252)
        rv22 = np.std(r[max(0, i-21):i+1]) * np.sqrt(252)
        records.append({"date": rets.index[i], "realized_vol_22d": rv22,
                        "garch_1d": f1, "garch_5d": f5, "garch_21d": f21})

    fc_df = pd.DataFrame(records).set_index("date")
    fc_df.to_csv(os.path.join(cfg.outdir, "vol_forecasts.csv"))

    # Edge analysis vs IV
    summary = {"garch_params": asdict(params), "n_obs": len(r)}
    if cfg.iv_file:
        iv = load_iv(cfg.iv_file)
        merged = fc_df[["garch_21d"]].join(iv.rename("implied_vol"), how="inner")
        merged["vrp"] = merged["implied_vol"] - merged["garch_21d"]
        merged["signal"] = merged["vrp"].apply(lambda x: "sell_vol" if x > 0.03 else ("buy_vol" if x < -0.03 else "neutral"))
        merged.to_csv(os.path.join(cfg.outdir, "edge_analysis.csv"))
        summary["avg_vrp"] = float(merged["vrp"].mean())
        summary["sell_vol_pct"] = float((merged["signal"] == "sell_vol").mean())

    with open(os.path.join(cfg.outdir, "garch_params.json"), "w") as f:
        json.dump(asdict(params), f, indent=2)
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"GARCH(1,1): omega={params.omega:.2e} alpha={params.alpha:.4f} beta={params.beta:.4f} LL={params.log_likelihood:.1f}")
    print(f"Persistence: {params.alpha + params.beta:.4f} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--iv", default=None, dest="iv_file")
    ap.add_argument("--outdir", default="./artifacts/garch")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
