#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rbi_rate_decision_trades.py — Trade around RBI Monetary Policy Committee meetings
==================================================================================
RBI MPC meets every 6-8 weeks (typically February, April, June, August, October,
December). Rate decisions create predictable volatility in:
  - USDINR (INR strengthens on hikes, weakens on cuts/dovish)
  - NIFTY (cut = positive, hike = negative in short run)
  - BANKNIFTY (most sensitive to repo rate changes)
  - G-Sec yields (move inverse to rate direction)

This strategy pre-positions 3-5 days before MPC and captures the post-announcement
move. Uses historical pattern analysis to determine directionality vs consensus.

Inputs (CSV)
------------
--mpc       mpc.csv         date, decision (hike/cut/hold), change_bps, consensus_bps (optional)
--nifty     nifty.csv       date, nifty_close
--banknifty bn.csv          date, banknifty_close
--usdinr    usdinr.csv      date, usdinr_close
--gsec10    gsec10.csv      date, gsec10y_yield (optional)

Outputs
-------
outdir/mpc_events.csv           event details, pre/post returns
outdir/consensus_analysis.csv   surprise vs no-surprise outcome differences
outdir/pre_positioning.csv      optimal pre-MPC positioning window
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd

# Pre-positioning: enter N days before, exit N days after
PRE_ENTRY_DAYS = 3
POST_EXIT_DAYS = 2
SURPRISE_THRESHOLD_BPS = 10  # > 10 bps vs consensus = surprise

# Asset return windows to analyse
RETURN_WINDOWS = [1, 2, 3, 5, 10]


def compute_returns(series: pd.Series, ref_date: pd.Timestamp, windows: list) -> dict:
    out = {}
    for w in windows:
        pre = ref_date - pd.Timedelta(days=w * 2)  # trading days buffer
        post = ref_date + pd.Timedelta(days=w * 2)
        try:
            r_pre = float(series.asof(pre))
            r_ref = float(series.asof(ref_date))
            r_post = float(series.asof(post))
            if r_pre > 0 and r_ref > 0:
                out[f"pre{w}d_pct"] = (r_ref / r_pre - 1) * 100
            if r_ref > 0 and r_post > 0:
                out[f"post{w}d_pct"] = (r_post / r_ref - 1) * 100
        except Exception:
            pass
    return out


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    mpc = pd.read_csv(cfg.mpc_file, parse_dates=["date"])
    mpc.columns = [c.lower().strip() for c in mpc.columns]
    mpc = mpc.sort_values("date")

    nifty = pd.read_csv(cfg.nifty_file, parse_dates=["date"]).set_index("date").sort_index()
    nifty.columns = [c.lower().strip() for c in nifty.columns]
    nifty_col = nifty.columns[0]

    bn = pd.read_csv(cfg.bn_file, parse_dates=["date"]).set_index("date").sort_index()
    bn.columns = [c.lower().strip() for c in bn.columns]
    bn_col = bn.columns[0]

    usdinr = pd.read_csv(cfg.usdinr_file, parse_dates=["date"]).set_index("date").sort_index()
    usdinr.columns = [c.lower().strip() for c in usdinr.columns]
    usdinr_col = usdinr.columns[0]

    gsec10 = None
    if cfg.gsec10_file and os.path.exists(cfg.gsec10_file):
        gsec10 = pd.read_csv(cfg.gsec10_file, parse_dates=["date"]).set_index("date").sort_index()
        gsec10.columns = [c.lower().strip() for c in gsec10.columns]

    event_records = []
    trade_pnls = []
    pre_position_data = []

    for _, event in mpc.iterrows():
        mpc_date = event["date"]
        decision = str(event.get("decision", "hold")).lower()
        change_bps = float(event.get("change_bps", 0))
        consensus_bps = float(event.get("consensus_bps", 0)) if "consensus_bps" in event else 0

        surprise = abs(change_bps - consensus_bps)
        is_surprise = surprise > SURPRISE_THRESHOLD_BPS

        # Compute asset returns around MPC date
        nifty_ret = compute_returns(nifty[nifty_col], mpc_date, RETURN_WINDOWS)
        bn_ret = compute_returns(bn[bn_col], mpc_date, RETURN_WINDOWS)
        usdinr_ret = compute_returns(usdinr[usdinr_col], mpc_date, RETURN_WINDOWS)

        record = {
            "mpc_date": mpc_date.date(),
            "decision": decision,
            "change_bps": float(change_bps),
            "consensus_bps": float(consensus_bps),
            "surprise_bps": float(surprise),
            "is_surprise": is_surprise,
        }
        record.update({f"nifty_{k}": v for k, v in nifty_ret.items()})
        record.update({f"banknifty_{k}": v for k, v in bn_ret.items()})
        record.update({f"usdinr_{k}": v for k, v in usdinr_ret.items()})

        event_records.append(record)

        # Strategy: pre-position based on expected direction
        # Hike: short NIFTY (equity negative), long INR (usdinr falls)
        # Cut: long NIFTY, short INR (usdinr rises)
        # Hold: flat (direction ambiguous)
        entry_date = mpc_date - pd.Timedelta(days=PRE_ENTRY_DAYS)
        exit_date = mpc_date + pd.Timedelta(days=POST_EXIT_DAYS)

        if decision in ("hike",):
            nifty_direction = -1  # Short NIFTY
        elif decision in ("cut",):
            nifty_direction = 1   # Long NIFTY
        else:
            nifty_direction = 0   # Flat on hold

        # P&L: NIFTY leg
        nifty_entry = float(nifty[nifty_col].asof(entry_date)) if not nifty[nifty_col].empty else np.nan
        nifty_exit = float(nifty[nifty_col].asof(exit_date)) if not nifty[nifty_col].empty else np.nan

        if nifty_direction != 0 and nifty_entry > 0 and nifty_exit > 0:
            pnl = nifty_direction * (nifty_exit / nifty_entry - 1)
            trade_pnls.append(pnl)

        # Pre-positioning analysis
        for days_before in range(1, 8):
            pre_date = mpc_date - pd.Timedelta(days=days_before)
            pre_nifty = float(nifty[nifty_col].asof(pre_date)) if not nifty[nifty_col].empty else np.nan
            mpc_nifty = float(nifty[nifty_col].asof(mpc_date)) if not nifty[nifty_col].empty else np.nan
            if pre_nifty > 0 and mpc_nifty > 0:
                pre_position_data.append({
                    "days_before_mpc": days_before,
                    "decision": decision,
                    "nifty_return_pct": float((mpc_nifty / pre_nifty - 1) * 100),
                })

    if event_records:
        pd.DataFrame(event_records).to_csv(os.path.join(cfg.outdir, "mpc_events.csv"), index=False)

    # Consensus vs surprise analysis
    if event_records:
        ev_df = pd.DataFrame(event_records)
        by_surprise = ev_df.groupby("is_surprise")
        surprise_stats = []
        for is_surp, grp in by_surprise:
            stats_row = {"is_surprise": bool(is_surp), "n_events": len(grp)}
            for col in [c for c in grp.columns if "post5d_pct" in c]:
                stats_row[f"avg_{col}"] = float(grp[col].mean()) if col in grp else None
            surprise_stats.append(stats_row)
        pd.DataFrame(surprise_stats).to_csv(os.path.join(cfg.outdir, "consensus_analysis.csv"), index=False)

    # Pre-positioning analysis
    if pre_position_data:
        pre_df = pd.DataFrame(pre_position_data)
        pre_agg = pre_df.groupby(["days_before_mpc", "decision"])["nifty_return_pct"].agg(
            ["mean", "std", "count"]
        ).reset_index()
        pre_agg.to_csv(os.path.join(cfg.outdir, "pre_positioning.csv"), index=False)

    if trade_pnls:
        rets = pd.Series(trade_pnls)
        cum = (1 + rets).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(rets.mean() / rets.std() * np.sqrt(12)) if rets.std() > 0 else None  # ~monthly events
        win_rate = float((rets > 0).mean())
    else:
        sharpe = win_rate = None

    hike_events = [r for r in event_records if r["decision"] == "hike"]
    cut_events = [r for r in event_records if r["decision"] == "cut"]

    summary = {
        "n_mpc_events": len(event_records),
        "n_hikes": len(hike_events),
        "n_cuts": len(cut_events),
        "n_holds": len(event_records) - len(hike_events) - len(cut_events),
        "n_surprises": int(sum(r["is_surprise"] for r in event_records)),
        "win_rate": win_rate,
        "sharpe": sharpe,
        "params": {"pre_entry_days": PRE_ENTRY_DAYS, "post_exit_days": POST_EXIT_DAYS}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"RBI MPC Trades | {len(event_records)} events | Win rate: {win_rate:.1%} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mpc", required=True, dest="mpc_file")
    ap.add_argument("--nifty", required=True, dest="nifty_file")
    ap.add_argument("--bn", required=True, dest="bn_file")
    ap.add_argument("--usdinr", required=True, dest="usdinr_file")
    ap.add_argument("--gsec10", default=None, dest="gsec10_file")
    ap.add_argument("--outdir", default="./artifacts/rbi_mpc_trades")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
