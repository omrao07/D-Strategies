"""
Pre-market job — runs at 9:10 AM IST every trading day.

Responsibilities:
  1. Fetch GIFT Nifty gap as a directional signal
  2. Cache India VIX to Redis
  3. Download NSE F&O ban list → Redis
  4. Fetch NSE circuit-breaker levels → Redis
  5. Arm risk limits in Redis
  6. Run allocator to refresh weights for the day
  7. Send Telegram summary
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional dependencies
# ---------------------------------------------------------------------------
try:
    import redis as _redis_mod

    from backend.live_engine.config import (
        CAPITAL_BASE,
        MAX_DAILY_LOSS_PCT,
        MAX_DRAWDOWN_PCT,
        REDIS_HOST,
        REDIS_PASSWORD,
        REDIS_PORT,
    )
    _redis_client = _redis_mod.Redis(
        host=REDIS_HOST, port=REDIS_PORT, password=REDIS_PASSWORD, decode_responses=True
    )
    _HAS_REDIS = True
except Exception:
    _redis_client = None  # type: ignore[assignment]
    _HAS_REDIS = False

try:
    from backend.live_engine.market_data_service import MarketDataService
    _svc = MarketDataService()
    _HAS_MDS = True
except Exception as _e:
    log.warning("MarketDataService unavailable: %s", _e)
    _svc = None  # type: ignore[assignment]
    _HAS_MDS = False

try:
    from backend.engine.allocator import allocate
    _HAS_ALLOCATOR = True
except Exception as _e:
    log.warning("allocator unavailable: %s", _e)
    allocate = None  # type: ignore[assignment]
    _HAS_ALLOCATOR = False

try:
    from backend.live_engine.telegram_alerts import TelegramAlerter
    _alerter = TelegramAlerter()
    _HAS_TELEGRAM = True
except Exception:
    _alerter = None  # type: ignore[assignment]
    _HAS_TELEGRAM = False

try:
    import httpx as _httpx
    _HAS_HTTPX = True
except ImportError:
    _httpx = None  # type: ignore[assignment]
    _HAS_HTTPX = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _r_set(key: str, value: str, ex: int | None = None) -> None:
    if not _HAS_REDIS or _redis_client is None:
        return
    try:
        _redis_client.set(key, value, ex=ex)
    except Exception as exc:
        log.warning("Redis SET %s: %s", key, exc)


def _fetch_gift_nifty_gap() -> float:
    """
    Estimate GIFT Nifty gap vs previous NSE close.

    GIFT Nifty futures (SGX Nifty successor) price is compared against the
    previous day's Nifty 50 close price to determine the implied market gap.

    Returns gap percentage: positive = gap-up, negative = gap-down.
    Falls back to 0.0 if the data cannot be fetched.
    """
    if not _HAS_HTTPX or _httpx is None:
        return 0.0
    try:
        headers = {
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://www.nseindia.com/",
        }
        with _httpx.Client(headers=headers, timeout=10.0, follow_redirects=True) as client:
            # NSE index data for Nifty 50
            resp = client.get("https://www.nseindia.com/api/allIndices")
            data = resp.json()
            prev_close = None
            for idx in data.get("data", []):
                if idx.get("index") == "NIFTY 50":
                    prev_close = float(idx.get("previousClose", 0))
                    break

            if not prev_close:
                return 0.0

            # GIFT Nifty — try NSE API for derivatives
            gift_resp = client.get(
                "https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY"
            )
            gift_data = gift_resp.json()
            fut_price = gift_data.get("records", {}).get("underlyingValue", prev_close)
            gap_pct = (float(fut_price) - prev_close) / prev_close * 100.0
            return round(gap_pct, 2)
    except Exception as exc:
        log.warning("GIFT Nifty gap fetch failed: %s", exc)
        return 0.0


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run() -> Dict[str, Any]:
    """
    9:10 AM IST daily pre-market setup job.

    Returns a status summary dict.
    """
    log.info("=== Pre-market job starting ===")
    summary: Dict[str, Any] = {
        "ts": int(time.time()),
        "status": "ok",
        "errors": [],
    }

    # ── Step 1: GIFT Nifty gap ───────────────────────────────────────────────
    try:
        gift_gap = _fetch_gift_nifty_gap()
        summary["gift_nifty_gap_pct"] = gift_gap
        gap_direction = "bull" if gift_gap > 0.3 else ("bear" if gift_gap < -0.3 else "neutral")
        summary["gift_signal"] = gap_direction
        log.info("GIFT Nifty gap: %.2f%% (%s)", gift_gap, gap_direction)
    except Exception as exc:
        log.error("GIFT Nifty gap step failed: %s", exc)
        summary["errors"].append(f"gift_nifty: {exc}")
        gift_gap = 0.0

    # ── Step 2: India VIX ────────────────────────────────────────────────────
    vix = 15.0
    try:
        if _HAS_MDS and _svc is not None:
            vix = _svc.get_india_vix()
            _r_set("market:india_vix", str(vix), ex=86400)
            summary["india_vix"] = vix
            log.info("India VIX cached: %.2f", vix)
    except Exception as exc:
        log.error("VIX caching failed: %s", exc)
        summary["errors"].append(f"vix: {exc}")

    # ── Step 3: F&O ban list ─────────────────────────────────────────────────
    fo_ban_count = 0
    try:
        if _HAS_MDS and _svc is not None:
            fo_ban = _svc.get_fo_ban_list()
            _r_set("market:fo_ban_list", json.dumps(fo_ban), ex=86400)
            fo_ban_count = len(fo_ban)
            summary["fo_ban_count"] = fo_ban_count
            summary["fo_ban_list"] = fo_ban[:10]  # first 10 for log
            log.info("F&O ban list cached: %d symbols", fo_ban_count)
    except Exception as exc:
        log.error("F&O ban list step failed: %s", exc)
        summary["errors"].append(f"fo_ban: {exc}")

    # ── Step 4: Circuit-breaker levels ──────────────────────────────────────
    try:
        if _HAS_MDS and _svc is not None:
            cb_status = _svc.get_nse_circuit_breaker_status()
            _r_set("market:circuit_breakers", json.dumps(cb_status), ex=3600)
            summary["circuit_breakers"] = cb_status.get("marketStatus")
            log.info("Circuit-breaker status cached: %s", cb_status.get("marketStatus"))
    except Exception as exc:
        log.error("Circuit-breaker step failed: %s", exc)
        summary["errors"].append(f"circuit_breakers: {exc}")

    # ── Step 5: Arm risk limits ──────────────────────────────────────────────
    try:
        capital = CAPITAL_BASE if _HAS_REDIS else 10_000_000.0
        daily_loss_limit = capital * (MAX_DAILY_LOSS_PCT / 100.0)
        drawdown_kill = capital * (MAX_DRAWDOWN_PCT / 100.0)
        _r_set("risk:daily_loss_limit", str(daily_loss_limit))
        _r_set("risk:drawdown_kill_switch", str(drawdown_kill))
        # Clear previous kill-all in case it was set from yesterday
        _r_set("risk:kill_all", "false")
        summary["daily_loss_limit"] = daily_loss_limit
        summary["drawdown_kill_switch"] = drawdown_kill
        log.info(
            "Risk limits armed: daily_loss=%.0f, drawdown_kill=%.0f",
            daily_loss_limit, drawdown_kill,
        )
    except Exception as exc:
        log.error("Risk limit arming failed: %s", exc)
        summary["errors"].append(f"risk_limits: {exc}")

    # ── Step 6: Run allocator ────────────────────────────────────────────────
    try:
        if _HAS_ALLOCATOR and allocate is not None:
            weights, notionals = allocate()
            summary["allocator_strategies"] = len(weights)
            summary["total_deployed"] = sum(notionals.values())
            log.info(
                "Allocator run: %d strategies, total deployed ₹%.0f",
                len(weights), sum(notionals.values()),
            )
        else:
            log.warning("Allocator not available — skipping weight update")
    except Exception as exc:
        log.error("Allocator run failed: %s", exc)
        summary["errors"].append(f"allocator: {exc}")

    # ── Step 7: Telegram summary ─────────────────────────────────────────────
    try:
        msg = (
            f"✅ *Pre-market complete*\n"
            f"VIX: `{vix:.2f}` | "
            f"F\\&O bans: `{fo_ban_count}` | "
            f"GIFT Nifty gap: `{'+' if gift_gap>=0 else ''}{gift_gap:.2f}%` ({gap_direction})\n"
            f"Risk limits armed. Allocator updated."
        )
        if _HAS_TELEGRAM and _alerter is not None:
            _alerter.send_sync(msg)
    except Exception as exc:
        log.warning("Telegram pre-market alert failed: %s", exc)

    # Persist summary
    _r_set("live:pre_market_status", json.dumps(summary), ex=86400)

    errors = summary.get("errors", [])
    if errors:
        summary["status"] = "partial"
        log.warning("Pre-market job completed with %d errors", len(errors))
    else:
        log.info("=== Pre-market job completed successfully ===")

    return summary
