# backend/ai/agents/skills/commodities/commodity_signals.py
"""
Commodity Signals Skill
=======================
Lightweight skill wrapper around CommodityAIAgent and CommoditySignalHub.
Provides callable functions that the SwarmManager, Autopilot, and other
agents can invoke without constructing the full agent themselves.

Skill functions:
  get_commodity_brief(commodities, price_data, satellite_data, ais_data, ...)
  get_alt_data_signal(commodity, alt_data_type, region)
  get_carry_signal(commodity, forward_curve_df)
  get_cot_signal(commodity, cot_records)
  get_macro_regime(copper_lb, gold_oz, pmi_china, yield_10y)
  get_fuel_switching_signal(gas_mmbtu, coal_tonne, power_mwh, eua_price)
  get_ev_demand_score(ev_yoy_pct, ev_penetration, lfp_share)
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

# ── CommodityAIAgent ──
try:
    from backend.ai.agents.concrete.commodity_ai_agent import (
        CommodityAIAgent, CommodityRequest, CommodityBrief,
        TradeIdea, quick_brief, build_commodity_agent, _dominant_direction,
    )
    _HAS_AGENT = True
except Exception:
    _HAS_AGENT = False
    CommodityAIAgent = None  # type: ignore

# ── CommoditySignalHub ──
try:
    from backend.commodities.signal_hub import CommoditySignalHub
    _HAS_HUB = True
except Exception:
    _HAS_HUB = False
    CommoditySignalHub = None  # type: ignore

# ── Strategy analytics ──
try:
    from backend.strategies.commodities.carbon_credits_eua import (
        fuel_switching_signal, implied_carbon_price_from_switching
    )
    _HAS_EUA = True
except Exception:
    _HAS_EUA = False

try:
    from backend.strategies.commodities.battery_metals_ev_demand import ev_demand_score
    _HAS_EV = True
except Exception:
    _HAS_EV = False

try:
    from backend.strategies.commodities.copper_gold_ratio_economy import (
        compute_cuau, macro_regime as _macro_regime
    )
    _HAS_CU = True
except Exception:
    _HAS_CU = False

try:
    from backend.commodities.cot_positioning import COTEngine, COTRecord, generate_synthetic_cot
    _HAS_COT = True
except Exception:
    _HAS_COT = False

try:
    from backend.commodities.curve_analytics import (
        ForwardCurve, CurvePoint, carry_signal, classify_structure,
        roll_yield, build_curve,
    )
    _HAS_CURVE = True
except Exception:
    _HAS_CURVE = False


# ─────────────────────────────────────────────────────────────
# Primary skill: full commodity brief
# ─────────────────────────────────────────────────────────────

def get_commodity_brief(
    commodities: Optional[List[str]] = None,
    price_data:  Optional[Dict[str, Any]] = None,
    satellite_data: Optional[Dict[str, Any]] = None,
    ais_data: Optional[Dict[str, Any]] = None,
    eia_data: Optional[Dict[str, Any]] = None,
    weather_data: Optional[Dict[str, Any]] = None,
    cot_data: Optional[Dict[str, Any]] = None,
    min_confidence: float = 0.55,
    capital: float = 1_000_000.0,
) -> Dict[str, Any]:
    """
    Run the full commodity AI analysis and return a structured brief.

    Returns dict with:
      macro_regime, copper_gold_ratio, n_signals, top_ideas (list of dicts),
      signal_summary (per-commodity), data_sources_active, risk_flags
    """
    if not _HAS_AGENT or CommodityAIAgent is None:
        return {"error": "CommodityAIAgent not available", "macro_regime": "neutral"}

    try:
        from backend.ai.agents.concrete.commodity_ai_agent import CommodityRequest
        agent = build_commodity_agent()
        req = CommodityRequest(
            commodities=commodities or ["lng", "soybeans", "carbon_eua", "nickel", "copper"],
            price_data=price_data or {},
            satellite_data=satellite_data or {},
            ais_data=ais_data or {},
            eia_data=eia_data or {},
            weather_data=weather_data or {},
            cot_data=cot_data or {},
            min_confidence=min_confidence,
            capital=capital,
        )
        result = agent.run(req)
        if not result.ok:
            return {"error": result.error, "macro_regime": "neutral"}

        brief: CommodityBrief = result.payload
        return {
            "timestamp": brief.timestamp,
            "macro_regime": brief.macro_regime,
            "copper_gold_ratio": brief.copper_gold_ratio,
            "n_signals_generated": brief.n_signals_generated,
            "n_signals_filtered": brief.n_signals_filtered,
            "top_ideas": [
                {
                    "rank": t.rank,
                    "commodity": t.commodity,
                    "strategy": t.strategy,
                    "direction": t.direction,
                    "contracts": t.contracts,
                    "score": t.score,
                    "strength": t.strength,
                    "confidence": t.confidence,
                    "horizon_days": t.horizon_days,
                    "rationale": t.rationale,
                    "sizing_hint": t.sizing_hint,
                }
                for t in brief.top_ideas
            ],
            "signal_summary": brief.signal_summary,
            "data_sources_active": brief.data_sources_active,
            "top_idea_rationale": brief.top_idea_rationale,
            "risk_flags": brief.risk_flags,
        }
    except Exception as e:
        return {"error": str(e), "macro_regime": "neutral"}


# ─────────────────────────────────────────────────────────────
# Alt-data signal skill (single commodity)
# ─────────────────────────────────────────────────────────────

def get_alt_data_signal(
    commodity: str,
    alt_data_type: str = "all",   # "satellite" | "ais" | "eia" | "cot" | "curve" | "weather" | "all"
    satellite_region: str = "",
    ais_payload: Optional[Dict[str, Any]] = None,
    eia_payload: Optional[Dict[str, Any]] = None,
    weather_payload: Optional[Dict[str, Any]] = None,
    cot_records: Optional[List[Any]] = None,
    curve_df: Optional[pd.DataFrame] = None,
) -> Dict[str, Any]:
    """
    Pull a specific alt-data signal for a commodity.
    Returns normalized score [-1..+1] and direction.
    """
    if not _HAS_HUB or CommoditySignalHub is None:
        return {"commodity": commodity, "score": 0.0, "direction": "neutral",
                "error": "CommoditySignalHub not available"}

    try:
        hub = CommoditySignalHub()
        aux: Dict[str, Any] = {}
        prices = pd.DataFrame()

        if ais_payload:
            aux["ais"] = ais_payload
        if eia_payload:
            aux["eia"] = eia_payload
        if weather_payload:
            aux["weather"] = weather_payload
        if cot_records:
            aux["cot_records"] = cot_records
        if satellite_region:
            aux["satellite"] = {"region": satellite_region}

        result = hub.get_signal(commodity, prices, aux)
        if result is None:
            return {"commodity": commodity, "score": 0.0, "direction": "neutral"}

        if isinstance(result, list):
            scores = []
            directions = []
            for sig in result:
                s = getattr(sig, "strength", 0.0) or (sig.get("strength", 0.0) if isinstance(sig, dict) else 0.0)
                d = str(getattr(sig, "direction", "neutral") or (sig.get("direction", "neutral") if isinstance(sig, dict) else "neutral"))
                scores.append(float(s))
                directions.append(d)
            avg_score = sum(scores) / max(1, len(scores))
            dom = _dominant_direction(directions) if _HAS_AGENT else "neutral"
            return {"commodity": commodity, "score": round(avg_score, 4), "direction": dom, "n_signals": len(result)}

        return {"commodity": commodity, "signal": result}
    except Exception as e:
        return {"commodity": commodity, "error": str(e), "score": 0.0, "direction": "neutral"}


# ─────────────────────────────────────────────────────────────
# Carry / forward curve skill
# ─────────────────────────────────────────────────────────────

def get_carry_signal(
    commodity: str,
    forward_curve_points: List[Dict[str, Any]],  # [{days_to_expiry, price}, ...]
    hist_spreads: Optional[pd.Series] = None,
    roll_threshold_pct: float = 5.0,
) -> Dict[str, Any]:
    """
    Compute carry/roll yield signal from a forward curve.

    forward_curve_points: list of dicts with 'days_to_expiry' and 'price'.
    Returns direction, roll_yield_annualized, structure (contango/backwardation).
    """
    if not _HAS_CURVE:
        return {"commodity": commodity, "direction": "neutral",
                "error": "curve_analytics not available"}
    try:
        points = [CurvePoint(days_to_expiry=p["days_to_expiry"], price=p["price"],
                             label=p.get("label", f"M{i+1}"))
                  for i, p in enumerate(forward_curve_points)]
        from backend.commodities.curve_analytics import ForwardCurve as FC
        import datetime
        curve = FC(commodity=commodity, date=str(datetime.date.today()),
                   points=points, currency="USD", unit="BBL")
        ry = roll_yield(curve, near_days=30, far_days=60, holding_days=30)
        structure = classify_structure(curve)
        carry = carry_signal(curve, hist_spreads, roll_threshold_pct)
        return {
            "commodity": commodity,
            "roll_yield_annualized_pct": round(ry * 100, 3),
            "structure": structure.structure if hasattr(structure, "structure") else str(structure),
            "carry_direction": carry.direction if hasattr(carry, "direction") else "neutral",
            "carry_strength": carry.strength if hasattr(carry, "strength") else 0.0,
            "carry_rationale": carry.rationale if hasattr(carry, "rationale") else "",
        }
    except Exception as e:
        return {"commodity": commodity, "error": str(e), "direction": "neutral"}


# ─────────────────────────────────────────────────────────────
# COT positioning skill
# ─────────────────────────────────────────────────────────────

def get_cot_signal(
    commodity: str,
    cot_records: Optional[List[Any]] = None,
    n_synthetic_weeks: int = 156,
) -> Dict[str, Any]:
    """
    Compute COT positioning signal.

    cot_records: list of COTRecord objects. If None, uses synthetic data for demo.
    Returns crowding_direction, momentum_direction, composite_direction, interpretation.
    """
    if not _HAS_COT:
        return {"commodity": commodity, "composite_direction": "neutral",
                "error": "cot_positioning not available"}
    try:
        engine = COTEngine()
        if cot_records is None:
            cot_records = generate_synthetic_cot(commodity=commodity, n_weeks=n_synthetic_weeks)
        sig = engine.process(cot_records, commodity=commodity)
        if sig is None:
            return {"commodity": commodity, "composite_direction": "neutral"}
        return {
            "commodity":             sig.commodity,
            "date":                  sig.date,
            "mm_net":                sig.mm_net,
            "mm_net_pct_oi":         sig.mm_net_pct_oi,
            "z_score_1yr":           sig.z_score_1yr,
            "percentile_1yr":        sig.percentile_1yr,
            "crowding_direction":    sig.crowding_direction,
            "crowding_strength":     sig.crowding_strength,
            "momentum_direction":    sig.momentum_direction,
            "momentum_strength":     sig.momentum_strength,
            "composite_direction":   sig.composite_direction,
            "composite_strength":    sig.composite_strength,
            "interpretation":        sig.interpretation,
        }
    except Exception as e:
        return {"commodity": commodity, "error": str(e), "composite_direction": "neutral"}


# ─────────────────────────────────────────────────────────────
# Macro regime skill
# ─────────────────────────────────────────────────────────────

def get_macro_regime(
    copper_lb: float,
    gold_oz: float,
    pmi_china: Optional[float] = None,
    yield_10y: Optional[float] = None,
    cuau_zscore: float = 0.0,
) -> Dict[str, Any]:
    """
    Classify global macro regime from copper/gold ratio.
    Returns regime, direction (risk_on/risk_off), confidence.
    """
    if not _HAS_CU:
        cuau = copper_lb / max(gold_oz, 1.0) * 1000
        direction = "risk_on" if cuau > 2.5 else ("risk_off" if cuau < 1.5 else "neutral")
        return {"cuau_ratio": round(cuau, 4), "direction": direction, "regime": direction, "confidence": 0.55}
    try:
        cuau = compute_cuau(copper_lb, gold_oz)
        regime_data = _macro_regime(cuau, cuau_zscore, pmi_china, yield_10y)
        return regime_data
    except Exception as e:
        return {"error": str(e), "regime": "neutral", "direction": "neutral", "confidence": 0.0}


# ─────────────────────────────────────────────────────────────
# Carbon / EUA fuel switching skill
# ─────────────────────────────────────────────────────────────

def get_fuel_switching_signal(
    gas_mmbtu: float,
    coal_tonne: float,
    power_mwh: float,
    eua_price: float,
) -> Dict[str, Any]:
    """
    Compute EU ETS EUA fuel-switching regime and implied carbon price.
    Returns implied switching price, gap, regime, direction.
    """
    if not _HAS_EUA:
        return {"regime": "unknown", "direction": "neutral",
                "error": "carbon_credits_eua not available"}
    try:
        return fuel_switching_signal(gas_mmbtu, coal_tonne, power_mwh, eua_price)
    except Exception as e:
        return {"error": str(e), "regime": "unknown", "direction": "neutral"}


# ─────────────────────────────────────────────────────────────
# Battery metals / EV demand skill
# ─────────────────────────────────────────────────────────────

def get_ev_demand_score(
    ev_yoy_pct: float,
    ev_penetration: float,
    lfp_share: float = 0.38,
) -> Dict[str, Any]:
    """
    EV battery demand score for each battery metal (Ni, Co, Li, Mn).
    Returns normalized scores [-1..+1] indicating demand pressure.
    """
    if not _HAS_EV:
        base = min(1.0, ev_yoy_pct / 30.0) if ev_yoy_pct > 0 else -0.5
        return {"nickel": base, "cobalt": base * 0.6, "lithium": base, "manganese": base * 0.7}
    try:
        return ev_demand_score(ev_yoy_pct, ev_penetration, lfp_share)
    except Exception as e:
        return {"error": str(e)}


# ─────────────────────────────────────────────────────────────
# Quick-access registry (for SwarmManager / playbooks)
# ─────────────────────────────────────────────────────────────

COMMODITY_SKILLS: Dict[str, Any] = {
    "commodity_brief":      get_commodity_brief,
    "alt_data_signal":      get_alt_data_signal,
    "carry_signal":         get_carry_signal,
    "cot_signal":           get_cot_signal,
    "macro_regime":         get_macro_regime,
    "fuel_switching":       get_fuel_switching_signal,
    "ev_demand_score":      get_ev_demand_score,
}


def call_skill(skill_name: str, **kwargs) -> Dict[str, Any]:
    """Generic dispatch into COMMODITY_SKILLS registry."""
    fn = COMMODITY_SKILLS.get(skill_name)
    if fn is None:
        return {"error": f"Unknown commodity skill: {skill_name}",
                "available": list(COMMODITY_SKILLS)}
    try:
        return fn(**kwargs) or {}
    except Exception as e:
        return {"error": str(e), "skill": skill_name}
