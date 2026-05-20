# backend/data/historical/__init__.py
from .fetcher import fetch, fetch_yfinance, fetch_alpaca, fetch_binance, fetch_nse, fetch_fred

__all__ = ["fetch", "fetch_yfinance", "fetch_alpaca", "fetch_binance", "fetch_nse", "fetch_fred"]
