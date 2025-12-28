#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
api/main.py
-----------
FastAPI service for running backtests, parameter calibration, and utilities.

Run (local):
    uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload
"""

# ============================================================
# PYTHONPATH FIX (CRITICAL FOR RENDER)
# ============================================================
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]  # backend/
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

# ============================================================
# Standard library
# ============================================================
from __future__ import annotations
import io
import os
import json
import time
import uuid
import logging
from typing import Any, Dict, List, Optional

# ============================================================
# Third-party
# ============================================================
import pandas as pd
from fastapi import FastAPI, UploadFile, File, Body, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator

# ============================================================
# Internal imports (NOW RESOLVABLE)
# ============================================================
try:
    from orchestration.pipelines import Orchestrator
    from orchestration.utils import load_yaml_or_json, ensure_dir, setup_logging
except Exception as e:
    raise RuntimeError(
        "Failed to import orchestration package. "
        "Ensure backend/orchestration is a Python package and on PYTHONPATH."
    ) from e

try:
    from calibrate import Calibrator, ParamSpace, TimeSeriesCV  # type: ignore
    _HAS_CALIBRATE = True
except Exception:
    _HAS_CALIBRATE = False

try:
    import prompts  # type: ignore
    _HAS_PROMPTS = True
except Exception:
    _HAS_PROMPTS = False

# ============================================================
# App & logging
# ============================================================
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# Schemas
# ============================================================
class InlineData(BaseModel):
    price_col: str = "price"
    timestamp_col: Optional[str] = None
    records: Optional[List[Dict[str, Any]]] = None
    columns: Optional[List[str]] = None
    data: Optional[List[List[Any]]] = None

    def to_dataframe(self) -> pd.DataFrame:
        if self.records is not None:
            df = pd.DataFrame(self.records)
        elif self.columns and self.data:
            df = pd.DataFrame(self.data, columns=self.columns)
        else:
            raise ValueError("Provide either records or columns+data")

        if self.price_col not in df.columns:
            for c in ("close", "px", "last"):
                if c in df.columns:
                    df = df.rename(columns={c: self.price_col})
                    break

        if self.price_col not in df.columns:
            raise ValueError(f"Missing price column: {self.price_col}")

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


# ============================================================
# Helpers
# ============================================================
def _new_run_dir(prefix: str) -> Path:
    rid = uuid.uuid4().hex[:10]
    d = RUNS_DIR / f"{prefix}_{rid}"
    d.mkdir(parents=True, exist_ok=True)
    setup_logging(d, LOG_LEVEL)
    return d


def _resolve_cfg(cfg_path, reg_path, cfg, reg):
    cfg = cfg or (load_yaml_or_json(cfg_path) if cfg_path else None)
    reg = reg or (load_yaml_or_json(reg_path) if reg_path else None)
    if not cfg or not reg:
        raise HTTPException(400, "Config and registry are required")
    return cfg, reg


# ============================================================
# Routes
# ============================================================
@app.get("/health")
def health():
    return {"status": "ok", "version": APP_VERSION}


@app.post("/backtest", response_model=BacktestResponse)
def backtest(req: BacktestRequest):
    cfg, reg = _resolve_cfg(req.config_path, req.registry_path, req.config, req.registry)
    run_dir = Path(req.out_dir).resolve() if req.out_dir else _new_run_dir("bt")

    if req.inline_data:
        df = req.inline_data.to_dataframe()
    elif req.csv_path:
        df = pd.read_csv(req.csv_path)
    else:
        raise HTTPException(400, "No data provided")

    orch = Orchestrator(config=cfg, registry=reg, out_dir=run_dir, mode="backtest", paper=True)
    res = orch.run_backtest(df)

    return BacktestResponse(
        run_id=res["manifest"]["run_id"],
        history_path=res["history_path"],
        manifest=res["manifest"],
    )


@app.post("/echo")
def echo(payload: Dict[str, Any]):
    return {"received": payload, "ts": time.time()}


# ============================================================
# Entrypoint
# ============================================================
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        reload=False,
    )