#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ensemble_meta_learning.py — Stacking ensemble of multiple signal sources
=========================================================================
Meta-learner (logistic regression) trained on base model signals to produce
a final combined signal. Base signals: momentum, mean reversion, volume,
RF probability, HMM regime. Uses walk-forward stacking to prevent leakage.

Inputs (CSV)
------------
--signals  signals.csv
    Columns: date, ticker, signal_rf, signal_hmm, signal_momentum,
             signal_meanrev, signal_volume (values: -1, 0, 1)
--returns  returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/meta_signals.csv     date, ticker, meta_prob, meta_signal, base_signals
outdir/signal_weights.csv   meta-learner coefficients per base signal
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import accuracy_score, roc_auc_score


SIGNAL_COLS = ["signal_rf", "signal_hmm", "signal_momentum", "signal_meanrev", "signal_volume"]
FORWARD_DAYS = 5
TRAIN_MIN = 100
REFIT_EVERY = 21


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    signals = pd.read_csv(cfg.signals_file, parse_dates=["date"])
    signals.columns = [c.lower().strip() for c in signals.columns]
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    feat_cols = [c for c in SIGNAL_COLS if c in signals.columns]
    if not feat_cols:
        print(f"No base signal columns found. Expected: {SIGNAL_COLS}")
        return

    all_meta_signals = []
    all_weights = []

    for ticker in signals["ticker"].unique():
        sub = signals[signals["ticker"] == ticker].set_index("date").sort_index()
        if ticker not in ret_wide.columns:
            continue

        ret_s = ret_wide[ticker].dropna()
        sub = sub.reindex(ret_s.index, method="ffill").dropna(subset=feat_cols)
        fwd_ret = ret_s.rolling(FORWARD_DAYS).sum().shift(-FORWARD_DAYS).reindex(sub.index)
        sub["label"] = (fwd_ret > 0).astype(int)
        sub = sub.dropna(subset=feat_cols + ["label"])

        if len(sub) < TRAIN_MIN + REFIT_EVERY:
            continue

        meta_probs = pd.Series(index=sub.index, dtype=float)
        ticker_weights = []

        for i in range(TRAIN_MIN, len(sub), REFIT_EVERY):
            train = sub.iloc[:i]
            test_end = min(i + REFIT_EVERY, len(sub))
            test = sub.iloc[i:test_end]
            if len(train) < TRAIN_MIN or len(test) == 0:
                continue

            X_train = train[feat_cols].values
            y_train = train["label"].values
            X_test = test[feat_cols].values

            if len(set(y_train)) < 2:
                meta_probs.iloc[i:test_end] = 0.5
                continue

            scaler = StandardScaler()
            X_train_s = scaler.fit_transform(X_train)
            X_test_s = scaler.transform(X_test)

            lr = LogisticRegression(C=cfg.regularization, max_iter=500, random_state=42)
            lr.fit(X_train_s, y_train)
            probs = lr.predict_proba(X_test_s)[:, 1]
            meta_probs.iloc[i:test_end] = probs

            if i + REFIT_EVERY >= len(sub):
                coef = {feat_cols[j]: float(lr.coef_[0][j]) for j in range(len(feat_cols))}
                ticker_weights.append({"ticker": ticker, **coef})

        for date, prob in meta_probs.dropna().items():
            signal = "buy" if prob > cfg.prob_threshold else \
                     ("sell" if prob < (1 - cfg.prob_threshold) else "neutral")
            base = sub.loc[date, feat_cols].to_dict() if date in sub.index else {}
            all_meta_signals.append({
                "date": date, "ticker": ticker,
                "meta_prob": float(prob),
                "meta_signal": signal,
                **{k: int(v) for k, v in base.items()}
            })

        if ticker_weights:
            all_weights.extend(ticker_weights)

    if not all_meta_signals:
        print("No meta signals generated")
        return

    sig_df = pd.DataFrame(all_meta_signals).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "meta_signals.csv"), index=False)

    if all_weights:
        weights_df = pd.DataFrame(all_weights)
        weights_df.to_csv(os.path.join(cfg.outdir, "signal_weights.csv"), index=False)
        avg_weights = weights_df[feat_cols].mean().to_dict()
    else:
        avg_weights = {}

    # Backtest
    SIG_POS = {"buy": 1, "neutral": 0, "sell": -1}
    all_daily = []
    for ticker in sig_df["ticker"].unique():
        if ticker not in ret_wide.columns:
            continue
        pos = sig_df[sig_df["ticker"] == ticker].set_index("date")["meta_signal"].map(SIG_POS).fillna(0)
        ret_s = ret_wide[ticker].dropna()
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

    summary = {
        "tickers": sig_df["ticker"].unique().tolist(),
        "base_signals_used": feat_cols,
        "avg_signal_weights": avg_weights,
        "n_buy": int((sig_df["meta_signal"] == "buy").sum()),
        "n_sell": int((sig_df["meta_signal"] == "sell").sum()),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"prob_threshold": cfg.prob_threshold, "regularization": cfg.regularization,
                   "forward_days": FORWARD_DAYS}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Meta Ensemble | Signals: {feat_cols} | Buy: {summary['n_buy']} | Sell: {summary['n_sell']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--signals", required=True, dest="signals_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--prob-threshold", type=float, default=0.6)
    ap.add_argument("--regularization", type=float, default=1.0)
    ap.add_argument("--outdir", default="./artifacts/meta_ensemble")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
