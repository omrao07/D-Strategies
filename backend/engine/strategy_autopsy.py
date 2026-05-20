# backend/engine/strategy_autopsy.py
"""
Strategy Autopsy System

When a strategy breaches a loss threshold or gets disabled via kill switch,
this module performs an automated post-mortem analysis and writes a structured
report to Redis under `autopsy:<strategy>:<timestamp>`.

The report includes:
  - trigger: what caused the autopsy (daily_loss / kill_switch / manual)
  - pnl_breakdown: realized and unrealized at time of death
  - top_losing_trades: worst 5 fills
  - top_losing_symbols: symbols with most negative P&L
  - regime_at_time: the active market regime
  - dna_snapshot: the DNA vector at time of death
  - recommendations: simple rule-based diagnostics

Usage:
  from backend.engine.strategy_autopsy import perform_autopsy
  perform_autopsy("momentum_us", trigger="daily_loss")

Reports are stored for 30 days (TTL).
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Dict, List, Optional

log = logging.getLogger(__name__)

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
AUTOPSY_TTL_SECONDS = int(os.getenv("AUTOPSY_TTL_SECONDS", str(30 * 86400)))


def _get_redis():
    import redis as _redis
    ssl = os.getenv("REDIS_SSL", "").lower() in ("1", "true", "yes")
    kwargs = dict(
        host=REDIS_HOST,
        port=REDIS_PORT,
        password=os.getenv("REDIS_PASSWORD") or None,
        decode_responses=True,
    )
    if ssl:
        kwargs["ssl"] = True
    return _redis.Redis(**kwargs)


def _get_fills(strategy: str, r, limit: int = 500) -> List[Dict]:
    """Pull recent fills from STREAM_FILLS for the strategy."""
    fills = []
    try:
        raw = r.xrevrange("fills", count=limit)
        for _msg_id, fields in raw:
            if str(fields.get("strategy", "")) == strategy:
                try:
                    fills.append({
                        "ts_ms": int(fields.get("ts_ms", 0)),
                        "symbol": fields.get("symbol", ""),
                        "side": fields.get("side", ""),
                        "qty": float(fields.get("qty", 0)),
                        "price": float(fields.get("price", 0)),
                        "realized_delta": float(fields.get("realized_delta", 0)),
                    })
                except Exception:
                    continue
    except Exception:
        log.warning("autopsy: could not read fills stream for %s", strategy)
    return fills


def _top_losing_trades(fills: List[Dict], n: int = 5) -> List[Dict]:
    sells = [f for f in fills if f.get("side") == "sell"]
    sells.sort(key=lambda x: x.get("realized_delta", 0))
    return sells[:n]


def _top_losing_symbols(fills: List[Dict], n: int = 5) -> List[Dict]:
    pnl_by_sym: Dict[str, float] = {}
    for f in fills:
        sym = f.get("symbol", "")
        pnl_by_sym[sym] = pnl_by_sym.get(sym, 0.0) + float(f.get("realized_delta", 0))
    sorted_syms = sorted(pnl_by_sym.items(), key=lambda x: x[1])
    return [{"symbol": s, "realized_pnl": p} for s, p in sorted_syms[:n]]


def _diagnostics(fills: List[Dict], pnl: Dict) -> List[str]:
    recs = []
    total = pnl.get("total", 0.0)
    if total < -1000:
        recs.append("CRITICAL: realized loss exceeded -$1,000. Consider strategy suspension.")
    sells = [f for f in fills if f.get("side") == "sell"]
    if sells:
        wins = sum(1 for f in sells if f.get("realized_delta", 0) > 0)
        win_rate = wins / len(sells)
        if win_rate < 0.35:
            recs.append(f"Win rate critically low ({win_rate:.1%}). Signal quality may have degraded.")
    notionals = [abs(f.get("qty", 0) * f.get("price", 0)) for f in fills]
    if notionals and max(notionals) > 20000:
        recs.append("Single fill notional exceeded $20,000. Position sizing may need review.")
    if not recs:
        recs.append("No critical issues detected. Loss within expected parameters.")
    return recs


def perform_autopsy(strategy: str, trigger: str = "manual", r=None) -> Dict:
    """
    Perform a post-mortem analysis for `strategy`.
    Returns the autopsy report dict and stores it in Redis.
    """
    if r is None:
        r = _get_redis()

    ts = int(time.time())

    # PnL snapshot
    pnl = {}
    try:
        raw_pnl = r.get(f"pnl:day_strategy:{strategy}")
        pnl = json.loads(raw_pnl) if raw_pnl else {}
    except Exception:
        pass

    # Fills
    fills = _get_fills(strategy, r)

    # Regime
    regime = "unknown"
    try:
        raw_regime = r.get("regime:current")
        if raw_regime:
            obj = json.loads(raw_regime)
            regime = obj.get("regime", "unknown")
    except Exception:
        pass

    # DNA snapshot
    dna = {}
    try:
        raw_dna = r.get(f"strategy:dna:{strategy}")
        if raw_dna:
            dna = json.loads(raw_dna)
    except Exception:
        pass

    report = {
        "strategy": strategy,
        "trigger": trigger,
        "ts": ts,
        "pnl_at_death": pnl,
        "regime_at_time": regime,
        "top_losing_trades": _top_losing_trades(fills),
        "top_losing_symbols": _top_losing_symbols(fills),
        "dna_snapshot": dna,
        "recommendations": _diagnostics(fills, pnl),
        "fill_count_analyzed": len(fills),
    }

    # Persist
    try:
        key = f"autopsy:{strategy}:{ts}"
        r.set(key, json.dumps(report), ex=AUTOPSY_TTL_SECONDS)
        r.lpush(f"autopsy:history:{strategy}", key)
        r.ltrim(f"autopsy:history:{strategy}", 0, 99)  # keep last 100
        log.info("Autopsy stored at %s (trigger=%s)", key, trigger)
    except Exception:
        log.exception("autopsy: failed to persist report for %s", strategy)

    return report
