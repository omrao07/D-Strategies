-- D-Strategies TimescaleDB schema bootstrap
-- Runs once on first container start (idempotent).

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ── Market ticks ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticks (
    ts          TIMESTAMPTZ     NOT NULL,
    symbol      TEXT            NOT NULL,
    exchange    TEXT            NOT NULL DEFAULT 'NSE',
    price       DOUBLE PRECISION NOT NULL,
    volume      DOUBLE PRECISION NOT NULL DEFAULT 0,
    bid         DOUBLE PRECISION,
    ask         DOUBLE PRECISION,
    oi          DOUBLE PRECISION   -- open interest (F&O)
);

SELECT create_hypertable('ticks', 'ts', if_not_exists => TRUE,
       chunk_time_interval => INTERVAL '1 day');

CREATE INDEX IF NOT EXISTS ticks_symbol_ts ON ticks (symbol, ts DESC);

-- ── OHLCV bars ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bars (
    ts          TIMESTAMPTZ     NOT NULL,
    symbol      TEXT            NOT NULL,
    tf          TEXT            NOT NULL,   -- '1m','5m','15m','1h','1d'
    open        DOUBLE PRECISION NOT NULL,
    high        DOUBLE PRECISION NOT NULL,
    low         DOUBLE PRECISION NOT NULL,
    close       DOUBLE PRECISION NOT NULL,
    volume      DOUBLE PRECISION NOT NULL DEFAULT 0
);

SELECT create_hypertable('bars', 'ts', if_not_exists => TRUE,
       chunk_time_interval => INTERVAL '7 days');

CREATE UNIQUE INDEX IF NOT EXISTS bars_symbol_tf_ts ON bars (symbol, tf, ts DESC);

-- ── Positions ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS positions (
    id          SERIAL PRIMARY KEY,
    strategy    TEXT            NOT NULL,
    symbol      TEXT            NOT NULL,
    side        TEXT            NOT NULL CHECK (side IN ('long', 'short')),
    qty         DOUBLE PRECISION NOT NULL,
    avg_price   DOUBLE PRECISION NOT NULL,
    opened_at   TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    closed_at   TIMESTAMPTZ,
    realized_pnl DOUBLE PRECISION DEFAULT 0,
    is_paper    BOOLEAN         NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS positions_strategy_symbol ON positions (strategy, symbol);

-- ── Orders ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
    id          TEXT PRIMARY KEY,
    strategy    TEXT            NOT NULL,
    symbol      TEXT            NOT NULL,
    side        TEXT            NOT NULL,
    order_type  TEXT            NOT NULL DEFAULT 'market',
    qty         DOUBLE PRECISION NOT NULL,
    filled_qty  DOUBLE PRECISION NOT NULL DEFAULT 0,
    fill_price  DOUBLE PRECISION,
    status      TEXT            NOT NULL DEFAULT 'open',
    submitted_at TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    filled_at   TIMESTAMPTZ,
    is_paper    BOOLEAN         NOT NULL DEFAULT TRUE
);

-- ── Daily P&L snapshots ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_pnl (
    date        DATE            NOT NULL,
    strategy    TEXT            NOT NULL,
    realized    DOUBLE PRECISION NOT NULL DEFAULT 0,
    unrealized  DOUBLE PRECISION NOT NULL DEFAULT 0,
    commission  DOUBLE PRECISION NOT NULL DEFAULT 0,
    PRIMARY KEY (date, strategy)
);

-- ── Signal audit log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signal_log (
    ts          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    strategy    TEXT            NOT NULL,
    score       DOUBLE PRECISION NOT NULL,
    vol         DOUBLE PRECISION,
    metadata    JSONB
);

SELECT create_hypertable('signal_log', 'ts', if_not_exists => TRUE,
       chunk_time_interval => INTERVAL '7 days');

-- ── Risk gate events ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS risk_events (
    ts          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    gate        TEXT            NOT NULL,
    triggered   BOOLEAN         NOT NULL,
    reason      TEXT,
    metadata    JSONB
);

SELECT create_hypertable('risk_events', 'ts', if_not_exists => TRUE,
       chunk_time_interval => INTERVAL '30 days');

-- ── SEBI OTR compliance alerts ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_otr_alerts (
    id          BIGSERIAL,
    ts_ms       BIGINT          NOT NULL,
    window_ms   INTEGER         NOT NULL,
    bucket      JSONB,
    orders      INTEGER,
    trades      INTEGER,
    otr         NUMERIC(10, 4),
    slab        NUMERIC(10, 4),
    UNIQUE (ts_ms, window_ms, bucket)
);
CREATE INDEX IF NOT EXISTS idx_compliance_otr_ts ON compliance_otr_alerts (ts_ms DESC);

-- Compression policy: compress ticks older than 7 days
SELECT add_compression_policy('ticks', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_compression_policy('bars',  INTERVAL '30 days', if_not_exists => TRUE);
