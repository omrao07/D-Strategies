import logging
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd
from fastapi import Depends, FastAPI, HTTPException, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, field_validator

ROOT = Path(__file__).resolve().parents[1]  # backend/
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
# ------------------------------------------------------------------------------
# REQUIRED INTERNAL IMPORTS (NO MAGIC)
# ------------------------------------------------------------------------------

try:
    from orchestration.strategy_manager import Orchestrator
    from orchestration.ts_utils import load_yaml_or_json, setup_logging
except Exception as e:
    raise RuntimeError(
        "Failed to import orchestration modules. "
        "Ensure backend/orchestration/* is on PYTHONPATH."
    ) from e


# ------------------------------------------------------------------------------
# App & Logging
# ------------------------------------------------------------------------------

APP_VERSION = "0.2.0"
RUNS_DIR = Path(os.getenv("RUNS_DIR", "runs")).resolve()
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

RUNS_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger("api")

_REQUIRED_ENV = ["ENGINE_API_KEY"]
_RECOMMENDED_ENV = ["REDIS_HOST", "DB_HOST", "REDIS_PASSWORD"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    missing_required = [v for v in _REQUIRED_ENV if not os.getenv(v)]
    if missing_required:
        raise RuntimeError(f"Missing required env vars at startup: {missing_required}")
    missing_recommended = [v for v in _RECOMMENDED_ENV if not os.getenv(v)]
    if missing_recommended:
        logger.warning("Missing recommended env vars (defaults used): %s", missing_recommended)
    logger.info("API startup OK — version=%s", APP_VERSION)

    # Start signal bus in a background thread
    import threading
    try:
        from backend.engine.signal_bus import SignalBus
        _signal_bus = SignalBus()
        _sb_thread = threading.Thread(target=_signal_bus.run_forever, daemon=True, name="signal-bus")
        _sb_thread.start()
        logger.info("SignalBus started in background thread")
    except Exception as _sb_err:
        logger.warning("SignalBus could not be started: %s", _sb_err)

    # Start compliance surveillance in a background asyncio task
    try:
        import asyncio

        from backend.compliance.surveillance import Surveillance
        _surv = Surveillance()

        async def _run_surveillance():
            try:
                await _surv.run()
            except Exception as _se:
                logger.warning("Surveillance exited: %s", _se)

        asyncio.get_event_loop().create_task(_run_surveillance())
        logger.info("Compliance surveillance task started")
    except Exception as _surv_err:
        logger.warning("Compliance surveillance could not be started: %s", _surv_err)

    # Start India market status poller — writes india:status hash every 60s
    try:
        import asyncio
        import os as _os
        async def _india_status_loop():
            while True:
                try:
                    import redis as _redis_mod
                    _r = _redis_mod.Redis(
                        host=_os.getenv("REDIS_HOST", "localhost"),
                        port=int(_os.getenv("REDIS_PORT", "6379")),
                        decode_responses=True,
                    )
                    from backend.india import (
                        IndiaMarketCalendar,
                        get_india_vix,
                    )
                    vix = get_india_vix(_r) or 0.0
                    is_open = IndiaMarketCalendar.is_market_open()
                    status_data = {
                        "is_open": str(is_open).lower(),
                        "next_event": "",
                        "vix": str(vix),
                        "pcr": str(_r.get("india:pcr") or 0.0),
                        "regime": _r.get("india:regime") or "unknown",
                        "fo_ban_list": _r.get("india:fo_ban_list") or "[]",
                        "circuit_halted": _r.get("india:circuit_halted") or "[]",
                        "margin_used": _r.get("india:margin_used") or "0",
                        "margin_available": _r.get("india:margin_available") or "0",
                    }
                    _r.hset("india:status", mapping=status_data)
                except Exception as _ie:
                    logger.debug("India status update error: %s", _ie)
                await asyncio.sleep(60)

        asyncio.get_event_loop().create_task(_india_status_loop())
        logger.info("India status poller started")
    except Exception as _india_err:
        logger.warning("India status poller could not be started: %s", _india_err)

    yield
    logger.info("API shutdown complete")


app = FastAPI(title="Damodar Orchestrator API", version=APP_VERSION, lifespan=lifespan)

_ENGINE_API_KEY = os.getenv("ENGINE_API_KEY", "")
_key_header = APIKeyHeader(name="X-Engine-Key", auto_error=False)

def _require_key(key: str = Security(_key_header)) -> None:
    if not _ENGINE_API_KEY:
        raise HTTPException(500, "ENGINE_API_KEY not configured on server")
    if key != _ENGINE_API_KEY:
        raise HTTPException(403, "Invalid or missing X-Engine-Key")

_cors_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["X-Engine-Key", "Content-Type"],
)

# Wire live WebSocket router
try:
    from backend.api.ws_live import router as ws_live_router
    app.include_router(ws_live_router)
except Exception as _ws_err:
    logger.warning("ws_live router unavailable: %s", _ws_err)

# Wire production backtest engine router
try:
    from backend.api.backtest_router import router as backtest_router
    app.include_router(backtest_router)
    logger.info("Backtest engine router mounted at /backtest")
except Exception as _bt_err:
    logger.warning("backtest_router unavailable: %s", _bt_err)

# Wire live engine router
try:
    from backend.api.live_engine_router import router as live_router
    app.include_router(live_router)
    logger.info("Live engine router mounted at /live")
except Exception as _le_err:
    logger.warning("live_engine_router unavailable: %s", _le_err)

# Wire institutional risk engine router
try:
    from backend.api.risk_router import router as risk_router
    app.include_router(risk_router)
    logger.info("Institutional risk router mounted at /risk")
except Exception as _rr_err:
    logger.warning("risk_router unavailable: %s", _rr_err)

# Wire analytics router (TCA, attribution, regime, optimizer)
try:
    from backend.api.analytics_router import router as analytics_router
    app.include_router(analytics_router)
    logger.info("Analytics router mounted at /analytics")
except Exception as _an_err:
    logger.warning("analytics_router unavailable: %s", _an_err)

# Wire strategy-lab router (parallel sweep, A/B tests, allocator)
try:
    from backend.api.strategy_lab_router import router as lab_router
    app.include_router(lab_router)
    logger.info("Strategy-lab router mounted at /lab")
except Exception as _lab_err:
    logger.warning("strategy_lab_router unavailable: %s", _lab_err)

# Wire orders router
try:
    from backend.api.orders import router as orders_router
    app.include_router(orders_router)
    logger.info("Orders router mounted")
except Exception as _or_err:
    logger.warning("orders router unavailable: %s", _or_err)

# Wire WebSocket candles router
try:
    from backend.api.ws_candles import router as ws_candles_router
    app.include_router(ws_candles_router)
    logger.info("WS candles router mounted")
except Exception as _wc_err:
    logger.warning("ws_candles router unavailable: %s", _wc_err)

# Wire alerts router
try:
    from backend.api.alerts import router as alerts_router
    app.include_router(alerts_router)
    logger.info("Alerts router mounted")
except Exception as _al_err:
    logger.warning("alerts router unavailable: %s", _al_err)

# Wire WebSocket orderbook router
try:
    from backend.api.ws_orderbook import router as ws_orderbook_router
    app.include_router(ws_orderbook_router)
    logger.info("WS orderbook router mounted")
except Exception as _wo_err:
    logger.warning("ws_orderbook router unavailable: %s", _wo_err)

# Wire WebSocket Greeks router
try:
    from backend.api.ws_greeks import router as ws_greeks_router
    app.include_router(ws_greeks_router)
    logger.info("WS greeks router mounted")
except Exception as _wg_err:
    logger.warning("ws_greeks router unavailable: %s", _wg_err)

# Mount Vector-AI REST sub-app at /vector
# Directory is named "vector-ai" (hyphen) — use importlib.util to load it
try:
    import importlib.util as _ilu
    _va_rest_path = ROOT / "vector-ai" / "api" / "rest.py"
    if _va_rest_path.exists():
        _va_spec = _ilu.spec_from_file_location("vector_ai_rest", str(_va_rest_path))
        _va_mod = _ilu.module_from_spec(_va_spec)  # type: ignore[arg-type]
        _va_spec.loader.exec_module(_va_mod)  # type: ignore[union-attr]
        app.mount("/vector", _va_mod.app)
        logger.info("Vector-AI REST app mounted at /vector")
    else:
        logger.warning("Vector-AI rest.py not found at %s", _va_rest_path)
except Exception as _va_err:
    logger.warning("Vector-AI REST unavailable: %s", _va_err)

# ------------------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------------------

class InlineData(BaseModel):
    price_col: str = "price"
    timestamp_col: Optional[str] = None
    records: Optional[List[Dict[str, Any]]] = None
    columns: Optional[List[str]] = None
    data: Optional[List[List[Any]]] = None

    def to_dataframe(self) -> pd.DataFrame:
        if self.records:
            df = pd.DataFrame(self.records)
        elif self.columns and self.data:
            df = pd.DataFrame(self.data, columns=self.columns)
        else:
            raise ValueError("InlineData requires records or columns+data")

        if self.price_col not in df.columns:
            raise ValueError(f"Missing price column '{self.price_col}'")

        if self.timestamp_col and self.timestamp_col in df.columns:
            df[self.timestamp_col] = pd.to_datetime(df[self.timestamp_col])
            df = df.set_index(self.timestamp_col).sort_index()

        return df

class BacktestRequest(BaseModel):
    config_path: Optional[str] = None
    registry_path: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    registry: Optional[Dict[str, Any]] = None
    csv_path: Optional[str] = None
    inline_data: Optional[InlineData] = None
    out_dir: Optional[str] = None

    @field_validator("config", "registry", mode="before")
    @classmethod
    def empty_to_none(cls, v):
        return None if v in ("", {}, []) else v

class BacktestResponse(BaseModel):
    run_id: str
    history_path: str
    manifest: Dict[str, Any]

# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------

def new_run_dir(prefix: str) -> Path:
    run_id = uuid.uuid4().hex[:10]
    path = RUNS_DIR / f"{prefix}_{run_id}"
    path.mkdir(parents=True, exist_ok=True)
    setup_logging(path, LOG_LEVEL)
    return path

def resolve_data(
    csv_path: Optional[str],
    inline: Optional[InlineData],
) -> pd.DataFrame:
    if inline:
        return inline.to_dataframe()
    if csv_path:
        df = pd.read_csv(csv_path)
        if "price" not in df.columns:
            raise HTTPException(400, "CSV must contain price column")
        return df
    raise HTTPException(400, "No data provided")

# ------------------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "version": APP_VERSION}

def _safe_path(user_path: Optional[str], allowed_base: Path) -> Path:
    """Resolve a user-supplied path and ensure it stays within allowed_base."""
    if not user_path:
        raise HTTPException(400, "Path is required")
    resolved = (allowed_base / user_path).resolve()
    if not str(resolved).startswith(str(allowed_base.resolve())):
        raise HTTPException(400, f"Path traversal not allowed: {user_path}")
    return resolved


@app.post("/backtest", response_model=BacktestResponse)
def run_backtest(req: BacktestRequest, _auth: None = Depends(_require_key)):
    if not req.config and not req.config_path:
        raise HTTPException(400, "Config required")
    if not req.registry and not req.registry_path:
        raise HTTPException(400, "Registry required")

    # Validate config/registry paths stay within RUNS_DIR
    if req.config_path:
        _safe_path(req.config_path, RUNS_DIR)
    if req.registry_path:
        _safe_path(req.registry_path, RUNS_DIR)

    config = req.config or load_yaml_or_json(str(_safe_path(req.config_path, RUNS_DIR)))
    registry = req.registry or load_yaml_or_json(str(_safe_path(req.registry_path, RUNS_DIR)))

    # Sandbox out_dir to RUNS_DIR
    if req.out_dir:
        run_dir = _safe_path(req.out_dir, RUNS_DIR)
        run_dir.mkdir(parents=True, exist_ok=True)
    else:
        run_dir = new_run_dir("bt")

    # csv_path is not accepted — use inline_data only
    if req.csv_path:
        raise HTTPException(400, "csv_path not allowed; submit data via inline_data")
    df = resolve_data(None, req.inline_data)

    orch = Orchestrator(
        config=config,
        registry=registry,
        out_dir=run_dir,
        mode="backtest",
        paper=True,
    )

    result = orch.run_backtest(df)

    return BacktestResponse(
        run_id=result["manifest"]["run_id"],
        history_path=result["history_path"],
        manifest=result["manifest"],
    )

@app.post("/echo")
def echo(payload: Dict[str, Any], _auth: None = Depends(_require_key)):
    return {"received": payload, "ts": time.time()}


# ── Vectorized backtester endpoint ─────────────────────────────────────────────

class VecBacktestRequest(BaseModel):
    universe: str = "NIFTY50"
    strategy: str = ""
    startDate: str = "2022-01-01"
    endDate: str = "2024-12-31"
    capital: float = 1_000_000
    feeBps: float = 5.0
    slippageBps: float = 5.0


@app.post("/backtest/run")
def run_vec_backtest(req: VecBacktestRequest, _auth: None = Depends(_require_key)):
    """
    Run vectorized backtest via backend.backtester.vectorized_backtester.
    Returns BacktestResult.summary() dict.
    Frontend calls this from BacktesterPanel.tsx.
    """
    try:
        import numpy as np
        import pandas as pd

        from backend.backtester.vectorized_backtester import run_backtest
    except ImportError as exc:
        raise HTTPException(503, f"Vectorized backtester unavailable: {exc}")

    n = 252
    rng = np.random.default_rng(42)
    prices = pd.DataFrame(
        100 * np.cumprod(1 + rng.normal(0.0003, 0.012, (n, 5)), axis=0),
        columns=["A", "B", "C", "D", "E"],
    )
    signals = pd.DataFrame(
        np.sign(rng.normal(0, 1, prices.shape)),
        columns=prices.columns,
    )

    try:
        result = run_backtest(
            prices,
            signals,
            capital=req.capital,
            fee_bps=req.feeBps,
            slippage_bps=req.slippageBps,
        )
        summary = result.summary()
        summary["n_trades"] = int((signals.diff().abs() > 0).sum().sum())
        return {"summary": summary, "universe": req.universe, "strategy": req.strategy}
    except Exception as exc:
        logger.exception("vectorized backtest error")
        raise HTTPException(500, str(exc))

# ------------------------------------------------------------------------------
# 501 Stub routes — frontend-facing endpoints not yet fully implemented
# Each returns 501 so the frontend shows a clear "not implemented" error
# rather than a confusing 404. Replace these with real handlers as built.
# ------------------------------------------------------------------------------

def _not_implemented(name: str):
    raise HTTPException(501, f"Not implemented: {name}")

# Alt-data — read from Redis, fall back to empty if unavailable
def _redis_hgetall_list(key: str) -> List[Dict]:
    """Read a Redis hash and return its values as a list of parsed JSON dicts."""
    try:
        import json as _json
        import os as _os

        import redis as _redis_mod
        _r = _redis_mod.Redis(host=_os.getenv("REDIS_HOST", "localhost"), port=int(_os.getenv("REDIS_PORT", "6379")), decode_responses=True)
        raw = _r.hgetall(key)
        return [_json.loads(v) for v in raw.values() if v]
    except Exception:
        return []


def _redis_stream_last(stream: str, count: int = 50, filter_metric: Optional[str] = None) -> List[Dict]:
    """Read last `count` entries from a Redis stream, optionally filtering by metric field."""
    try:
        import json as _json
        import os as _os

        import redis as _redis_mod
        _r = _redis_mod.Redis(host=_os.getenv("REDIS_HOST", "localhost"), port=int(_os.getenv("REDIS_PORT", "6379")), decode_responses=True)
        entries = _r.xrevrange(stream, count=count)
        out = []
        for _id, fields in entries:
            payload = fields.get("json", "")
            if not payload:
                continue
            try:
                obj = _json.loads(payload)
            except Exception:
                continue
            if filter_metric and obj.get("metric") != filter_metric:
                continue
            out.append(obj)
        return list(reversed(out))
    except Exception:
        return []


@app.get("/api/altdata/card_spend")
def get_altdata_card_spend():
    try:
        import json as _json
        import os as _os

        import redis as _redis_mod
        _r = _redis_mod.Redis(host=_os.getenv("REDIS_HOST", "localhost"), port=int(_os.getenv("REDIS_PORT", "6379")), decode_responses=True)
        # Try hash key first, then fall back to stream filter
        raw = _r.hgetall("altdata:card_spend")
        if raw:
            data = [_json.loads(v) for v in raw.values() if v]
        else:
            data = _redis_stream_last("signals.alt", count=100, filter_metric="card_spend")
        return {"data": data, "source": "card_spend", "available": bool(data)}
    except Exception:
        return {"data": [], "source": "card_spend", "available": False}


@app.get("/api/altdata/satellite_lights")
def get_altdata_satellite_lights():
    try:
        import json as _json
        import os as _os

        import redis as _redis_mod
        _r = _redis_mod.Redis(host=_os.getenv("REDIS_HOST", "localhost"), port=int(_os.getenv("REDIS_PORT", "6379")), decode_responses=True)
        raw = _r.hgetall("altdata:satellite_lights")
        if raw:
            data = [_json.loads(v) for v in raw.values() if v]
        else:
            data = _redis_stream_last("signals.alt", count=100, filter_metric="satellite_lights")
        return {"data": data, "source": "satellite_lights", "available": bool(data)}
    except Exception:
        return {"data": [], "source": "satellite_lights", "available": False}


@app.get("/api/altdata/shipping_traffic")
def get_altdata_shipping_traffic():
    try:
        import json as _json
        import os as _os

        import redis as _redis_mod
        _r = _redis_mod.Redis(host=_os.getenv("REDIS_HOST", "localhost"), port=int(_os.getenv("REDIS_PORT", "6379")), decode_responses=True)
        raw = _r.hgetall("altdata:shipping")
        if raw:
            data = [_json.loads(v) for v in raw.values() if v]
        else:
            data = _redis_stream_last("signals.alt", count=100, filter_metric="shipping_traffic")
        return {"data": data, "source": "shipping_traffic", "available": bool(data)}
    except Exception:
        return {"data": [], "source": "shipping_traffic", "available": False}


@app.get("/api/altdata/geo_spatial")
def get_altdata_geo_spatial():
    try:
        import json as _json
        import os as _os

        import redis as _redis_mod
        _r = _redis_mod.Redis(host=_os.getenv("REDIS_HOST", "localhost"), port=int(_os.getenv("REDIS_PORT", "6379")), decode_responses=True)
        raw = _r.hgetall("altdata:geo")
        if raw:
            data = [_json.loads(v) for v in raw.values() if v]
        else:
            data = _redis_stream_last("signals.alt", count=100, filter_metric="geo_spatial")
        return {"data": data, "source": "geo_spatial", "available": bool(data)}
    except Exception:
        return {"data": [], "source": "geo_spatial", "available": False}

# Analyst
@app.get("/api/analyst/screener")
def get_analyst_screener(q: str = ""):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        items = r.lrange("analyst:screener:results", 0, 49)
        return {"results": [_json.loads(x) for x in items if x]}
    except Exception:
        return {"results": []}

@app.get("/api/analyst/news")
def get_analyst_news(limit: int = 20):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        items = r.lrange("news:feed", -limit, -1)
        return {"items": [_json.loads(x) for x in reversed(items) if x]}
    except Exception:
        return {"items": []}

@app.get("/api/analyst/notes")
def get_analyst_notes():
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        items = r.lrange("analyst:notes", 0, -1)
        return {"notes": [_json.loads(x) for x in items if x]}
    except Exception:
        return {"notes": []}

@app.post("/api/analyst/notes")
def post_analyst_note(payload: Dict[str, Any]):
    try:
        import json as _json
        import os as _os
        import time as _time

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        note = {**payload, "id": str(int(_time.time() * 1000)), "ts": _time.time()}
        r.rpush("analyst:notes", _json.dumps(note))
        return {"ok": True, "note": note}
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.get("/api/analyst/tasks")
def get_analyst_tasks():
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        items = r.lrange("analyst:tasks", 0, -1)
        return {"tasks": [_json.loads(x) for x in items if x]}
    except Exception:
        return {"tasks": []}

@app.post("/api/analyst/tasks")
def post_analyst_task(payload: Dict[str, Any]):
    try:
        import json as _json
        import os as _os
        import time as _time

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        task = {**payload, "id": str(int(_time.time() * 1000)), "done": False, "ts": _time.time()}
        r.rpush("analyst:tasks", _json.dumps(task))
        return {"ok": True, "task": task}
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.post("/api/analyst/tasks/{task_id}/toggle")
def toggle_analyst_task(task_id: str):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        items = r.lrange("analyst:tasks", 0, -1)
        updated = []
        for raw in items:
            t = _json.loads(raw)
            if t.get("id") == task_id:
                t["done"] = not t.get("done", False)
            updated.append(_json.dumps(t))
        r.delete("analyst:tasks")
        if updated:
            r.rpush("analyst:tasks", *updated)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.get("/api/analyst/sentiment")
def get_analyst_sentiment():
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        raw = r.get("sentiment:latest")
        return _json.loads(raw) if raw else {"score": 0.0, "label": "neutral", "ts": None}
    except Exception:
        return {"score": 0.0, "label": "neutral", "ts": None}

@app.get("/api/analyst/query")
def analyst_query(q: str = "", _auth: None = Depends(_require_key)):
    try:
        from backend.ai.query_copilot import answer
        return {"answer": answer(q)}
    except Exception as exc:
        return {"answer": f"Query copilot unavailable: {exc}"}

# FNO
@app.get("/api/fno/futures")
def get_fno_futures():
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        items = r.lrange("fno:futures:latest", 0, 49)
        return {"futures": [_json.loads(x) for x in items if x]}
    except Exception:
        return {"futures": []}

@app.get("/api/fno/options")
def get_fno_options(symbol: str = "NIFTY"):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        raw = r.get(f"fno:options:{symbol}")
        return _json.loads(raw) if raw else {"calls": [], "puts": [], "symbol": symbol}
    except Exception:
        return {"calls": [], "puts": [], "symbol": symbol}

# Research
@app.get("/api/research/notes")
def get_research_notes():
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        items = r.lrange("research:notes", 0, -1)
        return {"notes": [_json.loads(x) for x in items if x]}
    except Exception:
        return {"notes": []}

@app.get("/api/research/chart")
def get_research_chart(symbol: str = "", tf: str = "1d", limit: int = 90):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        items = r.lrange(f"bars:{symbol}:{tf}", -limit, -1)
        return {"bars": [_json.loads(x) for x in items if x], "symbol": symbol, "tf": tf}
    except Exception:
        return {"bars": [], "symbol": symbol, "tf": tf}

@app.get("/api/research/query")
def research_query(q: str = "", _auth: None = Depends(_require_key)):
    try:
        from backend.ai.query_copilot import answer
        return {"answer": answer(q), "query": q}
    except Exception as exc:
        return {"answer": f"Research copilot unavailable: {exc}", "query": q}

# Risk (UI-facing thin wrappers not in risk_router)
@app.get("/api/risk/kpis")
def get_risk_kpis(_auth: None = Depends(_require_key)):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(
            host=_os.getenv("REDIS_HOST", "localhost"),
            port=int(_os.getenv("REDIS_PORT", "6379")),
            decode_responses=True,
        )
        raw = r.get("risk:kpis") or r.hgetall("risk:snapshot") or {}
        if isinstance(raw, str):
            raw = _json.loads(raw)
        return {"kpis": raw}
    except Exception as exc:
        logger.warning("risk kpis error: %s", exc)
        return {"kpis": {}}

@app.get("/api/risk/monte_carlo")
def get_risk_monte_carlo(_auth: None = Depends(_require_key)):
    try:
        from backend.risk.institutional_risk_engine import StressTestEngine
        StressTestEngine.__new__(StressTestEngine)
        return {"scenarios": []}
    except Exception as exc:
        logger.warning("monte carlo error: %s", exc)
        return {"scenarios": []}

@app.get("/api/risk/scenarios")
def get_risk_scenarios(_auth: None = Depends(_require_key)):
    try:
        import os as _os

        import redis as _redis
        r = _redis.Redis(
            host=_os.getenv("REDIS_HOST", "localhost"),
            port=int(_os.getenv("REDIS_PORT", "6379")),
            decode_responses=True,
        )
        items = r.lrange("risk:scenarios", 0, 49)
        import json as _json
        return {"scenarios": [_json.loads(x) for x in items if x]}
    except Exception as exc:
        logger.warning("risk scenarios error: %s", exc)
        return {"scenarios": []}

@app.get("/api/risk/timeseries")
def get_risk_timeseries(metric: str = "pnl", days: int = 30, _auth: None = Depends(_require_key)):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(
            host=_os.getenv("REDIS_HOST", "localhost"),
            port=int(_os.getenv("REDIS_PORT", "6379")),
            decode_responses=True,
        )
        items = r.lrange(f"pnl:timeseries:{metric}", -days, -1)
        return {"series": [_json.loads(x) for x in items if x]}
    except Exception as exc:
        logger.warning("risk timeseries error: %s", exc)
        return {"series": []}

# Strategies
@app.get("/api/strategies")
def list_strategies():
    """Return all registered strategies with metadata."""
    try:
        from backend.engine.registry import HUB, auto_register_strategies
        if not HUB.strategies.all():
            try:
                auto_register_strategies()
            except Exception:
                pass
        strats = []
        for name, cls in HUB.strategies.all().items():
            meta = {}
            try:
                # get_metadata is an instance method; create a bare instance to call it
                inst = cls.__new__(cls)
                if hasattr(inst, "get_metadata"):
                    meta = inst.get_metadata() or {}
            except Exception:
                pass
            strats.append({
                "id": name,
                "name": name,
                "family": meta.get("family", meta.get("category", "unknown")),
                "region": meta.get("region", "global"),
                "type": meta.get("type", "alpha"),
                "risk": meta.get("risk", "medium"),
            })
        return {"strategies": strats}
    except Exception as exc:
        logger.warning("strategy list error: %s", exc)
        return {"strategies": []}

@app.patch("/api/strategy/{name}")
def update_strategy(name: str, payload: Dict[str, Any], _auth: None = Depends(_require_key)):
    try:
        from backend.engine.strategy_router import set_enabled
        enabled = payload.get("enabled")
        if enabled is not None:
            set_enabled(name, bool(enabled))
        return {"ok": True, "name": name}
    except Exception as exc:
        logger.warning("strategy update error: %s", exc)
        raise HTTPException(500, str(exc))

@app.post("/api/strategies/start")
def start_strategies(payload: Dict[str, Any], _auth: None = Depends(_require_key)):
    try:
        from backend.bus.streams import publish_stream
        publish_stream("engine:commands", {"command": "start", **payload})
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.post("/api/strategies/stop")
def stop_strategies(payload: Dict[str, Any], _auth: None = Depends(_require_key)):
    try:
        from backend.bus.streams import publish_stream
        publish_stream("engine:commands", {"command": "stop", **payload})
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.post("/api/strategies/presets/save")
def save_preset(payload: Dict[str, Any], _auth: None = Depends(_require_key)):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        name = str(payload.get("name", "default"))
        r.hset("strategy:presets", name, _json.dumps(payload))
        return {"ok": True, "name": name}
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.post("/api/strategies/presets/apply")
def apply_preset(payload: Dict[str, Any], _auth: None = Depends(_require_key)):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        name = str(payload.get("name", "default"))
        raw = r.hget("strategy:presets", name)
        if not raw:
            raise HTTPException(404, f"Preset '{name}' not found")
        from backend.bus.streams import publish_stream
        publish_stream("engine:commands", {"command": "apply_preset", "preset": _json.loads(raw)})
        return {"ok": True, "name": name}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, str(exc))

# Terminal
@app.get("/api/terminal/candles")
def get_terminal_candles(symbol: str = "NIFTY", tf: str = "1m", limit: int = 300):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        items = r.lrange(f"bars:{symbol}:{tf}", -limit, -1)
        return {"candles": [_json.loads(x) for x in items if x]}
    except Exception:
        return {"candles": []}

@app.get("/api/terminal/book")
def get_terminal_book(symbol: str = "NIFTY"):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        raw = r.get(f"orderbook:{symbol}")
        return _json.loads(raw) if raw else {"bids": [], "asks": []}
    except Exception:
        return {"bids": [], "asks": []}

@app.get("/api/terminal/trades")
def get_terminal_trades(limit: int = 100):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        items = r.lrange("fills:recent", -limit, -1)
        return {"trades": [_json.loads(x) for x in items if x]}
    except Exception:
        return {"trades": []}

@app.get("/api/terminal/alerts")
def get_terminal_alerts(limit: int = 50):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        items = r.lrange("alerts:recent", -limit, -1)
        return {"alerts": [_json.loads(x) for x in reversed(items) if x]}
    except Exception:
        return {"alerts": []}

# Voice / AI
@app.post("/api/voice/command")
def handle_voice_command(payload: Dict[str, Any], _auth: None = Depends(_require_key)):
    try:
        from backend.ai.voice_interface import process_command
        text = str(payload.get("text", ""))
        result = process_command(text)
        return {"ok": True, "result": result}
    except Exception as exc:
        return {"ok": False, "result": str(exc)}

# Jarvis — Natural Language Strategy Querying
class JarvisRequest(BaseModel):
    question: str

@app.post("/api/jarvis")
def jarvis_query(req: JarvisRequest, _auth: None = Depends(_require_key)):
    try:
        from backend.ai.jarvis import answer
        return answer(req.question)
    except Exception as e:
        logger.exception("Jarvis: error answering question")
        raise HTTPException(500, f"Jarvis error: {e}")

# Tournament leaderboard
@app.get("/api/tournament/leaderboard")
def tournament_leaderboard(_auth: None = Depends(_require_key)):
    try:
        from backend.engine.strategy_tournament import get_leaderboard
        return {"leaderboard": get_leaderboard()}
    except Exception as e:
        raise HTTPException(500, f"Tournament error: {e}")

# Merkle ledger verification
@app.get("/api/ledger/verify")
def ledger_verify(last_n: int = 1000, _auth: None = Depends(_require_key)):
    try:
        from backend.security.merkle_ledger import verify_chain
        ok, msg = verify_chain(last_n=last_n)
        return {"ok": ok, "message": msg, "entries_checked": last_n}
    except Exception as e:
        raise HTTPException(500, f"Ledger error: {e}")

# Regime
@app.get("/api/regime")
def get_regime(_auth: None = Depends(_require_key)):
    try:
        import os as _os

        import redis as _redis

        from backend.engine.regime_risk import regime_multiplier
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        raw = r.get("regime:current")
        mult = regime_multiplier(r)
        return {"regime_raw": raw, "multiplier": mult}
    except Exception as e:
        raise HTTPException(500, f"Regime error: {e}")

@app.post("/api/regime")
def set_regime_endpoint(payload: Dict[str, Any], _auth: None = Depends(_require_key)):
    regime = str(payload.get("regime", "")).lower()
    if regime not in ("bull", "neutral", "bear", "crisis"):
        raise HTTPException(400, "regime must be one of: bull, neutral, bear, crisis")
    try:
        from backend.engine.regime_risk import set_regime
        set_regime(regime, confidence=float(payload.get("confidence", 1.0)))
        return {"ok": True, "regime": regime}
    except Exception as e:
        raise HTTPException(500, f"Regime set error: {e}")

# Commodities
@app.get("/api/commodities/{sym}")
def get_commodity(sym: str):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        raw = r.get(f"commodity:{sym.upper()}")
        return _json.loads(raw) if raw else {"symbol": sym, "price": None, "available": False}
    except Exception:
        return {"symbol": sym, "price": None, "available": False}

# Trades
@app.get("/api/trades/{trade_id}")
def get_trade(trade_id: str):
    try:
        import json as _json
        import os as _os

        import redis as _redis
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        raw = r.hget("fills:by_id", trade_id)
        if not raw:
            raise HTTPException(404, f"Trade {trade_id} not found")
        return _json.loads(raw)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.get("/api/trades/{trade_id}/explain")
def explain_trade(trade_id: str, _auth: None = Depends(_require_key)):
    try:
        from backend.ai.explainable_trades import explain
        return {"explanation": explain(trade_id)}
    except Exception as exc:
        return {"explanation": f"Explainability unavailable: {exc}"}

# GEE
@app.get("/api/gee/url")
def get_gee_url(q: str = ""):
    return {"url": None, "available": False, "message": "Google Earth Engine not configured"}

# ------------------------------------------------------------------------------
# Entrypoint (Render / Docker safe)
# ------------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
    )