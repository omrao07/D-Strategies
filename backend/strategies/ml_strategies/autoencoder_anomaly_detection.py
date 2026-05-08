#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
autoencoder_anomaly_detection.py — Autoencoder for market anomaly detection
============================================================================
Trains a shallow autoencoder (numpy/scipy-based, no PyTorch dependency) on
normal market behavior. High reconstruction error → anomaly → signal.
Uses price/volume/volatility windows as input. Anomaly during uptrend → fade;
anomaly during downtrend → mean reversion opportunity.

Inputs (CSV)
------------
--prices   prices.csv
    Columns: date, ticker, close, volume (optional), high (optional), low (optional)

Outputs
-------
outdir/anomaly_scores.csv   date, ticker, recon_error, error_zscore, is_anomaly, signal
outdir/anomaly_events.csv   high-confidence anomaly events and forward returns
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy.linalg import svd


WINDOW = 20       # look-back window for feature vector
N_LATENT = 5      # bottleneck dimension
ANOMALY_Z_THRESHOLD = 2.5
TRAIN_FRACTION = 0.6


def build_feature_matrix(series_dict: dict, window: int) -> np.ndarray:
    """Concatenate rolling windows of multiple series into feature rows."""
    rows = []
    min_len = min(len(v) for v in series_dict.values())
    for i in range(window, min_len):
        row = []
        for key, vals in series_dict.items():
            segment = vals[i - window:i]
            segment = (segment - np.mean(segment)) / (np.std(segment) + 1e-10)
            row.extend(segment)
        rows.append(row)
    return np.array(rows)


class LinearAutoencoder:
    """PCA-based autoencoder via SVD (exact reconstruction of n_latent dims)."""
    def __init__(self, n_latent: int):
        self.n_latent = n_latent
        self.components_ = None
        self.mean_ = None

    def fit(self, X: np.ndarray):
        self.mean_ = X.mean(axis=0)
        X_c = X - self.mean_
        U, S, Vt = svd(X_c, full_matrices=False)
        self.components_ = Vt[:self.n_latent]
        return self

    def reconstruct(self, X: np.ndarray) -> np.ndarray:
        X_c = X - self.mean_
        latent = X_c @ self.components_.T
        recon = latent @ self.components_ + self.mean_
        return recon

    def reconstruction_error(self, X: np.ndarray) -> np.ndarray:
        recon = self.reconstruct(X)
        return np.mean((X - recon) ** 2, axis=1)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]

    all_anomalies = []
    anomaly_events = []

    for ticker in prices["ticker"].unique():
        sub = prices[prices["ticker"] == ticker].set_index("date").sort_index()
        if len(sub) < WINDOW * 3 + 50:
            continue

        close = sub["close"].values
        volume = sub.get("volume", pd.Series(np.ones(len(sub)), index=sub.index)).values
        high = sub.get("high", sub["close"]).values
        low = sub.get("low", sub["close"]).values

        ret = np.diff(np.log(close + 1e-10))
        vol_hist = np.array([np.std(ret[max(0, i-20):i]) for i in range(len(ret))])
        hl_range = (high[1:] - low[1:]) / (close[1:] + 1e-10)
        vol_ratio = volume[1:] / (np.convolve(volume[1:], np.ones(21)/21, mode="same") + 1e-10)

        series_dict = {"ret": ret, "vol": vol_hist, "hl": hl_range, "vol_ratio": vol_ratio}
        min_len = min(len(v) for v in series_dict.values())
        series_dict = {k: v[:min_len] for k, v in series_dict.items()}

        X = build_feature_matrix(series_dict, WINDOW)
        if len(X) < 60:
            continue

        # Train on first TRAIN_FRACTION, detect anomalies on all
        n_train = int(len(X) * TRAIN_FRACTION)
        ae = LinearAutoencoder(n_latent=min(cfg.n_latent, X.shape[1] - 1))
        ae.fit(X[:n_train])

        errors = ae.reconstruction_error(X)
        error_series = pd.Series(errors)
        error_mean = error_series.expanding(min_periods=30).mean()
        error_std = error_series.expanding(min_periods=30).std().replace(0, np.nan)
        error_z = (error_series - error_mean) / error_std

        dates = sub.index[WINDOW + 1: WINDOW + 1 + len(errors)]

        for i, (date, err, ez) in enumerate(zip(dates, errors, error_z)):
            is_anomaly = not np.isnan(ez) and ez > ANOMALY_Z_THRESHOLD
            # Trend context
            close_idx = WINDOW + 1 + i
            trend = float(np.mean(ret[max(0, close_idx - 21):close_idx])) if close_idx > 21 else 0

            if is_anomaly:
                signal = "fade_anomaly" if trend > 0 else "mean_revert_anomaly"
            else:
                signal = "neutral"

            all_anomalies.append({
                "date": date, "ticker": ticker,
                "recon_error": float(err),
                "error_zscore": float(ez) if not np.isnan(ez) else None,
                "is_anomaly": bool(is_anomaly), "trend": float(trend),
                "signal": signal
            })

            if is_anomaly:
                fwd_window = min(10, len(ret) - close_idx - 1)
                fwd_ret = float(np.sum(ret[close_idx:close_idx + fwd_window])) if fwd_window > 0 else None
                anomaly_events.append({
                    "date": date, "ticker": ticker,
                    "error_zscore": float(ez),
                    "trend_context": "uptrend" if trend > 0 else "downtrend",
                    "signal": signal,
                    "fwd_10d_return": fwd_ret
                })

    if not all_anomalies:
        print("No anomalies detected — check data")
        return

    sig_df = pd.DataFrame(all_anomalies).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "anomaly_scores.csv"), index=False)
    if anomaly_events:
        pd.DataFrame(anomaly_events).to_csv(os.path.join(cfg.outdir, "anomaly_events.csv"), index=False)

    # Backtest
    price_wide = prices.pivot(index="date", columns="ticker", values="close").sort_index().pct_change()
    SIG_POS = {"fade_anomaly": -0.5, "mean_revert_anomaly": 1, "neutral": 0}
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

    ae_events = pd.DataFrame(anomaly_events) if anomaly_events else pd.DataFrame()
    summary = {
        "tickers": sig_df["ticker"].unique().tolist(),
        "total_anomaly_events": len(anomaly_events),
        "avg_fwd_10d_return_on_anomaly": float(ae_events["fwd_10d_return"].mean()) if not ae_events.empty and "fwd_10d_return" in ae_events else None,
        "anomaly_rate_pct": float((sig_df["is_anomaly"].sum() / len(sig_df)) * 100),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"window": WINDOW, "n_latent": cfg.n_latent, "anomaly_z": ANOMALY_Z_THRESHOLD}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Autoencoder Anomaly | Events: {summary['total_anomaly_events']} | Rate: {summary['anomaly_rate_pct']:.1f}% | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--n-latent", type=int, default=N_LATENT)
    ap.add_argument("--outdir", default="./artifacts/autoencoder_anomaly")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
