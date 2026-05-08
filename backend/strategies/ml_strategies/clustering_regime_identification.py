#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
clustering_regime_identification.py — K-Means/DBSCAN market regime clustering
===============================================================================
Clusters market observations (returns, volatility, macro features) into regimes
using K-Means. Each cluster gets a regime label based on average return and vol.
Cross-validates cluster stability with silhouette score. Uses current cluster
assignment for signal generation.

Inputs (CSV)
------------
--features features.csv
    Columns: date, feature1, feature2, ... (precomputed, e.g., returns, vol, VIX)
--returns  returns.csv (optional, for backtest)
    Columns: date, ticker, return

Outputs
-------
outdir/cluster_assignments.csv  date, cluster_id, regime_label, silhouette_score
outdir/cluster_stats.csv        per-cluster mean/std for each feature
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score, silhouette_samples
from sklearn.preprocessing import StandardScaler


N_CLUSTERS = 4
ROLLING_FIT_WINDOW = 252
MIN_CLUSTER_SIZE = 20


def label_cluster(cluster_id: int, cluster_means: dict) -> str:
    means = cluster_means[cluster_id]
    ret = means.get("return_feature", 0)
    vol = means.get("vol_feature", 0)
    if ret > 0 and vol < 0:
        return "bull_low_vol"
    elif ret > 0 and vol >= 0:
        return "bull_high_vol"
    elif ret <= 0 and vol > 0:
        return "bear_high_vol"
    else:
        return "bear_low_vol"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    features = pd.read_csv(cfg.features_file, parse_dates=["date"])
    features.columns = [c.lower().strip() for c in features.columns]
    features = features.set_index("date").sort_index()

    returns = None
    if cfg.returns_file:
        ret_raw = pd.read_csv(cfg.returns_file, parse_dates=["date"])
        ret_raw.columns = [c.lower().strip() for c in ret_raw.columns]
        returns = ret_raw.pivot(index="date", columns="ticker", values="return").sort_index()

    feat_cols = [c for c in features.columns if c != "date"]
    features_clean = features[feat_cols].dropna()

    scaler = StandardScaler()
    X = scaler.fit_transform(features_clean)

    # Optimal k via elbow / silhouette
    k_scores = {}
    for k in range(2, min(cfg.n_clusters + 3, 8)):
        km = KMeans(n_clusters=k, random_state=42, n_init=10)
        labels_k = km.fit_predict(X)
        if len(set(labels_k)) > 1:
            k_scores[k] = silhouette_score(X, labels_k)

    best_k = max(k_scores, key=k_scores.get) if k_scores else cfg.n_clusters

    # Final clustering
    km_final = KMeans(n_clusters=best_k, random_state=42, n_init=20)
    cluster_labels = km_final.fit_predict(X)
    sil_samples = silhouette_samples(X, cluster_labels)

    # Cluster statistics
    features_clean["cluster_id"] = cluster_labels
    features_clean["silhouette"] = sil_samples

    cluster_stats = []
    cluster_means = {}
    for cid in range(best_k):
        mask = features_clean["cluster_id"] == cid
        sub = features_clean[mask]
        stats_row = {"cluster_id": cid, "n_observations": int(mask.sum()),
                     "avg_silhouette": float(sub["silhouette"].mean())}
        means = {}
        for col in feat_cols:
            stats_row[f"mean_{col}"] = float(sub[col].mean())
            stats_row[f"std_{col}"] = float(sub[col].std())
            means[f"{col}_feature" if "_" not in col else col.replace(feat_cols[0], "return_feature")] = float(sub[col].mean())
        # Map first feature to return, second to vol for label
        if len(feat_cols) >= 2:
            means["return_feature"] = float(sub[feat_cols[0]].mean())
            means["vol_feature"] = float(sub[feat_cols[1]].mean())
        cluster_means[cid] = means
        cluster_stats.append(stats_row)

    pd.DataFrame(cluster_stats).to_csv(os.path.join(cfg.outdir, "cluster_stats.csv"), index=False)

    # Assign regime labels
    assignment_records = []
    SIG_MAP = {"bull_low_vol": "buy", "bull_high_vol": "mild_buy",
               "bear_high_vol": "sell", "bear_low_vol": "mild_sell"}

    for date, row in features_clean.iterrows():
        cid = int(row["cluster_id"])
        regime_label = label_cluster(cid, cluster_means)
        signal = SIG_MAP.get(regime_label, "neutral")
        assignment_records.append({
            "date": date, "cluster_id": cid, "regime_label": regime_label,
            "silhouette_score": float(row["silhouette"]),
            "signal": signal
        })

    assign_df = pd.DataFrame(assignment_records).sort_values("date")
    assign_df.to_csv(os.path.join(cfg.outdir, "cluster_assignments.csv"), index=False)

    # Backtest
    if returns is not None:
        SIG_POS = {"buy": 1, "mild_buy": 0.5, "neutral": 0, "mild_sell": -0.5, "sell": -1}
        pos = assign_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
        all_daily = []
        for ticker in returns.columns:
            ret_s = returns[ticker].dropna()
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
    else:
        sharpe, ann_ret = None, None

    latest = assign_df.iloc[-1] if not assign_df.empty else {}
    summary = {
        "optimal_k": best_k,
        "silhouette_scores_by_k": {str(k): float(v) for k, v in k_scores.items()},
        "best_silhouette": float(max(k_scores.values())) if k_scores else None,
        "cluster_distribution": {str(cid): int((cluster_labels == cid).sum()) for cid in range(best_k)},
        "current_regime": str(latest.get("regime_label", "N/A")),
        "current_signal": str(latest.get("signal", "N/A")),
        "ann_return": ann_ret, "sharpe": sharpe,
        "params": {"n_clusters": cfg.n_clusters}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Clustering | Best k: {best_k} | Silhouette: {summary['best_silhouette']:.3f if summary['best_silhouette'] else 'N/A'} | Current: {summary['current_regime']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--features", required=True, dest="features_file")
    ap.add_argument("--returns", default=None, dest="returns_file")
    ap.add_argument("--n-clusters", type=int, default=N_CLUSTERS)
    ap.add_argument("--outdir", default="./artifacts/clustering")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
