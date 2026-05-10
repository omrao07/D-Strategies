"""
Telegram alerting for the D-Strategies live engine.

All network I/O is async-first; a sync wrapper is provided for use in
non-async scheduler callbacks.  Messages are throttled to a maximum of one
every 5 seconds to avoid Telegram's per-bot rate limit (30 msg/min).
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import List, Optional

from backend.live_engine.config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

log = logging.getLogger(__name__)

try:
    import httpx
    _HAS_HTTPX = True
except ImportError:
    httpx = None  # type: ignore[assignment]
    _HAS_HTTPX = False

# ---------------------------------------------------------------------------
# Message format helpers (module-level so they can be imported standalone)
# ---------------------------------------------------------------------------

def fmt_eod_summary(
    pnl: float,
    drawdown: float,
    trades: int,
    top_winners: List[str],
    top_losers: List[str],
) -> str:
    """Format an end-of-day Telegram summary message."""
    winners = ", ".join(top_winners[:3]) if top_winners else "—"
    losers = ", ".join(top_losers[:3]) if top_losers else "—"
    sign = "+" if pnl >= 0 else ""
    return (
        f"📊 *EOD Summary*\n"
        f"P&L: `{sign}₹{pnl:,.2f}`\n"
        f"Drawdown: `{drawdown:.2f}%`\n"
        f"Trades today: `{trades}`\n"
        f"Top winners: {winners}\n"
        f"Top losers: {losers}"
    )


def fmt_risk_breach(
    gate: str,
    value: float,
    threshold: float,
    action: str,
) -> str:
    """Format a risk-breach alert."""
    return (
        f"🚨 *Risk Breach — {gate}*\n"
        f"Value: `{value:.4f}`\n"
        f"Threshold: `{threshold:.4f}`\n"
        f"Action taken: `{action}`"
    )


def fmt_health_alert(component: str, status: str, detail: str) -> str:
    """Format a component health-check alert."""
    icon = "✅" if status.lower() == "ok" else "❌"
    return (
        f"{icon} *Health: {component}*\n"
        f"Status: `{status}`\n"
        f"Detail: {detail}"
    )


def fmt_weekly_report(
    sharpe: float,
    cagr: float,
    dd: float,
    n_strategies: int,
) -> str:
    """Format a weekly performance summary."""
    return (
        f"📈 *Weekly Report*\n"
        f"Sharpe (rolling): `{sharpe:.2f}`\n"
        f"CAGR: `{cagr:.2f}%`\n"
        f"Max Drawdown: `{dd:.2f}%`\n"
        f"Active strategies: `{n_strategies}`"
    )


def fmt_order(
    symbol: str,
    side: str,
    qty: float,
    price: float,
    strategy: str,
) -> str:
    """Format an order execution notification."""
    side_icon = "🟢" if side.lower() == "buy" else "🔴"
    return (
        f"{side_icon} *Order — {symbol}*\n"
        f"Side: `{side.upper()}`  Qty: `{qty}`  Price: `₹{price:,.2f}`\n"
        f"Strategy: `{strategy}`"
    )


# ---------------------------------------------------------------------------
# Alerter class
# ---------------------------------------------------------------------------

class TelegramAlerter:
    """
    Thin wrapper around the Telegram Bot API.

    - Async ``send(msg)`` for use inside asyncio loops.
    - Sync ``send_sync(msg)`` for scheduler callbacks.
    - Throttle: at most one message per ``_throttle_sec`` seconds.
    - Falls back gracefully to ``logging`` if httpx is unavailable or the
      network call fails.
    """

    _throttle_sec: float = 5.0

    def __init__(
        self,
        bot_token: str = "",
        chat_id: str = "",
        throttle_sec: float = 5.0,
    ) -> None:
        self._bot_token = bot_token or TELEGRAM_BOT_TOKEN
        self._chat_id = chat_id or TELEGRAM_CHAT_ID
        self._throttle_sec = throttle_sec
        self._last_sent: float = 0.0

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _api_url(self) -> str:
        return f"https://api.telegram.org/bot{self._bot_token}/sendMessage"

    def _is_configured(self) -> bool:
        return bool(self._bot_token and self._chat_id)

    def _should_throttle(self) -> bool:
        return (time.monotonic() - self._last_sent) < self._throttle_sec

    def _build_payload(self, msg: str) -> dict:
        return {
            "chat_id": self._chat_id,
            "text": msg,
            "parse_mode": "Markdown",
            "disable_web_page_preview": True,
        }

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def send(self, msg: str) -> bool:
        """
        Send *msg* asynchronously.  Returns True on success, False on failure.
        Silently no-ops when not configured or when throttled.
        """
        if not self._is_configured():
            log.debug("TelegramAlerter: not configured — skipping send")
            return False

        if self._should_throttle():
            log.debug("TelegramAlerter: throttled — skipping send")
            return False

        if not _HAS_HTTPX:
            log.warning("TelegramAlerter: httpx not installed — logging msg instead: %s", msg)
            return False

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(self._api_url(), json=self._build_payload(msg))
                resp.raise_for_status()
            self._last_sent = time.monotonic()
            log.debug("TelegramAlerter: sent OK")
            return True
        except Exception as exc:
            log.error("TelegramAlerter: send failed — %s", exc)
            return False

    def send_sync(self, msg: str) -> bool:
        """Synchronous wrapper safe to call from any thread (including APScheduler workers)."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        try:
            if loop and loop.is_running():
                asyncio.ensure_future(self.send(msg))
                return True
            return asyncio.run(self.send(msg))
        except Exception as exc:
            log.error("TelegramAlerter.send_sync failed — %s", exc)
            return False

    # ------------------------------------------------------------------
    # Convenience short-hands
    # ------------------------------------------------------------------

    def alert_risk_breach(
        self,
        gate: str,
        value: float,
        threshold: float,
        action: str,
    ) -> bool:
        return self.send_sync(fmt_risk_breach(gate, value, threshold, action))

    def alert_health(self, component: str, status: str, detail: str) -> bool:
        return self.send_sync(fmt_health_alert(component, status, detail))

    def alert_eod(
        self,
        pnl: float,
        drawdown: float,
        trades: int,
        top_winners: Optional[List[str]] = None,
        top_losers: Optional[List[str]] = None,
    ) -> bool:
        return self.send_sync(
            fmt_eod_summary(pnl, drawdown, trades, top_winners or [], top_losers or [])
        )

    def alert_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        price: float,
        strategy: str,
    ) -> bool:
        return self.send_sync(fmt_order(symbol, side, qty, price, strategy))


# Process-global default alerter (uses env vars)
_alerter = TelegramAlerter()


def send(msg: str) -> bool:
    """Module-level convenience wrapper around the global alerter."""
    return _alerter.send_sync(msg)
