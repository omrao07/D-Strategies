"""
backend/db/models.py

SQLAlchemy ORM models mirroring the TimescaleDB schema in scripts/db/init.sql.
"""
from __future__ import annotations

try:
    from sqlalchemy import (
        Boolean,
        Column,
        Date,
        DateTime,
        Double,
        Integer,
        Text,
        func,
    )
    from sqlalchemy.dialects.postgresql import JSONB
    from sqlalchemy.orm import DeclarativeBase

    class Base(DeclarativeBase):
        pass

    class Tick(Base):
        __tablename__ = "ticks"
        ts       = Column(DateTime(timezone=True), primary_key=True)
        symbol   = Column(Text, primary_key=True)
        exchange = Column(Text, nullable=False, default="NSE")
        price    = Column(Double, nullable=False)
        volume   = Column(Double, nullable=False, default=0)
        bid      = Column(Double)
        ask      = Column(Double)
        oi       = Column(Double)

    class Bar(Base):
        __tablename__ = "bars"
        ts     = Column(DateTime(timezone=True), primary_key=True)
        symbol = Column(Text, primary_key=True)
        tf     = Column(Text, primary_key=True)
        open   = Column(Double, nullable=False)
        high   = Column(Double, nullable=False)
        low    = Column(Double, nullable=False)
        close  = Column(Double, nullable=False)
        volume = Column(Double, nullable=False, default=0)

    class Position(Base):
        __tablename__ = "positions"
        id           = Column(Integer, primary_key=True, autoincrement=True)
        strategy     = Column(Text, nullable=False)
        symbol       = Column(Text, nullable=False)
        side         = Column(Text, nullable=False)
        qty          = Column(Double, nullable=False)
        avg_price    = Column(Double, nullable=False)
        opened_at    = Column(DateTime(timezone=True), server_default=func.now())
        closed_at    = Column(DateTime(timezone=True))
        realized_pnl = Column(Double, default=0)
        is_paper     = Column(Boolean, nullable=False, default=True)

    class Order(Base):
        __tablename__ = "orders"
        id           = Column(Text, primary_key=True)
        strategy     = Column(Text, nullable=False)
        symbol       = Column(Text, nullable=False)
        side         = Column(Text, nullable=False)
        order_type   = Column(Text, nullable=False, default="market")
        qty          = Column(Double, nullable=False)
        filled_qty   = Column(Double, nullable=False, default=0)
        fill_price   = Column(Double)
        status       = Column(Text, nullable=False, default="open")
        submitted_at = Column(DateTime(timezone=True), server_default=func.now())
        filled_at    = Column(DateTime(timezone=True))
        is_paper     = Column(Boolean, nullable=False, default=True)

    class DailyPnL(Base):
        __tablename__ = "daily_pnl"
        date       = Column(Date, primary_key=True)
        strategy   = Column(Text, primary_key=True)
        realized   = Column(Double, nullable=False, default=0)
        unrealized = Column(Double, nullable=False, default=0)
        commission = Column(Double, nullable=False, default=0)

    class SignalLog(Base):
        __tablename__ = "signal_log"
        ts       = Column(DateTime(timezone=True), primary_key=True, server_default=func.now())
        strategy = Column(Text, primary_key=True)
        score    = Column(Double, nullable=False)
        vol      = Column(Double)
        meta     = Column("metadata", JSONB)

    class RiskEvent(Base):
        __tablename__ = "risk_events"
        ts        = Column(DateTime(timezone=True), primary_key=True, server_default=func.now())
        gate      = Column(Text, primary_key=True)
        triggered = Column(Boolean, nullable=False)
        reason    = Column(Text)
        meta      = Column("metadata", JSONB)

except ImportError:
    # SQLAlchemy not installed — models unavailable, graceful degradation
    Base = None  # type: ignore[assignment]
