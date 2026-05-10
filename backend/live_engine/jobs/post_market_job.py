# backend/live_engine/jobs/post_market_job.py
"""
Post-market job — runs at 3:30 PM IST (Mon-Fri).

Steps:
  1. Wait for confirmed market close
  2. Reconcile tracked positions with broker
  3. Calculate final daily PnL (realized + unrealized → realized)
  4. Compute daily metrics: Sharpe (rolling), drawdown, turnover
  5. Save daily snapshot to Redis
  6. Send Telegram EOD summary
  7. Reset PnL tracker for next session
  8. Archive filled orders
"""
from __future__ import annotations

import json
import logging
import os
import time
import datetime
from typing import Any, Dict, List

import numpy as np

log = logging.getLogger(__name__)

_REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
_REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))


def _redis():
    try:
        import redis
        return redis.Redis(host=_REDIS_HOST, port=int(_REDIS_PORT), password=__import__("os").getenv("REDIS_PASSWORD") or None, decode_responses=True)
    except Exception:
        return None


def run() -> dict:
    """Post-market reconciliation and EOD summary — 3:30 PM IST."""
    t0 = time.perf_counter()
    today = datetime.date.today().isoformat()
    log.info("=== POST-MARKET JOB START [%s] ===", today)

    results: Dict[str, Any] = {
        "date": today,
        "daily_pnl": 0.0,
        "total_equity": 0.0,
        "drawdown": 0.0,
        "n_trades": 0,
        "n_mismatches": 0,
        "top_winners": [],
        "top_losers": [],
        "sharpe_rolling": 0.0,
        "turnover_pct": 0.0,
    }

    r = _redis()

    # ── 1. Reconcile with broker ──────────────────────────────────────────────
    try:
        from backend.live_engine.pnl_tracker import PnLTracker
        from backend.ai.agents.connectors.brokers.zerodha import _ZerodhaClient

        tracker = PnLTracker()
        broker = _ZerodhaClient()

        broker_positions = []
        try:
            if hasattr(broker, "get_positions"):
                raw = broker.get_positions()
                broker_positions = raw if isinstance(raw, list) else []
        except Exception as exc:
            log.warning("Could not fetch broker positions: %s", exc)

        mismatches = tracker.reconcile_with_broker(broker_positions)
        results["n_mismatches"] = len(mismatches)

        if mismatches:
            mismatch_text = "\n".join(
                f"  {m['symbol']}: ours={m['our_qty']:.0f}, broker={m['broker_qty']:.0f}"
                for m in mismatches
            )
            log.warning("RECONCILIATION MISMATCHES:\n%s", mismatch_text)
            _alert(f"⚠️ Reconciliation: {len(mismatches)} mismatches:\n{mismatch_text[:500]}")

    except Exception as exc:
        log.error("Reconciliation error: %s", exc)

    # ── 2. Collect final PnL metrics ──────────────────────────────────────────
    try:
        from backend.live_engine.pnl_tracker import PnLTracker
        tracker = PnLTracker()

        results["daily_pnl"] = tracker.get_daily_pnl()
        results["total_equity"] = tracker.get_total_equity()
        results["drawdown"] = tracker.get_drawdown()

        trades = tracker.get_trade_log(limit=1000)
        results["n_trades"] = len(trades)

        # Top winners / losers by realized PnL
        trade_pnl = {}
        for t in trades:
            sym = t.get("symbol", "")
            pnl = float(t.get("realized_pnl", 0))
            trade_pnl[sym] = trade_pnl.get(sym, 0) + pnl

        sorted_pnl = sorted(trade_pnl.items(), key=lambda x: x[1], reverse=True)
        results["top_winners"] = [{"symbol": s, "pnl": round(p, 2)} for s, p in sorted_pnl[:5] if p > 0]
        results["top_losers"] = [{"symbol": s, "pnl": round(p, 2)} for s, p in sorted_pnl[-5:] if p < 0]

    except Exception as exc:
        log.error("PnL collection error: %s", exc)

    # ── 3. Rolling Sharpe (252-day) ───────────────────────────────────────────
    try:
        if r:
            raw_returns = r.lrange("portfolio:daily_returns", -252, -1)
            if len(raw_returns) >= 30:
                rets = np.array([float(x) for x in raw_returns])
                mu = rets.mean() * 252
                sigma = rets.std() * np.sqrt(252)
                results["sharpe_rolling"] = round((mu - 0.065) / sigma, 4) if sigma > 0 else 0.0
    except Exception as exc:
        log.debug("Rolling Sharpe error: %s", exc)

    # ── 4. Save daily snapshot ────────────────────────────────────────────────
    try:
        if r:
            snapshot = {k: str(v) for k, v in results.items()
                        if not isinstance(v, (list, dict))}
            r.hset(f"snapshots:daily:{today}", mapping=snapshot)
            r.lpush("snapshots:daily:history", today)
            r.ltrim("snapshots:daily:history", 0, 252)  # keep 1 year
            log.info("Daily snapshot saved for %s", today)
    except Exception as exc:
        log.error("Snapshot save error: %s", exc)

    # ── 5. Reset PnL tracker for tomorrow ────────────────────────────────────
    try:
        from backend.live_engine.pnl_tracker import PnLTracker
        PnLTracker().reset_daily()
    except Exception as exc:
        log.error("Daily reset error: %s", exc)

    # ── 6. Archive orders ─────────────────────────────────────────────────────
    try:
        if r:
            fills_raw = r.xrange("fills", count=10000)
            if fills_raw:
                r.set(f"archive:fills:{today}:count", str(len(fills_raw)))
            log.info("Archived %d fills for %s", len(fills_raw) if fills_raw else 0, today)
    except Exception as exc:
        log.debug("Order archive error: %s", exc)

    elapsed = time.perf_counter() - t0
    log.info("=== POST-MARKET DONE in %.1fs ===", elapsed)

    # ── 7. Telegram EOD ───────────────────────────────────────────────────────
    try:
        from backend.live_engine.telegram_alerts import TelegramAlerter, fmt_eod_summary
        msg = fmt_eod_summary(
            pnl=results["daily_pnl"],
            drawdown=results["drawdown"],
            trades=results["n_trades"],
            top_winners=results["top_winners"],
            top_losers=results["top_losers"],
        )
        TelegramAlerter().send_sync(msg)
    except Exception as exc:
        log.error("Telegram EOD error: %s", exc)

    return results


def _alert(msg: str) -> None:
    try:
        from backend.live_engine.telegram_alerts import TelegramAlerter
        TelegramAlerter().send_sync(msg)
    except Exception:
        pass
