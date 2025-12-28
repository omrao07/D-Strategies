"""
JPX Adapter (WebSocket-Compatible Interface)
-------------------------------------------
Purpose:
- Normalize JPX market events into engine format
- Support licensed Arrowhead / ITCH feeds OR polling fallback
- Maintain consistency with other exchange adapters

JPX does NOT provide a free public websocket.
This adapter is intentionally vendor-safe and compliant.
"""

import asyncio
import logging
import time
from typing import Callable, Dict, Optional

log = logging.getLogger("jpx.ws")

DEFAULT_POLL_INTERVAL = 5  # seconds


class JPXWebSocket:
    def __init__(
        self,
        *,
        market: str = "TSE",        # TSE, OSE (derivatives)
        poll_interval: int = DEFAULT_POLL_INTERVAL,
        fetcher: Optional[Callable[[], Dict]] = None,
        on_event: Optional[Callable[[Dict], None]] = None,
        mode: str = "polling",      # "polling" | "vendor"
    ):
        """
        market:
          - TSE: Tokyo Stock Exchange (equities, ETFs, REITs)
          - OSE: Osaka Exchange (futures, options)

        mode:
          - polling: delayed / dev / paper
          - vendor: licensed Arrowhead / ITCH feed wrapper

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
        log.info(f"Starting JPX adapter (market={self.market}, mode={self.mode})")

        if self.mode == "vendor":
            await self._run_vendor()
        else:
            await self._run_polling()

    async def stop(self):
        self._running = False
        log.info("Stopping JPX adapter")

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
                log.error(f"JPX polling error: {e}")

            await asyncio.sleep(self.poll_interval)

    # ============================
    # Vendor mode (Arrowhead wrapper)
    # ============================

    async def _run_vendor(self):
        """
        Placeholder for licensed JPX Arrowhead / ITCH feed integration.
        Actual transport (TCP multicast / FIX / ITCH) is vendor-specific.
        """
        log.warning("JPX vendor mode enabled – waiting for external Arrowhead feed")

        while self._running:
            await asyncio.sleep(1)

    # ============================
    # Default fetcher (stub)
    # ============================

    def _default_fetcher(self) -> Dict:
        """
        Replace with:
        - JPX delayed REST snapshot
        - Vendor proxy
        - Internal simulator
        """

        return {
            "symbol": "7203.T",       # Toyota Motor Corp
            "price": 2865.5,
            "bid": 2865.0,
            "ask": 2866.0,
            "volume": 1_250_000,
            "market": self.market,
            "ts": int(time.time() * 1000),
        }

    # ============================
    # Normalization
    # ============================

    def _normalize(self, raw: Dict) -> Dict:
        return {
            "type": "ticker",
            "exchange": "JPX",
            "market": raw.get("market", self.market),
            "symbol": raw["symbol"],
            "price": raw["price"],
            "bid": raw.get("bid"),
            "ask": raw.get("ask"),
            "volume": raw.get("volume"),
            "ts": raw["ts"],
            "source": "jpx",
        }


# ============================
# Example usage
# ============================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    def handle(evt):
        print(
            f"{evt['symbol']} "
            f"{evt['price']} "
            f"({evt['bid']} / {evt['ask']})"
        )

    jpx = JPXWebSocket(
        market="TSE",
        poll_interval=10,
        on_event=handle,
    )

    asyncio.run(jpx.start())