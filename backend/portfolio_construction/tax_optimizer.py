# backend/portfolio_construction/tax_optimizer.py
"""
Tax-aware trade optimizer.
India: STCG (15%), LTCG (10% > ₹1L), STT deduction.
US: wash-sale rule, short/long-term capital gains.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import List

# ── India ────────────────────────────────────────────────────────────────────

INDIA_STCG_RATE = 0.15       # <12 months
INDIA_LTCG_RATE = 0.10       # ≥12 months, above ₹1L exemption
INDIA_LTCG_EXEMPTION = 100_000.0  # INR
INDIA_STT_EQUITY_DELIVERY = 0.001   # 0.1% on sell
INDIA_STT_EQUITY_INTRADAY = 0.00025  # 0.025% on sell
INDIA_STT_FO_SELL = 0.0005  # 0.05% on sell premium (options)


def india_tax_on_gain(
    gain_inr: float,
    holding_days: int,
    is_intraday: bool = False,
) -> float:
    """Estimate Indian capital gains tax on a realized gain."""
    if is_intraday or holding_days < 365:
        return gain_inr * INDIA_STCG_RATE
    # LTCG: 10% on amount above ₹1L
    taxable = max(0.0, gain_inr - INDIA_LTCG_EXEMPTION)
    return taxable * INDIA_LTCG_RATE


def india_stt(
    notional: float,
    is_intraday: bool = False,
    is_fo: bool = False,
) -> float:
    if is_fo:
        return notional * INDIA_STT_FO_SELL
    if is_intraday:
        return notional * INDIA_STT_EQUITY_INTRADAY
    return notional * INDIA_STT_EQUITY_DELIVERY


def india_net_gain(
    gain_inr: float,
    notional: float,
    holding_days: int,
    is_intraday: bool = False,
) -> float:
    tax = india_tax_on_gain(gain_inr, holding_days, is_intraday)
    stt = india_stt(notional, is_intraday)
    return gain_inr - tax - stt


# ── US ───────────────────────────────────────────────────────────────────────

US_SHORT_TERM_RATE = 0.37    # ordinary income (top bracket)
US_LONG_TERM_RATE = 0.20     # LTCG (top bracket)
WASH_SALE_WINDOW_DAYS = 30


def us_tax_on_gain(gain_usd: float, holding_days: int) -> float:
    if holding_days < 365:
        return gain_usd * US_SHORT_TERM_RATE
    return gain_usd * US_LONG_TERM_RATE


@dataclass
class TradeRecord:
    symbol: str
    buy_date: date
    sell_date: date
    gain_usd: float


def is_wash_sale(
    symbol: str,
    sell_date: date,
    prior_trades: List[TradeRecord],
) -> bool:
    """
    True if any prior trade in the same symbol sold at a loss within 30 days
    before or after sell_date (simplified).
    """
    window_start = sell_date - timedelta(days=WASH_SALE_WINDOW_DAYS)
    window_end = sell_date + timedelta(days=WASH_SALE_WINDOW_DAYS)
    for t in prior_trades:
        if t.symbol == symbol and t.gain_usd < 0:
            if window_start <= t.sell_date <= window_end:
                return True
    return False


def us_net_gain(
    gain_usd: float,
    holding_days: int,
    is_wash_sale_: bool = False,
) -> float:
    """Net gain after US tax. Wash-sale losses are disallowed."""
    if is_wash_sale_ and gain_usd < 0:
        return 0.0  # loss disallowed
    return gain_usd - us_tax_on_gain(max(0, gain_usd), holding_days)
