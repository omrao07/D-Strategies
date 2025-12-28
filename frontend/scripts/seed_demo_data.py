# scripts/seed_demo_data.py
"""
Seed demo data for local/dev environments.

What this script does:
- Seeds Redis with demo pub/sub messages (for ws-server)
- Seeds a local JSON file with mock strategies / analytics data
- Safe to re-run (idempotent where possible)

Usage:
  python scripts/seed_demo_data.py
  REDIS_HOST=localhost REDIS_PORT=6379 python scripts/seed_demo_data.py
"""

import json
import os
import time
import random
from datetime import datetime, timedelta

try:
    import redis
except ImportError:
    raise SystemExit(
        "redis package not installed. Run: pip install redis"
    )

# -------------------- CONFIG --------------------

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
REDIS_CHANNEL = os.getenv("WS_CHANNEL", "CHAN_ANALYST")

OUTPUT_DIR = os.getenv("SEED_OUTPUT_DIR", "data")
STRATEGY_FILE = os.path.join(OUTPUT_DIR, "strategies.json")
ANALYTICS_FILE = os.path.join(OUTPUT_DIR, "analytics.json")

PUBLISH_MESSAGES = True
NUM_WS_EVENTS = 25

random.seed(42)

# -------------------- REDIS --------------------

def get_redis():
    return redis.Redis(
        host=REDIS_HOST,
        port=REDIS_PORT,
        decode_responses=True,
    )

def publish_ws_events(r):
    print(f"Publishing demo WebSocket events to Redis channel: {REDIS_CHANNEL}")
    for i in range(NUM_WS_EVENTS):
        event = {
            "type": "strategy_update",
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "strategy": random.choice(
                ["Carry FX", "Index Arb", "Vol Skew", "Liquidity Fade"]
            ),
            "pnl": round(random.uniform(-2.5, 3.5), 2),
            "risk": random.choice(["LOW", "MEDIUM", "HIGH"]),
        }
        r.publish(REDIS_CHANNEL, json.dumps(event))
        time.sleep(0.05)

# -------------------- FILE SEEDING --------------------

def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)

def seed_strategies():
    strategies = [
        {
            "id": "carry-fx",
            "name": "Carry FX",
            "category": "FX",
            "risk": "Medium",
            "enabled": True,
        },
        {
            "id": "index-arb",
            "name": "Index Arbitrage",
            "category": "Equities",
            "risk": "Low",
            "enabled": True,
        },
        {
            "id": "vol-skew",
            "name": "Volatility Skew",
            "category": "Options",
            "risk": "High",
            "enabled": False,
        },
    ]
    with open(STRATEGY_FILE, "w", encoding="utf-8") as f:
        json.dump(strategies, f, indent=2)
    print(f"Wrote {STRATEGY_FILE}")

def seed_analytics():
    base = datetime.utcnow()
    analytics = []
    for i in range(30):
        analytics.append(
            {
                "date": (base - timedelta(days=i)).strftime("%Y-%m-%d"),
                "pnl": round(random.uniform(-10, 15), 2),
                "drawdown": round(random.uniform(0, 5), 2),
                "var_99": round(random.uniform(1, 3), 2),
            }
        )

    with open(ANALYTICS_FILE, "w", encoding="utf-8") as f:
        json.dump(list(reversed(analytics)), f, indent=2)
    print(f"Wrote {ANALYTICS_FILE}")

# -------------------- MAIN --------------------

def main():
    print("Seeding demo data...")
    ensure_dir(OUTPUT_DIR)

    seed_strategies()
    seed_analytics()

    if PUBLISH_MESSAGES:
        r = get_redis()
        publish_ws_events(r)

    print("Done.")

if __name__ == "__main__":
    main()