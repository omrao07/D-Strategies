# backend/live_engine/jobs/monthly_pipeline.py
"""
Monthly pipeline — runs on the 1st Sunday of each month, 9:00 AM IST.

Steps:
  1. Full portfolio rebalance via HRP (Hierarchical Risk Parity)
  2. Run complete backtest for all strategies (parallel)
  3. Tax optimization — LTCG/STCG lot identification (India rules)
  4. Position limit review — flag overweight strategies
  5. Generate monthly institutional HTML report
  6. Telegram monthly summary
"""
from __future__ import annotations

import datetime
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List

import numpy as np

log = logging.getLogger(__name__)

_REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
_REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
_REPORTS_DIR = Path(os.getenv("REPORTS_DIR", "reports"))
_CAPITAL_BASE = float(os.getenv("CAPITAL_BASE", "10000000"))


def _redis():
    try:
        import redis
        return redis.Redis(host=_REDIS_HOST, port=int(_REDIS_PORT), password=__import__("os").getenv("REDIS_PASSWORD") or None, decode_responses=True)
    except Exception:
        return None


def run() -> Dict[str, Any]:
    """Full monthly pipeline — 1st Sunday of each month."""
    t0 = time.perf_counter()
    today = datetime.date.today().isoformat()
    log.info("=== MONTHLY PIPELINE START [%s] ===", today)

    results: Dict[str, Any] = {
        "date": today,
        "strategies_backtested": 0,
        "rebalance_trades": 0,
        "tax_lots_identified": 0,
        "overweight_flags": [],
        "top_strategies": [],
        "report_path": "",
    }

    r = _redis()

    # ── 1. Full parallel backtest ─────────────────────────────────────────────
    try:
        log.info("Starting full parallel backtest for all strategies...")
        from backend.backtester.parallel_runner import ParallelRunner

        end_date = today
        start_date = (datetime.date.today() - datetime.timedelta(days=5 * 365)).isoformat()

        runner = ParallelRunner(
            capital=_CAPITAL_BASE,
            n_workers=8,
            mode="vectorized",
            fee_bps=5.0,
            slippage_bps=5.0,
            run_walk_forward=True,
            run_monte_carlo=False,
            verbose=True,
        )

        backtest_results = runner.run_all_strategies(start=start_date, end=end_date)
        results["strategies_backtested"] = len([res for res in backtest_results if not res.failed])

        # Persist rankings
        if r and backtest_results:
            valid = [res for res in backtest_results if not res.failed]
            valid.sort(key=lambda x: x.sharpe, reverse=True)
            results["top_strategies"] = [
                {"name": res.name, "sharpe": res.sharpe, "cagr": round(res.cagr, 4)}
                for res in valid[:20]
            ]
            for rank, res in enumerate(valid, 1):
                r.hset("strategy:monthly_rankings", res.name, json.dumps({
                    "rank": rank, "sharpe": round(res.sharpe, 4),
                    "cagr": round(res.cagr, 4), "max_dd": round(res.max_drawdown, 4),
                    "anti_overfit_passed": res.anti_overfit_passed,
                }))

        log.info("Full backtest done: %d strategies", results["strategies_backtested"])
    except Exception as exc:
        log.error("Full backtest failed: %s", exc)

    # ── 2. HRP Portfolio rebalance ────────────────────────────────────────────
    try:
        results["rebalance_trades"] = _run_hrp_rebalance(r)
    except Exception as exc:
        log.error("HRP rebalance error: %s", exc)

    # ── 3. Tax optimization ───────────────────────────────────────────────────
    try:
        results["tax_lots_identified"] = _run_tax_optimization(r)
    except Exception as exc:
        log.error("Tax optimization error: %s", exc)

    # ── 4. Position limit review ─────────────────────────────────────────────
    try:
        results["overweight_flags"] = _check_position_limits(r)
    except Exception as exc:
        log.error("Position limit check error: %s", exc)

    # ── 5. Monthly report ─────────────────────────────────────────────────────
    try:
        report_path = _generate_monthly_report(results, r, today)
        results["report_path"] = str(report_path)
    except Exception as exc:
        log.error("Monthly report generation error: %s", exc)

    elapsed = time.perf_counter() - t0
    log.info("=== MONTHLY PIPELINE DONE in %.1fs ===", elapsed)

    # ── 6. Telegram monthly summary ───────────────────────────────────────────
    try:
        from backend.live_engine.telegram_alerts import TelegramAlerter
        top_str = "\n".join(
            f"  {i+1}. {s['name']} Sharpe={s['sharpe']:.2f}"
            for i, s in enumerate(results["top_strategies"][:5])
        )
        msg = (
            f"📅 Monthly Rebalance Complete — {today}\n"
            f"⏱️ Runtime: {elapsed:.0f}s\n"
            f"📊 Strategies backtested: {results['strategies_backtested']}\n"
            f"🔄 Rebalance trades: {results['rebalance_trades']}\n"
            f"💰 Tax lots identified: {results['tax_lots_identified']}\n"
            f"⚠️ Overweight: {len(results['overweight_flags'])}\n\n"
            f"🏆 Top 5 strategies:\n{top_str}"
        )
        TelegramAlerter().send_sync(msg)
    except Exception as exc:
        log.error("Telegram monthly error: %s", exc)

    return results


# ── HRP Rebalance ─────────────────────────────────────────────────────────────

def _run_hrp_rebalance(r) -> int:
    """Compute HRP weights and generate rebalance order list."""
    try:
        from backend.live_engine.pnl_tracker import PnLTracker
        from backend.risk.institutional_risk_engine import PositionSizer

        strategy_names = r.hkeys("strategy:monthly_rankings") if r else []
        if not strategy_names:
            log.info("No strategy rankings yet — skipping HRP rebalance")
            return 0

        # Build covariance matrix from strategy returns
        returns_dict = {}
        for name in strategy_names[:50]:  # cap at 50 for matrix size
            raw = r.lrange(f"strategy:returns:{name}", -252, -1) if r else []
            if len(raw) >= 60:
                returns_dict[name] = np.array([float(x) for x in raw])

        if len(returns_dict) < 2:
            return 0

        import pandas as pd
        n = min(len(v) for v in returns_dict.values())
        df = pd.DataFrame({k: v[-n:] for k, v in returns_dict.items()})
        cov = df.cov().values

        sizer = PositionSizer()
        weights = sizer.hrp_weights(cov)
        names = list(returns_dict.keys())

        tracker = PnLTracker()
        nav = tracker.get_total_equity()

        # Compute target notionals and persist
        rebalance_count = 0
        if r:
            pipe = r.pipeline()
            for i, name in enumerate(names):
                target_notional = float(weights[i]) * nav
                pipe.hset("allocator:hrp_weights", name, json.dumps({
                    "weight": round(float(weights[i]), 4),
                    "target_usd": round(target_notional, 2),
                }))
                rebalance_count += 1
            pipe.execute()

        log.info("HRP rebalance computed: %d strategies, total weight=%.4f",
                 rebalance_count, float(weights.sum()))
        return rebalance_count
    except Exception as exc:
        log.error("HRP rebalance computation failed: %s", exc)
        return 0


# ── Tax optimization ──────────────────────────────────────────────────────────

def _run_tax_optimization(r) -> int:
    """
    Identify tax lots for LTCG/STCG optimization.
    India rules:
      - LTCG (> 1 year holding): 10% tax on gains > ₹1 lakh
      - STCG (< 1 year): 15% tax
    Strategy: prefer selling LTCG lots over STCG to minimize tax.
    """
    lots_identified = 0
    try:
        if not r:
            return 0

        today = datetime.date.today()
        positions = r.hgetall("portfolio:positions") or {}
        tax_report = []

        for sym, pos_json in positions.items():
            try:
                pos = json.loads(pos_json)
                qty = float(pos.get("qty", 0))
                avg_price = float(pos.get("avg_price", 0))
                if qty <= 0 or avg_price <= 0:
                    continue

                # Check if there are trade history entries with dates
                trade_raw = r.zrevrangebyscore("portfolio:trades", "+inf", "-inf", start=0, num=100)
                for trade_str in trade_raw:
                    try:
                        trade = json.loads(trade_str)
                        if trade.get("symbol") != sym or trade.get("side") != "buy":
                            continue
                        ts_ms = trade.get("ts_ms", 0)
                        trade_date = datetime.date.fromtimestamp(ts_ms / 1000)
                        holding_days = (today - trade_date).days
                        trade_qty = float(trade.get("qty", 0))
                        trade_price = float(trade.get("fill_price", avg_price))

                        # Estimate current price from Redis
                        cur_price_str = r.hget("market:quotes", sym)
                        cur_price = float(cur_price_str) if cur_price_str else avg_price

                        gain = (cur_price - trade_price) * trade_qty
                        tax_type = "LTCG" if holding_days >= 365 else "STCG"
                        tax_rate = 0.10 if tax_type == "LTCG" else 0.15

                        tax_report.append({
                            "symbol": sym,
                            "qty": trade_qty,
                            "buy_price": trade_price,
                            "cur_price": cur_price,
                            "holding_days": holding_days,
                            "gain": round(gain, 2),
                            "tax_type": tax_type,
                            "estimated_tax": round(max(0, gain) * tax_rate, 2),
                        })
                        lots_identified += 1
                    except Exception:
                        pass
            except Exception:
                pass

        if tax_report and r:
            r.set("portfolio:tax_lots", json.dumps(tax_report[:500]))
            log.info("Tax optimization: identified %d lots", lots_identified)

    except Exception as exc:
        log.error("Tax optimization error: %s", exc)
    return lots_identified


# ── Position limit review ─────────────────────────────────────────────────────

def _check_position_limits(r, max_pct: float = 0.05) -> List[dict]:
    """Flag any strategy exceeding max_pct of portfolio NAV."""
    flags = []
    try:
        if not r:
            return flags
        from backend.live_engine.pnl_tracker import PnLTracker
        tracker = PnLTracker()
        nav = tracker.get_total_equity()
        if nav <= 0:
            return flags

        notionals = r.hgetall("allocator:notional") or {}
        for name, val_str in notionals.items():
            try:
                notional = float(json.loads(val_str).get("usd", 0))
                pct = notional / nav
                if pct > max_pct:
                    flags.append({"strategy": name, "pct": round(pct, 4), "notional": round(notional, 2)})
                    log.warning("OVERWEIGHT: %s at %.1f%% (limit %.1f%%)", name, pct * 100, max_pct * 100)
            except Exception:
                pass
    except Exception as exc:
        log.error("Position limit check error: %s", exc)
    return flags


# ── Monthly HTML report ────────────────────────────────────────────────────────

def _generate_monthly_report(results: dict, r, date_str: str) -> Path:
    _REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    path = _REPORTS_DIR / f"monthly_{date_str}.html"

    # Portfolio equity
    raw_rets = r.lrange("portfolio:daily_returns", -504, -1) if r else []
    equity_html = ""
    if len(raw_rets) >= 10:
        rets = np.array([float(x) for x in raw_rets])
        equity = np.cumprod(1 + rets) * _CAPITAL_BASE
        eq_vals = ",".join(f"{v:.0f}" for v in equity)
        equity_html = f"""
        <script>
        Plotly.newPlot('equity',
          [{{y:[{eq_vals}],type:'scatter',fill:'tozeroy',line:{{color:'#6366f1'}},fillcolor:'rgba(99,102,241,0.15)'}}],
          {{paper_bgcolor:'#020617',plot_bgcolor:'#020617',font:{{color:'#e2e8f0'}},
           yaxis:{{tickprefix:'₹',tickformat:',.0f'}}}});
        </script>"""

    top_rows = ""
    for s in results.get("top_strategies", []):
        top_rows += f"<tr><td>{s['name']}</td><td>{s['sharpe']:.3f}</td><td>{s['cagr']*100:.1f}%</td></tr>"

    overweight_rows = ""
    for f in results.get("overweight_flags", []):
        overweight_rows += f"<tr><td>{f['strategy']}</td><td style='color:#ef4444'>{f['pct']*100:.1f}%</td><td>₹{f['notional']:,.0f}</td></tr>"

    html = f"""<!DOCTYPE html>
<html><head><meta charset='utf-8'>
<title>Monthly Report — {date_str}</title>
<script src='https://cdn.plot.ly/plotly-2.26.0.min.js'></script>
<style>
body{{background:#020617;color:#e2e8f0;font-family:monospace;padding:24px;max-width:1200px;margin:0 auto}}
h1{{color:#6366f1;border-bottom:2px solid #1e293b;padding-bottom:12px}}
h2{{color:#94a3b8;margin-top:32px}}
.cards{{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}}
.card{{background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:16px 20px;min-width:160px}}
.card-val{{font-size:28px;font-weight:bold;color:#6366f1}}
.card-lbl{{font-size:12px;color:#64748b;margin-top:4px}}
table{{border-collapse:collapse;width:100%;margin-top:8px}}
th{{background:#1e293b;padding:8px 12px;text-align:left;font-size:13px}}
td{{padding:6px 12px;border-bottom:1px solid #0f172a;font-size:13px}}
tr:hover td{{background:#0f172a}}
</style></head><body>
<h1>📅 Monthly Portfolio Report — {date_str}</h1>

<div class='cards'>
  <div class='card'><div class='card-val'>{results['strategies_backtested']}</div><div class='card-lbl'>Strategies Backtested</div></div>
  <div class='card'><div class='card-val'>{results['rebalance_trades']}</div><div class='card-lbl'>HRP Rebalance Targets</div></div>
  <div class='card'><div class='card-val'>{results['tax_lots_identified']}</div><div class='card-lbl'>Tax Lots Identified</div></div>
  <div class='card'><div class='card-val' style='color:{"#ef4444" if results["overweight_flags"] else "#22c55e"}'>{len(results['overweight_flags'])}</div><div class='card-lbl'>Overweight Flags</div></div>
</div>

<h2>Portfolio Equity (2 years)</h2>
<div id='equity' style='height:350px'></div>

<h2>Top 20 Strategies (Monthly Backtest)</h2>
<table>
<tr><th>Strategy</th><th>Sharpe</th><th>CAGR</th></tr>
{top_rows}
</table>

<h2>Overweight Positions</h2>
<table>
<tr><th>Strategy</th><th>Weight</th><th>Notional</th></tr>
{overweight_rows if overweight_rows else "<tr><td colspan='3' style='color:#22c55e'>No overweight positions</td></tr>"}
</table>

{equity_html}
</body></html>"""

    path.write_text(html)
    log.info("Monthly report written: %s", path)
    return path
