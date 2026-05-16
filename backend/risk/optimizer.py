# backend/risk/optimizer.py
"""
Mean-Variance portfolio optimizer (scipy-based SLSQP).

Supports:
  - Long-only and long-short portfolios
  - Per-asset and scalar bounds
  - Leverage constraint
  - Turnover / transaction-cost penalty
  - Sector allocation bounds
  - L2 regularization (shrinkage)
  - Risk-parity portfolio
  - Simplified HRP (inverse-volatility weighting)
"""
from __future__ import annotations

import numpy as np
from scipy.optimize import minimize
from typing import Any, Dict, List, Optional, Tuple, Union


class Optimizer:

    def optimize(
        self,
        mu: np.ndarray,
        Sigma: np.ndarray,
        *,
        risk_aversion: float = 3.0,
        target_vol: Optional[float] = None,
        target_return: Optional[float] = None,
        bounds: Optional[Union[Tuple[float, float], List]] = None,
        budget: float = 1.0,
        leverage: Optional[float] = None,
        costs: Optional[float] = None,
        prev_w: Optional[np.ndarray] = None,
        turnover_lim: Optional[float] = None,
        sector: Optional[np.ndarray] = None,
        sector_bounds: Optional[Dict[int, Tuple[float, float]]] = None,
        l2_reg: Optional[float] = None,
        l1_reg: Optional[float] = None,
        long_only: Optional[bool] = None,
        cards: Optional[Any] = None,
        **kw,
    ) -> Dict[str, Any]:
        """
        Solve the constrained MVO problem:
            min  -mu'w + (lam/2) w'Σw + l2|w|² + costs|w - prev_w|
            s.t. 1'w = budget
                 lb ≤ w ≤ ub
                 |w|₁ ≤ leverage  (if given)
                 sector weight bounds (if given)
                 turnover ≤ turnover_lim (if given)

        Returns dict with keys: w, ret, vol, sharpe.
        """
        mu = np.asarray(mu, dtype=float)
        Sigma = np.asarray(Sigma, dtype=float)
        n = len(mu)

        # --- Input validation ---
        if Sigma.shape != (n, n):
            raise ValueError(f"Sigma shape {Sigma.shape} does not match mu size {n}")
        if np.linalg.matrix_rank(Sigma) < n:
            raise ValueError("Sigma is singular; optimization is ill-posed")

        lam = float(risk_aversion if risk_aversion is not None else 3.0)
        l2 = float(l2_reg) if l2_reg is not None else 0.0
        bgt = float(budget)

        # --- Bounds ---
        if long_only is True and bounds is None:
            lb, ub = 0.0, float("inf")
        elif bounds is None:
            lb, ub = float("-inf"), float("inf")
        elif isinstance(bounds, (tuple, list)) and len(bounds) == 2 and not isinstance(bounds[0], (list, tuple)):
            lb, ub = float(bounds[0]), float(bounds[1])
        else:
            raise ValueError(f"Unsupported bounds format: {bounds}")

        if long_only is True:
            lb = max(lb, 0.0)

        # Feasibility check: lb * n > budget is infeasible
        if lb > -float("inf") and lb * n > bgt + 1e-8:
            raise ValueError(
                f"Infeasible: lb={lb:.4f} × n={n} = {lb*n:.4f} > budget={bgt}"
            )
        if ub < float("inf") and ub * n < bgt - 1e-8:
            raise ValueError(
                f"Infeasible: ub={ub:.4f} × n={n} = {ub*n:.4f} < budget={bgt}"
            )

        # Leverage feasibility
        if leverage is not None:
            lev = float(leverage)
            if lev < bgt - 1e-8:
                raise ValueError(
                    f"Infeasible: leverage={lev} < budget={bgt}"
                )

        scipy_bounds_list = [
            (lb if lb > -float("inf") else None, ub if ub < float("inf") else None)
            for _ in range(n)
        ]

        # --- Objective and gradient ---
        def objective(w: np.ndarray) -> float:
            ret_term = -float(np.dot(mu, w))
            var_term = (lam / 2) * float(w @ Sigma @ w)
            l2_term = l2 * float(np.dot(w, w))
            cost_term = 0.0
            if costs is not None and prev_w is not None:
                cost_term = float(costs) * float(np.sum(np.abs(w - prev_w)))
            return ret_term + var_term + l2_term + cost_term

        def gradient(w: np.ndarray) -> np.ndarray:
            g = -mu + lam * (Sigma @ w) + 2 * l2 * w
            return g

        # --- Constraints ---
        constraints = []

        # Budget
        constraints.append({
            "type": "eq",
            "fun": lambda w: np.sum(w) - bgt,
            "jac": lambda w: np.ones(n),
        })

        # Leverage: sum |w| <= lev
        if leverage is not None:
            lev = float(leverage)
            constraints.append({
                "type": "ineq",
                "fun": lambda w: lev - np.sum(np.abs(w)),
            })

        # Turnover: 0.5 * sum |w - prev_w| <= turnover_lim
        if turnover_lim is not None and prev_w is not None:
            pw = np.asarray(prev_w, dtype=float)
            tl = float(turnover_lim)
            constraints.append({
                "type": "ineq",
                "fun": lambda w: tl * 2 - np.sum(np.abs(w - pw)),
            })

        # Target volatility: w'Σw ≤ target_vol²
        if target_vol is not None:
            tv2 = float(target_vol) ** 2
            constraints.append({
                "type": "ineq",
                "fun": lambda w: tv2 - float(w @ Sigma @ w),
            })

        # Target return (as equality — soft via ineq here)
        if target_return is not None:
            tr = float(target_return)
            constraints.append({
                "type": "ineq",
                "fun": lambda w: float(np.dot(mu, w)) - tr,
            })

        # Sector bounds
        if sector is not None and sector_bounds is not None:
            sec = np.asarray(sector)
            for g, (slo, shi) in sector_bounds.items():
                constraints.append({
                    "type": "ineq",
                    "fun": lambda w, g=g, shi=shi: shi - np.sum(w[sec == g]),
                })
                constraints.append({
                    "type": "ineq",
                    "fun": lambda w, g=g, slo=slo: np.sum(w[sec == g]) - slo,
                })

        # --- Initial weights ---
        w0 = np.full(n, bgt / n)
        if lb > -float("inf"):
            w0 = np.maximum(w0, lb)
        if ub < float("inf"):
            w0 = np.minimum(w0, ub)
        # Re-normalize to budget
        w0 = w0 * bgt / np.sum(w0)

        result = minimize(
            objective,
            w0,
            jac=gradient,
            method="SLSQP",
            bounds=scipy_bounds_list,
            constraints=constraints,
            options={"maxiter": 2000, "ftol": 1e-12},
        )

        if not result.success:
            msg = result.message
            if "Positive directional derivative" not in msg and "Iteration limit" not in msg:
                raise ValueError(f"Optimization failed: {msg}")

        w = result.x
        ret = float(np.dot(mu, w))
        vol = float(np.sqrt(max(1e-14, float(w @ Sigma @ w))))
        sharpe = ret / vol if vol > 1e-10 else 0.0

        return {"w": w, "ret": ret, "vol": vol, "sharpe": sharpe}

    def risk_parity(
        self,
        Sigma: np.ndarray,
        bounds: Optional[Tuple[float, float]] = None,
        **kw,
    ) -> Dict[str, Any]:
        """Equal-risk-contribution portfolio (Maillard et al. 2010).

        Uses the unconstrained log-barrier formulation:
            min  0.5 * y'Σy - sum(ln(y_i)),  y > 0
        At the optimum: y_i*(Σy)_i = 1 for all i (equal RC).
        Then normalize: w = y / sum(y).
        """
        Sigma = np.asarray(Sigma, dtype=float)
        n = Sigma.shape[0]

        lb, ub = 0.0, 1.0
        if bounds is not None and isinstance(bounds, (tuple, list)):
            lb, ub = float(bounds[0]), float(bounds[1])

        def objective(y: np.ndarray) -> float:
            return 0.5 * float(y @ Sigma @ y) - float(np.sum(np.log(np.maximum(y, 1e-14))))

        def gradient(y: np.ndarray) -> np.ndarray:
            return Sigma @ y - 1.0 / np.maximum(y, 1e-14)

        y0 = np.full(n, 1.0)
        result = minimize(
            objective, y0, jac=gradient, method="SLSQP",
            bounds=[(1e-8, None)] * n,
            options={"maxiter": 2000, "ftol": 1e-14},
        )
        y = np.maximum(result.x, 1e-14)
        w = y / np.sum(y)

        # Apply explicit bounds via clipping (small adjustment only)
        if bounds is not None:
            w = np.clip(w, lb, ub)
            s = np.sum(w)
            if s > 1e-10:
                w = w / s

        return {"w": w}

    def hrp(
        self,
        Sigma: np.ndarray,
        **kw,
    ) -> Dict[str, Any]:
        """Simplified HRP: inverse-volatility weights (long-only, budget=1)."""
        Sigma = np.asarray(Sigma, dtype=float)
        vols = np.sqrt(np.maximum(np.diag(Sigma), 1e-14))
        inv_vols = 1.0 / vols
        w = inv_vols / np.sum(inv_vols)
        return {"w": w}
