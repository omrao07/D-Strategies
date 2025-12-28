"""
Quantum Optimization Orchestrator
---------------------------------

Unified interface over quantum / quantum-inspired optimizers.

Supported backends:
- "anneal"   → simulated annealing (pure Python)
- "qiskit"   → QAOA via Qiskit (optional dependency)

Backends are loaded lazily and safely.
"""

from typing import Dict, Tuple, List, Optional, Literal

BackendName = Literal["anneal", "qiskit"]


# ─────────────────────────────────────────────────────────────
# Errors
# ─────────────────────────────────────────────────────────────

class BackendError(RuntimeError):
    pass


# ─────────────────────────────────────────────────────────────
# Orchestrator
# ─────────────────────────────────────────────────────────────

class QuantumOptimizer:
    """
    High-level optimizer for QUBO / binary optimization problems.
    """

    def __init__(
        self,
        backend: BackendName = "anneal",
        seed: Optional[int] = None,
        **backend_kwargs,
    ):
        self.backend_name = backend
        self.seed = seed
        self.backend_kwargs = backend_kwargs
        self._backend = None

    # ─────────────────────────────────────────────────────────

    def _load_backend(self):
        if self._backend is not None:
            return

        if self.backend_name == "anneal":
            from quantum.backends.anneal import Annealer

            self._backend = ("anneal", Annealer)

        elif self.backend_name == "qiskit":
            from quantum.backends.qiskit_backend import QiskitBackend

            self._backend = ("qiskit", QiskitBackend)

        else:
            raise BackendError(f"Unknown backend: {self.backend_name}")

    # ─────────────────────────────────────────────────────────

    def solve_qubo(
        self,
        Q: Dict[Tuple[int, int], float],
        n: int,
        initial_state: Optional[List[float]] = None,
    ) -> Tuple[List[int], float]:
        """
        Solve QUBO problem.

        Args:
            Q: dict mapping (i,j) -> coefficient
            n: number of binary variables
            initial_state: optional initial guess

        Returns:
            (solution_vector, objective_value)
        """

        self._load_backend()
        name, backend_cls = self._backend

        if name == "anneal":
            from quantum.backends.anneal import binary_neighbor

            if initial_state is None:
                initial_state = [0.0] * n

            def energy(state: List[float]) -> float:
                e = 0.0
                for (i, j), v in Q.items():
                    e += v * state[i] * state[j]
                return e

            annealer = backend_cls(
                energy_fn=energy,
                neighbor_fn=binary_neighbor,
                initial_state=initial_state,
                seed=self.seed,
                **self.backend_kwargs,
            )

            best_state, best_energy = annealer.run()
            solution = [int(round(x)) for x in best_state]

            return solution, float(best_energy)

        if name == "qiskit":
            backend = backend_cls(seed=self.seed, **self.backend_kwargs)
            return backend.solve_qubo(Q, n)

        raise BackendError("Backend failed to execute")


# ─────────────────────────────────────────────────────────────
# Convenience function
# ─────────────────────────────────────────────────────────────

def solve_qubo(
    Q: Dict[Tuple[int, int], float],
    n: int,
    backend: BackendName = "anneal",
    seed: Optional[int] = None,
    **backend_kwargs,
) -> Tuple[List[int], float]:
    """
    One-shot QUBO solve helper.
    """
    return QuantumOptimizer(
        backend=backend,
        seed=seed,
        **backend_kwargs,
    ).solve_qubo(Q, n)


# ─────────────────────────────────────────────────────────────
# Example (commented)
# ─────────────────────────────────────────────────────────────
#
# Q = {
#     (0, 0): -1.0,
#     (1, 1): -1.0,
#     (0, 1): 2.0,
# }
#
# sol, val = solve_qubo(Q, n=2, backend="anneal", seed=42)
# print(sol, val)
#