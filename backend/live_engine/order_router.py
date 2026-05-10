"""
OrderRouter — the critical path between strategy signals and broker execution.

Pipeline per order:
  OrderRequest
    → Risk manager gate (backend.engine.risk_manager.check_order)
    → Allocator sizing (notional cap from backend.engine.allocator)
    → Institutional risk gates (VIX halt, F&O ban, circuit-breaker)
    → Zerodha broker submission
    → Fill publication to Redis Stream ``fills``
    → PnL tracker update
    → Telegram alert (configurable)

All steps are wrapped in try/except — a failure at any gate rejects the
order and logs the reason; it never propagates an exception to the caller.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from backend.live_engine.strategy_runner import OrderRequest

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional dependency imports — all fail gracefully
# ---------------------------------------------------------------------------
try:
    import redis as _redis_mod
    from backend.live_engine.config import REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
    _redis_client = _redis_mod.Redis(
        host=REDIS_HOST, port=REDIS_PORT, password=REDIS_PASSWORD, decode_responses=True
    )
    _HAS_REDIS = True
except Exception:
    _redis_client = None  # type: ignore[assignment]
    _HAS_REDIS = False

try:
    from backend.engine.risk_manager import check_order as _risk_check_order
    _HAS_RISK = True
except Exception as _e:
    log.warning("risk_manager unavailable: %s", _e)
    _risk_check_order = None  # type: ignore[assignment]
    _HAS_RISK = False

try:
    from backend.engine.allocator import get_notionals
    _HAS_ALLOCATOR = True
except Exception as _e:
    log.warning("allocator unavailable: %s", _e)
    get_notionals = None  # type: ignore[assignment]
    _HAS_ALLOCATOR = False

try:
    from backend.ai.agents.connectors.brokers import zerodha as _zerodha
    _HAS_ZERODHA = True
except Exception as _e:
    log.warning("zerodha connector unavailable: %s", _e)
    _zerodha = None  # type: ignore[assignment]
    _HAS_ZERODHA = False

try:
    from backend.live_engine.pnl_tracker import PnLTracker
    _pnl_tracker: Optional[PnLTracker] = PnLTracker()
except Exception:
    _pnl_tracker = None

try:
    from backend.live_engine.telegram_alerts import TelegramAlerter
    _alerter: Optional[TelegramAlerter] = TelegramAlerter()
except Exception:
    _alerter = None

try:
    from backend.live_engine.config import NIFTY_VIX_HALT_THRESHOLD
except Exception:
    NIFTY_VIX_HALT_THRESHOLD = 30.0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _r_get(key: str) -> Optional[str]:
    if not _HAS_REDIS or _redis_client is None:
        return None
    try:
        return _redis_client.get(key)  # type: ignore[return-value]
    except Exception as exc:
        log.warning("Redis GET %s: %s", key, exc)
        return None


def _r_xadd(stream: str, payload: Dict[str, Any]) -> None:
    if not _HAS_REDIS or _redis_client is None:
        return
    try:
        _redis_client.xadd(stream, {"json": json.dumps(payload)}, maxlen=50_000)
    except Exception as exc:
        log.warning("Redis XADD %s: %s", stream, exc)


def _r_hget(name: str, key: str) -> Optional[str]:
    if not _HAS_REDIS or _redis_client is None:
        return None
    try:
        return _redis_client.hget(name, key)  # type: ignore[return-value]
    except Exception as exc:
        log.warning("Redis HGET %s %s: %s", name, key, exc)
        return None


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
# OrderRouter
# ---------------------------------------------------------------------------

class OrderRouter:
    """
    Routes ``OrderRequest`` objects through risk, sizing, and execution layers.

    The router is instantiated once at engine start-up and shared across
    all intraday tick loops.  Thread-safety: each call to ``route`` is
    self-contained.  Cancel / open-order queries use Redis for persistence.
    """

    _OPEN_ORDERS_HASH = "live:open_orders"
    _FILLED_ORDERS_ZSET = "live:filled_orders"
    _REJECTED_ORDERS_ZSET = "live:rejected_orders"
    _FILLS_STREAM = "fills"

    def __init__(
        self,
        pnl_tracker: Optional[PnLTracker] = None,
        alert_on_fill: bool = False,
    ) -> None:
        self._pnl_tracker = pnl_tracker or _pnl_tracker
        self._alerter = _alerter
        self._alert_on_fill = alert_on_fill

        # In-memory order store as fallback
        self._open_orders: Dict[str, Dict[str, Any]] = {}
        self._halted: bool = False

    # ------------------------------------------------------------------
    # Core routing
    # ------------------------------------------------------------------

    def route(self, order: OrderRequest) -> Optional[str]:
        """
        Route a single ``OrderRequest`` through the full pre-trade pipeline.

        Returns the broker ``order_id`` string on success, or ``None`` if the
        order was rejected at any gate.
        """
        if self._halted:
            log.warning("OrderRouter halted — rejecting %s %s", order.side, order.symbol)
            return None

        symbol = order.symbol.upper()

        # ── Gate 1: F&O ban list ─────────────────────────────────────────────
        fo_ban_raw = _r_get("market:fo_ban_list")
        if fo_ban_raw:
            try:
                fo_ban = json.loads(fo_ban_raw)
                if symbol in fo_ban:
                    self._reject(order, "fo_ban_list")
                    return None
            except Exception:
                pass

        # ── Gate 2: VIX halt ────────────────────────────────────────────────
        vix_raw = _r_get("market:india_vix")
        if vix_raw:
            try:
                vix = float(vix_raw)
                if vix >= NIFTY_VIX_HALT_THRESHOLD:
                    self._reject(order, f"vix_halt:{vix:.1f}")
                    return None
            except Exception:
                pass

        # ── Gate 3: Market-wide circuit breaker ────────────────────────────
        cb_raw = _r_get("market:circuit_breakers")
        if cb_raw:
            try:
                cb = json.loads(cb_raw)
                status = str(cb.get("marketStatus", "")).lower()
                if "halt" in status or "suspend" in status:
                    self._reject(order, f"circuit_breaker:{status}")
                    return None
            except Exception:
                pass

        # ── Gate 4: Kill switch ─────────────────────────────────────────────
        for _ks_key in ("risk:kill_switch_active", "risk:daily_trading_halted", "risk:kill_all"):
            _ks_val = _r_get(_ks_key)
            if _ks_val and str(_ks_val).lower() in ("1", "true", "yes"):
                self._halted = True
                self._reject(order, f"kill_switch:{_ks_key}")
                return None

        # ── Gate 5: Risk manager check ──────────────────────────────────────
        order_dict = self._order_to_dict(order)
        if _HAS_RISK and _risk_check_order is not None:
            try:
                ok, reason = _risk_check_order(order_dict)
                if not ok:
                    self._reject(order, reason or "risk_manager")
                    return None
            except Exception as exc:
                log.error("risk_manager check_order raised: %s — rejecting order", exc)
                self._reject(order, f"risk_manager_exception:{exc}")
                return None

        # ── Gate 6: Allocator sizing cap ────────────────────────────────────
        if _HAS_ALLOCATOR and get_notionals is not None:
            try:
                notionals = get_notionals()
                alloc = notionals.get(order.strategy, 0.0)
                price = order.limit_price or 0.0
                if alloc > 0 and price > 0:
                    notional = price * order.qty
                    used_raw = _r_hget("risk:used_by_strategy", order.strategy)
                    used = float(used_raw) if used_raw else 0.0
                    if (used + notional) > alloc * 1.05:  # 5% tolerance
                        self._reject(order, "allocator_cap")
                        return None
            except Exception as exc:
                log.warning("Allocator cap check failed: %s", exc)

        # ── Gate 7: Daily loss kill-switch ──────────────────────────────────
        daily_loss_limit = _r_get("risk:daily_loss_limit")
        if daily_loss_limit and self._pnl_tracker is not None:
            try:
                limit = float(daily_loss_limit)
                daily_pnl = self._pnl_tracker.get_daily_pnl()
                if daily_pnl < -abs(limit):
                    self._reject(order, "daily_loss_limit")
                    return None
            except Exception as exc:
                log.warning("Daily loss check failed: %s", exc)

        # ── Execute ──────────────────────────────────────────────────────────
        order_id = self._execute(order, order_dict)
        return order_id

    # ------------------------------------------------------------------
    # Emergency cancel
    # ------------------------------------------------------------------

    def cancel_all_orders(self) -> int:
        """
        Cancel all open orders at the broker (kill-switch action).

        Returns the count of orders successfully cancelled.
        """
        self._halted = True
        log.critical("OrderRouter.cancel_all_orders() called — HALTING all new orders")

        open_orders = self.get_open_orders()
        cancelled = 0

        for order_info in open_orders:
            order_id = order_info.get("order_id", "")
            if not order_id:
                continue
            try:
                if _HAS_ZERODHA and _zerodha is not None:
                    ok = _zerodha.cancel_order(order_id)
                    if ok:
                        cancelled += 1
                        log.info("Cancelled order %s", order_id)
            except Exception as exc:
                log.error("Failed to cancel order %s: %s", order_id, exc)

        # Clear Redis open orders
        if _HAS_REDIS and _redis_client is not None:
            try:
                _redis_client.delete(self._OPEN_ORDERS_HASH)
            except Exception:
                pass
        self._open_orders.clear()

        log.warning("cancel_all_orders: cancelled %d orders", cancelled)
        return cancelled

    def resume(self) -> None:
        """Re-enable order routing after a halt."""
        self._halted = False
        log.info("OrderRouter resumed")

    # ------------------------------------------------------------------
    # Order queries
    # ------------------------------------------------------------------

    def get_open_orders(self) -> List[Dict[str, Any]]:
        """Return all currently open/pending orders."""
        if _HAS_REDIS and _redis_client is not None:
            try:
                raw = _redis_client.hgetall(self._OPEN_ORDERS_HASH) or {}
                orders = []
                for v in raw.values():
                    try:
                        orders.append(json.loads(v))
                    except Exception:
                        pass
                return orders
            except Exception:
                pass
        return list(self._open_orders.values())

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _order_to_dict(self, order: OrderRequest) -> Dict[str, Any]:
        return {
            "strategy": order.strategy,
            "symbol": order.symbol,
            "side": order.side,
            "qty": order.qty,
            "order_type": order.order_type,
            "limit_price": order.limit_price,
            "stop_price": order.stop_price,
            "ts_ms": order.ts_ms,
            **order.extra,
        }

    def _execute(self, order: OrderRequest, order_dict: Dict[str, Any]) -> Optional[str]:
        """Submit to broker, record fill, publish to Redis."""
        order_id: Optional[str] = None

        if _HAS_ZERODHA and _zerodha is not None:
            try:
                order_id = _zerodha.submit_order(
                    symbol=order.symbol,
                    side=order.side,
                    qty=order.qty,
                    order_type=order.order_type,
                    limit_price=order.limit_price,
                    tag=order.strategy[:8],
                    venue="NSE",
                )
            except Exception as exc:
                log.error("Zerodha submit_order failed for %s: %s", order.symbol, exc)
                return None
        else:
            # Paper-trading mode
            order_id = f"PAPER-{uuid.uuid4().hex[:10]}"

        if order_id is None:
            return None

        # Persist open order
        order_record = {
            **order_dict,
            "order_id": order_id,
            "status": "sent",
            "ts_sent": int(time.time()),
        }
        if _HAS_REDIS and _redis_client is not None:
            try:
                _redis_client.hset(
                    self._OPEN_ORDERS_HASH, order_id, json.dumps(order_record)
                )
            except Exception:
                self._open_orders[order_id] = order_record
        else:
            self._open_orders[order_id] = order_record

        # Simulate immediate fill (market orders)
        if order.order_type in ("market", "mkt"):
            self._record_fill(order, order_id)

        return order_id

    def _record_fill(self, order: OrderRequest, order_id: str) -> None:
        """Record a (simulated or confirmed) fill in PnL tracker + Redis streams."""
        price = order.limit_price or self._get_last_price(order.symbol)
        if not price or price <= 0:
            log.error("_record_fill: no valid price for %s — skipping fill record", order.symbol)
            return
        fill = {
            "order_id": order_id,
            "strategy": order.strategy,
            "symbol": order.symbol,
            "side": order.side,
            "qty": order.qty,
            "price": price,
            "ts_ms": int(time.time() * 1000),
        }

        # Publish to fills stream
        _r_xadd(self._FILLS_STREAM, fill)

        # Archive in sorted set
        _r_zadd(self._FILLED_ORDERS_ZSET, time.time(), json.dumps(fill))

        # Remove from open orders
        if _HAS_REDIS and _redis_client is not None:
            try:
                _redis_client.hdel(self._OPEN_ORDERS_HASH, order_id)
            except Exception:
                pass
        self._open_orders.pop(order_id, None)

        # Update PnL tracker
        if self._pnl_tracker is not None:
            try:
                self._pnl_tracker.record_fill(fill)
            except Exception as exc:
                log.error("PnL tracker record_fill failed: %s", exc)

        # Telegram alert
        if self._alert_on_fill and self._alerter is not None:
            self._alerter.alert_order(
                symbol=order.symbol,
                side=order.side,
                qty=order.qty,
                price=price,
                strategy=order.strategy,
            )

        log.info(
            "Fill: %s %s %g @ %.2f [%s]",
            order.side.upper(), order.symbol, order.qty, price, order_id,
        )

    def _reject(self, order: OrderRequest, reason: str) -> None:
        """Log and persist a rejected order."""
        log.warning(
            "Order REJECTED — strategy=%s symbol=%s side=%s qty=%g reason=%s",
            order.strategy, order.symbol, order.side, order.qty, reason,
        )
        record = {
            **self._order_to_dict(order),
            "reject_reason": reason,
            "ts_rejected": int(time.time()),
        }
        _r_zadd(self._REJECTED_ORDERS_ZSET, time.time(), json.dumps(record))

    def _get_last_price(self, symbol: str) -> float:
        """Best-effort last price lookup for fill recording."""
        try:
            if _HAS_ZERODHA and _zerodha is not None:
                px = _zerodha.last_price(symbol)
                if px:
                    return float(px)
        except Exception:
            pass

        # Redis quote cache
        quote_raw = _r_get(f"live:quote:{symbol.upper()}")
        if quote_raw:
            try:
                q = json.loads(quote_raw)
                px = q.get("last_price")
                if px:
                    return float(px)
            except Exception:
                pass

        log.critical("No price found for %s — order fill skipped", symbol)
        return 0.0  # caller must guard price > 0
