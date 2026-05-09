# backend/live_engine/jobs/weekly_pipeline.py
"""
Weekly pipeline — runs Sunday 8:00 AM IST.

Steps:
  1. Walk-forward re-validation for all active strategies (last 52 weeks)
  2. Recompute correlation matrix across strategy equity curves
  3. Alpha decay check per strategy (rolling 63-day IR)
  4. Flag strategies with Sharpe < 0.5 in last 3 months
  5. Update strategy cluster assignments (PCA)
  6. Generate weekly HTML performance report
  7. Send Telegram weekly summary
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, List

import numpy as np

log = logging.getLogger(__name__)

_REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
_REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
_REPORTS_DIR = os.getenv("REPORTS_DIR", "reports")


def _redis():
    try:
        import redis
        return redis.Redis(host=_REDIS_HOST, port=int(_REDIS_PORT), decode_responses=True)
    except Exception:
        return None


def run() -> Dict[str, Any]:
    """Weekly pipeline — Sunday 8 AM IST."""
    t0 = time.perf_counter()
    log.info("=== WEEKLY PIPELINE START ===")

    results: Dict[str, Any] = {
        "wf_validated": 0,
        "wf_failed": 0,
        "low_sharpe_flags": [],
        "alpha_decay_flags": [],
        "n_clusters": 0,
        "correlation_computed": False,
    }

    r = _redis()

    # ── 1. Walk-forward re-validation ────────────────────────────────────────
    try:
        from backend.backtester.anti_overfit_engine import AntiOverfitEngine, walk_forward_split
        import pandas as pd

        strategy_names = r.hkeys("strategy:rankings") if r else []
        for name in strategy_names:
            try:
                raw = r.lrange(f"strategy:returns:{name}", -252, -1) if r else []
                if len(raw) < 100:
                    continue
                rets = pd.Series([float(x) for x in raw])
                # IS = first 75%, OOS = last 25%
                split = int(len(rets) * 0.75)
                is_rets = rets.iloc[:split]
                oos_rets = rets.iloc[split:]

                is_sharpe = _sharpe(is_rets.values)
                oos_sharpe = _sharpe(oos_rets.values)

                # OOS Sharpe >= 0.5 and not more than 80% below IS
                if oos_sharpe >= 0.5 and (is_sharpe <= 0 or oos_sharpe / is_sharpe >= 0.20):
                    results["wf_validated"] += 1
                    if r:
                        r.hset("strategy:wf_status", name, "pass")
                else:
                    results["wf_failed"] += 1
                    if r:
                        r.hset("strategy:wf_status", name, "fail")
                    log.info("WF FAIL: %s IS_Sharpe=%.2f OOS_Sharpe=%.2f", name, is_sharpe, oos_sharpe)
            except Exception as exc:
                log.debug("WF check failed for %s: %s", name, exc)

        log.info("Walk-forward: %d pass, %d fail", results["wf_validated"], results["wf_failed"])
    except Exception as exc:
        log.error("Walk-forward validation error: %s", exc)

    # ── 2. Correlation matrix ────────────────────────────────────────────────
    try:
        strategy_names = r.hkeys("strategy:rankings") if r else []
        returns_matrix = {}
        for name in strategy_names:
            raw = r.lrange(f"strategy:returns:{name}", -63, -1) if r else []
            if len(raw) >= 30:
                returns_matrix[name] = [float(x) for x in raw]

        if len(returns_matrix) >= 2:
            import pandas as pd
            df = pd.DataFrame(returns_matrix)
            df = df.dropna(how="all")
            corr = df.corr().round(4)

            # Store correlation matrix in Redis
            if r:
                r.set("strategy:correlation_matrix", corr.to_json())
            results["correlation_computed"] = True
            log.info("Correlation matrix computed: %dx%d", len(corr), len(corr))
    except Exception as exc:
        log.error("Correlation matrix error: %s", exc)

    # ── 3. Low Sharpe flags (last 63 days) ───────────────────────────────────
    try:
        strategy_names = r.hkeys("strategy:rankings") if r else []
        for name in strategy_names:
            raw = r.lrange(f"strategy:returns:{name}", -63, -1) if r else []
            if len(raw) < 30:
                continue
            rets = np.array([float(x) for x in raw])
            sharpe = _sharpe(rets)
            if sharpe < 0.5:
                results["low_sharpe_flags"].append({"name": name, "sharpe": round(sharpe, 3)})
                if r:
                    r.hset("strategy:low_sharpe", name, str(round(sharpe, 4)))
            else:
                if r:
                    r.hdel("strategy:low_sharpe", name)

        log.info("Low Sharpe flags: %d strategies", len(results["low_sharpe_flags"]))
    except Exception as exc:
        log.error("Low Sharpe check error: %s", exc)

    # ── 4. Alpha decay flags (63-day IR < 0.3) ───────────────────────────────
    try:
        strategy_names = r.hkeys("strategy:rankings") if r else []
        for name in strategy_names:
            raw = r.lrange(f"strategy:returns:{name}", -63, -1) if r else []
            if len(raw) < 30:
                continue
            rets = np.array([float(x) for x in raw])
            mu = rets.mean() * 252
            sigma = rets.std() * np.sqrt(252)
            ir = abs(mu / sigma) if sigma > 0 else 0.0
            if ir < 0.3:
                results["alpha_decay_flags"].append({"name": name, "ir": round(ir, 3)})

        log.info("Alpha decay flags: %d strategies", len(results["alpha_decay_flags"]))
    except Exception as exc:
        log.error("Alpha decay check error: %s", exc)

    # ── 5. Strategy clustering (PCA) ─────────────────────────────────────────
    try:
        from backend.backtester.factor_model import StrategyClusterer
        import pandas as pd

        strategy_names = r.hkeys("strategy:rankings") if r else []
        equity_curves = {}
        for name in strategy_names:
            raw = r.lrange(f"strategy:returns:{name}", -252, -1) if r else []
            if len(raw) >= 60:
                rets = np.array([float(x) for x in raw])
                equity_curves[name] = np.cumprod(1 + rets)

        if len(equity_curves) >= 3:
            n = min(len(v) for v in equity_curves.values())
            matrix = np.column_stack([v[-n:] for v in equity_curves.values()])
            result = StrategyClusterer().cluster(matrix, list(equity_curves.keys()))
            results["n_clusters"] = result.n_clusters
            if r:
                r.set("strategy:clusters", json.dumps(result.assignments))
            log.info("Strategy clustering: %d clusters, %d effective bets",
                     result.n_clusters, result.n_unique_bets)
    except Exception as exc:
        log.debug("Strategy clustering error: %s", exc)

    # ── 6. Generate weekly HTML report ────────────────────────────────────────
    try:
        _generate_weekly_report(results, r)
    except Exception as exc:
        log.error("Weekly report generation error: %s", exc)

    elapsed = time.perf_counter() - t0
    log.info("=== WEEKLY PIPELINE DONE in %.1fs ===", elapsed)

    # ── 7. Telegram ───────────────────────────────────────────────────────────
    try:
        from backend.live_engine.telegram_alerts import TelegramAlerter
        import datetime
        # Fetch rolling portfolio metrics
        raw_rets = r.lrange("portfolio:daily_returns", -252, -1) if r else []
        if len(raw_rets) >= 30:
            rets = np.array([float(x) for x in raw_rets])
            port_sharpe = _sharpe(rets)
            port_cagr = (np.prod(1 + rets) ** (252 / len(rets)) - 1) * 100
            port_dd = _max_dd(np.cumprod(1 + rets))
        else:
            port_sharpe = port_cagr = port_dd = 0.0

        msg = (
            f"📊 Weekly Report — {datetime.date.today().strftime('%d %b %Y')}\n"
            f"Portfolio Sharpe (52W): {port_sharpe:.2f}\n"
            f"CAGR: {port_cagr:.1f}%  Max DD: {port_dd*100:.1f}%\n"
            f"Active strategies: {results['wf_validated']} pass / {results['wf_failed']} fail\n"
            f"⚠️ Low Sharpe: {len(results['low_sharpe_flags'])} | Alpha decay: {len(results['alpha_decay_flags'])}\n"
            f"Clusters: {results['n_clusters']}"
        )
        TelegramAlerter().send_sync(msg)
    except Exception as exc:
        log.error("Telegram weekly error: %s", exc)

    return results


# ── Helpers ───────────────────────────────────────────────────────────────────

def _sharpe(rets: np.ndarray, rf: float = 0.065) -> float:
    if len(rets) < 5:
        return 0.0
    mu = rets.mean() * 252 - rf
    sigma = rets.std() * np.sqrt(252)
    return mu / sigma if sigma > 0 else 0.0


def _max_dd(equity: np.ndarray) -> float:
    peak = np.maximum.accumulate(equity)
    dd = (peak - equity) / peak
    return float(dd.max()) if len(dd) > 0 else 0.0


def _generate_weekly_report(results: dict, r) -> None:
    import os, datetime
    os.makedirs(_REPORTS_DIR, exist_ok=True)
    date_str = datetime.date.today().isoformat()
    path = os.path.join(_REPORTS_DIR, f"weekly_{date_str}.html")

    raw_rets = r.lrange("portfolio:daily_returns", -252, -1) if r else []
    equity_html = ""
    if len(raw_rets) >= 10:
        rets = np.array([float(x) for x in raw_rets])
        equity = np.cumprod(1 + rets)
        equity_vals = ",".join(f"{v:.4f}" for v in equity)
        equity_html = f"""
        <script>
        var eq = [{equity_vals}];
        var x = Array.from({{length: eq.length}}, (_, i) => i);
        Plotly.newPlot('equity', [{{x, y: eq, type:'scatter', line:{{color:'#6366f1'}}}}],
          {{paper_bgcolor:'#020617',plot_bgcolor:'#020617',font:{{color:'#e2e8f0'}}}});
        </script>"""

    flags_html = ""
    for f in results.get("low_sharpe_flags", [])[:10]:
        flags_html += f"<tr><td>{f['name']}</td><td style='color:#ef4444'>{f['sharpe']:.3f}</td></tr>"
    decay_html = ""
    for f in results.get("alpha_decay_flags", [])[:10]:
        decay_html += f"<tr><td>{f['name']}</td><td style='color:#f59e0b'>{f['ir']:.3f}</td></tr>"

    html = f"""<!DOCTYPE html>
<html><head><meta charset='utf-8'>
<title>Weekly Report — {date_str}</title>
<script src='https://cdn.plot.ly/plotly-2.26.0.min.js'></script>
<style>
body{{background:#020617;color:#e2e8f0;font-family:monospace;padding:24px}}
h1{{color:#6366f1}}h2{{color:#94a3b8;border-bottom:1px solid #1e293b;padding-bottom:8px}}
table{{border-collapse:collapse;width:100%}}
th{{background:#1e293b;padding:8px;text-align:left}}
td{{padding:6px 8px;border-bottom:1px solid #1e293b}}
.metric{{display:inline-block;background:#0f172a;border:1px solid #1e293b;
         border-radius:8px;padding:16px 24px;margin:8px;min-width:140px}}
.metric-val{{font-size:24px;font-weight:bold;color:#6366f1}}
.metric-lbl{{font-size:12px;color:#64748b}}
</style></head><body>
<h1>📊 Weekly Performance Report — {date_str}</h1>
<div>
<div class='metric'><div class='metric-val'>{results['wf_validated']}</div><div class='metric-lbl'>WF Validated</div></div>
<div class='metric'><div class='metric-val' style='color:#ef4444'>{results['wf_failed']}</div><div class='metric-lbl'>WF Failed</div></div>
<div class='metric'><div class='metric-val' style='color:#f59e0b'>{len(results.get('low_sharpe_flags',[]))}</div><div class='metric-lbl'>Low Sharpe</div></div>
<div class='metric'><div class='metric-val'>{results['n_clusters']}</div><div class='metric-lbl'>Clusters</div></div>
</div>
<h2>Portfolio Equity (252 days)</h2>
<div id='equity' style='height:300px'></div>
<h2>Low Sharpe Strategies</h2>
<table><tr><th>Strategy</th><th>63D Sharpe</th></tr>{flags_html}</table>
<h2>Alpha Decay Flags</h2>
<table><tr><th>Strategy</th><th>63D IR</th></tr>{decay_html}</table>
{equity_html}
</body></html>"""

    with open(path, "w") as f:
        f.write(html)
    log.info("Weekly report written: %s", path)
