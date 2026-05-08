#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
india_digital_payment_growth.py — UPI/digital payment volumes as economic activity proxy
==========================================================================================
India's UPI transaction volumes (NPCI data) track real economic activity with a
1-2 month lead. Acceleration in UPI volume → consumption recovery → bullish for
payment processors (PayTM, PhonePe), banks, and FMCG. NACH mandates track loan
disbursals → lead indicator for NBFC/MFI performance.

Inputs (CSV)
------------
--upi      upi_data.csv
    Columns: date, upi_volume_mn, upi_value_crore, nach_volume_mn, nach_value_crore
--returns  sector_returns.csv
    Columns: date, ticker, return

Outputs
-------
outdir/upi_signals.csv      date, upi_volume_mn, yoy_pct, acceleration, signal
outdir/upi_vs_sector.csv    UPI growth vs sector forward return correlation
outdir/backtest.csv         cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
from scipy import stats


UPI_ACCELERATING_THRESHOLD = 5.0   # % acceleration (current_mom - prev_mom) in pp
UPI_GROWTH_HIGH = 30.0              # YoY growth rate considered strong
UPI_GROWTH_LOW = 10.0               # YoY growth rate considered weak

DIGITAL_BENEFICIARIES = ["paytm", "one97", "razorpay", "hdfc", "kotak", "axis", "sbi"]


def compute_acceleration(series: pd.Series) -> pd.Series:
    mom = series.pct_change(1) * 100
    return mom - mom.shift(1)


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)
    upi = pd.read_csv(cfg.upi_file, parse_dates=["date"])
    upi.columns = [c.lower().strip() for c in upi.columns]
    upi = upi.set_index("date").sort_index()
    returns = pd.read_csv(cfg.returns_file, parse_dates=["date"])
    returns.columns = [c.lower().strip() for c in returns.columns]
    ret_wide = returns.pivot(index="date", columns="ticker", values="return").sort_index()

    vol_col = "upi_volume_mn" if "upi_volume_mn" in upi.columns else upi.columns[0]
    val_col = "upi_value_crore" if "upi_value_crore" in upi.columns else None

    upi["upi_yoy_pct"] = upi[vol_col].pct_change(12) * 100   # monthly data → 12M YoY
    upi["upi_mom_pct"] = upi[vol_col].pct_change(1) * 100
    upi["upi_acceleration"] = compute_acceleration(upi[vol_col])
    upi["upi_zscore"] = (upi[vol_col] - upi[vol_col].rolling(12).mean()) / \
                         upi[vol_col].rolling(12).std().replace(0, np.nan)

    if val_col:
        upi["avg_ticket_crore"] = upi[val_col] / upi[vol_col].replace(0, np.nan)
        upi["ticket_yoy"] = upi["avg_ticket_crore"].pct_change(12) * 100

    nach_col = "nach_volume_mn" if "nach_volume_mn" in upi.columns else None
    if nach_col:
        upi["nach_yoy_pct"] = upi[nach_col].pct_change(12) * 100

    signal_records = []
    for date, row in upi.iterrows():
        yoy = row.get("upi_yoy_pct", np.nan)
        accel = row.get("upi_acceleration", np.nan)
        z = row.get("upi_zscore", np.nan)

        if not np.isnan(yoy) and not np.isnan(accel):
            if yoy > UPI_GROWTH_HIGH and accel > UPI_ACCELERATING_THRESHOLD:
                signal = "strong_buy_digital_ecosystem"
            elif yoy > UPI_GROWTH_HIGH:
                signal = "buy_digital_ecosystem"
            elif yoy > UPI_GROWTH_LOW and accel > 0:
                signal = "mild_buy"
            elif yoy < UPI_GROWTH_LOW or accel < -UPI_ACCELERATING_THRESHOLD:
                signal = "mild_sell"
            else:
                signal = "neutral"
        elif not np.isnan(z):
            signal = "buy_digital_ecosystem" if z > 1 else ("mild_sell" if z < -1 else "neutral")
        else:
            signal = "neutral"

        signal_records.append({
            "date": date,
            "upi_volume_mn": float(row[vol_col]) if not np.isnan(row[vol_col]) else None,
            "upi_yoy_pct": float(yoy) if not np.isnan(yoy) else None,
            "upi_acceleration_pp": float(accel) if not np.isnan(accel) else None,
            "upi_zscore": float(z) if not np.isnan(z) else None,
            "nach_yoy_pct": float(row.get("nach_yoy_pct", np.nan)) if nach_col and not np.isnan(row.get("nach_yoy_pct", np.nan)) else None,
            "signal": signal
        })

    sig_df = pd.DataFrame(signal_records).sort_values("date")
    sig_df.to_csv(os.path.join(cfg.outdir, "upi_signals.csv"), index=False)

    # Correlation: UPI growth vs sector forward return
    upi_yoy = upi["upi_yoy_pct"].dropna()
    corr_records = []
    for ticker in ret_wide.columns:
        ret_s = ret_wide[ticker].dropna()
        for lag_months in [1, 2, 3, 6]:
            fwd_ret = ret_s.rolling(lag_months * 21).sum().shift(-lag_months * 21)
            upi_monthly = upi_yoy.reindex(ret_s.index, method="ffill").dropna()
            aligned = upi_monthly.align(fwd_ret.dropna(), join="inner")
            if len(aligned[0]) > 15:
                r, p = stats.pearsonr(aligned[0].values, aligned[1].values)
                corr_records.append({
                    "ticker": ticker, "lag_months": lag_months,
                    "upi_corr": float(r), "pvalue": float(p), "n": len(aligned[0])
                })

    corr_df = pd.DataFrame(corr_records) if corr_records else pd.DataFrame()
    if not corr_df.empty:
        corr_df.to_csv(os.path.join(cfg.outdir, "upi_vs_sector.csv"), index=False)

    # Backtest
    SIG_POS = {"strong_buy_digital_ecosystem": 1.5, "buy_digital_ecosystem": 1,
               "mild_buy": 0.5, "neutral": 0, "mild_sell": -0.5}
    pos = sig_df.set_index("date")["signal"].map(SIG_POS).fillna(0)
    all_daily = []
    for ticker in ret_wide.columns:
        if any(d in ticker.lower() for d in DIGITAL_BENEFICIARIES):
            pos_daily = pos.reindex(ret_wide.index, method="ffill").shift(1).fillna(0)
            all_daily.append((pos_daily * ret_wide[ticker]).rename(ticker))

    if all_daily:
        port = pd.concat(all_daily, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    latest = sig_df.iloc[-1] if not sig_df.empty else {}
    best_corr = corr_df.loc[corr_df["upi_corr"].abs().idxmax()].to_dict() if not corr_df.empty else None
    summary = {
        "latest_upi_volume_mn": float(latest.get("upi_volume_mn", np.nan)) if latest.get("upi_volume_mn") else None,
        "latest_upi_yoy_pct": float(latest.get("upi_yoy_pct", np.nan)) if latest.get("upi_yoy_pct") else None,
        "latest_signal": str(latest.get("signal", "N/A")),
        "best_lead_lag": best_corr,
        "ann_return": ann_ret, "sharpe": sharpe
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"UPI/Digital | Volume: {summary['latest_upi_volume_mn']:.0f}mn | YoY: {summary['latest_upi_yoy_pct']:.1f}% | Signal: {summary['latest_signal']} | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--upi", required=True, dest="upi_file")
    ap.add_argument("--returns", required=True, dest="returns_file")
    ap.add_argument("--outdir", default="./artifacts/india_digital")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
