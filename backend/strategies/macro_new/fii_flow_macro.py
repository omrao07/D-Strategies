#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fii_flow_macro.py — FII macro flows as NIFTY directional signal
================================================================
Extends the FII/DII daily signal (in alternative_data/) with a macro-level
analysis of structural FII flow patterns:
  - EM allocation cycles (USD strength → EM outflows)
  - India weight in MSCI EM (inclusion events → forced buying)
  - FPI sectoral allocations (financials vs tech vs manufacturing)
  - Global risk events → emergency outflow cascades

This strategy operates on weekly/monthly data to capture structural allocation
changes rather than daily noise.

Inputs (CSV)
------------
--fii_monthly  fii_monthly.csv    date, fii_equity_cr, fii_debt_cr, fii_net_cr
--msci         msci.csv           date, india_weight_pct, em_total_return (optional)
--dxy          dxy.csv            date, dxy_index (USD strength)
--nifty        nifty.csv          date, nifty_close

Outputs
-------
outdir/flow_regime.csv          date, fii_3m_cr, fii_12m_cr, regime, dxy_correlation
outdir/msci_events.csv          event_date, weight_change_pct, nifty_reaction
outdir/macro_signals.csv        date, signal, strength, rationale
outdir/backtest.csv             cumulative P&L
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd

FII_STRONG_INFLOW_THRESHOLD = 10000    # ₹10,000 crore/month = strong inflow
FII_STRONG_OUTFLOW_THRESHOLD = -10000  # ₹10,000 crore/month outflow
DXY_STRONG_LEVEL = 105.0               # USD > 105 = EM headwind
EM_WEIGHT_CHANGE_THRESHOLD = 0.5       # 0.5% weight change = significant rebalancing

ZSCORE_WINDOW = 12    # Months
MA_WINDOWS = [3, 6, 12]


def run(cfg):
    os.makedirs(cfg.outdir, exist_ok=True)

    fii = pd.read_csv(cfg.fii_monthly_file, parse_dates=["date"]).set_index("date").sort_index()
    fii.columns = [c.lower().strip() for c in fii.columns]
    net_col = "fii_net_cr" if "fii_net_cr" in fii.columns else fii.columns[0]

    nifty = pd.read_csv(cfg.nifty_file, parse_dates=["date"]).set_index("date").sort_index()
    nifty.columns = [c.lower().strip() for c in nifty.columns]
    nifty_col = nifty.columns[0]

    # DXY
    dxy = None
    if cfg.dxy_file and os.path.exists(cfg.dxy_file):
        dxy = pd.read_csv(cfg.dxy_file, parse_dates=["date"]).set_index("date").sort_index()
        dxy.columns = [c.lower().strip() for c in dxy.columns]
        dxy_col = dxy.columns[0]

    # MSCI events
    msci = None
    if cfg.msci_file and os.path.exists(cfg.msci_file):
        msci = pd.read_csv(cfg.msci_file, parse_dates=["date"]).set_index("date").sort_index()
        msci.columns = [c.lower().strip() for c in msci.columns]

    # Monthly FII flow analysis
    fii_monthly = fii[[net_col]].rename(columns={net_col: "fii_net"})
    for w in MA_WINDOWS:
        fii_monthly[f"fii_{w}m_ma"] = fii_monthly["fii_net"].rolling(w).sum()

    mu = fii_monthly["fii_net"].rolling(ZSCORE_WINDOW).mean()
    sigma = fii_monthly["fii_net"].rolling(ZSCORE_WINDOW).std().replace(0, np.nan)
    fii_monthly["fii_z"] = (fii_monthly["fii_net"] - mu) / sigma

    # Nifty monthly returns
    nifty_monthly = nifty[nifty_col].resample("MS").last().pct_change()

    # FII forward returns analysis
    nifty_fwd = nifty_monthly.shift(-1) * 100

    # DXY correlation
    dxy_corr = None
    if dxy is not None:
        dxy_monthly = dxy[dxy_col].resample("MS").last()
        aligned_dxy = pd.concat([fii_monthly["fii_net"], dxy_monthly], axis=1).dropna()
        if len(aligned_dxy) >= 12:
            dxy_corr = float(aligned_dxy.iloc[:, 0].corr(aligned_dxy.iloc[:, 1]))

    # Signal generation
    macro_signals = []
    for dt, row in fii_monthly.iterrows():
        fii_net = row["fii_net"]
        fii_3m = row.get("fii_3m_ma", np.nan)
        fii_12m = row.get("fii_12m_ma", np.nan)
        fii_z = row.get("fii_z", np.nan)

        # DXY filter
        dxy_headwind = False
        if dxy is not None and dt in dxy_monthly.index:
            dxy_headwind = float(dxy_monthly.loc[dt]) > DXY_STRONG_LEVEL

        # Signal logic
        if not np.isnan(fii_z) and fii_z > 1.5 and not dxy_headwind:
            signal = "long"
            strength = min(fii_z / 2.0, 1.5)
            rationale = f"Strong FII inflow z={fii_z:.1f}"
        elif not np.isnan(fii_z) and fii_z < -1.5:
            signal = "short"
            strength = -min(abs(fii_z) / 2.0, 1.5)
            rationale = f"Strong FII outflow z={fii_z:.1f}"
        elif dxy_headwind and fii_net < 0:
            signal = "short"
            strength = -0.5
            rationale = "DXY strong + FII selling"
        else:
            signal = "flat"
            strength = 0.0
            rationale = "No clear signal"

        # Regime classification
        if fii_3m > FII_STRONG_INFLOW_THRESHOLD and fii_12m > 0:
            regime = "structural_inflow"
        elif fii_3m < FII_STRONG_OUTFLOW_THRESHOLD and fii_12m < 0:
            regime = "structural_outflow"
        elif fii_3m > 0 and fii_12m < 0:
            regime = "tactical_inflow"
        elif fii_3m < 0 and fii_12m > 0:
            regime = "tactical_outflow"
        else:
            regime = "neutral"

        macro_signals.append({
            "date": dt.date(),
            "fii_monthly_cr": float(fii_net) if not np.isnan(fii_net) else None,
            "fii_3m_cr": float(fii_3m) if not np.isnan(fii_3m) else None,
            "fii_12m_cr": float(fii_12m) if not np.isnan(fii_12m) else None,
            "fii_z": float(fii_z) if not np.isnan(fii_z) else None,
            "regime": regime,
            "signal": signal,
            "strength": float(strength),
            "rationale": rationale,
        })

    pd.DataFrame(macro_signals).to_csv(os.path.join(cfg.outdir, "macro_signals.csv"), index=False)

    # Flow regime summary
    sig_df = pd.DataFrame(macro_signals)
    sig_df["date"] = pd.to_datetime(sig_df["date"])
    sig_df = sig_df.set_index("date")
    sig_df["nifty_fwd_1m"] = nifty_fwd.reindex(sig_df.index)

    regime_stats = sig_df.groupby("regime")["nifty_fwd_1m"].agg(["mean", "std", "count"]).reset_index()
    regime_stats.to_csv(os.path.join(cfg.outdir, "flow_regime.csv"), index=False)

    # MSCI weight events
    if msci is not None and "india_weight_pct" in msci.columns:
        msci_events = []
        weight_change = msci["india_weight_pct"].diff()
        large_changes = weight_change[abs(weight_change) > EM_WEIGHT_CHANGE_THRESHOLD]
        for dt, chg in large_changes.items():
            nifty_fwd_ret = float(nifty[nifty_col].asof(dt + pd.Timedelta(days=30)) /
                                   nifty[nifty_col].asof(dt) - 1) * 100 if not nifty.empty else np.nan
            msci_events.append({
                "event_date": dt.date(),
                "weight_change_pct": float(chg),
                "new_weight_pct": float(msci.loc[dt, "india_weight_pct"]),
                "nifty_30d_reaction_pct": float(nifty_fwd_ret) if not np.isnan(nifty_fwd_ret) else None,
            })
        if msci_events:
            pd.DataFrame(msci_events).to_csv(os.path.join(cfg.outdir, "msci_events.csv"), index=False)

    # Backtest
    pos = sig_df["strength"].shift(1).fillna(0)
    nifty_monthly_aligned = nifty_monthly.reindex(pos.index)
    strat_ret = (pos * nifty_monthly_aligned).dropna()
    cum = (1 + strat_ret).cumprod()
    cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(12)) if strat_ret.std() > 0 else None

    summary = {
        "avg_monthly_fii_cr": float(fii_monthly["fii_net"].mean()),
        "pct_inflow_months": float((fii_monthly["fii_net"] > 0).mean() * 100),
        "structural_inflow_months": int((sig_df["regime"] == "structural_inflow").sum()),
        "structural_outflow_months": int((sig_df["regime"] == "structural_outflow").sum()),
        "dxy_correlation": dxy_corr,
        "ann_return": float(strat_ret.mean() * 12) if len(strat_ret) > 0 else None,
        "sharpe": sharpe,
        "params": {"strong_inflow_cr": FII_STRONG_INFLOW_THRESHOLD, "dxy_level": DXY_STRONG_LEVEL}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"FII Macro Flows | Avg monthly: ₹{summary['avg_monthly_fii_cr']:.0f}cr | Sharpe: {sharpe:.2f if sharpe else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fii-monthly", required=True, dest="fii_monthly_file")
    ap.add_argument("--nifty", required=True, dest="nifty_file")
    ap.add_argument("--dxy", default=None, dest="dxy_file")
    ap.add_argument("--msci", default=None, dest="msci_file")
    ap.add_argument("--outdir", default="./artifacts/fii_macro_flows")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
