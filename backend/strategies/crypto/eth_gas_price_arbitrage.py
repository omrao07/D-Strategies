#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eth_gas_price_arbitrage.py — ETH gas price regime predicts on-chain activity & price
=======================================================================================
High Ethereum gas prices signal intense DeFi/NFT demand → network congestion →
bearish short-term (users exit), bullish medium-term (high utility). Extremely low
gas signals activity drought → bearish for ETH ecosystem tokens.

Inputs (CSV)
------------
--gas      eth_gas.csv
    Columns: date, avg_gas_gwei, base_fee_gwei, priority_fee_gwei,
             gas_used_pct, pending_txns
--prices   crypto_prices.csv
    Columns: date, ticker, price (ETH, BTC, DeFi tokens, etc.)

Outputs
-------
outdir/gas_regime.csv           date, gas_zscore, regime, signal per ticker
outdir/gas_vs_price.csv         correlation by ticker
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


GAS_REGIMES = {
    "ultra_low": (0, 10),
    "low": (10, 30),
    "normal": (30, 80),
    "high": (80, 150),
    "extreme": (150, np.inf)
}


def classify_regime(gwei: float) -> str:
    for regime, (lo, hi) in GAS_REGIMES.items():
        if lo <= gwei < hi:
            return regime
    return "extreme"


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    gas = pd.read_csv(cfg.gas_file, parse_dates=["date"])
    gas.columns = [c.lower().strip() for c in gas.columns]
    gas = gas.set_index("date").sort_index()
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]
    price_wide = prices.pivot(index="date", columns="ticker", values="price").sort_index()

    gas_col = "avg_gas_gwei" if "avg_gas_gwei" in gas.columns else gas.columns[0]
    gas_series = gas[gas_col].dropna()

    # Gas regime features
    gas["regime"] = gas[gas_col].apply(classify_regime)
    gas["gas_zscore"] = (gas[gas_col] - gas[gas_col].rolling(30).mean()) / \
                         gas[gas_col].rolling(30).std().replace(0, np.nan)
    gas["gas_mom7d"] = gas[gas_col].pct_change(7)
    gas["gas_mom1d"] = gas[gas_col].pct_change(1)

    # Signal logic:
    # Extreme gas spike (zscore > 2): short-term sell (congestion, fee shock)
    # Ultra-low gas (zscore < -2): medium-term sell (low activity)
    # Normalizing from extreme (zscore dropping from >2 to 0-2): buy signal
    gas["signal_eth"] = gas["gas_zscore"].apply(
        lambda z: "sell" if z > 2.5 else ("sell" if z < -2.5 else ("buy" if 1.0 < z < 2.0 else "neutral"))
    )

    regime_records = []
    for date, row in gas.iterrows():
        regime_records.append({
            "date": date, "gas_gwei": float(row[gas_col]),
            "gas_zscore": float(row["gas_zscore"]) if not np.isnan(row["gas_zscore"]) else None,
            "regime": row["regime"], "signal_eth": row["signal_eth"],
            "gas_mom7d": float(row["gas_mom7d"]) if not np.isnan(row["gas_mom7d"]) else None
        })

    regime_df = pd.DataFrame(regime_records).sort_values("date")
    regime_df.to_csv(os.path.join(cfg.outdir, "gas_regime.csv"), index=False)

    # Correlation: gas z-score vs ticker returns
    corr_records = []
    all_daily = []
    for ticker in price_wide.columns:
        ret = price_wide[ticker].pct_change().dropna()
        fwd5 = ret.rolling(5).sum().shift(-5)
        gas_z_daily = gas["gas_zscore"].reindex(ret.index, method="ffill").dropna()
        aligned = gas_z_daily.align(fwd5.dropna(), join="inner")
        if len(aligned[0]) > 20:
            r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
            corr_records.append({"ticker": ticker, "gas_fwd5d_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

        # Backtest per ticker
        sig = gas["signal_eth"].reindex(ret.index, method="ffill")
        pos = sig.map({"buy": 1, "sell": -1, "neutral": 0}).fillna(0).shift(1)
        strat = pos * ret
        all_daily.append(strat.rename(ticker))

    corr_df = pd.DataFrame(corr_records).sort_values("gas_fwd5d_corr") if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "gas_vs_price.csv"), index=False)

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(365)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 365)
    else:
        sharpe, ann_ret = None, None

    regime_counts = gas["regime"].value_counts().to_dict()
    summary = {
        "n_obs": len(gas), "regime_distribution": regime_counts,
        "avg_gas_gwei": float(gas_series.mean()), "max_gas_gwei": float(gas_series.max()),
        "pct_extreme": float((gas["regime"] == "extreme").mean()),
        "avg_corr_fwd5d": float(corr_df["gas_fwd5d_corr"].mean()) if not corr_df.empty else None,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"ETH gas | Avg: {summary['avg_gas_gwei']:.1f} gwei | Extreme {summary['pct_extreme']:.1%} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gas", required=True, dest="gas_file")
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--outdir", default="./artifacts/eth_gas_arb")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
