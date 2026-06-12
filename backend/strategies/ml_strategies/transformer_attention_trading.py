#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
transformer_attention_trading.py — Attention mechanism for sequence signal
===========================================================================
Implements a single-head attention mechanism (numpy) over price/feature sequences.
Query = current day features, Keys/Values = past window. Attention weights tell
which past days are most relevant. Pooled attended context → linear classifier.
No framework required — pure numpy with Adam optimizer.

Inputs (CSV)
------------
--prices   prices.csv
    Columns: date, ticker, close, volume (optional)

Outputs
-------
outdir/attention_signals.csv  date, ticker, attention_prob, signal
outdir/attention_weights.csv  sample attention weight patterns (top events)
outdir/backtest.csv           cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

SEQ_LEN = 15
D_MODEL = 8
FORWARD_DAYS = 5
TRAIN_FRAC = 0.65
N_EPOCHS = 60
LR = 0.001
BETA1, BETA2, EPS_ADAM = 0.9, 0.999, 1e-8


def scaled_dot_product_attention(Q: np.ndarray, K: np.ndarray, V: np.ndarray) -> np.ndarray:
    d_k = Q.shape[-1]
    scores = Q @ K.T / np.sqrt(d_k)
    scores -= scores.max(axis=-1, keepdims=True)
    weights = np.exp(scores)
    weights /= weights.sum(axis=-1, keepdims=True) + 1e-10
    return weights @ V, weights


class AttentionClassifier:
    def __init__(self, input_dim: int, d_model: int):
        scale = 0.01
        self.Wq = np.random.randn(input_dim, d_model) * scale
        self.Wk = np.random.randn(input_dim, d_model) * scale
        self.Wv = np.random.randn(input_dim, d_model) * scale
        self.Wo = np.random.randn(d_model, 1) * scale
        self.bo = np.zeros(1)
        # Adam state
        params = self._params()
        self.m = {k: np.zeros_like(v) for k, v in params.items()}
        self.v_adam = {k: np.zeros_like(v) for k, v in params.items()}
        self.t = 0

    def _params(self) -> dict:
        return {"Wq": self.Wq, "Wk": self.Wk, "Wv": self.Wv, "Wo": self.Wo, "bo": self.bo}

    def forward(self, X_seq: np.ndarray) -> tuple:
        Q = X_seq[-1:] @ self.Wq  # shape: (1, d_model)
        K = X_seq @ self.Wk       # shape: (seq, d_model)
        V = X_seq @ self.Wv       # shape: (seq, d_model)
        context, attn_weights = scaled_dot_product_attention(Q, K, V)
        logit = context.mean(axis=0) @ self.Wo + self.bo
        prob = 1 / (1 + np.exp(-np.clip(logit, -50, 50)))
        return float(prob.flatten()[0]), attn_weights.flatten()

    def _sigmoid(self, x):
        return 1 / (1 + np.exp(-np.clip(x, -50, 50)))

    def train_step(self, X_seq: np.ndarray, y: float, lr: float):
        prob, _ = self.forward(X_seq)
        err = prob - y

        Q = X_seq[-1:] @ self.Wq
        K = X_seq @ self.Wk
        V = X_seq @ self.Wv
        context, attn = scaled_dot_product_attention(Q, K, V)
        context_mean = context.mean(axis=0)

        d_Wo = context_mean.reshape(-1, 1) * err
        d_bo = np.array([err])
        d_ctx = (self.Wo * err).T  # shape: (1, d_model)
        d_V = attn.reshape(-1, 1) * d_ctx  # shape: (seq, d_model)
        d_Wv = X_seq.T @ d_V

        grads = {"Wq": np.zeros_like(self.Wq), "Wk": np.zeros_like(self.Wk),
                 "Wv": d_Wv, "Wo": d_Wo, "bo": d_bo}

        self.t += 1
        params = self._params()
        for k in params:
            self.m[k] = BETA1 * self.m[k] + (1 - BETA1) * grads[k]
            self.v_adam[k] = BETA2 * self.v_adam[k] + (1 - BETA2) * grads[k] ** 2
            m_hat = self.m[k] / (1 - BETA1 ** self.t)
            v_hat = self.v_adam[k] / (1 - BETA2 ** self.t)
            params[k] -= lr * m_hat / (np.sqrt(v_hat) + EPS_ADAM)


def build_features(sub: pd.DataFrame, forward_days: int) -> pd.DataFrame:
    c = sub["close"]
    ret = c.pct_change().dropna()
    feat = pd.DataFrame({
        "ret": ret,
        "ret_5d": ret.rolling(5).sum(),
        "vol": ret.rolling(10).std(),
        "price_z": (c - c.rolling(21).mean()) / c.rolling(21).std().replace(0, np.nan)
    }).dropna()
    if "volume" in sub.columns:
        v = sub["volume"].reindex(feat.index)
        feat["vol_ratio"] = v / v.rolling(10).mean().replace(0, np.nan)
    feat["label"] = (ret.reindex(feat.index).rolling(forward_days).sum().shift(-forward_days) > 0).astype(float)
    return feat.dropna()


def run(cfg):
    np.random.seed(42)
    os.makedirs(cfg.outdir, exist_ok=True)
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]

    all_signals = []
    attn_samples = []

    for ticker in prices["ticker"].unique():
        sub = prices[prices["ticker"] == ticker].set_index("date").sort_index()
        if len(sub) < SEQ_LEN * 3 + 50:
            continue

        feat = build_features(sub, FORWARD_DAYS)
        if len(feat) < SEQ_LEN + 40:
            continue

        feat_cols = [c for c in feat.columns if c != "label"]
        X_all = feat[feat_cols].values
        y_all = feat["label"].values
        X_mean, X_std = X_all.mean(0), X_all.std(0) + 1e-8
        X_norm = (X_all - X_mean) / X_std

        n_train = int(len(X_norm) * TRAIN_FRAC)
        model = AttentionClassifier(len(feat_cols), D_MODEL)

        for epoch in range(cfg.n_epochs):
            idx = np.random.permutation(max(0, n_train - SEQ_LEN))
            for j in idx:
                seq = X_norm[j:j + SEQ_LEN]
                label = float(y_all[j + SEQ_LEN - 1])
                model.train_step(seq, label, LR)

        for i in range(SEQ_LEN, len(X_norm)):
            seq = X_norm[i - SEQ_LEN:i]
            prob, attn_w = model.forward(seq)
            date = feat.index[i]
            signal = "buy" if prob > cfg.prob_threshold else ("sell" if prob < (1 - cfg.prob_threshold) else "neutral")
            all_signals.append({"date": date, "ticker": ticker, "attention_prob": float(prob), "signal": signal})

            if i == len(X_norm) - 1 and len(attn_w) == SEQ_LEN:
                top_k = np.argsort(attn_w)[-3:][::-1]
                for rank, ki in enumerate(top_k):
                    ref_date = feat.index[i - SEQ_LEN + ki] if (i - SEQ_LEN + ki) < len(feat) else date
                    attn_samples.append({"ticker": ticker, "as_of_date": date, "rank": rank + 1,
                                          "attention_weight": float(attn_w[ki]),
                                          "reference_date": ref_date})

    if not all_signals:
        print("No signals generated")
        return

    sig_df = pd.DataFrame(all_signals).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "attention_signals.csv"), index=False)
    if attn_samples:
        pd.DataFrame(attn_samples).to_csv(os.path.join(cfg.outdir, "attention_weights.csv"), index=False)

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

    summary = {
        "tickers": sig_df["ticker"].unique().tolist(),
        "n_buy": int((sig_df["signal"] == "buy").sum()),
        "n_sell": int((sig_df["signal"] == "sell").sum()),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"seq_len": SEQ_LEN, "d_model": D_MODEL, "n_epochs": cfg.n_epochs,
                   "prob_threshold": cfg.prob_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Attention | Tickers: {len(summary['tickers'])} | Buy: {summary['n_buy']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--n-epochs", type=int, default=N_EPOCHS)
    ap.add_argument("--prob-threshold", type=float, default=0.6)
    ap.add_argument("--outdir", default="./artifacts/attention_trading")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
