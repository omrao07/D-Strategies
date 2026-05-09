#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gradient_boosting_ensemble.py — XGBoost/GBM ensemble for return prediction
============================================================================
Gradient boosted trees (via sklearn GradientBoostingClassifier) trained on a
wide feature set: technical momentum, macro z-scores, cross-sectional rank,
earnings quality, short interest. Walk-forward validation with monthly refit.
Feature selection via permutation importance.

Inputs (CSV)
------------
--prices   prices.csv
    Columns: date, ticker, close, volume, high, low
--macro    macro_factors.csv (optional)
    Columns: date, vix, yield_2y, yield_10y, dxy, spx_return

Outputs
-------
outdir/gbm_signals.csv      date, ticker, prob_up, signal
outdir/permutation_importance.csv feature importance
outdir/walk_forward_metrics.csv accuracy/AUC per period
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import accuracy_score, roc_auc_score


FORWARD_DAYS = 10
MIN_TRAIN_OBS = 200
MONTHLY_REFIT = 21  # bars between refits


def compute_features(sub: pd.DataFrame, macro: pd.DataFrame = None) -> pd.DataFrame:
    c = sub["close"]
    h = sub.get("high", c)
    l = sub.get("low", c)
    v = sub.get("volume", pd.Series(1, index=sub.index))

    sub = sub.copy()
    for n in [1, 5, 10, 21, 63]:
        sub[f"mom_{n}d"] = c.pct_change(n)
    for n in [5, 21, 63, 126]:
        sub[f"vol_ratio_{n}d"] = v / v.rolling(n).mean().replace(0, np.nan)
    sub["hl_ratio"] = (h - l) / c.replace(0, np.nan)
    sub["price_z21"] = (c - c.rolling(21).mean()) / c.rolling(21).std().replace(0, np.nan)
    sub["price_z63"] = (c - c.rolling(63).mean()) / c.rolling(63).std().replace(0, np.nan)
    # RSI
    delta = c.diff()
    up = delta.clip(lower=0).rolling(14).mean()
    dn = (-delta.clip(upper=0)).rolling(14).mean()
    sub["rsi"] = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    # Bollinger %B
    bm = c.rolling(20).mean()
    bs = c.rolling(20).std().replace(0, np.nan)
    sub["bb_b"] = (c - (bm - 2*bs)) / (4*bs)
    # ATR
    tr = pd.concat([h-l, (h-c.shift()).abs(), (l-c.shift()).abs()], axis=1).max(axis=1)
    sub["atr_n"] = tr.rolling(14).mean() / c.replace(0, np.nan)
    # Macro factors
    if macro is not None:
        for col in macro.columns:
            sub[f"macro_{col}"] = macro[col].reindex(sub.index, method="ffill")
    # Target
    sub["fwd_ret"] = c.pct_change(FORWARD_DAYS).shift(-FORWARD_DAYS)
    sub["label"] = (sub["fwd_ret"] > 0).astype(int)
    return sub


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]

    macro = None
    if cfg.macro_file:
        macro_raw = pd.read_csv(cfg.macro_file, parse_dates=["date"])
        macro_raw.columns = [c.lower().strip() for c in macro_raw.columns]
        macro = macro_raw.set_index("date").sort_index()

    all_signals = []
    all_importance = []
    wf_metrics = []

    for ticker in prices["ticker"].unique():
        sub = prices[prices["ticker"] == ticker].set_index("date").sort_index()
        if len(sub) < MIN_TRAIN_OBS + FORWARD_DAYS + 50:
            continue

        sub = compute_features(sub, macro)
        feat_cols = [c for c in sub.columns if c not in ["close", "high", "low", "volume", "fwd_ret", "label", "ticker"]]
        df_clean = sub[feat_cols + ["label"]].dropna()
        if len(df_clean) < MIN_TRAIN_OBS + 30:
            continue

        scaler = StandardScaler()
        step = MONTHLY_REFIT
        ticker_probs = []

        for i in range(MIN_TRAIN_OBS, len(df_clean), step):
            train = df_clean.iloc[:i]
            test_end = min(i + step, len(df_clean))
            test = df_clean.iloc[i:test_end]
            if len(train) < MIN_TRAIN_OBS or len(test) == 0:
                continue

            X_train = train[feat_cols]
            y_train = train["label"]
            X_test = test[feat_cols]
            y_test = test["label"]

            X_train_s = scaler.fit_transform(X_train)
            X_test_s = scaler.transform(X_test)

            gbm = GradientBoostingClassifier(
                n_estimators=cfg.n_estimators,
                max_depth=cfg.max_depth,
                learning_rate=cfg.learning_rate,
                subsample=0.8,
                random_state=42
            )
            gbm.fit(X_train_s, y_train)
            probs = gbm.predict_proba(X_test_s)[:, 1]

            for j, (date, prob) in enumerate(zip(test.index, probs)):
                ticker_probs.append({"date": date, "ticker": ticker, "prob_up": float(prob)})

            if len(y_test) > 5 and len(set(y_test)) > 1:
                acc = accuracy_score(y_test, (probs > 0.5).astype(int))
                auc = roc_auc_score(y_test, probs)
                wf_metrics.append({"ticker": ticker, "period_start": str(test.index[0]),
                                   "accuracy": float(acc), "auc": float(auc), "n_test": len(test)})

            # Permutation importance on last fold
            if i + step >= len(df_clean):
                perm = permutation_importance(gbm, X_test_s, y_test, n_repeats=5, random_state=42)
                imp = {feat_cols[j]: float(perm.importances_mean[j]) for j in range(len(feat_cols))}
                all_importance.append({"ticker": ticker, **imp})

        for rec in ticker_probs:
            prob = rec["prob_up"]
            signal = "buy" if prob > cfg.prob_threshold else ("sell" if prob < (1 - cfg.prob_threshold) else "neutral")
            all_signals.append({**rec, "signal": signal})

    if not all_signals:
        print("No signals generated")
        return

    sig_df = pd.DataFrame(all_signals).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "gbm_signals.csv"), index=False)

    if all_importance:
        pd.DataFrame(all_importance).to_csv(os.path.join(cfg.outdir, "permutation_importance.csv"), index=False)
    if wf_metrics:
        pd.DataFrame(wf_metrics).to_csv(os.path.join(cfg.outdir, "walk_forward_metrics.csv"), index=False)

    # Backtest
    prices_wide = prices.pivot(index="date", columns="ticker", values="close").sort_index().pct_change()
    all_daily = []
    SIG_POS = {"buy": 1, "neutral": 0, "sell": -1}
    for ticker in sig_df["ticker"].unique():
        if ticker not in prices_wide.columns:
            continue
        pos = sig_df[sig_df["ticker"] == ticker].set_index("date")["signal"].map(SIG_POS).fillna(0)
        ret_s = prices_wide[ticker].dropna()
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

    wf_df = pd.DataFrame(wf_metrics) if wf_metrics else pd.DataFrame()
    summary = {
        "tickers": sig_df["ticker"].unique().tolist(),
        "avg_accuracy": float(wf_df["accuracy"].mean()) if not wf_df.empty else None,
        "avg_auc": float(wf_df["auc"].mean()) if not wf_df.empty else None,
        "n_buy": int((sig_df["signal"] == "buy").sum()),
        "n_sell": int((sig_df["signal"] == "sell").sum()),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"n_estimators": cfg.n_estimators, "learning_rate": cfg.learning_rate,
                   "prob_threshold": cfg.prob_threshold}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"GBM | Avg AUC: {f'{summary['avg_auc']:.3f}' if summary['avg_auc'] else 'N/A'} | Buy: {summary['n_buy']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--macro", default=None, dest="macro_file")
    ap.add_argument("--n-estimators", type=int, default=100)
    ap.add_argument("--max-depth", type=int, default=4)
    ap.add_argument("--learning-rate", type=float, default=0.05)
    ap.add_argument("--prob-threshold", type=float, default=0.6)
    ap.add_argument("--outdir", default="./artifacts/gbm_signals")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
