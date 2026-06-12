# backend/engine/shadow_engine.py
"""
Shadow Engine — paper-trades every registered strategy in parallel.

For each strategy in the catalog, the shadow engine subscribes to the
`orders.incoming` stream and mirrors every order as a paper fill
(using last-trade price from Redis `last_price` hash), accumulating
shadow PnL under `shadow:pnl:<strategy>` and shadow positions under
`shadow:positions:<strategy>:<symbol>`.

This enables:
- Comparing live vs. paper performance without risking capital
- Identifying strategy drift before it manifests in real P&L
- Running the real-time strategy tournament (see strategy_tournament.py)

Run:
  python -m backend.engine.shadow_engine

Redis keys written:
  shadow:pnl:<strategy>          JSON {realized, unrealized, total}
  shadow:positions:<strategy>    HSET {symbol -> JSON position}
  shadow:alive                   JSON {ts}
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Dict, Optional

import redis

from backend.bus.streams import CHAN_ORDERS, consume_stream, publish_pubsub

log = logging.getLogger(__name__)

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
INCOMING_STREAM = os.getenv("SHADOW_INCOMING_STREAM", "orders.incoming")


class _LazyRedis:
    def __init__(self):
        self._client = None

    def _get(self):
        if self._client is None:
            ssl = os.getenv("REDIS_SSL", "").lower() in ("1", "true", "yes")
            kwargs = dict(
                host=REDIS_HOST,
                port=REDIS_PORT,
                password=os.getenv("REDIS_PASSWORD") or None,
                decode_responses=True,
            )
            if ssl:
                kwargs["ssl"] = True
                ca = os.getenv("REDIS_SSL_CA_CERTS")
                if ca:
                    kwargs["ssl_ca_certs"] = ca
            self._client = redis.Redis(**kwargs)
        return self._client

    def __getattr__(self, name: str):
        return getattr(self._get(), name)


r = _LazyRedis()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _last_price(symbol: str) -> Optional[float]:
    v = r.hget("last_price", symbol)
    if v is None:
        return None
    try:
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                obj = json.loads(v)
                return float(obj.get("price", 0) or 0)
        return float(v)
    except Exception:
        return None


def _load_shadow_pos(strategy: str, symbol: str) -> Dict:
    raw = r.hget(f"shadow:positions:{strategy}", symbol)
    if not raw:
        return {"symbol": symbol, "qty": 0.0, "avg_price": 0.0, "realized_pnl": 0.0}
    try:
        return json.loads(raw)
    except Exception:
        return {"symbol": symbol, "qty": 0.0, "avg_price": 0.0, "realized_pnl": 0.0}


def _save_shadow_pos(strategy: str, pos: Dict) -> None:
    r.hset(f"shadow:positions:{strategy}", pos["symbol"], json.dumps(pos))


def _update_shadow_pos(strategy: str, symbol: str, side: str, qty: float, price: float) -> float:
    pos = _load_shadow_pos(strategy, symbol)
    realized = 0.0
    if side == "buy":
        new_qty = pos["qty"] + qty
        if pos["qty"] <= 0:
            pos["avg_price"] = price if new_qty != 0 else 0.0
        else:
            pos["avg_price"] = (pos["avg_price"] * pos["qty"] + price * qty) / new_qty
        pos["qty"] = new_qty
    else:
        sell_qty = qty
        if pos["qty"] > 0:
            close_qty = min(pos["qty"], sell_qty)
            realized += (price - pos["avg_price"]) * close_qty
            pos["qty"] -= close_qty
            sell_qty -= close_qty
        if sell_qty > 0:
            pos["avg_price"] = price
            pos["qty"] -= sell_qty
    pos["realized_pnl"] = pos.get("realized_pnl", 0.0) + realized
    _save_shadow_pos(strategy, pos)
    return realized


def _update_shadow_pnl(strategy: str, realized_delta: float, symbol: str, price: float) -> None:
    key = f"shadow:pnl:{strategy}"
    raw = r.get(key)
    try:
        pnl = json.loads(raw) if raw else {"realized": 0.0, "unrealized": 0.0, "total": 0.0}
    except Exception:
        pnl = {"realized": 0.0, "unrealized": 0.0, "total": 0.0}

    pnl["realized"] = pnl.get("realized", 0.0) + realized_delta

    # Recompute unrealized across all shadow positions for this strategy
    unrealized = 0.0
    all_pos = r.hgetall(f"shadow:positions:{strategy}")
    for sym, raw_pos in all_pos.items():
        try:
            p = json.loads(raw_pos)
            lp = _last_price(sym)
            if lp is not None and p.get("qty", 0.0) != 0:
                unrealized += (lp - p["avg_price"]) * p["qty"]
        except Exception:
            continue

    pnl["unrealized"] = unrealized
    pnl["total"] = pnl["realized"] + pnl["unrealized"]
    r.set(key, json.dumps(pnl))


def _process_shadow_order(order: Dict) -> None:
    strategy = str(order.get("strategy", "")).strip()
    symbol = str(order.get("symbol", "")).strip().upper()
    side = str(order.get("side", "")).lower()
    qty = float(order.get("qty", 0.0) or 0.0)

    if not strategy or not symbol or side not in ("buy", "sell") or qty <= 0:
        return

    price = _last_price(symbol)
    if price is None:
        log.debug("Shadow: no market price for %s, skipping", symbol)
        return

    realized = _update_shadow_pos(strategy, symbol, side, qty, price)
    _update_shadow_pnl(strategy, realized, symbol, price)

    publish_pubsub(CHAN_ORDERS, {
        "event": "shadow_fill",
        "strategy": strategy,
        "symbol": symbol,
        "side": side,
        "qty": qty,
        "price": price,
        "realized_delta": realized,
        "ts_ms": _now_ms(),
    })


def run() -> None:
    r.set("shadow:alive", json.dumps({"ts": _now_ms()}))
    log.info("Shadow engine started, listening on %s", INCOMING_STREAM)
    for _, order in consume_stream(INCOMING_STREAM, start_id="$", block_ms=1000, count=200):
        try:
            if isinstance(order, str):
                order = json.loads(order)
            _process_shadow_order(order)
        except Exception:
            log.exception("Shadow engine: error processing order %s", order)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run()
