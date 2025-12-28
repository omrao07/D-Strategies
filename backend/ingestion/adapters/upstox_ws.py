"""
Upstox WebSocket Adapter
-----------------------
Supports:
- Market data streaming (LTP / quote / depth)
- NSE / BSE / MCX instruments
- OAuth token auth
- Auto reconnect
- Engine-normalized events

Docs:
https://upstox.com/developer/api-documentation/websocket-feed/
"""

import asyncio
import json
import logging
from typing import Callable, Dict, List, Optional

import websockets

log = logging.getLogger("upstox.ws")

UPSTOX_WS_URL = "wss://api.upstox.com/v2/feed/market-data-feed"
RECONNECT_DELAY = 5


class UpstoxWebSocket:
    def __init__(
        self,
        *,
        access_token: str,
        instruments: List[str],
        mode: str = "ltpc",  # ltpc | full | option_chain
        on_event: Optional[Callable[[Dict], None]] = None,
    ):
        """
        instruments examples:
        - NSE_EQ|INE009A01021
        - NSE_FO|BANKNIFTY24JANFUT
        - MCX_FO|CRUDEOIL24JANFUT

        mode:
        - ltpc        : Last traded price + close
        - full        : Quote + depth
        - option_chain: Options feed
        """

        self.access_token = access_token
        self.instruments = instruments
        self.mode = mode
        self.on_event = on_event

        self._running = False

    # ============================
    # Lifecycle
    # ============================

    async def start(self):
        self._running = True
        log.info("Starting Upstox WebSocket adapter")

        headers = {
            "Authorization": f"Bearer {self.access_token}",
        }

        while self._running:
            try:
                async with websockets.connect(
                    UPSTOX_WS_URL,
                    extra_headers=headers,
                    ping_interval=20,
                    max_queue=2048,
                ) as ws:
                    await self._subscribe(ws)

                    async for msg in ws:
                        payload = json.loads(msg)
                        event = self._normalize(payload)

                        if event and self.on_event:
                            self.on_event(event)

            except Exception as e:
                log.error(f"Upstox WS error: {e}")
                await asyncio.sleep(RECONNECT_DELAY)

    async def stop(self):
        self._running = False
        log.info("Stopping Upstox WebSocket adapter")

    # ============================
    # Protocol helpers
    # ============================

    async def _subscribe(self, ws):
        sub = {
            "guid": "engine-feed",
            "method": "sub",
            "data": {
                "mode": self.mode,
                "instrumentKeys": self.instruments,
            },
        }

        await ws.send(json.dumps(sub))
        log.info(f"Subscribed to Upstox instruments: {self.instruments}")

    # ============================
    # Normalization
    # ============================

    def _normalize(self, msg: Dict) -> Optional[Dict]:
        """
        Normalize Upstox payload into engine format
        """

        feeds = msg.get("feeds")
        if not feeds:
            return None

        events = []

        for key, data in feeds.items():
            ltpc = data.get("ltpc")
            depth = data.get("depth")

            if ltpc:
                events.append({
                    "type": "tick",
                    "exchange": "UPSTOX",
                    "symbol": key,
                    "price": ltpc.get("ltp"),
                    "close": ltpc.get("cp"),
                    "ts": ltpc.get("ltt"),
                    "source": "upstox",
                })

            if depth:
                events.append({
                    "type": "orderbook",
                    "exchange": "UPSTOX",
                    "symbol": key,
                    "bids": depth.get("buy"),
                    "asks": depth.get("sell"),
                    "ts": data.get("timestamp"),
                    "source": "upstox",
                })

        # Emit one by one (engine-friendly)
        for evt in events:
            if self.on_event:
                self.on_event(evt)

        return None


# ============================
# Example usage
# ============================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    def handle(evt):
        print(evt)

    ws = UpstoxWebSocket(
        access_token="YOUR_ACCESS_TOKEN",
        instruments=[
            "NSE_EQ|INE009A01021",       # Reliance
            "NSE_FO|NIFTY24JANFUT",
        ],
        mode="ltpc",
        on_event=handle,
    )

    asyncio.run(ws.start())