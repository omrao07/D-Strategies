# backend/live/health_monitor.py
"""
Health monitor: periodically checks Redis connectivity, stream lag, and
engine heartbeat. Publishes alerts to Redis pub/sub and logs.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Dict, Optional

import redis

logger = logging.getLogger("live.health_monitor")

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
HEARTBEAT_KEY = "engine:heartbeat"
HEALTH_CHANNEL = "engine:health"
HEARTBEAT_TTL = 30  # seconds
CHECK_INTERVAL = 10  # seconds
MAX_STREAM_LAG = 10_000  # entries

_r: Optional[redis.Redis] = None

def _get_r() -> redis.Redis:
    global _r
    if _r is None:
        _r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT,
                         password=os.getenv("REDIS_PASSWORD") or None,
                         decode_responses=True)
    return _r


def beat(r=None) -> None:
    """Call every loop iteration to register liveness."""
    rc = r or _get_r()
    rc.set(HEARTBEAT_KEY, str(time.time()), ex=HEARTBEAT_TTL)


def _check_redis(r) -> Dict:
    try:
        r.ping()
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error", "detail": str(e)}


def _check_heartbeat(r) -> Dict:
    val = r.get(HEARTBEAT_KEY)
    if val is None:
        return {"status": "stale", "detail": "no heartbeat"}
    age = time.time() - float(val)
    if age > HEARTBEAT_TTL:
        return {"status": "stale", "age_s": round(age, 1)}
    return {"status": "ok", "age_s": round(age, 1)}


def _check_stream_lag(stream: str, r) -> Dict:
    try:
        length = r.xlen(stream)
        status = "ok" if length < MAX_STREAM_LAG else "lagging"
        return {"status": status, "length": length}
    except Exception as e:
        return {"status": "error", "detail": str(e)}


def run_health_check(streams: list[str] = None, r=None) -> Dict:
    rc = r or _get_r()
    report = {
        "ts": time.time(),
        "redis": _check_redis(rc),
        "heartbeat": _check_heartbeat(rc),
    }
    if streams:
        report["streams"] = {s: _check_stream_lag(s, rc) for s in streams}

    overall = "ok" if all(
        v.get("status") == "ok"
        for k, v in report.items()
        if isinstance(v, dict) and "status" in v
    ) else "degraded"
    report["overall"] = overall

    if overall != "ok":
        try:
            rc.publish(HEALTH_CHANNEL, json.dumps(report))
        except Exception:
            pass
        logger.warning(f"[health_monitor] degraded: {report}")
    else:
        logger.debug("[health_monitor] ok")
    return report


class HealthMonitor:
    def __init__(self, streams: list[str] = None, interval: int = CHECK_INTERVAL):
        self._streams = streams or []
        self._interval = interval
        self._thread: Optional[threading.Thread] = None
        self._running = False

    def start(self) -> None:
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        logger.info("[health_monitor] started")

    def stop(self) -> None:
        self._running = False

    def _loop(self) -> None:
        while self._running:
            try:
                run_health_check(self._streams)
            except Exception as e:
                logger.error(f"[health_monitor] check failed: {e}")
            time.sleep(self._interval)
