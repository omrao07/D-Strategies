# backend/backtester/parallel_runner.py
"""
Parallel strategy evaluation runner.

Runs all 337 strategies independently in parallel, then aggregates results.
Also provides parameter sweep (grid/random search) across strategies.

Architecture:
  - Each strategy gets its own BacktestEngine instance (process-safe)
  - ThreadPoolExecutor for I/O-bound work (signal generation)
  - ProcessPoolExecutor for CPU-bound metric computation
  - Results streamed back progressively (no waiting for all to finish)

Usage:
    runner = ParallelRunner(capital=10_000_000, n_workers=8)
    results = runner.run_all_strategies(
        start="2018-01-01", end="2024-12-31"
    )
    runner.print_leaderboard(results)
    runner.save_results(results, "runs/parallel_sweep.parquet")
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

import pandas as pd

log = logging.getLogger(__name__)


# ── Per-strategy result ───────────────────────────────────────────────────────

@dataclass
class StrategyRunResult:
    name: str
    sharpe: float = 0.0
    sortino: float = 0.0
    cagr: float = 0.0
    max_drawdown: float = 0.0
    calmar: float = 0.0
    win_rate: float = 0.0
    n_trades: int = 0
    total_return: float = 0.0
    elapsed_s: float = 0.0
    anti_overfit_passed: bool = False
    error: Optional[str] = None
    equity_curve: Optional[pd.Series] = None

    @property
    def failed(self) -> bool:
        return self.error is not None

    def to_dict(self) -> Dict:
        return {
            "strategy": self.name,
            "sharpe": round(self.sharpe, 4),
            "sortino": round(self.sortino, 4),
            "cagr": round(self.cagr, 4),
            "max_drawdown": round(self.max_drawdown, 4),
            "calmar": round(self.calmar, 4),
            "win_rate": round(self.win_rate, 4),
            "n_trades": self.n_trades,
            "total_return": round(self.total_return, 4),
            "elapsed_s": round(self.elapsed_s, 2),
            "anti_overfit_passed": self.anti_overfit_passed,
            "error": self.error,
        }


# ── Parallel runner ───────────────────────────────────────────────────────────

class ParallelRunner:
    """
    Runs each strategy independently in parallel using ThreadPoolExecutor.

    Each strategy gets:
      - Its own BacktestEngine (vectorized mode for speed)
      - Its own data feed copy
      - Full metrics computed independently
    """

    def __init__(
        self,
        capital: float = 10_000_000.0,
        n_workers: int = 8,
        mode: str = "vectorized",
        fee_bps: float = 5.0,
        slippage_bps: float = 5.0,
        run_walk_forward: bool = False,
        run_monte_carlo: bool = False,
        verbose: bool = True,
        timeout_per_strategy_s: float = 120.0,
    ):
        self.capital = capital
        self.n_workers = n_workers
        self.mode = mode
        self.fee_bps = fee_bps
        self.slippage_bps = slippage_bps
        self.run_walk_forward = run_walk_forward
        self.run_monte_carlo = run_monte_carlo
        self.verbose = verbose
        self.timeout_per_strategy_s = timeout_per_strategy_s

    def run_all_strategies(
        self,
        start: str,
        end: str,
        feed_factory: Optional[Callable] = None,
        symbols: Optional[List[str]] = None,
        strategy_filter: Optional[Callable] = None,
        progress_cb: Optional[Callable[[str, StrategyRunResult], None]] = None,
    ) -> List[StrategyRunResult]:
        """
        Run all registered strategies in parallel.

        feed_factory: callable() → DataFeed (called per worker to avoid sharing)
        strategy_filter: callable(strategy_instance) → bool
        progress_cb: called with (strategy_name, result) as each finishes

        Returns sorted list of StrategyRunResult.
        """
        from backend.backtester.backtest_engine import BacktestEngine
        from backend.backtester.data_feeds import SyntheticFeed

        # Discover all strategy classes
        strategy_classes = self._discover_strategies()
        if not strategy_classes:
            log.warning("No strategies found in registry")
            return []

        if self.verbose:
            log.info("ParallelRunner: %d strategies, %d workers, mode=%s",
                     len(strategy_classes), self.n_workers, self.mode)

        default_symbols = symbols or [
            "RELIANCE", "TCS", "INFY", "HDFC", "ICICI",
            "SBIN", "WIPRO", "HCLTECH", "LT", "AXISBANK",
        ]

        def _run_one(cls_name_pair: Tuple) -> StrategyRunResult:
            cls, name = cls_name_pair
            t0 = time.perf_counter()
            try:
                # Instantiate fresh engine per strategy
                engine = BacktestEngine(
                    capital=self.capital,
                    mode=self.mode,
                    fee_bps=self.fee_bps,
                    slippage_bps=self.slippage_bps,
                    run_walk_forward=self.run_walk_forward,
                    run_monte_carlo=self.run_monte_carlo,
                    verbose=False,
                )

                instance = cls()
                if strategy_filter and not strategy_filter(instance):
                    return StrategyRunResult(name=name, error="filtered")

                engine.add_strategy(instance)

                if feed_factory:
                    feed = feed_factory()
                else:
                    feed = SyntheticFeed(
                        symbols=default_symbols, start=start, end=end,
                        seed=hash(name) % (2**31),
                    )

                report = engine.run(start=start, end=end, feed=feed)
                m = report.portfolio_metrics

                result = StrategyRunResult(
                    name=name,
                    sharpe=m.sharpe,
                    sortino=m.sortino,
                    cagr=m.cagr,
                    max_drawdown=m.max_drawdown,
                    calmar=m.calmar,
                    win_rate=m.win_rate,
                    n_trades=m.n_trades,
                    total_return=m.total_return,
                    elapsed_s=time.perf_counter() - t0,
                    anti_overfit_passed=report.anti_overfit.passed,
                    equity_curve=report.equity_curve,
                )
            except Exception as exc:
                result = StrategyRunResult(
                    name=name,
                    elapsed_s=time.perf_counter() - t0,
                    error=str(exc),
                )
            return result

        results: List[StrategyRunResult] = []
        pairs = [(cls, name) for name, cls in strategy_classes.items()]

        with ThreadPoolExecutor(max_workers=self.n_workers) as executor:
            futures = {executor.submit(_run_one, pair): pair[1] for pair in pairs}
            n_done = 0
            n_total = len(futures)
            for future in as_completed(futures, timeout=self.timeout_per_strategy_s * n_total):
                name = futures[future]
                try:
                    result = future.result(timeout=self.timeout_per_strategy_s)
                except Exception as exc:
                    result = StrategyRunResult(name=name, error=str(exc))

                results.append(result)
                n_done += 1

                if progress_cb:
                    progress_cb(name, result)
                elif self.verbose and n_done % 10 == 0:
                    pct = 100 * n_done / n_total
                    n_ok = sum(1 for r in results if not r.failed)
                    log.info("[%3.0f%%] %d/%d done, %d OK, %d failed",
                             pct, n_done, n_total, n_ok, n_done - n_ok)

        # Sort by Sharpe (descending), errors last
        results.sort(key=lambda r: (r.error is None, r.sharpe), reverse=True)

        if self.verbose:
            n_ok = sum(1 for r in results if not r.failed)
            n_pass = sum(1 for r in results if r.anti_overfit_passed)
            best = results[0] if results else None
            log.info(
                "ParallelRunner done: %d/%d OK, %d passed anti-overfit, best=%s (Sharpe=%.2f)",
                n_ok, len(results), n_pass,
                best.name if best else "N/A",
                best.sharpe if best else 0,
            )

        return results

    def _discover_strategies(self) -> Dict[str, Any]:
        """Return dict of strategy_name → class."""
        try:
            from backend.engine.registry import HUB, auto_register_strategies
            auto_register_strategies()
            return dict(HUB.strategies._store)
        except Exception as exc:
            log.warning("Could not load strategy registry: %s", exc)
            return {}

    # ── Parameter sweep ───────────────────────────────────────────────────────

    def parameter_sweep(
        self,
        strategy_class: Any,
        param_grid: Dict[str, List],
        start: str,
        end: str,
        feed_factory: Optional[Callable] = None,
        symbols: Optional[List[str]] = None,
        n_workers: Optional[int] = None,
    ) -> pd.DataFrame:
        """
        Grid search over strategy parameters in parallel.

        param_grid: {"param_name": [val1, val2, ...], ...}
        Returns DataFrame with one row per parameter combination, sorted by Sharpe.
        """
        from itertools import product

        from backend.backtester.backtest_engine import BacktestEngine
        from backend.backtester.data_feeds import SyntheticFeed

        keys = list(param_grid.keys())
        values = list(param_grid.values())
        combos = [dict(zip(keys, combo)) for combo in product(*values)]

        default_symbols = symbols or ["RELIANCE", "TCS", "INFY", "HDFC", "ICICI"]
        workers = n_workers or self.n_workers

        log.info("Parameter sweep: %d combinations, %d workers", len(combos), workers)

        def _run_combo(params: Dict) -> Dict:
            t0 = time.perf_counter()
            try:
                engine = BacktestEngine(
                    capital=self.capital, mode=self.mode,
                    fee_bps=self.fee_bps, slippage_bps=self.slippage_bps,
                    run_walk_forward=False, run_monte_carlo=False, verbose=False,
                )
                instance = strategy_class(**params)
                engine.add_strategy(instance)
                feed = feed_factory() if feed_factory else SyntheticFeed(
                    default_symbols, start=start, end=end, seed=42
                )
                report = engine.run(start=start, end=end, feed=feed)
                m = report.portfolio_metrics
                return {
                    **params,
                    "sharpe": m.sharpe,
                    "cagr": m.cagr,
                    "max_drawdown": m.max_drawdown,
                    "calmar": m.calmar,
                    "win_rate": m.win_rate,
                    "n_trades": m.n_trades,
                    "elapsed_s": time.perf_counter() - t0,
                    "error": None,
                }
            except Exception as exc:
                return {**params, "sharpe": float("-inf"), "error": str(exc),
                        "elapsed_s": time.perf_counter() - t0}

        rows = []
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(_run_combo, p): p for p in combos}
            for future in as_completed(futures):
                try:
                    rows.append(future.result())
                except Exception as exc:
                    rows.append({"error": str(exc), "sharpe": float("-inf")})

        df = pd.DataFrame(rows).sort_values("sharpe", ascending=False).reset_index(drop=True)
        return df

    # ── Reporting ─────────────────────────────────────────────────────────────

    def print_leaderboard(
        self, results: List[StrategyRunResult], top_n: int = 20
    ) -> None:
        valid = [r for r in results if not r.failed][:top_n]
        print(f"\n{'='*80}")
        print(f"  STRATEGY LEADERBOARD  (top {top_n})")
        print(f"{'='*80}")
        print(f"  {'#':>3}  {'Strategy':<35} {'Sharpe':>7} {'CAGR':>7} {'MDD':>7} {'Trades':>7} {'AO':>5}")
        print(f"  {'-'*3}  {'-'*35} {'-'*7} {'-'*7} {'-'*7} {'-'*7} {'-'*5}")
        for i, r in enumerate(valid, 1):
            ao = "✓" if r.anti_overfit_passed else "✗"
            print(
                f"  {i:>3}  {r.name:<35} {r.sharpe:>7.3f} "
                f"{r.cagr*100:>6.1f}% {r.max_drawdown*100:>6.1f}% "
                f"{r.n_trades:>7,} {ao:>5}"
            )
        failed = [r for r in results if r.failed]
        print(f"\n  {len(valid)} strategies ran successfully, {len(failed)} failed.")
        print(f"  Anti-overfit passed: {sum(1 for r in valid if r.anti_overfit_passed)}/{len(valid)}")
        print(f"{'='*80}\n")

    def save_results(
        self, results: List[StrategyRunResult], path: str
    ) -> None:
        """Save results to Parquet or CSV."""
        rows = [r.to_dict() for r in results]
        df = pd.DataFrame(rows)
        if path.endswith(".parquet"):
            df.to_parquet(path, index=False)
        else:
            df.to_csv(path, index=False)
        log.info("Saved %d strategy results to %s", len(results), path)

    def to_dataframe(self, results: List[StrategyRunResult]) -> pd.DataFrame:
        """Convert results to sorted DataFrame."""
        rows = [r.to_dict() for r in results if not r.failed]
        if not rows:
            return pd.DataFrame()
        return pd.DataFrame(rows).sort_values("sharpe", ascending=False).reset_index(drop=True)
