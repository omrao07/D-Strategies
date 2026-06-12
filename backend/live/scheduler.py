# backend/live/scheduler.py
"""
Full trading scheduler: pre-market, intraday, EOD, nightly, weekly, monthly jobs.
Each job is a callable registered with a schedule slot.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from datetime import time as dtime
from typing import Callable, List, Optional

logger = logging.getLogger("live.scheduler")

# IST offset from UTC (UTC+5:30)
IST_OFFSET_SECONDS = 19800


def _now_ist() -> datetime:
    ts = time.time() + IST_OFFSET_SECONDS
    return datetime.utcfromtimestamp(ts)


@dataclass
class ScheduledJob:
    name: str
    fn: Callable
    # one of: pre_market | intraday | eod | nightly | weekly | monthly
    slot: str
    # For intraday: run every `interval_s` seconds between market open/close
    interval_s: Optional[int] = None
    last_run: Optional[datetime] = None
    enabled: bool = True


class TradingScheduler:
    """
    Scheduler that fires jobs based on IST market hours.
    NSE hours: 09:15–15:30.
    """

    PRE_MARKET_START = dtime(8, 30)
    MARKET_OPEN = dtime(9, 15)
    MARKET_CLOSE = dtime(15, 30)
    EOD_START = dtime(15, 35)
    NIGHTLY_START = dtime(22, 0)

    def __init__(self):
        self._jobs: List[ScheduledJob] = []
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def register(self, name: str, fn: Callable, slot: str, interval_s: int = 60) -> None:
        self._jobs.append(ScheduledJob(name=name, fn=fn, slot=slot, interval_s=interval_s))
        logger.info(f"[scheduler] registered job={name} slot={slot}")

    def start(self) -> None:
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        logger.info("[scheduler] started")

    def stop(self) -> None:
        self._running = False
        logger.info("[scheduler] stopped")

    def _loop(self) -> None:
        while self._running:
            now = _now_ist()
            t = now.time()
            weekday = now.weekday()  # Mon=0, Fri=4
            is_trading_day = weekday < 5

            for job in self._jobs:
                if not job.enabled:
                    continue
                try:
                    self._maybe_fire(job, now, t, is_trading_day)
                except Exception as e:
                    logger.exception(f"[scheduler] job={job.name} error: {e}")

            time.sleep(1)

    def _maybe_fire(self, job: ScheduledJob, now: datetime, t: dtime, is_trading_day: bool) -> None:
        if job.slot == "pre_market":
            if is_trading_day and self.PRE_MARKET_START <= t < self.MARKET_OPEN:
                self._fire_once_per_day(job, now)

        elif job.slot == "intraday":
            if is_trading_day and self.MARKET_OPEN <= t < self.MARKET_CLOSE:
                self._fire_on_interval(job, now)

        elif job.slot == "eod":
            if is_trading_day and self.EOD_START <= t < dtime(16, 0):
                self._fire_once_per_day(job, now)

        elif job.slot == "nightly":
            if t >= self.NIGHTLY_START or t < dtime(1, 0):
                self._fire_once_per_day(job, now)

        elif job.slot == "weekly":
            if now.weekday() == 4 and t >= self.NIGHTLY_START:
                self._fire_once_per_day(job, now)

        elif job.slot == "monthly":
            if now.day == 1 and t >= self.NIGHTLY_START:
                self._fire_once_per_day(job, now)

    def _fire_once_per_day(self, job: ScheduledJob, now: datetime) -> None:
        if job.last_run is None or job.last_run.date() < now.date():
            job.fn()
            job.last_run = now
            logger.info(f"[scheduler] fired job={job.name} slot={job.slot}")

    def _fire_on_interval(self, job: ScheduledJob, now: datetime) -> None:
        interval = job.interval_s or 60
        if job.last_run is None or (now - job.last_run).total_seconds() >= interval:
            job.fn()
            job.last_run = now


# Module-level singleton
_scheduler = TradingScheduler()

def get_scheduler() -> TradingScheduler:
    return _scheduler
