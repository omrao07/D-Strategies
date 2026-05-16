# backend/engine/core/engine.py
"""
Deterministic execution engine.

Processes a sequence of Events in order, accumulates positions and
trades, and returns an EngineResult with a deterministic state hash.
"""
from __future__ import annotations

from typing import List

from backend.engine.core.types import Event, EngineResult, hash_state


class Engine:
    """
    Simple deterministic event-processing engine.

    Each Event represents a fill: symbol bought/sold at price with qty.
    Positive qty = buy, negative qty = sell.
    """

    def run(self, events: List[Event]) -> EngineResult:
        """
        Process events in the given order and return the result.

        Parameters
        ----------
        events : list of Event (must be pre-sorted by ts if order matters)

        Returns
        -------
        EngineResult with pnl, positions, trades, and state_hash
        """
        positions: dict = {}
        trades: list = []
        cash = 0.0

        for e in events:
            positions[e.symbol] = positions.get(e.symbol, 0.0) + e.qty
            cash -= e.qty * e.price
            trades.append((e.ts, e.symbol, e.qty, e.price))

        pnl = -cash
        state = {"positions": positions, "trades": trades, "pnl": pnl}

        return EngineResult(
            pnl=pnl,
            positions=positions,
            orders=[],
            trades=trades,
            state_hash=hash_state(state),
        )
