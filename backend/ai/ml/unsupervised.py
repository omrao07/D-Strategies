# backend/ai/ml/unsupervised.py
"""
Unsupervised ML: Hidden Markov Model (regime detection), PCA factor extraction,
and Autoencoder anomaly detection.
All models degrade gracefully when optional deps are absent.
"""
from __future__ import annotations

import logging
from typing import List, Optional, Tuple
import numpy as np

logger = logging.getLogger("ai.ml.unsupervised")


# ── Hidden Markov Model ────────────────────────────────────────────────────────

class HMMRegime:
    """
    Gaussian HMM for market regime identification.
    Requires hmmlearn. Falls back to threshold-based regimes without it.
    """

    def __init__(self, n_components: int = 3, covariance_type: str = "full",
                 n_iter: int = 100):
        self.n_components = n_components
        self.covariance_type = covariance_type
        self.n_iter = n_iter
        self._model = None
        self._regimes = ["bull", "neutral", "bear"][:n_components]

    def fit(self, returns: np.ndarray) -> "HMMRegime":
        X = returns.reshape(-1, 1) if returns.ndim == 1 else returns
        try:
            from hmmlearn import hmm  # type: ignore
            self._model = hmm.GaussianHMM(
                n_components=self.n_components,
                covariance_type=self.covariance_type,
                n_iter=self.n_iter,
            )
            self._model.fit(X)
        except ImportError:
            logger.warning("[HMMRegime] hmmlearn not installed — using threshold fallback")
        return self

    def predict(self, returns: np.ndarray) -> np.ndarray:
        if self._model is None:
            return self._threshold_regime(returns)
        X = returns.reshape(-1, 1) if returns.ndim == 1 else returns
        return self._model.predict(X)

    def _threshold_regime(self, returns: np.ndarray) -> np.ndarray:
        out = np.ones(len(returns), dtype=int)  # neutral
        out[returns > 0.005] = 0   # bull
        out[returns < -0.005] = 2  # bear
        return out

    def regime_name(self, state: int) -> str:
        return self._regimes[state % len(self._regimes)]


# ── PCA Factor Extraction ─────────────────────────────────────────────────────

class PCAFactors:
    """
    Principal Component Analysis for factor extraction from returns matrix.
    Pure numpy — no sklearn required.
    """

    def __init__(self, n_components: int = 5):
        self.n_components = n_components
        self.components_: Optional[np.ndarray] = None
        self.explained_variance_ratio_: Optional[np.ndarray] = None
        self._mean: Optional[np.ndarray] = None

    def fit(self, returns: np.ndarray) -> "PCAFactors":
        """returns: (T × N) matrix of asset returns."""
        self._mean = returns.mean(axis=0)
        centered = returns - self._mean
        cov = np.cov(centered, rowvar=False)
        eigvals, eigvecs = np.linalg.eigh(cov)
        # Sort descending
        idx = np.argsort(eigvals)[::-1]
        eigvals = eigvals[idx]
        eigvecs = eigvecs[:, idx]
        self.components_ = eigvecs[:, :self.n_components].T
        total_var = eigvals.sum()
        self.explained_variance_ratio_ = eigvals[:self.n_components] / total_var
        return self

    def transform(self, returns: np.ndarray) -> np.ndarray:
        if self.components_ is None:
            raise RuntimeError("Call fit() first")
        centered = returns - self._mean
        return centered @ self.components_.T

    def factor_loadings(self) -> np.ndarray:
        if self.components_ is None:
            raise RuntimeError("Call fit() first")
        return self.components_


# ── Autoencoder Anomaly Detection ─────────────────────────────────────────────

class AutoencoderAnomaly:
    """
    Autoencoder-based anomaly detector.
    Requires torch. Falls back to z-score anomaly without it.
    """

    def __init__(self, input_dim: int = 20, latent_dim: int = 4,
                 threshold_sigma: float = 3.0):
        self.input_dim = input_dim
        self.latent_dim = latent_dim
        self.threshold_sigma = threshold_sigma
        self._model = None
        self._threshold = None
        self._mean = None
        self._std = None

    def fit(self, X: np.ndarray, epochs: int = 50, lr: float = 1e-3) -> "AutoencoderAnomaly":
        try:
            import torch
            import torch.nn as nn

            class _AE(nn.Module):
                def __init__(self, input_dim, latent_dim):
                    super().__init__()
                    self.enc = nn.Sequential(nn.Linear(input_dim, 32), nn.ReLU(),
                                             nn.Linear(32, latent_dim))
                    self.dec = nn.Sequential(nn.Linear(latent_dim, 32), nn.ReLU(),
                                             nn.Linear(32, input_dim))

                def forward(self, x):
                    return self.dec(self.enc(x))

            model = _AE(X.shape[1], self.latent_dim)
            opt = torch.optim.Adam(model.parameters(), lr=lr)
            loss_fn = nn.MSELoss()
            Xt = torch.tensor(X, dtype=torch.float32)
            model.train()
            for _ in range(epochs):
                opt.zero_grad()
                loss_fn(model(Xt), Xt).backward()
                opt.step()
            model.eval()
            with torch.no_grad():
                recon = model(Xt).numpy()
            errors = np.mean((X - recon) ** 2, axis=1)
            self._threshold = errors.mean() + self.threshold_sigma * errors.std()
            self._model = model
            self._torch = torch
        except ImportError:
            logger.warning("[AutoencoderAnomaly] torch not installed — using z-score")
            self._mean = X.mean(axis=0)
            self._std = X.std(axis=0) + 1e-9
        return self

    def score(self, X: np.ndarray) -> np.ndarray:
        """Return per-sample reconstruction error (higher = more anomalous)."""
        if self._model is not None:
            import torch
            Xt = self._torch.tensor(X, dtype=torch.float32)
            self._model.eval()
            with self._torch.no_grad():
                recon = self._model(Xt).numpy()
            return np.mean((X - recon) ** 2, axis=1)
        # z-score fallback
        z = np.abs((X - self._mean) / self._std)
        return z.mean(axis=1)

    def predict(self, X: np.ndarray) -> np.ndarray:
        """Return boolean mask: True = anomaly."""
        scores = self.score(X)
        if self._threshold is not None:
            return scores > self._threshold
        return scores > self.threshold_sigma
