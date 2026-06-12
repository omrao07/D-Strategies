# backend/ai/jarvis.py
"""
Jarvis — Natural Language Strategy Querying

Accepts natural language questions about strategies, positions, and risk
and answers them by querying Redis state + vector-ai search.

Backed by an LLM (Claude by default via Anthropic API, configurable).
Falls back to a rule-based keyword responder if no API key is configured.

API endpoint: POST /api/jarvis  { "question": "..." }
Response: { "answer": "...", "sources": [...] }

Example questions:
  "Which strategy has the highest Sharpe today?"
  "What is the current regime?"
  "Show me the top 3 strategies by realized P&L"
  "Which symbols are we most exposed to right now?"
  "Is momentum_us hitting its daily loss limit?"

Integration:
  - Imports from backend.bus.streams for Redis state
  - Calls vector-ai /search for context retrieval (if ENGINE_API_KEY set)
  - Sends context + question to LLM for answer generation

Set env vars:
  ANTHROPIC_API_KEY=sk-ant-...     (required for LLM answers)
  JARVIS_MODEL=claude-haiku-4-5-20251001  (default, cheap + fast)
  JARVIS_MAX_TOKENS=512
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict

log = logging.getLogger(__name__)

JARVIS_MODEL = os.getenv("JARVIS_MODEL", "claude-haiku-4-5-20251001")
JARVIS_MAX_TOKENS = int(os.getenv("JARVIS_MAX_TOKENS", "512"))
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

try:
    import anthropic as _anthropic
    _HAS_ANTHROPIC = True
except Exception:
    _HAS_ANTHROPIC = False

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))


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


def _gather_context(r) -> str:
    """Pull key system state from Redis to inject as LLM context."""
    lines = []

    # PnL
    try:
        raw = r.get("pnl")
        if raw:
            pnl = json.loads(raw)
            lines.append(f"Portfolio PnL today: realized=${pnl.get('realized', 0):.2f}, unrealized=${pnl.get('unrealized', 0):.2f}, total=${pnl.get('total', 0):.2f}")
    except Exception:
        pass

    # Regime
    try:
        raw = r.get("regime:current")
        if raw:
            obj = json.loads(raw)
            lines.append(f"Current market regime: {obj.get('regime', 'unknown')} (confidence={obj.get('confidence', 0):.0%})")
    except Exception:
        pass

    # Tournament leaderboard
    try:
        raw = r.get("tournament:snapshot")
        if raw:
            snapshot = json.loads(raw)[:5]
            lines.append("Top 5 strategies by score:")
            for entry in snapshot:
                lines.append(f"  #{entry['rank']} {entry['strategy']}: score={entry['score']:.2f}, real_pnl=${entry['real_pnl']:.2f}")
    except Exception:
        pass

    # Gross exposure
    try:
        raw = r.get("portfolio:gross_usd")
        if raw:
            lines.append(f"Gross portfolio exposure: ${float(raw):.2f}")
    except Exception:
        pass

    # Kill switches
    try:
        kill_all = r.get("risk:kill_all")
        if kill_all and str(kill_all).lower() in ("1", "true", "yes"):
            lines.append("WARNING: Global kill switch is ACTIVE — all orders blocked.")
    except Exception:
        pass

    return "\n".join(lines) if lines else "No system state available."


def _rule_based_answer(question: str, context: str) -> str:
    """Fallback: keyword-based answer when no LLM is configured."""
    q = question.lower()
    if "regime" in q:
        for line in context.split("\n"):
            if "regime" in line.lower():
                return line
    if "pnl" in q or "profit" in q or "loss" in q:
        for line in context.split("\n"):
            if "pnl" in line.lower():
                return line
    if "top" in q or "best" in q or "rank" in q:
        lines = [l for l in context.split("\n") if "strategy" in l.lower() or "#" in l]
        return "\n".join(lines[:5]) if lines else "No ranking data available."
    if "kill" in q or "disabled" in q:
        for line in context.split("\n"):
            if "kill" in line.lower():
                return line
    return f"Here is the current system state:\n{context}"


def answer(question: str, r=None) -> Dict[str, Any]:
    """
    Answer a natural language question about the trading system.
    Returns {"answer": str, "sources": list, "model": str}
    """
    if r is None:
        r = _get_redis()

    context = _gather_context(r)

    if not _HAS_ANTHROPIC or not ANTHROPIC_API_KEY:
        answer_text = _rule_based_answer(question, context)
        return {
            "answer": answer_text,
            "sources": ["redis:state"],
            "model": "rule_based",
        }

    try:
        client = _anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        system_prompt = (
            "You are Jarvis, an AI assistant for a quantitative trading platform. "
            "Answer questions about strategy performance, risk, positions, and market regime "
            "using the system state provided. Be concise and precise. Use numbers where available."
        )
        user_msg = f"System state:\n{context}\n\nQuestion: {question}"

        response = client.messages.create(
            model=JARVIS_MODEL,
            max_tokens=JARVIS_MAX_TOKENS,
            system=system_prompt,
            messages=[{"role": "user", "content": user_msg}],
        )
        answer_text = response.content[0].text if response.content else "No response generated."
        return {
            "answer": answer_text,
            "sources": ["redis:state"],
            "model": JARVIS_MODEL,
        }
    except Exception as e:
        log.exception("Jarvis: LLM call failed")
        fallback = _rule_based_answer(question, context)
        return {
            "answer": fallback,
            "sources": ["redis:state"],
            "model": "rule_based_fallback",
            "error": str(e),
        }
