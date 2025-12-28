"""
Alpaca WebSocket Adapter
-----------------------
Supports:
- Market data (stocks, crypto if enabled)
- Trade updates (orders, fills)
- Auto-reconnect
- Auth handshake
- Channel subscriptions

Requires:
- Python 3.9+
- websockets (pip install websockets)

No Alpaca SDK dependency.
"""

import asyncio
import json
import logging
import time
from typing import Callable, Dict, List, Optional

import websockets

log = logging.getLogger("alpaca.ws")


# ============================
# Defaults
# ============================

ALPACA_DATA_WS = "wss://stream.data.alpaca.markets/v2/sip"
ALPACA_TRADE_WS = "wss://paper-api.alpaca.markets/stream"

RECONNECT_DELAY = 5


# ============================
# Adapter
# ============================

class AlpacaWebSocket:
    def __init__(
        self,
        api_key: str,
        api_secret: str,
        *,
        data_ws_url: str = ALPACA_DATA_WS,
        trade_ws_url: str = ALPACA_TRADE_WS,
        on_data: Optional[Callable[[dict], None]] = None,
        on_trade: Optional[Callable[[dict], None]] = None,
        symbols: Optional[List[str]] = None,
        trades: bool = True,
        quotes: bool = True,
        bars: bool = False,
    ):
        self.api_key = api_key
        self.api_secret = api_secret

        self.data_ws_url = data_ws_url
        self.trade_ws_url = trade_ws_url

        self.on_data = on_data
        self.on_trade = on_trade

        self.symbols = symbols or []
        self.enable_trades = trades
        self.enable_quotes = quotes
        self.enable_bars = bars

        self._running = False
        self._tasks: List[asyncio.Task] = []

    # ============================
    # Public API
    # ============================

    async def start(self):
        self._running = True
        log.info("Starting Alpaca WebSocket adapter")

        if self.symbols:
            self._tasks.append(asyncio.create_task(self._run_data_ws()))

        self._tasks.append(asyncio.create_task(self._run_trade_ws()))

        await asyncio.gather(*self._tasks)

    async def stop(self):
        self._running = False
        log.info("Stopping Alpaca WebSocket adapter")
        for t in self._tasks:
            t.cancel()

    # ============================
    # Internal loops
    # ============================

    async def _run_data_ws(self):
        while self._running:
            try:
                async with websockets.connect(self.data_ws_url, ping_interval=20) as ws:
                    await self._auth(ws)
                    await self._subscribe_data(ws)

                    async for msg in ws:
                        for event in json.loads(msg):
                            if self.on_data:
                                self.on_data(event)

            except Exception as e:
                log.error(f"Data WS error: {e}")
                await asyncio.sleep(RECONNECT_DELAY)

    async def _run_trade_ws(self):
        while self._running:
            try:
                async with websockets.connect(self.trade_ws_url, ping_interval=20) as ws:
                    await self._auth(ws)

                    async for msg in ws:
                        data = json.loads(msg)
                        if self.on_trade:
                            self.on_trade(data)

            except Exception as e:
                log.error(f"Trade WS error: {e}")
                await asyncio.sleep(RECONNECT_DELAY)

    # ============================
    # Protocol helpers
    # ============================

    async def _auth(self, ws):
        payload = {
            "action": "auth",
            "key": self.api_key,
            "secret": self.api_secret,
        }
        await ws.send(json.dumps(payload))

        resp = json.loads(await ws.recv())
        if resp.get("status") != "authorized":
            raise RuntimeError(f"Alpaca auth failed: {resp}")

        log.info("Alpaca WS authenticated")

    async def _subscribe_data(self, ws):
        sub: Dict[str, List[str]] = {}

        if self.enable_trades:
            sub["trades"] = self.symbols
        if self.enable_quotes:
            sub["quotes"] = self.symbols
        if self.enable_bars:
            sub["bars"] = self.symbols

        payload = {
            "action": "subscribe",
            **sub,
        }

        await ws.send(json.dumps(payload))
        log.info(f"Subscribed to data streams: {sub}")


# ============================
# Example usage
# ============================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    def handle_market(event):
        print("DATA:", event)

    def handle_trade(event):
        print("TRADE:", event)

    ws = AlpacaWebSocket(
        api_key="YOUR_KEY",
        api_secret="YOUR_SECRET",
        symbols=["AAPL", "MSFT"],
        on_data=handle_market,
        on_trade=handle_trade,
    )

    asyncio.run(ws.start())