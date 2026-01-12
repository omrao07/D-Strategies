import io
import os
import time
import uuid
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd
from fastapi import FastAPI, UploadFile, File, Body, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator

import sys

# ------------------------------------------------------------------------------
# Path setup
# ------------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ------------------------------------------------------------------------------
# Internal imports
# ------------------------------------------------------------------------------

try:
    from orchestration.strategy_manager import Orchestrator
    from orchestration.ts_utils import load_yaml_or_json, ensure_dir, setup_logging
    from orchestration.modes import RunMode
except Exception as e:
    raise RuntimeError(
        "Failed to import orchestration modules. "
        "Ensure backend/orchestration/* is on PYTHONPATH."
    ) from e

# ------------------------------------------------------------------------------
# App & logging
# ------------------------------------------------------------------------------

APP_VERSION = "0.3.0"
RUNS_DIR = Path(os.getenv("RUNS_DIR", "runs")).resolve()
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

RUNS_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)

logger = logging.getLogger("api")

app = FastAPI(title="Damodar Orchestrator API", version=APP_VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------------------------------------------------------------
# Global orchestrator (Phase 1)
# ------------------------------------------------------------------------------

orchestrator = Orchestrator(run_mode=RunMode.PAPER)
START_TIME = time.time()

@app.on_event("startup")
def startup_event():
    logger.info("Loading strategies from registry...")
    try:
        orchestrator.load_from_registry(limit=2)  # start small (1–2 strategies)
        orchestrator.warmup_all()
        logger.info(f"Loaded {len(orchestrator.handles())} strategies")
    except Exception as e:
        logger.exception("Failed to initialize orchestrator")
        raise

# ------------------------------------------------------------------------------
# Schemas (existing)
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

    @validator("config", "registry", pre=True)
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


def resolve_data(csv_path: Optional[str], inline: Optional[InlineData]) -> pd.DataFrame:
    if inline:
        return inline.to_dataframe()
    if csv_path:
        df = pd.read_csv(csv_path)
        if "price" not in df.columns:
            raise HTTPException(400, "CSV must contain price column")
        return df
    raise HTTPException(400, "No data provided")

# ------------------------------------------------------------------------------
# Phase 1 API endpoints
# ------------------------------------------------------------------------------

@app.get("/status")
def status():
    return {
        "status": "ok",
        "version": APP_VERSION,
        "uptime_sec": int(time.time() - START_TIME),
        "strategies_loaded": len(orchestrator.handles()),
        "mode": orchestrator.run_mode.name,
    }


@app.get("/strategies")
def list_strategies():
    return [
        {
            "id": sid,
            "name": h.spec.name,
            "family": h.spec.family,
            "run_mode": h.spec.run_mode,
            "control_mode": h.spec.control_mode,
            "health": h.state.health,
        }
        for sid, h in orchestrator.handles().items()
    ]


@app.get("/strategies/{sid}/state")
def strategy_state(sid: str):
    h = orchestrator.handles().get(sid)
    if not h:
        raise HTTPException(404, "Strategy not found")

    return {
        "id": sid,
        "spec": h.spec.__dict__,
        "state": h.state.__dict__,
    }


@app.post("/strategies/{sid}/tick")
def tick_strategy(sid: str):
    if sid not in orchestrator.handles():
        raise HTTPException(404, "Strategy not found")

    result = orchestrator.tick_once(sid)
    return {"result": result}


@app.post("/strategies/run")
def tick_all():
    result = orchestrator.tick_all()
    return {"result": result}

# ------------------------------------------------------------------------------
# Existing routes (kept)
# ------------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "version": APP_VERSION}


@app.post("/backtest", response_model=BacktestResponse)
def run_backtest(req: BacktestRequest):
    if not req.config and not req.config_path:
        raise HTTPException(400, "Config required")
    if not req.registry and not req.registry_path:
        raise HTTPException(400, "Registry required")

    config = req.config or load_yaml_or_json(req.config_path)
    registry = req.registry or load_yaml_or_json(req.registry_path)

    run_dir = Path(req.out_dir) if req.out_dir else new_run_dir("bt")
    df = resolve_data(req.csv_path, req.inline_data)

    orch = Orchestrator(run_mode=RunMode.PAPER)
    result = orch.run_backtest(df)

    return BacktestResponse(
        run_id=result["manifest"]["run_id"],
        history_path=result["history_path"],
        manifest=result["manifest"],
    )


@app.post("/echo")
def echo(payload: Dict[str, Any]):
    return {"received": payload, "ts": time.time()}

# ------------------------------------------------------------------------------
# Entrypoint
# ------------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
    )