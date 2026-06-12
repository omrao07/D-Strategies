# backend/backtester/risk_engine.py
"""
Risk engine: sector limits, correlation limits, VaR/CVaR, factor exposure,
volatility targeting, risk-parity weights, and all gate checks.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from backend.backtester.events import RiskEvent, RiskGateType

# ── Risk config ───────────────────────────────────────────────────────────────

@dataclass
class RiskConfig:
    daily_loss_limit_pct: float = 2.0        # % of starting NAV
    drawdown_limit_pct: float = 10.0         # % from peak NAV
    max_position_pct: float = 20.0           # % of NAV per symbol
    max_sector_pct: float = 30.0             # % of NAV per sector
    max_leverage: float = 5.0
    max_concentration: float = 0.20
    max_correlation: float = 0.85            # max pairwise correlation in book
    var_limit_pct: float = 5.0              # daily 95% VaR as % of NAV
    vix_halt_level: float = 40.0            # halt trading above this VIX
    max_order_rate_per_minute: int = 100
    beta_limit: float = 1.5                  # portfolio beta vs benchmark
    margin_utilization_limit: float = 0.85   # fraction of buying power


# ── Gate results ──────────────────────────────────────────────────────────────

@dataclass
class GateResult:
    passed: bool
    gate: RiskGateType
    reason: str = ""
    current_value: float = 0.0
    limit_value: float = 0.0
    action: str = "allow"          # "allow", "block", "reduce", "warn", "halt"

    def to_risk_event(self, ts, source: str = "risk_engine") -> RiskEvent:
        return RiskEvent(
            ts=ts,
            source=source,
            gate=self.gate,
            triggered=not self.passed,
            reason=self.reason,
            current_value=self.current_value,
            limit_value=self.limit_value,
            action=self.action,
        )


# ── VAR & CVaR ────────────────────────────────────────────────────────────────

def var_historical(returns: np.ndarray, confidence: float = 0.95) -> float:
    """Historical VaR at given confidence level (positive = loss)."""
    if len(returns) < 10:
        return 0.0
    return float(-np.percentile(returns, (1 - confidence) * 100))


def cvar_historical(returns: np.ndarray, confidence: float = 0.95) -> float:
    """Expected Shortfall / CVaR (average of tail losses)."""
    if len(returns) < 10:
        return 0.0
    var = var_historical(returns, confidence)
    tail = returns[returns <= -var]
    if len(tail) == 0:
        return var
    return float(-tail.mean())


def var_parametric(returns: np.ndarray, confidence: float = 0.95) -> float:
    """Parametric (normal) VaR."""
    mu = float(np.mean(returns))
    sigma = float(np.std(returns))
    from scipy.stats import norm
    z = norm.ppf(1 - confidence)
    return float(-(mu + z * sigma))


# ── Beta calculation ──────────────────────────────────────────────────────────

def portfolio_beta(
    portfolio_returns: np.ndarray,
    benchmark_returns: np.ndarray,
) -> float:
    """OLS beta of portfolio vs benchmark."""
    if len(portfolio_returns) < 20:
        return 1.0
    cov = np.cov(portfolio_returns, benchmark_returns)
    if cov[1, 1] == 0:
        return 1.0
    return float(cov[0, 1] / cov[1, 1])


# ── Volatility targeting ──────────────────────────────────────────────────────

def volatility_target_weight(
    current_vol: float,
    target_vol: float,
    max_leverage: float = 2.0,
) -> float:
    """
    Scale position so realized vol ≈ target_vol.
    Returns leverage multiplier clamped to max_leverage.
    """
    if current_vol <= 0:
        return 1.0
    scalar = target_vol / current_vol
    return min(scalar, max_leverage)


# ── Sector exposure ───────────────────────────────────────────────────────────

def sector_exposure(
    positions: Dict[str, float],       # symbol → notional (signed)
    sector_map: Dict[str, str],        # symbol → sector
    nav: float,
) -> Dict[str, float]:
    """Returns sector → gross exposure fraction of NAV."""
    sector_notional: Dict[str, float] = {}
    for sym, notional in positions.items():
        sector = sector_map.get(sym, "Unknown")
        sector_notional[sector] = sector_notional.get(sector, 0.0) + abs(notional)
    return {s: v / max(nav, 1.0) for s, v in sector_notional.items()}


# ── Correlation matrix ────────────────────────────────────────────────────────

def max_pairwise_correlation(returns_df: pd.DataFrame) -> Tuple[float, str, str]:
    """
    Find the maximum pairwise correlation in a returns DataFrame.
    Returns (max_corr, sym_a, sym_b).
    """
    corr = returns_df.corr()
    max_corr = 0.0
    pair = ("", "")
    cols = corr.columns.tolist()
    for i in range(len(cols)):
        for j in range(i + 1, len(cols)):
            c = abs(corr.iloc[i, j])
            if c > max_corr:
                max_corr = c
                pair = (cols[i], cols[j])
    return max_corr, pair[0], pair[1]


# ── Risk-parity weights ───────────────────────────────────────────────────────

def risk_parity_weights(
    cov_matrix: np.ndarray,
    tol: float = 1e-8,
    max_iter: int = 500,
) -> np.ndarray:
    """
    Equal Risk Contribution weights via Cyclical Coordinate Descent.
    Uses full covariance (not just diagonal) so correlations are properly handled.
    """
    n = cov_matrix.shape[0]
    w = np.ones(n) / n
    for _ in range(max_iter):
        w_prev = w.copy()
        for i in range(n):
            # Marginal risk contribution of asset i = (Cov @ w)[i]
            marginal_risk = float(np.dot(cov_matrix[i], w))
            sigma_i = math.sqrt(max(marginal_risk, 1e-12))
            w[i] = 1.0 / sigma_i
        w = np.clip(w, 0, None)
        w /= w.sum()
        if np.max(np.abs(w - w_prev)) < tol:
            break
    return w


# ── Main risk engine ──────────────────────────────────────────────────────────

class RiskEngine:
    """
    Evaluates all risk gates before allowing an order through.
    Also provides portfolio-level risk metrics.
    """

    def __init__(self, config: Optional[RiskConfig] = None):
        self.config = config or RiskConfig()
        self._order_timestamps: List[float] = []   # for rate limiting
        self._peak_nav: float = 0.0
        self._start_nav: float = 0.0
        self._fo_ban_list: set[str] = set()
        self._sector_map: Dict[str, str] = {}
        self.risk_log: List[GateResult] = []

    def initialize(self, nav: float, sector_map: Optional[Dict[str, str]] = None) -> None:
        self._start_nav = nav
        self._peak_nav = nav
        if sector_map:
            self._sector_map = sector_map

    def set_fo_ban_list(self, symbols: List[str]) -> None:
        self._fo_ban_list = set(s.upper() for s in symbols)

    # ── Gate checks ───────────────────────────────────────────────────────────

    def check_fo_ban(self, symbol: str) -> GateResult:
        if symbol.upper() in self._fo_ban_list:
            return GateResult(
                passed=False, gate=RiskGateType.FO_BAN,
                reason=f"{symbol} is on F&O ban list",
                action="block",
            )
        return GateResult(passed=True, gate=RiskGateType.FO_BAN)

    def check_position_size(
        self, proposed_notional: float, nav: float
    ) -> GateResult:
        limit = nav * self.config.max_position_pct / 100.0
        if proposed_notional > limit:
            return GateResult(
                passed=False, gate=RiskGateType.POSITION_SIZE,
                reason=f"Position {proposed_notional:.0f} > limit {limit:.0f}",
                current_value=proposed_notional, limit_value=limit,
                action="reduce",
            )
        return GateResult(passed=True, gate=RiskGateType.POSITION_SIZE,
                          current_value=proposed_notional, limit_value=limit)

    def check_daily_loss(self, current_nav: float) -> GateResult:
        if self._start_nav <= 0:
            return GateResult(passed=True, gate=RiskGateType.DAILY_LOSS)
        loss_pct = (self._start_nav - current_nav) / self._start_nav * 100.0
        limit = self.config.daily_loss_limit_pct
        if loss_pct >= limit:
            return GateResult(
                passed=False, gate=RiskGateType.DAILY_LOSS,
                reason=f"Daily loss {loss_pct:.2f}% >= {limit:.2f}%",
                current_value=loss_pct, limit_value=limit,
                action="halt",
            )
        return GateResult(passed=True, gate=RiskGateType.DAILY_LOSS,
                          current_value=loss_pct, limit_value=limit)

    def check_drawdown(self, current_nav: float) -> GateResult:
        self._peak_nav = max(self._peak_nav, current_nav)
        if self._peak_nav <= 0:
            return GateResult(passed=True, gate=RiskGateType.DRAWDOWN)
        dd_pct = (self._peak_nav - current_nav) / self._peak_nav * 100.0
        limit = self.config.drawdown_limit_pct
        if dd_pct >= limit:
            return GateResult(
                passed=False, gate=RiskGateType.DRAWDOWN,
                reason=f"Drawdown {dd_pct:.2f}% >= {limit:.2f}%",
                current_value=dd_pct, limit_value=limit,
                action="halt",
            )
        return GateResult(passed=True, gate=RiskGateType.DRAWDOWN,
                          current_value=dd_pct, limit_value=limit)

    def check_leverage(self, gross_exposure: float, nav: float) -> GateResult:
        leverage = gross_exposure / max(nav, 1.0)
        limit = self.config.max_leverage
        if leverage > limit:
            return GateResult(
                passed=False, gate=RiskGateType.LEVERAGE,
                reason=f"Leverage {leverage:.2f}x > {limit:.2f}x",
                current_value=leverage, limit_value=limit,
                action="block",
            )
        return GateResult(passed=True, gate=RiskGateType.LEVERAGE,
                          current_value=leverage, limit_value=limit)

    def check_sector(
        self, positions: Dict[str, float], nav: float, symbol: str, new_notional: float
    ) -> GateResult:
        sector = self._sector_map.get(symbol, "Unknown")
        exposures = sector_exposure(positions, self._sector_map, nav)
        current_sec_pct = exposures.get(sector, 0.0) * 100.0
        proposed_pct = current_sec_pct + abs(new_notional) / max(nav, 1.0) * 100.0
        limit = self.config.max_sector_pct
        if proposed_pct > limit:
            return GateResult(
                passed=False, gate=RiskGateType.SECTOR,
                reason=f"Sector {sector} exposure {proposed_pct:.1f}% > {limit:.1f}%",
                current_value=proposed_pct, limit_value=limit,
                action="block",
            )
        return GateResult(passed=True, gate=RiskGateType.SECTOR,
                          current_value=proposed_pct, limit_value=limit)

    def check_correlation(
        self, returns_df: pd.DataFrame
    ) -> GateResult:
        if returns_df.shape[1] < 2 or len(returns_df) < 20:
            return GateResult(passed=True, gate=RiskGateType.CORRELATION)
        max_corr, sym_a, sym_b = max_pairwise_correlation(returns_df)
        limit = self.config.max_correlation
        if max_corr > limit:
            return GateResult(
                passed=False, gate=RiskGateType.CORRELATION,
                reason=f"Corr({sym_a},{sym_b})={max_corr:.2f} > {limit:.2f}",
                current_value=max_corr, limit_value=limit,
                action="warn",
            )
        return GateResult(passed=True, gate=RiskGateType.CORRELATION,
                          current_value=max_corr, limit_value=limit)

    def check_order_rate(self, import_time: float) -> GateResult:
        import time
        now = time.time()
        self._order_timestamps = [t for t in self._order_timestamps if now - t < 60.0]
        self._order_timestamps.append(now)
        rate = len(self._order_timestamps)
        limit = self.config.max_order_rate_per_minute
        if rate > limit:
            return GateResult(
                passed=False, gate=RiskGateType.ORDER_RATE,
                reason=f"Order rate {rate}/min > {limit}/min",
                current_value=float(rate), limit_value=float(limit),
                action="block",
            )
        return GateResult(passed=True, gate=RiskGateType.ORDER_RATE,
                          current_value=float(rate), limit_value=float(limit))

    def check_vix(self, vix: float) -> GateResult:
        limit = self.config.vix_halt_level
        if vix >= limit:
            return GateResult(
                passed=False, gate=RiskGateType.VIX,
                reason=f"VIX {vix:.1f} >= halt level {limit:.1f}",
                current_value=vix, limit_value=limit,
                action="halt",
            )
        return GateResult(passed=True, gate=RiskGateType.VIX,
                          current_value=vix, limit_value=limit)

    def check_margin(self, margin_used: float, buying_power: float) -> GateResult:
        nav = margin_used + buying_power
        if nav <= 0:
            return GateResult(passed=True, gate=RiskGateType.MARGIN)
        util = margin_used / nav
        limit = self.config.margin_utilization_limit
        if util > limit:
            return GateResult(
                passed=False, gate=RiskGateType.MARGIN,
                reason=f"Margin utilization {util:.1%} > {limit:.1%}",
                current_value=util, limit_value=limit,
                action="block",
            )
        return GateResult(passed=True, gate=RiskGateType.MARGIN,
                          current_value=util, limit_value=limit)

    def check_beta(
        self,
        portfolio_returns: np.ndarray,
        benchmark_returns: np.ndarray,
    ) -> GateResult:
        beta = portfolio_beta(portfolio_returns, benchmark_returns)
        limit = self.config.beta_limit
        if abs(beta) > limit:
            return GateResult(
                passed=False, gate=RiskGateType.BETA,
                reason=f"Portfolio beta {beta:.2f} > {limit:.2f}",
                current_value=abs(beta), limit_value=limit,
                action="warn",
            )
        return GateResult(passed=True, gate=RiskGateType.BETA,
                          current_value=abs(beta), limit_value=limit)

    def check_var(
        self, daily_returns: np.ndarray, nav: float, confidence: float = 0.95
    ) -> GateResult:
        if len(daily_returns) < 20:
            return GateResult(passed=True, gate=RiskGateType.CIRCUIT_BREAKER)
        var_pct = var_historical(daily_returns, confidence) * 100.0
        limit = self.config.var_limit_pct
        if var_pct > limit:
            return GateResult(
                passed=False, gate=RiskGateType.CIRCUIT_BREAKER,
                reason=f"95% VaR {var_pct:.2f}% > {limit:.2f}%",
                current_value=var_pct, limit_value=limit,
                action="warn",
            )
        return GateResult(passed=True, gate=RiskGateType.CIRCUIT_BREAKER,
                          current_value=var_pct, limit_value=limit)

    # ── Full pre-trade check ───────────────────────────────────────────────────

    def pre_trade_check(
        self,
        symbol: str,
        proposed_notional: float,
        nav: float,
        gross_exposure: float,
        margin_used: float,
        buying_power: float,
        positions: Optional[Dict[str, float]] = None,
        vix: Optional[float] = None,
        import_time: float = 0.0,
    ) -> Tuple[bool, List[GateResult]]:
        """
        Run all pre-trade risk gates. Returns (all_passed, list_of_results).
        Halting gates short-circuit immediately.
        """
        results: List[GateResult] = []
        positions = positions or {}

        gates = [
            self.check_fo_ban(symbol),
            self.check_position_size(proposed_notional, nav),
            self.check_daily_loss(nav),
            self.check_drawdown(nav),
            self.check_leverage(gross_exposure + proposed_notional, nav),
            self.check_margin(margin_used, buying_power),
        ]

        if positions:
            gates.append(self.check_sector(positions, nav, symbol, proposed_notional))

        if vix is not None:
            gates.append(self.check_vix(vix))

        all_passed = True
        for gate in gates:
            results.append(gate)
            self.risk_log.append(gate)
            if not gate.passed:
                all_passed = False
                if gate.action in ("halt", "block"):
                    break   # short-circuit on hard stops

        return all_passed, results

    # ── Portfolio-level analytics ─────────────────────────────────────────────

    def portfolio_var(
        self,
        weights: np.ndarray,
        cov_matrix: np.ndarray,
        nav: float,
        confidence: float = 0.95,
    ) -> float:
        """Parametric portfolio VaR using covariance matrix."""
        from scipy.stats import norm
        port_variance = weights @ cov_matrix @ weights
        port_vol = math.sqrt(max(port_variance, 0.0))
        z = norm.ppf(confidence)
        return float(nav * port_vol * z)

    def compute_risk_metrics(
        self, daily_returns: np.ndarray, nav: float
    ) -> Dict:
        if len(daily_returns) < 5:
            return {}
        rets = np.array(daily_returns)
        return {
            "var_95": round(var_historical(rets, 0.95) * 100, 3),
            "var_99": round(var_historical(rets, 0.99) * 100, 3),
            "cvar_95": round(cvar_historical(rets, 0.95) * 100, 3),
            "cvar_99": round(cvar_historical(rets, 0.99) * 100, 3),
            "daily_vol_pct": round(float(np.std(rets)) * 100, 3),
            "worst_day_pct": round(float(np.min(rets)) * 100, 3),
            "best_day_pct": round(float(np.max(rets)) * 100, 3),
        }

    def reset_daily(self, nav: float) -> None:
        """Call at start of each trading day to reset daily loss counter."""
        self._start_nav = nav
        self._order_timestamps.clear()
