# backend/notifications/telegram.py
"""
Telegram bot notification channel.
Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.request
from typing import Optional

log = logging.getLogger(__name__)

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

_BASE_URL = "https://api.telegram.org/bot{token}/sendMessage"


def send_telegram(
    message: str,
    chat_id: Optional[str] = None,
    token: Optional[str] = None,
    parse_mode: str = "HTML",
) -> bool:
    """
    Send a message via Telegram Bot API.
    Returns True on success, False on failure.
    """
    bot_token = token or TELEGRAM_BOT_TOKEN
    cid = chat_id or TELEGRAM_CHAT_ID

    if not bot_token or not cid:
        log.debug("Telegram not configured (missing token or chat_id)")
        return False

    url = _BASE_URL.format(token=bot_token)
    payload = json.dumps({
        "chat_id": cid,
        "text": str(message)[:4096],
        "parse_mode": parse_mode,
        "disable_web_page_preview": True,
    }).encode("utf-8")

    try:
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception as exc:
        log.warning("Telegram send failed: %s", exc)
        return False


def format_alert(
    title: str,
    body: str,
    level: str = "INFO",
) -> str:
    icons = {"INFO": "ℹ️", "WARNING": "⚠️", "CRITICAL": "🚨", "OK": "✅"}
    icon = icons.get(level.upper(), "📢")
    return f"{icon} <b>{title}</b>\n{body}"
