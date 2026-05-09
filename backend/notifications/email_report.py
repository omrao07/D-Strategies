# backend/notifications/email_report.py
"""
Email report sender via SMTP (supports Gmail/Outlook/any SMTP relay).
Requires: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, REPORT_TO env vars.
"""
from __future__ import annotations

import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import List, Optional

log = logging.getLogger(__name__)

SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
REPORT_TO = os.getenv("REPORT_TO", "")


def send_email(
    subject: str,
    body_html: str,
    to: Optional[List[str]] = None,
    from_addr: Optional[str] = None,
    smtp_host: Optional[str] = None,
    smtp_port: Optional[int] = None,
    smtp_user: Optional[str] = None,
    smtp_pass: Optional[str] = None,
) -> bool:
    """
    Send an HTML email report. Returns True on success.
    Falls back to env vars if params not supplied.
    """
    host = smtp_host or SMTP_HOST
    port = smtp_port or SMTP_PORT
    user = smtp_user or SMTP_USER
    pwd = smtp_pass or SMTP_PASS
    sender = from_addr or user
    recipients = to or ([REPORT_TO] if REPORT_TO else [])

    if not (host and user and pwd and recipients):
        log.debug("Email not configured; skipping send.")
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)
    msg.attach(MIMEText(body_html, "html"))

    try:
        with smtplib.SMTP(host, port, timeout=15) as server:
            server.ehlo()
            server.starttls()
            server.login(user, pwd)
            server.sendmail(sender, recipients, msg.as_string())
        return True
    except Exception as exc:
        log.warning("Email send failed: %s", exc)
        return False


def daily_pnl_report_html(
    date: str,
    strategies: dict,
    total_pnl: float,
    drawdown: float,
) -> str:
    rows = "".join(
        f"<tr><td>{k}</td><td>{v.get('pnl', 0):.2f}</td><td>{v.get('signal', 0):.2f}</td></tr>"
        for k, v in strategies.items()
    )
    color = "green" if total_pnl >= 0 else "red"
    return f"""
    <html><body>
    <h2>Daily P&L Report — {date}</h2>
    <p>Total P&L: <b style="color:{color}">${total_pnl:,.2f}</b> | Drawdown: {drawdown:.1%}</p>
    <table border="1" cellpadding="4">
    <tr><th>Strategy</th><th>P&L ($)</th><th>Signal</th></tr>
    {rows}
    </table>
    </body></html>
    """
