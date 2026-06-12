# backend/execution/rl_execution_agent.py
"""
Reinforcement-learning execution agent.

Provides a test-compatible interface:
  agent = RLExecutionAgent(params, broker, risk)
  action = agent.act(state)          # scalar ∈ [-1,1]
  stats  = agent.run_episode(env)    # optional training loop
"""
from __future__ import annotations

import math
import random
from typing import Any, Dict, List


class RLExecutionAgent:
    """
    ε-greedy scalar-action execution agent.

    Action space: scalar ∈ [-1, 1]
      positive → buy (qty ∝ |action| * scale_qty)
      negative → sell

    Constructor accepts (params, broker, risk) so test harnesses
    can inject fakes without touching production infrastructure.
    """

    def __init__(
        self,
        params: Dict[str, Any],
        broker: Any = None,
        risk: Any = None,
    ):
        self.params = params
        self.broker = broker
        self.risk = risk

        seed = int(params.get("seed", 42))
        self._rng = random.Random(seed)

        self.epsilon: float = float(params.get("epsilon", 0.1))
        self._action_space: str = params.get("action_space", "scalar")
        self._scale_qty: float = float(params.get("scale_qty", 100.0))

        # Simple linear Q-proxy: w · state
        self._n_features: int = 4
        self._weights: List[float] = [0.0] * self._n_features
        self._lr: float = float(params.get("lr", 1e-3))
        self._step: int = 0
        self.updates: int = 0

    # ── Core API ──────────────────────────────────────────────────────────────

    def act(self, state: Any) -> Any:
        """
        Return a scalar action in [-1, 1].
        Uses ε-greedy exploration if epsilon > 0.
        """
        if self._rng.random() < self.epsilon:
            action = self._rng.uniform(-1.0, 1.0)
        else:
            features = self._extract(state)
            raw = sum(w * f for w, f in zip(self._weights, features))
            action = max(-1.0, min(1.0, math.tanh(raw)))

        if self._action_space == "dict":
            side = "buy" if action >= 0 else "sell"
            qty = abs(action) * self._scale_qty
            return {"side": side, "qty": qty}
        return action

    def learn(
        self,
        state_or_transition: Any,
        action: float = 0.0,
        reward: float = 0.0,
        next_state: Any = None,
        done: bool = False,
    ) -> None:
        """One-step TD(0) update. Accepts positional args or a dict transition."""
        if isinstance(state_or_transition, dict):
            t = state_or_transition
            state = t.get("state")
            raw_action = t.get("action", action)
            if isinstance(raw_action, dict):
                sign = 1.0 if raw_action.get("side") == "buy" else -1.0
                action = sign * float(raw_action.get("qty", 0.0)) / self._scale_qty
            else:
                action = float(raw_action)
            reward = float(t.get("reward", reward))
            next_state = t.get("next_state", next_state)
            done = bool(t.get("done", done))
        else:
            state = state_or_transition

        if next_state is None:
            next_state = state

        features = self._extract(state)
        next_features = self._extract(next_state)
        q_now = sum(w * f for w, f in zip(self._weights, features))
        q_next = sum(w * f for w, f in zip(self._weights, next_features)) if not done else 0.0
        target = reward + 0.99 * q_next
        error = target - q_now
        for i in range(len(self._weights)):
            self._weights[i] += self._lr * error * features[i]
        self._step += 1
        self.updates += 1

    def run_episode(
        self,
        env: Any,
        max_steps: int = 256,
        train: bool = True,
    ) -> Dict[str, Any]:
        """
        Run one episode against env (must have reset() and step(action) -> obs,reward,done,info).
        Returns stats dict with at minimum {steps, cum_reward}.
        """
        obs = env.reset()
        cum_reward = 0.0
        steps = 0
        episode_actions: List[float] = []

        for _ in range(max_steps):
            action = self.act(obs)
            scalar_action = action if isinstance(action, (int, float)) else (
                1.0 if action.get("side") == "buy" else -1.0
            ) * action.get("qty", 0.0) / self._scale_qty

            next_obs, reward, done, info = env.step(action)
            cum_reward += float(reward)
            steps += 1
            episode_actions.append(float(scalar_action))

            if train:
                self.learn(obs, float(scalar_action), float(reward), next_obs, done)

            obs = next_obs
            if done:
                break

        return {
            "steps": steps,
            "cum_reward": cum_reward,
            "mean_action": sum(episode_actions) / max(1, len(episode_actions)),
        }

    def save(self, path: str) -> None:
        import json
        with open(path, "w") as f:
            json.dump({"weights": self._weights, "step": self._step, "epsilon": self.epsilon}, f)

    def load(self, path: str) -> None:
        import json
        with open(path) as f:
            d = json.load(f)
        self._weights = d.get("weights", self._weights)
        self._step = d.get("step", self._step)
        if "epsilon" in d:
            self.epsilon = float(d["epsilon"])

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _extract(self, state: Any) -> List[float]:
        """Extract a fixed-length feature vector from arbitrary state."""
        try:
            import numpy as np  # type: ignore
            arr = np.asarray(state, dtype=float).ravel()
            if len(arr) >= self._n_features:
                return list(arr[:self._n_features])
            padded = list(arr) + [0.0] * (self._n_features - len(arr))
            return padded
        except Exception:
            pass
        if isinstance(state, (list, tuple)):
            flat = list(state)[:self._n_features]
            return flat + [0.0] * max(0, self._n_features - len(flat))
        return [0.0] * self._n_features
