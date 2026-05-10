"""
MarketDataService — live and historical market data for Indian equities.

Data hierarchy (most-preferred → fallback):
  1. Zerodha KiteConnect WebSocket / REST (live)
  2. Redis cache (last-written bar)
  3. Synthetic / mock data (for paper-trading / CI environments)

Redis keys used:
  market:india_vix              — scalar float stored as string
  market:fo_ban_list            — JSON list of F&O-banned symbols
  market:circuit_breakers       — JSON dict of circuit-breaker status
  live:bars:{symbol}            — Redis Stream of 1-min OHLCV bars
  live:quote:{symbol}           — JSON hash of latest quote
"""
from __future__ import annotations

import json
import logging
import time
from datetime import date, datetime
from typing import Any, Callable, Dict, List, Optional

from backend.live_engine.config import (
    REDIS_HOST,
    REDIS_PORT,
    REDIS_PASSWORD,
    ZERODHA_ACCESS_TOKEN,
    ZERODHA_API_KEY,
    FOB_API_URL,
    NSE_CIRCUIT_BREAKER_URL,
)

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional heavy dependencies — all wrapped so the module loads even without
# ---------------------------------------------------------------------------
try:
    import redis as _redis_mod
    _redis_client = _redis_mod.Redis(
        host=REDIS_HOST,
        port=REDIS_PORT,
        password=REDIS_PASSWORD,
        decode_responses=True,
    )
    _HAS_REDIS = True
except Exception:
    _redis_client = None  # type: ignore[assignment]
    _HAS_REDIS = False

try:
    import pandas as pd
    _HAS_PANDAS = True
except ImportError:
    pd = None  # type: ignore[assignment]
    _HAS_PANDAS = False

try:
    from kiteconnect import KiteConnect, KiteTicker  # type: ignore
    _kite_obj: Optional[KiteConnect] = None
    if ZERODHA_API_KEY and ZERODHA_ACCESS_TOKEN:
        _kite_obj = KiteConnect(api_key=ZERODHA_API_KEY)
        _kite_obj.set_access_token(ZERODHA_ACCESS_TOKEN)
    _HAS_KITE = True
except Exception:
    KiteConnect = None  # type: ignore[assignment,misc]
    KiteTicker = None   # type: ignore[assignment,misc]
    _kite_obj = None
    _HAS_KITE = False

try:
    import httpx as _httpx
    _HAS_HTTPX = True
except ImportError:
    _httpx = None  # type: ignore[assignment]
    _HAS_HTTPX = False

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _r_get(key: str) -> Optional[str]:
    if not _HAS_REDIS or _redis_client is None:
        return None
    try:
        return _redis_client.get(key)  # type: ignore[return-value]
    except Exception as exc:
        log.warning("Redis GET %s failed: %s", key, exc)
        return None


def _r_set(key: str, value: str, ex: Optional[int] = None) -> None:
    if not _HAS_REDIS or _redis_client is None:
        return
    try:
        _redis_client.set(key, value, ex=ex)
    except Exception as exc:
        log.warning("Redis SET %s failed: %s", key, exc)


def _r_xadd(stream: str, payload: Dict[str, Any]) -> None:
    if not _HAS_REDIS or _redis_client is None:
        return
    try:
        _redis_client.xadd(stream, {"json": json.dumps(payload)}, maxlen=10_000)
    except Exception as exc:
        log.warning("Redis XADD %s failed: %s", stream, exc)


def _mock_quote(symbol: str) -> Dict[str, Any]:
    """Return a deterministic mock quote — useful for paper trading / CI."""
    import hashlib
    seed = int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16) % 100_000
    px = 500.0 + (seed % 3000)
    return {
        "symbol": symbol,
        "last_price": px,
        "open": px * 0.99,
        "high": px * 1.01,
        "low": px * 0.98,
        "close": px,
        "volume": 100_000 + seed,
        "ts": int(time.time()),
        "mock": True,
    }


# ---------------------------------------------------------------------------
# Main service class
# ---------------------------------------------------------------------------

class MarketDataService:
    """
    Provides live quotes, OHLCV history, VIX, F&O ban list, circuit-breaker
    status, WebSocket tick subscriptions, and Redis bar publishing.

    Usage::

        svc = MarketDataService()
        quote = svc.get_live_quote("RELIANCE")
        df    = svc.get_ohlcv_history("TCS", date(2023, 1, 1), date(2024, 1, 1))
        vix   = svc.get_india_vix()
    """

    def __init__(self) -> None:
        self._kite = _kite_obj
        self._ticker: Any = None  # KiteTicker instance
        self._tick_callbacks: List[Callable] = []
        self._instruments_cache: List[Dict[str, Any]] = []
        self._instruments_cache_ts: float = 0.0

    def _get_instruments(self) -> List[Dict[str, Any]]:
        """Return NSE instrument list, refreshing at most once per hour."""
        now = time.time()
        if self._kite is not None and (now - self._instruments_cache_ts) > 3600:
            try:
                self._instruments_cache = self._kite.instruments("NSE")
                self._instruments_cache_ts = now
            except Exception as exc:
                log.warning("instruments() fetch failed: %s", exc)
        return self._instruments_cache

    # ------------------------------------------------------------------
    # Live quotes
    # ------------------------------------------------------------------

    def get_live_quote(self, symbol: str) -> Dict[str, Any]:
        """
        Fetch the latest quote for *symbol*.

        Priority: KiteConnect REST → Redis cached quote → mock.
        """
        symbol = symbol.upper()

        # 1. KiteConnect
        if self._kite is not None:
            try:
                ins = f"NSE:{symbol}"
                resp = self._kite.quote([ins])
                data = resp.get(ins, {})
                if data:
                    quote = {
                        "symbol": symbol,
                        "last_price": float(data.get("last_price", 0)),
                        "open": float(data.get("ohlc", {}).get("open", 0)),
                        "high": float(data.get("ohlc", {}).get("high", 0)),
                        "low": float(data.get("ohlc", {}).get("low", 0)),
                        "close": float(data.get("ohlc", {}).get("close", 0)),
                        "volume": int(data.get("volume", 0)),
                        "ts": int(time.time()),
                    }
                    # Cache in Redis for downstream consumers
                    _r_set(f"live:quote:{symbol}", json.dumps(quote), ex=120)
                    return quote
            except Exception as exc:
                log.warning("KiteConnect quote fetch failed for %s: %s", symbol, exc)

        # 2. Redis cache
        cached = _r_get(f"live:quote:{symbol}")
        if cached:
            try:
                return json.loads(cached)
            except Exception:
                pass

        # 3. Mock fallback
        return _mock_quote(symbol)

    def get_multi_quote(self, symbols: List[str]) -> Dict[str, Dict[str, Any]]:
        """
        Batch quote fetch.  Calls KiteConnect with all symbols in one request.
        Falls back to individual ``get_live_quote`` per symbol on error.
        """
        symbols = [s.upper() for s in symbols]

        if self._kite is not None:
            try:
                instruments = [f"NSE:{s}" for s in symbols]
                resp = self._kite.quote(instruments)
                out: Dict[str, Dict[str, Any]] = {}
                for s in symbols:
                    ins = f"NSE:{s}"
                    data = resp.get(ins, {})
                    if data:
                        out[s] = {
                            "symbol": s,
                            "last_price": float(data.get("last_price", 0)),
                            "open": float(data.get("ohlc", {}).get("open", 0)),
                            "high": float(data.get("ohlc", {}).get("high", 0)),
                            "low": float(data.get("ohlc", {}).get("low", 0)),
                            "close": float(data.get("ohlc", {}).get("close", 0)),
                            "volume": int(data.get("volume", 0)),
                            "ts": int(time.time()),
                        }
                    else:
                        out[s] = _mock_quote(s)
                return out
            except Exception as exc:
                log.warning("KiteConnect multi-quote failed: %s", exc)

        return {s: self.get_live_quote(s) for s in symbols}

    # ------------------------------------------------------------------
    # Historical OHLCV
    # ------------------------------------------------------------------

    def get_ohlcv_history(
        self,
        symbol: str,
        from_date: date,
        to_date: date,
        interval: str = "day",
    ) -> "pd.DataFrame":  # type: ignore[name-defined]
        """
        Return historical OHLCV bars as a DataFrame with columns
        [date, open, high, low, close, volume].

        Tries Zerodha historical API first; falls back to a synthetic series.
        """
        if not _HAS_PANDAS:
            raise RuntimeError("pandas is required for get_ohlcv_history")

        symbol = symbol.upper()

        if self._kite is not None:
            try:
                # KiteConnect requires instrument_token — look it up
                instruments = self._get_instruments()
                token = None
                for inst in instruments:
                    if inst.get("tradingsymbol") == symbol:
                        token = inst["instrument_token"]
                        break

                if token is not None:
                    kite_interval_map = {
                        "minute": "minute",
                        "5minute": "5minute",
                        "15minute": "15minute",
                        "30minute": "30minute",
                        "60minute": "60minute",
                        "day": "day",
                    }
                    ki = kite_interval_map.get(interval, "day")
                    data = self._kite.historical_data(
                        token,
                        from_date=datetime.combine(from_date, datetime.min.time()),
                        to_date=datetime.combine(to_date, datetime.min.time()),
                        interval=ki,
                    )
                    if data:
                        df = pd.DataFrame(data)
                        df.rename(columns={"date": "date"}, inplace=True)
                        return df
            except Exception as exc:
                log.warning("KiteConnect history fetch failed for %s: %s", symbol, exc)

        # Synthetic fallback — flag clearly so callers can choose to reject
        log.warning("SYNTHETIC DATA: returning synthetic OHLCV for %s (no real data available)", symbol)

        import hashlib
        import numpy as np

        seed_int = int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16) % 10_000
        rng = np.random.default_rng(seed_int)
        n_days = (to_date - from_date).days
        dates = pd.bdate_range(start=from_date, end=to_date)[:n_days]
        closes = 1000.0 * np.exp(np.cumsum(rng.normal(0, 0.01, len(dates))))
        # Open = prior close with small gap; first bar opens at initial price
        prior_closes = np.concatenate([[closes[0]], closes[:-1]])
        opens = prior_closes * rng.uniform(0.997, 1.003, len(dates))
        highs = np.maximum(opens, closes) * rng.uniform(1.001, 1.015, len(dates))
        lows = np.minimum(opens, closes) * rng.uniform(0.985, 0.999, len(dates))
        vols = rng.integers(50_000, 5_000_000, len(dates))

        df = pd.DataFrame({
            "date": dates,
            "open": opens,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": vols,
        })
        df["synthetic"] = True  # sentinel column — callers should check this
        return df

    # ------------------------------------------------------------------
    # India VIX
    # ------------------------------------------------------------------

    def get_india_vix(self) -> float:
        """
        Return the current India VIX value.

        Priority: Redis ``market:india_vix`` → NSE live fetch → default 15.0.
        """
        cached = _r_get("market:india_vix")
        if cached:
            try:
                return float(cached)
            except Exception:
                pass

        # Try fetching from NSE
        if _HAS_HTTPX:
            try:
                headers = {
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36"
                    ),
                    "Accept": "application/json",
                    "Referer": "https://www.nseindia.com/",
                }
                with _httpx.Client(headers=headers, timeout=8.0, follow_redirects=True) as client:
                    resp = client.get("https://www.nseindia.com/api/allIndices")
                    data = resp.json()
                    for idx in data.get("data", []):
                        if "VIX" in idx.get("index", "").upper():
                            vix_val = float(idx.get("last", 15.0))
                            _r_set("market:india_vix", str(vix_val), ex=900)
                            return vix_val
            except Exception as exc:
                log.warning("NSE VIX fetch failed: %s", exc)

        return 15.0  # conservative default

    # ------------------------------------------------------------------
    # F&O ban list
    # ------------------------------------------------------------------

    def get_fo_ban_list(self) -> List[str]:
        """
        Return current F&O-banned securities.

        Priority: Redis ``market:fo_ban_list`` → NSE CSV fetch → empty list.
        """
        cached = _r_get("market:fo_ban_list")
        if cached:
            try:
                return json.loads(cached)
            except Exception:
                pass

        if _HAS_HTTPX:
            try:
                headers = {
                    "User-Agent": "Mozilla/5.0",
                    "Referer": "https://www.nseindia.com/",
                }
                with _httpx.Client(headers=headers, timeout=10.0, follow_redirects=True) as client:
                    resp = client.get(FOB_API_URL)
                    # The ban list endpoint returns JSON with "data" key
                    body = resp.json()
                    symbols: List[str] = []
                    for row in body.get("data", []):
                        sym = row.get("symbol") or row.get("scripName") or ""
                        if sym:
                            symbols.append(sym.strip().upper())
                    _r_set("market:fo_ban_list", json.dumps(symbols), ex=86400)
                    return symbols
            except Exception as exc:
                log.warning("NSE F&O ban list fetch failed: %s", exc)

        return []

    # ------------------------------------------------------------------
    # Circuit-breaker status
    # ------------------------------------------------------------------

    def get_nse_circuit_breaker_status(self) -> Dict[str, Any]:
        """
        Retrieve NSE market-wide circuit-breaker status.

        Reads from Redis ``market:circuit_breakers`` if fresh; otherwise
        fetches from NSE API.
        """
        cached = _r_get("market:circuit_breakers")
        if cached:
            try:
                return json.loads(cached)
            except Exception:
                pass

        if _HAS_HTTPX:
            try:
                headers = {
                    "User-Agent": "Mozilla/5.0",
                    "Referer": "https://www.nseindia.com/",
                }
                with _httpx.Client(headers=headers, timeout=8.0, follow_redirects=True) as client:
                    resp = client.get(NSE_CIRCUIT_BREAKER_URL)
                    data = resp.json()
                    payload = {
                        "marketStatus": data.get("marketState"),
                        "tradeDate": data.get("tradeDate"),
                        "raw": data,
                    }
                    _r_set("market:circuit_breakers", json.dumps(payload), ex=300)
                    return payload
            except Exception as exc:
                log.warning("NSE circuit-breaker fetch failed: %s", exc)

        return {"marketStatus": "unknown", "tradeDate": None}

    # ------------------------------------------------------------------
    # WebSocket tick subscription
    # ------------------------------------------------------------------

    def subscribe_ticks(
        self,
        symbols: List[str],
        callback: Callable[[Dict[str, Any]], None],
    ) -> None:
        """
        Subscribe to live ticks for *symbols* via Zerodha KiteTicker.

        *callback* is called with each normalized tick dict.
        Falls back to a no-op log warning if KiteTicker is unavailable.
        """
        if not _HAS_KITE or KiteTicker is None or not ZERODHA_API_KEY:
            log.warning(
                "subscribe_ticks: KiteTicker unavailable — tick subscription skipped "
                "(paper-trading mode)."
            )
            return

        try:
            ticker = KiteTicker(ZERODHA_API_KEY, ZERODHA_ACCESS_TOKEN)
            self._ticker = ticker
            self._tick_callbacks.append(callback)

            def _on_ticks(ws: Any, ticks: List[Dict]) -> None:
                for tick in ticks:
                    normalized = {
                        "symbol": tick.get("tradingsymbol", ""),
                        "last_price": float(tick.get("last_price", 0)),
                        "volume": int(tick.get("volume", 0)),
                        "ts": int(time.time()),
                    }
                    for cb in self._tick_callbacks:
                        try:
                            cb(normalized)
                        except Exception as exc:
                            log.error("Tick callback error: %s", exc)

            def _on_connect(ws: Any, response: Any) -> None:
                # Look up instrument tokens
                try:
                    assert self._kite is not None
                    instruments = self._get_instruments()
                    token_map = {
                        inst["tradingsymbol"]: inst["instrument_token"]
                        for inst in instruments
                    }
                    tokens = [
                        token_map[s.upper()]
                        for s in symbols
                        if s.upper() in token_map
                    ]
                    ws.subscribe(tokens)
                    ws.set_mode(ws.MODE_FULL, tokens)
                except Exception as exc:
                    log.error("KiteTicker subscribe error: %s", exc)

            def _on_error(ws: Any, code: Any, reason: Any) -> None:
                log.error("KiteTicker error %s: %s", code, reason)

            ticker.on_ticks = _on_ticks  # type: ignore[assignment]
            ticker.on_connect = _on_connect  # type: ignore[assignment]
            ticker.on_error = _on_error  # type: ignore[assignment]
            ticker.connect(threaded=True)
            log.info("KiteTicker connected for %d symbols", len(symbols))
        except Exception as exc:
            log.error("subscribe_ticks failed: %s", exc)

    # ------------------------------------------------------------------
    # Bar publishing
    # ------------------------------------------------------------------

    def publish_bar(self, symbol: str, bar_dict: Dict[str, Any]) -> None:
        """
        Publish a completed OHLCV bar to Redis Stream ``live:bars:{symbol}``.

        Also caches the latest quote under ``live:quote:{symbol}``.
        """
        symbol = symbol.upper()
        bar_dict["symbol"] = symbol
        bar_dict.setdefault("ts", int(time.time()))

        _r_xadd(f"live:bars:{symbol}", bar_dict)

        # Update quote cache with close price
        quote_update = {
            "symbol": symbol,
            "last_price": bar_dict.get("close", bar_dict.get("last_price", 0)),
            "open": bar_dict.get("open", 0),
            "high": bar_dict.get("high", 0),
            "low": bar_dict.get("low", 0),
            "close": bar_dict.get("close", 0),
            "volume": bar_dict.get("volume", 0),
            "ts": bar_dict["ts"],
        }
        _r_set(f"live:quote:{symbol}", json.dumps(quote_update), ex=120)
