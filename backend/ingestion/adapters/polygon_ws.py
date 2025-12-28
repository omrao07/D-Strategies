"""
Polygon WebSocket Adapter
-------------------------
Supports:
- Stocks, crypto, forex streams
- Trades, quotes, aggregates
- Async, SDK-free
- Auto reconnect
- Engine-normalized events

Docs:
https://polygon.io/docs/websockets
"""

import asyncio
import json
import logging
from typing import Callable, Dict, List, Optional

import websockets

log = logging.getLogger("polygon.ws")

POLYGON_WS_URL = "wss://socket.polygon.io/stocks"
RECONNECT_DELAY = 5


class PolygonWebSocket:
    def __init__(
        self,
        *,
        api_key: str,
        symbols: List[str],
        trades: bool = True,
        quotes: bool = False,
        aggregates: bool = False,
        agg_interval: int = 1,              # seconds
        on_event: Optional[Callable[[Dict], None]] = None,
    ):
        """
        symbols:
          - Stocks: ["AAPL", "MSFT"]
          - Crypto: ["X:BTCUSD"]
          - Forex: ["C:EURUSD"]

        Event callbacks receive normalized dicts.
        """

        self.api_key = api_key
        self.symbols = symbols

        self.trades = trades
        self.quotes = quotes
        self.aggregates = aggregates
        self.agg_interval = agg_interval

        self.on_event = on_event
        self._running = False

    # ============================
    # Lifecycle
    # ============================

    async def start(self):
        self._running = True
        log.info("Starting Polygon WebSocket adapter")

        while self._running:
            try:
                async with websockets.connect(
                    POLYGON_WS_URL,
                    ping_interval=20,
                    max_queue=2048,
                ) as ws:
                    await self._auth(ws)
                    await self._subscribe(ws)

                    async for msg in ws:
                        events = json.loads(msg)
                        for evt in events:
                            norm = self._normalize(evt)
                            if norm and self.on_event:
                                self.on_event(norm)

            except Exception as e:
                log.error(f"Polygon WS error: {e}")
                await asyncio.sleep(RECONNECT_DELAY)

    async def stop(self):
        self._running = False
        log.info("Stopping Polygon WebSocket adapter")

    # ============================
    # Protocol helpers
    # ============================

    async def _auth(self, ws):
        msg = {
            "action": "auth",
            "params": self.api_key,
        }
        await ws.send(json.dumps(msg))
        log.info("Polygon WS auth sent")

    async def _subscribe(self, ws):
        channels: List[str] = []

        for sym in self.symbols:
            if self.trades:
                channels.append(f"T.{sym}")
            if self.quotes:
                channels.append(f"Q.{sym}")
            if self.aggregates:
                channels.append(f"A.{self.agg_interval}.{sym}")

        sub = {
            "action": "subscribe",
            "params": ",".join(channels),
        }

        await ws.send(json.dumps(sub))
        log.info(f"Subscribed to Polygon channels: {channels}")

    # ============================
    # Normalization
    # ============================

    def _normalize(self, evt: Dict) -> Optional[Dict]:
        etype = evt.get("ev")

        # Trade
        if etype == "T":
            return {
                "type": "trade",
                "exchange": "POLYGON",
                "symbol": evt["sym"],
                "price": evt["p"],
                "qty": evt["s"],
                "ts": evt["t"],
                "source": "polygon",
            }

        # Quote
        if etype == "Q":
            return {
                "type": "quote",
                "exchange": "POLYGON",
                "symbol": evt["sym"],
                "bid": evt["bp"],
                "ask": evt["ap"],
                "bid_size": evt.get("bs"),
                "ask_size": evt.get("as"),
                "ts": evt["t"],
                "source": "polygon",
            }

        # Aggregate bar
        if etype == "A":
            return {
                "type": "bar",
                "exchange": "POLYGON",
                "symbol": evt["sym"],
                "open": evt["o"],
                "high": evt["h"],
                "low": evt["l"],
                "close": evt["c"],
                "volume": evt["v"],
                "start": evt["s"],
                "end": evt["e"],
                "source": "polygon",
            }

        return None


# ============================
# Example usage
# ============================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    def handle(evt):
        print(evt)

    ws = PolygonWebSocket(
        api_key="YOUR_POLYGON_API_KEY",
        symbols=["AAPL", "MSFT"],
        trades=True,
        quotes=True,
        aggregates=False,
        on_event=handle,
    )

    asyncio.run(ws.start())