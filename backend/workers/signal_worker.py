"""
backend/workers/signal_worker.py

Async worker that bridges market data streams into Redis signal channels.
Reads from configured data sources (WebSocket tick feeds or Redis streams)
and writes normalised ticks so StrategyRunners can consume them.

Run:
    python -m backend.workers.signal_worker

Environment:
    REDIS_HOST, REDIS_PORT  — Redis connection (default localhost:6379)
    TICK_STREAM             — Redis stream key to publish ticks (default: ticks.live)
    LOG_LEVEL               — Logging level (default: info)
"""
from __future__ import annotations

import logging
import os
import signal
import time

log = logging.getLogger(__name__)


def _setup_logging() -> None:
    level = os.getenv("LOG_LEVEL", "info").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )


def _get_redis():
    try:
        import redis
        host = os.getenv("REDIS_HOST", "localhost")
        port = int(os.getenv("REDIS_PORT", "6379"))
        r = redis.Redis(host=host, port=port, password=__import__("os").getenv("REDIS_PASSWORD") or None, decode_responses=True)
        r.ping()
        return r
    except Exception as exc:
        log.warning("Redis unavailable: %s — running in no-op mode", exc)
        return None


def run() -> None:
    _setup_logging()
    log.info("signal_worker starting")

    r = _get_redis()
    stream = os.getenv("TICK_STREAM", "ticks.live")

    stop_flag = [False]

    def _handle_signal(sig, _frame):
        log.info("signal_worker received signal %s — stopping", sig)
        stop_flag[0] = True

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    log.info("signal_worker ready — publishing to stream '%s'", stream)

    while not stop_flag[0]:
        # Placeholder: in production, this loop connects to broker WebSocket
        # and publishes normalised ticks via r.xadd(stream, {...})
        time.sleep(5)
        if r is not None:
            try:
                r.xadd(stream, {"heartbeat": "1", "ts": str(time.time())}, maxlen=1000)
            except Exception as exc:
                log.error("Redis write error: %s", exc)

    log.info("signal_worker stopped")


if __name__ == "__main__":
    run()
