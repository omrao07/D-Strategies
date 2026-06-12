# backend/backtester/factor_model.py
"""
Factor model attribution, strategy capacity analysis, and strategy clustering.

Components:
  FactorModel        — 6-factor return decomposition (market, size, momentum,
                       quality, low-vol, reversal). Brinson attribution.
  CapacityAnalyzer   — finds AUM where market impact consumes 50% of alpha
  StrategyClusterer  — PCA + correlation clustering of 337 strategies
  BenchmarkComparer  — alpha/beta/IR vs NIFTY50 or any benchmark
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

# ── Factor definitions ────────────────────────────────────────────────────────

FACTOR_NAMES = [
    "market",       # excess return over risk-free (beta)
    "size",         # small-cap premium (SMB proxy)
    "momentum",     # 12-1 month momentum
    "low_vol",      # low-volatility anomaly
    "quality",      # earnings stability / profitability proxy
    "reversal",     # short-term mean reversion (1-month reversal)
]


@dataclass
class FactorExposures:
    """Per-strategy factor loadings and attribution."""
    strategy: str
    alpha_annualized: float = 0.0         # Jensen's alpha
    r_squared: float = 0.0
    loadings: Dict[str, float] = field(default_factory=dict)
    attribution: Dict[str, float] = field(default_factory=dict)  # % of return explained
    residual_return: float = 0.0          # unexplained return
    t_stats: Dict[str, float] = field(default_factory=dict)

    def summary(self) -> Dict:
        return {
            "strategy": self.strategy,
            "alpha_ann": round(self.alpha_annualized, 4),
            "r_squared": round(self.r_squared, 3),
            "loadings": {k: round(v, 3) for k, v in self.loadings.items()},
            "attribution_pct": {k: round(v * 100, 2) for k, v in self.attribution.items()},
        }


# ── Factor model ──────────────────────────────────────────────────────────────

class FactorModel:
    """
    6-factor linear model for return decomposition.

    Factors are constructed from the price/returns data directly
    (no Fama-French database needed). Uses rolling 252-bar windows
    to construct cross-sectional factors.

    Regression: R_i = alpha + beta_m*Rm + beta_s*SMB + beta_mo*MOM
                       + beta_lv*LowVol + beta_q*Quality + beta_rev*Rev + eps
    """

    def __init__(self, rf_annual: float = 0.065, periods_per_year: int = 252):
        self.rf_daily = rf_annual / periods_per_year
        self.periods_per_year = periods_per_year
        self._factors: Optional[pd.DataFrame] = None

    def build_factors(
        self,
        prices: pd.DataFrame,
        market_returns: Optional[pd.Series] = None,
    ) -> pd.DataFrame:
        """
        Build factor return series from a universe of prices.

        prices: DataFrame [T x symbols], daily close prices
        market_returns: optional pre-computed market index returns

        Returns DataFrame [T x 6 factors].
        """
        returns = prices.pct_change().fillna(0)
        T, N = returns.shape

        if market_returns is None:
            market_returns = returns.mean(axis=1)   # equal-weight market

        factors = pd.DataFrame(index=returns.index)

        # 1. Market (excess return)
        factors["market"] = market_returns - self.rf_daily

        # 2. Size (SMB proxy): bottom 30% minus top 30% by trailing 20d vol)
        vol_20 = returns.rolling(20, min_periods=5).std()
        factors["size"] = self._long_short_factor(returns, vol_20, high_is_long=False)

        # 3. Momentum (12-1 month, i.e., 252-21 bars)
        mom = prices.shift(21) / prices.shift(252) - 1.0
        factors["momentum"] = self._long_short_factor(returns, mom, high_is_long=True)

        # 4. Low-volatility (low vol outperforms)
        vol_252 = returns.rolling(252, min_periods=60).std()
        factors["low_vol"] = self._long_short_factor(returns, vol_252, high_is_long=False)

        # 5. Quality (low vol of returns as earnings stability proxy)
        vol_60 = returns.rolling(60, min_periods=20).std()
        factors["quality"] = self._long_short_factor(returns, vol_60, high_is_long=False)

        # 6. Reversal (1-month reversal)
        rev_1m = prices / prices.shift(21) - 1.0
        factors["reversal"] = self._long_short_factor(returns, rev_1m, high_is_long=False)

        self._factors = factors.fillna(0)
        return self._factors

    def _long_short_factor(
        self,
        returns: pd.DataFrame,
        signal: pd.DataFrame,
        high_is_long: bool = True,
        top_pct: float = 0.3,
    ) -> pd.Series:
        """Construct long-short factor: top_pct minus bottom_pct by signal."""
        n = max(1, int(len(returns.columns) * top_pct))
        result = []
        for i in range(len(returns)):
            sig_row = signal.iloc[i].dropna()
            if len(sig_row) < 4:
                result.append(0.0)
                continue
            sorted_syms = sig_row.sort_values(ascending=not high_is_long)
            longs = sorted_syms.index[:n]
            shorts = sorted_syms.index[-n:]
            ret_row = returns.iloc[i]
            long_ret = float(ret_row[longs].mean())
            short_ret = float(ret_row[shorts].mean())
            result.append(long_ret - short_ret)
        return pd.Series(result, index=returns.index)

    def attribute(
        self,
        strategy_returns: pd.Series,
        strategy_name: str = "",
    ) -> FactorExposures:
        """
        Run OLS regression of strategy_returns on factor returns.
        Returns FactorExposures with loadings, alpha, R².
        """
        if self._factors is None:
            raise RuntimeError("Call build_factors() first")

        common = strategy_returns.index.intersection(self._factors.index)
        if len(common) < 60:
            return FactorExposures(strategy=strategy_name)

        y = strategy_returns.loc[common].values
        X_df = self._factors.loc[common]
        X = np.column_stack([np.ones(len(X_df)), X_df.values])   # add intercept

        # OLS: beta = (X'X)^{-1} X'y
        try:
            XtX = X.T @ X
            Xty = X.T @ y
            beta = np.linalg.solve(XtX + np.eye(len(XtX)) * 1e-8, Xty)
        except np.linalg.LinAlgError:
            return FactorExposures(strategy=strategy_name)

        alpha_daily = beta[0]
        loadings = dict(zip(FACTOR_NAMES, beta[1:]))

        y_hat = X @ beta
        ss_res = float(np.sum((y - y_hat) ** 2))
        ss_tot = float(np.sum((y - y.mean()) ** 2))
        r2 = 1.0 - ss_res / max(ss_tot, 1e-12)

        # Standard errors for t-stats
        n, k = X.shape
        sigma2 = ss_res / max(n - k, 1)
        try:
            cov_beta = sigma2 * np.linalg.inv(XtX + np.eye(k) * 1e-8)
            se = np.sqrt(np.diag(cov_beta))
            t_stats = beta / (se + 1e-12)
        except Exception:
            t_stats = np.zeros(len(beta))

        factor_t_stats = dict(zip(FACTOR_NAMES, t_stats[1:]))

        # Attribution: what % of total variance is explained by each factor
        total_var = float(np.var(y)) + 1e-12
        attribution = {}
        for j, fname in enumerate(FACTOR_NAMES):
            factor_contribution = beta[j + 1] * float(np.cov(y, X_df.iloc[:, j])[0, 1])
            attribution[fname] = factor_contribution / total_var

        return FactorExposures(
            strategy=strategy_name,
            alpha_annualized=alpha_daily * self.periods_per_year,
            r_squared=max(0.0, r2),
            loadings=loadings,
            attribution=attribution,
            residual_return=float(alpha_daily * len(y)),
            t_stats=factor_t_stats,
        )

    def attribute_all(
        self,
        strategy_returns: Dict[str, pd.Series],
    ) -> Dict[str, FactorExposures]:
        """Attribute all strategies at once."""
        return {
            name: self.attribute(rets, name)
            for name, rets in strategy_returns.items()
        }


# ── Capacity analyzer ─────────────────────────────────────────────────────────

@dataclass
class CapacityResult:
    strategy: str
    alpha_daily: float
    capacity_inr: float        # AUM where impact cost = 50% of alpha
    capacity_usd: float        # same in USD (divide by ~83)
    turnover_daily_pct: float  # daily portfolio turnover
    impact_per_100cr: float    # basis points impact at 100Cr AUM
    recommendation: str

    def summary(self) -> Dict:
        return {
            "strategy": self.strategy,
            "alpha_daily_bps": round(self.alpha_daily * 10_000, 2),
            "capacity_inr_cr": round(self.capacity_inr / 1e7, 1),
            "capacity_usd_mn": round(self.capacity_usd / 1e6, 1),
            "turnover_daily_pct": round(self.turnover_daily_pct * 100, 2),
            "impact_per_100cr_bps": round(self.impact_per_100cr, 2),
            "recommendation": self.recommendation,
        }


class CapacityAnalyzer:
    """
    Estimates strategy capacity — the AUM level at which market impact
    consumes alpha.

    Uses the Almgren-Chriss model:
      impact_cost_daily = eta * sigma * sqrt(daily_turnover / ADV)

    Capacity = AUM where impact_cost = 0.5 * alpha_daily
    """

    def __init__(
        self,
        eta: float = 0.1,           # market impact parameter
        daily_sigma: float = 0.015,  # market daily vol (default 1.5%)
        adv_per_stock_cr: float = 50.0,  # avg daily volume per stock in Cr
        n_stocks: int = 10,          # stocks in portfolio
    ):
        self.eta = eta
        self.daily_sigma = daily_sigma
        self.adv_per_stock_cr = adv_per_stock_cr
        self.n_stocks = n_stocks
        self.adv_total_inr = adv_per_stock_cr * 1e7 * n_stocks  # total ADV in INR

    def analyze(
        self,
        strategy_name: str,
        daily_returns: pd.Series,
        turnover_series: Optional[pd.Series] = None,
    ) -> CapacityResult:
        """
        Estimate capacity for a single strategy.

        turnover_series: daily fractional turnover (if None, inferred from signals).
        """
        alpha_daily = float(daily_returns.mean())
        if alpha_daily <= 0:
            return CapacityResult(
                strategy=strategy_name,
                alpha_daily=alpha_daily,
                capacity_inr=0.0,
                capacity_usd=0.0,
                turnover_daily_pct=0.0,
                impact_per_100cr=0.0,
                recommendation="No positive alpha to protect",
            )

        # Estimate daily turnover if not provided
        if turnover_series is not None and len(turnover_series) > 0:
            turnover = float(turnover_series.mean())
        else:
            # Rough proxy from return autocorrelation (higher autocorr → lower turnover)
            autocorr = float(daily_returns.autocorr(1)) if len(daily_returns) > 10 else 0
            turnover = max(0.01, 0.2 * (1 - abs(autocorr)))

        # At AUM = X:
        #   daily_trade = X * turnover
        #   impact = eta * sigma * sqrt(daily_trade / ADV)
        # Set impact = 0.5 * alpha → solve for X
        # 0.5 * alpha = eta * sigma * sqrt(X * turnover / ADV)
        # X = ADV * (0.5 * alpha / (eta * sigma))^2 / turnover

        half_alpha = 0.5 * alpha_daily
        term = half_alpha / (self.eta * self.daily_sigma)
        capacity_inr = self.adv_total_inr * (term ** 2) / max(turnover, 1e-6)
        capacity_usd = capacity_inr / 83.0

        # Impact in bps at 100 Cr AUM
        aum_100cr = 100e7
        daily_trade = aum_100cr * turnover
        impact_100cr = self.eta * self.daily_sigma * math.sqrt(
            daily_trade / max(self.adv_total_inr, 1.0)
        ) * 10_000

        if capacity_inr > 5000e7:   # > 5000 Cr
            rec = "Scalable: suitable for large AIF/PMS"
        elif capacity_inr > 500e7:  # > 500 Cr
            rec = "Medium capacity: suitable for mid-size fund"
        elif capacity_inr > 50e7:   # > 50 Cr
            rec = "Low capacity: suitable for small fund / prop desk"
        else:
            rec = "Micro-cap / niche: keep AUM < 50 Cr"

        return CapacityResult(
            strategy=strategy_name,
            alpha_daily=alpha_daily,
            capacity_inr=capacity_inr,
            capacity_usd=capacity_usd,
            turnover_daily_pct=turnover,
            impact_per_100cr=float(impact_100cr),
            recommendation=rec,
        )

    def analyze_all(
        self,
        strategy_returns: Dict[str, pd.Series],
    ) -> pd.DataFrame:
        """Analyze capacity for all strategies, return sorted DataFrame."""
        results = []
        for name, rets in strategy_returns.items():
            result = self.analyze(name, rets)
            results.append(result.summary())
        if not results:
            return pd.DataFrame()
        df = pd.DataFrame(results).sort_values("capacity_inr_cr", ascending=False)
        return df.reset_index(drop=True)


# ── Strategy clusterer ────────────────────────────────────────────────────────

@dataclass
class ClusterResult:
    n_clusters: int
    n_unique_bets: int           # effective number of independent strategies
    clusters: Dict[int, List[str]]  # cluster_id → strategy names
    correlation_matrix: pd.DataFrame
    pca_variance_explained: List[float]
    redundant_pairs: List[Tuple[str, str, float]]  # (strat_a, strat_b, correlation)
    diversification_ratio: float   # 1 = fully diversified, 0 = all same

    def summary(self) -> Dict:
        return {
            "n_strategies": sum(len(v) for v in self.clusters.values()),
            "n_clusters": self.n_clusters,
            "n_unique_bets": self.n_unique_bets,
            "diversification_ratio": round(self.diversification_ratio, 3),
            "n_redundant_pairs": len(self.redundant_pairs),
            "cluster_sizes": {k: len(v) for k, v in self.clusters.items()},
            "top_redundant": [
                {"a": a, "b": b, "corr": round(c, 3)}
                for a, b, c in self.redundant_pairs[:10]
            ],
        }


class StrategyClusterer:
    """
    Identifies redundant strategies among all 337 using:
    1. Pairwise signal correlation matrix
    2. PCA to find effective number of independent bets
    3. DBSCAN / agglomerative clustering to group similar strategies
    """

    def __init__(
        self,
        high_corr_threshold: float = 0.75,
        min_history: int = 60,
    ):
        self.high_corr_threshold = high_corr_threshold
        self.min_history = min_history

    def cluster(
        self,
        signal_df: pd.DataFrame,   # [T x strategies] signal scores
    ) -> ClusterResult:
        """
        Cluster strategies by signal correlation.
        signal_df: DataFrame of strategy signals, columns = strategy names.
        """
        # Drop strategies with insufficient history
        valid = signal_df.dropna(axis=1, thresh=self.min_history)
        if valid.shape[1] < 2:
            return ClusterResult(
                n_clusters=1, n_unique_bets=valid.shape[1],
                clusters={0: list(valid.columns)},
                correlation_matrix=pd.DataFrame(),
                pca_variance_explained=[1.0],
                redundant_pairs=[],
                diversification_ratio=1.0,
            )

        corr = valid.fillna(0).corr()

        # Find highly correlated pairs
        redundant = []
        cols = list(corr.columns)
        for i in range(len(cols)):
            for j in range(i + 1, len(cols)):
                c = float(corr.iloc[i, j])
                if abs(c) >= self.high_corr_threshold:
                    redundant.append((cols[i], cols[j], c))
        redundant.sort(key=lambda x: abs(x[2]), reverse=True)

        # PCA for effective number of independent bets
        returns_mat = valid.fillna(0).values
        cov = np.cov(returns_mat.T)
        try:
            eigenvalues = np.linalg.eigvalsh(cov)[::-1]
            eigenvalues = np.maximum(eigenvalues, 0)
            total_var = eigenvalues.sum()
            var_explained = (eigenvalues / max(total_var, 1e-12)).tolist()
            # Effective number of bets (entropy-based)
            w = np.array(var_explained) + 1e-12
            w = w / w.sum()
            n_effective = math.exp(-float(np.sum(w * np.log(w))))
        except Exception:
            var_explained = [1.0]
            n_effective = float(valid.shape[1])

        # Simple agglomerative clustering via distance matrix
        clusters = self._agglomerate(corr, threshold=self.high_corr_threshold)
        len(clusters)

        # Diversification ratio
        # DR = (sum of individual vols) / portfolio_vol (equal weight)
        try:
            vols = returns_mat.std(axis=0)
            avg_vol = float(vols.mean())
            port_vol = float(np.sqrt(np.ones(len(cols)) @ cov @ np.ones(len(cols))) / len(cols))
            div_ratio = avg_vol / max(port_vol, 1e-12)
        except Exception:
            div_ratio = 1.0

        return ClusterResult(
            n_clusters=len(clusters),
            n_unique_bets=round(n_effective),
            clusters=clusters,
            correlation_matrix=corr,
            pca_variance_explained=var_explained[:20],
            redundant_pairs=redundant,
            diversification_ratio=min(div_ratio, 1.0),
        )

    def _agglomerate(
        self, corr: pd.DataFrame, threshold: float
    ) -> Dict[int, List[str]]:
        """Simple single-linkage clustering by correlation."""
        cols = list(corr.columns)
        labels = {col: i for i, col in enumerate(cols)}
        len(cols)

        # Merge pairs with correlation > threshold
        changed = True
        while changed:
            changed = False
            for i in range(len(cols)):
                for j in range(i + 1, len(cols)):
                    if abs(float(corr.iloc[i, j])) > threshold:
                        li = labels[cols[i]]
                        lj = labels[cols[j]]
                        if li != lj:
                            # Merge j's cluster into i's
                            for c in cols:
                                if labels[c] == lj:
                                    labels[c] = li
                            changed = True

        # Collect clusters
        clusters: Dict[int, List[str]] = {}
        for col, label in labels.items():
            if label not in clusters:
                clusters[label] = []
            clusters[label].append(col)

        # Re-index clusters 0, 1, 2, ...
        return {i: v for i, v in enumerate(clusters.values())}


# ── Benchmark comparer ────────────────────────────────────────────────────────

@dataclass
class BenchmarkStats:
    strategy: str
    benchmark: str
    alpha_annualized: float
    beta: float
    correlation: float
    information_ratio: float
    tracking_error_ann: float
    up_capture: float       # % of benchmark up-moves captured
    down_capture: float     # % of benchmark down-moves captured
    batting_average: float  # % of periods outperforming benchmark

    def summary(self) -> Dict:
        return {
            "strategy": self.strategy,
            "benchmark": self.benchmark,
            "alpha_ann_pct": round(self.alpha_annualized * 100, 2),
            "beta": round(self.beta, 3),
            "correlation": round(self.correlation, 3),
            "information_ratio": round(self.information_ratio, 3),
            "tracking_error_ann_pct": round(self.tracking_error_ann * 100, 2),
            "up_capture_pct": round(self.up_capture * 100, 1),
            "down_capture_pct": round(self.down_capture * 100, 1),
            "batting_average_pct": round(self.batting_average * 100, 1),
        }


class BenchmarkComparer:
    """Compare strategy returns against a benchmark (e.g., NIFTY50)."""

    def __init__(self, benchmark_name: str = "NIFTY50", rf_annual: float = 0.065):
        self.benchmark_name = benchmark_name
        self.rf_annual = rf_annual

    def compare(
        self,
        strategy_returns: pd.Series,
        benchmark_returns: pd.Series,
        strategy_name: str = "",
        periods_per_year: int = 252,
    ) -> BenchmarkStats:
        common = strategy_returns.index.intersection(benchmark_returns.index)
        if len(common) < 20:
            return BenchmarkStats(
                strategy=strategy_name, benchmark=self.benchmark_name,
                alpha_annualized=0.0, beta=1.0, correlation=0.0,
                information_ratio=0.0, tracking_error_ann=0.0,
                up_capture=1.0, down_capture=1.0, batting_average=0.5,
            )

        sr = strategy_returns.loc[common].values
        br = benchmark_returns.loc[common].values
        rf = self.rf_annual / periods_per_year

        # Beta
        cov_matrix = np.cov(sr, br)
        beta = float(cov_matrix[0, 1] / max(cov_matrix[1, 1], 1e-12))

        # Alpha (Jensen's)
        alpha_daily = float(sr.mean()) - rf - beta * (float(br.mean()) - rf)
        alpha_ann = alpha_daily * periods_per_year

        # Correlation
        corr = float(np.corrcoef(sr, br)[0, 1])

        # Tracking error and IR
        active_returns = sr - br
        te_daily = float(np.std(active_returns))
        te_ann = te_daily * math.sqrt(periods_per_year)
        ir = (float(active_returns.mean()) * periods_per_year) / max(te_ann, 1e-12)

        # Up/down capture
        up_mask = br > 0
        down_mask = br < 0
        up_capture = (float(sr[up_mask].mean()) / float(br[up_mask].mean())
                      if up_mask.sum() > 0 and abs(float(br[up_mask].mean())) > 1e-12 else 1.0)
        down_capture = (float(sr[down_mask].mean()) / float(br[down_mask].mean())
                        if down_mask.sum() > 0 and abs(float(br[down_mask].mean())) > 1e-12 else 1.0)

        # Batting average
        batting = float((sr > br).mean())

        return BenchmarkStats(
            strategy=strategy_name,
            benchmark=self.benchmark_name,
            alpha_annualized=alpha_ann,
            beta=beta,
            correlation=corr,
            information_ratio=ir,
            tracking_error_ann=te_ann,
            up_capture=up_capture,
            down_capture=down_capture,
            batting_average=batting,
        )

    def compare_all(
        self,
        strategy_returns: Dict[str, pd.Series],
        benchmark_returns: pd.Series,
        periods_per_year: int = 252,
    ) -> pd.DataFrame:
        rows = []
        for name, rets in strategy_returns.items():
            stats = self.compare(rets, benchmark_returns, name, periods_per_year)
            rows.append(stats.summary())
        if not rows:
            return pd.DataFrame()
        return pd.DataFrame(rows).sort_values("information_ratio", ascending=False).reset_index(drop=True)
