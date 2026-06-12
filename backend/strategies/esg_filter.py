# backend/strategies/esg_filter.py
from __future__ import annotations

import csv
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from backend.bus.streams import hset
from backend.engine.strategy_base import Strategy


@dataclass
class ESGConfig:
    min_score: float = 50.0
    # Path to CSV with columns: ticker, score  (optional)
    scores_csv: Optional[str] = None
    # Inline scores dict (used if scores_csv is None or file missing)
    scores_dict: Dict[str, float] = field(default_factory=lambda: {
        "RELIANCE.NS": 72.5,
        "TCS.NS": 81.0,
        "ADANIPORTS.NS": 45.0,
        "INFY.NS": 77.0,
        "AAPL": 68.0,
        "MSFT": 75.0,
        "GOOGL": 71.0,
        "AMZN": 60.0,
        "NVDA": 62.0,
        "TSLA": 55.0,
        "XOM": 30.0,
        "CVX": 35.0,
        "LMT": 48.0,
        "RTX": 46.0,
        "NOC": 44.0,
    })
    symbols: tuple[str, ...] = ()  # empty = accept any ticker present in score map
    hard_kill: bool = False


class ESGFilter(Strategy):
    """
    ESG-gated overlay strategy:
      - Maintains ESG scores loaded from a CSV file or inline dict.
      - On each tick for a known symbol, emits +1.0 (compliant) or -1.0 (non-compliant).
      - Provides a `filter_trades()` utility for portfolio managers that need
        to screen a batch of candidate trades.
      - Does not generate independent alpha; intended as an overlay constraint
        on order flow from other strategies.

    CSV format (if scores_csv is set):
        ticker,score
        AAPL,68.0
        XOM,30.0

    Tick format (tolerant):
        { "symbol"|"s": "AAPL", ... }  (any quote / trade / signal tick)
    """

    def __init__(self, name: str = "policy_esg_filter", region: Optional[str] = None,
                 cfg: Optional[ESGConfig] = None):
        cfg = cfg or ESGConfig()
        super().__init__(name=name, region=region)
        self.cfg = cfg
        self._scores: Dict[str, float] = {}
        self._load_scores()

    def _load_scores(self) -> None:
        if self.cfg.scores_csv and os.path.isfile(self.cfg.scores_csv):
            try:
                with open(self.cfg.scores_csv, newline="") as f:
                    reader = csv.DictReader(f)
                    for row in reader:
                        ticker = str(row.get("ticker") or row.get("symbol") or "").upper().strip()
                        raw = row.get("score") or row.get("esg_score")
                        if ticker and raw is not None:
                            try:
                                self._scores[ticker] = float(raw)
                            except ValueError:
                                pass
            except Exception:
                pass
        # inline dict fills gaps; CSV entries take precedence for shared keys
        for ticker, score in self.cfg.scores_dict.items():
            self._scores.setdefault(ticker.upper(), score)

    # -------- public API --------

    def get_esg_score(self, ticker: str) -> float:
        """Return ESG score for ticker (defaults to 50.0 if unknown)."""
        return self._scores.get(ticker.upper(), 50.0)

    def is_esg_compliant(self, ticker: str) -> bool:
        return self.get_esg_score(ticker) >= self.cfg.min_score

    def filter_trades(self, trades: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Filter a list of trade dicts, returning only those that pass the ESG threshold.

        Args:
            trades: List of dicts with a 'ticker' or 'symbol' key.

        Returns:
            Passing subset, each augmented with an 'esg_score' field.
        """
        passed = []
        for trade in trades:
            ticker = str(trade.get("ticker") or trade.get("symbol") or "").upper()
            score = self.get_esg_score(ticker)
            if score >= self.cfg.min_score:
                t = dict(trade)
                t["esg_score"] = score
                passed.append(t)
        return passed

    # -------- lifecycle --------

    def on_start(self) -> None:
        super().on_start()
        hset("strategy:meta", self.ctx.name, {
            "tags": ["esg", "filter", "overlay"],
            "region": self.ctx.region or "GLOBAL",
            "min_score": self.cfg.min_score,
            "n_scored_tickers": len(self._scores),
            "notes": "ESG compliance overlay; +1.0 = compliant, -1.0 = blocked."
        })

    # -------- main --------

    def on_tick(self, tick: Dict[str, Any]) -> None:
        if self.cfg.hard_kill:
            return

        sym = (tick.get("symbol") or tick.get("s") or "").upper()
        if not sym:
            return
        if self.cfg.symbols and sym not in self.cfg.symbols:
            return

        score = self.get_esg_score(sym)
        self.emit_signal(1.0 if score >= self.cfg.min_score else -1.0)


if __name__ == "__main__":
    strat = ESGFilter()
    # strat.run(stream="ticks.equities.us")
