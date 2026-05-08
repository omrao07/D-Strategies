#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
volatility_regime_switching.py — HMM 2-state regime (low/high vol) via Viterbi + EM
--------------------------------------------------------------------------------------
Fits a Gaussian HMM with 2 hidden states to a realized-vol or return series using
the Baum-Welch (EM) algorithm implemented in pure NumPy. Outputs regime labels,
regime-conditional return statistics, and transition probabilities.

Inputs (CSV)
------------
--data  data.csv    REQUIRED: date, realized_vol (annualized), [optional: spy_return, vix]

Outputs
-------
outdir/regime_series.csv    date, realized_vol, regime (0=low,1=high), prob_high
outdir/regime_stats.csv     regime-conditional: mean_vol, mean_return, sharpe, count
outdir/transition_matrix.csv
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


def load_data(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"]).set_index("date").sort_index()
    return df.dropna(subset=[df.columns[0]])


def gaussian_pdf(x, mu, sigma):
    return (1.0 / (sigma * np.sqrt(2 * np.pi))) * np.exp(-0.5 * ((x - mu) / sigma) ** 2)


def forward_algorithm(obs, pi, A, means, stds):
    T, K = len(obs), len(pi)
    alpha = np.zeros((T, K))
    B = np.array([[gaussian_pdf(obs[t], means[k], stds[k]) for k in range(K)] for t in range(T)])
    alpha[0] = pi * B[0]
    alpha[0] /= alpha[0].sum() + 1e-300
    for t in range(1, T):
        for j in range(K):
            alpha[t, j] = np.sum(alpha[t-1] * A[:, j]) * B[t, j]
        alpha[t] /= alpha[t].sum() + 1e-300
    return alpha, B


def backward_algorithm(obs, A, B):
    T, K = len(obs), A.shape[0]
    beta = np.ones((T, K))
    for t in range(T - 2, -1, -1):
        for i in range(K):
            beta[t, i] = np.sum(A[i] * B[t+1] * beta[t+1])
        beta[t] /= beta[t].sum() + 1e-300
    return beta


def baum_welch(obs, K=2, n_iter=50):
    T = len(obs)
    np.random.seed(42)
    # Init: sort obs, split into K groups
    sorted_obs = np.sort(obs)
    chunk = T // K
    means = np.array([sorted_obs[i*chunk:(i+1)*chunk].mean() for i in range(K)])
    stds = np.array([max(sorted_obs[i*chunk:(i+1)*chunk].std(), 1e-4) for i in range(K)])
    pi = np.ones(K) / K
    A = np.full((K, K), 1.0 / K)

    for _ in range(n_iter):
        alpha, B = forward_algorithm(obs, pi, A, means, stds)
        beta = backward_algorithm(obs, A, B)
        gamma = alpha * beta
        gamma /= gamma.sum(axis=1, keepdims=True) + 1e-300
        xi = np.zeros((T-1, K, K))
        for t in range(T-1):
            for i in range(K):
                for j in range(K):
                    xi[t, i, j] = alpha[t, i] * A[i, j] * B[t+1, j] * beta[t+1, j]
            xi[t] /= xi[t].sum() + 1e-300
        # Update
        pi = gamma[0]
        for i in range(K):
            for j in range(K):
                A[i, j] = xi[:, i, j].sum() / (gamma[:-1, i].sum() + 1e-300)
            A[i] /= A[i].sum() + 1e-300
        for k in range(K):
            w = gamma[:, k]
            means[k] = (w * obs).sum() / (w.sum() + 1e-300)
            stds[k] = np.sqrt((w * (obs - means[k])**2).sum() / (w.sum() + 1e-300))
            stds[k] = max(stds[k], 1e-4)

    # Viterbi decode
    alpha_v = np.zeros((T, K))
    psi = np.zeros((T, K), dtype=int)
    alpha_v[0] = np.log(pi + 1e-300) + np.log(B[0] + 1e-300)
    for t in range(1, T):
        for j in range(K):
            vals = alpha_v[t-1] + np.log(A[:, j] + 1e-300)
            psi[t, j] = np.argmax(vals)
            alpha_v[t, j] = vals[psi[t, j]] + np.log(B[t, j] + 1e-300)
    states = np.zeros(T, dtype=int)
    states[-1] = np.argmax(alpha_v[-1])
    for t in range(T-2, -1, -1):
        states[t] = psi[t+1, states[t+1]]

    # Ensure state 0=low vol, 1=high vol
    if means[0] > means[1]:
        states = 1 - states
        means = means[::-1]; stds = stds[::-1]
        A = A[::-1, ::-1]

    return states, gamma[:, 1], A, means, stds


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    df = load_data(cfg.data_file)
    vol_col = df.columns[0]
    obs = df[vol_col].values.astype(float)

    states, prob_high, A, means, stds = baum_welch(obs, K=2, n_iter=cfg.n_iter)

    result = df.copy()
    result["regime"] = states
    result["prob_high_vol"] = prob_high
    result["regime_label"] = result["regime"].map({0: "low_vol", 1: "high_vol"})
    result.to_csv(os.path.join(cfg.outdir, "regime_series.csv"))

    pd.DataFrame(A, index=["from_low", "from_high"], columns=["to_low", "to_high"]).to_csv(
        os.path.join(cfg.outdir, "transition_matrix.csv"))

    # Regime stats
    stats = []
    for r, label in [(0, "low_vol"), (1, "high_vol")]:
        mask = states == r
        row = {"regime": label, "count": int(mask.sum()), "mean_vol": float(obs[mask].mean())}
        if "spy_return" in df.columns:
            rets = df["spy_return"].values[mask]
            row["mean_daily_return"] = float(rets.mean())
            row["annualized_sharpe"] = float(rets.mean() / (rets.std() + 1e-10) * np.sqrt(252))
        stats.append(row)
    pd.DataFrame(stats).to_csv(os.path.join(cfg.outdir, "regime_stats.csv"), index=False)

    summary = {"low_vol_mean": float(means[0]), "high_vol_mean": float(means[1]),
               "low_vol_pct": float((states == 0).mean()), "high_vol_pct": float((states == 1).mean()),
               "transition_prob_low_to_high": float(A[0, 1]), "transition_prob_high_to_low": float(A[1, 0])}
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print(f"Low-vol mean: {means[0]:.4f} | High-vol mean: {means[1]:.4f}")
    print(f"Low-vol {summary['low_vol_pct']:.1%} of time | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, dest="data_file")
    ap.add_argument("--n-iter", type=int, default=50)
    ap.add_argument("--outdir", default="./artifacts/vol_regime")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
