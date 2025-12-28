"""
Shanghai–Hong Kong Stock Connect Adapter
----------------------------------------
Purpose:
- Fetch Northbound / Southbound Connect flows
- Normalize into engine events
- Polling-based (no public WS exists)

Data sources (pluggable):
- HKEX Northbound/Southbound summaries
- SSE trading stats
- Vendor REST endpoints (Wind, Tushare, etc.)

This adapter is intentionally vendor-agnostic.
"""

import asyncio
import logging
import time
from typing import Callable, Dict, Optional

import requests

log = logging.getLogger("connect.shhk")

DEFAULT_POLL_INTERVAL = 30  # seconds


class SHHKConnectAdapter:
    def __init__(
        self,
        *,
        poll_interval: int = DEFAULT_POLL_INTERVAL,
        fetcher: Optional[Callable[[], Dict]] = None,
        on_event: Optional[Callable[[Dict], None]] = None,
    ):
        """
        fetcher: custom function returning raw connect data
        on_event: callback to publish normalized events
        """

        self.poll_interval = poll_interval
        self.fetcher = fetcher or self._default_fetcher
        self.on_event = on_event

        self._running = False

    # ============================
    # Lifecycle
    # ============================

    async def start(self):
        self._running = True
        log.info("Starting SH–HK Connect adapter")

        while self._running:
            try:
                raw = self.fetcher()
                event = self._normalize(raw)

                if self.on_event:
                    self.on_event(event)

            except Exception as e:
                log.error(f"SHHK fetch error: {e}")

            await asyncio.sleep(self.poll_interval)

    async def stop(self):
        self._running = False
        log.info("Stopping SH–HK Connect adapter")

    # ============================
    # Fetchers
    # ============================

    def _default_fetcher(self) -> Dict:
        """
        Placeholder fetcher.
        Replace with:
        - HKEX JSON endpoint
        - Tushare pro
        - Wind REST
        """

        # Example synthetic payload
        return {
            "northbound": {
                "net_flow": 3_200_000_000,
                "buy": 18_000_000_000,
                "sell": 14_800_000_000,
            },
            "southbound": {
                "net_flow": -1_100_000_000,
                "buy": 9_500_000_000,
                "sell": 10_600_000_000,
            },
            "ts": int(time.time() * 1000),
        }

    # ============================
    # Normalization
    # ============================

    def _normalize(self, raw: Dict) -> Dict:
        """
        Convert raw connect data into engine event
        """

        return {
            "type": "connect_flow",
            "region": "CNHK",
            "northbound": {
                "net": raw["northbound"]["net_flow"],
                "buy": raw["northbound"]["buy"],
                "sell": raw["northbound"]["sell"],
            },
            "southbound": {
                "net": raw["southbound"]["net_flow"],
                "buy": raw["southbound"]["buy"],
                "sell": raw["southbound"]["sell"],
            },
            "ts": raw["ts"],
            "source": "shhk_connect",
        }


# ============================
# Example usage
# ============================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    def handle_event(evt):
        print(
            "CONNECT:",
            "NB net =", evt["northbound"]["net"],
            "SB net =", evt["southbound"]["net"],
        )

    adapter = SHHKConnectAdapter(
        poll_interval=15,
        on_event=handle_event,
    )

    asyncio.run(adapter.start())