"""
Zerodha Kite Ticker Adapter
--------------------------
Supports:
- NSE / BSE / MCX instruments
- LTP / Quote / Full (market depth)
- Auto reconnect
- SDK-free
- Engine-normalized events

Docs:
https://kite.trade/docs/connect/v3/websocket/
"""

import asyncio
import json
import logging
from typing import Callable, Dict, List, Optional

import websockets

log = logging.getLogger("zerodha.ticker")

KITE_TICKER_URL = "wss://ws.kite.trade"
RECONNECT_DELAY = 5


# Subscription modes
MODE_LTP = "ltp"
MODE_QUOTE = "quote"
MODE_FULL = "full"


class ZerodhaTicker:
    def __init__(
        self,
        *,
        api_key: str,
        access_token: str,
        instrument_tokens: List[int],
        mode: str = MODE_LTP,
        on_event: Optional[Callable[[Dict], None]] = None,
    ):
        """
        instrument_tokens:
          - NSE: Reliance = 738561
          - NIFTY = 256265
          - BANKNIFTY = 260105

        mode:
          - ltp
          - quote
          - full
        """

        self.api_key = api_key
        self.access_token = access_token
        self.instrument_tokens = instrument_tokens
        self.mode = mode
        self.on_event = on_event

        self._running = False

    # ============================
    # Lifecycle
    # ============================

    async def start(self):
        self._running = True
        log.info("Starting Zerodha Kite Ticker")

        url = f"{KITE_TICKER_URL}?api_key={self.api_key}&access_token={self.access_token}"

        while self._running:
            try:
                async with websockets.connect(
                    url,
                    ping_interval=20,
                    max_queue=2048,
                ) as ws:
                    await self._subscribe(ws)

                    async for msg in ws:
                        if isinstance(msg, bytes):
                            # Zerodha sometimes sends binary frames (heartbeat)
                            continue

                        payload = json.loads(msg)
                        events = self._normalize(payload)

                        for evt in events:
                            if self.on_event:
                                self.on_event(evt)

            except Exception as e:
                log.error(f"Zerodha WS error: {e}")
                await asyncio.sleep(RECONNECT_DELAY)

    async def stop(self):
        self._running = False
        log.info("Stopping Zerodha Kite Ticker")

    # ============================
    # Protocol helpers
    # ============================

    async def _subscribe(self, ws):
        # Subscribe instruments
        sub = {
            "a": "subscribe",
            "v": self.instrument_tokens,
        }
        await ws.send(json.dumps(sub))

        # Set mode
        mode_msg = {
            "a": "mode",
            "v": [self.mode, self.instrument_tokens],
        }
        await ws.send(json.dumps(mode_msg))

        log.info(
            f"Subscribed to Zerodha instruments {self.instrument_tokens} "
            f"with mode={self.mode}"
        )

    # ============================
    # Normalization
    # ============================

    def _normalize(self, msg: Dict) -> List[Dict]:
        """
        Zerodha sends arrays of ticks
        """
        if not isinstance(msg, list):
            return []

        events: List[Dict] = []

        for tick in msg:
            token = tick.get("instrument_token")

            # LTP
            if "last_price" in tick:
                events.append({
                    "type": "tick",
                    "exchange": "ZERODHA",
                    "instrument_token": token,
                    "price": tick.get("last_price"),
                    "volume": tick.get("volume_traded"),
                    "ts": tick.get("last_trade_time"),
                    "source": "zerodha",
                })

            # Quote / depth
            if self.mode == MODE_FULL and "depth" in tick:
                events.append({
                    "type": "orderbook",
                    "exchange": "ZERODHA",
                    "instrument_token": token,
                    "bids": tick["depth"]["buy"],
                    "asks": tick["depth"]["sell"],
                    "ts": tick.get("exchange_timestamp"),
                    "source": "zerodha",
                })

        return events


# ============================
# Example usage
# ============================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    def handle(evt):
        print(evt)

    ticker = ZerodhaTicker(
        api_key="YOUR_API_KEY",
        access_token="YOUR_ACCESS_TOKEN",
        instrument_tokens=[256265, 260105],  # NIFTY, BANKNIFTY
        mode=MODE_LTP,
        on_event=handle,
    )

    asyncio.run(ticker.start())