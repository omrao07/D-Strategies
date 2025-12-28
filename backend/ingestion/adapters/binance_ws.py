"""
Binance WebSocket Adapter
------------------------
Supports:
- Trade stream
- Book ticker (best bid/ask)
- Kline (candles)
- Auto reconnect
- No Binance SDK dependency

Requires:
- Python 3.9+
- websockets (pip install websockets)
"""

import asyncio
import json
import logging
from typing import Callable, Dict, List, Optional

import websockets

log = logging.getLogger("binance.ws")

BINANCE_WS_BASE = "wss://stream.binance.com:9443/stream"
RECONNECT_DELAY = 5


class BinanceWebSocket:
    def __init__(
        self,
        symbols: List[str],
        *,
        trades: bool = True,
        book_ticker: bool = True,
        klines: Optional[str] = None,   # e.g. "1m", "5m", "1h"
        on_message: Optional[Callable[[dict], None]] = None,
    ):
        """
        symbols: ["BTCUSDT", "ETHUSDT"]
        klines: "1m", "5m", "1h", "1d" or None
        """

        self.symbols = [s.lower() for s in symbols]
        self.trades = trades
        self.book_ticker = book_ticker
        self.klines = klines
        self.on_message = on_message

        self._running = False

    # ============================
    # Public API
    # ============================

    async def start(self):
        self._running = True
        log.info("Starting Binance WebSocket adapter")

        while self._running:
            try:
                url = self._build_url()
                async with websockets.connect(url, ping_interval=20) as ws:
                    log.info("Connected to Binance WS")

                    async for msg in ws:
                        payload = json.loads(msg)
                        data = payload.get("data", payload)

                        if self.on_message:
                            self.on_message(data)

            except Exception as e:
                log.error(f"Binance WS error: {e}")
                await asyncio.sleep(RECONNECT_DELAY)

    async def stop(self):
        self._running = False
        log.info("Stopping Binance WebSocket adapter")

    # ============================
    # Helpers
    # ============================

    def _build_url(self) -> str:
        streams: List[str] = []

        for sym in self.symbols:
            if self.trades:
                streams.append(f"{sym}@trade")
            if self.book_ticker:
                streams.append(f"{sym}@bookTicker")
            if self.klines:
                streams.append(f"{sym}@kline_{self.klines}")

        stream_param = "/".join(streams)
        return f"{BINANCE_WS_BASE}?streams={stream_param}"


# ============================
# Example usage
# ============================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    def handle_event(event: dict):
        etype = event.get("e")
        if etype == "trade":
            print("TRADE:", event["s"], event["p"], event["q"])
        elif etype == "bookTicker":
            print("BOOK:", event["s"], event["b"], event["a"])
        elif etype == "kline":
            k = event["k"]
            print("KLINE:", k["s"], k["i"], k["c"])

    ws = BinanceWebSocket(
        symbols=["BTCUSDT", "ETHUSDT"],
        klines="1m",
        on_message=handle_event,
    )

    asyncio.run(ws.start())