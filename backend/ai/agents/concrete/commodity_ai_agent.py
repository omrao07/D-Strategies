# backend/ai/agents/concrete/commodity_ai_agent.py
"""
CommodityAIAgent
================
Unified AI agent for the full commodity complex. Aggregates all commodity
signals from CommoditySignalHub (satellite, AIS, EIA, COT, curve, weather),
runs strategy-specific signal generators, and returns a structured
CommodityBrief with ranked trade ideas and risk assessments.

Connects to:
  - CommoditySignalHub     → all alternative data feeds
  - All CommodityStrategy subclasses (energy, metals, agri, carbon)
  - BaseAgent framework    → standard run/plan/act/emit interface
  - Redis event stream     → publishes commodity events
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import pandas as pd

# ── BaseAgent ──
try:
    from backend.ai.agents.core.base_agent import AgentResult, BaseAgent
except Exception:
    try:
        from ..core.base_agent import AgentResult, BaseAgent  # type: ignore
    except Exception:
        class AgentResult:  # type: ignore
            def __init__(self, ok, agent, started_at, finished_at, took_ms, payload=None, error=None, trace=None, meta=None):
                self.ok=ok; self.agent=agent; self.started_at=started_at
                self.finished_at=finished_at; self.took_ms=took_ms
                self.payload=payload; self.error=error; self.trace=trace; self.meta=meta or {}
            def to_dict(self): return self.__dict__
        class BaseAgent:  # type: ignore
            name="base_agent"
            def plan(self, r): return r
            def act(self, r): return {}
            def explain(self): return "noop"
            def heartbeat(self): return {"ok": True}
            def run(self, req, **kw):
                t=int(time.time()*1000)
                return AgentResult(True, self.name, t, t, 0, payload=self.act(self.plan(req)))
            def emit(self, *a, **kw): pass

# ── CommoditySignalHub ──
try:
    from backend.commodities.signal_hub import CommoditySignalHub, CommoditySignalSet
    _HAS_HUB = True
except Exception:
    _HAS_HUB = False
    CommoditySignalHub = None  # type: ignore
    CommoditySignalSet = None  # type: ignore

# ── Strategy registry ──
try:
    from backend.strategies.commodities.battery_metals_ev_demand import BatteryMetalsEVDemand
    from backend.strategies.commodities.carbon_credits_eua import CarbonCreditsEUA
    from backend.strategies.commodities.copper_gold_ratio_economy import CopperGoldRatioEconomy
    from backend.strategies.commodities.corn_soybean_crush import CornSoybeanCrush
    from backend.strategies.commodities.lng_henry_hub_ttf_arb import LNGHenryHubTTFArb
    _HAS_STRATEGIES = True
except Exception:
    _HAS_STRATEGIES = False

# ── COT engine ──
try:
    _HAS_COT = True
except Exception:
    _HAS_COT = False


# ─────────────────────────────────────────────────────────────
# Request / Response data models
# ─────────────────────────────────────────────────────────────

@dataclass
class CommodityRequest:
    """Input to the CommodityAIAgent."""
    # Which commodity universe to analyze
    commodities: List[str] = field(default_factory=lambda: [
        "crude_oil", "natural_gas", "gold", "copper", "soybeans",
        "carbon_eua", "nickel", "lithium", "lng",
    ])

    # Price data: {commodity: pd.DataFrame with price columns}
    price_data: Dict[str, Any] = field(default_factory=dict)

    # Alternative data overrides (if live feeds available)
    satellite_data: Dict[str, Any] = field(default_factory=dict)   # {region: {ndvi_z, nightlights_z}}
    ais_data: Dict[str, Any] = field(default_factory=dict)          # {commodity: {laden_to_ballast, tanker_count}}
    eia_data: Dict[str, Any] = field(default_factory=dict)          # {commodity: {storage_pct, inventory_chg}}
    weather_data: Dict[str, Any] = field(default_factory=dict)      # {region: {hdd_anom, precip_anom}}

    # COT: list of COTRecord per commodity
    cot_data: Dict[str, List[Any]] = field(default_factory=dict)

    # Max signals per commodity to return
    max_signals_per_commodity: int = 5

    # Minimum confidence to include a signal
    min_confidence: float = 0.55

    # Capital for position sizing
    capital: float = 1_000_000.0


@dataclass
class TradeIdea:
    """Single ranked trade idea from the commodity analysis."""
    rank: int
    commodity: str
    strategy: str
    direction: str          # "long" | "short" | "spread_long" | "spread_short" | "neutral"
    contracts: List[str]
    strength: float         # 0..1
    confidence: float       # 0..1
    horizon_days: int
    signal_sources: List[str]
    rationale: str
    sizing_hint: float = 0.0   # suggested position size (fraction of capital)
    stop_loss_pct: float = 0.08
    score: float = 0.0         # composite ranking score = strength × confidence


@dataclass
class CommodityBrief:
    """Full output from CommodityAIAgent.act()"""
    timestamp: str
    commodities_analyzed: List[str]
    n_signals_generated: int
    n_signals_filtered: int

    top_ideas: List[TradeIdea]              # ranked, filtered trade ideas
    macro_regime: str                       # "risk_on" | "risk_off" | "neutral"
    copper_gold_ratio: Optional[float]      # Cu/Au macro indicator

    # Per-commodity signal summary
    signal_summary: Dict[str, Any]          # {commodity: {direction, composite_score, n_signals}}

    # Alt-data availability
    data_sources_active: List[str]

    # Commentary
    top_idea_rationale: str
    risk_flags: List[str]


# ─────────────────────────────────────────────────────────────
# Agent
# ─────────────────────────────────────────────────────────────

class CommodityAIAgent(BaseAgent):  # type: ignore
    """
    AI agent for the full commodity complex.

    Wraps CommoditySignalHub (alt data aggregator) and all commodity
    strategy classes into a single agent interface that produces
    ranked trade ideas, macro regime classification, and a risk dashboard.

    Plugs into the SwarmManager as a first-class agent alongside
    GreeksAgent, MonteCarloAgent, and PortfolioAgent.
    """

    name    = "commodity_ai_agent"
    version = "1.0.0"

    STRATEGY_MAP = {
        "lng":        ("LNGHenryHubTTFArb",       ["hh_price", "ttf_price", "jkm_price"]),
        "soybeans":   ("CornSoybeanCrush",         ["soy_price", "corn_price", "meal_price", "oil_price"]),
        "carbon_eua": ("CarbonCreditsEUA",         ["eua_price", "gas_price_mmbtu", "coal_price_tonne", "power_price_mwh"]),
        "nickel":     ("BatteryMetalsEVDemand",    ["ni_price", "co_price", "li_price"]),
        "copper":     ("CopperGoldRatioEconomy",   ["copper_lb_price", "gold_oz_price"]),
    }

    def __init__(self):
        super().__init__()
        self._hub: Optional[CommoditySignalHub] = None
        self._strategies: Dict[str, Any] = {}
        self._init_strategies()

    def _init_strategies(self):
        """Instantiate strategy objects, fallback gracefully if imports fail."""
        if not _HAS_STRATEGIES:
            return
        try:
            self._strategies["lng"]        = LNGHenryHubTTFArb()
            self._strategies["soybeans"]   = CornSoybeanCrush()
            self._strategies["carbon_eua"] = CarbonCreditsEUA()
            self._strategies["nickel"]     = BatteryMetalsEVDemand()
            self._strategies["copper"]     = CopperGoldRatioEconomy()
        except Exception:
            pass

    def explain(self) -> str:
        return ("Commodity AI agent. Aggregates satellite, AIS, EIA, COT, curve and weather "
                "signals via CommoditySignalHub and runs 5 institutional strategies "
                "(LNG, Soybean Crush, Carbon EUA, Battery Metals, Dr. Copper) to produce "
                "ranked trade ideas and macro regime classification.")

    def plan(self, request: Any) -> CommodityRequest:
        if isinstance(request, CommodityRequest):
            return request
        if isinstance(request, dict):
            return CommodityRequest(
                commodities=request.get("commodities", CommodityRequest.__dataclass_fields__["commodities"].default_factory()),
                price_data=request.get("price_data", {}),
                satellite_data=request.get("satellite_data", {}),
                ais_data=request.get("ais_data", {}),
                eia_data=request.get("eia_data", {}),
                weather_data=request.get("weather_data", {}),
                cot_data=request.get("cot_data", {}),
                max_signals_per_commodity=request.get("max_signals_per_commodity", 5),
                min_confidence=request.get("min_confidence", 0.55),
                capital=request.get("capital", 1_000_000.0),
            )
        return CommodityRequest()

    def act(self, request: CommodityRequest) -> CommodityBrief:
        import datetime
        ts = datetime.datetime.utcnow().isoformat() + "Z"
        all_signals: List[Any] = []
        signal_summary: Dict[str, Any] = {}
        data_sources: List[str] = []
        risk_flags: List[str] = []

        # Build per-commodity aux data
        def _aux(commodity: str) -> Dict[str, Any]:
            aux: Dict[str, Any] = {}
            sat = request.satellite_data.get(commodity) or request.satellite_data.get("global", {})
            if sat:
                aux["satellite"] = sat
                if "satellite" not in data_sources:
                    data_sources.append("satellite")
            ais = request.ais_data.get(commodity, {})
            if ais:
                aux["ais"] = ais
                if "ais" not in data_sources:
                    data_sources.append("ais")
            eia = request.eia_data.get(commodity, {})
            if eia:
                aux["eia"] = eia
                if "eia" not in data_sources:
                    data_sources.append("eia")
            weather = request.weather_data.get(commodity, {})
            if weather:
                aux["weather"] = weather
                if "weather" not in data_sources:
                    data_sources.append("weather")
            return aux

        # ── CommoditySignalHub alt-data pass ──
        if _HAS_HUB and CommoditySignalHub is not None:
            try:
                hub = CommoditySignalHub()
                for commodity in request.commodities:
                    hub_aux = _aux(commodity)
                    if request.cot_data.get(commodity):
                        hub_aux["cot_records"] = request.cot_data[commodity]
                    prices_df = self._get_prices_df(request, commodity)
                    hub_signals = hub.get_signal(commodity, prices_df, hub_aux)
                    if hub_signals:
                        for sig in (hub_signals if isinstance(hub_signals, list) else [hub_signals]):
                            all_signals.append((commodity, "signal_hub", sig))
                if "cot" not in data_sources and request.cot_data:
                    data_sources.append("cot")
                if "forward_curve" not in data_sources:
                    data_sources.append("forward_curve")
            except Exception as e:
                risk_flags.append(f"signal_hub_error: {str(e)[:80]}")

        # ── Strategy-specific signal generation ──
        for commodity, strategy in self._strategies.items():
            if commodity not in request.commodities:
                continue
            try:
                prices_df = self._get_prices_df(request, commodity)
                aux = _aux(commodity)
                sigs = strategy.generate_signals(prices_df, aux)
                for s in sigs:
                    all_signals.append((commodity, strategy.name, s))
            except Exception as e:
                risk_flags.append(f"{commodity}_strategy_error: {str(e)[:80]}")

        # ── Filter and rank signals ──
        trade_ideas = self._rank_signals(all_signals, request.min_confidence, request.capital)

        # ── Per-commodity summary ──
        for commodity in request.commodities:
            commodity_sigs = [(c, st, s) for c, st, s in all_signals if c == commodity]
            if commodity_sigs:
                directions = []
                scores = []
                sources = []
                for _, _, s in commodity_sigs:
                    d = getattr(s, "direction", None) or (s.get("direction") if isinstance(s, dict) else "neutral")
                    strength = getattr(s, "strength", 0.5) or (s.get("strength", 0.5) if isinstance(s, dict) else 0.5)
                    conf = getattr(s, "confidence", 0.5) or (s.get("confidence", 0.5) if isinstance(s, dict) else 0.5)
                    src = getattr(s, "source", "") or (s.get("source", "") if isinstance(s, dict) else "")
                    directions.append(str(d).lower())
                    scores.append(float(strength) * float(conf))
                    sources.append(str(src))
                avg_score = sum(scores) / max(1, len(scores))
                dominant_dir = _dominant_direction(directions)
                signal_summary[commodity] = {
                    "direction": dominant_dir,
                    "composite_score": round(avg_score, 4),
                    "n_signals": len(commodity_sigs),
                    "signal_sources": list(set(sources)),
                }
            else:
                signal_summary[commodity] = {"direction": "neutral", "composite_score": 0.0, "n_signals": 0}

        # ── Macro regime from Cu/Au ──
        macro_regime_str = "neutral"
        cuau: Optional[float] = None
        if "copper" in request.price_data:
            try:
                df = self._get_prices_df(request, "copper")
                if not df.empty and "copper_lb_price" in df.columns and "gold_oz_price" in df.columns:
                    row = df.iloc[-1]
                    cu = float(row.get("copper_lb_price", 4.0))
                    au = float(row.get("gold_oz_price", 2000.0))
                    cuau = round(cu / au * 1000, 4)
                    if cuau > 2.5:
                        macro_regime_str = "risk_on"
                    elif cuau < 1.5:
                        macro_regime_str = "risk_off"
            except Exception:
                pass

        # ── Construct top idea rationale ──
        top_rationale = "No high-confidence commodity signals at this time."
        if trade_ideas:
            t = trade_ideas[0]
            top_rationale = (f"Top idea: {t.direction.upper()} {','.join(t.contracts)} "
                             f"(score={t.score:.2f}) via {t.strategy}. {t.rationale}")

        brief = CommodityBrief(
            timestamp=ts,
            commodities_analyzed=request.commodities,
            n_signals_generated=len(all_signals),
            n_signals_filtered=len(trade_ideas),
            top_ideas=trade_ideas[:10],
            macro_regime=macro_regime_str,
            copper_gold_ratio=cuau,
            signal_summary=signal_summary,
            data_sources_active=list(set(data_sources)) or ["synthetic"],
            top_idea_rationale=top_rationale,
            risk_flags=risk_flags,
        )

        # Emit to Redis
        self.emit(
            stream="commodity_signals",
            event={
                "macro_regime": macro_regime_str,
                "n_signals": len(all_signals),
                "top_direction": (trade_ideas[0].direction if trade_ideas else "neutral"),
                "top_commodity": (trade_ideas[0].commodity if trade_ideas else ""),
                "copper_gold_ratio": cuau,
            }
        )

        return brief

    # ─────────────────────────────────────────────────────────
    # Helpers
    # ─────────────────────────────────────────────────────────

    def _get_prices_df(self, request: CommodityRequest, commodity: str) -> pd.DataFrame:
        """Retrieve or synthesize a price DataFrame for a commodity."""
        raw = request.price_data.get(commodity)
        if raw is None:
            return self._synthetic_prices(commodity)
        if isinstance(raw, pd.DataFrame):
            return raw
        if isinstance(raw, dict):
            return pd.DataFrame([raw])
        if isinstance(raw, list):
            return pd.DataFrame(raw)
        return pd.DataFrame()

    @staticmethod
    def _synthetic_prices(commodity: str) -> pd.DataFrame:
        """Generate a minimal synthetic price row so strategies can run without live data."""
        defaults: Dict[str, Dict[str, float]] = {
            "lng":        {"hh_price": 2.8,  "ttf_price": 9.5,   "jkm_price": 12.0, "eu_storage_pct": 72.0},
            "soybeans":   {"soy_price": 1350, "corn_price": 520,   "meal_price": 395, "oil_price": 0.60},
            "carbon_eua": {"eua_price": 65.0, "gas_price_mmbtu": 3.0, "coal_price_tonne": 80.0, "power_price_mwh": 65.0},
            "nickel":     {"ni_price": 18_000, "co_price": 28_000, "li_price": 12_000, "ev_yoy_pct": 25.0, "ev_penetration": 0.20, "lfp_market_share": 0.38},
            "copper":     {"copper_lb_price": 4.05, "gold_oz_price": 2050.0},
            "crude_oil":  {"cl_price": 75.0},
            "natural_gas": {"ng_price": 2.8},
            "gold":       {"gold_price": 2050.0},
        }
        row = defaults.get(commodity, {"price": 100.0})
        return pd.DataFrame([row])

    @staticmethod
    def _rank_signals(all_signals: List[Any], min_conf: float, capital: float) -> List[TradeIdea]:
        """Convert raw signals into ranked TradeIdea list."""
        ideas: List[TradeIdea] = []
        for commodity, strategy_name, sig in all_signals:
            try:
                direction = str(getattr(sig, "direction", None) or
                                (sig.get("direction", "neutral") if isinstance(sig, dict) else "neutral"))
                strength  = float(getattr(sig, "strength", 0.5) or
                                  (sig.get("strength", 0.5) if isinstance(sig, dict) else 0.5))
                confidence = float(getattr(sig, "confidence", 0.5) or
                                   (sig.get("confidence", 0.5) if isinstance(sig, dict) else 0.5))
                if confidence < min_conf:
                    continue
                contracts = getattr(sig, "contracts", None) or \
                            (sig.get("contracts", [commodity]) if isinstance(sig, dict) else [commodity])
                horizon   = int(getattr(sig, "horizon_days", 14) or
                                (sig.get("horizon_days", 14) if isinstance(sig, dict) else 14))
                rationale = str(getattr(sig, "rationale", "") or
                                (sig.get("rationale", "") if isinstance(sig, dict) else ""))
                source    = str(getattr(sig, "source", "") or
                                (sig.get("source", "") if isinstance(sig, dict) else ""))
                score = round(strength * confidence, 4)
                sizing_hint = min(0.10, score * 0.15)  # max 10% capital per idea
                ideas.append(TradeIdea(
                    rank=0,
                    commodity=commodity,
                    strategy=strategy_name,
                    direction=direction.lower(),
                    contracts=list(contracts) if contracts else [commodity],
                    strength=round(strength, 4),
                    confidence=round(confidence, 4),
                    horizon_days=horizon,
                    signal_sources=[source] if source else [],
                    rationale=rationale,
                    sizing_hint=round(sizing_hint, 4),
                    stop_loss_pct=0.08,
                    score=score,
                ))
            except Exception:
                continue

        # Sort by score descending, assign ranks
        ideas.sort(key=lambda x: x.score, reverse=True)
        for i, idea in enumerate(ideas):
            idea.rank = i + 1
        return ideas


# ─────────────────────────────────────────────────────────────
# Utility
# ─────────────────────────────────────────────────────────────

def _dominant_direction(directions: List[str]) -> str:
    """Return the most common non-neutral direction, or neutral."""
    counts: Dict[str, int] = {}
    for d in directions:
        d_norm = d.lower().strip()
        if "long" in d_norm:
            counts["long"] = counts.get("long", 0) + 1
        elif "short" in d_norm:
            counts["short"] = counts.get("short", 0) + 1
    if not counts:
        return "neutral"
    return max(counts, key=lambda k: counts[k])


# ─────────────────────────────────────────────────────────────
# Convenience factory
# ─────────────────────────────────────────────────────────────

def build_commodity_agent() -> CommodityAIAgent:
    return CommodityAIAgent()


def quick_brief(commodities: Optional[List[str]] = None,
                price_data: Optional[Dict[str, Any]] = None) -> CommodityBrief:
    """One-shot commodity analysis with optional price overrides."""
    agent = CommodityAIAgent()
    req = CommodityRequest(
        commodities=commodities or ["lng", "soybeans", "carbon_eua", "nickel", "copper"],
        price_data=price_data or {},
    )
    result = agent.run(req)
    return result.payload  # type: ignore


if __name__ == "__main__":
    print("=== CommodityAIAgent Demo ===")
    brief = quick_brief()
    print(f"Macro regime: {brief.macro_regime}")
    print(f"Cu/Au ratio: {brief.copper_gold_ratio}")
    print(f"Signals generated: {brief.n_signals_generated} → {brief.n_signals_filtered} filtered")
    print(f"\nTop idea: {brief.top_idea_rationale}")
    print("\nSignal summary:")
    for commodity, summary in brief.signal_summary.items():
        print(f"  {commodity:15}: {summary['direction']:12} score={summary['composite_score']:.3f} n={summary['n_signals']}")
    if brief.risk_flags:
        print(f"\nRisk flags: {brief.risk_flags}")
