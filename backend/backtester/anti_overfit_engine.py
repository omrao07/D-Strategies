# backend/backtester/anti_overfit_engine.py
"""
Anti-overfit engine: survivorship bias detection, data leakage checks,
mandatory validation rules, and out-of-sample testing utilities.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

# ── Validation result ─────────────────────────────────────────────────────────

@dataclass
class ValidationResult:
    rule: str
    passed: bool
    value: float
    threshold: float
    message: str = ""

    def __repr__(self) -> str:
        status = "PASS" if self.passed else "FAIL"
        return f"[{status}] {self.rule}: {self.value:.4f} (threshold={self.threshold:.4f}) — {self.message}"


@dataclass
class AntiOverfitReport:
    results: List[ValidationResult] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return all(r.passed for r in self.results)

    @property
    def n_passed(self) -> int:
        return sum(1 for r in self.results if r.passed)

    @property
    def n_failed(self) -> int:
        return sum(1 for r in self.results if not r.passed)

    def failed_rules(self) -> List[ValidationResult]:
        return [r for r in self.results if not r.passed]

    def summary(self) -> Dict:
        return {
            "passed": self.passed,
            "n_passed": self.n_passed,
            "n_failed": self.n_failed,
            "rules": [
                {
                    "rule": r.rule,
                    "passed": r.passed,
                    "value": round(r.value, 4),
                    "threshold": r.threshold,
                    "message": r.message,
                }
                for r in self.results
            ],
        }


# ── 6 Mandatory anti-overfit rules ────────────────────────────────────────────

class MandatoryRules:
    """
    The 6 institutional mandatory anti-overfit rules.
    All must pass for a strategy to be considered non-overfit.
    """

    MIN_TRADES = 200
    OOS_SHARPE_MIN = 0.5
    WF_CONSISTENCY_MIN = 0.6     # fraction of walk-forward windows with positive Sharpe
    REGIME_COVERAGE_MIN = 3      # must have traded in at least 3 distinct regimes
    LOOKAHEAD_VIOLATIONS_MAX = 0
    IS_OOS_SHARPE_GAP_MAX = 0.8  # IS Sharpe - OOS Sharpe difference must be < this

    @classmethod
    def check_min_trades(cls, n_trades: int) -> ValidationResult:
        passed = n_trades >= cls.MIN_TRADES
        return ValidationResult(
            rule="min_trades",
            passed=passed,
            value=float(n_trades),
            threshold=float(cls.MIN_TRADES),
            message=f"{n_trades} trades {'≥' if passed else '<'} required {cls.MIN_TRADES}",
        )

    @classmethod
    def check_oos_sharpe(cls, oos_sharpe: float) -> ValidationResult:
        passed = oos_sharpe >= cls.OOS_SHARPE_MIN
        return ValidationResult(
            rule="oos_sharpe",
            passed=passed,
            value=oos_sharpe,
            threshold=cls.OOS_SHARPE_MIN,
            message=f"OOS Sharpe {oos_sharpe:.3f} {'≥' if passed else '<'} {cls.OOS_SHARPE_MIN}",
        )

    @classmethod
    def check_wf_consistency(cls, wf_sharpes: List[float]) -> ValidationResult:
        if not wf_sharpes:
            return ValidationResult(
                rule="wf_consistency", passed=False, value=0.0,
                threshold=cls.WF_CONSISTENCY_MIN, message="No walk-forward windows",
            )
        consistency = sum(1 for s in wf_sharpes if s > 0) / len(wf_sharpes)
        passed = consistency >= cls.WF_CONSISTENCY_MIN
        return ValidationResult(
            rule="wf_consistency",
            passed=passed,
            value=consistency,
            threshold=cls.WF_CONSISTENCY_MIN,
            message=f"WF consistency {consistency:.1%} {'≥' if passed else '<'} {cls.WF_CONSISTENCY_MIN:.1%}",
        )

    @classmethod
    def check_regime_coverage(cls, regimes_traded: set) -> ValidationResult:
        n = len(regimes_traded)
        passed = n >= cls.REGIME_COVERAGE_MIN
        return ValidationResult(
            rule="regime_coverage",
            passed=passed,
            value=float(n),
            threshold=float(cls.REGIME_COVERAGE_MIN),
            message=f"Traded in {n} regimes: {sorted(regimes_traded)} (need ≥{cls.REGIME_COVERAGE_MIN})",
        )

    @classmethod
    def check_lookahead(cls, n_violations: int) -> ValidationResult:
        passed = n_violations == cls.LOOKAHEAD_VIOLATIONS_MAX
        return ValidationResult(
            rule="lookahead_violations",
            passed=passed,
            value=float(n_violations),
            threshold=float(cls.LOOKAHEAD_VIOLATIONS_MAX),
            message=f"{n_violations} lookahead violations (must be 0)",
        )

    @classmethod
    def check_is_oos_gap(cls, is_sharpe: float, oos_sharpe: float) -> ValidationResult:
        gap = is_sharpe - oos_sharpe
        passed = gap < cls.IS_OOS_SHARPE_GAP_MAX
        return ValidationResult(
            rule="is_oos_sharpe_gap",
            passed=passed,
            value=round(gap, 4),
            threshold=cls.IS_OOS_SHARPE_GAP_MAX,
            message=f"IS-OOS Sharpe gap {gap:.3f} ({'<' if passed else '≥'} {cls.IS_OOS_SHARPE_GAP_MAX})",
        )

    @classmethod
    def run_all(
        cls,
        n_trades: int,
        oos_sharpe: float,
        is_sharpe: float,
        wf_sharpes: List[float],
        regimes_traded: set,
        n_lookahead_violations: int,
    ) -> AntiOverfitReport:
        report = AntiOverfitReport()
        report.results.extend([
            cls.check_min_trades(n_trades),
            cls.check_oos_sharpe(oos_sharpe),
            cls.check_wf_consistency(wf_sharpes),
            cls.check_regime_coverage(regimes_traded),
            cls.check_lookahead(n_lookahead_violations),
            cls.check_is_oos_gap(is_sharpe, oos_sharpe),
        ])
        return report


# ── Survivorship bias detection ───────────────────────────────────────────────

def survivorship_bias_detection(
    universe_symbols: List[str],
    delisted_symbols: Optional[List[str]] = None,
    backtest_start: Optional[str] = None,
) -> Dict:
    """
    Detect survivorship bias: checks if the backtest universe includes delisted symbols.

    In practice, historical backtests should include symbols that were
    listed AND delisted during the test period, not just survivors.

    Returns a dict with bias score and recommendations.
    """
    delisted = set(delisted_symbols or [])
    universe = set(universe_symbols)
    missing_delisted = delisted - universe

    bias_score = len(missing_delisted) / max(len(delisted), 1)
    has_bias = bias_score > 0.0

    return {
        "has_survivorship_bias": has_bias,
        "bias_score": round(bias_score, 3),
        "n_delisted_in_universe": len(delisted & universe),
        "n_delisted_missing": len(missing_delisted),
        "missing_delisted_symbols": sorted(missing_delisted),
        "recommendation": (
            "Universe includes delisted symbols — lower survivorship bias"
            if not has_bias else
            f"WARNING: {len(missing_delisted)} delisted symbols excluded — "
            "performance may be upward biased. Include historical universe with delistings."
        ),
    }


# ── Data leakage detection ────────────────────────────────────────────────────

def data_leakage_check(
    signals: pd.Series,
    prices: pd.Series,
    lookahead_bars: int = 1,
) -> Dict:
    """
    Detect forward-looking data leakage by testing if signals have
    statistically significant correlation with FUTURE returns
    beyond the expected alpha horizon.

    signals: bar-aligned signal scores (e.g., ∈ [-1,+1])
    prices: price series aligned with signals
    lookahead_bars: intended holding period

    Returns suspicion score and details.
    """
    if len(signals) < 30 or len(prices) < 30:
        return {"n_violations": 0, "suspicion_score": 0.0, "message": "insufficient_data"}

    returns = prices.pct_change().fillna(0)
    aligned, _ = signals.align(returns, join="inner")
    ret_aligned = returns.reindex(aligned.index)

    violations = 0
    suspicion_scores = []

    for lag in range(1, min(6, len(aligned) // 10)):
        future_ret = ret_aligned.shift(-lag).dropna()
        sig_trimmed = aligned.iloc[: len(future_ret)]

        if len(sig_trimmed) < 10:
            continue

        # Spearman rank correlation
        from scipy.stats import spearmanr
        corr, pval = spearmanr(sig_trimmed.values, future_ret.values)

        if lag > lookahead_bars and abs(corr) > 0.3 and pval < 0.05:
            violations += 1
            suspicion_scores.append(abs(corr))

    suspicion_score = float(np.mean(suspicion_scores)) if suspicion_scores else 0.0

    return {
        "n_violations": violations,
        "suspicion_score": round(suspicion_score, 4),
        "has_leakage": violations > 0,
        "message": (
            f"LEAKAGE SUSPECTED: {violations} lags show significant future correlation"
            if violations > 0 else "No data leakage detected"
        ),
    }


def detect_lookahead_in_features(
    features: pd.DataFrame,
    prices: pd.Series,
    threshold_corr: float = 0.5,
) -> List[str]:
    """
    Screen feature columns for suspiciously high correlation with future returns.
    Returns list of suspicious feature names.
    """
    returns = prices.pct_change().shift(-1).fillna(0)   # next-bar returns
    suspicious = []

    for col in features.columns:
        feat = features[col].dropna()
        ret = returns.reindex(feat.index).fillna(0)
        if len(feat) < 20:
            continue
        try:
            from scipy.stats import pearsonr
            corr, pval = pearsonr(feat.values, ret.values)
            if abs(corr) > threshold_corr and pval < 0.01:
                suspicious.append(col)
        except Exception:
            pass

    return suspicious


# ── Walk-forward validation ───────────────────────────────────────────────────

def walk_forward_split(
    index: pd.DatetimeIndex,
    train_bars: int,
    test_bars: int,
    step_bars: Optional[int] = None,
) -> List[Tuple[pd.DatetimeIndex, pd.DatetimeIndex]]:
    """
    Generate walk-forward train/test splits.
    step_bars: how many bars to advance each window (default = test_bars → non-overlapping).
    Returns list of (train_index, test_index) tuples.
    """
    step = step_bars or test_bars
    splits = []
    start = 0
    while start + train_bars + test_bars <= len(index):
        train_idx = index[start: start + train_bars]
        test_idx = index[start + train_bars: start + train_bars + test_bars]
        splits.append((train_idx, test_idx))
        start += step
    return splits


# ── Purged cross-validation (anti-leakage) ────────────────────────────────────

def purged_cv_split(
    index: pd.DatetimeIndex,
    n_splits: int = 5,
    embargo_pct: float = 0.01,
) -> List[Tuple[pd.DatetimeIndex, pd.DatetimeIndex]]:
    """
    Purged k-fold cross-validation for financial time series.
    Removes observations within embargo_pct of test period from training set
    to prevent leakage through feature overlap.
    """
    n = len(index)
    fold_size = n // n_splits
    embargo_bars = max(1, int(n * embargo_pct))
    splits = []

    for k in range(n_splits):
        test_start = k * fold_size
        test_end = test_start + fold_size if k < n_splits - 1 else n
        test_idx = index[test_start:test_end]

        # Purge: exclude train observations that are too close to test period
        embargo_start = max(0, test_start - embargo_bars)
        train_mask = list(range(embargo_start)) + list(range(test_end + embargo_bars, n))
        if not train_mask:
            continue
        train_idx = index[train_mask]
        splits.append((train_idx, test_idx))

    return splits


# ── Combinatorial purged cross-validation ─────────────────────────────────────

def combinatorial_purged_cv(
    returns: pd.Series,
    n_splits: int = 6,
    n_test_splits: int = 2,
    embargo_pct: float = 0.01,
) -> List[Dict]:
    """
    CPCV (Marcos Lopez de Prado): generates multiple OOS paths by choosing
    n_test_splits of n_splits folds as test, training on the rest.
    Returns list of dicts with train/test DataFrames.
    """
    from itertools import combinations

    index = returns.index
    n = len(index)
    fold_size = n // n_splits
    embargo_bars = max(1, int(n * embargo_pct))

    fold_indices = []
    for k in range(n_splits):
        start = k * fold_size
        end = start + fold_size if k < n_splits - 1 else n
        fold_indices.append((start, end))

    paths = []
    for test_combo in combinations(range(n_splits), n_test_splits):
        test_mask = set()
        for k in test_combo:
            s, e = fold_indices[k]
            test_mask.update(range(s, e))

        # Purge train around test boundaries
        purged_mask = set()
        for k in test_combo:
            s, e = fold_indices[k]
            purged_mask.update(range(max(0, s - embargo_bars), min(n, e + embargo_bars)))

        train_mask = [i for i in range(n) if i not in test_mask and i not in purged_mask]
        test_list = sorted(test_mask)

        if not train_mask or not test_list:
            continue

        paths.append({
            "train": returns.iloc[train_mask],
            "test": returns.iloc[test_list],
            "test_folds": list(test_combo),
        })

    return paths


# ── Main anti-overfit engine ──────────────────────────────────────────────────

class AntiOverfitEngine:
    """
    Orchestrates all anti-overfit checks for a completed backtest.
    """

    def __init__(self):
        self.rules = MandatoryRules()

    def full_check(
        self,
        strategy_name: str,
        trades: pd.DataFrame,
        signals: pd.Series,
        prices: pd.Series,
        is_returns: pd.Series,
        oos_returns: pd.Series,
        wf_sharpes: List[float],
        regimes_traded: Optional[set] = None,
        universe: Optional[List[str]] = None,
        delisted: Optional[List[str]] = None,
    ) -> Dict:
        """
        Run all anti-overfit checks and return a full report dict.
        """
        from backend.backtester.metrics import sharpe

        n_trades = len(trades)
        is_sharpe = sharpe(is_returns.values) if len(is_returns) > 10 else 0.0
        oos_sharpe = sharpe(oos_returns.values) if len(oos_returns) > 10 else 0.0

        if regimes_traded is None:
            from backend.backtester.signal_engine import detect_regime
            regime_series = detect_regime(pd.concat([is_returns, oos_returns]))
            regimes_traded = set(regime_series.unique())

        leakage = data_leakage_check(signals, prices)
        survivorship = survivorship_bias_detection(universe or [], delisted or [])

        mandatory_report = MandatoryRules.run_all(
            n_trades=n_trades,
            oos_sharpe=oos_sharpe,
            is_sharpe=is_sharpe,
            wf_sharpes=wf_sharpes,
            regimes_traded=regimes_traded,
            n_lookahead_violations=leakage["n_violations"],
        )

        return {
            "strategy": strategy_name,
            "mandatory_rules": mandatory_report.summary(),
            "data_leakage": leakage,
            "survivorship_bias": survivorship,
            "is_sharpe": round(is_sharpe, 3),
            "oos_sharpe": round(oos_sharpe, 3),
            "n_trades": n_trades,
            "regimes_traded": sorted(regimes_traded),
            "wf_consistency": mandatory_report.results[2].value if len(mandatory_report.results) > 2 else 0.0,
            "overall_pass": mandatory_report.passed,
        }
