# backend/backtester/optimization_engine.py
"""
Strategy parameter optimization: grid search, random search,
Bayesian optimization, and genetic algorithm.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

# ── Parameter space ───────────────────────────────────────────────────────────

@dataclass
class ParamDef:
    """Definition of a single hyperparameter."""
    name: str
    low: float
    high: float
    dtype: str = "float"       # "float" | "int" | "log"
    choices: Optional[List] = None   # for categorical

    def sample(self, rng: np.random.Generator) -> Any:
        if self.choices is not None:
            return rng.choice(self.choices)
        if self.dtype == "int":
            return int(rng.integers(int(self.low), int(self.high) + 1))
        if self.dtype == "log":
            log_val = rng.uniform(math.log(self.low), math.log(self.high))
            return float(math.exp(log_val))
        return float(rng.uniform(self.low, self.high))

    def linspace(self, n: int) -> List:
        if self.choices:
            return list(self.choices)
        if self.dtype == "int":
            return [int(x) for x in np.linspace(self.low, self.high, n)]
        if self.dtype == "log":
            return [float(x) for x in np.exp(np.linspace(math.log(self.low), math.log(self.high), n))]
        return [float(x) for x in np.linspace(self.low, self.high, n)]


ParamSpace = List[ParamDef]


# ── Optimization result ───────────────────────────────────────────────────────

@dataclass
class OptResult:
    best_params: Dict[str, Any]
    best_score: float
    all_trials: List[Dict]     # {"params": ..., "score": ..., "trial": ...}
    method: str = ""
    elapsed_s: float = 0.0
    n_trials: int = 0

    def top_n(self, n: int = 5) -> List[Dict]:
        sorted_trials = sorted(self.all_trials, key=lambda x: x["score"], reverse=True)
        return sorted_trials[:n]

    def summary(self) -> Dict:
        return {
            "method": self.method,
            "best_score": round(self.best_score, 4),
            "best_params": self.best_params,
            "n_trials": self.n_trials,
            "elapsed_s": round(self.elapsed_s, 2),
            "top5": self.top_n(5),
        }


# ── Grid search ───────────────────────────────────────────────────────────────

def grid_search(
    objective: Callable[[Dict], float],
    param_space: ParamSpace,
    n_per_dim: int = 5,
    maximize: bool = True,
    max_trials: int = 10_000,
    seed: int = 42,
) -> OptResult:
    """
    Exhaustive grid search over parameter space.
    n_per_dim: number of evenly-spaced values per dimension.
    max_trials: hard cap to prevent combinatorial explosion.
    """
    t0 = time.time()
    rng = np.random.default_rng(seed)

    # Build grid
    grids = [p.linspace(n_per_dim) for p in param_space]

    # Flatten via cartesian product
    from itertools import product
    all_combos = list(product(*grids))

    if len(all_combos) > max_trials:
        # Random subsample to stay within budget
        indices = rng.choice(len(all_combos), size=max_trials, replace=False)
        all_combos = [all_combos[i] for i in indices]

    best_params: Dict = {}
    best_score = float("-inf") if maximize else float("inf")
    all_trials: List[Dict] = []

    for i, combo in enumerate(all_combos):
        params = {p.name: v for p, v in zip(param_space, combo)}
        try:
            score = objective(params)
        except Exception:
            score = float("-inf") if maximize else float("inf")

        all_trials.append({"trial": i, "params": params, "score": score})

        if (maximize and score > best_score) or (not maximize and score < best_score):
            best_score = score
            best_params = params.copy()

    return OptResult(
        best_params=best_params,
        best_score=best_score,
        all_trials=all_trials,
        method="grid_search",
        elapsed_s=time.time() - t0,
        n_trials=len(all_trials),
    )


# ── Random search ─────────────────────────────────────────────────────────────

def random_search(
    objective: Callable[[Dict], float],
    param_space: ParamSpace,
    n_trials: int = 100,
    maximize: bool = True,
    seed: int = 42,
) -> OptResult:
    """
    Random sampling of parameter space. Often more efficient than grid search.
    """
    t0 = time.time()
    rng = np.random.default_rng(seed)

    best_params: Dict = {}
    best_score = float("-inf") if maximize else float("inf")
    all_trials: List[Dict] = []

    for i in range(n_trials):
        params = {p.name: p.sample(rng) for p in param_space}
        try:
            score = objective(params)
        except Exception:
            score = float("-inf") if maximize else float("inf")

        all_trials.append({"trial": i, "params": params, "score": score})

        if (maximize and score > best_score) or (not maximize and score < best_score):
            best_score = score
            best_params = params.copy()

    return OptResult(
        best_params=best_params,
        best_score=best_score,
        all_trials=all_trials,
        method="random_search",
        elapsed_s=time.time() - t0,
        n_trials=n_trials,
    )


# ── Bayesian optimization (GP-based) ─────────────────────────────────────────

class GaussianProcessSurrogate:
    """
    Minimal Gaussian Process surrogate for Bayesian optimization.
    Uses RBF kernel with nugget. No external dependencies (pure numpy).
    """

    def __init__(self, noise: float = 1e-6, length_scale: float = 1.0):
        self.noise = noise
        self.length_scale = length_scale
        self._X: Optional[np.ndarray] = None
        self._y: Optional[np.ndarray] = None
        self._K_inv: Optional[np.ndarray] = None

    def _kernel(self, X1: np.ndarray, X2: np.ndarray) -> np.ndarray:
        """RBF kernel."""
        diff = X1[:, None, :] - X2[None, :, :]
        sq_dist = (diff ** 2).sum(axis=-1)
        return np.exp(-0.5 * sq_dist / self.length_scale ** 2)

    def fit(self, X: np.ndarray, y: np.ndarray) -> None:
        self._X = X
        self._y = y
        K = self._kernel(X, X) + self.noise * np.eye(len(X))
        self._K_inv = np.linalg.inv(K)

    def predict(self, X_new: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """Returns (mean, std)."""
        if self._X is None:
            return np.zeros(len(X_new)), np.ones(len(X_new))
        K_s = self._kernel(X_new, self._X)
        K_ss = self._kernel(X_new, X_new)
        mu = K_s @ self._K_inv @ self._y
        cov = K_ss - K_s @ self._K_inv @ K_s.T
        std = np.sqrt(np.maximum(np.diag(cov), 1e-12))
        return mu, std

    def expected_improvement(
        self, X_new: np.ndarray, best: float, xi: float = 0.01
    ) -> np.ndarray:
        from scipy.stats import norm
        mu, std = self.predict(X_new)
        z = (mu - best - xi) / std
        return (mu - best - xi) * norm.cdf(z) + std * norm.pdf(z)


def bayesian_optimization(
    objective: Callable[[Dict], float],
    param_space: ParamSpace,
    n_trials: int = 50,
    n_warmup: int = 10,
    maximize: bool = True,
    seed: int = 42,
) -> OptResult:
    """
    Bayesian optimization with Gaussian Process surrogate and EI acquisition.
    n_warmup: random trials before fitting GP.
    """
    t0 = time.time()
    rng = np.random.default_rng(seed)

    # Normalize continuous dims to [0,1] for GP
    continuous = [p for p in param_space if p.choices is None]
    [p for p in param_space if p.choices is not None]

    def encode(params: Dict) -> np.ndarray:
        row = []
        for p in continuous:
            lo = math.log(p.low) if p.dtype == "log" else p.low
            hi = math.log(p.high) if p.dtype == "log" else p.high
            v = params[p.name]
            v_enc = math.log(v) if p.dtype == "log" else float(v)
            row.append((v_enc - lo) / max(hi - lo, 1e-9))
        return np.array(row)

    gp = GaussianProcessSurrogate()
    X_obs: List[np.ndarray] = []
    y_obs: List[float] = []
    all_trials: List[Dict] = []
    best_score = float("-inf") if maximize else float("inf")
    best_params: Dict = {}

    for i in range(n_trials):
        if i < n_warmup or len(X_obs) < 2:
            # Random warmup
            params = {p.name: p.sample(rng) for p in param_space}
        else:
            # Acquisition: EI over random candidates
            candidates = [{p.name: p.sample(rng) for p in param_space} for _ in range(200)]
            X_cand = np.array([encode(c) for c in candidates])
            best_so_far = max(y_obs) if maximize else min(y_obs)
            ei = gp.expected_improvement(X_cand, best_so_far)
            if not maximize:
                ei = -ei
            best_idx = int(np.argmax(ei))
            params = candidates[best_idx]

        try:
            score = objective(params)
        except Exception:
            score = float("-inf") if maximize else float("inf")

        all_trials.append({"trial": i, "params": params, "score": score})

        if continuous:
            X_obs.append(encode(params))
            y_obs.append(score if maximize else -score)
            if len(X_obs) >= 2:
                gp.fit(np.array(X_obs), np.array(y_obs))

        if (maximize and score > best_score) or (not maximize and score < best_score):
            best_score = score
            best_params = params.copy()

    return OptResult(
        best_params=best_params,
        best_score=best_score,
        all_trials=all_trials,
        method="bayesian",
        elapsed_s=time.time() - t0,
        n_trials=n_trials,
    )


# ── Genetic algorithm ─────────────────────────────────────────────────────────

def genetic_optimization(
    objective: Callable[[Dict], float],
    param_space: ParamSpace,
    population_size: int = 30,
    n_generations: int = 20,
    mutation_rate: float = 0.15,
    crossover_rate: float = 0.8,
    elite_fraction: float = 0.1,
    maximize: bool = True,
    seed: int = 42,
) -> OptResult:
    """
    Genetic algorithm parameter optimization.
    Uses tournament selection, uniform crossover, Gaussian mutation.
    """
    t0 = time.time()
    rng = np.random.default_rng(seed)
    all_trials: List[Dict] = []
    trial_count = 0

    def evaluate(params: Dict) -> float:
        nonlocal trial_count
        try:
            score = objective(params)
        except Exception:
            score = float("-inf") if maximize else float("inf")
        all_trials.append({"trial": trial_count, "params": params.copy(), "score": score})
        trial_count += 1
        return score

    def random_individual() -> Dict:
        return {p.name: p.sample(rng) for p in param_space}

    def mutate(ind: Dict) -> Dict:
        child = ind.copy()
        for p in param_space:
            if rng.random() < mutation_rate:
                child[p.name] = p.sample(rng)
        return child

    def crossover(a: Dict, b: Dict) -> Tuple[Dict, Dict]:
        if rng.random() > crossover_rate:
            return a.copy(), b.copy()
        child1, child2 = {}, {}
        for p in param_space:
            if rng.random() < 0.5:
                child1[p.name] = a[p.name]
                child2[p.name] = b[p.name]
            else:
                child1[p.name] = b[p.name]
                child2[p.name] = a[p.name]
        return child1, child2

    def tournament(pop: List[Dict], scores: List[float], k: int = 3) -> Dict:
        idxs = rng.choice(len(pop), size=k, replace=False)
        best_idx = max(idxs, key=lambda i: scores[i] if maximize else -scores[i])
        return pop[best_idx].copy()

    # Initialize
    population = [random_individual() for _ in range(population_size)]
    scores = [evaluate(ind) for ind in population]

    best_score = max(scores) if maximize else min(scores)
    best_params = population[scores.index(best_score)].copy()

    n_elite = max(1, int(population_size * elite_fraction))

    for gen in range(n_generations):
        # Sort by fitness
        order = sorted(range(len(population)), key=lambda i: scores[i], reverse=maximize)
        elites = [population[i].copy() for i in order[:n_elite]]

        new_pop = elites.copy()
        while len(new_pop) < population_size:
            parent1 = tournament(population, scores)
            parent2 = tournament(population, scores)
            child1, child2 = crossover(parent1, parent2)
            child1 = mutate(child1)
            child2 = mutate(child2)
            new_pop.append(child1)
            if len(new_pop) < population_size:
                new_pop.append(child2)

        population = new_pop
        scores = [evaluate(ind) for ind in population]

        gen_best = max(scores) if maximize else min(scores)
        if (maximize and gen_best > best_score) or (not maximize and gen_best < best_score):
            best_score = gen_best
            best_params = population[scores.index(gen_best)].copy()

    return OptResult(
        best_params=best_params,
        best_score=best_score,
        all_trials=all_trials,
        method="genetic",
        elapsed_s=time.time() - t0,
        n_trials=trial_count,
    )


# ── Convenience wrapper ───────────────────────────────────────────────────────

def optimize(
    objective: Callable[[Dict], float],
    param_space: ParamSpace,
    method: str = "bayesian",
    n_trials: int = 50,
    maximize: bool = True,
    seed: int = 42,
    **kwargs,
) -> OptResult:
    """
    Unified interface to all optimization methods.
    method: "grid" | "random" | "bayesian" | "genetic"
    """
    if method == "grid":
        return grid_search(objective, param_space, maximize=maximize, seed=seed, **kwargs)
    elif method == "random":
        return random_search(objective, param_space, n_trials=n_trials, maximize=maximize, seed=seed)
    elif method == "bayesian":
        return bayesian_optimization(objective, param_space, n_trials=n_trials, maximize=maximize, seed=seed, **kwargs)
    elif method == "genetic":
        return genetic_optimization(objective, param_space, maximize=maximize, seed=seed, **kwargs)
    else:
        raise ValueError(f"Unknown optimization method: {method!r}. Choose from: grid, random, bayesian, genetic")
