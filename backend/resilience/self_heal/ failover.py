"""
Failover & Self-Healing Engine
------------------------------

Generic failover controller for:
- Brokers
- Data feeds
- Execution engines
- Strategy services

No external dependencies.
"""

from typing import Callable, Dict, List, Optional
import time
import threading


# ─────────────────────────────────────────────────────────────
# Errors
# ─────────────────────────────────────────────────────────────

class FailoverError(RuntimeError):
    pass


# ─────────────────────────────────────────────────────────────
# Target definition
# ─────────────────────────────────────────────────────────────

class FailoverTarget:
    """
    Represents a single failover target (primary or backup).
    """

    def __init__(
        self,
        name: str,
        health_check: Callable[[], bool],
        activate: Callable[[], None],
        deactivate: Optional[Callable[[], None]] = None,
    ):
        self.name = name
        self.health_check = health_check
        self.activate = activate
        self.deactivate = deactivate
        self.failed = False


# ─────────────────────────────────────────────────────────────
# Failover Manager
# ─────────────────────────────────────────────────────────────

class FailoverManager:
    """
    Monitors targets and switches automatically on failure.
    """

    def __init__(
        self,
        targets: List[FailoverTarget],
        check_interval: float = 5.0,
        max_failures: int = 3,
        auto_recover: bool = True,
    ):
        if not targets:
            raise FailoverError("At least one failover target is required")

        self.targets = targets
        self.check_interval = check_interval
        self.max_failures = max_failures
        self.auto_recover = auto_recover

        self.active_index = 0
        self.fail_counts: Dict[str, int] = {t.name: 0 for t in targets}
        self._stop = False
        self._thread: Optional[threading.Thread] = None

        # Activate primary
        self.targets[0].activate()

    # ─────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start background monitoring."""
        if self._thread is not None:
            return

        self._thread = threading.Thread(
            target=self._monitor_loop,
            daemon=True,
        )
        self._thread.start()

    # ─────────────────────────────────────────────────────────

    def stop(self) -> None:
        """Stop background monitoring."""
        self._stop = True
        if self._thread:
            self._thread.join(timeout=1)

    # ─────────────────────────────────────────────────────────

    def current(self) -> FailoverTarget:
        """Return active target."""
        return self.targets[self.active_index]

    # ─────────────────────────────────────────────────────────

    def _monitor_loop(self) -> None:
        while not self._stop:
            time.sleep(self.check_interval)
            self._check_active()

    # ─────────────────────────────────────────────────────────

    def _check_active(self) -> None:
        active = self.current()

        try:
            healthy = active.health_check()
        except Exception:
            healthy = False

        if healthy:
            self.fail_counts[active.name] = 0
            return

        self.fail_counts[active.name] += 1

        if self.fail_counts[active.name] < self.max_failures:
            return

        self._failover()

    # ─────────────────────────────────────────────────────────

    def _failover(self) -> None:
        old = self.current()

        if old.deactivate:
            try:
                old.deactivate()
            except Exception:
                pass

        for i, t in enumerate(self.targets):
            if i == self.active_index:
                continue

            try:
                if t.health_check():
                    t.activate()
                    self.active_index = i
                    self.fail_counts[t.name] = 0
                    return
            except Exception:
                continue

        raise FailoverError("All failover targets are unhealthy")


# ─────────────────────────────────────────────────────────────
# Example (commented)
# ─────────────────────────────────────────────────────────────
#
# primary = FailoverTarget(
#     name="primary-broker",
#     health_check=lambda: ping_broker(),
#     activate=lambda: connect_primary(),
#     deactivate=lambda: disconnect_primary(),
# )
#
# backup = FailoverTarget(
#     name="backup-broker",
#     health_check=lambda: ping_backup(),
#     activate=lambda: connect_backup(),
# )
#
# mgr = FailoverManager([primary, backup])
# mgr.start()
# # ...
# mgr.stop()    