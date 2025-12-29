# backend/orchestration/utils.py

import time
from pathlib import Path
from datetime import datetime

def ensure_dir(path):
    Path(path).mkdir(parents=True, exist_ok=True)

def utc_now_ts():
    return int(datetime.utcnow().timestamp())

def sleep_secs(seconds: float):
    time.sleep(seconds)