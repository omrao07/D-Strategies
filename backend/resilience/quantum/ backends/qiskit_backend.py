"""
Qiskit Backend
--------------

Quantum-inspired optimization backend using Qiskit.

This module is SAFE even if Qiskit is not installed.
If unavailable, it raises a clear runtime error only when used.
"""

from typing import Dict, Tuple, Optional, List

# ─────────────────────────────────────────────────────────────
# Optional import guard
# ─────────────────────────────────────────────────────────────

try:
    from qiskit import Aer
    from qiskit.algorithms import QAOA
    from qiskit.utils import QuantumInstance
    from qiskit_optimization import QuadraticProgram
    from qiskit_optimization.algorithms import MinimumEigenOptimizer
    from qiskit.algorithms.optimizers import COBYLA
    _QISKIT_AVAILABLE = True
except Exception:
    _QISKIT_AVAILABLE = False


# ─────────────────────────────────────────────────────────────
# Errors
# ─────────────────────────────────────────────────────────────

class QiskitUnavailableError(RuntimeError):
    pass


# ─────────────────────────────────────────────────────────────
# Backend
# ─────────────────────────────────────────────────────────────

class QiskitBackend:
    """
    QAOA-based optimizer for QUBO problems.

    Solves:
        min xᵀ Q x
    where x ∈ {0,1}ⁿ
    """

    def __init__(
        self,
        reps: int = 1,
        shots: int = 1024,
        seed: Optional[int] = None,
        optimizer_maxiter: int = 100,
    ):
        if not _QISKIT_AVAILABLE:
            raise QiskitUnavailableError(
                "Qiskit is not installed. "
                "Install with: pip install qiskit qiskit-optimization"
            )

        backend = Aer.get_backend("aer_simulator")
        qi = QuantumInstance(
            backend=backend,
            shots=shots,
            seed_simulator=seed,
            seed_transpiler=seed,
        )

        optimizer = COBYLA(maxiter=optimizer_maxiter)
        qaoa = QAOA(
            optimizer=optimizer,
            reps=reps,
            quantum_instance=qi,
        )

        self.solver = MinimumEigenOptimizer(qaoa)

    # ─────────────────────────────────────────────────────────

    def solve_qubo(
        self,
        Q: Dict[Tuple[int, int], float],
        n: int,
    ) -> Tuple[List[int], float]:
        """
        Solve QUBO problem.

        Args:
            Q: dict mapping (i, j) -> coefficient
            n: number of binary variables

        Returns:
            (solution_vector, objective_value)
        """

        qp = QuadraticProgram()

        for i in range(n):
            qp.binary_var(name=f"x{i}")

        linear = {}
        quadratic = {}

        for (i, j), v in Q.items():
            if i == j:
                linear[f"x{i}"] = linear.get(f"x{i}", 0.0) + v
            else:
                quadratic[(f"x{i}", f"x{j}")] = v

        qp.minimize(linear=linear, quadratic=quadratic)

        result = self.solver.solve(qp)

        solution = [int(result.variables_dict[f"x{i}"]) for i in range(n)]
        value = float(result.fval)

        return solution, value


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
# backend = QiskitBackend(reps=2, seed=42)
# sol, val = backend.solve_qubo(Q, n=2)
# print(sol, val)
#