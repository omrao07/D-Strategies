#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pca_factor_extraction.py — PCA latent factor extraction for cross-sectional alpha
====================================================================================
Applies PCA to returns matrix to extract orthogonal risk factors. Residual returns
(alpha) after projecting out the top N principal components represent idiosyncratic
exposure. Extreme positive residuals → buy; extreme negatives → sell.

Inputs (CSV)
------------
--returns  returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/pca_factors.csv      date, PC1..PCn, explained_var
outdir/residual_signals.csv date, ticker, raw_return, pc_fitted, residual, signal
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse
import json
import os

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler

N_COMPONENTS = 5
ROLLING_WINDOW = 63     # days for rolling PCA
RESIDUAL_THRESHOLD = 1.5  # z-score of residual to generate signal


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()
    ret_wide = ret_wide.dropna(axis=1, thresh=int(len(ret_wide) * 0.8))  # drop sparse tickers
    ret_wide = ret_wide.fillna(0)

    n_comp = min(cfg.n_components, ret_wide.shape[1] - 1)

    # Full-sample PCA for reference
    scaler_full = StandardScaler()
    X_full = scaler_full.fit_transform(ret_wide.T)  # shape: tickers × dates
    pca_full = PCA(n_components=n_comp)
    pca_full.fit(X_full)

    factor_records = []
    signal_records = []

    for i in range(ROLLING_WINDOW, len(ret_wide)):
        window = ret_wide.iloc[i - ROLLING_WINDOW:i]
        date = ret_wide.index[i]
        today_returns = ret_wide.iloc[i]

        # Fit PCA on rolling window
        scaler = StandardScaler()
        X = scaler.fit_transform(window.T)
        pca = PCA(n_components=min(n_comp, X.shape[1] - 1))
        pca.fit(X)

        # Project today's cross-sectional returns onto rolling factors
        scaler.transform(today_returns.values.reshape(1, -1))  # shape: 1 × dates — wrong
        # Correct: PCA is on tickers × dates space; project returns in ticker space
        # Instead: use PCA on dates × tickers (standard)
        X_dt = scaler.fit_transform(window)  # shape: dates × tickers
        pca_dt = PCA(n_components=min(n_comp, X_dt.shape[1] - 1))
        pca_dt.fit(X_dt)

        today_s = (today_returns.values - scaler.mean_) / (scaler.scale_ + 1e-10)
        today_s = today_s.reshape(1, -1)
        today_projected = today_s @ pca_dt.components_.T @ pca_dt.components_
        residuals = (today_s - today_projected).flatten()

        factor_record = {"date": date}
        for k in range(min(n_comp, pca_dt.n_components_)):
            factor_record[f"PC{k+1}_loading"] = float(pca_dt.explained_variance_ratio_[k])
        factor_records.append(factor_record)

        # Residual z-scores cross-sectionally
        res_std = float(np.std(residuals)) if np.std(residuals) > 0 else 1.0
        for j, ticker in enumerate(ret_wide.columns):
            resid_z = residuals[j] / res_std
            signal = "buy" if resid_z > RESIDUAL_THRESHOLD else \
                     ("sell" if resid_z < -RESIDUAL_THRESHOLD else "neutral")
            signal_records.append({
                "date": date, "ticker": ticker,
                "raw_return": float(today_returns.iloc[j]),
                "pc_fitted": float(today_projected.flatten()[j] * (scaler.scale_[j] + 1e-10) + scaler.mean_[j]),
                "residual": float(residuals[j]),
                "residual_zscore": float(resid_z),
                "signal": signal
            })

    factor_df = pd.DataFrame(factor_records).sort_values("date")
    factor_df.to_csv(os.path.join(cfg.outdir, "pca_factors.csv"), index=False)

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "residual_signals.csv"), index=False)

    # Backtest: long top residuals, short bottom residuals (market neutral)
    all_daily = []
    SIG_POS = {"buy": 1, "neutral": 0, "sell": -1}
    for ticker in sig_df["ticker"].unique():
        pos = sig_df[sig_df["ticker"] == ticker].set_index("date")["signal"].map(SIG_POS).fillna(0)
        ret_s = ret_wide[ticker].dropna()
        pos_daily = pos.reindex(ret_s.index).shift(1).fillna(0)
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
        "n_tickers": ret_wide.shape[1],
        "n_components": n_comp,
        "explained_variance_pct": [float(v * 100) for v in pca_full.explained_variance_ratio_],
        "total_explained_pct": float(pca_full.explained_variance_ratio_.sum() * 100),
        "n_buy_signals": int((sig_df["signal"] == "buy").sum()),
        "n_sell_signals": int((sig_df["signal"] == "sell").sum()),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"n_components": n_comp, "rolling_window": ROLLING_WINDOW, "residual_threshold": RESIDUAL_THRESHOLD}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"PCA | Components: {n_comp} | Explained: {summary['total_explained_pct']:.1f}% | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--n-components", type=int, default=N_COMPONENTS)
    ap.add_argument("--outdir", default="./artifacts/pca_factors")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
