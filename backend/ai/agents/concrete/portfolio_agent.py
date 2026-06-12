# backend/ai/agents/concrete/portfolio_agent.py
"""
PortfolioAgent
--------------
Quant portfolio construction + execution planning agent.

Connects:
  - backend/portfolio_construction/risk_parity.py  (ERC weights)
  - backend/portfolio_construction/kelly.py         (Kelly sizing)
  - backend/portfolio_construction/hrp.py           (HRP weights)
  - backend/engine/allocator.py                     (final allocation)
  - research/exec/almgren.py                        (optimal execution schedule)

Capabilities:
  - Risk-parity (ERC) weight computation from covariance matrix
  - Kelly criterion sizing per asset (full & fractional)
  - HRP (Hierarchical Risk Parity) weight computation
  - Mean-Variance (inverse-vol weighted as fast proxy)
  - Concentration check: HHI, effective-N, top-3 weight share
  - Risk decomposition: marginal & percentage risk contributions
  - Almgren-Chriss TWAP/optimal execution schedule for a large parent order
  - Rebalancing signal: current vs target weights, drift beyond threshold
  - Human-readable commentary on diversification and sizing
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

try:
    from ..core.base_agent import BaseAgent  # type: ignore
except Exception:
    class BaseAgent:  # type: ignore
        name: str = "base_agent"
        def plan(self, *a, **k): ...
        def act(self, *a, **k): return {}
        def explain(self): return ""
        def heartbeat(self): return {"ok": True}

# ── optional: risk parity ──
try:
    from backend.portfolio_construction.risk_parity import risk_parity_weights  # type: ignore
    _HAS_RP = True
except Exception:
    _HAS_RP = False

# ── optional: kelly ──
try:
    _HAS_KELLY = True
except Exception:
    _HAS_KELLY = False

# ── optional: HRP ──
try:
    from backend.portfolio_construction.hrp import hrp_weights  # type: ignore
    _HAS_HRP = True
except Exception:
    _HAS_HRP = False

# ── optional: allocator ──
try:
    _HAS_ALLOC = True
except Exception:
    _HAS_ALLOC = False

# ── optional: Almgren-Chriss ──
try:
    from research.exec.almgren import ACParams, optimal_schedule  # type: ignore
    _HAS_AC = True
except Exception:
    _HAS_AC = False


# ─────────────────────────────────────────────────────────────
# Inline fallbacks
# ─────────────────────────────────────────────────────────────

def _inv_vol_weights(cov: np.ndarray) -> np.ndarray:
    """Inverse-volatility weights (fast proxy for MV)."""
    vols = np.sqrt(np.diag(cov).clip(1e-12))
    w = 1.0 / vols
    return w / w.sum()

def _marginal_risk(w: np.ndarray, cov: np.ndarray) -> np.ndarray:
    portfolio_var = max(w @ cov @ w, 1e-12)
    sigma = math.sqrt(portfolio_var)
    return (cov @ w) / sigma

def _risk_contribution(w: np.ndarray, cov: np.ndarray) -> np.ndarray:
    mrc = _marginal_risk(w, cov)
    return w * mrc

def _hhi(weights: np.ndarray) -> float:
    return float((weights**2).sum())

def _effective_n(weights: np.ndarray) -> float:
    hhi = _hhi(weights)
    return 1.0 / max(hhi, 1e-12)


# ─────────────────────────────────────────────────────────────
# Request / Response models
# ─────────────────────────────────────────────────────────────

@dataclass
class HoldingSpec:
    symbol: str
    current_qty: float = 0.0
    current_value: float = 0.0         # current market value
    exp_return: float = 0.08           # expected annual return
    exp_vol: float = 0.20              # expected annual vol
    bid_ask_spread: float = 0.001      # for execution cost

@dataclass
class ExecRequest:
    symbol: str
    side: str                           # "buy" | "sell"
    total_qty: float
    avg_daily_vol: float = 1_000_000   # ADV for participation calc
    sigma_daily: float = 0.015         # daily vol of price
    mid_price: float = 100.0
    risk_aversion: float = 1e-6        # Almgren-Chriss lambda
    urgency_days: float = 5.0          # horizon for execution

@dataclass
class PortfolioRequest:
    holdings: List[HoldingSpec]
    cov_matrix: Optional[List[List[float]]] = None   # n×n annualized covariance
    total_capital: float = 1_000_000.0
    methods: List[str] = field(default_factory=lambda: ["risk_parity","hrp","inv_vol"])
    kelly_win_rate: Optional[float] = None    # e.g. 0.55 for Kelly sizing
    kelly_odds: Optional[float] = None        # e.g. 2.0 (reward:risk ratio)
    kelly_fraction: float = 0.25             # fractional Kelly multiplier
    rebalance_threshold: float = 0.05        # trigger rebalance if drift > 5%
    exec_request: Optional[ExecRequest] = None

@dataclass
class WeightSet:
    method: str
    weights: Dict[str, float]
    risk_contributions: Dict[str, float]
    hhi: float
    effective_n: float
    top3_weight_pct: float
    portfolio_vol: float

@dataclass
class KellyResult:
    symbol: str
    kelly_f: float
    fractional_f: float
    recommended_capital: float
    recommended_qty: float              # at mid price

@dataclass
class RebalanceSignal:
    symbol: str
    current_weight: float
    target_weight: float
    drift: float
    action: str                         # "buy" | "sell" | "hold"
    delta_value: float

@dataclass
class ExecSchedule:
    symbol: str
    total_qty: float
    schedule_qty: List[float]           # qty per interval
    schedule_pct: List[float]           # % of total per interval
    expected_cost_bps: float
    urgency_days: float

@dataclass
class PortfolioResponse:
    generated_at: int
    capital: float
    weight_sets: List[WeightSet]
    kelly_results: List[KellyResult]
    rebalance_signals: List[RebalanceSignal]
    exec_schedule: Optional[ExecSchedule]
    summary: str


# ─────────────────────────────────────────────────────────────
# Agent
# ─────────────────────────────────────────────────────────────

class PortfolioAgent(BaseAgent):  # type: ignore
    """
    Portfolio construction + execution planning agent.
    Computes optimal weights via risk parity / HRP / inv-vol,
    Kelly position sizing, rebalancing signals, and Almgren-Chriss
    execution schedules for large parent orders.
    """

    name = "portfolio_agent"

    def plan(self, req: Any) -> PortfolioRequest:
        if isinstance(req, PortfolioRequest):
            return req
        if isinstance(req, dict):
            holdings = [
                HoldingSpec(**{k: v for k, v in h.items() if k in HoldingSpec.__dataclass_fields__})
                if isinstance(h, dict) else h
                for h in req.get("holdings", [])
            ]
            exec_raw = req.get("exec_request")
            exec_req = None
            if exec_raw and isinstance(exec_raw, dict):
                exec_req = ExecRequest(**{k: v for k, v in exec_raw.items() if k in ExecRequest.__dataclass_fields__})
            return PortfolioRequest(
                holdings=holdings,
                cov_matrix=req.get("cov_matrix"),
                total_capital=float(req.get("total_capital", 1_000_000)),
                methods=req.get("methods", ["risk_parity","hrp","inv_vol"]),
                kelly_win_rate=req.get("kelly_win_rate"),
                kelly_odds=req.get("kelly_odds"),
                kelly_fraction=float(req.get("kelly_fraction", 0.25)),
                rebalance_threshold=float(req.get("rebalance_threshold", 0.05)),
                exec_request=exec_req,
            )
        return PortfolioRequest(holdings=[])

    def act(self, req: Any) -> PortfolioResponse:
        req = self.plan(req)
        symbols = [h.symbol for h in req.holdings]
        n = len(symbols)

        if n == 0:
            return PortfolioResponse(generated_at=int(time.time()*1000), capital=req.total_capital,
                                     weight_sets=[], kelly_results=[], rebalance_signals=[],
                                     exec_schedule=None, summary="No holdings specified.")

        # Build covariance matrix
        cov = self._build_cov(req)

        # Compute weight sets for each requested method
        weight_sets: List[WeightSet] = []
        for method in req.methods:
            ws = self._compute_weights(method, symbols, cov, req)
            if ws:
                weight_sets.append(ws)

        # Kelly sizing
        kelly_results: List[KellyResult] = []
        if req.kelly_win_rate and req.kelly_odds:
            for h in req.holdings:
                kr = self._kelly(h, req)
                kelly_results.append(kr)

        # Rebalancing signals (vs first weight set)
        rebalance_signals: List[RebalanceSignal] = []
        if weight_sets and any(h.current_value > 0 for h in req.holdings):
            total_val = sum(h.current_value for h in req.holdings)
            target_ws = weight_sets[0]
            for h in req.holdings:
                cur_w = h.current_value / max(total_val, 1.0)
                tgt_w = target_ws.weights.get(h.symbol, 0.0)
                drift = tgt_w - cur_w
                if abs(drift) >= req.rebalance_threshold:
                    action = "buy" if drift > 0 else "sell"
                    delta_val = drift * req.total_capital
                else:
                    action = "hold"
                    delta_val = 0.0
                rebalance_signals.append(RebalanceSignal(
                    symbol=h.symbol, current_weight=cur_w, target_weight=tgt_w,
                    drift=drift, action=action, delta_value=delta_val,
                ))

        # Execution schedule
        exec_schedule: Optional[ExecSchedule] = None
        if req.exec_request:
            exec_schedule = self._ac_schedule(req.exec_request)

        summary = self._summarize(weight_sets, kelly_results, rebalance_signals, exec_schedule)
        return PortfolioResponse(
            generated_at=int(time.time()*1000),
            capital=req.total_capital,
            weight_sets=weight_sets,
            kelly_results=kelly_results,
            rebalance_signals=rebalance_signals,
            exec_schedule=exec_schedule,
            summary=summary,
        )

    # ─────────────── covariance ───────────────

    def _build_cov(self, req: PortfolioRequest) -> np.ndarray:
        n = len(req.holdings)
        if req.cov_matrix and len(req.cov_matrix) == n:
            return np.array(req.cov_matrix, dtype=float)
        # Diagonal from individual vols (no cross-correlations)
        vols = np.array([h.exp_vol for h in req.holdings], dtype=float)
        return np.diag(vols**2)

    # ─────────────── weight methods ───────────────

    def _compute_weights(self, method: str, symbols: List[str],
                         cov: np.ndarray, req: PortfolioRequest) -> Optional[WeightSet]:
        n = len(symbols)
        w = np.ones(n) / n  # fallback

        try:
            if method == "risk_parity":
                if _HAS_RP:
                    cov_df = pd.DataFrame(cov, index=symbols, columns=symbols)
                    series = risk_parity_weights(cov_df)
                    w = series.values
                else:
                    w = _inv_vol_weights(cov)

            elif method == "hrp":
                if _HAS_HRP:
                    returns_df = pd.DataFrame(
                        np.random.randn(252, n) * [h.exp_vol/math.sqrt(252) for h in req.holdings],
                        columns=symbols
                    )
                    series = hrp_weights(returns_df)
                    w = series.values
                else:
                    w = _inv_vol_weights(cov)

            elif method == "inv_vol":
                w = _inv_vol_weights(cov)

            elif method == "equal":
                w = np.ones(n) / n

        except Exception:
            w = np.ones(n) / n

        w = np.maximum(w, 0.0)
        if w.sum() < 1e-9:
            w = np.ones(n) / n
        w = w / w.sum()

        rc = _risk_contribution(w, cov)
        port_vol = math.sqrt(float(w @ cov @ w))
        top3 = float(sum(sorted(w.tolist(), reverse=True)[:3]) if len(w) >= 3 else float(w.sum()))

        return WeightSet(
            method=method,
            weights={s: float(round(w[i], 6)) for i, s in enumerate(symbols)},
            risk_contributions={s: float(round(rc[i], 8)) for i, s in enumerate(symbols)},
            hhi=round(_hhi(w), 6),
            effective_n=round(_effective_n(w), 2),
            top3_weight_pct=round(top3 * 100, 2),
            portfolio_vol=round(port_vol * 100, 3),  # in %
        )

    # ─────────────── kelly sizing ───────────────

    def _kelly(self, h: HoldingSpec, req: PortfolioRequest) -> KellyResult:
        p = req.kelly_win_rate or 0.5
        b = req.kelly_odds or 1.0
        q = 1 - p
        f_full = max(0.0, (p * b - q) / b)
        f_frac = f_full * req.kelly_fraction

        if _HAS_KELLY:
            try:
                from backend.portfolio_construction.kelly import kelly_fraction as kf
                from backend.portfolio_construction.kelly import kelly_size as ks
                f_full = kf(p, b)
                f_frac = f_full * req.kelly_fraction
                cap = ks(req.total_capital, f_full, kelly_fraction=req.kelly_fraction)
            except Exception:
                cap = req.total_capital * f_frac
        else:
            cap = req.total_capital * f_frac

        mid = h.current_value / max(h.current_qty, 1) if h.current_qty > 0 else 100.0
        qty = cap / max(mid, 1.0)

        return KellyResult(
            symbol=h.symbol, kelly_f=round(f_full, 6),
            fractional_f=round(f_frac, 6),
            recommended_capital=round(cap, 2),
            recommended_qty=round(qty, 4),
        )

    # ─────────────── Almgren-Chriss execution ───────────────

    def _ac_schedule(self, er: ExecRequest) -> ExecSchedule:
        n_slices = max(1, round(er.urgency_days))

        if _HAS_AC:
            try:
                params = ACParams(
                    sigma=er.sigma_daily,
                    eta=er.bid_ask_spread / 2,   # market impact parameter
                    gamma=1e-7,
                    lam=er.risk_aversion,
                    T=er.urgency_days,
                    N=n_slices,
                )
                sched = optimal_schedule(er.total_qty, params)
                qtys = [float(sched.trades[i]) for i in range(len(sched.trades))]
                pcts = [q / max(er.total_qty, 1e-9) for q in qtys]
                exp_cost = float(getattr(sched, "expected_cost", 0.0))
                return ExecSchedule(
                    symbol=er.symbol, total_qty=er.total_qty,
                    schedule_qty=qtys, schedule_pct=pcts,
                    expected_cost_bps=round(exp_cost / max(er.total_qty * er.mid_price, 1) * 10000, 3),
                    urgency_days=er.urgency_days,
                )
            except Exception:
                pass

        # Fallback: TWAP-style (equal slices)
        qty_per = er.total_qty / n_slices
        qtys = [qty_per] * n_slices
        pcts = [1.0 / n_slices] * n_slices
        # Rough cost estimate: spread + market impact proportional to sqrt(ADV)
        pct_adv = er.total_qty / max(er.avg_daily_vol, 1)
        impact_bps = (er.bid_ask_spread * 5000) + (0.1 * pct_adv ** 0.5 * 10000)
        return ExecSchedule(
            symbol=er.symbol, total_qty=er.total_qty,
            schedule_qty=qtys, schedule_pct=pcts,
            expected_cost_bps=round(impact_bps, 3),
            urgency_days=er.urgency_days,
        )

    # ─────────────── commentary ───────────────

    def _summarize(self, wsets: List[WeightSet], kelly: List[KellyResult],
                   rebal: List[RebalanceSignal], exec_sched: Optional[ExecSchedule]) -> str:
        parts: List[str] = []
        for ws in wsets:
            parts.append(f"[{ws.method.upper()}] vol={ws.portfolio_vol:.2f}%, "
                         f"eff-N={ws.effective_n:.1f}, HHI={ws.hhi:.3f}, top3={ws.top3_weight_pct:.1f}%.")
            if ws.effective_n < 3:
                parts.append("WARNING: highly concentrated — effective N < 3.")
            if ws.hhi > 0.25:
                parts.append("HHI > 0.25 — consider diversification.")

        if kelly:
            for k in kelly:
                parts.append(f"Kelly {k.symbol}: f={k.kelly_f:.3f} → frac={k.fractional_f:.3f} "
                              f"→ deploy ~₹{k.recommended_capital:,.0f}.")

        actions = [r for r in rebal if r.action != "hold"]
        if actions:
            parts.append(f"Rebalance needed: {len(actions)} asset(s) outside threshold.")
            for r in actions:
                parts.append(f"  {r.symbol}: {r.action.upper()} {r.delta_value:+,.0f} "
                              f"(cur={r.current_weight*100:.1f}% → tgt={r.target_weight*100:.1f}%).")

        if exec_sched:
            parts.append(f"Exec schedule {exec_sched.symbol}: {len(exec_sched.schedule_qty)} slice(s) "
                         f"over {exec_sched.urgency_days:.0f}d, "
                         f"est. cost={exec_sched.expected_cost_bps:.1f} bps.")

        return " ".join(parts) or "Portfolio analysis complete."

    def explain(self) -> str:
        return ("PortfolioAgent computes risk-parity (ERC), HRP, and inverse-vol weights, "
                "Kelly position sizing, concentration metrics (HHI, effective-N), "
                "rebalancing signals, and Almgren-Chriss optimal execution schedules.")

    def heartbeat(self) -> Dict[str, Any]:
        return {"ok": True, "agent": self.name,
                "has_risk_parity": _HAS_RP, "has_hrp": _HAS_HRP,
                "has_kelly": _HAS_KELLY, "has_almgren": _HAS_AC,
                "ts": int(time.time())}


if __name__ == "__main__":  # pragma: no cover
    agent = PortfolioAgent()
    req = PortfolioRequest(
        holdings=[
            HoldingSpec("RELIANCE",  current_value=300_000, exp_return=0.12, exp_vol=0.22),
            HoldingSpec("TCS",       current_value=250_000, exp_return=0.10, exp_vol=0.18),
            HoldingSpec("HDFCBANK",  current_value=200_000, exp_return=0.09, exp_vol=0.20),
            HoldingSpec("NIFTY50_ETF", current_value=250_000, exp_return=0.08, exp_vol=0.15),
        ],
        total_capital=1_000_000,
        methods=["risk_parity","inv_vol","equal"],
        kelly_win_rate=0.55, kelly_odds=2.0, kelly_fraction=0.25,
        cov_matrix=[
            [0.22**2, 0.03, 0.02, 0.01],
            [0.03, 0.18**2, 0.025, 0.015],
            [0.02, 0.025, 0.20**2, 0.018],
            [0.01, 0.015, 0.018, 0.15**2],
        ],
        exec_request=ExecRequest(symbol="RELIANCE", side="buy",
                                 total_qty=1000, avg_daily_vol=5_000_000,
                                 sigma_daily=0.015, mid_price=2900, urgency_days=3),
    )
    resp = agent.act(req)
    print(resp.summary)
