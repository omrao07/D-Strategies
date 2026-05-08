#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
monte_carlo_risk_sim.py — Monte Carlo portfolio risk simulation
===============================================================
Simulates portfolio return paths using GBM (Geometric Brownian Motion) with
empirical mean/covariance (or Cholesky-decomposed correlated draws). Computes
VaR (99%, 95%), CVaR, max drawdown distribution, and probability of ruin.
Stress tests under fat-tail (Student-t) and jump-diffusion scenarios.

Inputs (CSV)
------------
--returns  returns.csv
    Columns: date, ticker, return
--weights  weights.csv (optional)
    Columns: ticker, weight

Outputs
-------
outdir/var_cvar.csv         VaR/CVaR at 95%/99% confidence over 1/5/10/21d
outdir/drawdown_dist.csv    simulated max drawdown distribution
outdir/path_scenarios.csv   sample paths (P5/P50/P95 percentiles)
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


N_SIMS = 10000
HORIZON_DAYS = 252
CONFIDENCE_LEVELS = [0.95, 0.99]
VAR_HORIZONS = [1, 5, 10, 21]


def simulate_gbm_correlated(mu: np.ndarray, cov: np.ndarray, n_sims: int, horizon: int) -> np.ndarray:
    n_assets = len(mu)
    L = np.linalg.cholesky(cov + np.eye(n_assets) * 1e-8)
    Z = np.random.standard_normal((n_sims, horizon, n_assets))
    dW = Z @ L.T
    dt = 1.0 / 252
    paths = np.exp(np.cumsum((mu - 0.5 * np.diag(cov)) * dt + dW * np.sqrt(dt), axis=1))
    return paths  # shape: (n_sims, horizon, n_assets)


def simulate_student_t(mu: np.ndarray, cov: np.ndarray, n_sims: int, horizon: int, df: int = 4) -> np.ndarray:
    n_assets = len(mu)
    L = np.linalg.cholesky(cov + np.eye(n_assets) * 1e-8)
    chi2 = np.random.chisquare(df, size=(n_sims, horizon))
    Z = np.random.standard_normal((n_sims, horizon, n_assets))
    t_draws = Z / np.sqrt(chi2 / df)[:, :, np.newaxis]
    dW = t_draws @ L.T
    dt = 1.0 / 252
    paths = np.exp(np.cumsum((mu - 0.5 * np.diag(cov)) * dt + dW * np.sqrt(dt), axis=1))
    return paths


def compute_portfolio_paths(asset_paths: np.ndarray, weights: np.ndarray) -> np.ndarray:
    return (asset_paths * weights[np.newaxis, np.newaxis, :]).sum(axis=2)


def compute_max_drawdown(port_path: np.ndarray) -> float:
    cummax = np.maximum.accumulate(port_path)
    drawdown = (port_path - cummax) / (cummax + 1e-10)
    return float(np.min(drawdown))


def run(cfg):
    np.random.seed(42)
    os.makedirs(cfg.outdir, exist_ok=True)
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()
    ret_wide = ret_wide.dropna(axis=1, thresh=int(len(ret_wide) * 0.8)).fillna(0)

    if cfg.weights_file:
        weights_df = pd.read_csv(cfg.weights_file)
        weights_df.columns = [c.lower().strip() for c in weights_df.columns]
        tickers = [t for t in weights_df["ticker"].values if t in ret_wide.columns]
        weights_raw = weights_df.set_index("ticker").reindex(tickers)["weight"].values
        weights = weights_raw / weights_raw.sum()
    else:
        tickers = list(ret_wide.columns)
        weights = np.ones(len(tickers)) / len(tickers)

    ret_sub = ret_wide[tickers].dropna()
    mu = ret_sub.mean().values * 252  # annualized
    cov = ret_sub.cov().values * 252  # annualized

    # GBM simulation
    gbm_paths = simulate_gbm_correlated(mu / 252, cov / 252, cfg.n_sims, HORIZON_DAYS)
    gbm_port = compute_portfolio_paths(gbm_paths, weights)

    # Student-t simulation (fat tails)
    t_paths = simulate_student_t(mu / 252, cov / 252, cfg.n_sims, HORIZON_DAYS, df=cfg.student_df)
    t_port = compute_portfolio_paths(t_paths, weights)

    # VaR/CVaR analysis
    var_records = []
    for model, port_paths in [("GBM", gbm_port), ("StudentT", t_port)]:
        for horizon in VAR_HORIZONS:
            h_returns = port_paths[:, horizon - 1] - 1  # terminal return at horizon
            for cl in CONFIDENCE_LEVELS:
                var_val = float(np.percentile(h_returns, (1 - cl) * 100))
                cvar_val = float(h_returns[h_returns <= var_val].mean())
                var_records.append({
                    "model": model, "horizon_days": horizon, "confidence": cl,
                    "var_pct": var_val * 100, "cvar_pct": cvar_val * 100
                })

    pd.DataFrame(var_records).to_csv(os.path.join(cfg.outdir, "var_cvar.csv"), index=False)

    # Max drawdown distribution
    dd_gbm = [compute_max_drawdown(gbm_port[i]) for i in range(cfg.n_sims)]
    dd_t = [compute_max_drawdown(t_port[i]) for i in range(cfg.n_sims)]
    dd_df = pd.DataFrame({"gbm_max_dd": dd_gbm, "student_t_max_dd": dd_t})
    dd_df.to_csv(os.path.join(cfg.outdir, "drawdown_dist.csv"), index=False)

    # Path scenarios
    pct_labels = [5, 25, 50, 75, 95]
    path_records = []
    for t in range(HORIZON_DAYS):
        row = {"day": t + 1}
        for label in pct_labels:
            row[f"gbm_p{label}"] = float(np.percentile(gbm_port[:, t], label))
            row[f"t_p{label}"] = float(np.percentile(t_port[:, t], label))
        path_records.append(row)
    pd.DataFrame(path_records).to_csv(os.path.join(cfg.outdir, "path_scenarios.csv"), index=False)

    # Probability of ruin (port < 0.7 → -30% loss)
    ruin_threshold = cfg.ruin_threshold
    prob_ruin_gbm = float((gbm_port.min(axis=1) < ruin_threshold).mean())
    prob_ruin_t = float((t_port.min(axis=1) < ruin_threshold).mean())

    summary = {
        "tickers": tickers,
        "portfolio_weights": {t: float(w) for t, w in zip(tickers, weights)},
        "ann_return_expected": float(float(weights @ mu) * 100),
        "ann_vol_expected": float(np.sqrt(weights @ cov @ weights) * 100),
        "gbm_var99_1d_pct": float(np.percentile(gbm_port[:, 0] - 1, 1) * 100),
        "t_var99_1d_pct": float(np.percentile(t_port[:, 0] - 1, 1) * 100),
        "gbm_expected_max_dd_pct": float(np.mean(dd_gbm) * 100),
        "t_expected_max_dd_pct": float(np.mean(dd_t) * 100),
        "prob_ruin_gbm_pct": float(prob_ruin_gbm * 100),
        "prob_ruin_t_pct": float(prob_ruin_t * 100),
        "params": {"n_sims": cfg.n_sims, "horizon_days": HORIZON_DAYS, "ruin_threshold": ruin_threshold,
                   "student_df": cfg.student_df}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Monte Carlo | Ann Return: {summary['ann_return_expected']:.1f}% | VaR99 1d: {summary['gbm_var99_1d_pct']:.2f}% | P(Ruin): {summary['prob_ruin_t_pct']:.1f}% | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--weights", default=None, dest="weights_file")
    ap.add_argument("--n-sims", type=int, default=N_SIMS)
    ap.add_argument("--student-df", type=int, default=4)
    ap.add_argument("--ruin-threshold", type=float, default=0.7, help="Portfolio value below which = ruin")
    ap.add_argument("--outdir", default="./artifacts/monte_carlo")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
