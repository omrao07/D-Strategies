"""
PnL Tracker — Redis-backed real-time position and profit/loss accounting.

Redis key schema:
  pnl:positions:{symbol}      — JSON: {qty, avg_price, unrealized_pnl}
  pnl:realized                — running realized PnL (float string)
  pnl:peak_equity             — all-time equity high-water mark
  pnl:daily_snapshot:{date}   — JSON snapshot of EOD stats
  pnl:trades                  — Redis sorted-set, score=timestamp, value=JSON trade

All monetary values are in Indian Rupees (₹) and are tracked against the
``CAPITAL_BASE`` environment variable.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from backend.live_engine.config import CAPITAL_BASE, IST, REDIS_HOST, REDIS_PORT, REDIS_PASSWORD

log = logging.getLogger(__name__)

try:
    import redis as _redis_mod
    _redis_client = _redis_mod.Redis(
        host=REDIS_HOST,
        port=REDIS_PORT,
        password=REDIS_PASSWORD,
        decode_responses=True,
    )
    _HAS_REDIS = True
except Exception:
    _redis_client = None  # type: ignore[assignment]
    _HAS_REDIS = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_ts() -> float:
    return time.time()


def _r_get(key: str) -> Optional[str]:
    if not _HAS_REDIS or _redis_client is None:
        return None
    try:
        return _redis_client.get(key)  # type: ignore[return-value]
    except Exception as exc:
        log.warning("Redis GET %s: %s", key, exc)
        return None


def _r_set(key: str, value: str, ex: Optional[int] = None) -> None:
    if not _HAS_REDIS or _redis_client is None:
        return
    try:
        _redis_client.set(key, value, ex=ex)
    except Exception as exc:
        log.warning("Redis SET %s: %s", key, exc)


def _r_hget(name: str, key: str) -> Optional[str]:
    if not _HAS_REDIS or _redis_client is None:
        return None
    try:
        return _redis_client.hget(name, key)  # type: ignore[return-value]
    except Exception as exc:
        log.warning("Redis HGET %s %s: %s", name, key, exc)
        return None


def _r_hset(name: str, key: str, value: str) -> None:
    if not _HAS_REDIS or _redis_client is None:
        return
    try:
        _redis_client.hset(name, key, value)
    except Exception as exc:
        log.warning("Redis HSET %s %s: %s", name, key, exc)


def _r_hgetall(name: str) -> Dict[str, str]:
    if not _HAS_REDIS or _redis_client is None:
        return {}
    try:
        return _redis_client.hgetall(name) or {}  # type: ignore[return-value]
    except Exception as exc:
        log.warning("Redis HGETALL %s: %s", name, exc)
        return {}


def _r_zadd(name: str, score: float, value: str) -> None:
    if not _HAS_REDIS or _redis_client is None:
        return
    try:
        _redis_client.zadd(name, {value: score})
    except Exception as exc:
        log.warning("Redis ZADD %s: %s", name, exc)


def _r_zrange(name: str, start: int, end: int) -> List[str]:
    if not _HAS_REDIS or _redis_client is None:
        return []
    try:
        return _redis_client.zrange(name, start, end)  # type: ignore[return-value]
    except Exception as exc:
        log.warning("Redis ZRANGE %s: %s", name, exc)
        return []


# ---------------------------------------------------------------------------
# PnLTracker
# ---------------------------------------------------------------------------

class PnLTracker:
    """
    Real-time position and P&L tracker backed by Redis.

    Positions are keyed per symbol.  All fills are recorded in a sorted set
    for audit and for daily EOD snapshots.
    """

    _POS_HASH = "pnl:positions"
    _REALIZED_KEY = "pnl:realized"
    _PEAK_KEY = "pnl:peak_equity"
    _TRADES_ZSET = "pnl:trades"

    def __init__(self, capital_base: float = 0.0) -> None:
        self._capital_base: float = capital_base or CAPITAL_BASE
        # In-memory fallback when Redis is unavailable
        self._positions: Dict[str, Dict[str, Any]] = {}
        self._realized_pnl: float = 0.0
        self._peak_equity: float = self._capital_base
        self._trades: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------
    # Fill recording
    # ------------------------------------------------------------------

    def record_fill(self, fill: Dict[str, Any]) -> None:
        """
        Process a broker fill and update position / realized PnL.

        *fill* must contain: symbol, side ('buy'/'sell'), qty, price.
        Optional: strategy, order_id, ts_ms.
        """
        symbol: str = str(fill.get("symbol", "")).upper()
        side: str = str(fill.get("side", "buy")).lower()
        qty: float = float(fill.get("qty", 0))
        price: float = float(fill.get("price", 0))
        ts: float = float(fill.get("ts_ms", _now_ts() * 1000)) / 1000.0

        if not symbol or qty <= 0 or price <= 0:
            log.warning("record_fill: invalid fill %s", fill)
            return

        pos = self._load_position(symbol)

        if side == "buy":
            new_qty = pos["qty"] + qty
            if new_qty > 0:
                pos["avg_price"] = (pos["avg_price"] * pos["qty"] + price * qty) / new_qty
            pos["qty"] = new_qty
        else:  # sell
            sell_qty = min(qty, pos["qty"])
            realized = (price - pos["avg_price"]) * sell_qty
            self._realized_pnl += realized
            self._persist_realized()

            pos["qty"] = pos["qty"] - sell_qty
            if pos["qty"] <= 0:
                pos["qty"] = 0.0
                pos["avg_price"] = 0.0

        pos["unrealized_pnl"] = (price - pos["avg_price"]) * pos["qty"]
        self._save_position(symbol, pos)

        # Trade log
        trade_record = {
            "symbol": symbol,
            "side": side,
            "qty": qty,
            "price": price,
            "ts": ts,
            "strategy": fill.get("strategy", ""),
            "order_id": fill.get("order_id", ""),
        }
        _r_zadd(self._TRADES_ZSET, ts, json.dumps(trade_record))
        self._trades.append(trade_record)

        # Update peak equity
        current = self.get_total_equity()
        peak = self.get_peak_equity()
        if current > peak:
            self._peak_equity = current
            _r_set(self._PEAK_KEY, str(current))

        log.debug(
            "Fill: %s %s %g @ %.2f | realized=%.2f",
            side.upper(), symbol, qty, price, self._realized_pnl,
        )

    # ------------------------------------------------------------------
    # Position queries
    # ------------------------------------------------------------------

    def get_position(self, symbol: str) -> Dict[str, Any]:
        """Return position dict for *symbol*: qty, avg_price, unrealized_pnl."""
        return self._load_position(symbol.upper())

    def get_all_positions(self) -> Dict[str, Dict[str, Any]]:
        """Return all open positions keyed by symbol."""
        raw = _r_hgetall(self._POS_HASH)
        out: Dict[str, Dict[str, Any]] = {}
        for sym, val in raw.items():
            try:
                pos = json.loads(val)
                if pos.get("qty", 0) != 0:
                    out[sym] = pos
            except Exception:
                pass

        # Merge in-memory fallback
        for sym, pos in self._positions.items():
            if sym not in out and pos.get("qty", 0) != 0:
                out[sym] = pos
        return out

    def mark_to_market(self, prices: Dict[str, float]) -> None:
        """
        Update unrealized PnL for all open positions using *prices* mapping
        ``{symbol: last_price}``.
        """
        for symbol, price in prices.items():
            pos = self._load_position(symbol.upper())
            if pos["qty"] == 0:
                continue
            pos["unrealized_pnl"] = (price - pos["avg_price"]) * pos["qty"]
            self._save_position(symbol.upper(), pos)

    # ------------------------------------------------------------------
    # Aggregate metrics
    # ------------------------------------------------------------------

    def get_daily_pnl(self) -> float:
        """Sum of realized + unrealized PnL since last ``reset_daily()`` call."""
        unrealized = sum(
            pos.get("unrealized_pnl", 0.0)
            for pos in self.get_all_positions().values()
        )
        return self._realized_pnl + unrealized

    def get_total_equity(self) -> float:
        """Capital base + cumulative all-time realized PnL + current unrealized."""
        realized_str = _r_get(self._REALIZED_KEY)
        try:
            realized = float(realized_str) if realized_str else self._realized_pnl
        except Exception:
            realized = self._realized_pnl

        unrealized = sum(
            pos.get("unrealized_pnl", 0.0)
            for pos in self.get_all_positions().values()
        )
        return self._capital_base + realized + unrealized

    def get_peak_equity(self) -> float:
        """All-time high-water mark equity."""
        peak_str = _r_get(self._PEAK_KEY)
        try:
            if peak_str:
                return max(float(peak_str), self._peak_equity)
        except Exception:
            pass
        return max(self._peak_equity, self._capital_base)

    def get_drawdown(self) -> float:
        """Current drawdown as a fraction of peak equity: (peak - current) / peak."""
        peak = self.get_peak_equity()
        current = self.get_total_equity()
        if peak <= 0:
            return 0.0
        dd = (peak - current) / peak
        return max(0.0, dd)

    # ------------------------------------------------------------------
    # Reconciliation
    # ------------------------------------------------------------------

    def reconcile_with_broker(self, broker_positions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Compare internal positions against *broker_positions*.

        Returns a list of mismatch dicts (empty list = clean reconciliation).
        Each mismatch: {symbol, internal_qty, broker_qty, delta}.
        """
        mismatches: List[Dict[str, Any]] = []
        broker_map: Dict[str, float] = {
            p["symbol"].upper(): float(p.get("qty", 0))
            for p in broker_positions
            if p.get("symbol")
        }
        internal_map: Dict[str, float] = {
            sym: pos["qty"]
            for sym, pos in self.get_all_positions().items()
        }
        all_symbols = set(broker_map) | set(internal_map)
        for sym in all_symbols:
            b_qty = broker_map.get(sym, 0.0)
            i_qty = internal_map.get(sym, 0.0)
            delta = abs(b_qty - i_qty)
            if delta > 0.0001:
                log.warning(
                    "Reconciliation mismatch %s: internal=%.2f broker=%.2f",
                    sym, i_qty, b_qty,
                )
                mismatches.append({
                    "symbol": sym,
                    "internal_qty": i_qty,
                    "broker_qty": b_qty,
                    "delta": delta,
                })
        return mismatches

    # ------------------------------------------------------------------
    # Trade log
    # ------------------------------------------------------------------

    def get_trade_log(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Return the *limit* most-recent trades from Redis sorted set."""
        raw = _r_zrange(self._TRADES_ZSET, -limit, -1)
        trades: List[Dict[str, Any]] = []
        for item in reversed(raw):
            try:
                trades.append(json.loads(item))
            except Exception:
                pass
        if not trades:
            # In-memory fallback
            return list(reversed(self._trades[-limit:]))
        return trades

    # ------------------------------------------------------------------
    # Daily reset
    # ------------------------------------------------------------------

    def reset_daily(self) -> None:
        """
        Save a snapshot of today's PnL then zero the daily realized counter.
        Called at market open each day.
        """
        today = datetime.now(tz=IST).date().isoformat()  # type: ignore[arg-type]
        snapshot = {
            "date": today,
            "realized_pnl": self._realized_pnl,
            "total_equity": self.get_total_equity(),
            "drawdown": self.get_drawdown(),
            "peak_equity": self.get_peak_equity(),
        }
        _r_set(f"pnl:daily_snapshot:{today}", json.dumps(snapshot), ex=60 * 86400)
        log.info("PnL daily snapshot saved for %s: realized=%.2f", today, self._realized_pnl)

        # Reset daily counter
        self._realized_pnl = 0.0
        _r_set(self._REALIZED_KEY, "0.0")

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _load_position(self, symbol: str) -> Dict[str, Any]:
        raw = _r_hget(self._POS_HASH, symbol)
        if raw:
            try:
                return json.loads(raw)
            except Exception:
                pass
        return self._positions.get(symbol, {"qty": 0.0, "avg_price": 0.0, "unrealized_pnl": 0.0})

    def _save_position(self, symbol: str, pos: Dict[str, Any]) -> None:
        self._positions[symbol] = pos
        _r_hset(self._POS_HASH, symbol, json.dumps(pos))

    def _persist_realized(self) -> None:
        _r_set(self._REALIZED_KEY, str(self._realized_pnl))
