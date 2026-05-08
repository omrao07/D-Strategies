#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gan_synthetic_data.py — GAN-style synthetic return generation for stress testing
==================================================================================
Implements a simplified GAN (generator + discriminator as MLPs in numpy) to learn
the joint distribution of asset returns. Synthetic paths used for: (1) augmenting
training data for ML models, (2) stress scenario generation, (3) tail risk estimation
beyond historical sample.

Inputs (CSV)
------------
--returns  returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/synthetic_returns.csv  N synthetic return paths (dates × tickers)
outdir/distribution_stats.csv comparison: real vs synthetic moments
outdir/tail_scenarios.csv     worst-case synthetic scenarios (5th percentile paths)
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd


LATENT_DIM = 8
HIDDEN_G = 32
HIDDEN_D = 32
N_EPOCHS = 200
BATCH_SIZE = 32
LR_G = 0.001
LR_D = 0.001
N_SYNTHETIC = 1000
CLIP_VALUE = 0.01  # WGAN-style weight clipping


class Generator:
    def __init__(self, latent_dim: int, hidden: int, output_dim: int):
        self.W1 = np.random.randn(latent_dim, hidden) * 0.01; self.b1 = np.zeros(hidden)
        self.W2 = np.random.randn(hidden, hidden) * 0.01; self.b2 = np.zeros(hidden)
        self.W3 = np.random.randn(hidden, output_dim) * 0.01; self.b3 = np.zeros(output_dim)

    def forward(self, z: np.ndarray) -> np.ndarray:
        h1 = np.tanh(z @ self.W1 + self.b1)
        h2 = np.tanh(h1 @ self.W2 + self.b2)
        return h2 @ self.W3 + self.b3  # linear output for returns

    def clip_weights(self, c: float):
        for attr in ["W1", "W2", "W3", "b1", "b2", "b3"]:
            w = getattr(self, attr)
            setattr(self, attr, np.clip(w, -c, c))


class Discriminator:
    def __init__(self, input_dim: int, hidden: int):
        self.W1 = np.random.randn(input_dim, hidden) * 0.01; self.b1 = np.zeros(hidden)
        self.W2 = np.random.randn(hidden, hidden) * 0.01; self.b2 = np.zeros(hidden)
        self.W3 = np.random.randn(hidden, 1) * 0.01; self.b3 = np.zeros(1)

    def forward(self, x: np.ndarray) -> np.ndarray:
        h1 = np.maximum(0, x @ self.W1 + self.b1)  # LeakyReLU approx
        h2 = np.maximum(0, h1 @ self.W2 + self.b2)
        return h2 @ self.W3 + self.b3  # Wasserstein: no sigmoid

    def clip_weights(self, c: float):
        for attr in ["W1", "W2", "W3", "b1", "b2", "b3"]:
            w = getattr(self, attr)
            setattr(self, attr, np.clip(w, -c, c))

    def update(self, x_real: np.ndarray, x_fake: np.ndarray, lr: float):
        d_real = self.forward(x_real)
        d_fake = self.forward(x_fake)
        loss = -(d_real.mean() - d_fake.mean())  # Wasserstein loss

        # Gradient w.r.t. W3 (simplified)
        d_out_real = -np.ones_like(d_real) / len(d_real)
        d_out_fake = np.ones_like(d_fake) / len(d_fake)
        h2_real = np.maximum(0, np.maximum(0, x_real @ self.W1 + self.b1) @ self.W2 + self.b2)
        h2_fake = np.maximum(0, np.maximum(0, x_fake @ self.W1 + self.b1) @ self.W2 + self.b2)
        dW3 = h2_real.T @ d_out_real + h2_fake.T @ d_out_fake
        self.W3 -= lr * dW3
        self.b3 -= lr * (d_out_real.sum() + d_out_fake.sum())
        self.clip_weights(CLIP_VALUE)
        return float(loss)

    def generator_gradient(self, x_fake: np.ndarray) -> np.ndarray:
        return -np.ones((len(x_fake), 1)) / len(x_fake)


def run(cfg):
    np.random.seed(42)
    os.makedirs(cfg.outdir, exist_ok=True)
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()
    ret_wide = ret_wide.dropna(axis=1, thresh=int(len(ret_wide) * 0.8)).fillna(0)

    tickers = list(ret_wide.columns)
    n_assets = len(tickers)
    X_real = ret_wide.values.astype(float)
    X_mean, X_std = X_real.mean(0), X_real.std(0) + 1e-8
    X_norm = (X_real - X_mean) / X_std

    G = Generator(LATENT_DIM, HIDDEN_G, n_assets)
    D = Discriminator(n_assets, HIDDEN_D)

    train_records = []
    n_critic = 5  # update D more often

    for epoch in range(cfg.n_epochs):
        idx = np.random.permutation(len(X_norm))
        epoch_d_loss = []
        epoch_g_loss = []

        for b in range(0, len(X_norm) - BATCH_SIZE, BATCH_SIZE):
            batch_real = X_norm[idx[b:b + BATCH_SIZE]]

            # Update discriminator n_critic times
            for _ in range(n_critic):
                z = np.random.randn(BATCH_SIZE, LATENT_DIM)
                batch_fake = G.forward(z)
                d_loss = D.update(batch_real, batch_fake, LR_D)
                epoch_d_loss.append(d_loss)

            # Update generator (simple: update W3 of G to maximize D output)
            z = np.random.randn(BATCH_SIZE, LATENT_DIM)
            fake = G.forward(z)
            d_fake = D.forward(fake)
            g_loss = -d_fake.mean()
            epoch_g_loss.append(float(g_loss))
            # Simplified G gradient: push W3 toward higher D output
            grad_out = -np.ones_like(d_fake) / BATCH_SIZE
            h2_g = np.maximum(0, np.maximum(0, z @ G.W1 + G.b1) @ G.W2 + G.b2)
            G.W3 -= LR_G * h2_g.T @ grad_out
            G.clip_weights(1.0)

        if (epoch + 1) % 20 == 0:
            train_records.append({
                "epoch": epoch + 1,
                "avg_d_loss": float(np.mean(epoch_d_loss)),
                "avg_g_loss": float(np.mean(epoch_g_loss))
            })

    # Generate synthetic returns
    Z = np.random.randn(cfg.n_synthetic, LATENT_DIM)
    synthetic_norm = G.forward(Z)
    synthetic = synthetic_norm * X_std + X_mean

    synth_dates = pd.date_range("2000-01-01", periods=cfg.n_synthetic, freq="B")
    synth_df = pd.DataFrame(synthetic, index=synth_dates, columns=tickers)
    synth_df.index.name = "date"
    synth_df.to_csv(os.path.join(cfg.outdir, "synthetic_returns.csv"))

    # Distribution comparison
    dist_records = []
    for i, ticker in enumerate(tickers):
        real_col = X_real[:, i]
        synth_col = synthetic[:, i]
        dist_records.append({
            "ticker": ticker,
            "real_mean": float(real_col.mean()), "synth_mean": float(synth_col.mean()),
            "real_std": float(real_col.std()), "synth_std": float(synth_col.std()),
            "real_skew": float(pd.Series(real_col).skew()), "synth_skew": float(pd.Series(synth_col).skew()),
            "real_kurt": float(pd.Series(real_col).kurtosis()), "synth_kurt": float(pd.Series(synth_col).kurtosis()),
            "real_var99": float(np.percentile(real_col, 1)), "synth_var99": float(np.percentile(synth_col, 1))
        })

    pd.DataFrame(dist_records).to_csv(os.path.join(cfg.outdir, "distribution_stats.csv"), index=False)

    # Tail scenarios: worst 5% of synthetic paths (by portfolio loss)
    eq_weights = np.ones(n_assets) / n_assets
    port_returns = synthetic @ eq_weights
    worst_idx = np.argsort(port_returns)[:int(cfg.n_synthetic * 0.05)]
    tail_df = synth_df.iloc[worst_idx]
    tail_df.to_csv(os.path.join(cfg.outdir, "tail_scenarios.csv"))

    dist_df = pd.DataFrame(dist_records)
    summary = {
        "n_assets": n_assets, "n_synthetic": cfg.n_synthetic,
        "avg_mean_diff": float((dist_df["real_mean"] - dist_df["synth_mean"]).abs().mean()),
        "avg_std_diff_pct": float(((dist_df["real_std"] - dist_df["synth_std"]) / dist_df["real_std"]).abs().mean() * 100),
        "tail_var99_portfolio_real": float(np.percentile(X_real @ eq_weights, 1)),
        "tail_var99_portfolio_synth": float(np.percentile(port_returns, 1)),
        "training_epochs": cfg.n_epochs,
        "params": {"latent_dim": LATENT_DIM, "n_synthetic": cfg.n_synthetic, "n_epochs": cfg.n_epochs}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"GAN | Assets: {n_assets} | Synthetic: {cfg.n_synthetic} | Mean diff: {summary['avg_mean_diff']:.4f} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--n-epochs", type=int, default=N_EPOCHS)
    ap.add_argument("--n-synthetic", type=int, default=N_SYNTHETIC)
    ap.add_argument("--outdir", default="./artifacts/gan_synthetic")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
