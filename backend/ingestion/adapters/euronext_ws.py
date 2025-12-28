"""
Euronext WebSocket Adapter
-------------------------
Purpose:
- Normalize Euronext market events into engine format
- Support licensed Optiq feeds OR simulated polling
- Maintain a consistent interface with other adapters

This adapter DOES NOT fake a public WebSocket.
It is intentionally vendor-agnostic and compliant.
"""

import asyncio
import logging
import time
from typing import Callable, Dict, Optional

log = logging.getLogger("euronext.ws")

DEFAULT_POLL_INTERVAL = 5  # seconds


class EuronextWebSocket:
    def __init__(
        self,
        *,
        venue: str = "PAR",  # PAR, AMS, BRU, LIS, DUB, OSL
        poll_interval: int = DEFAULT_POLL_INTERVAL,
        fetcher: Optional[Callable[[], Dict]] = None,
        on_event: Optional[Callable[[Dict], None]] = None,
        mode: str = "polling",  # "polling" | "vendor"
    ):
        """
        venue: Euronext venue code
        mode:
          - polling: REST / delayed data
          - vendor: licensed Optiq socket (wrapped externally)
        fetcher: custom data fetcher
        on_event: callback into engine
        """

        self.venue = venue
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
        log.info(f"Starting Euronext adapter ({self.venue}, mode={self.mode})")

        if self.mode == "vendor":
            await self._run_vendor()
        else:
            await self._run_polling()

    async def stop(self):
        self._running = False
        log.info("Stopping Euronext adapter")

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
                log.error(f"Euronext polling error: {e}")

            await asyncio.sleep(self.poll_interval)

    # ============================
    # Vendor mode (Optiq wrapper)
    # ============================

    async def _run_vendor(self):
        """
        Placeholder for licensed Optiq feed integration.
        The actual socket handling is vendor-specific.
        """
        log.warning("Vendor mode enabled – waiting for external Optiq feed")

        while self._running:
            await asyncio.sleep(1)

    # ============================
    # Default fetcher (stub)
    # ============================

    def _default_fetcher(self) -> Dict:
        """
        Replace with:
        - Euronext delayed REST
        - Vendor proxy
        - Internal market simulator
        """

        return {
            "symbol": "AIR",
            "price": 132.45,
            "bid": 132.40,
            "ask": 132.50,
            "volume": 125_000,
            "venue": self.venue,
            "ts": int(time.time() * 1000),
        }

    # ============================
    # Normalization
    # ============================

    def _normalize(self, raw: Dict) -> Dict:
        return {
            "type": "ticker",
            "exchange": "EURONEXT",
            "venue": self.venue,
            "symbol": raw["symbol"],
            "price": raw["price"],
            "bid": raw.get("bid"),
            "ask": raw.get("ask"),
            "volume": raw.get("volume"),
            "ts": raw["ts"],
            "source": "euronext",
        }


# ============================
# Example usage
# ============================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    def handle(evt):
        print(
            f"{evt['venue']} {evt['symbol']} "
            f"{evt['price']} @ {evt['ts']}"
        )

    ws = EuronextWebSocket(
        venue="PAR",
        poll_interval=10,
        on_event=handle,
    )

    asyncio.run(ws.start())