# backend/ai/ml/nlp.py
"""
NLP sentiment: FinBERT-based financial sentiment scorer.
Falls back to VADER/keyword sentiment when transformers is not available.
"""
from __future__ import annotations

import logging
import re
from typing import List, Literal, Tuple

logger = logging.getLogger("ai.ml.nlp")

SentimentLabel = Literal["positive", "neutral", "negative"]

# Simple keyword-based fallback
_POSITIVE_WORDS = {
    "beat", "profit", "growth", "revenue", "record", "strong", "surge",
    "upgrade", "buy", "bullish", "outperform", "rally", "gain",
}
_NEGATIVE_WORDS = {
    "miss", "loss", "decline", "weak", "downgrade", "sell", "bearish",
    "underperform", "fall", "risk", "cut", "warning", "default",
}


def _keyword_sentiment(text: str) -> Tuple[SentimentLabel, float]:
    words = set(re.findall(r"\b\w+\b", text.lower()))
    pos = len(words & _POSITIVE_WORDS)
    neg = len(words & _NEGATIVE_WORDS)
    total = pos + neg
    if total == 0:
        return "neutral", 0.0
    score = (pos - neg) / total
    if score > 0.1:
        return "positive", round(score, 4)
    if score < -0.1:
        return "negative", round(score, 4)
    return "neutral", round(score, 4)


class FinBERTSentiment:
    """
    Financial sentiment using FinBERT (ProsusAI/finbert).
    Requires: transformers, torch.
    Graceful fallback to keyword scoring.
    """

    def __init__(self, model_name: str = "ProsusAI/finbert", device: str = "cpu"):
        self.model_name = model_name
        self.device = device
        self._pipeline = None
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        try:
            from transformers import pipeline  # type: ignore
            self._pipeline = pipeline(
                "sentiment-analysis",
                model=self.model_name,
                tokenizer=self.model_name,
                device=-1,  # CPU
            )
            logger.info(f"[FinBERT] loaded model={self.model_name}")
        except Exception as e:
            logger.warning(f"[FinBERT] could not load model: {e} — using keyword fallback")
        self._loaded = True

    def score(self, text: str) -> Tuple[SentimentLabel, float]:
        """Return (label, confidence)."""
        self._load()
        if self._pipeline is None:
            return _keyword_sentiment(text)
        try:
            result = self._pipeline(text[:512])[0]
            label = result["label"].lower()  # positive/neutral/negative
            if label not in ("positive", "neutral", "negative"):
                label = "neutral"
            return label, round(result["score"], 4)
        except Exception as e:
            logger.warning(f"[FinBERT] inference error: {e}")
            return _keyword_sentiment(text)

    def score_batch(self, texts: List[str]) -> List[Tuple[SentimentLabel, float]]:
        return [self.score(t) for t in texts]

    def sentiment_score(self, text: str) -> float:
        """Return scalar in [-1, 1]: +1=positive, -1=negative, 0=neutral."""
        label, confidence = self.score(text)
        if label == "positive":
            return confidence
        if label == "negative":
            return -confidence
        return 0.0
