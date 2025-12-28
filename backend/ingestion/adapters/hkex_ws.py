"""
HKEX Adapter (WebSocket-Compatible Interface)
---------------------------------------------
Purpose:
- Normalize HKEX market events into engine format
- Support licensed OMD feeds OR polling fallback
- Maintain interface consistency with other adapters

HKEX does NOT provide a public websocket.
This adapter is intentionally vendor-safe.
"""

import asyncio
import logging
import time
from typing import Callable, Dict, Optional

log = logging.getLogger("hkex.ws")

DEFAULT_POLL_INTERVAL = 5  # seconds


class HKEXWebSocket:
    def __init__(
        self,
        *,
        market: str = "HK",
        poll_interval: int = DEFAULT_POLL_INTERVAL,
        fetcher: Optional[Callable[[], Dict]] = None,
        on_event: Optional[Callable[[Dict], None]] = None,
        mode: str = "polling",  # "polling" | "vendor"
    ):
        """
        market: HK (equities), GEM, ETF, Warrant
        mode:
          - polling: delayed / dev / paper
          - vendor: licensed OMD-C / OMD-D feed wrapper
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
        log.info(f"Starting HKEX adapter (market={self.market}, mode={self.mode})")

        if self.mode == "vendor":
            await self._run_vendor()
        else:
            await self._run_polling()

    async def stop(self):
        self._running = False
        log.info("Stopping HKEX adapter")

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
                log.error(f"HKEX polling error: {e}")

            await asyncio.sleep(self.poll_interval)

    # ============================
    # Vendor mode (OMD wrapper)
    # ============================

    async def _run_vendor(self):
        """
        Placeholder for licensed HKEX OMD feed integration.
        Actual socket / FIX / multicast handling is vendor-specific.
        """
        log.warning("HKEX vendor mode enabled – waiting for external OMD feed")

        while self._running:
            await asyncio.sleep(1)

    # ============================
    # Default fetcher (stub)
    # ============================

    def _default_fetcher(self) -> Dict:
        """
        Replace with:
        - HKEX delayed REST snapshot
        - Vendor proxy
        - Internal simulator
        """

        return {
            "symbol": "0700.HK",
            "price": 312.40,
            "bid": 312.20,
            "ask": 312.60,
            "volume": 18_500_000,
            "market": self.market,
            "ts": int(time.time() * 1000),
        }

    # ============================
    # Normalization
    # ============================

    def _normalize(self, raw: Dict) -> Dict:
        return {
            "type": "ticker",
            "exchange": "HKEX",
            "market": raw.get("market", self.market),
            "symbol": raw["symbol"],
            "price": raw["price"],
            "bid": raw.get("bid"),
            "ask": raw.get("ask"),
            "volume": raw.get("volume"),
            "ts": raw["ts"],
            "source": "hkex",
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

    hkex = HKEXWebSocket(
        market="HK",
        poll_interval=10,
        on_event=handle,
    )

    asyncio.run(hkex.start())