#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
random_forest_signals.py — Random Forest multi-factor signal generator
=======================================================================
Trains a Random Forest classifier on technical + fundamental features to predict
5/10/21-day forward return sign. Features: price momentum (1/5/21d), volume z-score,
RSI, BB %B, ATR ratio, sector relative strength, earnings surprise, IV percentile.

Inputs (CSV)
------------
--prices   prices.csv
    Columns: date, ticker, close, volume, high, low
--factors  factors.csv (optional)
    Columns: date, ticker, eps_surprise, iv_pct, analyst_revisions

    
Outputs
-------
outdir/rf_signals.csv       date, ticker, rf_prob_up, rf_signal, feature_importance
outdir/feature_importance.csv  feature importance per model
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import accuracy_score, roc_auc_score


FEATURE_COLS = ["mom_1d", "mom_5d", "mom_21d", "vol_zscore", "rsi_14",
                "bb_pct_b", "atr_ratio", "price_zscore_63d", "volume_trend"]
FORWARD_DAYS = 10
TRAIN_WINDOW = 252


def compute_rsi(prices: pd.Series, window: int = 14) -> pd.Series:
    delta = prices.diff()
    up = delta.clip(lower=0).rolling(window).mean()
    down = (-delta.clip(upper=0)).rolling(window).mean()
    rs = up / down.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def compute_features(sub: pd.DataFrame) -> pd.DataFrame:
    close = sub["close"]
    high = sub.get("high", close)
    low = sub.get("low", close)
    volume = sub.get("volume", pd.Series(1, index=sub.index))

    sub = sub.copy()
    sub["mom_1d"] = close.pct_change(1) * 100
    sub["mom_5d"] = close.pct_change(5) * 100
    sub["mom_21d"] = close.pct_change(21) * 100
    vol_mean = volume.rolling(21).mean()
    vol_std = volume.rolling(21).std().replace(0, np.nan)
    sub["vol_zscore"] = (volume - vol_mean) / vol_std
    sub["rsi_14"] = compute_rsi(close, 14)
    bb_mid = close.rolling(20).mean()
    bb_std = close.rolling(20).std().replace(0, np.nan)
    sub["bb_pct_b"] = (close - (bb_mid - 2 * bb_std)) / (4 * bb_std.replace(0, np.nan))
    tr = pd.concat([high - low, (high - close.shift(1)).abs(), (low - close.shift(1)).abs()], axis=1).max(axis=1)
    sub["atr_ratio"] = tr.rolling(14).mean() / close.replace(0, np.nan)
    sub["price_zscore_63d"] = (close - close.rolling(63).mean()) / close.rolling(63).std().replace(0, np.nan)
    sub["volume_trend"] = volume.rolling(5).mean() / volume.rolling(21).mean().replace(0, np.nan) - 1
    sub["fwd_return"] = close.pct_change(FORWARD_DAYS).shift(-FORWARD_DAYS) * 100
    sub["label"] = (sub["fwd_return"] > 0).astype(int)
    return sub


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]

    factors = None
    if cfg.factors_file:
        factors = pd.read_csv(cfg.factors_file, parse_dates=["date"])
        factors.columns = [c.lower().strip() for c in factors.columns]

    all_signals = []
    all_importance = []

    for ticker in prices["ticker"].unique():
        sub = prices[prices["ticker"] == ticker].set_index("date").sort_index()
        if len(sub) < TRAIN_WINDOW + FORWARD_DAYS + 50:
            continue

        sub = compute_features(sub)

        if factors is not None and "ticker" in factors.columns:
            fac_sub = factors[factors["ticker"] == ticker].set_index("date")
            for col in ["eps_surprise", "iv_pct", "analyst_revisions"]:
                if col in fac_sub.columns:
                    sub[col] = fac_sub[col].reindex(sub.index).ffill()
                    if col not in FEATURE_COLS:
                        FEATURE_COLS.append(col)

        feat_cols_available = [c for c in FEATURE_COLS if c in sub.columns]
        df_clean = sub[feat_cols_available + ["label"]].dropna()
        if len(df_clean) < TRAIN_WINDOW + 30:
            continue

        tscv = TimeSeriesSplit(n_splits=min(5, len(df_clean) // TRAIN_WINDOW))
        all_probs = pd.Series(index=df_clean.index, dtype=float)
        feature_importances = []

        for train_idx, test_idx in tscv.split(df_clean):
            X_train = df_clean.iloc[train_idx][feat_cols_available]
            y_train = df_clean.iloc[train_idx]["label"]
            X_test = df_clean.iloc[test_idx][feat_cols_available]

            scaler = StandardScaler()
            X_train_s = scaler.fit_transform(X_train)
            X_test_s = scaler.transform(X_test)

            rf = RandomForestClassifier(
                n_estimators=cfg.n_estimators,
                max_depth=cfg.max_depth,
                min_samples_leaf=cfg.min_samples_leaf,
                random_state=42, n_jobs=-1
            )
            rf.fit(X_train_s, y_train)
            probs = rf.predict_proba(X_test_s)[:, 1]
            all_probs.iloc[test_idx] = probs
            feature_importances.append(dict(zip(feat_cols_available, rf.feature_importances_)))

        if feature_importances:
            avg_imp = {k: float(np.mean([fi[k] for fi in feature_importances])) for k in feat_cols_available}
            all_importance.append({"ticker": ticker, **avg_imp})

        for date, prob in all_probs.dropna().items():
            signal = "buy" if prob > cfg.prob_threshold else ("sell" if prob < (1 - cfg.prob_threshold) else "neutral")
            all_signals.append({"date": date, "ticker": ticker, "rf_prob_up": float(prob), "signal": signal})

    if not all_signals:
        print("No signals generated — check data size")
        return

    sig_df = pd.DataFrame(all_signals).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "rf_signals.csv"), index=False)

    if all_importance:
        pd.DataFrame(all_importance).to_csv(os.path.join(cfg.outdir, "feature_importance.csv"), index=False)

    # Backtest
    prices_wide = prices.pivot(index="date", columns="ticker", values="close").sort_index()
    ret_wide = prices_wide.pct_change()
    all_daily = []
    SIG_POS = {"buy": 1, "neutral": 0, "sell": -1}
    for ticker in sig_df["ticker"].unique():
        if ticker not in ret_wide.columns:
            continue
        pos = sig_df[sig_df["ticker"] == ticker].set_index("date")["signal"].map(SIG_POS).fillna(0)
        pos_daily = pos.reindex(ret_wide.index).ffill().shift(1).fillna(0)
        all_daily.append((pos_daily * ret_wide[ticker]).rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    top_features = pd.DataFrame(all_importance)[feat_cols_available].mean().nlargest(5).to_dict() if all_importance else {}
    summary = {
        "tickers": sig_df["ticker"].unique().tolist(),
        "n_buy_signals": int((sig_df["signal"] == "buy").sum()),
        "n_sell_signals": int((sig_df["signal"] == "sell").sum()),
        "top_features": top_features,
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"n_estimators": cfg.n_estimators, "max_depth": cfg.max_depth,
                   "prob_threshold": cfg.prob_threshold, "forward_days": FORWARD_DAYS}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Random Forest | Tickers: {len(summary['tickers'])} | Buy: {summary['n_buy_signals']} | Sell: {summary['n_sell_signals']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--factors", default=None, dest="factors_file")
    ap.add_argument("--n-estimators", type=int, default=200)
    ap.add_argument("--max-depth", type=int, default=6)
    ap.add_argument("--min-samples-leaf", type=int, default=20)
    ap.add_argument("--prob-threshold", type=float, default=0.6)
    ap.add_argument("--outdir", default="./artifacts/rf_signals")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
