#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mining_difficulty_vs_price.py — Hash rate / difficulty vs BTC price divergence
================================================================================
Bitcoin mining difficulty adjusts every 2016 blocks (~2 weeks). Rising difficulty
= miner confidence in future price. When price lags difficulty surge, it's a
bullish divergence. When price crashes but difficulty holds, miners are holding →
eventual capitulation causes further drops (miner capitulation signal).

Inputs (CSV)
------------
--mining   mining_data.csv
    Columns: date, difficulty, hash_rate_eh, block_reward_usd,
             miner_revenue_usd, cost_to_mine_usd
--prices   btc_prices.csv
    Columns: date, price

Outputs
-------
outdir/difficulty_signals.csv   date, difficulty_pct_chg, hash_vs_price_ratio, signal
outdir/miner_capitulation.csv   capitulation events with forward returns
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


def detect_miner_capitulation(series_price: pd.Series, series_hashrate: pd.Series,
                               window: int = 14) -> pd.Series:
    """Capitulation: price drops >20% while hash rate drops >10% in same window."""
    price_chg = series_price.pct_change(window)
    hash_chg = series_hashrate.pct_change(window)
    cap = (price_chg < -0.20) & (hash_chg < -0.10)
    return cap.rename("capitulation")


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    mining = pd.read_csv(cfg.mining_file, parse_dates=["date"])
    mining.columns = [c.lower().strip() for c in mining.columns]
    mining = mining.set_index("date").sort_index()
    btc = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    btc.columns = [c.lower().strip() for c in btc.columns]
    btc = btc.set_index("date")["price"].sort_index()

    # Align
    merged = mining.join(btc.rename("btc_price"), how="inner").dropna(subset=["btc_price"])

    diff_col = "difficulty" if "difficulty" in merged.columns else merged.columns[0]
    hash_col = "hash_rate_eh" if "hash_rate_eh" in merged.columns else None

    merged["diff_pct_chg_14d"] = merged[diff_col].pct_change(14)
    merged["price_pct_chg_14d"] = merged["btc_price"].pct_change(14)
    merged["diff_zscore"] = (merged[diff_col] - merged[diff_col].rolling(90).mean()) / \
                             merged[diff_col].rolling(90).std().replace(0, np.nan)

    # Puell Multiple: miner revenue / 365-day avg miner revenue
    if "miner_revenue_usd" in merged.columns:
        merged["puell_multiple"] = merged["miner_revenue_usd"] / \
                                    merged["miner_revenue_usd"].rolling(365, min_periods=100).mean()
    else:
        merged["puell_multiple"] = np.nan

    # Hash ribbon: hash_rate MA30 vs MA60 crossover
    if hash_col:
        merged["hash_ma30"] = merged[hash_col].rolling(30).mean()
        merged["hash_ma60"] = merged[hash_col].rolling(60).mean()
        merged["hash_ribbon_bull"] = merged["hash_ma30"] > merged["hash_ma60"]
        merged["hash_ribbon_recovery"] = (merged["hash_ma30"] > merged["hash_ma60"]) & \
                                          (merged["hash_ma30"].shift(1) <= merged["hash_ma60"].shift(1))

    # Miner capitulation
    if hash_col:
        cap = detect_miner_capitulation(merged["btc_price"], merged[hash_col])
        merged["capitulation"] = cap

    signal_records = []
    cap_records = []

    for date, row in merged.iterrows():
        diff_chg = row.get("diff_pct_chg_14d", np.nan) or 0
        price_chg = row.get("price_pct_chg_14d", np.nan) or 0
        diff_z = row.get("diff_zscore", np.nan)
        puell = row.get("puell_multiple", np.nan)

        # Bullish divergence: difficulty rising faster than price
        bull_div = diff_chg > 0.05 and price_chg < diff_chg * 0.5
        # Miner capitulation: bottom signal
        is_cap = row.get("capitulation", False)
        # Puell multiple: extreme low (<0.5) = buy, extreme high (>4) = sell
        puell_buy = not np.isnan(puell) and puell < 0.5
        puell_sell = not np.isnan(puell) and puell > 4.0
        # Hash ribbon recovery
        hash_recover = row.get("hash_ribbon_recovery", False)

        if is_cap or (puell_buy and bull_div):
            signal = "buy_capitulation_bottom"
        elif hash_recover:
            signal = "buy_hash_ribbon"
        elif puell_sell:
            signal = "sell_overheated"
        elif not np.isnan(diff_z) and diff_z < -2:
            signal = "caution_diff_crash"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date, "difficulty": float(row[diff_col]),
            "difficulty_pct_chg_14d": float(diff_chg) if not np.isnan(diff_chg) else None,
            "btc_price": float(row["btc_price"]),
            "price_pct_chg_14d": float(price_chg) if not np.isnan(price_chg) else None,
            "puell_multiple": float(puell) if not np.isnan(puell) else None,
            "capitulation": bool(is_cap), "hash_ribbon_recovery": bool(hash_recover),
            "signal": signal
        })

        if is_cap:
            cap_records.append({"date": date, "btc_price": float(row["btc_price"]),
                                 "diff_chg": float(diff_chg), "price_chg": float(price_chg)})

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "difficulty_signals.csv"), index=False)

    if cap_records:
        cap_df = pd.DataFrame(cap_records)
        # Forward returns after capitulation
        cap_df["fwd_30d_ret"] = [btc.reindex(pd.date_range(r["date"], periods=31, freq="D")).iloc[-1] / r["btc_price"] - 1
                                  if r["date"] in btc.index else None for _, r in cap_df.iterrows()]
        cap_df.to_csv(os.path.join(cfg.outdir, "miner_capitulation.csv"), index=False)

    # Backtest: long on buy signals, short on sell
    pos = sig_df.set_index("date")["signal"].map(
        {"buy_capitulation_bottom": 1, "buy_hash_ribbon": 1,
         "sell_overheated": -1, "caution_diff_crash": -0.5, "neutral": 0}
    ).fillna(0)
    ret = merged["btc_price"].pct_change().dropna()
    pos_aligned = pos.reindex(ret.index, method="ffill").shift(1).fillna(0)
    strat = pos_aligned * ret
    cum = (1 + strat).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
    sharpe = float(strat.mean() / strat.std() * np.sqrt(365)) if strat.std() > 0 else None

    summary = {
        "n_obs": len(sig_df), "n_capitulation_events": len(cap_records),
        "n_hash_ribbon_signals": int((sig_df["signal"] == "buy_hash_ribbon").sum()),
        "avg_puell_multiple": float(merged["puell_multiple"].dropna().mean()) if "puell_multiple" in merged.columns else None,
        "sharpe": sharpe, "ann_return": float(strat.mean() * 365)
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Mining difficulty | Capitulations: {len(cap_records)} | Hash ribbon signals: {summary['n_hash_ribbon_signals']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mining", required=True, dest="mining_file")
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--outdir", default="./artifacts/mining_difficulty")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
