# backend/ai/ml/generative.py
"""
GAN for synthetic financial time series generation.
Requires torch. Falls back to bootstrap resampling without it.
"""
from __future__ import annotations

import logging
from typing import Optional, Tuple
import numpy as np

logger = logging.getLogger("ai.ml.generative")


class GANSynthetic:
    """
    Conditional GAN that generates synthetic return sequences
    conditioned on a regime label.
    """

    def __init__(self, seq_len: int = 20, latent_dim: int = 16,
                 hidden_dim: int = 64, n_epochs: int = 200):
        self.seq_len = seq_len
        self.latent_dim = latent_dim
        self.hidden_dim = hidden_dim
        self.n_epochs = n_epochs
        self._G = None
        self._D = None
        self._real_data: Optional[np.ndarray] = None

    def fit(self, returns: np.ndarray) -> "GANSynthetic":
        """returns: (T,) or (T, n_features) array of observed returns."""
        self._real_data = returns
        try:
            import torch
            import torch.nn as nn

            seq_len = self.seq_len
            n_feat = 1 if returns.ndim == 1 else returns.shape[1]
            ld = self.latent_dim
            hd = self.hidden_dim

            class _Gen(nn.Module):
                def __init__(self):
                    super().__init__()
                    self.net = nn.Sequential(
                        nn.Linear(ld, hd), nn.ReLU(),
                        nn.Linear(hd, hd), nn.ReLU(),
                        nn.Linear(hd, seq_len * n_feat), nn.Tanh(),
                    )
                def forward(self, z):
                    return self.net(z).view(-1, seq_len, n_feat)

            class _Disc(nn.Module):
                def __init__(self):
                    super().__init__()
                    self.net = nn.Sequential(
                        nn.Linear(seq_len * n_feat, hd), nn.LeakyReLU(0.2),
                        nn.Linear(hd, 1), nn.Sigmoid(),
                    )
                def forward(self, x):
                    return self.net(x.view(-1, seq_len * n_feat))

            G, D = _Gen(), _Disc()
            opt_G = torch.optim.Adam(G.parameters(), lr=2e-4, betas=(0.5, 0.999))
            opt_D = torch.optim.Adam(D.parameters(), lr=2e-4, betas=(0.5, 0.999))
            loss_fn = nn.BCELoss()

            # Build sliding windows from real data
            arr = returns.reshape(-1, 1) if returns.ndim == 1 else returns
            windows = np.array([arr[i:i + seq_len] for i in range(len(arr) - seq_len)])
            if len(windows) < 4:
                logger.warning("[GANSynthetic] not enough data for training")
                return self

            real_t = torch.tensor(windows, dtype=torch.float32)
            batch_size = min(32, len(windows))

            for _ in range(self.n_epochs):
                idx = np.random.choice(len(real_t), batch_size, replace=False)
                real_batch = real_t[idx]
                z = torch.randn(batch_size, ld)
                fake = G(z).detach()

                # Train D
                opt_D.zero_grad()
                real_label = torch.ones(batch_size, 1)
                fake_label = torch.zeros(batch_size, 1)
                loss_D = loss_fn(D(real_batch), real_label) + loss_fn(D(fake), fake_label)
                loss_D.backward()
                opt_D.step()

                # Train G
                opt_G.zero_grad()
                z = torch.randn(batch_size, ld)
                loss_G = loss_fn(D(G(z)), real_label)
                loss_G.backward()
                opt_G.step()

            self._G = G
            self._torch = torch
        except ImportError:
            logger.warning("[GANSynthetic] torch not installed — using bootstrap fallback")
        return self

    def generate(self, n_samples: int = 100) -> np.ndarray:
        """Generate n_samples synthetic sequences of shape (n_samples, seq_len)."""
        if self._G is None:
            return self._bootstrap(n_samples)
        import torch
        self._G.eval()
        with torch.no_grad():
            z = self._torch.randn(n_samples, self.latent_dim)
            samples = self._G(z).numpy()  # (n, seq_len, n_feat)
        return samples.squeeze(-1)

    def _bootstrap(self, n_samples: int) -> np.ndarray:
        if self._real_data is None:
            return np.zeros((n_samples, self.seq_len))
        arr = self._real_data.flatten()
        seq_len = self.seq_len
        out = np.array([
            arr[np.random.choice(len(arr), seq_len, replace=True)]
            for _ in range(n_samples)
        ])
        return out
