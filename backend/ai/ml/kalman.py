# backend/ai/ml/kalman.py
"""
Kalman Filter for pairs trading spread estimation and signal smoothing.
Pure numpy — no external deps.
"""
from __future__ import annotations

from typing import Optional, Tuple
import numpy as np


class KalmanPairFilter:
    """
    Dynamic linear regression via Kalman Filter.
    Estimates time-varying hedge ratio β and spread intercept α
    between two price series.
    """

    def __init__(
        self,
        delta: float = 1e-4,   # state transition noise
        r: float = 1e-2,       # observation noise
    ):
        self.delta = delta
        self.R = r
        # State: [α, β]
        self._theta: Optional[np.ndarray] = None
        self._P: Optional[np.ndarray] = None
        self._Q: Optional[np.ndarray] = None

    def _init_state(self) -> None:
        self._theta = np.zeros(2)  # [α, β]
        self._P = np.eye(2) * 1.0
        self._Q = np.eye(2) * self.delta

    def update(self, y: float, x: float) -> Tuple[float, float, float]:
        """
        Incorporate one observation (y, x).
        Returns (spread, alpha, beta).
        spread = y - (α + β*x)
        """
        if self._theta is None:
            self._init_state()

        F = np.array([1.0, x])  # observation vector

        # Predict
        self._P = self._P + self._Q

        # Kalman gain
        S = F @ self._P @ F + self.R
        K = self._P @ F / S

        # Innovation
        y_hat = F @ self._theta
        innovation = y - y_hat

        # Update
        self._theta = self._theta + K * innovation
        self._P = (np.eye(2) - np.outer(K, F)) @ self._P

        alpha, beta = self._theta
        spread = y - (alpha + beta * x)
        return spread, alpha, beta

    def fit(self, y: np.ndarray, x: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """
        Run Kalman filter over full history.
        Returns (spreads, alphas, betas) arrays of same length as y.
        """
        self._init_state()
        spreads = np.empty(len(y))
        alphas = np.empty(len(y))
        betas = np.empty(len(y))
        for i in range(len(y)):
            spreads[i], alphas[i], betas[i] = self.update(float(y[i]), float(x[i]))
        return spreads, alphas, betas

    def zscore(self, spreads: np.ndarray, window: int = 20) -> np.ndarray:
        """Rolling z-score of the Kalman spread."""
        z = np.zeros(len(spreads))
        for i in range(window, len(spreads)):
            w = spreads[i - window:i]
            mu, sigma = w.mean(), w.std()
            z[i] = (spreads[i] - mu) / sigma if sigma > 1e-9 else 0.0
        return z


class KalmanSmoother:
    """
    Simple univariate Kalman smoother for price or signal series.
    """

    def __init__(self, process_noise: float = 1e-3, obs_noise: float = 1.0):
        self.Q = process_noise
        self.R = obs_noise
        self._x: float = 0.0
        self._P: float = 1.0

    def smooth(self, observations: np.ndarray) -> np.ndarray:
        smoothed = np.empty(len(observations))
        x, P = 0.0, 1.0
        for i, z in enumerate(observations):
            # Predict
            P = P + self.Q
            # Update
            K = P / (P + self.R)
            x = x + K * (z - x)
            P = (1 - K) * P
            smoothed[i] = x
        self._x = x
        self._P = P
        return smoothed

    def update_one(self, z: float) -> float:
        self._P = self._P + self.Q
        K = self._P / (self._P + self.R)
        self._x = self._x + K * (z - self._x)
        self._P = (1 - K) * self._P
        return self._x
