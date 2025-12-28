"""
OANDA Streaming Adapter
----------------------
Supports:
- Pricing stream (ticks)
- Transaction stream (orders, fills)
- Practice & live accounts
- Auto reconnect
- SDK-free (pure REST streaming)

Docs:
https://developer.oanda.com/rest-live-v20/streaming/
"""

import asyncio
import json
import logging
from typing import Callable, Dict, List, Optional

import aiohttp

log = logging.getLogger("oanda.stream")

PRACTICE_PRICING_URL = "https://stream-fxpractice.oanda.com/v3/accounts/{account_id}/pricing/stream"
PRACTICE_TX_URL = "https://stream-fxpractice.oanda.com/v3/accounts/{account_id}/transactions/stream"

LIVE_PRICING_URL = "https://stream-fxtrade.oanda.com/v3/accounts/{account_id}/pricing/stream"
LIVE_TX_URL = "https://stream-fxtrade.oanda.com/v3/accounts/{account_id}/transactions/stream"

RECONNECT_DELAY = 5


class OandaStream:
    def __init__(
        self,
        *,
        account_id: str,
        access_token: str,
        instruments: List[str],
        practice: bool = True,
        on_price: Optional[Callable[[Dict], None]] = None,
        on_transaction: Optional[Callable[[Dict], None]] = None,
    ):
        """
        instruments: ["EUR_USD", "USD_JPY"]
        """

        self.account_id = account_id
        self.access_token = access_token
        self.instruments = instruments
        self.practice = practice

        self.on_price = on_price
        self.on_transaction = on_transaction

        self._running = False

    # ============================
    # Lifecycle
    # ============================

    async def start(self):
        self._running = True
        log.info("Starting OANDA stream")

        tasks = [
            asyncio.create_task(self._run_pricing_stream()),
            asyncio.create_task(self._run_transaction_stream()),
        ]

        await asyncio.gather(*tasks)

    async def stop(self):
        self._running = False
        log.info("Stopping OANDA stream")

    # ============================
    # Streaming loops
    # ============================

    async def _run_pricing_stream(self):
        url = (PRACTICE_PRICING_URL if self.practice else LIVE_PRICING_URL).format(
            account_id=self.account_id
        )

        headers = {
            "Authorization": f"Bearer {self.access_token}",
        }

        params = {
            "instruments": ",".join(self.instruments),
        }

        while self._running:
            try:
                async with aiohttp.ClientSession(headers=headers) as session:
                    async with session.get(url, params=params, timeout=None) as resp:
                        async for line in resp.content:
                            if not line:
                                continue

                            msg = json.loads(line.decode())
                            if msg.get("type") == "PRICE":
                                if self.on_price:
                                    self.on_price(self._normalize_price(msg))

            except Exception as e:
                log.error(f"OANDA pricing stream error: {e}")
                await asyncio.sleep(RECONNECT_DELAY)

    async def _run_transaction_stream(self):
        url = (PRACTICE_TX_URL if self.practice else LIVE_TX_URL).format(
            account_id=self.account_id
        )

        headers = {
            "Authorization": f"Bearer {self.access_token}",
        }

        while self._running:
            try:
                async with aiohttp.ClientSession(headers=headers) as session:
                    async with session.get(url, timeout=None) as resp:
                        async for line in resp.content:
                            if not line:
                                continue

                            msg = json.loads(line.decode())
                            if self.on_transaction:
                                self.on_transaction(self._normalize_tx(msg))

            except Exception as e:
                log.error(f"OANDA transaction stream error: {e}")
                await asyncio.sleep(RECONNECT_DELAY)

    # ============================
    # Normalization
    # ============================

    @staticmethod
    def _normalize_price(msg: Dict) -> Dict:
        return {
            "type": "tick",
            "exchange": "OANDA",
            "symbol": msg["instrument"],
            "bid": float(msg["bids"][0]["price"]),
            "ask": float(msg["asks"][0]["price"]),
            "ts": msg["time"],
            "source": "oanda",
        }

    @staticmethod
    def _normalize_tx(msg: Dict) -> Dict:
        return {
            "type": "transaction",
            "exchange": "OANDA",
            "tx_type": msg.get("type"),
            "id": msg.get("id"),
            "instrument": msg.get("instrument"),
            "units": msg.get("units"),
            "price": msg.get("price"),
            "reason": msg.get("reason"),
            "ts": msg.get("time"),
            "source": "oanda",
        }


# ============================
# Example usage
# ============================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    def on_tick(t):
        print("TICK:", t["symbol"], t["bid"], t["ask"])

    def on_tx(t):
        print("TX:", t["tx_type"], t.get("instrument"))

    stream = OandaStream(
        account_id="YOUR_ACCOUNT_ID",
        access_token="YOUR_TOKEN",
        instruments=["EUR_USD", "USD_JPY"],
        practice=True,
        on_price=on_tick,
        on_transaction=on_tx,
    )

    asyncio.run(stream.start())