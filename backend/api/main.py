#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
FastAPI service for backtests, calibration, and utilities.
"""

from __future__ import annotations

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

# ==============================================================================
# REQUIRED INTERNAL IMPORTS (FIXED)
# ==============================================================================

try:
    from orchestration.pipelines import Orchestrator
    from orchestration.utils import load_yaml_or_json, ensure_dir, setup_logging
except Exception as e:
    raise RuntimeError(
        "Failed to import orchestration package. "
        "Ensure backend/orchestration is a Python package and on PYTHONPATH."
    ) from e

# Optional modules
try:
    from calibrate import Calibrator, ParamSpace, TimeSeriesCV  # type: ignore
    HAS_CALIBRATE = True
except Exception:
    HAS_CALIBRATE = False

try:
    import prompts  # type: ignore
    HAS_PROMPTS = True
except Exception:
    HAS_PROMPTS = False

# ==============================================================================
# APP SETUP
# ==============================================================================

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

# ==============================================================================
# SCHEMAS
# ==============================================================================

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
            raise ValueError("Provide records or columns+data")

        if self.price_col not in df.columns:
            for alt in ("close", "px", "last"):
                if alt in df.columns:
                    df.rename(columns={alt: self.price_col}, inplace=True)
                    break

        if self.price_col not in df.columns:
            raise ValueError("Missing price column")

        if self.timestamp_col and self.timestamp_col in df.columns:
            df[self.timestamp_col] = pd.to_datetime(df[self.timestamp_col])
            df.set_index(self.timestamp_col, inplace=True)
            df.sort_index(inplace=True)

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


# ==============================================================================
# HELPERS
# ==============================================================================

def new_run_dir(prefix: str) -> Path:
    rid = uuid.uuid4().hex[:10]
    path = RUNS_DIR / f"{prefix}_{rid}"
    path.mkdir(parents=True, exist_ok=True)
    setup_logging(path, LOG_LEVEL)
    return path


def resolve_cfg_reg(req: BacktestRequest):
    cfg = req.config or (load_yaml_or_json(req.config_path) if req.config_path else None)
    reg = req.registry or (load_yaml_or_json(req.registry_path) if req.registry_path else None)

    if not cfg:
        raise HTTPException(400, "Missing config")
    if not reg:
        raise HTTPException(400, "Missing registry")

    return cfg, reg


def resolve_data(req: BacktestRequest) -> pd.DataFrame:
    if req.inline_data:
        return req.inline_data.to_dataframe()

    if req.csv_path:
        df = pd.read_csv(req.csv_path)
        for c in ("timestamp", "date", "datetime"):
            if c in df.columns:
                df[c] = pd.to_datetime(df[c])
                df.set_index(c, inplace=True)
                break
        return df

    raise HTTPException(400, "No data provided")


# ==============================================================================
# ROUTES
# ==============================================================================

@app.get("/health")
def health():
    return {"status": "ok", "version": APP_VERSION}


@app.post("/backtest", response_model=BacktestResponse)
def run_backtest(req: BacktestRequest):
    cfg, reg = resolve_cfg_reg(req)
    df = resolve_data(req)

    out_dir = Path(req.out_dir) if req.out_dir else new_run_dir("bt")

    orch = Orchestrator(
        config=cfg,
        registry=reg,
        out_dir=out_dir,
        mode="backtest",
        paper=True,
    )

    result = orch.run_backtest(df)

    return BacktestResponse(
        run_id=result["manifest"]["run_id"],
        history_path=result["history_path"],
        manifest=result["manifest"],
    )


@app.post("/upload/csv")
async def upload_csv(file: UploadFile = File(...)):
    content = await file.read()
    df = pd.read_csv(io.BytesIO(content))
    path = RUNS_DIR / f"upload_{uuid.uuid4().hex[:8]}.csv"
    df.to_csv(path, index=False)
    return {"path": str(path), "rows": len(df)}


# ==============================================================================
# ENTRYPOINT
# ==============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
    )