# backend/agents/analyst_agent.py
"""
Rule-based analyst agent for news-driven trade signal generation.

Produces structured recommendations: {action, signal, score, confidence, reasoning}.
Uses an injectable sentiment model (default: rule-based lexicon scorer).
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


class _DefaultSentiment:
    """Minimal fallback sentiment scorer (word-list based)."""

    _POS = frozenset(["beats", "surge", "upgrade", "strong", "growth", "beat", "raises",
                      "record", "profit", "outperform", "buy", "excellent", "positive"])
    _NEG = frozenset(["miss", "downgrade", "fraud", "probe", "loss", "weak", "cut",
                      "decline", "warning", "crash", "bearish", "concern"])

    def predict(self, text: str) -> Dict[str, float]:
        if not text:
            return {"polarity": 0.0, "confidence": 0.3}
        words = re.findall(r"\b\w+\b", text.lower())
        pos = sum(1 for w in words if w in self._POS)
        neg = sum(1 for w in words if w in self._NEG)
        total = pos + neg
        polarity = (pos - neg) / total if total else 0.0
        confidence = min(0.5 + 0.1 * total, 0.95)
        return {"polarity": polarity, "confidence": confidence}


class AnalystAgent:
    """
    Analyst agent that scores news events and generates trade recommendations.

    Parameters
    ----------
    config : dict
        Optional config with keys: min_conf (float, default 0.5).
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        cfg = config or {}
        self._min_conf = float(cfg.get("min_conf", 0.5))
        self.sentiment = _DefaultSentiment()

    # ------------------------------------------------------------------
    # Core API
    # ------------------------------------------------------------------

    def analyze_event(
        self,
        news: Dict[str, Any],
        market_ctx: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Analyze a news event in the context of a market snapshot.

        Parameters
        ----------
        news       : dict with headline, body (optional), symbols, source, ts
        market_ctx : dict with symbol, price, prev_close, etc.

        Returns
        -------
        dict: {action, signal, score, confidence, reasoning}
        """
        headline = str(news.get("headline") or "")
        body = str(news.get("body") or "")
        text = (headline + " " + body).strip()

        news_symbols = [s.upper() for s in (news.get("symbols") or [])]
        ctx_symbol = str(market_ctx.get("symbol", "")).upper()

        # If news is about a different symbol, return low-relevance hold
        if news_symbols and ctx_symbol and ctx_symbol not in news_symbols:
            return {
                "action": "hold",
                "signal": 0.0,
                "score": 0.0,
                "confidence": 0.2,
                "reasoning": f"News targets {news_symbols}, not {ctx_symbol}",
            }

        # Empty or missing text → neutral
        if not text:
            return {
                "action": "hold",
                "signal": 0.0,
                "score": 0.0,
                "confidence": 0.3,
                "reasoning": "No text content in event",
            }

        pred = self.sentiment.predict(text)
        polarity = float(pred.get("polarity", 0.0))
        confidence = float(pred.get("confidence", 0.5))

        # Derive signal from polarity (clamped to [-1, 1])
        signal = max(-1.0, min(1.0, polarity))

        # Determine action thresholds
        if confidence < self._min_conf or abs(signal) < 0.1:
            action = "hold"
        elif signal >= 0.3:
            action = "buy"
        elif signal > 0.1:
            action = "scale_in"
        elif signal <= -0.3:
            action = "sell"
        elif signal < -0.1:
            action = "reduce"
        else:
            action = "hold"

        return {
            "action": action,
            "signal": signal,
            "score": abs(signal),
            "confidence": confidence,
            "reasoning": f"polarity={polarity:.3f} from '{headline[:60]}'",
        }

    def generate_report(
        self,
        items: List[Dict[str, Any]],
        market_ctx: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Generate a brief human-readable summary of multiple news items."""
        ctx_symbol = str((market_ctx or {}).get("symbol", "")).upper()
        lines = [f"Analyst Report — {ctx_symbol or 'Portfolio'}"]
        for item in items:
            hl = str(item.get("headline", ""))
            syms = ", ".join(str(s) for s in (item.get("symbols") or []))
            if hl:
                lines.append(f"  [{syms}] {hl}")
        return "\n".join(lines)
