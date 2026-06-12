# backend/backtester/data_feeds.py
"""
DataFeed abstraction and implementations for the BacktestEngine.

Implementations:
  CSVFeed        — wide-format or long-format CSV files / directories
  SyntheticFeed  — correlated GBM with Markov-chain regime switching
  YfinanceFeed   — yfinance-based (optional dependency)
  TimescaleDBFeed — reads from backend.db (stub, async→sync)
"""
from __future__ import annotations

import datetime
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Union

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)


# ── Core types ────────────────────────────────────────────────────────────────

@dataclass
class Bar:
    ts: datetime.datetime
    symbol: str
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0
    vwap: float = 0.0
    adv_20: float = 0.0   # 20-day avg daily volume (for market impact)


@dataclass
class BarBatch:
    """All bars for one timestamp (one trading period)."""
    ts: datetime.datetime
    bars: Dict[str, Bar]   # symbol → Bar

    def prices(self) -> Dict[str, float]:
        return {sym: b.close for sym, b in self.bars.items()}


# ── DataFeed protocol ─────────────────────────────────────────────────────────

class DataFeed:
    """Base class for all data feeds. Subclass and implement iter_batches()."""

    def get_symbols(self) -> List[str]:
        raise NotImplementedError

    def iter_batches(
        self,
        start: datetime.datetime,
        end: datetime.datetime,
    ) -> Iterator[BarBatch]:
        raise NotImplementedError


# ── CSVFeed ───────────────────────────────────────────────────────────────────

class CSVFeed(DataFeed):
    """
    Load market data from CSV files.

    Supported formats:
      1. Wide (default): rows = dates, columns = symbols (close prices only)
         date,AAPL,MSFT,GOOG,...
         2022-01-03,182.01,336.32,...

      2. Long: one row per (date, symbol) with OHLCV
         ts,symbol,open,high,low,close,volume
         2022-01-03,AAPL,182.01,182.50,181.00,182.01,75e6

      3. Directory: one CSV per symbol, any OHLCV format
    """

    def __init__(
        self,
        path: Union[str, Path],
        fmt: str = "auto",        # "wide" | "long" | "dir" | "auto"
        date_col: str = "date",
        freq: str = "1d",
    ):
        self.path = Path(path)
        self.fmt = fmt
        self.date_col = date_col
        self.freq = freq
        self._df: Optional[pd.DataFrame] = None   # loaded lazily

    def _load(self) -> pd.DataFrame:
        if self._df is not None:
            return self._df

        if self.path.is_dir() or self.fmt == "dir":
            self._df = self._load_dir(self.path)
        else:
            raw = pd.read_csv(self.path)
            fmt = self.fmt if self.fmt != "auto" else self._detect_format(raw)
            if fmt == "wide":
                self._df = self._parse_wide(raw)
            else:
                self._df = self._parse_long(raw)

        self._df = self._df.sort_index()
        return self._df

    @staticmethod
    def _detect_format(df: pd.DataFrame) -> str:
        cols_lower = [c.lower() for c in df.columns]
        if "symbol" in cols_lower:
            return "long"
        return "wide"

    @staticmethod
    def _parse_wide(df: pd.DataFrame) -> pd.DataFrame:
        date_cols = [c for c in df.columns if c.lower() in ("date", "ts", "time", "datetime")]
        if date_cols:
            df = df.set_index(date_cols[0])
        df.index = pd.to_datetime(df.index)
        df = df.apply(pd.to_numeric, errors="coerce")
        return df

    @staticmethod
    def _parse_long(df: pd.DataFrame) -> pd.DataFrame:
        cols = {c.lower(): c for c in df.columns}
        ts_col = next((cols[k] for k in ("ts", "date", "datetime", "time") if k in cols), None)
        sym_col = next((cols[k] for k in ("symbol", "sym", "ticker") if k in cols), None)
        close_col = next((cols[k] for k in ("close", "adj_close", "price") if k in cols), None)
        if not ts_col or not sym_col or not close_col:
            raise ValueError("Long CSV must have ts/symbol/close columns")
        df[ts_col] = pd.to_datetime(df[ts_col])
        pivot = df.pivot(index=ts_col, columns=sym_col, values=close_col)
        return pivot

    def _load_dir(self, d: Path) -> pd.DataFrame:
        frames = []
        for f in sorted(d.glob("*.csv")):
            sym = f.stem.upper()
            sub = pd.read_csv(f)
            cols = {c.lower(): c for c in sub.columns}
            ts_col = next((cols[k] for k in ("date", "ts", "datetime", "time") if k in cols), None)
            close_col = next((cols[k] for k in ("close", "adj_close", "price") if k in cols), "close")
            if ts_col:
                sub = sub.set_index(ts_col)
            sub.index = pd.to_datetime(sub.index)
            if close_col in sub.columns:
                frames.append(sub[[close_col]].rename(columns={close_col: sym}))
        if not frames:
            raise FileNotFoundError(f"No CSV files found in {d}")
        return pd.concat(frames, axis=1)

    def get_symbols(self) -> List[str]:
        return list(self._load().columns)

    def iter_batches(
        self,
        start: datetime.datetime,
        end: datetime.datetime,
    ) -> Iterator[BarBatch]:
        df = self._load()
        # Filter to date range
        mask = (df.index >= pd.Timestamp(start)) & (df.index <= pd.Timestamp(end))
        df = df.loc[mask]
        if df.empty:
            log.warning("CSVFeed: no data in range %s – %s", start, end)
            return

        # Compute 20-day rolling ADV if volume not available (use price proxy)
        for ts, row in df.iterrows():
            bars: Dict[str, Bar] = {}
            for sym in df.columns:
                close = row[sym]
                if pd.isna(close):
                    continue
                bars[sym] = Bar(
                    ts=ts.to_pydatetime(),
                    symbol=sym,
                    open=close,
                    high=close,
                    low=close,
                    close=close,
                    volume=0.0,
                    adv_20=0.0,
                )
            if bars:
                yield BarBatch(ts=ts.to_pydatetime(), bars=bars)


# ── SyntheticFeed ─────────────────────────────────────────────────────────────

# Regime parameters (daily)
_REGIMES = {
    "bull":     {"mu": 3e-4,  "sigma": 0.010, "p_stay": 0.95},
    "sideways": {"mu": 0.0,   "sigma": 0.013, "p_stay": 0.90},
    "bear":     {"mu": -2e-4, "sigma": 0.018, "p_stay": 0.92},
    "crisis":   {"mu": -8e-4, "sigma": 0.030, "p_stay": 0.85},
}
_REGIME_ORDER = ["bull", "sideways", "bear", "crisis"]
# Transition matrix rows→from, cols→to
_TRANSITION = np.array([
    [0.95, 0.03, 0.015, 0.005],  # bull → ...
    [0.08, 0.90, 0.015, 0.005],  # sideways → ...
    [0.02, 0.06, 0.92,  0.000],  # bear → ...
    [0.05, 0.10, 0.00,  0.85 ],  # crisis → ...
])


class SyntheticFeed(DataFeed):
    """
    Correlated GBM with optional Markov-chain regime switching.

    Parameters:
        symbols     — list of asset names
        start       — simulation start date
        end         — simulation end date
        vols        — per-symbol annualized vol (dict or float). Default 0.20
        drifts      — per-symbol annual drift (dict or float). Default 0.08
        corr        — correlation matrix (N x N) or float (pairwise). Default 0.30
        seed        — RNG seed for reproducibility
        use_regimes — if True, use Markov regime switching
        freq        — bar frequency ("1d" only for now)
    """

    def __init__(
        self,
        symbols: List[str],
        start: Union[str, datetime.datetime],
        end: Union[str, datetime.datetime],
        vols: Union[float, Dict[str, float]] = 0.20,
        drifts: Union[float, Dict[str, float]] = 0.08,
        corr: Union[float, np.ndarray] = 0.30,
        seed: int = 42,
        use_regimes: bool = True,
        freq: str = "1d",
    ):
        self.symbols = list(symbols)
        self.start = pd.Timestamp(start)
        self.end = pd.Timestamp(end)
        self.seed = seed
        self.use_regimes = use_regimes

        N = len(self.symbols)
        self._vols = np.array([
            vols.get(s, 0.20) if isinstance(vols, dict) else vols for s in self.symbols
        ])
        self._drifts = np.array([
            drifts.get(s, 0.08) if isinstance(drifts, dict) else drifts for s in self.symbols
        ])
        if isinstance(corr, (int, float)):
            self._corr = np.full((N, N), corr)
            np.fill_diagonal(self._corr, 1.0)
        else:
            self._corr = np.asarray(corr)

        self._cached: Optional[pd.DataFrame] = None

    def _generate(self) -> pd.DataFrame:
        if self._cached is not None:
            return self._cached

        rng = np.random.default_rng(self.seed)
        dates = pd.bdate_range(self.start, self.end)
        T, N = len(dates), len(self.symbols)

        # Cholesky decomposition for correlated returns
        try:
            L = np.linalg.cholesky(self._corr)
        except np.linalg.LinAlgError:
            # Not PD — regularize
            eps = 1e-6
            L = np.linalg.cholesky(self._corr + eps * np.eye(N))

        daily_vols = self._vols / np.sqrt(252.0)
        daily_drifts = self._drifts / 252.0

        prices = np.zeros((T, N))
        prices[0] = 100.0

        if self.use_regimes:
            regime_idx = 0  # start in bull
            regime_seq = []

        for t in range(1, T):
            if self.use_regimes:
                # Markov transition
                probs = _TRANSITION[regime_idx]
                regime_idx = int(rng.choice(4, p=probs))
                regime = _REGIME_ORDER[regime_idx]
                rp = _REGIMES[regime]
                mu_t = rp["mu"]
                sigma_scale = rp["sigma"] / daily_vols.mean() if daily_vols.mean() > 0 else 1.0
                regime_seq.append(regime)
            else:
                mu_t = daily_drifts.mean()
                sigma_scale = 1.0

            z = rng.standard_normal(N)
            eps = L @ z  # correlated shocks
            ret = mu_t + sigma_scale * daily_vols * eps
            prices[t] = prices[t - 1] * np.exp(ret)

        df = pd.DataFrame(prices, index=dates, columns=self.symbols)
        self._cached = df
        return df

    def get_symbols(self) -> List[str]:
        return self.symbols

    def iter_batches(
        self,
        start: datetime.datetime,
        end: datetime.datetime,
    ) -> Iterator[BarBatch]:
        df = self._generate()
        mask = (df.index >= pd.Timestamp(start)) & (df.index <= pd.Timestamp(end))
        df = df.loc[mask]

        # Compute rolling 20-day ADV proxy (vol * price)
        rolling_vol = df.rolling(20).std().fillna(df.std())

        for ts, row in df.iterrows():
            bars: Dict[str, Bar] = {}
            for sym in self.symbols:
                close = row[sym]
                if pd.isna(close):
                    continue
                # Simulate OHLC from close using daily vol
                daily_range = rolling_vol.at[ts, sym] * close
                bars[sym] = Bar(
                    ts=ts.to_pydatetime(),
                    symbol=sym,
                    open=max(close * (1 + np.random.uniform(-0.2, 0.2) * rolling_vol.at[ts, sym]), 0.01),
                    high=close + abs(daily_range) * np.random.uniform(0.3, 0.8),
                    low=close - abs(daily_range) * np.random.uniform(0.3, 0.8),
                    close=close,
                    volume=1e6 * np.random.uniform(0.5, 2.0),
                    adv_20=1e6,
                )
            if bars:
                yield BarBatch(ts=ts.to_pydatetime(), bars=bars)


# ── YfinanceFeed ─────────────────────────────────────────────────────────────

class YfinanceFeed(DataFeed):
    """
    Download historical OHLCV data from Yahoo Finance via yfinance.
    Requires: pip install yfinance

    Usage:
        feed = YfinanceFeed(["AAPL", "MSFT", "GOOG"], interval="1d")
    """

    def __init__(
        self,
        symbols: List[str],
        interval: str = "1d",   # "1d", "1h", "5m", "1m"
        adjust: bool = True,    # adjust for splits/dividends
    ):
        self.symbols = [s.upper() for s in symbols]
        self.interval = interval
        self.adjust = adjust
        self._cache: Dict[str, pd.DataFrame] = {}

    def _download(self, symbol: str, start: datetime.datetime, end: datetime.datetime) -> pd.DataFrame:
        key = f"{symbol}_{start.date()}_{end.date()}"
        if key in self._cache:
            return self._cache[key]

        try:
            import yfinance as yf  # type: ignore
        except ImportError:
            raise ImportError("yfinance not installed. Run: pip install yfinance")

        ticker = yf.Ticker(symbol)
        df = ticker.history(
            start=start.strftime("%Y-%m-%d"),
            end=end.strftime("%Y-%m-%d"),
            interval=self.interval,
            auto_adjust=self.adjust,
        )
        df.index = pd.to_datetime(df.index).tz_localize(None)
        self._cache[key] = df
        return df

    def get_symbols(self) -> List[str]:
        return self.symbols

    def iter_batches(
        self,
        start: datetime.datetime,
        end: datetime.datetime,
    ) -> Iterator[BarBatch]:
        frames: Dict[str, pd.DataFrame] = {}
        for sym in self.symbols:
            try:
                frames[sym] = self._download(sym, start, end)
            except Exception as exc:
                log.warning("YfinanceFeed: failed to download %s: %s", sym, exc)

        if not frames:
            return

        # Align timestamps
        all_ts = sorted(set.union(*[set(df.index) for df in frames.values()]))

        # Compute ADV20
        adv: Dict[str, float] = {}
        for sym, df in frames.items():
            if "Volume" in df.columns:
                adv[sym] = float(df["Volume"].rolling(20).mean().iloc[-1] or 1e6)
            else:
                adv[sym] = 1e6

        for ts in all_ts:
            ts_dt = ts.to_pydatetime() if hasattr(ts, "to_pydatetime") else ts
            bars: Dict[str, Bar] = {}
            for sym, df in frames.items():
                if ts not in df.index:
                    continue
                row = df.loc[ts]
                bars[sym] = Bar(
                    ts=ts_dt,
                    symbol=sym,
                    open=float(row.get("Open", row.get("Close", 0))),
                    high=float(row.get("High", row.get("Close", 0))),
                    low=float(row.get("Low", row.get("Close", 0))),
                    close=float(row.get("Close", 0)),
                    volume=float(row.get("Volume", 0)),
                    adv_20=adv.get(sym, 1e6),
                )
            if bars:
                yield BarBatch(ts=ts_dt, bars=bars)


# ── Convenience factory ───────────────────────────────────────────────────────

def make_feed(
    source: Union[str, Path, List[str]],
    start: Optional[Union[str, datetime.datetime]] = None,
    end: Optional[Union[str, datetime.datetime]] = None,
    **kwargs,
) -> DataFeed:
    """
    Auto-detect and create a DataFeed.

    - str/Path pointing to CSV/dir → CSVFeed
    - list of ticker symbols       → YfinanceFeed (or SyntheticFeed if yfinance unavailable)
    """
    if isinstance(source, (str, Path)):
        p = Path(source)
        if p.exists():
            return CSVFeed(p, **kwargs)
        raise FileNotFoundError(f"Data path not found: {source}")

    if isinstance(source, list):
        try:
            import yfinance  # noqa: F401
            return YfinanceFeed(source, **kwargs)
        except ImportError:
            log.warning("yfinance not installed; using SyntheticFeed instead")
            s = start or datetime.datetime(2020, 1, 1)
            e = end or datetime.datetime.today()
            return SyntheticFeed(source, start=s, end=e, **kwargs)

    raise ValueError(f"Unknown source type: {type(source)}")
