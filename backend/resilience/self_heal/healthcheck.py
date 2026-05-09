# self_heal/healthcheck.py
"""
Health Check Utilities
----------------------

Pure, dependency-free health check framework.

Designed for:
- Services
- Brokers
- Data feeds
- Execution engines
- Background workers

Safe to import anywhere. No threads, no async, no side effects.
"""

from typing import Callable, Dict, Optional
import time


# ─────────────────────────────────────────────────────────────
# Types
# ─────────────────────────────────────────────────────────────

HealthFn = Callable[[], bool]


# ─────────────────────────────────────────────────────────────
# Health Check
# ─────────────────────────────────────────────────────────────

class HealthCheck:
    """
    Wraps a health check callable with timing and failure tracking.
    """

    def __init__(
        self,
        name: str,
        check: HealthFn,
        timeout: float = 2.0,
        max_failures: int = 3,
    ):
        self.name = name
        self.check = check
        self.timeout = timeout
        self.max_failures = max_failures

        self.last_ok: Optional[float] = None
        self.last_fail: Optional[float] = None
        self.failures: int = 0

    # ─────────────────────────────────────────────────────────

    def run(self) -> bool:
        start = time.time()
        ok = False

        try:
            ok = bool(self.check())
        except Exception:
            ok = False

        elapsed = time.time() - start

        if elapsed > self.timeout:
            ok = False

        if ok:
            self.last_ok = time.time()
            self.failures = 0
        else:
            self.last_fail = time.time()
            self.failures += 1

        return ok

    # ─────────────────────────────────────────────────────────

    def healthy(self) -> bool:
        return self.failures < self.max_failures


# ─────────────────────────────────────────────────────────────
# Registry
# ─────────────────────────────────────────────────────────────

class HealthRegistry:
    """
    Registry for multiple health checks.
    """

    def __init__(self):
        self.checks: Dict[str, HealthCheck] = {}

    # ─────────────────────────────────────────────────────────

    def register(self, check: HealthCheck) -> None:
        self.checks[check.name] = check

    # ─────────────────────────────────────────────────────────

    def run_all(self) -> Dict[str, bool]:
        results: Dict[str, bool] = {}
        for name, hc in self.checks.items():
            results[name] = hc.run()
        return results

    # ─────────────────────────────────────────────────────────

    def status(self) -> Dict[str, Dict[str, Optional[float]]]:
        """
        Returns detailed health status.
        """
        out: Dict[str, Dict[str, Optional[float]]] = {}
        for name, hc in self.checks.items():
            out[name] = {
                "healthy": hc.healthy(),
                "failures": hc.failures,
                "last_ok": hc.last_ok,
                "last_fail": hc.last_fail,
            }
        return out


# ─────────────────────────────────────────────────────────────
# Convenience helpers
# ─────────────────────────────────────────────────────────────

def simple_healthcheck(fn: HealthFn, name: str) -> HealthCheck:
    """
    Quick wrapper for simple health checks.
    """
    return HealthCheck(name=name, check=fn)


# ─────────────────────────────────────────────────────────────
# Example (commented)
# ─────────────────────────────────────────────────────────────
#
# registry = HealthRegistry()
#
# registry.register(
#     HealthCheck(
#         name="broker",
#         check=lambda: ping_broker(),
#         timeout=1.0,
#     )
# )
#
# registry.register(
#     simple_healthcheck(lambda: True, "always_ok")
# )
#
# print(registry.run_all())
# print(registry.status())
# # --- IGNORE ---
# # publish_stream("health", registry.status())  # publish health status    