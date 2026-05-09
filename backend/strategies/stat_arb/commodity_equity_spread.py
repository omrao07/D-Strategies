#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
commodity_equity_spread.py — MCX commodity vs NSE commodity-stock spread
=========================================================================
Tracks the spread between MCX commodity prices and their NSE-listed equity
proxies. When the commodity price moves but the stock hasn't (or vice versa),
the spread reverts as the equity re-prices.

Pairs traded:
  - MCX Gold vs GOLDBEES/GOLDIAM/TITAN
  - MCX Silver vs SILVERM/MUTHOOTFIN
  - MCX Crude vs ONGC/RELIANCE/IOC
  - MCX Natural Gas vs GAIL/IGL/MGL
  - MCX Copper vs HINDALCO/VEDL/HINDUCOPPER
  - MCX Zinc vs HINDUSTAN ZINC (HINDZINC)

Inputs (CSV)
------------
--mcx       mcx.csv         date, commodity (GOLD/SILVER/CRUDEOIL/etc), close_mcx
--stocks    stocks.csv      date, ticker, close

Outputs
-------
outdir/commodity_equity_basis.csv   date, commodity, stock, basis_pct, z_score, signal
outdir/backtest.csv                 cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd

COMMODITY_PAIRS = {
    "GOLD":      ["GOLDBEES", "TITAN", "GOLDIAM"],
    "SILVER":    ["SILVERBEES", "MUTHOOTFIN"],
    "CRUDEOIL":  ["ONGC", "RELIANCE", "IOC"],
    "NATURALGAS":["GAIL", "IGL", "MGL"],
    "COPPER":    ["HINDALCO", "HINDUCOPPER", "VEDL"],
    "ZINC":      ["HINDZINC"],
    "ALUMINIUM": ["HINDALCO", "NATIONALUM"],
}

ENTRY_Z = 2.0
EXIT_Z = 0.5
ZSCORE_WINDOW = 30
HEDGE_WINDOW = 60


def rolling_beta(y: np.ndarray, x: np.ndarray, window: int) -> np.ndarray:
    betas = np.full(len(y), np.nan)
    for i in range(window, len(y)):
        yi = y[i - window: i]
        xi = x[i - window: i]
        X = np.column_stack([xi, np.ones(len(xi))])
        b = np.linalg.lstsq(X, yi, rcond=None)[0]
        betas[i] = b[0]
    return betas


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    mcx = pd.read_csv(cfg.mcx_file, parse_dates=["date"])
    mcx.columns = [c.lower().strip() for c in mcx.columns]
    mcx_wide = mcx.pivot_table(index="date", columns="commodity", values="close_mcx").sort_index()
    mcx_wide.columns = [c.upper() for c in mcx_wide.columns]

    stocks = pd.read_csv(cfg.stocks_file, parse_dates=["date"])
    stocks.columns = [c.lower().strip() for c in stocks.columns]
    stocks_wide = stocks.pivot_table(index="date", columns="ticker", values="close").sort_index()
    stocks_wide.columns = [c.upper() for c in stocks_wide.columns]

    all_port = []
    basis_records = []

    for commodity, tickers in COMMODITY_PAIRS.items():
        if commodity not in mcx_wide.columns:
            continue
        comm_px = mcx_wide[commodity].dropna()

        for ticker in tickers:
            if ticker not in stocks_wide.columns:
                continue
            stock_px = stocks_wide[ticker].dropna()

            common = comm_px.index.intersection(stock_px.index)
            if len(common) < HEDGE_WINDOW + 30:
                continue

            comm_log = np.log(comm_px.reindex(common).values)
            stock_log = np.log(stock_px.reindex(common).values)

            # Rolling beta
            betas = rolling_beta(stock_log, comm_log, HEDGE_WINDOW)
            spread = stock_log - betas * comm_log

            spread_s = pd.Series(spread, index=common)
            mu = spread_s.rolling(ZSCORE_WINDOW).mean()
            sigma = spread_s.rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
            z = (spread_s - mu) / sigma

            pos = z.shift(1).apply(
                lambda v: -1 if v > ENTRY_Z else (1 if v < -ENTRY_Z else (0 if abs(v) < EXIT_Z else np.nan))
            ).ffill().fillna(0)

            comm_ret = comm_px.reindex(common).pct_change()
            stock_ret = stock_px.reindex(common).pct_change()
            pair_ret = pos * (stock_ret - pd.Series(betas, index=common) * comm_ret)
            all_port.append(pair_ret.rename(f"{commodity}/{ticker}"))

            for i, dt in enumerate(common):
                if not np.isnan(z.iloc[i]):
                    basis_records.append({
                        "date": dt.date(),
                        "commodity": commodity,
                        "stock": ticker,
                        "comm_close": float(comm_px.loc[dt]),
                        "stock_close": float(stock_px.loc[dt]),
                        "spread": float(spread_s.iloc[i]),
                        "z_score": float(z.iloc[i]),
                        "signal": "short_stock" if pos.iloc[i] == -1 else ("long_stock" if pos.iloc[i] == 1 else "flat"),
                    })

    if basis_records:
        pd.DataFrame(basis_records).sort_values("date").to_csv(
            os.path.join(cfg.outdir, "commodity_equity_basis.csv"), index=False
        )

    if all_port:
        portfolio = pd.concat(all_port, axis=1).mean(axis=1).dropna()
        cum = (1 + portfolio).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(portfolio.mean() / portfolio.std() * np.sqrt(252)) if portfolio.std() > 0 else None
    else:
        sharpe = None
        portfolio = pd.Series(dtype=float)

    summary = {
        "n_pairs": len(all_port),
        "n_observations": len(basis_records),
        "ann_return": float(portfolio.mean() * 252) if len(portfolio) > 0 else None,
        "sharpe": sharpe,
        "params": {"entry_z": ENTRY_Z, "hedge_window": HEDGE_WINDOW, "zscore_window": ZSCORE_WINDOW}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"MCX/Equity Spread | {len(all_port)} pairs | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mcx", required=True, dest="mcx_file")
    ap.add_argument("--stocks", required=True, dest="stocks_file")
    ap.add_argument("--outdir", default="./artifacts/commodity_equity_spread")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
