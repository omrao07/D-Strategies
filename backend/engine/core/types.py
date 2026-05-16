# backend/engine/core/types.py
"""
Shared data types for engine execution and replay.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Tuple


@dataclass
class Event:
    """A single market/order event processed by the engine."""
    ts: int
    symbol: str
    price: float
    qty: float


@dataclass
class EngineResult:
    """Output of a single engine run or replay."""
    pnl: float
    positions: Dict[str, float]
    orders: List[Any]
    trades: List[Tuple]
    state_hash: str


def hash_state(obj: Any) -> str:
    """SHA-256 of a JSON-serialized object (keys sorted for determinism)."""
    raw = json.dumps(obj, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()
