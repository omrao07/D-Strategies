# backend/engine/core/replay.py
"""
Event-log replayer.

Replays a stored sequence of Events through the same deterministic
logic as Engine.run(), guaranteeing parity between live execution and
historical replay.  Any divergence indicates non-determinism or a bug.
"""
from __future__ import annotations

from typing import List

from backend.engine.core.engine import Engine
from backend.engine.core.types import EngineResult, Event


class Replayer:
    """
    Replays a list of Events using the same Engine logic.

    Using the same Engine implementation (not a separate code-path)
    guarantees that live == replay by construction.  The replayer's
    responsibility is to enforce strict timestamp ordering and to
    reject events that would break determinism.
    """

    def __init__(self, strict_ordering: bool = True):
        """
        Parameters
        ----------
        strict_ordering : if True, raise if events are not sorted by ts
        """
        self.strict_ordering = strict_ordering
        self._engine = Engine()

    def replay(self, events: List[Event]) -> EngineResult:
        """
        Replay events and return the EngineResult.

        Parameters
        ----------
        events : event log (should be in original chronological order)

        Raises
        ------
        ValueError : if strict_ordering=True and timestamps are not monotonic
        """
        if self.strict_ordering and len(events) > 1:
            for i in range(1, len(events)):
                if events[i].ts < events[i - 1].ts:
                    raise ValueError(
                        f"Events not in timestamp order at index {i}: "
                        f"{events[i-1].ts} → {events[i].ts}"
                    )

        return self._engine.run(events)
