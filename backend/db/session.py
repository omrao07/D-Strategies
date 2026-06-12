"""
backend/db/session.py

SQLAlchemy async session factory for TimescaleDB.
Falls back gracefully when asyncpg / sqlalchemy is not installed.
"""
from __future__ import annotations

import logging
import os
from typing import AsyncGenerator

log = logging.getLogger(__name__)

_engine = None
_SessionLocal = None
_HAVE_SA = False

try:
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
    from sqlalchemy.orm import sessionmaker

    _DB_URL = (
        f"postgresql+asyncpg://"
        f"{os.getenv('DB_USER', 'dstrategies')}:"
        f"{os.getenv('DB_PASSWORD', 'dstrategies')}@"
        f"{os.getenv('DB_HOST', 'localhost')}:"
        f"{os.getenv('DB_PORT', '5432')}/"
        f"{os.getenv('DB_NAME', 'dstrategies')}"
    )

    _engine = create_async_engine(
        _DB_URL,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20,
        echo=os.getenv("DB_ECHO", "false").lower() == "true",
    )

    _SessionLocal = sessionmaker(  # type: ignore[call-overload]
        bind=_engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )

    _HAVE_SA = True

except ImportError:
    log.warning("sqlalchemy / asyncpg not installed — DB session unavailable")


async def get_session() -> AsyncGenerator["AsyncSession", None]:  # type: ignore[type-arg]
    if _SessionLocal is None:
        raise RuntimeError("Database session not available (sqlalchemy not installed)")
    async with _SessionLocal() as session:
        yield session


def engine():
    return _engine
