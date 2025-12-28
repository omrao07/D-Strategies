# self_heal/watchdogs.py
"""
Watchdog Supervisor
-------------------

Pure, dependency-free watchdog framework.

Designed to:
- Monitor long-running tasks
- Detect stalls / deadlocks
- Restart or escalate on failure
- Integrate cleanly with failover + healthcheck modules

No async, no external libs, safe everywhere.
"""

from typing import Callable, Dict, Optional
import time
import threading


# ─────────────────────────────────────────────────────────────
# Errors
# ─────────────────────────────────────────────────────────────

class WatchdogError(RuntimeError):
    pass


# ─────────────────────────────────────────────────────────────
# Watchdog Task
# ─────────────────────────────────────────────────────────────

class Watchdog:
    """
    Monitors heartbeat activity of a component.
    """

    def __init__(
        self,
        name: str,
        timeout: float,
        on_timeout: Callable[[str], None],
    ):
        self.name = name
        self.timeout = timeout
        self.on_timeout = on_timeout

        self.last_heartbeat: float = time.time()
        self.triggered: bool = False

    # ─────────────────────────────────────────────────────────

    def heartbeat(self) -> None:
        """Signal liveness."""
        self.last_heartbeat = time.time()
        self.triggered = False

    # ─────────────────────────────────────────────────────────

    def check(self) -> None:
        """Check for timeout."""
        if self.triggered:
            return

        now = time.time()
        if now - self.last_heartbeat > self.timeout:
            self.triggered = True
            try:
                self.on_timeout(self.name)
            except Exception:
                pass


# ─────────────────────────────────────────────────────────────
# Watchdog Manager
# ─────────────────────────────────────────────────────────────

class WatchdogManager:
    """
    Supervises multiple watchdogs in a background loop.
    """

    def __init__(self, interval: float = 1.0):
        self.interval = interval
        self.watchdogs: Dict[str, Watchdog] = {}
        self._stop = False
        self._thread: Optional[threading.Thread] = None

    # ─────────────────────────────────────────────────────────

    def register(self, watchdog: Watchdog) -> None:
        self.watchdogs[watchdog.name] = watchdog

    # ─────────────────────────────────────────────────────────

    def heartbeat(self, name: str) -> None:
        wd = self.watchdogs.get(name)
        if wd:
            wd.heartbeat()

    # ─────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._thread is not None:
            return

        self._thread = threading.Thread(
            target=self._loop,
            daemon=True,
        )
        self._thread.start()

    # ─────────────────────────────────────────────────────────

    def stop(self) -> None:
        self._stop = True
        if self._thread:
            self._thread.join(timeout=1)

    # ─────────────────────────────────────────────────────────

    def _loop(self) -> None:
        while not self._stop:
            time.sleep(self.interval)
            for wd in list(self.watchdogs.values()):
                wd.check()


# ─────────────────────────────────────────────────────────────
# Example (commented)
# ─────────────────────────────────────────────────────────────
#
# def restart_service(name):
#     print(f"[WATCHDOG] Restarting {name}")
#
# mgr = WatchdogManager(interval=2.0)
#
# worker = Watchdog(
#     name="data-feed",
#     timeout=5.0,
#     on_timeout=restart_service,
# )
#
# mgr.register(worker)
# mgr.start()
#
# while True:
#     mgr.heartbeat("data-feed")
#     time.sleep(1)
# # ...
# mgr.stop()
# --- IGNORE ---