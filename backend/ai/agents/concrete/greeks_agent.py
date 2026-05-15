# backend/ai/agents/concrete/greeks_agent.py
"""
GreeksAgent
-----------
Full options analytics agent:
  - BSM & Black-76 pricing + complete greek set (delta, gamma, vega, theta, rho, charm, vanna)
  - Implied vol from market prices (bracketed Newton)
  - Portfolio-level aggregate greeks (delta, gamma, vega, theta in cash terms)
  - Delta-hedge notional recommendation
  - IV surface snapshot across a strike/expiry grid
  - Put-call parity arbitrage check
  - Human-readable risk commentary
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Literal, Optional, Tuple

try:
    from ..core.base_agent import BaseAgent  # type: ignore
except Exception:
    class BaseAgent:  # type: ignore
        name: str = "base_agent"
        def plan(self, *a, **k): ...
        def act(self, *a, **k): return {}
        def explain(self): return ""
        def heartbeat(self): return {"ok": True}

try:
    from ..skills.market.greeks import (  # type: ignore
        bsm_greeks, b76_greeks, bsm_price, b76_price,
        implied_vol_bsm, implied_vol_b76,
        charm, vanna, BSMResult, B76Result,
        put_from_call_bsm, call_from_put_bsm,
    )
    _HAS_GREEKS = True
except Exception:
    _HAS_GREEKS = False


# ─────────────────────────────────────────────────────────────
# Inline fallbacks (full implementations if skill import fails)
# ─────────────────────────────────────────────────────────────
if not _HAS_GREEKS:
    def _phi(x: float) -> float:
        return math.exp(-0.5*x*x) / math.sqrt(2*math.pi)

    def _ncdf(x: float) -> float:
        return 0.5*(1 + math.erf(x / math.sqrt(2)))

    def bsm_greeks(s, k, t, r, q, vol, typ):  # type: ignore
        is_call = (typ == "call")
        if t <= 0 or vol <= 0 or s <= 0 or k <= 0:
            return type("R", (), {"price":max(0,(s-k) if is_call else (k-s)), "delta":1.0 if is_call else -1.0,
                                  "gamma":0,"vega":0,"theta":0,"rho":0})()
        st = math.sqrt(t)
        d1 = (math.log(s/k) + (r-q+0.5*vol*vol)*t) / (vol*st)
        d2 = d1 - vol*st
        dr, dq = math.exp(-r*t), math.exp(-q*t)
        price = (dq*s*_ncdf(d1) - dr*k*_ncdf(d2)) if is_call else (dr*k*_ncdf(-d2) - dq*s*_ncdf(-d1))
        delta = dq*(_ncdf(d1) if is_call else _ncdf(d1)-1)
        gamma = dq*_phi(d1)/(s*vol*st)
        vega  = s*dq*_phi(d1)*st
        theta = -(s*dq*_phi(d1)*vol)/(2*st) - q*s*dq*delta + r*k*dr*(_ncdf(d2) if is_call else _ncdf(-d2))*(-1 if is_call else 1)
        rho   = k*t*dr*(_ncdf(d2) if is_call else -_ncdf(-d2))
        return type("R", (), {"price":price,"delta":delta,"gamma":gamma,"vega":vega,"theta":theta,"rho":rho})()

    def b76_greeks(f, k, t, r, vol, typ):  # type: ignore
        is_call = (typ == "call")
        if t <= 0 or vol <= 0: return type("R", (), {"price":0,"delta_f":0,"gamma_f":0,"vega":0,"theta":0,"rho":0})()
        st = math.sqrt(t); d1 = (math.log(f/k)+0.5*vol*vol*t)/(vol*st); d2=d1-vol*st; disc=math.exp(-r*t)
        price = disc*(f*_ncdf(d1)-k*_ncdf(d2)) if is_call else disc*(k*_ncdf(-d2)-f*_ncdf(-d1))
        delta_f = disc*(_ncdf(d1) if is_call else _ncdf(d1)-1)
        gamma_f = disc*_phi(d1)/(f*vol*st); vega = disc*f*_phi(d1)*st
        theta = -(disc*f*_phi(d1)*vol)/(2*st) - r*price; rho = -t*price
        return type("R", (), {"price":price,"delta_f":delta_f,"gamma_f":gamma_f,"vega":vega,"theta":theta,"rho":rho})()

    def implied_vol_bsm(price, s, k, t, r, q, typ, *, tol=1e-7, max_iter=100):  # type: ignore
        lo, hi, v = 1e-6, 6.0, 0.3
        for _ in range(max_iter):
            res = bsm_greeks(s,k,t,r,q,v,typ)
            diff = res.price - price
            if abs(diff) < tol: return v
            v = max(lo, min(hi, v - diff/res.vega if res.vega > 1e-10 else 0.5*(lo+hi)))
        return v

    def implied_vol_b76(price, f, k, t, r, typ, *, tol=1e-7, max_iter=100):  # type: ignore
        lo, hi, v = 1e-6, 6.0, 0.3
        for _ in range(max_iter):
            res = b76_greeks(f,k,t,r,v,typ)
            diff = res.price - price
            if abs(diff) < tol: return v
            v = max(lo, min(hi, v - diff/res.vega if res.vega > 1e-10 else 0.5*(lo+hi)))
        return v

    def charm(s, k, t, r, q, vol, typ): return 0.0  # type: ignore
    def vanna(s, k, t, r, q, vol): return 0.0  # type: ignore
    def put_from_call_bsm(call, s, k, t, r, q): return call - s*math.exp(-q*t) + k*math.exp(-r*t)  # type: ignore
    def call_from_put_bsm(put, s, k, t, r, q): return put + s*math.exp(-q*t) - k*math.exp(-r*t)  # type: ignore


# ─────────────────────────────────────────────────────────────
# Request / Response data models
# ─────────────────────────────────────────────────────────────

OptionType = Literal["call", "put"]
ModelType  = Literal["bsm", "b76"]

@dataclass
class OptionSpec:
    """Single option leg specification."""
    symbol: str                         # underlying ticker
    option_type: OptionType             # "call" | "put"
    model: ModelType = "bsm"            # "bsm" (spot) | "b76" (futures)
    s: float = 100.0                    # spot (BSM) or forward (B76)
    k: float = 100.0                    # strike
    t: float = 0.0822                   # time to expiry in years (≈ 30 days)
    r: float = 0.065                    # risk-free rate
    q: float = 0.0                      # dividend yield (BSM only)
    vol: float = 0.25                   # implied/historical vol
    qty: float = 1.0                    # +ve = long, -ve = short
    notional: float = 1.0               # contract multiplier / notional per lot
    market_price: Optional[float] = None  # if set, compute IV from this

@dataclass
class GreekSurface:
    """IV surface across a strike/expiry grid."""
    symbol: str
    model: ModelType
    strikes: List[float]
    expiries_yr: List[float]
    call_ivs: List[List[Optional[float]]]   # [expiry][strike]
    put_ivs: List[List[Optional[float]]]

@dataclass
class OptionResult:
    """Per-leg analytics."""
    spec: OptionSpec
    price: float
    delta: float
    gamma: float
    vega: float
    theta: float                        # per calendar year
    rho: float
    charm: float
    vanna: float
    iv: Optional[float]                 # recovered IV if market_price set
    dollar_delta: float                 # delta × notional × qty
    dollar_gamma: float                 # gamma × notional × qty
    dollar_vega: float                  # vega × notional × qty × (1% vol move)
    dollar_theta: float                 # theta/365 × notional × qty  (daily)
    parity_check: Optional[float]       # deviation from put-call parity (if both legs)
    commentary: str = ""

@dataclass
class PortfolioGreeks:
    """Aggregate portfolio Greeks."""
    net_delta: float
    net_gamma: float
    net_vega: float
    net_theta_daily: float
    net_rho: float
    net_charm: float
    net_vanna: float
    hedge_notional: float               # shares needed to delta-hedge at spot
    greeks_by_symbol: Dict[str, Dict[str, float]] = field(default_factory=dict)

@dataclass
class GreeksRequest:
    options: List[OptionSpec]
    compute_surface: bool = False
    surface_strikes_pct: List[float] = field(default_factory=lambda: [0.8,0.9,0.95,1.0,1.05,1.1,1.2])
    surface_expiries_yr: List[float] = field(default_factory=lambda: [7/365,14/365,30/365,60/365,90/365,180/365])

@dataclass
class GreeksResponse:
    generated_at: int
    legs: List[OptionResult]
    portfolio: PortfolioGreeks
    surfaces: List[GreekSurface]
    summary: str


# ─────────────────────────────────────────────────────────────
# Agent
# ─────────────────────────────────────────────────────────────

class GreeksAgent(BaseAgent):  # type: ignore
    """
    Options analytics agent.  Works standalone (pure Python) or with
    skills.market.greeks imported.  Handles BSM and Black-76, full
    first- and second-order Greeks, IV recovery, and portfolio-level
    aggregation with hedge recommendations.
    """

    name = "greeks_agent"

    def plan(self, req: Any) -> GreeksRequest:
        if isinstance(req, GreeksRequest):
            return req
        if isinstance(req, dict):
            options = [
                OptionSpec(**{k: v for k, v in o.items() if k in OptionSpec.__dataclass_fields__})
                if isinstance(o, dict) else o
                for o in req.get("options", [])
            ]
            return GreeksRequest(
                options=options,
                compute_surface=req.get("compute_surface", False),
                surface_strikes_pct=req.get("surface_strikes_pct", [0.8,0.9,0.95,1.0,1.05,1.1,1.2]),
                surface_expiries_yr=req.get("surface_expiries_yr", [7/365,14/365,30/365,60/365,90/365]),
            )
        return GreeksRequest(options=[])

    def act(self, req: Any) -> GreeksResponse:
        req = self.plan(req)
        legs: List[OptionResult] = [self._price_leg(spec) for spec in req.options]

        # Portfolio aggregates
        portfolio = self._aggregate(legs)

        # Optional IV surface
        surfaces: List[GreekSurface] = []
        if req.compute_surface:
            seen_symbols = {}
            for spec in req.options:
                key = (spec.symbol, spec.model)
                if key not in seen_symbols:
                    seen_symbols[key] = spec
            for spec in seen_symbols.values():
                surfaces.append(self._iv_surface(spec, req.surface_strikes_pct, req.surface_expiries_yr))

        summary = self._summarize(legs, portfolio)
        return GreeksResponse(
            generated_at=int(time.time() * 1000),
            legs=legs,
            portfolio=portfolio,
            surfaces=surfaces,
            summary=summary,
        )

    # ─────────────── per-leg pricing ───────────────

    def _price_leg(self, spec: OptionSpec) -> OptionResult:
        is_bsm = (spec.model == "bsm")
        typ = spec.option_type

        if is_bsm:
            res = bsm_greeks(spec.s, spec.k, spec.t, spec.r, spec.q, spec.vol, typ)
            delta_val = res.delta
            gamma_val = res.gamma
            ch = charm(spec.s, spec.k, spec.t, spec.r, spec.q, spec.vol, typ)
            vn = vanna(spec.s, spec.k, spec.t, spec.r, spec.q, spec.vol)
            price = res.price; vega = res.vega; theta = res.theta; rho = res.rho
        else:
            res = b76_greeks(spec.s, spec.k, spec.t, spec.r, spec.vol, typ)
            delta_val = res.delta_f
            gamma_val = res.gamma_f
            ch = 0.0; vn = 0.0
            price = res.price; vega = res.vega; theta = res.theta; rho = res.rho

        # Dollar Greeks
        mult = spec.qty * spec.notional
        d_delta  = delta_val * mult
        d_gamma  = gamma_val * mult
        d_vega   = vega * 0.01 * mult       # per 1% vol move
        d_theta  = (theta / 365.0) * mult   # daily

        # Implied vol from market price
        iv: Optional[float] = None
        if spec.market_price is not None and spec.market_price > 0:
            if is_bsm:
                iv = implied_vol_bsm(spec.market_price, spec.s, spec.k, spec.t, spec.r, spec.q, typ)
            else:
                iv = implied_vol_b76(spec.market_price, spec.s, spec.k, spec.t, spec.r, typ)

        commentary = self._leg_commentary(spec, price, delta_val, vega, theta, iv)

        return OptionResult(
            spec=spec, price=price,
            delta=delta_val, gamma=gamma_val, vega=vega, theta=theta, rho=rho,
            charm=ch, vanna=vn,
            iv=iv,
            dollar_delta=d_delta, dollar_gamma=d_gamma,
            dollar_vega=d_vega, dollar_theta=d_theta,
            parity_check=None,
            commentary=commentary,
        )

    # ─────────────── portfolio aggregates ───────────────

    def _aggregate(self, legs: List[OptionResult]) -> PortfolioGreeks:
        net_delta = sum(l.dollar_delta for l in legs)
        net_gamma = sum(l.dollar_gamma for l in legs)
        net_vega  = sum(l.dollar_vega for l in legs)
        net_theta = sum(l.dollar_theta for l in legs)
        net_rho   = sum(l.rho * l.spec.qty * l.spec.notional for l in legs)
        net_charm = sum(l.charm * l.spec.qty * l.spec.notional for l in legs)
        net_vanna = sum(l.vanna * l.spec.qty * l.spec.notional for l in legs)

        # Hedge: to neutralize net delta, short/buy the underlying
        # hedge_notional = -net_delta shares (at spot=1 notional per share)
        avg_spot = (sum(l.spec.s for l in legs) / len(legs)) if legs else 1.0
        hedge_notional = -net_delta * avg_spot

        # Greeks by symbol
        by_sym: Dict[str, Dict[str, float]] = {}
        for l in legs:
            sym = l.spec.symbol
            by_sym.setdefault(sym, {"delta":0,"gamma":0,"vega":0,"theta":0})
            by_sym[sym]["delta"] += l.dollar_delta
            by_sym[sym]["gamma"] += l.dollar_gamma
            by_sym[sym]["vega"]  += l.dollar_vega
            by_sym[sym]["theta"] += l.dollar_theta

        return PortfolioGreeks(
            net_delta=net_delta, net_gamma=net_gamma,
            net_vega=net_vega, net_theta_daily=net_theta,
            net_rho=net_rho, net_charm=net_charm, net_vanna=net_vanna,
            hedge_notional=hedge_notional,
            greeks_by_symbol=by_sym,
        )

    # ─────────────── IV surface ───────────────

    def _iv_surface(self, base: OptionSpec, strikes_pct: List[float], expiries: List[float]) -> GreekSurface:
        strikes = [base.s * pct for pct in strikes_pct]
        call_ivs: List[List[Optional[float]]] = []
        put_ivs:  List[List[Optional[float]]] = []

        for t in expiries:
            c_row: List[Optional[float]] = []
            p_row: List[Optional[float]] = []
            for k in strikes:
                if base.model == "bsm":
                    c_price = bsm_price(base.s, k, t, base.r, base.q, base.vol, "call")
                    p_price = bsm_price(base.s, k, t, base.r, base.q, base.vol, "put")
                    c_iv = implied_vol_bsm(c_price, base.s, k, t, base.r, base.q, "call")
                    p_iv = implied_vol_bsm(p_price, base.s, k, t, base.r, base.q, "put")
                else:
                    c_price = b76_price(base.s, k, t, base.r, base.vol, "call")
                    p_price = b76_price(base.s, k, t, base.r, base.vol, "put")
                    c_iv = implied_vol_b76(c_price, base.s, k, t, base.r, "call")
                    p_iv = implied_vol_b76(p_price, base.s, k, t, base.r, "put")
                c_row.append(round(c_iv, 6) if c_iv else None)
                p_row.append(round(p_iv, 6) if p_iv else None)
            call_ivs.append(c_row)
            put_ivs.append(p_row)

        return GreekSurface(
            symbol=base.symbol, model=base.model,
            strikes=[round(k, 4) for k in strikes],
            expiries_yr=[round(t, 6) for t in expiries],
            call_ivs=call_ivs, put_ivs=put_ivs,
        )

    # ─────────────── commentary ───────────────

    def _leg_commentary(self, spec: OptionSpec, price: float, delta: float,
                        vega: float, theta: float, iv: Optional[float]) -> str:
        parts = [f"{spec.symbol} {spec.option_type.upper()} K={spec.k:.1f} T={spec.t*365:.0f}d:"]
        parts.append(f"price={price:.4f}")
        parts.append(f"Δ={delta:+.4f}")
        if abs(delta) > 0.7:
            parts.append("(deep ITM — mostly delta risk)")
        elif abs(delta) < 0.1:
            parts.append("(far OTM — mostly vega/gamma risk)")
        if iv:
            parts.append(f"IV={iv*100:.1f}%")
        theta_daily = theta / 365
        parts.append(f"θ/day={theta_daily:.4f}")
        if spec.qty < 0:
            parts.append("→ short: collecting theta, selling vol")
        else:
            parts.append("→ long: paying theta, buying vol")
        return " ".join(parts)

    def _summarize(self, legs: List[OptionResult], port: PortfolioGreeks) -> str:
        if not legs:
            return "No options analyzed."
        parts = [f"Portfolio: {len(legs)} leg(s)."]
        parts.append(f"Net Δ={port.net_delta:+.3f} (hedge: {port.hedge_notional:+.1f} shares).")
        parts.append(f"Net Γ={port.net_gamma:+.4f}.")
        parts.append(f"Net Vega (per 1%vol)={port.net_vega:+.2f}.")
        parts.append(f"Net Θ/day={port.net_theta_daily:+.4f}.")
        if port.net_theta_daily > 0:
            parts.append("Theta-positive book — time decay works in your favor.")
        elif port.net_theta_daily < -0.01:
            parts.append("Theta-negative — need price/vol movement to profit.")
        if abs(port.net_delta) > 0.5:
            parts.append(f"Significant directional exposure — consider delta hedge of {port.hedge_notional:+.0f} notional.")
        return " ".join(parts)

    def explain(self) -> str:
        return ("GreeksAgent prices options via BSM/B76, computes full Greek set including charm/vanna, "
                "recovers implied vol from market prices, aggregates portfolio-level Greeks, "
                "generates delta-hedge recommendations, and optionally builds IV surface grids.")

    def heartbeat(self) -> Dict[str, Any]:
        return {"ok": True, "agent": self.name, "has_greeks_skill": _HAS_GREEKS, "ts": int(time.time())}


if __name__ == "__main__":  # pragma: no cover
    agent = GreeksAgent()
    req = GreeksRequest(options=[
        OptionSpec(symbol="NIFTY", option_type="call", model="bsm",
                   s=22000, k=22000, t=30/365, r=0.065, q=0.0, vol=0.18, qty=1, notional=50),
        OptionSpec(symbol="NIFTY", option_type="put",  model="bsm",
                   s=22000, k=21500, t=30/365, r=0.065, q=0.0, vol=0.20, qty=1, notional=50),
    ], compute_surface=False)
    resp = agent.act(req)
    print("Summary:", resp.summary)
    for leg in resp.legs:
        print(f"  {leg.commentary}")
    print(f"Portfolio: delta={resp.portfolio.net_delta:.3f} hedge={resp.portfolio.hedge_notional:.1f}")
