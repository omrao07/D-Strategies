#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
neural_network_sentiment.py — 2-layer MLP for sentiment + price feature fusion
================================================================================
Combines sentiment scores (news, social, earnings call tone) with price features
in a shallow MLP (numpy/scipy, no deep learning framework). Uses backpropagation
with Adam optimizer implemented from scratch. Outputs probability of next N-day
positive return.

Inputs (CSV)
------------
--prices    prices.csv
    Columns: date, ticker, close
--sentiment sentiment.csv
    Columns: date, ticker, sentiment_score (-1 to 1), confidence (0-1), volume_mentions

Outputs
-------
outdir/nn_signals.csv       date, ticker, nn_prob_up, signal
outdir/training_log.csv     epoch, train_loss, val_loss, val_accuracy
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

HIDDEN_SIZE = 32
FORWARD_DAYS = 5
TRAIN_FRACTION = 0.7
N_EPOCHS = 200
LEARNING_RATE = 0.001
BATCH_SIZE = 64
BETA1, BETA2, EPS = 0.9, 0.999, 1e-8  # Adam params


class MLP:
    def __init__(self, input_size: int, hidden_size: int):
        scale = np.sqrt(2.0 / input_size)
        self.W1 = np.random.randn(input_size, hidden_size) * scale
        self.b1 = np.zeros(hidden_size)
        self.W2 = np.random.randn(hidden_size, 1) * np.sqrt(2.0 / hidden_size)
        self.b2 = np.zeros(1)
        # Adam state
        self.m = {k: np.zeros_like(v) for k, v in self._params().items()}
        self.v = {k: np.zeros_like(v) for k, v in self._params().items()}
        self.t = 0

    def _params(self) -> dict:
        return {"W1": self.W1, "b1": self.b1, "W2": self.W2, "b2": self.b2}

    def _relu(self, x):
        return np.maximum(0, x)

    def _sigmoid(self, x):
        return 1.0 / (1.0 + np.exp(-np.clip(x, -50, 50)))

    def forward(self, X: np.ndarray) -> tuple:
        z1 = X @ self.W1 + self.b1
        h1 = self._relu(z1)
        z2 = h1 @ self.W2 + self.b2
        out = self._sigmoid(z2)
        return out, (X, z1, h1, z2)

    def backward(self, out: np.ndarray, y: np.ndarray, cache: tuple) -> dict:
        X, z1, h1, z2 = cache
        n = len(y)
        dz2 = (out - y.reshape(-1, 1)) / n
        dW2 = h1.T @ dz2
        db2 = dz2.sum(axis=0)
        dh1 = dz2 @ self.W2.T
        dz1 = dh1 * (z1 > 0).astype(float)
        dW1 = X.T @ dz1
        db1 = dz1.sum(axis=0)
        return {"W1": dW1, "b1": db1, "W2": dW2, "b2": db2}

    def adam_update(self, grads: dict, lr: float):
        self.t += 1
        params = self._params()
        for k in params:
            self.m[k] = BETA1 * self.m[k] + (1 - BETA1) * grads[k]
            self.v[k] = BETA2 * self.v[k] + (1 - BETA2) * grads[k] ** 2
            m_hat = self.m[k] / (1 - BETA1 ** self.t)
            v_hat = self.v[k] / (1 - BETA2 ** self.t)
            params[k] -= lr * m_hat / (np.sqrt(v_hat) + EPS)

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        out, _ = self.forward(X)
        return out.flatten()


def build_features(prices_sub: pd.DataFrame, sentiment_sub: pd.DataFrame) -> pd.DataFrame:
    c = prices_sub["close"]
    ret = c.pct_change()
    feat = pd.DataFrame(index=prices_sub.index)
    for n in [1, 5, 21]:
        feat[f"mom_{n}d"] = ret.rolling(n).sum()
    feat["vol_21d"] = ret.rolling(21).std()
    feat["price_z21"] = (c - c.rolling(21).mean()) / c.rolling(21).std().replace(0, np.nan)
    if not sentiment_sub.empty:
        sent = sentiment_sub.reindex(prices_sub.index).ffill()
        for col in ["sentiment_score", "confidence", "volume_mentions"]:
            if col in sent.columns:
                feat[col] = sent[col]
                feat[f"{col}_ma5"] = feat[col].rolling(5).mean()
    feat["fwd_ret"] = ret.rolling(FORWARD_DAYS).sum().shift(-FORWARD_DAYS)
    feat["label"] = (feat["fwd_ret"] > 0).astype(float)
    return feat.dropna()


def run(cfg):
    np.random.seed(42)
    os.makedirs(cfg.outdir, exist_ok=True)
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]
    sentiment = pd.read_csv(cfg.sentiment_file, parse_dates=["date"])
    sentiment.columns = [c.lower().strip() for c in sentiment.columns]

    all_signals = []
    all_train_logs = []

    for ticker in prices["ticker"].unique():
        p_sub = prices[prices["ticker"] == ticker].set_index("date").sort_index()
        s_sub = sentiment[sentiment["ticker"] == ticker].set_index("date").sort_index() if "ticker" in sentiment.columns else pd.DataFrame()

        feat = build_features(p_sub, s_sub)
        if len(feat) < 80:
            continue

        feat_cols = [c for c in feat.columns if c not in ["fwd_ret", "label"]]
        X = feat[feat_cols].values
        y = feat["label"].values

        # Normalize
        X_mean, X_std = X.mean(axis=0), X.std(axis=0) + 1e-8
        X_norm = (X - X_mean) / X_std

        n_train = int(len(X) * TRAIN_FRACTION)
        X_train, y_train = X_norm[:n_train], y[:n_train]
        X_val, y_val = X_norm[n_train:], y[n_train:]

        mlp = MLP(input_size=len(feat_cols), hidden_size=HIDDEN_SIZE)

        for epoch in range(cfg.n_epochs):
            idx = np.random.permutation(len(X_train))
            X_shuf, y_shuf = X_train[idx], y_train[idx]
            for b in range(0, len(X_train), BATCH_SIZE):
                Xb = X_shuf[b:b + BATCH_SIZE]
                yb = y_shuf[b:b + BATCH_SIZE]
                out, cache = mlp.forward(Xb)
                grads = mlp.backward(out, yb, cache)
                mlp.adam_update(grads, lr=cfg.learning_rate)

            if (epoch + 1) % 20 == 0:
                train_out, _ = mlp.forward(X_train)
                val_out, _ = mlp.forward(X_val)
                train_loss = float(-np.mean(y_train * np.log(train_out.flatten() + 1e-10) + (1 - y_train) * np.log(1 - train_out.flatten() + 1e-10)))
                val_loss = float(-np.mean(y_val * np.log(val_out.flatten() + 1e-10) + (1 - y_val) * np.log(1 - val_out.flatten() + 1e-10)))
                val_acc = float(((val_out.flatten() > 0.5) == y_val).mean())
                all_train_logs.append({"ticker": ticker, "epoch": epoch + 1, "train_loss": train_loss,
                                        "val_loss": val_loss, "val_accuracy": val_acc})

        probs = mlp.predict_proba(X_norm)
        for i, (date, prob) in enumerate(zip(feat.index, probs)):
            signal = "buy" if prob > cfg.prob_threshold else ("sell" if prob < (1 - cfg.prob_threshold) else "neutral")
            all_signals.append({"date": date, "ticker": ticker, "nn_prob_up": float(prob), "signal": signal})

    if not all_signals:
        print("No signals generated")
        return

    sig_df = pd.DataFrame(all_signals).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "nn_signals.csv"), index=False)
    if all_train_logs:
        pd.DataFrame(all_train_logs).to_csv(os.path.join(cfg.outdir, "training_log.csv"), index=False)

    # Backtest
    price_wide = prices.pivot(index="date", columns="ticker", values="close").sort_index().pct_change()
    SIG_POS = {"buy": 1, "neutral": 0, "sell": -1}
    all_daily = []
    for ticker in sig_df["ticker"].unique():
        if ticker not in price_wide.columns:
            continue
        pos = sig_df[sig_df["ticker"] == ticker].set_index("date")["signal"].map(SIG_POS).fillna(0)
        ret_s = price_wide[ticker].dropna()
        pos_daily = pos.reindex(ret_s.index).ffill().shift(1).fillna(0)
        all_daily.append((pos_daily * ret_s).rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    log_df = pd.DataFrame(all_train_logs) if all_train_logs else pd.DataFrame()
    summary = {
        "tickers": sig_df["ticker"].unique().tolist(),
        "avg_final_val_accuracy": float(log_df.groupby("ticker")["val_accuracy"].last().mean()) if not log_df.empty else None,
        "n_buy": int((sig_df["signal"] == "buy").sum()),
        "n_sell": int((sig_df["signal"] == "sell").sum()),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"hidden_size": HIDDEN_SIZE, "n_epochs": cfg.n_epochs,
                   "learning_rate": cfg.learning_rate, "prob_threshold": cfg.prob_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"NN Sentiment | Val Acc: {format(summary['avg_final_val_accuracy'], '.3f') if summary['avg_final_val_accuracy'] else 'N/A'} | Buy: {summary['n_buy']} | Sharpe: {format(sharpe, '.2f') if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--sentiment", required=True, dest="sentiment_file")
    ap.add_argument("--n-epochs", type=int, default=N_EPOCHS)
    ap.add_argument("--learning-rate", type=float, default=LEARNING_RATE)
    ap.add_argument("--prob-threshold", type=float, default=0.6)
    ap.add_argument("--outdir", default="./artifacts/nn_sentiment")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
