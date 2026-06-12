"""Initial schema: ohlcv bars, strategies, fills, positions, audit_log.

Revision ID: 001
Revises:
Create Date: 2026-05-20
"""
from __future__ import annotations

from alembic import op

revision = "001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── ohlcv_bars (TimescaleDB hypertable) ──────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS ohlcv_bars (
            ts          TIMESTAMPTZ     NOT NULL,
            symbol      VARCHAR(32)     NOT NULL,
            freq        VARCHAR(8)      NOT NULL DEFAULT '1d',
            open        DOUBLE PRECISION NOT NULL,
            high        DOUBLE PRECISION NOT NULL,
            low         DOUBLE PRECISION NOT NULL,
            close       DOUBLE PRECISION NOT NULL,
            volume      DOUBLE PRECISION NOT NULL DEFAULT 0,
            source      VARCHAR(32),
            PRIMARY KEY (ts, symbol, freq)
        );
    """)
    # Convert to TimescaleDB hypertable (no-op if TimescaleDB not available)
    op.execute("""
        SELECT create_hypertable('ohlcv_bars', 'ts', if_not_exists => TRUE);
    """)
    op.create_index("ix_ohlcv_symbol_freq", "ohlcv_bars", ["symbol", "freq", "ts"])

    # ── strategies ────────────────────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS strategies (
            id              SERIAL          PRIMARY KEY,
            name            VARCHAR(128)    NOT NULL UNIQUE,
            category        VARCHAR(64),
            region          VARCHAR(32),
            india_compatible BOOLEAN        NOT NULL DEFAULT FALSE,
            enabled         BOOLEAN         NOT NULL DEFAULT TRUE,
            capital_base    DOUBLE PRECISION NOT NULL DEFAULT 100000,
            params          JSONB,
            created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
        );
    """)

    # ── fills ─────────────────────────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS fills (
            id              BIGSERIAL       PRIMARY KEY,
            strategy        VARCHAR(128)    NOT NULL,
            symbol          VARCHAR(32)     NOT NULL,
            side            VARCHAR(4)      NOT NULL,
            qty             DOUBLE PRECISION NOT NULL,
            price           DOUBLE PRECISION NOT NULL,
            notional        DOUBLE PRECISION GENERATED ALWAYS AS (qty * price) STORED,
            commission      DOUBLE PRECISION NOT NULL DEFAULT 0,
            slippage        DOUBLE PRECISION NOT NULL DEFAULT 0,
            ts              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
            order_id        VARCHAR(64),
            fill_id         VARCHAR(64),
            venue           VARCHAR(32),
            paper           BOOLEAN         NOT NULL DEFAULT FALSE
        );
    """)
    op.create_index("ix_fills_strategy_ts", "fills", ["strategy", "ts"])
    op.create_index("ix_fills_symbol_ts", "fills", ["symbol", "ts"])

    # ── positions ─────────────────────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS positions (
            id              BIGSERIAL       PRIMARY KEY,
            strategy        VARCHAR(128)    NOT NULL,
            symbol          VARCHAR(32)     NOT NULL,
            qty             DOUBLE PRECISION NOT NULL DEFAULT 0,
            avg_price       DOUBLE PRECISION NOT NULL DEFAULT 0,
            realized_pnl    DOUBLE PRECISION NOT NULL DEFAULT 0,
            unrealized_pnl  DOUBLE PRECISION NOT NULL DEFAULT 0,
            updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
            UNIQUE (strategy, symbol)
        );
    """)

    # ── daily_pnl ─────────────────────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS daily_pnl (
            id              BIGSERIAL       PRIMARY KEY,
            strategy        VARCHAR(128)    NOT NULL,
            date            DATE            NOT NULL,
            pnl             DOUBLE PRECISION NOT NULL DEFAULT 0,
            n_trades        INT             NOT NULL DEFAULT 0,
            gross_exposure  DOUBLE PRECISION,
            UNIQUE (strategy, date)
        );
    """)
    op.create_index("ix_daily_pnl_date", "daily_pnl", ["date"])

    # ── audit_log (compliance + Merkle) ───────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS audit_log (
            id              BIGSERIAL       PRIMARY KEY,
            event_type      VARCHAR(64)     NOT NULL,
            payload         JSONB           NOT NULL,
            hash            CHAR(64)        NOT NULL,
            prev_hash       CHAR(64),
            seq             BIGINT          NOT NULL UNIQUE,
            ts              TIMESTAMPTZ     NOT NULL DEFAULT NOW()
        );
    """)
    op.create_index("ix_audit_log_event_ts", "audit_log", ["event_type", "ts"])

    # ── regime_history ────────────────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS regime_history (
            id              BIGSERIAL       PRIMARY KEY,
            regime          VARCHAR(16)     NOT NULL,
            confidence      DOUBLE PRECISION,
            ts              TIMESTAMPTZ     NOT NULL DEFAULT NOW()
        );
    """)


def downgrade() -> None:
    for table in [
        "regime_history", "audit_log", "daily_pnl",
        "positions", "fills", "strategies", "ohlcv_bars",
    ]:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE;")
