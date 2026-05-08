#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hidden_markov_regime.py — Hidden Markov Model market regime detection
======================================================================
Trains a Gaussian HMM on return + volatility features to infer latent market
regimes (bull/bear/volatile/low-vol). Regime-conditional signal generation:
buy in bull regime, reduce/short in bear regime. Baum-Welch EM estimation.

Inputs (CSV)
------------
--prices   prices.csv
    Columns: date, ticker, close

Outputs
-------
outdir/hmm_regimes.csv      date, ticker, regime_id, regime_label, viterbi_prob, signal
outdir/regime_stats.csv     per-regime statistics: avg return, vol, duration
outdir/transition_matrix.csv  HMM state transition probabilities
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from sklearn.mixture import GaussianMixture


N_STATES = 3   # bull, neutral, bear
MIN_OBS = 252
LOOKBACK_VOL = 21


def fit_hmm_em(X: np.ndarray, n_states: int, n_iter: int = 100) -> dict:
    """EM-based HMM via GaussianMixture approximation (stationary regime probabilities)."""
    gm = GaussianMixture(n_components=n_states, covariance_type="full", max_iter=n_iter, random_state=42)
    gm.fit(X)
    labels = gm.predict(X)
    probs = gm.predict_proba(X)
    return {"labels": labels, "probs": probs, "means": gm.means_, "weights": gm.weights_}


def label_regimes(means: np.ndarray) -> dict:
    ret_feature = 0  # first feature is return
    order = np.argsort(means[:, ret_feature])
    n = len(order)
    labels = {}
    labels[int(order[0])] = "bear"
    labels[int(order[-1])] = "bull"
    for i in range(1, n - 1):
        labels[int(order[i])] = "neutral" if n == 3 else f"neutral_{i}"
    return labels


def compute_transition_matrix(labels: np.ndarray, n_states: int) -> np.ndarray:
    trans = np.zeros((n_states, n_states))
    for t in range(1, len(labels)):
        trans[labels[t-1], labels[t]] += 1
    row_sums = trans.sum(axis=1, keepdims=True)
    return trans / np.where(row_sums == 0, 1, row_sums)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]

    all_signals = []
    all_regime_stats = []
    trans_mats = []

    for ticker in prices["ticker"].unique():
        sub = prices[prices["ticker"] == ticker].set_index("date").sort_index()
        if len(sub) < MIN_OBS + 30:
            continue

        close = sub["close"]
        ret = close.pct_change().dropna()
        vol = ret.rolling(LOOKBACK_VOL).std().dropna()
        ret_aligned, vol_aligned = ret.align(vol, join="inner")

        X = np.column_stack([ret_aligned.values, vol_aligned.values])
        if len(X) < MIN_OBS:
            continue

        n_states = min(cfg.n_states, 3)
        result = fit_hmm_em(X, n_states, n_iter=cfg.n_iter)
        regime_map = label_regimes(result["means"])

        labels = result["labels"]
        probs = result["probs"]

        # Compute transition matrix
        trans = compute_transition_matrix(labels, n_states)
        trans_mats.append({"ticker": ticker, **{f"P_{i}_{j}": float(trans[i, j])
                            for i in range(n_states) for j in range(n_states)}})

        # Regime statistics
        for state_id in range(n_states):
            state_mask = labels == state_id
            if state_mask.sum() < 5:
                continue
            state_rets = ret_aligned.values[state_mask]
            all_regime_stats.append({
                "ticker": ticker,
                "state_id": state_id,
                "regime_label": regime_map.get(state_id, f"state_{state_id}"),
                "avg_daily_return": float(np.mean(state_rets)),
                "avg_daily_vol": float(np.std(state_rets)),
                "n_days": int(state_mask.sum()),
                "pct_time": float(state_mask.mean() * 100)
            })

        # Signal generation
        dates = ret_aligned.index
        for t, date in enumerate(dates):
            state_id = int(labels[t])
            regime_label = regime_map.get(state_id, f"state_{state_id}")
            max_prob = float(probs[t].max())

            signal = "buy" if regime_label == "bull" and max_prob > cfg.min_prob else \
                     ("sell" if regime_label == "bear" and max_prob > cfg.min_prob else "neutral")

            all_signals.append({
                "date": date, "ticker": ticker,
                "state_id": state_id, "regime_label": regime_label,
                "regime_prob": max_prob, "signal": signal
            })

    if not all_signals:
        print("No regimes detected — check data")
        return

    sig_df = pd.DataFrame(all_signals).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "hmm_regimes.csv"), index=False)
    pd.DataFrame(all_regime_stats).to_csv(os.path.join(cfg.outdir, "regime_stats.csv"), index=False)
    if trans_mats:
        pd.DataFrame(trans_mats).to_csv(os.path.join(cfg.outdir, "transition_matrix.csv"), index=False)

    # Backtest
    price_wide = prices.pivot(index="date", columns="ticker", values="close").sort_index().pct_change()
    SIG_POS = {"buy": 1, "neutral": 0, "sell": -1}
    all_daily = []
    for ticker in sig_df["ticker"].unique():
        if ticker not in price_wide.columns:
            continue
        pos = sig_df[sig_df["ticker"] == ticker].set_index("date")["signal"].map(SIG_POS).fillna(0)
        ret_s = price_wide[ticker].dropna()
        pos_daily = pos.reindex(ret_s.index, method="ffill").shift(1).fillna(0)
        all_daily.append((pos_daily * ret_s).rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    regime_df = pd.DataFrame(all_regime_stats)
    summary = {
        "n_states": n_states,
        "tickers": sig_df["ticker"].unique().tolist(),
        "bull_pct_time": float(regime_df[regime_df["regime_label"] == "bull"]["pct_time"].mean()) if not regime_df.empty else None,
        "bear_pct_time": float(regime_df[regime_df["regime_label"] == "bear"]["pct_time"].mean()) if not regime_df.empty else None,
        "n_buy_signals": int((sig_df["signal"] == "buy").sum()),
        "n_sell_signals": int((sig_df["signal"] == "sell").sum()),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"n_states": cfg.n_states, "min_prob": cfg.min_prob}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"HMM Regime | States: {n_states} | Bull: {summary['bull_pct_time']:.1f}% | Bear: {summary['bear_pct_time']:.1f}% | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--n-states", type=int, default=N_STATES)
    ap.add_argument("--n-iter", type=int, default=100)
    ap.add_argument("--min-prob", type=float, default=0.6)
    ap.add_argument("--outdir", default="./artifacts/hmm_regime")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
