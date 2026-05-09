#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nifty_index_rebalance.py — NIFTY 50/100/500 index rebalance front-running
==========================================================================
NSE announces index changes (additions/removals) 4-6 weeks before effective date.
Passive funds tracking NIFTY indices must rebalance on the announcement date.
This strategy front-runs additions (buy before) and removals (sell before),
capturing the price impact of forced passive-fund buying/selling.

India moat: NSE index AUM is growing rapidly (₹8+ lakh crore tracking NIFTY 50).
Each addition/removal causes predictable demand/supply shock. Global quant funds
underweight this because NSE index change data isn't cleanly available via Bloomberg.

Inputs (CSV)
------------
--changes   index_changes.csv   announce_date, effective_date, ticker, action (ADD/REMOVE), index_name
--prices    prices.csv          date, ticker, close, volume

Outputs
-------
outdir/rebalance_events.csv     event details with pre/post returns
outdir/signals.csv              date, ticker, signal, days_to_effective
outdir/backtest.csv             cumulative P&L from rebalance trades
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd

# Strategy parameters
ENTRY_DAYS_AFTER_ANNOUNCE = 2   # Enter 2 days after announcement
EXIT_DAYS_BEFORE_EFFECTIVE = 1  # Exit 1 day before effective date
MIN_PRICE_IMPACT_PCT = 1.5      # Expect >= 1.5% move on announcement
HOLD_WINDOW_DAYS = 30           # Max hold period (safety)

# NIFTY index passive AUM weights (for position sizing)
INDEX_AUM_WEIGHT = {
    "NIFTY50": 1.0,
    "NIFTY100": 0.4,
    "NIFTY200": 0.2,
    "NIFTY500": 0.1,
    "NIFTYNEXT50": 0.6,
}


def compute_event_returns(prices: pd.DataFrame, ticker: str, announce_date: pd.Timestamp,
                           effective_date: pd.Timestamp, action: str, windows: list):
    """Compute returns around announcement and effective dates."""
    if ticker not in prices.columns:
        return {}

    px = prices[ticker].dropna()
    results = {}

    for label, ref_date in [("announce", announce_date), ("effective", effective_date)]:
        for window in windows:
            pre_date = ref_date - pd.Timedelta(days=window)
            post_date = ref_date + pd.Timedelta(days=window)
            try:
                pre_px = px.asof(pre_date)
                ref_px = px.asof(ref_date)
                post_px = px.asof(post_date)
                if pre_px > 0 and ref_px > 0 and post_px > 0:
                    results[f"{label}_pre{window}d"] = float((ref_px / pre_px - 1) * 100)
                    results[f"{label}_post{window}d"] = float((post_px / ref_px - 1) * 100)
            except Exception:
                pass

    return results


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    changes = pd.read_csv(cfg.changes_file, parse_dates=["announce_date", "effective_date"])
    changes.columns = [c.lower().strip() for c in changes.columns]

    prices_df = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices_df.columns = [c.lower().strip() for c in prices_df.columns]
    wide = prices_df.pivot(index="date", columns="ticker", values="close").sort_index()

    event_records = []
    signal_records = []
    trade_pnls = []

    for _, event in changes.iterrows():
        ticker = str(event["ticker"]).upper()
        action = str(event["action"]).upper()  # ADD or REMOVE
        ann_date = event["announce_date"]
        eff_date = event["effective_date"]
        index_name = str(event.get("index_name", "NIFTY50")).upper()

        if ticker not in wide.columns:
            continue

        px_series = wide[ticker].dropna()
        if px_series.empty:
            continue

        # Entry: 2 days after announcement
        entry_date = ann_date + pd.Timedelta(days=ENTRY_DAYS_AFTER_ANNOUNCE)
        exit_date = eff_date - pd.Timedelta(days=EXIT_DAYS_BEFORE_EFFECTIVE)

        entry_px = px_series.asof(entry_date)
        exit_px = px_series.asof(exit_date)

        if entry_px <= 0 or exit_px <= 0:
            continue

        # Position direction
        # ADD: passive funds will buy → front-run long
        # REMOVE: passive funds will sell → front-run short
        direction = 1 if action == "ADD" else -1
        aum_scale = INDEX_AUM_WEIGHT.get(index_name, 0.2)

        raw_return = float((exit_px / entry_px - 1) * direction)
        scaled_return = raw_return * aum_scale

        trade_pnls.append(scaled_return)

        # Event analysis windows
        event_ret = compute_event_returns(wide, ticker, ann_date, eff_date, action, [1, 3, 5, 10])

        event_records.append({
            "ticker": ticker,
            "action": action,
            "index_name": index_name,
            "announce_date": ann_date.date(),
            "effective_date": eff_date.date(),
            "entry_date": entry_date.date() if hasattr(entry_date, "date") else entry_date,
            "exit_date": exit_date.date() if hasattr(exit_date, "date") else exit_date,
            "entry_price": float(entry_px),
            "exit_price": float(exit_px),
            "raw_return_pct": float(raw_return * 100),
            "aum_scaled_return_pct": float(scaled_return * 100),
            "direction": direction,
            **event_ret,
        })

        # Signal records
        hold_dates = pd.date_range(entry_date, exit_date, freq="B")
        for dt in hold_dates:
            if dt in wide.index:
                signal_records.append({
                    "date": dt.date(),
                    "ticker": ticker,
                    "action": action,
                    "signal": "long" if direction == 1 else "short",
                    "days_to_effective": (eff_date - dt).days,
                    "index_name": index_name,
                })

    if not event_records:
        print("No index change events processed.")
        return

    pd.DataFrame(event_records).sort_values("announce_date").to_csv(
        os.path.join(cfg.outdir, "rebalance_events.csv"), index=False
    )
    if signal_records:
        pd.DataFrame(signal_records).sort_values("date").to_csv(
            os.path.join(cfg.outdir, "signals.csv"), index=False
        )

    if trade_pnls:
        rets = pd.Series(trade_pnls)
        cum = (1 + rets).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(rets.mean() / rets.std() * np.sqrt(12)) if rets.std() > 0 else None  # ~monthly events
        win_rate = float((rets > 0).mean())
        add_events = [r for r in event_records if r["action"] == "ADD"]
        rem_events = [r for r in event_records if r["action"] == "REMOVE"]
    else:
        sharpe = win_rate = None
        add_events = rem_events = []

    summary = {
        "n_events": len(event_records),
        "n_additions": len(add_events),
        "n_removals": len(rem_events),
        "avg_raw_return_pct": float(np.mean([r["raw_return_pct"] for r in event_records])) if event_records else None,
        "win_rate": win_rate,
        "sharpe": sharpe,
        "params": {
            "entry_days_after_announce": ENTRY_DAYS_AFTER_ANNOUNCE,
            "exit_days_before_effective": EXIT_DAYS_BEFORE_EFFECTIVE,
        }
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"NIFTY Rebalance | {len(event_records)} events | Win rate: {win_rate:.1%} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--changes", required=True, dest="changes_file")
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--outdir", default="./artifacts/nifty_rebalance")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
