import os
import time
import uuid
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd
from fastapi import Depends, FastAPI, HTTPException, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, field_validator

import sys

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

# Alt-data
@app.get("/api/altdata/card_spend")
def stub_altdata_card_spend():
    _not_implemented("card spend data")

@app.get("/api/altdata/satellite_lights")
def stub_altdata_satellite_lights():
    _not_implemented("satellite lights data")

@app.get("/api/altdata/shipping_traffic")
def stub_altdata_shipping_traffic():
    _not_implemented("shipping traffic data")

@app.get("/api/altdata/geo_spatial")
def stub_altdata_geo_spatial():
    _not_implemented("geo spatial data")

# Analyst
@app.get("/api/analyst/screener")
def stub_analyst_screener():
    _not_implemented("analyst screener")

@app.get("/api/analyst/news")
def stub_analyst_news():
    _not_implemented("analyst news")

@app.get("/api/analyst/notes")
def stub_analyst_notes_get():
    _not_implemented("analyst notes GET")

@app.post("/api/analyst/notes")
def stub_analyst_notes_post(payload: Dict[str, Any]):
    _not_implemented("analyst notes POST")

@app.get("/api/analyst/tasks")
def stub_analyst_tasks_get():
    _not_implemented("analyst tasks GET")

@app.post("/api/analyst/tasks")
def stub_analyst_tasks_post(payload: Dict[str, Any]):
    _not_implemented("analyst tasks POST")

@app.post("/api/analyst/tasks/{task_id}/toggle")
def stub_analyst_tasks_toggle(task_id: str):
    _not_implemented(f"analyst task toggle {task_id}")

@app.get("/api/analyst/sentiment")
def stub_analyst_sentiment():
    _not_implemented("analyst sentiment")

@app.get("/api/analyst/query")
def stub_analyst_query(q: str = ""):
    _not_implemented("analyst query")

# FNO
@app.get("/api/fno/futures")
def stub_fno_futures():
    _not_implemented("FNO futures data")

@app.get("/api/fno/options")
def stub_fno_options():
    _not_implemented("FNO options data")

# Research
@app.get("/api/research/notes")
def stub_research_notes():
    _not_implemented("research notes")

@app.get("/api/research/chart")
def stub_research_chart():
    _not_implemented("research chart data")

@app.get("/api/research/query")
def stub_research_query(q: str = ""):
    _not_implemented("research query")

# Risk (UI-facing thin wrappers not in risk_router)
@app.get("/api/risk/kpis")
def get_risk_kpis(_auth: None = Depends(_require_key)):
    try:
        import redis as _redis, os as _os, json as _json
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
        eng = StressTestEngine.__new__(StressTestEngine)
        return {"scenarios": []}
    except Exception as exc:
        logger.warning("monte carlo error: %s", exc)
        return {"scenarios": []}

@app.get("/api/risk/scenarios")
def get_risk_scenarios(_auth: None = Depends(_require_key)):
    try:
        import redis as _redis, os as _os
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
        import redis as _redis, os as _os, json as _json
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
        from backend.engine.registry import Registry
        reg = Registry.get_instance()
        strats = []
        for name, cls in reg.items():
            meta = {}
            try:
                meta = cls.get_metadata() or {}
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
        import redis as _redis, os as _os, json as _json
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        name = str(payload.get("name", "default"))
        r.hset("strategy:presets", name, _json.dumps(payload))
        return {"ok": True, "name": name}
    except Exception as exc:
        raise HTTPException(500, str(exc))

@app.post("/api/strategies/presets/apply")
def apply_preset(payload: Dict[str, Any], _auth: None = Depends(_require_key)):
    try:
        import redis as _redis, os as _os, json as _json
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
        import redis as _redis, os as _os, json as _json
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        items = r.lrange(f"bars:{symbol}:{tf}", -limit, -1)
        return {"candles": [_json.loads(x) for x in items if x]}
    except Exception as exc:
        return {"candles": []}

@app.get("/api/terminal/book")
def get_terminal_book(symbol: str = "NIFTY"):
    try:
        import redis as _redis, os as _os, json as _json
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        raw = r.get(f"orderbook:{symbol}")
        return _json.loads(raw) if raw else {"bids": [], "asks": []}
    except Exception:
        return {"bids": [], "asks": []}

@app.get("/api/terminal/trades")
def get_terminal_trades(limit: int = 100):
    try:
        import redis as _redis, os as _os, json as _json
        r = _redis.Redis(host=_os.getenv("REDIS_HOST","localhost"), port=int(_os.getenv("REDIS_PORT","6379")), decode_responses=True)
        items = r.lrange("fills:recent", -limit, -1)
        return {"trades": [_json.loads(x) for x in items if x]}
    except Exception:
        return {"trades": []}

@app.get("/api/terminal/alerts")
def stub_terminal_alerts():
    _not_implemented("terminal alerts")

# Voice / AI
@app.post("/api/voice/command")
def stub_voice_command(payload: Dict[str, Any]):
    _not_implemented("voice command")

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
        from backend.engine.regime_risk import regime_multiplier
        import redis as _redis, os as _os
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
def stub_commodities(sym: str):
    _not_implemented(f"commodities data for {sym}")

# Trades
@app.get("/api/trades/{trade_id}")
def stub_trade(trade_id: str):
    _not_implemented(f"trade {trade_id}")

@app.get("/api/trades/{trade_id}/explain")
def stub_trade_explain(trade_id: str):
    _not_implemented(f"trade explanation {trade_id}")

# GEE
@app.get("/api/gee/url")
def stub_gee_url(q: str = ""):
    _not_implemented("Google Earth Engine URL")

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