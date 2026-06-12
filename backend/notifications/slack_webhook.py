# backend/notifications/slack_webhook.py
"""Slack webhook notifications for alerts, fills, and daily summaries."""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional
from urllib.error import URLError
from urllib.request import Request, urlopen

logger = logging.getLogger("notifications.slack")

SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "")
SLACK_CHANNEL = os.getenv("SLACK_CHANNEL", "#trading-alerts")
SLACK_USERNAME = os.getenv("SLACK_USERNAME", "D-Strategies Bot")
SLACK_ICON = os.getenv("SLACK_ICON_EMOJI", ":chart_with_upwards_trend:")


def _post(payload: Dict[str, Any], webhook_url: str = "") -> bool:
    url = webhook_url or SLACK_WEBHOOK_URL
    if not url:
        logger.debug("[slack] no webhook URL configured — skipping")
        return False
    body = json.dumps(payload).encode("utf-8")
    req = Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except URLError as e:
        logger.warning(f"[slack] post failed: {e}")
        return False


def send_message(
    text: str,
    channel: Optional[str] = None,
    webhook_url: str = "",
) -> bool:
    return _post({
        "channel": channel or SLACK_CHANNEL,
        "username": SLACK_USERNAME,
        "icon_emoji": SLACK_ICON,
        "text": text,
    }, webhook_url)


def send_fill_alert(fill: Dict[str, Any], webhook_url: str = "") -> bool:
    side_emoji = ":green_circle:" if fill.get("side") == "buy" else ":red_circle:"
    text = (
        f"{side_emoji} *FILL* | `{fill.get('symbol')}` "
        f"{fill.get('side', '').upper()} {fill.get('qty')} @ {fill.get('price')} "
        f"| strategy=`{fill.get('strategy')}`"
    )
    return send_message(text, webhook_url=webhook_url)


def send_risk_alert(reason: str, order: Dict[str, Any], webhook_url: str = "") -> bool:
    text = (
        f":warning: *RISK BLOCK* | `{order.get('symbol')}` "
        f"reason=`{reason}` strategy=`{order.get('strategy')}`"
    )
    return send_message(text, webhook_url=webhook_url)


def send_daily_summary(pnl: float, trades: int, top_strategy: str, webhook_url: str = "") -> bool:
    emoji = ":white_check_mark:" if pnl >= 0 else ":x:"
    text = (
        f"{emoji} *Daily Summary* | PnL: `{pnl:+.2f}` | "
        f"Trades: `{trades}` | Top: `{top_strategy}`"
    )
    return send_message(text, webhook_url=webhook_url)


def send_regime_change(old: str, new: str, confidence: float, webhook_url: str = "") -> bool:
    text = (
        f":rotating_light: *REGIME CHANGE* | `{old}` → `{new}` "
        f"(confidence={confidence:.0%})"
    )
    return send_message(text, webhook_url=webhook_url)
