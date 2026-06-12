# backend/news/social_sentiment.py
"""
Rule-based social sentiment engine.

Provides ingestion, deduplication, lexicon-based sentiment scoring,
entity (ticker) extraction, and time-windowed aggregation over stored events.
No external NLP dependencies — portable across environments.
"""
from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional

# ── Lexicon ─────────────────────────────────────────────────────────────────

_POS_WORDS = frozenset([
    "love", "great", "solid", "beat", "strong", "growth", "moon", "massive",
    "bullish", "surge", "rise", "gain", "exceed", "outperform", "rally",
    "terrific", "excellent", "profit", "boom", "exceptional", "amazing",
    "positive", "win", "soar", "success", "revenue", "earnings", "beat",
    "upside", "breakout", "momentum", "opportunity", "innovative", "record",
])

_NEG_WORDS = frozenset([
    "miss", "cut", "ugly", "bad", "weak", "poor", "decline", "fall",
    "cautious", "headwinds", "overrated", "bearish", "drop", "loss",
    "underperform", "crash", "awful", "terrible", "collapse", "warning",
    "caution", "soft", "concern", "risk", "worry", "slow", "downside",
    "disappointing", "pressure", "slump", "drag", "impair",
])

_POS_EMOJI = frozenset(["🚀", "🎉", "💚", "📈", "🤑", "✅", "🔥"])
_NEG_EMOJI = frozenset(["🙄", "📉", "😱", "💔", "⚠️", "❌", "😬"])

_STOP = frozenset([
    "IS", "TO", "AND", "THE", "FOR", "IN", "ON", "AT", "BY", "OF", "OR",
    "A", "AN", "IT", "WE", "HE", "SHE", "ALSO", "ABOUT", "TODAY", "WITH",
    "FROM", "THAT", "THIS", "HAVE", "HAS", "HAD", "ARE", "WAS", "WERE",
    "BE", "BEEN", "BEEN",
])


class SocialSentiment:
    """Store, score, and aggregate social / news sentiment events."""

    def __init__(self):
        self._events: Dict[str, Dict] = {}   # id → enriched event
        self._dedup_dropped = 0

    # ------------------------------------------------------------------
    # Text processing
    # ------------------------------------------------------------------

    def normalize(self, text: str) -> str:
        text = re.sub(r"https?://\S+", "", text)
        text = re.sub(r"\s+", " ", text)
        return text.strip()[:10_000]

    def score_text(self, text: str, lang: Optional[str] = None) -> Dict[str, Any]:
        if not text or not text.strip():
            return {"sent": 0.0, "label": "neu"}

        limited = text[:10_000].lower()
        words = re.findall(r"\b\w+\b", limited)

        pos = sum(1 for w in words if w in _POS_WORDS)
        neg = sum(1 for w in words if w in _NEG_WORDS)
        for e in _POS_EMOJI:
            pos += text.count(e)
        for e in _NEG_EMOJI:
            neg += text.count(e)

        total = pos + neg
        sent = float((pos - neg) / total) if total else 0.0
        sent = max(-1.0, min(1.0, sent))
        label = "pos" if sent > 0.1 else "neg" if sent < -0.1 else "neu"
        return {"sent": sent, "label": label}

    def score_batch(
        self,
        texts: List[str],
        langs: Optional[List[Optional[str]]] = None,
    ) -> List[Dict[str, Any]]:
        resolved: List[Optional[str]] = langs or [None] * len(texts)
        return [self.score_text(t, l) for t, l in zip(texts, resolved)]

    def extract_entities(self, text: str) -> Dict[str, List[str]]:
        upper = text.upper()
        dollar = re.findall(r"\$([A-Z]{1,5})", upper)
        hashed = re.findall(r"#([A-Z]{1,5})", upper)
        bare = [t for t in re.findall(r"\b([A-Z]{2,5})\b", upper) if t not in _STOP]
        tickers = list(dict.fromkeys(dollar + hashed + bare))
        return {"tickers": tickers, "symbols": tickers}

    # ------------------------------------------------------------------
    # Ingestion
    # ------------------------------------------------------------------

    def ingest(self, events: List[Dict]) -> int:
        ingested = 0
        for ev in events:
            ev_id = str(ev.get("id", ""))
            if ev_id and ev_id in self._events:
                self._dedup_dropped += 1
                continue
            text = str(ev.get("text", ""))
            score = self.score_text(text, ev.get("lang"))
            entities = self.extract_entities(text)
            key = ev_id if ev_id else f"_auto_{len(self._events)}"
            self._events[key] = {**ev, "score": score, "entities": entities}
            ingested += 1
        return ingested

    # ------------------------------------------------------------------
    # Aggregation
    # ------------------------------------------------------------------

    def aggregate(
        self,
        entity: str,
        start_ms: int,
        end_ms: int,
        *,
        window: str = "1h",
    ) -> Dict[str, Any]:
        win_ms = self._parse_window_ms(window)
        entity_up = entity.upper()

        matching = []
        for ev in self._events.values():
            ts = int(ev.get("ts", 0))
            if ts < start_ms or ts > end_ms:
                continue
            tickers = [t.upper() for t in ev.get("entities", {}).get("tickers", [])]
            if entity_up in tickers:
                matching.append(ev)

        if not matching:
            return {"n": 0, "mean": 0.0, "pos": 0, "neg": 0, "neu": 0, "series": []}

        buckets: Dict[int, List] = defaultdict(list)
        for ev in matching:
            ts = int(ev.get("ts", 0))
            bucket_start = (ts // win_ms) * win_ms
            buckets[bucket_start].append(ev)

        series = [
            {
                "ts": bts,
                "mean": sum(float(e["score"]["sent"]) for e in evs) / len(evs),
                "n": len(evs),
            }
            for bts, evs in sorted(buckets.items())
        ]

        all_sents = [float(ev["score"]["sent"]) for ev in matching]
        mean = sum(all_sents) / len(all_sents)
        pos_n = sum(1 for ev in matching if ev["score"]["label"] == "pos")
        neg_n = sum(1 for ev in matching if ev["score"]["label"] == "neg")
        neu_n = sum(1 for ev in matching if ev["score"]["label"] == "neu")

        return {"n": len(matching), "mean": mean, "pos": pos_n, "neg": neg_n,
                "neu": neu_n, "series": series}

    def rolling(
        self, entity: str, end_ms: int, lookback: str = "7d"
    ) -> Dict[str, Any]:
        lb_ms = self._parse_window_ms(lookback)
        return self.aggregate(entity=entity, start_ms=end_ms - lb_ms, end_ms=end_ms)

    def alerts(
        self, entity: str, *, threshold: float = 0.5
    ) -> List[Dict[str, Any]]:
        agg = self.aggregate(entity=entity, start_ms=0, end_ms=int(time.time() * 1000))
        if agg["n"] > 0 and abs(agg["mean"]) >= threshold:
            return [{"entity": entity, "mean": agg["mean"], "n": agg["n"]}]
        return []

    def dedup_stats(self) -> Dict[str, Any]:
        return {"dropped": self._dedup_dropped, "dupes": self._dedup_dropped,
                "unique": len(self._events)}

    # ------------------------------------------------------------------
    # Rate limiting (store config; enforcement is a no-op)
    # ------------------------------------------------------------------

    def set_rate_limit(self, key: str, n: int, per_s: float) -> None:
        pass

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def export_json(self) -> Dict[str, Any]:
        return {"events": list(self._events.values()), "dedup_count": self._dedup_dropped}

    def import_json(self, blob: Any = None, **kw) -> None:
        if blob is None:
            blob = kw.get("blob")
        if isinstance(blob, str):
            blob = json.loads(blob)
        self._events = {}
        for i, ev in enumerate(blob.get("events", [])):
            key = str(ev.get("id", i))
            self._events[key] = ev
        self._dedup_dropped = int(blob.get("dedup_count", 0))

    def clear(self) -> None:
        self._events.clear()
        self._dedup_dropped = 0

    # ------------------------------------------------------------------
    @staticmethod
    def _parse_window_ms(window: str) -> int:
        try:
            if window.endswith("m"):
                return int(window[:-1]) * 60_000
            if window.endswith("h"):
                return int(window[:-1]) * 3_600_000
            if window.endswith("d"):
                return int(window[:-1]) * 86_400_000
        except Exception:
            pass
        return 3_600_000
