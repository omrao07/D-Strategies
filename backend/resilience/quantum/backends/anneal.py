"""
Simulated Annealing Backend
---------------------------

Pure-Python, dependency-free annealing engine.

Designed for:
- QUBO-style optimization
- Portfolio weight selection
- Discrete strategy / signal optimization

This backend is deterministic if seed is fixed.
"""

from typing import Callable, List, Tuple, Optional
import math
import random


# ─────────────────────────────────────────────────────────────
# Types
# ─────────────────────────────────────────────────────────────

State = List[float]
EnergyFn = Callable[[State], float]
NeighborFn = Callable[[State], State]


# ─────────────────────────────────────────────────────────────
# Annealer
# ─────────────────────────────────────────────────────────────

class Annealer:
    def __init__(
        self,
        energy_fn: EnergyFn,
        neighbor_fn: NeighborFn,
        initial_state: State,
        temperature: float = 1.0,
        cooling_rate: float = 0.995,
        min_temperature: float = 1e-6,
        max_steps: int = 50_000,
        seed: Optional[int] = None,
    ):
        if seed is not None:
            random.seed(seed)

        self.energy_fn = energy_fn
        self.neighbor_fn = neighbor_fn
        self.state = initial_state[:]
        self.best_state = initial_state[:]

        self.temperature = float(temperature)
        self.cooling_rate = float(cooling_rate)
        self.min_temperature = float(min_temperature)
        self.max_steps = int(max_steps)

        self.energy = self.energy_fn(self.state)
        self.best_energy = self.energy

    # ─────────────────────────────────────────────────────────

    def step(self) -> None:
        candidate = self.neighbor_fn(self.state)
        candidate_energy = self.energy_fn(candidate)

        delta = candidate_energy - self.energy

        if delta < 0 or random.random() < math.exp(-delta / self.temperature):
            self.state = candidate
            self.energy = candidate_energy

            if candidate_energy < self.best_energy:
                self.best_energy = candidate_energy
                self.best_state = candidate[:]

        self.temperature *= self.cooling_rate

    # ─────────────────────────────────────────────────────────

    def run(self) -> Tuple[State, float]:
        steps = 0

        while self.temperature > self.min_temperature and steps < self.max_steps:
            self.step()
            steps += 1

        return self.best_state, self.best_energy


# ─────────────────────────────────────────────────────────────
# Utility helpers
# ─────────────────────────────────────────────────────────────

def binary_neighbor(state: State, flip_prob: float = 0.1) -> State:
    """Flip random bits in a binary vector."""
    out = state[:]
    for i in range(len(out)):
        if random.random() < flip_prob:
            out[i] = 1.0 - out[i]
    return out


def gaussian_neighbor(state: State, sigma: float = 0.1) -> State:
    """Add Gaussian noise to continuous vector."""
    return [x + random.gauss(0, sigma) for x in state]


def clip_state(state: State, lo: float = -1.0, hi: float = 1.0) -> State:
    """Clip values into bounds."""
    return [max(lo, min(hi, x)) for x in state]


# ─────────────────────────────────────────────────────────────
# Example (commented)
# ─────────────────────────────────────────────────────────────
#
# def energy(x):
#     # Minimize sum of squares
#     return sum(v * v for v in x)
#
# def neighbor(x):
#     return gaussian_neighbor(x, sigma=0.05)
#
# annealer = Annealer(
#     energy_fn=energy,
#     neighbor_fn=neighbor,
#     initial_state=[1.0, -1.0, 0.5],
#     temperature=1.0,
#     seed=42,
# )
#
# best_state, best_energy = annealer.run()
# print(best_state, best_energy)
#