# backend/india/nse_option_chain.py
"""NSE option chain utilities — PCR, max pain, IV skew, gamma exposure."""
from __future__ import annotations

import json
import os
from typing import Dict, List, Optional, Tuple
import redis

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

_r: Optional[redis.Redis] = None

def _get_r() -> redis.Redis:
    global _r
    if _r is None:
        _r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT,
                         password=os.getenv("REDIS_PASSWORD") or None,
                         decode_responses=True)
    return _r


def get_option_chain(symbol: str, expiry: str, r=None) -> Dict:
    """Read cached option chain from Redis. Format: {strike: {CE: {...}, PE: {...}}}."""
    rc = r or _get_r()
    raw = rc.get(f"nse:option_chain:{symbol}:{expiry}")
    return json.loads(raw) if raw else {}


def put_call_ratio(chain: Dict) -> float:
    """Compute PCR = total PE OI / total CE OI."""
    ce_oi = sum(v.get("CE", {}).get("openInterest", 0) for v in chain.values())
    pe_oi = sum(v.get("PE", {}).get("openInterest", 0) for v in chain.values())
    if ce_oi == 0:
        return 0.0
    return round(pe_oi / ce_oi, 4)


def max_pain(chain: Dict) -> Optional[float]:
    """Return the strike where total option pain is minimized for writers."""
    if not chain:
        return None
    strikes = [float(k) for k in chain.keys()]
    min_pain = float("inf")
    max_pain_strike = None
    for candidate in strikes:
        pain = 0.0
        for strike_str, data in chain.items():
            s = float(strike_str)
            ce_oi = data.get("CE", {}).get("openInterest", 0)
            pe_oi = data.get("PE", {}).get("openInterest", 0)
            pain += ce_oi * max(0, candidate - s) + pe_oi * max(0, s - candidate)
        if pain < min_pain:
            min_pain = pain
            max_pain_strike = candidate
    return max_pain_strike


def gamma_exposure(chain: Dict, spot: float) -> float:
    """Approximate net dealer gamma exposure (simplified)."""
    gex = 0.0
    for strike_str, data in chain.items():
        strike = float(strike_str)
        ce = data.get("CE", {})
        pe = data.get("PE", {})
        ce_gamma = ce.get("gamma", 0) * ce.get("openInterest", 0)
        pe_gamma = pe.get("gamma", 0) * pe.get("openInterest", 0)
        gex += (ce_gamma - pe_gamma) * spot * 0.01  # in units of notional per 1% move
    return round(gex, 2)


def atm_iv_skew(chain: Dict, spot: float) -> Dict[str, float]:
    """Return ATM IV and skew (25D put IV - 25D call IV)."""
    if not chain:
        return {"atm_iv": 0.0, "skew": 0.0}
    strikes = sorted(chain.keys(), key=lambda k: abs(float(k) - spot))
    atm_strike = strikes[0]
    atm_iv = chain[atm_strike].get("CE", {}).get("impliedVolatility", 0.0)
    all_strikes = sorted(float(k) for k in chain.keys())
    q25_idx = max(0, int(len(all_strikes) * 0.25))
    q75_idx = min(len(all_strikes) - 1, int(len(all_strikes) * 0.75))
    otm_put_iv = chain.get(str(int(all_strikes[q25_idx])), {}).get("PE", {}).get("impliedVolatility", 0.0)
    otm_call_iv = chain.get(str(int(all_strikes[q75_idx])), {}).get("CE", {}).get("impliedVolatility", 0.0)
    return {"atm_iv": round(atm_iv, 4), "skew": round(otm_put_iv - otm_call_iv, 4)}
