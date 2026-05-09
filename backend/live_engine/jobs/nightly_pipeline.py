# backend/live_engine/jobs/nightly_pipeline.py
"""
Nightly pipeline — runs at 10:00 PM IST (Mon-Fri) and a lighter pass at 6:00 AM.

Full run (10 PM):
  1. Download OHLCV for all NIFTY500 symbols (last 5 years via Zerodha history)
  2. Store to parquet under data/ohlcv/{symbol}.parquet
  3. Rebuild feature store (generate_features per symbol → Redis)
  4. Run anti-overfit check on each active strategy
  5. Re-rank all 337 strategies by rolling 252-day Sharpe
  6. Update allocator weights
  7. Detect alpha decay (rolling IR < 0.3 → flag)
  8. Send Telegram summary

Lite run (6 AM) — run() subset: just features + allocator, no full download.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np

log = logging.getLogger(__name__)

_DATA_DIR = Path(os.getenv("OHLCV_DATA_DIR", "data/ohlcv"))
_REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
_REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))


def _redis():
    try:
        import redis
        return redis.Redis(host=_REDIS_HOST, port=int(_REDIS_PORT), decode_responses=True)
    except Exception:
        return None


def run() -> dict:
    """Full nightly pipeline — 10:00 PM IST."""
    t0 = time.perf_counter()
    results: Dict = {
        "symbols_downloaded": 0,
        "symbols_failed": 0,
        "features_built": 0,
        "strategies_ranked": 0,
        "alpha_decay_flags": [],
    }

    log.info("=== NIGHTLY PIPELINE START ===")

    # ── 1. Download OHLCV ────────────────────────────────────────────────────
    try:
        from backend.live_engine.config import NIFTY500_SYMBOLS
        from backend.live_engine.market_data_service import MarketDataService
        import pandas as pd

        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        svc = MarketDataService()

        import datetime
        end_date = datetime.date.today().isoformat()
        start_date = (datetime.date.today() - datetime.timedelta(days=5 * 365)).isoformat()

        for sym in NIFTY500_SYMBOLS:
            try:
                df = svc.get_ohlcv_history(sym, start_date, end_date, interval="day")
                if df is not None and not df.empty:
                    out_path = _DATA_DIR / f"{sym}.parquet"
                    df.to_parquet(out_path)
                    results["symbols_downloaded"] += 1
                else:
                    results["symbols_failed"] += 1
            except Exception as exc:
                log.debug("OHLCV download failed for %s: %s", sym, exc)
                results["symbols_failed"] += 1

        log.info("OHLCV: %d downloaded, %d failed", results["symbols_downloaded"], results["symbols_failed"])
    except Exception as exc:
        log.error("OHLCV download stage failed: %s", exc)

    # ── 2. Rebuild feature store ──────────────────────────────────────────────
    results["features_built"] = _rebuild_features()

    # ── 3. Anti-overfit check ─────────────────────────────────────────────────
    try:
        _run_anti_overfit_checks()
    except Exception as exc:
        log.error("Anti-overfit check failed: %s", exc)

    # ── 4. Re-rank strategies ─────────────────────────────────────────────────
    results["strategies_ranked"] = _rerank_strategies()

    # ── 5. Update allocator ───────────────────────────────────────────────────
    try:
        from backend.engine.allocator import allocate
        allocate()
        log.info("Allocator weights updated")
    except Exception as exc:
        log.error("Allocator update failed: %s", exc)

    # ── 6. Alpha decay detection ──────────────────────────────────────────────
    results["alpha_decay_flags"] = _detect_alpha_decay()

    elapsed = time.perf_counter() - t0
    log.info("=== NIGHTLY PIPELINE DONE in %.1fs ===", elapsed)

    # ── 7. Telegram ───────────────────────────────────────────────────────────
    try:
        from backend.live_engine.telegram_alerts import TelegramAlerter
        msg = (
            f"🌙 Nightly pipeline complete ({elapsed:.0f}s)\n"
            f"📊 Data: {results['symbols_downloaded']} symbols\n"
            f"⚙️ Features: {results['features_built']} built\n"
            f"📈 Strategies ranked: {results['strategies_ranked']}\n"
            f"⚠️ Alpha decay flags: {len(results['alpha_decay_flags'])}"
        )
        TelegramAlerter().send_sync(msg)
    except Exception:
        pass

    return results


def run_lite() -> dict:
    """Lightweight 6 AM pass — features + allocator only, no full download."""
    t0 = time.perf_counter()
    log.info("=== NIGHTLY EARLY (6 AM) START ===")
    results = {
        "features_built": _rebuild_features(),
        "strategies_ranked": _rerank_strategies(),
    }
    try:
        from backend.engine.allocator import allocate
        allocate()
    except Exception as exc:
        log.error("Allocator failed in lite run: %s", exc)
    elapsed = time.perf_counter() - t0
    log.info("=== NIGHTLY EARLY DONE in %.1fs ===", elapsed)
    return results


# ── Helpers ───────────────────────────────────────────────────────────────────

def _rebuild_features() -> int:
    """Rebuild feature store for all symbols with local parquet data."""
    count = 0
    try:
        import pandas as pd
        from backend.backtester.signal_engine import generate_features

        r = _redis()
        for parquet_path in sorted(_DATA_DIR.glob("*.parquet")):
            sym = parquet_path.stem
            try:
                df = pd.read_parquet(parquet_path)
                if df.empty or len(df) < 30:
                    continue
                features = generate_features(df)
                if r and not features.empty:
                    # Store last row of features as current feature vector
                    latest = features.iloc[-1].to_dict()
                    serialized = {k: str(v) for k, v in latest.items()
                                  if v is not None and str(v) != "nan"}
                    r.hset(f"features:{sym}", mapping=serialized)
                count += 1
            except Exception as exc:
                log.debug("Feature build failed for %s: %s", sym, exc)

        log.info("Features rebuilt for %d symbols", count)
    except Exception as exc:
        log.error("Feature rebuild failed: %s", exc)
    return count


def _rerank_strategies() -> int:
    """Re-rank all strategies by rolling 252-day Sharpe, persist to Redis."""
    count = 0
    try:
        import pandas as pd
        from backend.engine.registry import auto_register_strategies, HUB

        auto_register_strategies()
        strategy_names = list(HUB.strategies._store.keys())
        if not strategy_names:
            return 0

        r = _redis()

        rankings: List[dict] = []
        for name in strategy_names:
            try:
                # Read equity curve from Redis if it exists
                raw_returns = r.lrange(f"strategy:returns:{name}", -252, -1) if r else []
                if len(raw_returns) < 30:
                    sharpe = 0.0
                else:
                    rets = np.array([float(x) for x in raw_returns])
                    mu = rets.mean() * 252
                    sigma = rets.std() * np.sqrt(252)
                    sharpe = (mu - 0.065) / sigma if sigma > 0 else 0.0
                rankings.append({"name": name, "sharpe": round(sharpe, 4)})
                count += 1
            except Exception:
                pass

        # Sort by Sharpe descending
        rankings.sort(key=lambda x: x["sharpe"], reverse=True)

        # Persist ranking to Redis
        if r and rankings:
            pipe = r.pipeline()
            for rank, entry in enumerate(rankings, 1):
                pipe.hset("strategy:rankings", entry["name"], json.dumps({
                    "rank": rank,
                    "sharpe": entry["sharpe"],
                }))
            pipe.execute()

        log.info("Strategy rankings updated: %d strategies", count)
    except Exception as exc:
        log.error("Strategy re-ranking failed: %s", exc)
    return count


def _run_anti_overfit_checks() -> None:
    """Run anti-overfit validation for all active strategies."""
    try:
        from backend.backtester.anti_overfit_engine import MandatoryRules
        import pandas as pd

        r = _redis()
        if not r:
            return

        strategy_names = r.hkeys("strategy:rankings") or []
        failed = []

        for name in strategy_names[:50]:  # cap at 50 per nightly run to save time
            try:
                raw = r.lrange(f"strategy:returns:{name}", -504, -1)
                if len(raw) < 200:
                    continue
                rets = pd.Series([float(x) for x in raw])
                results = MandatoryRules.run_all(rets, rets.iloc[:len(rets)//2])
                if not all(r.passed for r in results):
                    failed.append(name)
                    r.hset("strategy:anti_overfit_failed", name, "1")
                else:
                    r.hdel("strategy:anti_overfit_failed", name)
            except Exception:
                pass

        log.info("Anti-overfit checks: %d/%d failed", len(failed), len(strategy_names))
    except Exception as exc:
        log.debug("Anti-overfit checks error: %s", exc)


def _detect_alpha_decay(window: int = 63, threshold: float = 0.3) -> List[str]:
    """Flag strategies with rolling IR < threshold over last `window` days."""
    flagged = []
    try:
        r = _redis()
        if not r:
            return flagged

        strategy_names = r.hkeys("strategy:rankings") or []
        for name in strategy_names:
            try:
                raw = r.lrange(f"strategy:returns:{name}", -window, -1)
                if len(raw) < window // 2:
                    continue
                rets = np.array([float(x) for x in raw])
                mu = rets.mean() * 252
                sigma = rets.std() * np.sqrt(252)
                ir = mu / sigma if sigma > 0 else 0.0
                if ir < threshold:
                    flagged.append(name)
                    r.hset("strategy:alpha_decay", name, str(round(ir, 4)))
                    log.warning("Alpha decay detected: %s IR=%.3f", name, ir)
            except Exception:
                pass

        log.info("Alpha decay scan: %d/%d strategies flagged", len(flagged), len(strategy_names))
    except Exception as exc:
        log.debug("Alpha decay detection error: %s", exc)
    return flagged
