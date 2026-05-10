# backend/backtester/data_engine.py
"""
Data Engine — loads, validates, aligns, and serves market data to the backtest engine.

Implements:
  load_ohlcv            — CSV, yfinance, TimescaleDB, synthetic
  load_tick_data        — raw tick streams (CSV, parquet)
  load_orderbook        — L2 order book snapshots
  resample_timeframe    — 1m→5m, 5m→1h, 1d→1W, etc.
  align_multitimeframes — align M1 / M5 / H1 / D1 into one index
  normalize_timezone    — any TZ → UTC (or target TZ)
  fill_missing_data     — forward fill, interpolate, zero-volume bars
  validate_data_integrity — OHLC constraints, gaps, spike detection
"""
from __future__ import annotations

import datetime
import logging
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple, Union

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

_OHLCV_COLS = {"open", "high", "low", "close", "volume"}
_ALIAS = {
    "o": "open", "h": "high", "l": "low", "c": "close",
    "v": "volume", "vol": "volume", "adj_close": "close",
    "price": "close", "last": "close", "trade_price": "close",
    "bid_price": "bid", "ask_price": "ask",
    "ts": "timestamp", "time": "timestamp", "date": "timestamp",
    "datetime": "timestamp", "index": "timestamp",
}


# ── Data containers ───────────────────────────────────────────────────────────

@dataclass
class OHLCVBar:
    ts: datetime.datetime
    symbol: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    vwap: float = 0.0
    bid: float = 0.0
    ask: float = 0.0
    spread: float = 0.0
    adv_20: float = 0.0
    exchange: str = ""
    currency: str = ""


@dataclass
class Tick:
    ts: datetime.datetime
    symbol: str
    price: float
    size: float
    side: str = ""    # "buy" | "sell" | ""
    exchange: str = ""
    conditions: str = ""


@dataclass
class OrderBookSnapshot:
    ts: datetime.datetime
    symbol: str
    bids: List[Tuple[float, float]]   # [(price, size), ...] sorted desc
    asks: List[Tuple[float, float]]   # [(price, size), ...] sorted asc

    def mid_price(self) -> float:
        if self.bids and self.asks:
            return (self.bids[0][0] + self.asks[0][0]) / 2.0
        return 0.0

    def spread(self) -> float:
        if self.bids and self.asks:
            return self.asks[0][0] - self.bids[0][0]
        return 0.0

    def bid_ask_imbalance(self, levels: int = 5) -> float:
        """Order book imbalance ∈ [-1, +1]. Positive → more bids (bullish pressure)."""
        bid_vol = sum(s for _, s in self.bids[:levels])
        ask_vol = sum(s for _, s in self.asks[:levels])
        total = bid_vol + ask_vol
        return (bid_vol - ask_vol) / total if total > 0 else 0.0

    def depth_at_bps(self, bps: float) -> Tuple[float, float]:
        """Total bid/ask volume within `bps` of mid price."""
        mid = self.mid_price()
        if mid <= 0:
            return 0.0, 0.0
        threshold = mid * bps * 1e-4
        bid_depth = sum(s for p, s in self.bids if mid - p <= threshold)
        ask_depth = sum(s for p, s in self.asks if p - mid <= threshold)
        return bid_depth, ask_depth


# ── Validation result ─────────────────────────────────────────────────────────

@dataclass
class DataValidationReport:
    symbol: str
    n_bars: int
    n_missing: int
    n_gaps: int
    n_spikes: int
    n_ohlc_violations: int
    first_ts: Optional[datetime.datetime]
    last_ts: Optional[datetime.datetime]
    issues: List[str] = field(default_factory=list)
    passed: bool = True

    def summary(self) -> str:
        if self.passed:
            return f"{self.symbol}: OK ({self.n_bars} bars)"
        return f"{self.symbol}: ISSUES — {'; '.join(self.issues)}"


# ── Data loading ──────────────────────────────────────────────────────────────

def load_ohlcv(
    source: Union[str, Path, List[str]],
    symbols: Optional[List[str]] = None,
    start: Optional[Union[str, datetime.datetime]] = None,
    end: Optional[Union[str, datetime.datetime]] = None,
    freq: str = "1d",
    exchange: str = "",
    currency: str = "",
    adjust: bool = True,
) -> pd.DataFrame:
    """
    Load OHLCV data from any source into a MultiIndex DataFrame.

    Index:  DatetimeIndex
    Columns: MultiIndex (symbol, field) where field ∈ {open, high, low, close, volume, vwap}

    Sources:
      str/Path → CSV file or directory of CSVs
      List[str] → ticker symbols → yfinance (falls back to synthetic)
    """
    if isinstance(source, (str, Path)):
        df = _load_csv_ohlcv(Path(source), symbols)
    elif isinstance(source, list):
        df = _load_yfinance_ohlcv(source, start, end, freq, adjust)
    else:
        raise ValueError(f"Unsupported source type: {type(source)}")

    if start:
        df = df[df.index >= pd.Timestamp(start)]
    if end:
        df = df[df.index <= pd.Timestamp(end)]

    return df


def _load_csv_ohlcv(path: Path, symbols: Optional[List[str]]) -> pd.DataFrame:
    """Load from CSV — auto-detect wide or long format."""
    if path.is_dir():
        frames = {}
        for f in sorted(path.glob("*.csv")):
            sym = f.stem.upper()
            if symbols and sym not in symbols:
                continue
            sub = _load_single_csv(f)
            if sub is not None:
                frames[sym] = sub
        if not frames:
            raise FileNotFoundError(f"No CSV files in {path}")
        return _multi_symbol_to_multiindex(frames)
    else:
        raw = pd.read_csv(path)
        raw.columns = [_ALIAS.get(c.lower(), c.lower()) for c in raw.columns]
        if "symbol" in raw.columns:
            return _long_csv_to_multiindex(raw, symbols)
        return _wide_csv_to_multiindex(raw, symbols)


def _load_single_csv(path: Path) -> Optional[pd.DataFrame]:
    try:
        df = pd.read_csv(path)
        df.columns = [_ALIAS.get(c.lower(), c.lower()) for c in df.columns]
        ts_col = next((c for c in df.columns if c == "timestamp"), None)
        if ts_col:
            df = df.set_index(ts_col)
        df.index = pd.to_datetime(df.index)
        for col in list(_OHLCV_COLS):
            if col not in df.columns:
                if col == "volume":
                    df[col] = 0.0
                elif col in ("open", "high", "low"):
                    df[col] = df["close"] if "close" in df.columns else np.nan
        return df[list(_OHLCV_COLS)].apply(pd.to_numeric, errors="coerce")
    except Exception as exc:
        log.warning("Failed to load %s: %s", path, exc)
        return None


def _long_csv_to_multiindex(df: pd.DataFrame, symbols: Optional[List[str]]) -> pd.DataFrame:
    if "timestamp" in df.columns:
        df = df.set_index("timestamp")
    df.index = pd.to_datetime(df.index)
    groups = {}
    for sym, grp in df.groupby("symbol"):
        sym = str(sym).upper()
        if symbols and sym not in symbols:
            continue
        groups[sym] = grp.drop(columns=["symbol"])
    return _multi_symbol_to_multiindex(groups)


def _wide_csv_to_multiindex(df: pd.DataFrame, symbols: Optional[List[str]]) -> pd.DataFrame:
    if "timestamp" in df.columns:
        df = df.set_index("timestamp")
    df.index = pd.to_datetime(df.index)
    # Assume it's just close prices with symbol columns
    frames = {}
    for col in df.columns:
        sym = col.upper()
        if symbols and sym not in symbols:
            continue
        sub = pd.DataFrame({"close": df[col]})
        sub["open"] = sub["close"]
        sub["high"] = sub["close"]
        sub["low"] = sub["close"]
        sub["volume"] = 0.0
        frames[sym] = sub
    return _multi_symbol_to_multiindex(frames)


def _multi_symbol_to_multiindex(frames: Dict[str, pd.DataFrame]) -> pd.DataFrame:
    all_dfs = []
    for sym, df in frames.items():
        df = df.copy()
        df.columns = pd.MultiIndex.from_tuples([(sym, c) for c in df.columns])
        all_dfs.append(df)
    return pd.concat(all_dfs, axis=1).sort_index()


def _load_yfinance_ohlcv(
    symbols: List[str],
    start: Optional[Union[str, datetime.datetime]],
    end: Optional[Union[str, datetime.datetime]],
    freq: str,
    adjust: bool,
) -> pd.DataFrame:
    try:
        import yfinance as yf  # type: ignore
        interval_map = {"1d": "1d", "1h": "1h", "5m": "5m", "1m": "1m", "1W": "1wk", "1M": "1mo"}
        interval = interval_map.get(freq, "1d")
        frames = {}
        for sym in symbols:
            try:
                t = yf.Ticker(sym)
                df = t.history(
                    start=str(start) if start else "2010-01-01",
                    end=str(end) if end else datetime.datetime.today().strftime("%Y-%m-%d"),
                    interval=interval,
                    auto_adjust=adjust,
                )
                df.index = pd.to_datetime(df.index).tz_localize(None)
                df.columns = [c.lower() for c in df.columns]
                df = df.rename(columns={"adj close": "close", "stock splits": "split"})
                for col in _OHLCV_COLS:
                    if col not in df.columns:
                        df[col] = np.nan
                frames[sym.upper()] = df[list(_OHLCV_COLS)]
            except Exception as exc:
                log.warning("yfinance: failed %s: %s", sym, exc)
        if not frames:
            raise RuntimeError("No yfinance data loaded")
        return _multi_symbol_to_multiindex(frames)
    except ImportError:
        log.warning("yfinance not installed; returning synthetic data")
        from backend.backtester.data_feeds import SyntheticFeed
        s = start or "2020-01-01"
        e = end or datetime.datetime.today()
        feed = SyntheticFeed(symbols, start=s, end=e)
        batches = list(feed.iter_batches(pd.Timestamp(s).to_pydatetime(), pd.Timestamp(e).to_pydatetime()))
        if not batches:
            return pd.DataFrame()
        frames = {}
        for sym in symbols:
            rows = []
            for b in batches:
                if sym in b.bars:
                    bar = b.bars[sym]
                    rows.append({"open": bar.open, "high": bar.high, "low": bar.low,
                                 "close": bar.close, "volume": bar.volume})
            frames[sym.upper()] = pd.DataFrame(rows, index=[b.ts for b in batches if sym in b.bars])
        return _multi_symbol_to_multiindex(frames)


# ── Tick data ─────────────────────────────────────────────────────────────────

def load_tick_data(
    source: Union[str, Path],
    symbol: str,
    start: Optional[Union[str, datetime.datetime]] = None,
    end: Optional[Union[str, datetime.datetime]] = None,
) -> pd.DataFrame:
    """
    Load raw tick data from CSV or Parquet.
    Returns DataFrame with columns: [price, size, side].
    Index: DatetimeIndex (UTC).
    """
    path = Path(source)
    if not path.exists():
        raise FileNotFoundError(f"Tick data not found: {source}")

    if path.suffix == ".parquet":
        try:
            df = pd.read_parquet(path)
        except Exception:
            raise
    else:
        df = pd.read_csv(path)

    df.columns = [_ALIAS.get(c.lower(), c.lower()) for c in df.columns]
    ts_col = next((c for c in df.columns if c == "timestamp"), None)
    if ts_col:
        df[ts_col] = pd.to_datetime(df[ts_col], utc=True).dt.tz_localize(None)
        df = df.set_index(ts_col)

    if "symbol" in df.columns:
        df = df[df["symbol"].str.upper() == symbol.upper()].drop(columns=["symbol"])

    if start:
        df = df[df.index >= pd.Timestamp(start)]
    if end:
        df = df[df.index <= pd.Timestamp(end)]

    for col in ("price", "size"):
        if col not in df.columns:
            raise ValueError(f"Tick data missing column: {col}")

    df["price"] = pd.to_numeric(df["price"], errors="coerce")
    df["size"] = pd.to_numeric(df["size"], errors="coerce")
    if "side" not in df.columns:
        df["side"] = ""

    return df.sort_index().dropna(subset=["price"])


# ── Order book ────────────────────────────────────────────────────────────────

def load_orderbook(
    source: Union[str, Path],
    symbol: str,
    levels: int = 10,
    start: Optional[Union[str, datetime.datetime]] = None,
    end: Optional[Union[str, datetime.datetime]] = None,
) -> Iterator[OrderBookSnapshot]:
    """
    Stream L2 order book snapshots from a CSV file.
    Expected columns: ts, bid_px_1..N, bid_sz_1..N, ask_px_1..N, ask_sz_1..N
    """
    path = Path(source)
    if not path.exists():
        raise FileNotFoundError(f"Order book data not found: {source}")

    df = pd.read_csv(path)
    df.columns = [c.lower() for c in df.columns]

    ts_col = next((c for c in df.columns if c in ("ts", "timestamp", "time", "date")), None)
    if ts_col:
        df[ts_col] = pd.to_datetime(df[ts_col])
        df = df.set_index(ts_col)

    if start:
        df = df[df.index >= pd.Timestamp(start)]
    if end:
        df = df[df.index <= pd.Timestamp(end)]

    for ts, row in df.iterrows():
        bids = []
        asks = []
        for i in range(1, levels + 1):
            bp = row.get(f"bid_px_{i}", row.get(f"bid_p{i}", np.nan))
            bs = row.get(f"bid_sz_{i}", row.get(f"bid_s{i}", 0.0))
            ap = row.get(f"ask_px_{i}", row.get(f"ask_p{i}", np.nan))
            as_ = row.get(f"ask_sz_{i}", row.get(f"ask_s{i}", 0.0))
            if not np.isnan(bp):
                bids.append((float(bp), float(bs)))
            if not np.isnan(ap):
                asks.append((float(ap), float(as_)))

        yield OrderBookSnapshot(
            ts=ts.to_pydatetime(),
            symbol=symbol.upper(),
            bids=sorted(bids, key=lambda x: -x[0]),
            asks=sorted(asks, key=lambda x: x[0]),
        )


# ── Resampling ────────────────────────────────────────────────────────────────

_RESAMPLE_MAP = {
    "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min",
    "1h": "1h", "4h": "4h", "1d": "1D", "1W": "1W", "1M": "1ME",
}

def resample_timeframe(
    df: pd.DataFrame,
    target_freq: str,
    symbol: Optional[str] = None,
) -> pd.DataFrame:
    """
    Resample OHLCV DataFrame from any frequency to a lower frequency.
    Handles MultiIndex (symbol, field) or simple (field) columns.
    """
    freq = _RESAMPLE_MAP.get(target_freq, target_freq)

    if isinstance(df.columns, pd.MultiIndex):
        # MultiIndex: resample each symbol separately
        syms = df.columns.get_level_values(0).unique()
        frames = []
        for sym in syms:
            if symbol and sym != symbol:
                continue
            sub = df[sym]
            resampled = _resample_single(sub, freq)
            resampled.columns = pd.MultiIndex.from_tuples([(sym, c) for c in resampled.columns])
            frames.append(resampled)
        return pd.concat(frames, axis=1)
    else:
        return _resample_single(df, freq)


def _resample_single(df: pd.DataFrame, freq: str) -> pd.DataFrame:
    agg = {}
    col_lower = {c.lower(): c for c in df.columns}
    if "open" in col_lower:   agg[col_lower["open"]]   = "first"
    if "high" in col_lower:   agg[col_lower["high"]]   = "max"
    if "low" in col_lower:    agg[col_lower["low"]]    = "min"
    if "close" in col_lower:  agg[col_lower["close"]]  = "last"
    if "volume" in col_lower: agg[col_lower["volume"]] = "sum"
    if "vwap" in col_lower:   agg[col_lower["vwap"]]   = "mean"
    if not agg:
        agg = {c: "last" for c in df.columns}
    return df.resample(freq).agg(agg).dropna(how="all")


# ── Multi-timeframe alignment ─────────────────────────────────────────────────

def align_multitimeframes(
    frames: Dict[str, pd.DataFrame],
    base_freq: str = "1d",
    method: str = "ffill",    # "ffill" | "bfill" | "nearest"
) -> Dict[str, pd.DataFrame]:
    """
    Align multiple DataFrames with different frequencies to a common DatetimeIndex.
    frames: {"1d": df_daily, "1h": df_hourly, "1W": df_weekly}
    Returns: same keys, all reindexed to base_freq's index.
    """
    if base_freq not in frames:
        raise ValueError(f"base_freq '{base_freq}' not in frames")

    base_idx = frames[base_freq].index
    aligned = {}
    for freq, df in frames.items():
        if freq == base_freq:
            aligned[freq] = df
            continue
        reindexed = df.reindex(base_idx).ffill() if method == "ffill" else df.reindex(base_idx).bfill() if method == "bfill" else df.reindex(base_idx, method=method)
        aligned[freq] = reindexed
    return aligned


# ── Timezone normalization ────────────────────────────────────────────────────

def normalize_timezone(
    df: pd.DataFrame,
    from_tz: Optional[str] = None,
    to_tz: str = "UTC",
) -> pd.DataFrame:
    """
    Normalize DatetimeIndex to target timezone.
    from_tz: source timezone string (e.g. "Asia/Kolkata"). None = assume UTC.
    to_tz:   target timezone string. Default "UTC".
    """
    idx = df.index
    if not isinstance(idx, pd.DatetimeIndex):
        df.index = pd.to_datetime(df.index)
        idx = df.index

    if idx.tz is None:
        if from_tz:
            df.index = idx.tz_localize(from_tz).tz_convert(to_tz).tz_localize(None)
        else:
            df.index = idx.tz_localize("UTC").tz_convert(to_tz).tz_localize(None)
    else:
        df.index = idx.tz_convert(to_tz).tz_localize(None)

    return df


# ── Gap filling ───────────────────────────────────────────────────────────────

def fill_missing_data(
    df: pd.DataFrame,
    method: str = "ffill",        # "ffill" | "interpolate" | "zero_volume"
    max_gap_days: int = 5,
    trading_calendar: Optional[str] = "NSE",
) -> pd.DataFrame:
    """
    Fill missing bars in OHLCV data.
    - ffill:        forward-fill prices, zero volume for inserted bars
    - interpolate:  linear interpolation for prices
    - zero_volume:  insert bars with zero volume and previous close = all OHLC
    """
    if df.empty:
        return df

    # Generate expected business day index
    freq = pd.infer_freq(df.index[:min(50, len(df))])
    if freq is None:
        freq = "B"

    try:
        full_idx = pd.bdate_range(df.index.min(), df.index.max(), freq=freq)
        df = df.reindex(full_idx)
    except Exception:
        pass

    if method == "interpolate":
        df = df.interpolate(method="linear", limit=max_gap_days)
    elif method == "zero_volume":
        # Forward-fill OHLC, set volume to 0
        if "close" in df.columns:
            df["close"] = df["close"].ffill()
            for col in ("open", "high", "low"):
                if col in df.columns:
                    df[col] = df[col].fillna(df["close"])
        if "volume" in df.columns:
            df["volume"] = df["volume"].fillna(0.0)
    else:
        df = df.ffill()

    return df


# ── Data validation ───────────────────────────────────────────────────────────

def validate_data_integrity(
    df: pd.DataFrame,
    symbol: str = "unknown",
    spike_threshold: float = 0.20,   # >20% single-bar move = spike
    max_gap_days: int = 10,
) -> DataValidationReport:
    """
    Validate OHLCV data integrity.
    Checks:
      - OHLC constraints (high >= low, high >= open/close, low <= open/close)
      - Missing values
      - Timestamp gaps
      - Price spikes (>spike_threshold single-bar move)
    """
    issues = []
    n_bars = len(df)
    n_missing = int(df.isnull().any(axis=1).sum())
    n_violations = 0
    n_gaps = 0
    n_spikes = 0

    if n_bars == 0:
        return DataValidationReport(symbol, 0, 0, 0, 0, 0, None, None,
                                    ["Empty dataset"], passed=False)

    close_col = next((c for c in df.columns if c.lower() in ("close", "adj_close")), None)
    open_col = next((c for c in df.columns if c.lower() == "open"), None)
    high_col = next((c for c in df.columns if c.lower() == "high"), None)
    low_col = next((c for c in df.columns if c.lower() == "low"), None)

    # OHLC constraints
    if all(c is not None for c in (open_col, high_col, low_col, close_col)):
        o = df[open_col]
        h = df[high_col]
        l = df[low_col]
        c = df[close_col]
        n_violations += int((h < l).sum())
        n_violations += int((h < o).sum())
        n_violations += int((h < c).sum())
        n_violations += int((l > o).sum())
        n_violations += int((l > c).sum())
        if n_violations > 0:
            issues.append(f"{n_violations} OHLC constraint violations")

    # Gaps
    if isinstance(df.index, pd.DatetimeIndex) and len(df) > 1:
        diffs = pd.Series(df.index).diff().dropna()
        biz_day = pd.Timedelta(days=1)
        large_gaps = diffs[diffs > biz_day * max_gap_days]
        n_gaps = len(large_gaps)
        if n_gaps > 0:
            issues.append(f"{n_gaps} gaps > {max_gap_days} trading days")

    # Spikes
    if close_col is not None:
        returns = df[close_col].pct_change().dropna().abs()
        n_spikes = int((returns > spike_threshold).sum())
        if n_spikes > 0:
            issues.append(f"{n_spikes} price spikes > {spike_threshold*100:.0f}%")

    # Missing data
    if n_missing > 0:
        issues.append(f"{n_missing} bars with missing values")

    passed = len(issues) == 0
    return DataValidationReport(
        symbol=symbol,
        n_bars=n_bars,
        n_missing=n_missing,
        n_gaps=n_gaps,
        n_spikes=n_spikes,
        n_ohlc_violations=n_violations,
        first_ts=df.index.min().to_pydatetime() if isinstance(df.index, pd.DatetimeIndex) else None,
        last_ts=df.index.max().to_pydatetime() if isinstance(df.index, pd.DatetimeIndex) else None,
        issues=issues,
        passed=passed,
    )


# ── Aggregate ticks to bars ───────────────────────────────────────────────────

def ticks_to_ohlcv(
    ticks: pd.DataFrame,
    freq: str = "1min",
) -> pd.DataFrame:
    """Aggregate tick data into OHLCV bars."""
    if "price" not in ticks.columns:
        raise ValueError("Tick DataFrame must have 'price' column")

    size_col = "size" if "size" in ticks.columns else None

    agg = {"price": ["first", "max", "min", "last"]}
    if size_col:
        agg[size_col] = "sum"

    resampled = ticks.resample(freq).agg(agg)
    resampled.columns = ["open", "high", "low", "close"] + (["volume"] if size_col else [])

    if size_col:
        prices = ticks["price"]
        sizes = ticks[size_col]
        vwap = (prices * sizes).resample(freq).sum() / sizes.resample(freq).sum()
        resampled["vwap"] = vwap

    return resampled.dropna(subset=["close"])
