# backend/ai/ml/models.py
"""
Supervised ML signal generators.
All models implement a common interface: fit(X, y) / predict(X) / score(X, y).
Pure numpy/stdlib — XGBoost and sklearn are optional imports.
"""
from __future__ import annotations

import logging
from typing import Any, List, Optional
import numpy as np

logger = logging.getLogger("ai.ml.models")


# ── XGBoost ──────────────────────────────────────────────────────────────────

class XGBoostSignal:
    """XGBoost-based directional signal classifier (requires xgboost package)."""

    def __init__(self, n_estimators: int = 100, max_depth: int = 4,
                 learning_rate: float = 0.1, **kwargs):
        self._params = dict(
            n_estimators=n_estimators,
            max_depth=max_depth,
            learning_rate=learning_rate,
            use_label_encoder=False,
            eval_metric="logloss",
            **kwargs,
        )
        self._model = None

    def fit(self, X: np.ndarray, y: np.ndarray) -> "XGBoostSignal":
        try:
            import xgboost as xgb  # type: ignore
            self._model = xgb.XGBClassifier(**self._params)
            self._model.fit(X, y)
        except ImportError:
            logger.warning("[XGBoostSignal] xgboost not installed — using random baseline")
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self._model is None:
            return np.zeros(len(X), dtype=int)
        return self._model.predict(X)

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        if self._model is None:
            return np.full((len(X), 2), 0.5)
        return self._model.predict_proba(X)


# ── Random Forest ─────────────────────────────────────────────────────────────

class RandomForestSignal:
    """Random Forest signal classifier (requires scikit-learn)."""

    def __init__(self, n_estimators: int = 200, max_depth: int = 6, **kwargs):
        self._params = dict(n_estimators=n_estimators, max_depth=max_depth, **kwargs)
        self._model = None

    def fit(self, X: np.ndarray, y: np.ndarray) -> "RandomForestSignal":
        try:
            from sklearn.ensemble import RandomForestClassifier  # type: ignore
            self._model = RandomForestClassifier(**self._params)
            self._model.fit(X, y)
        except ImportError:
            logger.warning("[RandomForestSignal] scikit-learn not installed")
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self._model is None:
            return np.zeros(len(X), dtype=int)
        return self._model.predict(X)

    def feature_importances(self) -> Optional[np.ndarray]:
        if self._model is None:
            return None
        return self._model.feature_importances_


# ── LSTM ─────────────────────────────────────────────────────────────────────

class LSTMSignal:
    """LSTM sequence model for price prediction (requires torch)."""

    def __init__(self, input_size: int = 10, hidden_size: int = 64,
                 num_layers: int = 2, seq_len: int = 20, **kwargs):
        self.input_size = input_size
        self.hidden_size = hidden_size
        self.num_layers = num_layers
        self.seq_len = seq_len
        self._model = None
        self._device = "cpu"

    def _build(self):
        try:
            import torch
            import torch.nn as nn

            class _LSTM(nn.Module):
                def __init__(self, input_size, hidden_size, num_layers):
                    super().__init__()
                    self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True)
                    self.fc = nn.Linear(hidden_size, 1)

                def forward(self, x):
                    out, _ = self.lstm(x)
                    return torch.sigmoid(self.fc(out[:, -1, :]))

            self._model = _LSTM(self.input_size, self.hidden_size, self.num_layers)
            self._torch = torch
        except ImportError:
            logger.warning("[LSTMSignal] torch not installed")

    def fit(self, X: np.ndarray, y: np.ndarray,
            epochs: int = 20, lr: float = 1e-3) -> "LSTMSignal":
        self._build()
        if self._model is None:
            return self
        import torch
        import torch.nn as nn
        opt = torch.optim.Adam(self._model.parameters(), lr=lr)
        loss_fn = nn.BCELoss()
        Xt = torch.tensor(X, dtype=torch.float32)
        yt = torch.tensor(y, dtype=torch.float32).unsqueeze(1)
        self._model.train()
        for _ in range(epochs):
            opt.zero_grad()
            pred = self._model(Xt)
            loss = loss_fn(pred, yt)
            loss.backward()
            opt.step()
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self._model is None:
            return np.zeros(len(X), dtype=int)
        import torch
        self._model.eval()
        with torch.no_grad():
            Xt = torch.tensor(X, dtype=torch.float32)
            probs = self._model(Xt).numpy().flatten()
        return (probs > 0.5).astype(int)


# ── Transformer ───────────────────────────────────────────────────────────────

class TransformerSignal:
    """Transformer attention model for sequence-based signal generation (requires torch)."""

    def __init__(self, d_model: int = 64, nhead: int = 4,
                 num_encoder_layers: int = 2, seq_len: int = 30, **kwargs):
        self.d_model = d_model
        self.nhead = nhead
        self.num_encoder_layers = num_encoder_layers
        self.seq_len = seq_len
        self._model = None

    def _build(self, input_size: int):
        try:
            import torch
            import torch.nn as nn

            class _Transformer(nn.Module):
                def __init__(self, input_size, d_model, nhead, num_encoder_layers):
                    super().__init__()
                    self.proj = nn.Linear(input_size, d_model)
                    enc_layer = nn.TransformerEncoderLayer(d_model=d_model, nhead=nhead,
                                                           batch_first=True)
                    self.encoder = nn.TransformerEncoder(enc_layer,
                                                         num_layers=num_encoder_layers)
                    self.fc = nn.Linear(d_model, 1)

                def forward(self, x):
                    x = self.proj(x)
                    x = self.encoder(x)
                    return torch.sigmoid(self.fc(x[:, -1, :]))

            self._model = _Transformer(input_size, self.d_model, self.nhead,
                                       self.num_encoder_layers)
            self._torch = torch
        except ImportError:
            logger.warning("[TransformerSignal] torch not installed")

    def fit(self, X: np.ndarray, y: np.ndarray,
            epochs: int = 20, lr: float = 1e-3) -> "TransformerSignal":
        if X.ndim == 2:
            X = X[:, np.newaxis, :]
        self._build(X.shape[-1])
        if self._model is None:
            return self
        import torch
        import torch.nn as nn
        opt = torch.optim.Adam(self._model.parameters(), lr=lr)
        loss_fn = nn.BCELoss()
        Xt = torch.tensor(X, dtype=torch.float32)
        yt = torch.tensor(y, dtype=torch.float32).unsqueeze(1)
        self._model.train()
        for _ in range(epochs):
            opt.zero_grad()
            pred = self._model(Xt)
            loss_fn(pred, yt).backward()
            opt.step()
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self._model is None:
            return np.zeros(len(X), dtype=int)
        import torch
        if X.ndim == 2:
            X = X[:, np.newaxis, :]
        self._model.eval()
        with torch.no_grad():
            Xt = torch.tensor(X, dtype=torch.float32)
            probs = self._model(Xt).numpy().flatten()
        return (probs > 0.5).astype(int)
