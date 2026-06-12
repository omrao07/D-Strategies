# backend/backtester/nse_loader.py
"""
NSE/BSE data loaders for Indian market data.

Supports all common Indian market data formats:
  1. NSE Bhav Copy (daily equity bhavcopy CSV)
  2. NSE F&O Bhav Copy (fo_bhavcopy)
  3. Zerodha Kite Connect historical data CSV
  4. Upstox historical data CSV
  5. Angel Broking / SmartAPI CSV format
  6. NSE bulk download (complete price history)
  7. MoneyControl export format
  8. NSE Index data (NIFTY50, NIFTY500, etc.)
  9. Generic OHLCV (auto-detect column names)

Usage:
    from backend.backtester.nse_loader import NSELoader

    loader = NSELoader()

    # NSE bhav copy directory
    df = loader.load_bhav_copy("/data/bhav/2018/", symbols=["RELIANCE", "TCS"])

    # Zerodha CSV
    df = loader.load_zerodha("/data/zerodha/RELIANCE.csv")

    # Auto-detect
    df = loader.load("path/to/any_format.csv")

    # Use with BacktestEngine
    from backend.backtester.data_feeds import CSVFeed
    feed = loader.to_feed(df, symbols=["RELIANCE", "TCS"])
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import List, Optional, Union

import pandas as pd

log = logging.getLogger(__name__)

# ── Column name mappings ──────────────────────────────────────────────────────

_COL_ALIASES = {
    "open":   ["open", "OPEN", "Open", "open_price", "OPEN_PRICE"],
    "high":   ["high", "HIGH", "High", "high_price", "HIGH_PRICE"],
    "low":    ["low",  "LOW",  "Low",  "low_price",  "LOW_PRICE"],
    "close":  ["close", "CLOSE", "Close", "close_price", "CLOSE_PRICE",
               "ltp", "LTP", "last_price", "LAST_PRICE", "adjclose"],
    "volume": ["volume", "VOLUME", "Volume", "TOTTRDQTY", "tottrdqty",
               "vol", "VOL", "quantity", "QUANTITY"],
    "symbol": ["symbol", "SYMBOL", "Symbol", "ticker", "TICKER",
               "SCRIP_CD", "sc_code", "NSE_SYMBOL", "tradingsymbol"],
    "date":   ["date", "DATE", "Date", "timestamp", "TIMESTAMP",
               "TIMESTAMP1", "datetime", "time", "TIME",
               "trade_date", "TRADE_DATE", "Datetime"],
}


def _find_col(df: pd.DataFrame, field: str) -> Optional[str]:
    for alias in _COL_ALIASES.get(field, []):
        if alias in df.columns:
            return alias
    return None


def _standardize(df: pd.DataFrame) -> pd.DataFrame:
    """Rename columns to standard names: open/high/low/close/volume."""
    rename = {}
    for field in ("open", "high", "low", "close", "volume", "symbol", "date"):
        col = _find_col(df, field)
        if col and col != field:
            rename[col] = field
    return df.rename(columns=rename)


# ── NSE Loader ────────────────────────────────────────────────────────────────

class NSELoader:
    """
    Unified loader for all Indian equity market data formats.
    Returns MultiIndex DataFrame compatible with data_engine.load_ohlcv().
    """

    def __init__(self, adjust_for_splits: bool = True, fill_gaps: bool = True):
        self.adjust_for_splits = adjust_for_splits
        self.fill_gaps = fill_gaps

    # ── NSE Bhav Copy ─────────────────────────────────────────────────────────

    def load_bhav_copy(
        self,
        path: Union[str, Path],
        symbols: Optional[List[str]] = None,
        series: str = "EQ",
    ) -> pd.DataFrame:
        """
        Load NSE equity bhavcopy format.

        Expects either:
          - A single CSV file (bhavcopy_DDMMYY.csv)
          - A directory of bhavcopy files (one per day)

        NSE bhav copy columns:
          SYMBOL, SERIES, OPEN, HIGH, LOW, CLOSE, LAST, PREVCLOSE, TOTTRDQTY, TOTTRDVAL, TIMESTAMP
        """
        path = Path(path)
        if path.is_dir():
            return self._load_bhav_directory(path, symbols, series)
        return self._load_bhav_file(path, symbols, series)

    def _load_bhav_file(
        self, path: Path, symbols: Optional[List[str]], series: str
    ) -> pd.DataFrame:
        df = pd.read_csv(path, dtype=str)
        df.columns = [c.strip() for c in df.columns]

        # Filter by series (EQ = equity, BE = SME, etc.)
        if "SERIES" in df.columns:
            df = df[df["SERIES"].str.strip() == series]

        # Symbol filter
        sym_col = _find_col(df, "symbol") or "SYMBOL"
        if symbols and sym_col in df.columns:
            df = df[df[sym_col].str.strip().isin(set(symbols))]

        df = _standardize(df)
        return self._finalize(df)

    def _load_bhav_directory(
        self, dirpath: Path, symbols: Optional[List[str]], series: str
    ) -> pd.DataFrame:
        frames = []
        csv_files = sorted(dirpath.glob("*.csv"))
        if not csv_files:
            csv_files = sorted(dirpath.glob("**/*.csv"))

        log.info("Loading %d bhav copy files from %s", len(csv_files), dirpath)
        for fpath in csv_files:
            try:
                df = self._load_bhav_file(fpath, symbols, series)
                if not df.empty:
                    frames.append(df)
            except Exception as exc:
                log.debug("Skipping %s: %s", fpath.name, exc)

        if not frames:
            return pd.DataFrame()
        return pd.concat(frames, ignore_index=False).sort_index()

    # ── NSE F&O Bhav Copy ─────────────────────────────────────────────────────

    def load_fo_bhav_copy(
        self,
        path: Union[str, Path],
        instrument_type: str = "FUTSTK",   # FUTSTK, OPTSTK, FUTIDX, OPTIDX
        symbols: Optional[List[str]] = None,
    ) -> pd.DataFrame:
        """
        Load NSE F&O bhav copy (fo_bhavcopyDDMMYYYY.csv).

        Columns: INSTRUMENT, SYMBOL, EXPIRY_DT, STRIKE_PR, OPTION_TYP,
                 OPEN, HIGH, LOW, CLOSE, SETTLE_PR, CONTRACTS, VAL_INLAKH,
                 OPEN_INT, CHG_IN_OI, TIMESTAMP
        """
        path = Path(path)
        if path.is_dir():
            frames = []
            for fpath in sorted(path.glob("fo_bhav*.csv")):
                try:
                    frames.append(self._load_fo_file(fpath, instrument_type, symbols))
                except Exception:
                    pass
            return pd.concat(frames, ignore_index=False).sort_index() if frames else pd.DataFrame()
        return self._load_fo_file(path, instrument_type, symbols)

    def _load_fo_file(
        self, path: Path, instrument_type: str, symbols: Optional[List[str]]
    ) -> pd.DataFrame:
        df = pd.read_csv(path, dtype=str)
        df.columns = [c.strip() for c in df.columns]

        if "INSTRUMENT" in df.columns:
            df = df[df["INSTRUMENT"].str.strip() == instrument_type]

        if symbols and "SYMBOL" in df.columns:
            df = df[df["SYMBOL"].str.strip().isin(set(symbols))]

        # Add open interest as extra column
        df = _standardize(df)
        if "OPEN_INT" in df.columns and "open_interest" not in df.columns:
            df["open_interest"] = pd.to_numeric(df["OPEN_INT"], errors="coerce").fillna(0)

        return self._finalize(df)

    # ── Zerodha Kite ──────────────────────────────────────────────────────────

    def load_zerodha(
        self, path: Union[str, Path], symbol: Optional[str] = None
    ) -> pd.DataFrame:
        """
        Load Zerodha Kite Connect historical data CSV.

        Columns: date, open, high, low, close, volume
        Date format: YYYY-MM-DD HH:MM:SS or YYYY-MM-DD
        """
        df = pd.read_csv(path)
        df.columns = [c.strip().lower() for c in df.columns]
        df = _standardize(df)

        if symbol and "symbol" not in df.columns:
            df["symbol"] = symbol

        return self._finalize(df)

    # ── Upstox ────────────────────────────────────────────────────────────────

    def load_upstox(
        self, path: Union[str, Path], symbol: Optional[str] = None
    ) -> pd.DataFrame:
        """
        Load Upstox historical data CSV.

        Columns: Datetime, open, high, low, close, volume, OI (optional)
        """
        df = pd.read_csv(path)
        # Upstox uses 'Datetime' with capital D
        if "Datetime" in df.columns:
            df = df.rename(columns={"Datetime": "date"})
        df.columns = [c.strip().lower() for c in df.columns]
        df = _standardize(df)

        if symbol and "symbol" not in df.columns:
            df["symbol"] = symbol

        return self._finalize(df)

    # ── Angel Broking / SmartAPI ───────────────────────────────────────────────

    def load_angel(
        self, path: Union[str, Path], symbol: Optional[str] = None
    ) -> pd.DataFrame:
        """Load Angel SmartAPI historical data."""
        df = pd.read_csv(path)
        # Angel format: timestamp, open, high, low, close, volume
        if "timestamp" in df.columns:
            df = df.rename(columns={"timestamp": "date"})
        df.columns = [c.strip().lower() for c in df.columns]
        df = _standardize(df)
        if symbol and "symbol" not in df.columns:
            df["symbol"] = symbol
        return self._finalize(df)

    # ── NSE Index data ────────────────────────────────────────────────────────

    def load_nse_index(
        self, path: Union[str, Path], index_name: str = "NIFTY 50"
    ) -> pd.Series:
        """
        Load NSE index historical data (downloaded from NSE website).
        Returns daily returns Series indexed by date.

        NSE index CSV columns: Date, Open, High, Low, Close
        """
        df = pd.read_csv(path)
        df.columns = [c.strip() for c in df.columns]

        date_col = _find_col(df, "date") or "Date"
        close_col = _find_col(df, "close") or "Close"

        dates = pd.to_datetime(df[date_col], dayfirst=True, errors="coerce")
        closes = pd.to_numeric(
            df[close_col].astype(str).str.replace(",", ""), errors="coerce"
        )

        series = pd.Series(closes.values, index=dates, name=index_name)
        series = series.sort_index().dropna()
        log.info("Loaded %s index: %d bars from %s to %s",
                 index_name, len(series), series.index[0].date(), series.index[-1].date())
        return series

    # ── MoneyControl format ───────────────────────────────────────────────────

    def load_moneycontrol(
        self, path: Union[str, Path], symbol: Optional[str] = None
    ) -> pd.DataFrame:
        """Load MoneyControl historical data export."""
        df = pd.read_csv(path, skiprows=0)
        # MoneyControl: Date,Open,High,Low,Close,Volume
        df.columns = [c.strip() for c in df.columns]
        df = _standardize(df)
        if symbol and "symbol" not in df.columns:
            df["symbol"] = symbol
        return self._finalize(df)

    # ── Auto-detect format ────────────────────────────────────────────────────

    def load(
        self, path: Union[str, Path], symbol: Optional[str] = None
    ) -> pd.DataFrame:
        """
        Auto-detect the data format and load accordingly.
        Falls back to generic OHLCV if format is unrecognized.
        """
        path = Path(path)
        if path.is_dir():
            return self.load_bhav_copy(path)

        # Peek at first line to detect format
        try:
            header = pd.read_csv(path, nrows=1).columns.tolist()
        except Exception:
            log.warning("Could not read %s", path)
            return pd.DataFrame()

        header_lower = [h.lower().strip() for h in header]

        if "tottrdqty" in header_lower or "prevclose" in header_lower:
            return self._load_bhav_file(path, symbols=None, series="EQ")
        elif "instrument" in header_lower and "open_int" in header_lower:
            return self._load_fo_file(path, "FUTSTK", symbols=None)
        elif "datetime" in header_lower:
            return self.load_upstox(path, symbol)
        elif "timestamp" in header_lower:
            return self.load_angel(path, symbol)
        else:
            return self.load_zerodha(path, symbol)   # most generic

    # ── Multi-symbol loader ───────────────────────────────────────────────────

    def load_directory(
        self,
        dirpath: Union[str, Path],
        pattern: str = "*.csv",
        symbol_from_filename: bool = True,
    ) -> pd.DataFrame:
        """
        Load a directory of per-symbol CSVs (one file per symbol).
        Symbol is inferred from the filename unless symbol column exists.
        """
        dirpath = Path(dirpath)
        frames = []
        for fpath in sorted(dirpath.glob(pattern)):
            sym = fpath.stem.upper() if symbol_from_filename else None
            try:
                df = self.load(fpath, symbol=sym)
                if not df.empty:
                    frames.append(df)
            except Exception as exc:
                log.debug("Skipping %s: %s", fpath.name, exc)

        if not frames:
            return pd.DataFrame()
        return pd.concat(frames).sort_index()

    # ── To DataFeed ───────────────────────────────────────────────────────────

    def to_feed(
        self,
        df: pd.DataFrame,
        symbols: Optional[List[str]] = None,
        freq: str = "1d",
    ):
        """
        Convert a loaded DataFrame to a CSVFeed-compatible DataFeed.
        The returned feed can be passed directly to BacktestEngine.run().
        """
        from backend.backtester.data_feeds import CSVFeed
        return CSVFeed(df=df, symbols=symbols, freq=freq)

    # ── Finalization ──────────────────────────────────────────────────────────

    def _finalize(self, df: pd.DataFrame) -> pd.DataFrame:
        """Parse dates, coerce numerics, set DatetimeIndex."""
        if df.empty:
            return df

        # Parse date
        date_col = _find_col(df, "date") or "date"
        if date_col in df.columns:
            df["date"] = pd.to_datetime(df[date_col], dayfirst=True, errors="coerce")
        else:
            df["date"] = pd.NaT

        # Coerce numeric columns
        for col in ("open", "high", "low", "close", "volume"):
            if col in df.columns:
                df[col] = (
                    df[col].astype(str)
                    .str.replace(",", "").str.replace(" ", "")
                    .pipe(pd.to_numeric, errors="coerce")
                )

        # Drop rows without a date or close price
        df = df.dropna(subset=["date", "close"] if "close" in df.columns else ["date"])
        df = df.set_index("date").sort_index()

        # Fill volume with 0 if missing
        if "volume" not in df.columns:
            df["volume"] = 0.0

        # Fill gaps if enabled — ffill only (bfill uses future prices)
        if self.fill_gaps:
            df = df.ffill()

        return df


# ── Convenience functions ─────────────────────────────────────────────────────

def load_nse_bhav(dirpath: str, symbols: Optional[List[str]] = None) -> pd.DataFrame:
    """One-liner: load NSE bhav copy directory."""
    return NSELoader().load_bhav_copy(dirpath, symbols=symbols)


def load_zerodha(path: str, symbol: str) -> pd.DataFrame:
    """One-liner: load Zerodha CSV."""
    return NSELoader().load_zerodha(path, symbol=symbol)


def load_upstox(path: str, symbol: str) -> pd.DataFrame:
    """One-liner: load Upstox CSV."""
    return NSELoader().load_upstox(path, symbol=symbol)


def load_nifty50_index(path: str) -> pd.Series:
    """One-liner: load NIFTY50 index from NSE CSV."""
    return NSELoader().load_nse_index(path, "NIFTY 50")


def auto_load(path: str, symbol: Optional[str] = None) -> pd.DataFrame:
    """One-liner: auto-detect and load any Indian market data file."""
    return NSELoader().load(path, symbol=symbol)
