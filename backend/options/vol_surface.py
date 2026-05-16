# backend/options/vol_surface.py
"""
Implied-volatility surface with bilinear interpolation.

Fits a surface from a list of option quotes (each a dict with T, K, iv),
then answers iv(T, K) and optionally price(kind, T, K, ...) via Black-Scholes.
"""
from __future__ import annotations

import json
import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np


# ---------------------------------------------------------------------------
# Black-Scholes helpers
# ---------------------------------------------------------------------------

def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _bs_price(kind: str, S: float, K: float, T: float, r: float, q: float, sigma: float) -> float:
    if T <= 0:
        intrinsic = max(0.0, (S - K) if kind == "call" else (K - S))
        return intrinsic
    if sigma <= 0:
        fwd = S * math.exp((r - q) * T)
        disc = math.exp(-r * T)
        return disc * max(0.0, (fwd - K) if kind == "call" else (K - fwd))
    fwd = S * math.exp((r - q) * T)
    tot_vol = sigma * math.sqrt(T)
    d1 = (math.log(fwd / K) + 0.5 * tot_vol * tot_vol) / tot_vol
    d2 = d1 - tot_vol
    disc = math.exp(-r * T)
    if kind == "call":
        return disc * (fwd * _norm_cdf(d1) - K * _norm_cdf(d2))
    else:
        return disc * (K * _norm_cdf(-d2) - fwd * _norm_cdf(-d1))


# ---------------------------------------------------------------------------
# Bilinear interpolation helpers
# ---------------------------------------------------------------------------

def _interp2d(
    T_grid: np.ndarray,
    K_grid: np.ndarray,
    iv_grid: np.ndarray,
    T: float,
    K: float,
) -> float:
    """Bilinear interpolation; clamps to grid boundary for extrapolation."""
    T = float(np.clip(T, T_grid[0], T_grid[-1]))
    K = float(np.clip(K, K_grid[0], K_grid[-1]))

    # Find surrounding T indices
    ti = np.searchsorted(T_grid, T, side="right") - 1
    ti = int(np.clip(ti, 0, len(T_grid) - 2))
    T0, T1 = float(T_grid[ti]), float(T_grid[ti + 1])
    wT = (T - T0) / (T1 - T0) if T1 > T0 else 0.0

    # Find surrounding K indices
    ki = np.searchsorted(K_grid, K, side="right") - 1
    ki = int(np.clip(ki, 0, len(K_grid) - 2))
    K0, K1 = float(K_grid[ki]), float(K_grid[ki + 1])
    wK = (K - K0) / (K1 - K0) if K1 > K0 else 0.0

    # Bilinear blend
    v00 = iv_grid[ti, ki]
    v01 = iv_grid[ti, ki + 1]
    v10 = iv_grid[ti + 1, ki]
    v11 = iv_grid[ti + 1, ki + 1]
    return float(
        (1 - wT) * ((1 - wK) * v00 + wK * v01)
        + wT * ((1 - wK) * v10 + wK * v11)
    )


# ---------------------------------------------------------------------------
# VolSurface
# ---------------------------------------------------------------------------

class VolSurface:
    """
    Implied-volatility surface fitted from option quotes.

    Parameters
    ----------
    None — call fit() to calibrate.
    """

    def __init__(self):
        self._T_grid: Optional[np.ndarray] = None
        self._K_grid: Optional[np.ndarray] = None
        self._iv_grid: Optional[np.ndarray] = None
        self._S0: float = 100.0
        self._r: float = 0.0
        self._q: float = 0.0
        self._fitted = False

    # ------------------------------------------------------------------
    def fit(
        self,
        quotes: List[Dict[str, Any]],
        S0: float = 100.0,
        r: float = 0.0,
        q: float = 0.0,
        **kw,
    ) -> "VolSurface":
        """
        Fit the surface from a list of quote dicts.

        Each quote must have: T (float), K (float), iv (float).
        Duplicate (T, K) pairs are averaged.
        """
        self._S0 = float(S0)
        self._r = float(r)
        self._q = float(q)

        # Aggregate IV by (T, K)
        data: Dict[Tuple[float, float], List[float]] = {}
        for q_item in quotes:
            T = float(q_item["T"])
            K = float(q_item["K"])
            iv = float(q_item.get("iv", 0.0))
            if iv > 0:
                data.setdefault((T, K), []).append(iv)

        Ts = sorted({k[0] for k in data})
        Ks = sorted({k[1] for k in data})

        self._T_grid = np.array(Ts)
        self._K_grid = np.array(Ks)

        # Build IV grid
        iv_grid = np.zeros((len(Ts), len(Ks)))
        for i, T in enumerate(Ts):
            for j, K in enumerate(Ks):
                vals = data.get((T, K), [])
                iv_grid[i, j] = float(np.mean(vals)) if vals else float("nan")

        # Fill NaNs with nearest-neighbour along strike axis
        for i in range(len(Ts)):
            row = iv_grid[i]
            nans = np.isnan(row)
            if nans.any() and not nans.all():
                xp = np.where(~nans)[0]
                yp = row[~nans]
                row[nans] = np.interp(np.where(nans)[0], xp, yp)
            elif nans.all():
                row[:] = 0.20  # fallback

        self._iv_grid = iv_grid
        self._fitted = True
        return self

    # ------------------------------------------------------------------
    def iv(self, T: float, K: float) -> float:
        """Return implied volatility at (T, K) via bilinear interpolation."""
        if not self._fitted:
            raise RuntimeError("Surface not fitted; call fit() first.")
        result = _interp2d(self._T_grid, self._K_grid, self._iv_grid, T, K)
        return max(1e-6, result)

    # Aliases
    def vol(self, T: float, K: float) -> float:
        return self.iv(T, K)

    def get_vol(self, T: float, K: float) -> float:
        return self.iv(T, K)

    # ------------------------------------------------------------------
    def price(
        self,
        kind: str,
        T: float,
        K: float,
        S0: Optional[float] = None,
        r: Optional[float] = None,
        q: Optional[float] = None,
    ) -> float:
        """Price a call or put using the fitted implied vol and Black-Scholes."""
        sigma = self.iv(T, K)
        S = S0 if S0 is not None else self._S0
        rf = r if r is not None else self._r
        qf = q if q is not None else self._q
        return _bs_price(kind.lower(), float(S), float(K), float(T), float(rf), float(qf), sigma)

    # ------------------------------------------------------------------
    def grid(
        self,
        expiries: List[float],
        strikes: List[float],
    ) -> np.ndarray:
        """Return [len(expiries), len(strikes)] IV grid."""
        result = np.zeros((len(expiries), len(strikes)))
        for i, T in enumerate(expiries):
            for j, K in enumerate(strikes):
                result[i, j] = self.iv(T, K)
        return result

    # ------------------------------------------------------------------
    def no_arb_checks(self) -> Dict[str, bool]:
        """
        Heuristic calendar and butterfly no-arbitrage checks.

        calendar_ok : total variance T*sigma^2 non-decreasing in T at-the-money.
        butterfly_ok: second difference of IV w.r.t. K is non-negative (approx).
        """
        if not self._fitted:
            return {}
        K_atm = float(self._K_grid[np.argmin(np.abs(self._K_grid - self._S0))])
        tvars = [float(T * self.iv(T, K_atm) ** 2) for T in self._T_grid]
        cal_ok = all(tvars[i] <= tvars[i + 1] + 1e-8 for i in range(len(tvars) - 1))

        T_mid = float(self._T_grid[len(self._T_grid) // 2])
        ivs = [self.iv(T_mid, float(K)) for K in self._K_grid]
        d2 = [ivs[i] - 2 * ivs[i + 1] + ivs[i + 2] for i in range(len(ivs) - 2)]
        bf_ok = all(v >= -1e-4 for v in d2)
        return {"calendar_ok": cal_ok, "butterfly_ok": bf_ok}

    # ------------------------------------------------------------------
    def params(self) -> Dict[str, Any]:
        """Return surface metadata/parameters."""
        if not self._fitted:
            return {}
        return {
            "model": "bilinear_interpolation",
            "n_expiries": len(self._T_grid),
            "n_strikes": len(self._K_grid),
            "T_range": [float(self._T_grid[0]), float(self._T_grid[-1])],
            "K_range": [float(self._K_grid[0]), float(self._K_grid[-1])],
            "S0": self._S0,
            "r": self._r,
            "q": self._q,
        }

    # ------------------------------------------------------------------
    def export_json(self) -> Dict:
        if not self._fitted:
            return {}
        return {
            "T_grid": self._T_grid.tolist(),
            "K_grid": self._K_grid.tolist(),
            "iv_grid": self._iv_grid.tolist(),
            "S0": self._S0,
            "r": self._r,
            "q": self._q,
        }

    def import_json(self, blob: Any) -> None:
        if isinstance(blob, str):
            blob = json.loads(blob)
        self._T_grid = np.asarray(blob["T_grid"])
        self._K_grid = np.asarray(blob["K_grid"])
        self._iv_grid = np.asarray(blob["iv_grid"])
        self._S0 = float(blob.get("S0", 100.0))
        self._r = float(blob.get("r", 0.0))
        self._q = float(blob.get("q", 0.0))
        self._fitted = True
