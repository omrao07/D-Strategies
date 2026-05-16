# backend/adapters/latency_adapter.py
"""
Latency simulation adapter.

Resolves per-call latency from a config dict using priority:
  path override (adapter+venue) → venue override → defaults

Applies jitter and optional burst-mode spike via stdlib random,
so callers can monkeypatch random.uniform / random.random for tests.
"""
from __future__ import annotations

import random
import time
from typing import Any, Dict, Optional


class LatencyModel:

    def __init__(self, config: Dict[str, Any]):
        self._cfg = config

    def simulate(
        self,
        adapter: str,
        venue: str,
        phase: str = "order_send",
    ) -> float:
        """Sleep for the resolved latency and return the elapsed milliseconds."""
        cfg = self._cfg
        defaults: Dict[str, Any] = cfg.get("defaults", {})

        # 1. Path override (adapter + venue specific)
        base_ms: Optional[float] = None
        for path in cfg.get("paths", []):
            if path.get("adapter") == adapter and path.get("venue") == venue:
                if phase in path:
                    base_ms = float(path[phase])
                    break

        # 2. Venue override
        if base_ms is None:
            venue_cfg = cfg.get("venues", {}).get(venue, {})
            if phase in venue_cfg:
                base_ms = float(venue_cfg[phase])

        # 3. Default
        if base_ms is None:
            base_ms = float(defaults.get(phase, 0.0))

        # 4. Jitter (uniform ± jitter_ms)
        jitter = float(defaults.get("jitter_ms", 0.0))
        jitter_offset = random.uniform(-jitter, jitter) if jitter > 0 else 0.0

        # 5. Burst spike
        spike_ms = 0.0
        burst_cfg = cfg.get("simulation", {}).get("burst_mode", {})
        if burst_cfg.get("enabled", False):
            burst_prob = float(burst_cfg.get("prob", 0.0))
            if random.random() < burst_prob:
                spike_ms = float(burst_cfg.get("spike_ms", 0.0))

        # 6. Loss drop (skip normal sleep)
        loss_prob = float(defaults.get("loss_prob", 0.0))
        if loss_prob > 0 and random.random() < loss_prob:
            time.sleep(0.0)
            return 0.0

        total_ms = max(0.0, base_ms + jitter_offset + spike_ms)
        time.sleep(total_ms / 1000.0)
        return total_ms


def simulate_latency(adapter: str, venue: str, phase: str = "order_send") -> float:
    """Module-level convenience wrapper (uses an empty config — callers supply LatencyModel for real use)."""
    return LatencyModel({}).simulate(adapter=adapter, venue=venue, phase=phase)
