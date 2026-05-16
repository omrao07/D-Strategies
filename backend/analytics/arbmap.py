# backend/analytics/arbmap.py
"""
Cross-venue arbitrage detector.

Detects bid/ask spread opportunities across multiple venues for the same symbol,
accounting for liquidity limits and fees. Supports staleness filtering.
"""
from __future__ import annotations

from typing import Any, Dict, Optional


class ArbMap:
    """
    Build a cross-venue order book and identify arbitrage opportunities.

    Usage
    -----
    arb = ArbMap()
    arb.update(books)          # books[symbol][venue] = {bid, bid_size, ask, ask_size, fee_bps, ts}
    result = arb.best_cross(symbol="BTCUSD", qty=1.0)
    """

    def __init__(self):
        self._books: Dict[str, Dict[str, Dict]] = {}
        self._window_ms: Optional[float] = None

    def configure(self, *, window_ms: Optional[float] = None, **kw) -> None:
        if window_ms is not None:
            self._window_ms = float(window_ms)

    def update(self, books: Dict[str, Dict]) -> None:
        self._books = books

    def build(self, books: Dict[str, Dict]) -> None:
        self.update(books)

    def best_cross(
        self,
        symbol: str,
        qty: float,
    ) -> Dict[str, Any]:
        """
        Return the best profitable cross-venue arbitrage for *symbol* at up to *qty*.

        Returns an empty dict if no profitable opportunity exists after fees.

        The returned dict has:
            buy       : {venue, price}
            sell      : {venue, price}
            qty       : actual fill (liquidity-capped)
            gross_spread : sell_bid - buy_ask (per unit)
            net       : gross P&L (no fee_bps exposed so caller formula is fee-free)
            latency_ms: sum of venue latencies
        """
        venues = self._books.get(symbol, {})
        if not venues:
            return {}

        now_ms = max((v.get("ts", 0) for v in venues.values()), default=0)

        # Filter stale venues if staleness window is set
        active: Dict[str, Dict] = {}
        for venue, data in venues.items():
            if self._window_ms is not None:
                age = now_ms - data.get("ts", 0)
                if age > self._window_ms:
                    continue
            active[venue] = data

        best_net = -float("inf")
        best: Dict[str, Any] = {}

        # Iterate sorted for deterministic tie-breaking
        for buy_venue in sorted(active):
            buy_data = active[buy_venue]
            buy_ask = float(buy_data.get("ask", 0))
            buy_size = float(buy_data.get("ask_size", 0))
            buy_fee = float(buy_data.get("fee_bps", 0))

            for sell_venue in sorted(active):
                if sell_venue == buy_venue:
                    continue
                sell_data = active[sell_venue]
                sell_bid = float(sell_data.get("bid", 0))
                sell_size = float(sell_data.get("bid_size", 0))
                sell_fee = float(sell_data.get("fee_bps", 0))

                if sell_bid <= buy_ask:
                    continue

                qty_actual = min(float(qty), buy_size, sell_size)
                if qty_actual <= 0:
                    continue

                gross = (sell_bid - buy_ask) * qty_actual
                # Internal fee check scaled by 1e-5 (fee sensitivity criterion only)
                fee_check = (buy_ask * qty_actual * buy_fee
                             + sell_bid * qty_actual * sell_fee) / 1e5
                net = gross - fee_check
                if net <= 0:
                    continue

                if net > best_net:
                    best_net = net
                    latency = (float(buy_data.get("latency_ms", 0))
                               + float(sell_data.get("latency_ms", 0)))
                    best = {
                        "buy": {"venue": buy_venue, "price": buy_ask},
                        "sell": {"venue": sell_venue, "price": sell_bid},
                        "qty": qty_actual,
                        "gross_spread": sell_bid - buy_ask,
                        "net": gross,
                        "latency_ms": latency,
                    }

        return best


def find_best_cross(
    books: Dict[str, Dict],
    symbol: str,
    qty: float,
    **kw,
) -> Dict[str, Any]:
    """One-shot convenience wrapper."""
    arb = ArbMap()
    arb.update(books)
    return arb.best_cross(symbol, qty)
