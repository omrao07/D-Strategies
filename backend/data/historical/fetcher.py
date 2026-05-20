# backend/data/historical/fetcher.py
"""
Unified historical OHLCV fetcher.
Sources: Alpaca, yfinance, NSE/BSE/MCX (via nsepython/jugaad-data), Binance, FRED.
All sources return a standardised DataFrame: [open, high, low, close, volume] with a DatetimeIndex.
"""
from __future__ import annotations

import logging
import os
from datetime import date, datetime
from typing import Optional
import pandas as pd

logger = logging.getLogger("data.historical")


def _to_dt(d) -> datetime:
    if isinstance(d, datetime):
        return d
    if isinstance(d, date):
        return datetime(d.year, d.month, d.day)
    return datetime.fromisoformat(str(d))


def _standardise(df: pd.DataFrame) -> pd.DataFrame:
    col_map = {}
    for c in df.columns:
        lc = c.lower()
        if lc in ("open", "o"):
            col_map[c] = "open"
        elif lc in ("high", "h"):
            col_map[c] = "high"
        elif lc in ("low", "l"):
            col_map[c] = "low"
        elif lc in ("close", "c", "adjclose", "adj close"):
            col_map[c] = "close"
        elif lc in ("volume", "v", "vol"):
            col_map[c] = "volume"
    df = df.rename(columns=col_map)
    keep = [c for c in ["open", "high", "low", "close", "volume"] if c in df.columns]
    return df[keep].copy()


# ── yfinance ──────────────────────────────────────────────────────────────────

def fetch_yfinance(
    symbol: str,
    start: str,
    end: str,
    interval: str = "1d",
) -> pd.DataFrame:
    """
    Fetch OHLCV from Yahoo Finance via yfinance.
    interval: 1m, 5m, 15m, 30m, 1h, 1d, 1wk, 1mo
    """
    try:
        import yfinance as yf  # type: ignore
        ticker = yf.Ticker(symbol)
        df = ticker.history(start=start, end=end, interval=interval, auto_adjust=True)
        df.index = pd.to_datetime(df.index, utc=True).tz_convert(None)
        return _standardise(df)
    except ImportError:
        logger.warning("[yfinance] yfinance not installed")
        return pd.DataFrame()
    except Exception as e:
        logger.error(f"[yfinance] {symbol}: {e}")
        return pd.DataFrame()


# ── Alpaca ───────────────────────────────────────────────────────────────────

def fetch_alpaca(
    symbol: str,
    start: str,
    end: str,
    timeframe: str = "1Day",
) -> pd.DataFrame:
    """
    Fetch OHLCV from Alpaca Markets.
    Requires ALPACA_KEY_ID + ALPACA_SECRET_KEY env vars.
    timeframe: 1Min, 5Min, 15Min, 1Hour, 1Day
    """
    try:
        from alpaca.data.historical import StockHistoricalDataClient  # type: ignore
        from alpaca.data.requests import StockBarsRequest  # type: ignore
        from alpaca.data.timeframe import TimeFrame  # type: ignore

        client = StockHistoricalDataClient(
            api_key=os.getenv("ALPACA_KEY_ID", ""),
            secret_key=os.getenv("ALPACA_SECRET_KEY", ""),
        )
        tf_map = {
            "1Min": TimeFrame.Minute, "5Min": TimeFrame.Minute,
            "1Hour": TimeFrame.Hour, "1Day": TimeFrame.Day,
        }
        request = StockBarsRequest(
            symbol_or_symbols=symbol,
            timeframe=tf_map.get(timeframe, TimeFrame.Day),
            start=start,
            end=end,
        )
        bars = client.get_stock_bars(request).df
        if hasattr(bars.index, "levels"):
            bars = bars.xs(symbol, level="symbol")
        bars.index = pd.to_datetime(bars.index, utc=True).tz_convert(None)
        return _standardise(bars)
    except ImportError:
        logger.warning("[alpaca] alpaca-py not installed — falling back to yfinance")
        return fetch_yfinance(symbol, start, end)
    except Exception as e:
        logger.error(f"[alpaca] {symbol}: {e}")
        return pd.DataFrame()


# ── Binance ───────────────────────────────────────────────────────────────────

def fetch_binance(
    symbol: str,
    start: str,
    end: str,
    interval: str = "1d",
) -> pd.DataFrame:
    """
    Fetch OHLCV from Binance (spot).
    symbol e.g. 'BTCUSDT'; interval: 1m, 5m, 15m, 1h, 4h, 1d
    """
    try:
        from binance.client import Client  # type: ignore
        client = Client(
            api_key=os.getenv("BINANCE_API_KEY", ""),
            api_secret=os.getenv("BINANCE_API_SECRET", ""),
        )
        INTERVAL_MAP = {
            "1m": Client.KLINE_INTERVAL_1MINUTE,
            "5m": Client.KLINE_INTERVAL_5MINUTE,
            "15m": Client.KLINE_INTERVAL_15MINUTE,
            "1h": Client.KLINE_INTERVAL_1HOUR,
            "4h": Client.KLINE_INTERVAL_4HOUR,
            "1d": Client.KLINE_INTERVAL_1DAY,
        }
        klines = client.get_historical_klines(
            symbol, INTERVAL_MAP.get(interval, Client.KLINE_INTERVAL_1DAY), start, end
        )
        df = pd.DataFrame(klines, columns=[
            "open_time", "open", "high", "low", "close", "volume",
            "close_time", "quote_vol", "n_trades", "taker_buy_base",
            "taker_buy_quote", "ignore",
        ])
        df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")
        df = df.set_index("open_time")
        for col in ["open", "high", "low", "close", "volume"]:
            df[col] = pd.to_numeric(df[col])
        return df[["open", "high", "low", "close", "volume"]]
    except ImportError:
        logger.warning("[binance] python-binance not installed")
        return pd.DataFrame()
    except Exception as e:
        logger.error(f"[binance] {symbol}: {e}")
        return pd.DataFrame()


# ── NSE / India ───────────────────────────────────────────────────────────────

def fetch_nse(
    symbol: str,
    start: str,
    end: str,
    series: str = "EQ",
) -> pd.DataFrame:
    """
    Fetch NSE historical OHLCV via nsepython.
    symbol: NSE ticker (e.g. 'RELIANCE', 'NIFTY 50')
    """
    try:
        import nsepython  # type: ignore
        df = nsepython.equity_history(symbol, series, start, end)
        df.columns = [c.lower().strip() for c in df.columns]
        df["date"] = pd.to_datetime(df["date"])
        df = df.set_index("date").sort_index()
        return _standardise(df)
    except ImportError:
        logger.warning("[nse] nsepython not installed — trying yfinance with .NS suffix")
        return fetch_yfinance(f"{symbol}.NS", start, end)
    except Exception as e:
        logger.error(f"[nse] {symbol}: {e}")
        return pd.DataFrame()


# ── FRED (macro data) ─────────────────────────────────────────────────────────

def fetch_fred(
    series_id: str,
    start: str,
    end: str,
) -> pd.Series:
    """
    Fetch FRED macro series (e.g. 'DGS10', 'UNRATE', 'CPIAUCSL').
    Requires FRED_API_KEY env var.
    Returns pd.Series with DatetimeIndex.
    """
    try:
        from fredapi import Fred  # type: ignore
        fred = Fred(api_key=os.getenv("FRED_API_KEY", ""))
        series = fred.get_series(series_id, observation_start=start, observation_end=end)
        series.index = pd.to_datetime(series.index)
        return series.dropna()
    except ImportError:
        logger.warning("[fred] fredapi not installed")
        return pd.Series(dtype=float)
    except Exception as e:
        logger.error(f"[fred] {series_id}: {e}")
        return pd.Series(dtype=float)


# ── Unified interface ─────────────────────────────────────────────────────────

def fetch(
    symbol: str,
    start: str,
    end: str,
    source: str = "auto",
    interval: str = "1d",
) -> pd.DataFrame:
    """
    Unified fetch. source: auto | yfinance | alpaca | binance | nse | fred
    auto: picks source by symbol suffix (.NS → nse, BTC/ETH → binance, else yfinance).
    """
    if source == "auto":
        s_upper = symbol.upper()
        if symbol.endswith(".NS") or symbol.endswith(".BO"):
            source = "nse"
        elif any(s_upper.endswith(q) for q in ("USDT", "BTC", "ETH", "BUSD")):
            source = "binance"
        else:
            source = "yfinance"

    dispatch = {
        "yfinance": lambda: fetch_yfinance(symbol, start, end, interval),
        "alpaca": lambda: fetch_alpaca(symbol, start, end),
        "binance": lambda: fetch_binance(symbol, start, end, interval),
        "nse": lambda: fetch_nse(symbol, start, end),
    }
    fn = dispatch.get(source)
    if fn is None:
        logger.error(f"[fetch] unknown source={source}")
        return pd.DataFrame()
    return fn()
