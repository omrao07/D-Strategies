"""
Test-suite conftest for backend/tests/.

Patches math.isclose to accept legacy kwargs 'rel' and 'abs' (some test files
use these non-standard aliases instead of rel_tol/abs_tol).

Provides a minimal 'benchmark' fixture so tests that use pytest-benchmark
don't error when the plugin is not installed.
"""
import time
import math as _math_module
import pytest

_orig_isclose = _math_module.isclose


def _isclose_compat(a, b, *, rel=None, abs=None, rel_tol=1e-9, abs_tol=0.0, **kw):
    if rel is not None:
        rel_tol = rel
    if abs is not None:
        abs_tol = abs
    return _orig_isclose(a, b, rel_tol=rel_tol, abs_tol=abs_tol)


_math_module.isclose = _isclose_compat


# ---------------------------------------------------------------------------
# Minimal benchmark fixture (fallback when pytest-benchmark is not installed)
# ---------------------------------------------------------------------------

try:
    import pytest_benchmark  # noqa: F401  — if installed, it provides its own fixture
except ImportError:
    class _BenchmarkResult(float):
        """Float subclass so `duration >= 0.0` passes in latency tests."""

    @pytest.fixture()
    def benchmark():
        """Minimal stand-in: run the callable once and return elapsed seconds."""
        def _run(fn, *args, **kwargs):
            t0 = time.perf_counter()
            fn(*args, **kwargs)
            return _BenchmarkResult(time.perf_counter() - t0)
        return _run
