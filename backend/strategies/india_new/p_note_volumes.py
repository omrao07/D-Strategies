#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
p_note_volumes.py — Participatory Note (P-Note) flow as FPI sentiment indicator
================================================================================
P-Notes allow foreign investors without SEBI registration to invest in Indian
markets. Rising P-Note volumes → institutional foreign interest → bullish for
Nifty. SEBI periodically tightens P-Note regulations, causing flow reversals.

Inputs (CSV)
------------
--pnotes   p_note_data.csv
    Columns: date, pnote_value_crore, total_fpi_value_crore,
             equity_pct, derivatives_pct, debt_pct
--nifty    nifty_returns.csv
    Columns: date, nifty_return, nifty_close

Outputs
-------
outdir/pnote_signals.csv    date, pnote_share_pct, mom_pct, zscore, signal
outdir/pnote_vs_nifty.csv   P-Note flow vs Nifty forward return correlation
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


PNOTE_SHARE_HIGH = 12.0   # % share of FPI — high foreign interest
PNOTE_SHARE_LOW  = 6.0    # % share — low/declining interest
SEBI_CONCERN_THRESHOLD = 15.0  # SEBI typically intervenes above ~15%


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    pnotes = pd.read_csv(cfg.pnotes_file, parse_dates=["date"])
    pnotes.columns = [c.lower().strip() for c in pnotes.columns]
    pnotes = pnotes.set_index("date").sort_index()
    nifty = pd.read_csv(cfg.nifty_file, parse_dates=["date"])
    nifty.columns = [c.lower().strip() for c in nifty.columns]
    nifty = nifty.set_index("date").sort_index()

    pval_col = "pnote_value_crore" if "pnote_value_crore" in pnotes.columns else pnotes.columns[0]
    fpi_col = "total_fpi_value_crore" if "total_fpi_value_crore" in pnotes.columns else None
    ret_col = "nifty_return" if "nifty_return" in nifty.columns else nifty.columns[0]

    if fpi_col:
        pnotes["pnote_share_pct"] = pnotes[pval_col] / pnotes[fpi_col].replace(0, np.nan) * 100
    else:
        pnotes["pnote_share_pct"] = np.nan

    pnotes["pnote_mom_pct"] = pnotes[pval_col].pct_change(3) * 100  # quarterly momentum
    pnotes["pnote_yoy_pct"] = pnotes[pval_col].pct_change(12) * 100
    pnotes["pnote_zscore"] = (pnotes[pval_col] - pnotes[pval_col].rolling(24).mean()) / \
                              pnotes[pval_col].rolling(24).std().replace(0, np.nan)
    pnotes["pnote_trend"] = pnotes[pval_col].rolling(3).mean() - pnotes[pval_col].rolling(12).mean()

    signal_records = []
    for date, row in pnotes.iterrows():
        val = row.get(pval_col, np.nan)
        share = row.get("pnote_share_pct", np.nan)
        mom = row.get("pnote_mom_pct", np.nan)
        z = row.get("pnote_zscore", np.nan)
        trend = row.get("pnote_trend", np.nan)
        sebi_risk = not np.isnan(share) and share > SEBI_CONCERN_THRESHOLD

        if not np.isnan(z) and z > 1.5 and not np.isnan(trend) and trend > 0 and not sebi_risk:
            signal = "strong_buy"
        elif not np.isnan(z) and z > 0.5 and not sebi_risk:
            signal = "mild_buy"
        elif sebi_risk or (not np.isnan(z) and z > 2.5):
            signal = "regulatory_risk_neutral"  # too high → SEBI risk
        elif not np.isnan(z) and z < -1.5 and not np.isnan(trend) and trend < 0:
            signal = "sell"
        elif not np.isnan(z) and z < -0.5:
            signal = "mild_sell"
        else:
            signal = "neutral"

        signal_records.append({
            "date": date,
            "pnote_value_crore": float(val) if not np.isnan(val) else None,
            "pnote_share_pct": float(share) if not np.isnan(share) else None,
            "pnote_mom_pct": float(mom) if not np.isnan(mom) else None,
            "pnote_zscore": float(z) if not np.isnan(z) else None,
            "sebi_risk": bool(sebi_risk),
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "pnote_signals.csv"), index=False)

    # Correlation: P-Note flow vs Nifty forward returns
    nifty_ret = nifty[ret_col].dropna()
    pnote_z = pnotes["pnote_zscore"].dropna()
    corr_records = []
    for lag_months in [1, 3, 6]:
        fwd_ret = nifty_ret.rolling(lag_months * 21).sum().shift(-lag_months * 21)
        pnote_monthly = pnote_z.resample("ME").last().reindex(fwd_ret.index).ffill().dropna()
        aligned = pnote_monthly.align(fwd_ret.dropna(), join="inner")
        if len(aligned[0]) > 10:
            r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
            corr_records.append({"lag_months": lag_months, "pnote_nifty_corr": float(r), "pvalue": float(p), "n": len(aligned[0])})

    corr_df = pd.DataFrame(corr_records) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "pnote_vs_nifty.csv"), index=False)

    # Backtest
    SIG_POS = {"strong_buy": 1.5, "mild_buy": 0.5, "neutral": 0,
               "regulatory_risk_neutral": 0, "mild_sell": -0.5, "sell": -1}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    pos_daily = pos.reindex(nifty_ret.index).ffill().shift(1).fillna(0)
    port = (pos_daily * nifty_ret).dropna()
    cum = (1 + port).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
    sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None

    latest = sig_df.iloc[-1] if not sig_df.empty else {}
    summary = {
        "latest_pnote_value_crore": float(latest.get("pnote_value_crore", np.nan)) if latest.get("pnote_value_crore") else None,
        "latest_share_pct": float(latest.get("pnote_share_pct", np.nan)) if latest.get("pnote_share_pct") else None,
        "latest_signal": str(latest.get("signal", "N/A")),
        "n_sebi_risk_days": int(sig_df["sebi_risk"].sum()) if "sebi_risk" in sig_df else 0,
        "best_lag_corr": corr_df.loc[corr_df["pnote_nifty_corr"].abs().idxmax()].to_dict() if not corr_df.empty else None,
        "ann_return": float(port.mean() * 252), "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"P-Notes | Latest share: {summary['latest_share_pct']:.1f}% | Signal: {summary['latest_signal']} | Sharpe: {f'{sharpe:.2f}' if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pnotes", required=True, dest="pnotes_file")
    ap.add_argument("--nifty", required=True, dest="nifty_file")
    ap.add_argument("--outdir", default="./artifacts/p_notes")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
