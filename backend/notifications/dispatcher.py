# backend/notifications/dispatcher.py
"""
Unified notification dispatcher — routes alerts to Telegram, email, or Slack
based on severity and configuration.
"""
from __future__ import annotations

import logging
import os
from typing import List, Literal, Optional

from .telegram import send_telegram, format_alert
from .email_report import send_email

log = logging.getLogger(__name__)

Level = Literal["INFO", "WARNING", "CRITICAL", "OK"]

SLACK_WEBHOOK = os.getenv("SLACK_WEBHOOK_URL", "")


def _send_slack(message: str) -> bool:
    if not SLACK_WEBHOOK:
        return False
    import json
    import urllib.request
    payload = json.dumps({"text": message}).encode("utf-8")
    try:
        req = urllib.request.Request(
            SLACK_WEBHOOK,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception as exc:
        log.warning("Slack send failed: %s", exc)
        return False


class NotificationDispatcher:
    """
    Route notifications to configured channels.

    Channels enabled via env:
      TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID → Telegram
      SMTP_USER + SMTP_PASS + REPORT_TO       → Email
      SLACK_WEBHOOK_URL                       → Slack
    """

    def __init__(
        self,
        telegram: bool = True,
        email: bool = True,
        slack: bool = True,
        min_level_telegram: Level = "WARNING",
        min_level_email: Level = "CRITICAL",
        min_level_slack: Level = "WARNING",
    ):
        self.use_telegram = telegram
        self.use_email = email
        self.use_slack = slack
        self._level_order = {"INFO": 0, "OK": 0, "WARNING": 1, "CRITICAL": 2}
        self.min_telegram = self._level_order.get(min_level_telegram.upper(), 1)
        self.min_email = self._level_order.get(min_level_email.upper(), 2)
        self.min_slack = self._level_order.get(min_level_slack.upper(), 1)

    def send(
        self,
        title: str,
        body: str,
        level: Level = "INFO",
        email_subject: Optional[str] = None,
        email_html: Optional[str] = None,
    ) -> None:
        lvl = self._level_order.get(level.upper(), 0)
        msg = format_alert(title, body, level)

        if self.use_telegram and lvl >= self.min_telegram:
            send_telegram(msg)

        if self.use_slack and lvl >= self.min_slack:
            _send_slack(f"[{level}] {title}: {body}")

        if self.use_email and lvl >= self.min_email:
            subj = email_subject or f"[{level}] {title}"
            html = email_html or f"<html><body><h3>{title}</h3><p>{body}</p></body></html>"
            send_email(subject=subj, body_html=html)

    def alert_risk_gate(self, gate_name: str, reason: str) -> None:
        self.send(
            title=f"Risk Gate Triggered: {gate_name}",
            body=reason,
            level="CRITICAL",
        )

    def alert_strategy_error(self, strategy: str, error: str) -> None:
        self.send(
            title=f"Strategy Error: {strategy}",
            body=error,
            level="WARNING",
        )

    def daily_summary(
        self, date: str, total_pnl: float, strategies: dict, drawdown: float
    ) -> None:
        body = f"P&L: ${total_pnl:,.2f} | DD: {drawdown:.1%} | {len(strategies)} strategies"
        level: Level = "OK" if total_pnl >= 0 else "WARNING"
        self.send(
            title=f"Daily Summary {date}",
            body=body,
            level=level,
        )
