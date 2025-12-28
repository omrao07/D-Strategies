"""
Coinbase WebSocket Adapter
-------------------------
Supports:
- Trades
- Ticker
- Level-2 order book
- Auto reconnect
- No SDK dependency

Docs:
https://docs.cloud.coinbase.com/advanced-trade-api/docs/ws-overview

Requires:
- Python 3.9+
- websockets
"""

import asyncio
import json
import logging
from typing import Callable, Dict, List, Optional

import websockets

log = logging.getLogger("coinbase.ws")

COINBASE_WS_URL = "wss://advanced-trade-ws.coinbase.com"
RECONNECT_DELAY = 5


class CoinbaseWebSocket:
    def __init__(
        self,
        products: List[str],
        *,
        trades: bool = True,
        ticker: bool = True,
        level2: bool = False,
        on_message: Optional[Callable[[dict], None]] = None,
    ):
        """
        products: ["BTC-USD", "ETH-USD"]
        """

        self.products = products
        self.trades = trades
        self.ticker = ticker
        self.level2 = level2
        self.on_message = on_message

        self._running = False

    # ============================
    # Public API
    # ============================

    async def start(self):
        self._running = True
        log.info("Starting Coinbase WebSocket adapter")

        while self._running:
            try:
                async with websockets.connect(
                    COINBASE_WS_URL,
                    ping_interval=20,
                    max_queue=1024,
                ) as ws:
                    log.info("Connected to Coinbase WS")

                    await self._subscribe(ws)

                    async for msg in ws:
                        payload = json.loads(msg)

                        if self.on_message:
                            self.on_message(payload)

            except Exception as e:
                log.error(f"Coinbase WS error: {e}")
                await asyncio.sleep(RECONNECT_DELAY)

    async def stop(self):
        self._running = False
        log.info("Stopping Coinbase WebSocket adapter")

    # ============================
    # Internal helpers
    # ============================

    async def _subscribe(self, ws):
        channels = []

        if self.trades:
            channels.append("market_trades")
        if self.ticker:
            channels.append("ticker")
        if self.level2:
            channels.append("level2")

        msg = {
            "type": "subscribe",
            "product_ids": self.products,
            "channel": channels,
        }

        await ws.send(json.dumps(msg))
        log.info(f"Subscribed to channels: {channels}")

    # ============================
    # Optional normalizer
    # ============================

    @staticmethod
    def normalize(event: dict) -> Dict:
        """
        Convert Coinbase events into engine-friendly format
        """
        etype = event.get("type")

        if etype == "market_trades":
            trade = event["trades"][0]
            return {
                "type": "trade",
                "symbol": trade["product_id"],
                "price": float(trade["price"]),
                "qty": float(trade["size"]),
                "side": trade["side"],
                "ts": trade["time"],
                "source": "coinbase",
            }

        if etype == "ticker":
            return {
                "type": "ticker",
                "symbol": event["product_id"],
                "bid": float(event["best_bid"]),
                "ask": float(event["best_ask"]),
                "price": float(event["price"]),
                "ts": event["time"],
                "source": "coinbase",
            }

        if etype == "l2update":
            return {
                "type": "orderbook",
                "symbol": event["product_id"],
                "changes": event["changes"],
                "ts": event["time"],
                "source": "coinbase",
            }

        return event


# ============================
# Example usage
# ============================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    def handle_event(evt):
        etype = evt.get("type")
        if etype == "market_trades":
            print("TRADE:", evt["trades"][0]["product_id"])
        elif etype == "ticker":
            print("TICKER:", evt["product_id"], evt["price"])

    ws = CoinbaseWebSocket(
        products=["BTC-USD", "ETH-USD"],
        level2=True,
        on_message=handle_event,
    )

    asyncio.run(ws.start())