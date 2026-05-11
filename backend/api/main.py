import os
import time
import uuid
import logging
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

app = FastAPI(title="Damodar Orchestrator API", version=APP_VERSION)

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
# Entrypoint (Render / Docker safe)
# ------------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
    )