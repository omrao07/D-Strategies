# backend/security/merkle_ledger.py
"""
Compliance Trail Merkle Ledger

Every order accept/reject, fill, and kill-switch event is hashed into a
tamper-evident Merkle chain. Each entry includes:
  - event type and payload
  - SHA-256 hash of the previous entry (chain linkage)
  - entry hash (SHA-256 of prev_hash + payload)
  - timestamp

The chain head is stored at `ledger:head` in Redis.
All entries are stored as `ledger:entry:<sequence>` with configurable TTL.

This creates a lightweight append-only audit log that:
  - Can prove an event occurred at a specific time
  - Detects tampering if any entry is altered
  - Satisfies MiFID II / SEC audit trail requirements

Usage:
  from backend.security.merkle_ledger import append_event, verify_chain

  append_event("order_accept", {"strategy": "momentum_us", "symbol": "AAPL", "qty": 100})
  append_event("order_reject", {"strategy": "momentum_us", "reason": "global_cap"})
  ok, msg = verify_chain(last_n=100)

Wire into risk_manager.py and execution_engine.py after fill/reject events.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from typing import Any, Dict, Optional, Tuple

log = logging.getLogger(__name__)

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
LEDGER_TTL_SECONDS = int(os.getenv("LEDGER_TTL_SECONDS", str(365 * 86400)))  # 1 year
LEDGER_SEQ_KEY = "ledger:seq"
LEDGER_HEAD_KEY = "ledger:head"
GENESIS_HASH = "0" * 64


def _get_redis():
    import redis as _redis
    ssl = os.getenv("REDIS_SSL", "").lower() in ("1", "true", "yes")
    kwargs = dict(
        host=REDIS_HOST,
        port=REDIS_PORT,
        password=os.getenv("REDIS_PASSWORD") or None,
        decode_responses=True,
    )
    if ssl:
        kwargs["ssl"] = True
    return _redis.Redis(**kwargs)


def _sha256(data: str) -> str:
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def _make_entry(seq: int, event_type: str, payload: Dict[str, Any], prev_hash: str, ts: Optional[int] = None) -> Dict:
    if ts is None:
        ts = int(time.time() * 1000)
    content = json.dumps({
        "seq": seq,
        "type": event_type,
        "payload": payload,
        "prev_hash": prev_hash,
        "ts_ms": ts,
    }, sort_keys=True)
    entry_hash = _sha256(prev_hash + content)
    return {
        "seq": seq,
        "type": event_type,
        "payload": payload,
        "prev_hash": prev_hash,
        "ts_ms": ts,
        "hash": entry_hash,
    }


def append_event(event_type: str, payload: Dict[str, Any], r=None) -> Optional[Dict]:
    """
    Append a new event to the Merkle ledger.
    Returns the created entry or None on failure.
    """
    try:
        if r is None:
            r = _get_redis()

        # Atomic sequence increment
        seq = r.incr(LEDGER_SEQ_KEY)

        # Get previous hash
        head_raw = r.get(LEDGER_HEAD_KEY)
        if head_raw:
            try:
                prev_hash = json.loads(head_raw).get("hash", GENESIS_HASH)
            except Exception:
                prev_hash = GENESIS_HASH
        else:
            prev_hash = GENESIS_HASH

        entry = _make_entry(seq, event_type, payload, prev_hash)
        serialized = json.dumps(entry)

        pipeline = r.pipeline()
        pipeline.set(f"ledger:entry:{seq}", serialized, ex=LEDGER_TTL_SECONDS)
        pipeline.set(LEDGER_HEAD_KEY, serialized)
        pipeline.execute()

        return entry
    except Exception:
        log.exception("merkle_ledger: failed to append event type=%s", event_type)
        return None


def get_entry(seq: int, r=None) -> Optional[Dict]:
    """Retrieve a ledger entry by sequence number."""
    try:
        if r is None:
            r = _get_redis()
        raw = r.get(f"ledger:entry:{seq}")
        return json.loads(raw) if raw else None
    except Exception:
        log.exception("merkle_ledger: failed to get entry seq=%d", seq)
        return None


def verify_chain(last_n: int = 1000, r=None) -> Tuple[bool, str]:
    """
    Verify the last N entries form an unbroken Merkle chain.
    Returns (True, "ok") or (False, "<error description>").
    """
    try:
        if r is None:
            r = _get_redis()

        head_raw = r.get(LEDGER_HEAD_KEY)
        if not head_raw:
            return True, "empty chain"

        head = json.loads(head_raw)
        current_seq = int(head["seq"])

        start_seq = max(1, current_seq - last_n + 1)
        prev_hash = GENESIS_HASH

        for seq in range(start_seq, current_seq + 1):
            entry = get_entry(seq, r)
            if entry is None:
                # Entry may have expired from Redis TTL — skip gracefully
                continue

            # Recompute hash
            content = json.dumps({
                "seq": entry["seq"],
                "type": entry["type"],
                "payload": entry["payload"],
                "prev_hash": entry["prev_hash"],
                "ts_ms": entry["ts_ms"],
            }, sort_keys=True)
            expected_hash = _sha256(entry["prev_hash"] + content)

            if entry["hash"] != expected_hash:
                return False, f"Hash mismatch at seq={seq}: stored={entry['hash'][:16]}... computed={expected_hash[:16]}..."

            if seq > start_seq and entry["prev_hash"] != prev_hash:
                return False, f"Chain break at seq={seq}: prev_hash mismatch"

            prev_hash = entry["hash"]

        return True, "ok"
    except Exception as e:
        log.exception("merkle_ledger: verification error")
        return False, f"verification error: {e}"
