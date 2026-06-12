# backend/api/analytics_router.py
"""
Analytics REST API — TCA, attribution, regime, optimizer, scenario.

Endpoints:
  GET  /analytics/health              — liveness
  POST /analytics/tca/record-order    — register an order for TCA tracking
  POST /analytics/tca/record-fill     — register a fill event
  GET  /analytics/tca/summary         — aggregate TCA summary
  POST /analytics/regime/update       — push feature snapshot, get regime
  GET  /analytics/regime/state        — current regime state
  POST /analytics/attribution/bucket  — append a fill+mark for P&L attribution
  GET  /analytics/attribution/summary — aggregated P&L attribution
  POST /analytics/optimizer/run       — run portfolio optimizer (HRP / risk-parity / min-var)
  GET  /analytics/regime/backfill     — backfill regime from feature history
"""
from __future__ import annotations

import logging
import time
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)
router = APIRouter(prefix="/analytics", tags=["analytics"])


# ── Lazy singletons ──────────────────────────────────────────────────────────

_tca_instance = None
_regime_instance = None
_attribution_instance = None


def _tca():
    global _tca_instance
    if _tca_instance is None:
        try:
            from backend.analytics.tca import TCA
            _tca_instance = TCA()
        except Exception as e:
            raise HTTPException(503, f"TCA unavailable: {e}")
    return _tca_instance


def _regime():
    global _regime_instance
    if _regime_instance is None:
        try:
            from backend.analytics.regime_map import RegimeMapper
            _regime_instance = RegimeMapper()
        except Exception as e:
            raise HTTPException(503, f"RegimeMapper unavailable: {e}")
    return _regime_instance


def _attribution():
    global _attribution_instance
    if _attribution_instance is None:
        try:
            from backend.analytics.attribution import AttributionEngine
            _attribution_instance = AttributionEngine()
        except Exception as e:
            raise HTTPException(503, f"AttributionEngine unavailable: {e}")
    return _attribution_instance


# ── Health ───────────────────────────────────────────────────────────────────

@router.get("/health")
def analytics_health():
    return {"status": "ok", "ts": int(time.time() * 1000)}


# ── TCA ─────────────────────────────────────────────────────────────────────

class TCAOrderRequest(BaseModel):
    order_id: str
    symbol: str
    side: str = Field(..., description="'buy' or 'sell'")
    qty: float
    decision_px: float
    strategy: str = "unknown"
    ts: Optional[float] = None


class TCAFillRequest(BaseModel):
    order_id: str
    fill_qty: float
    fill_px: float
    market_mid: Optional[float] = None
    bid: Optional[float] = None
    ask: Optional[float] = None
    ts: Optional[float] = None


@router.post("/tca/record-order")
def tca_record_order(req: TCAOrderRequest):
    from backend.api.broker_interface import Order
    try:
        tca = _tca()
        order = Order(
            id=req.order_id,
            symbol=req.symbol,
            side=req.side,
            qty=req.qty,
            price=req.decision_px,
            strategy=req.strategy,
            ts=req.ts or time.time(),
        )
        tca.record_order(order, strategy=req.strategy, decision_px=req.decision_px, decision_ts=req.ts or time.time())
        return {"ok": True, "order_id": req.order_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/tca/record-fill")
def tca_record_fill(req: TCAFillRequest):
    from backend.api.broker_interface import Fill
    try:
        tca = _tca()
        fill = Fill(
            order_id=req.order_id,
            symbol="",  # TCA looks up from order registry
            side="",
            qty=req.fill_qty,
            price=req.fill_px,
            fee=0.0,
            ts=req.ts or time.time(),
        )
        tca.record_fill(fill, market_mid=req.market_mid, bid=req.bid, ask=req.ask)
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/tca/summary")
def tca_summary(strategy: Optional[str] = None, symbol: Optional[str] = None, top_n: int = 50):
    try:
        tca = _tca()
        rows = tca.aggregate(by="order")
        if strategy:
            rows = [r for r in rows if r.get("strategy") == strategy]
        if symbol:
            rows = [r for r in rows if r.get("symbol") == symbol]
        return {"count": len(rows), "rows": rows[:top_n]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Regime ───────────────────────────────────────────────────────────────────

class RegimeFeatureRequest(BaseModel):
    rv: Optional[float] = Field(None, description="Realized volatility (annualized decimal)")
    tr: Optional[float] = Field(None, description="Trend strength zscore")
    corr: Optional[float] = Field(None, description="Average pairwise correlation [0,1]")
    liq: Optional[float] = Field(None, description="Liquidity proxy")
    cred: Optional[float] = Field(None, description="Credit spread proxy")


@router.post("/regime/update")
def regime_update(req: RegimeFeatureRequest):
    try:
        import time as _time
        rm = _regime()
        ts_ms = int(_time.time() * 1000)
        regime, score, features, notes = rm.classify(
            ts_ms,
            rv=req.rv,
            tr=req.tr,
            corr=req.corr,
            liq=req.liq,
            cred=req.cred,
        )
        return {"regime": regime, "score": score, "features": features, "notes": notes, "ts_ms": ts_ms}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/regime/state")
def regime_state():
    try:
        rm = _regime()
        st = rm.st
        if st is None:
            return {"regime": None, "score": None, "ts_ms": None}
        return {"regime": st.regime, "dwell": st.dwell, "features": st.last_features, "ts_ms": st.ts_ms}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


class BackfillRequest(BaseModel):
    rv: Optional[List[float]] = None
    tr: Optional[List[float]] = None
    corr: Optional[List[float]] = None
    liq: Optional[List[float]] = None
    cred: Optional[List[float]] = None


@router.post("/regime/backfill")
def regime_backfill(req: BackfillRequest):
    try:
        from backend.analytics.regime_map import backfill
        features = {k: v for k, v in req.model_dump().items() if v is not None}
        results = backfill(features)
        return {"count": len(results), "states": results}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Attribution ───────────────────────────────────────────────────────────────

class AttributionBucketRequest(BaseModel):
    strategy: str
    symbol: str
    qty: float = Field(..., description="Signed fill quantity (+buy, -sell)")
    fill_price: float
    mark_price: float
    currency: str = "INR"
    ts_ms: Optional[int] = None


@router.post("/attribution/bucket")
def attribution_bucket(req: AttributionBucketRequest):
    try:
        engine = _attribution()
        engine.record_fill(
            strategy=req.strategy,
            symbol=req.symbol,
            qty=req.qty,
            fill_price=req.fill_price,
            mark_price=req.mark_price,
            currency=req.currency,
            ts_ms=req.ts_ms or int(time.time() * 1000),
        )
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/attribution/summary")
def attribution_summary(strategy: Optional[str] = None):
    try:
        engine = _attribution()
        summary = engine.summary(strategy=strategy)
        return summary
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Optimizer ────────────────────────────────────────────────────────────────

class OptimizerRequest(BaseModel):
    returns: List[List[float]] = Field(..., description="T×N matrix of daily returns (rows=days, cols=assets)")
    asset_ids: Optional[List[str]] = None
    method: str = Field("hrp", description="'hrp' | 'risk_parity' | 'min_var' | 'max_sharpe'")
    long_only: bool = True
    lb: float = Field(0.0, description="Per-asset lower bound weight")
    ub: float = Field(1.0, description="Per-asset upper bound weight")
    net_exposure: Optional[float] = Field(None, description="Target net exposure (None = unconstrained)")
    mu: Optional[List[float]] = Field(None, description="Expected returns vector (required for max_sharpe)")
    risk_free: float = Field(0.0, description="Risk-free rate for Sharpe (annualized decimal)")


@router.post("/optimizer/run")
def optimizer_run(req: OptimizerRequest):
    try:
        import numpy as np

        from backend.analytics.optimizer import Config, Optimizer

        returns_arr = np.array(req.returns, dtype=float)
        if returns_arr.ndim != 2:
            raise HTTPException(400, "returns must be a 2-D list (T×N)")

        T, N = returns_arr.shape
        if T < 2:
            raise HTTPException(400, "Need at least 2 rows of returns")

        # Compute mu and Sigma from returns matrix
        mu = np.array(req.mu, dtype=float) if req.mu else returns_arr.mean(axis=0)
        Sigma = np.cov(returns_arr.T)  # N×N covariance matrix

        cfg = Config(
            objective=req.method,
            long_only=req.long_only,
            lower_bound=req.lb,
            upper_bound=req.ub,
            net_exposure=req.net_exposure,
        )
        opt = Optimizer(cfg)
        weights, diagnostics = opt.optimize(mu, Sigma, ids=req.asset_ids)

        ids = req.asset_ids or [f"asset_{i}" for i in range(N)]
        return {
            "weights": {ids[i]: round(float(weights[i]), 6) for i in range(N)},
            "diagnostics": diagnostics,
            "method": req.method,
            "n_assets": N,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))
