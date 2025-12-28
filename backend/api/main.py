#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FastAPI entrypoint
"""

# ---------------------------------------------------------------------
# PYTHONPATH FIX — THIS IS THE KEY PART
# ---------------------------------------------------------------------
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]  # points to /backend
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

# ---------------------------------------------------------------------
# Normal imports start AFTER this
# ---------------------------------------------------------------------
import io
import os
import time
import uuid
import logging
from typing import Any, Dict, List, Optional

import pandas as pd
from fastapi import FastAPI, UploadFile, File, Body, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------
# Orchestration import (NOW THIS WILL WORK)
# ---------------------------------------------------------------------
try:
    from orchestration import Orchestrator
    from orchestration.utils import load_yaml_or_json, ensure_dir, setup_logging
except Exception as e:
    raise RuntimeError(
        "Failed to import orchestration package. "
        "Ensure backend/orchestration/__init__.py exists."
    ) from e

# ---------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------
APP_VERSION = "0.2.0"
RUNS_DIR = Path(os.getenv("RUNS_DIR", "runs")).resolve()
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

RUNS_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
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

# ---------------------------------------------------------------------
# Health check (Render uses this)
# ---------------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok", "version": APP_VERSION}

# ---------------------------------------------------------------------
# Minimal test endpoint (to confirm startup)
# ---------------------------------------------------------------------
@app.get("/")
def root():
    return {"service": "up"}

# ---------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
    )