"""
MCX Feed Adapter (WebSocket-Compatible Interface)
------------------------------------------------
Purpose:
- Normalize MCX commodity market data into engine format
- Support broker / vendor feeds OR polling fallback
- Maintain consistency with other exchange adapters

MCX does NOT provide a free public websocket.
This adapter is intentionally vendor-safe and compliant.
"""

import asyncio
import logging
import time
from typing import Callable, Dict, Optional

log = logging.getLogger("mcx.feed")

DEFAULT_POLL_INTERVAL = 5  # seconds


class MCXFeedAdapter:
    def __init__(
        self,
        *,
        market: str = "MCX",              # MCX
        poll_interval: int = DEFAULT_POLL_INTERVAL,
        fetcher: Optional[Callable[[], Dict]] = None,
        on_event: Optional[Callable[[Dict], None]] = None,
        mode: str = "polling",            # "polling" | "broker" | "vendor"
    ):
        """
        market:
          - MCX: Commodities (Crude, Gold, Silver, etc.)

        mode:
          - polling: delayed / dev / paper
          - broker: Zerodha / broker quote bridge
          - vendor: licensed MCX MDP / FIX feed wrapper

        fetcher: custom data fetcher
        on_event: callback into engine
        """

        self.market = market
        self.poll_interval = poll_interval
        self.fetcher = fetcher or self._default_fetcher
        self.on_event = on_event
        self.mode = mode

        self._running = False

    # ============================
    # Lifecycle
    # ============================

    async def start(self):
        self._running = True
        log.info(f"Starting MCX adapter (mode={self.mode})")

        if self.mode == "vendor":
            await self._run_vendor()
        elif self.mode == "broker":
            await self._run_broker()
        else:
            await self._run_polling()

    async def stop(self):
        self._running = False
        log.info("Stopping MCX adapter")

    # ============================
    # Polling mode
    # ============================

    async def _run_polling(self):
        while self._running:
            try:
                raw = self.fetcher()
                event = self._normalize(raw)

                if self.on_event:
                    self.on_event(event)

            except Exception as e:
                log.error(f"MCX polling error: {e}")

            await asyncio.sleep(self.poll_interval)

    # ============================
    # Broker mode (e.g. Zerodha)
    # ============================

    async def _run_broker(self):
        """
        Placeholder for broker-bridged MCX feeds.
        Typically pulls quotes via broker REST / WS.
        """
        log.warning("MCX broker mode enabled – awaiting broker bridge")

        while self._running:
            await asyncio.sleep(1)

    # ============================
    # Vendor mode (MCX MDP / FIX)
    # ============================

    async def _run_vendor(self):
        """
        Placeholder for licensed MCX MDP / FIX feed integration.
        Actual transport is vendor-specific.
        """
        log.warning("MCX vendor mode enabled – awaiting licensed feed")

        while self._running:
            await asyncio.sleep(1)

    # ============================
    # Default fetcher (stub)
    # ============================

    def _default_fetcher(self) -> Dict:
        """
        Replace with:
        - Broker quote API
        - Vendor proxy
        - Internal simulator
        """

        return {
            "symbol": "CRUDEOIL",
            "expiry": "2025-01-17",
            "price": 6248.0,
            "bid": 6247.0,
            "ask": 6249.0,
            "volume": 182_500,
            "market": self.market,
            "ts": int(time.time() * 1000),
        }

    # ============================
    # Normalization
    # ============================

    def _normalize(self, raw: Dict) -> Dict:
        return {
            "type": "ticker",
            "exchange": "MCX",
            "market": raw.get("market", self.market),
            "symbol": raw["symbol"],
            "expiry": raw.get("expiry"),
            "price": raw["price"],
            "bid": raw.get("bid"),
            "ask": raw.get("ask"),
            "volume": raw.get("volume"),
            "ts": raw["ts"],
            "source": "mcx",
        }


# ============================
# Example usage
# ============================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    def handle(evt):
        print(
            f"{evt['symbol']} {evt.get('expiry')} "
            f"{evt['price']} ({evt['bid']} / {evt['ask']})"
        )

    mcx = MCXFeedAdapter(
        poll_interval=10,
        on_event=handle,
    )

    asyncio.run(mcx.start())