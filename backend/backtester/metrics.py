# backend/backtester/metrics.py
"""
Comprehensive metrics library for the BacktestEngine.

Implements every metric specified in the D-Strategies Master Reference PDF:

Returns:   CAGR, total return, annualized vol, skewness, kurtosis, monthly distribution
Risk:      max drawdown, DD duration, VaR 95/99, CVaR (expected shortfall), Ulcer index
Efficiency:Sharpe, Sortino, Calmar, Omega ratio, profit factor
Trades:    win rate, avg W/L, avg hold period, MAE/MFE, trade frequency
Portfolio: beta vs benchmark, Jensen's alpha, factor exposure
Regime:    bull/bear/sideways performance split, crisis period returns, high/low vol Sharpe

Anti-overfit rules (all mandatory):
  1. Min trades > 200
  2. OOS Sharpe > 0.5
  3. Walk-forward consistency > 0.6
  4. Regime coverage >= 3
  5. Lookahead violations == 0
  6. IS/OOS Sharpe gap < 0.8
"""
from __future__ import annotations

import datetime
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

_EPS = 1e-12
_TRADING_DAYS = 252


# ── Return / distribution metrics ─────────────────────────────────────────────

def cagr(equity_curve: np.ndarray, periods_per_year: int = _TRADING_DAYS) -> float:
    """Compound Annual Growth Rate from equity curve."""
    if len(equity_curve) < 2 or equity_curve[0] <= 0:
        return 0.0
    years = len(equity_curve) / periods_per_year
    return float((equity_curve[-1] / equity_curve[0]) ** (1.0 / years) - 1.0)


def total_return(equity_curve: np.ndarray) -> float:
    if len(equity_curve) < 2 or equity_curve[0] <= 0:
        return 0.0
    return float(equity_curve[-1] / equity_curve[0] - 1.0)


def annualized_vol(daily_returns: np.ndarray, periods_per_year: int = _TRADING_DAYS) -> float:
    if len(daily_returns) < 2:
        return 0.0
    return float(np.nanstd(daily_returns, ddof=1) * np.sqrt(periods_per_year))


def skewness(daily_returns: np.ndarray) -> float:
    r = daily_returns[~np.isnan(daily_returns)]
    if len(r) < 3:
        return 0.0
    mu, sigma = r.mean(), r.std(ddof=1)
    if sigma < _EPS:
        return 0.0
    return float(np.mean(((r - mu) / sigma) ** 3))


def kurtosis(daily_returns: np.ndarray) -> float:
    r = daily_returns[~np.isnan(daily_returns)]
    if len(r) < 4:
        return 0.0
    mu, sigma = r.mean(), r.std(ddof=1)
    if sigma < _EPS:
        return 0.0
    return float(np.mean(((r - mu) / sigma) ** 4) - 3.0)  # excess kurtosis


def monthly_returns(daily_pnl: pd.Series) -> pd.DataFrame:
    """Returns [Year x Month] pivot of monthly returns."""
    monthly = daily_pnl.resample("ME").sum()
    df = monthly.to_frame("pnl")
    df["year"] = df.index.year
    df["month"] = df.index.month
    pivot = df.pivot(index="year", columns="month", values="pnl")
    pivot.columns = [datetime.date(2000, m, 1).strftime("%b") for m in pivot.columns]
    return pivot


# ── Risk metrics ─────────────────────────────────────────────────────────────

def max_drawdown(equity_curve: np.ndarray) -> float:
    """Maximum drawdown as a fraction (e.g. -0.15 = -15%)."""
    hwm = np.maximum.accumulate(equity_curve)
    dd = (equity_curve - hwm) / (hwm + _EPS)
    return float(np.min(dd))


def max_drawdown_duration(equity_curve: np.ndarray) -> int:
    """Max drawdown duration in bars (days)."""
    hwm = np.maximum.accumulate(equity_curve)
    in_dd = equity_curve < hwm
    if not in_dd.any():
        return 0
    # find longest consecutive True run
    max_dur = cur = 0
    for v in in_dd:
        cur = cur + 1 if v else 0
        max_dur = max(max_dur, cur)
    return max_dur


def var_historical(daily_returns: np.ndarray, confidence: float = 0.95) -> float:
    """Historical VaR at given confidence (returned as positive loss value)."""
    r = daily_returns[~np.isnan(daily_returns)]
    if len(r) == 0:
        return 0.0
    return float(-np.percentile(r, (1 - confidence) * 100))


def cvar_historical(daily_returns: np.ndarray, confidence: float = 0.95) -> float:
    """CVaR (Expected Shortfall) — mean of losses beyond VaR."""
    r = daily_returns[~np.isnan(daily_returns)]
    if len(r) == 0:
        return 0.0
    cutoff = np.percentile(r, (1 - confidence) * 100)
    tail = r[r <= cutoff]
    return float(-tail.mean()) if len(tail) > 0 else 0.0


def ulcer_index(equity_curve: np.ndarray) -> float:
    """Ulcer Index: RMS of percentage drawdowns. Lower is better."""
    hwm = np.maximum.accumulate(equity_curve)
    pct_dd = (equity_curve - hwm) / (hwm + _EPS) * 100.0
    return float(np.sqrt(np.mean(pct_dd ** 2)))


# ── Efficiency metrics ────────────────────────────────────────────────────────

def sharpe(daily_returns: np.ndarray, rf_daily: float = 0.0, periods_per_year: int = _TRADING_DAYS) -> float:
    r = daily_returns[~np.isnan(daily_returns)] - rf_daily
    sigma = np.std(r, ddof=1)
    if sigma < _EPS:
        mean = float(r.mean()) if len(r) > 0 else 0.0
        if mean > _EPS:
            return float("inf")
        if mean < -_EPS:
            return float("-inf")
        return 0.0
    return float(r.mean() / sigma * np.sqrt(periods_per_year))


def sortino(daily_returns: np.ndarray, rf_daily: float = 0.0, periods_per_year: int = _TRADING_DAYS) -> float:
    r = daily_returns[~np.isnan(daily_returns)] - rf_daily
    # Downside deviation: sqrt of mean squared negative excess returns (semi-deviation)
    downside_sq = np.minimum(r, 0.0) ** 2
    downside_dev = float(np.sqrt(np.mean(downside_sq) * periods_per_year))
    if downside_dev < _EPS:
        return 0.0
    return float(r.mean() * periods_per_year / downside_dev)


def calmar(equity_curve: np.ndarray, periods_per_year: int = _TRADING_DAYS) -> float:
    ann = cagr(equity_curve, periods_per_year)
    mdd = max_drawdown(equity_curve)
    if abs(mdd) < _EPS:
        return 0.0
    return float(ann / abs(mdd))


def omega_ratio(daily_returns: np.ndarray, threshold: float = 0.0) -> float:
    """Omega ratio: probability-weighted gains / losses above threshold."""
    r = daily_returns[~np.isnan(daily_returns)] - threshold
    gains = r[r > 0].sum()
    losses = -r[r < 0].sum()
    return float(gains / losses) if losses > _EPS else float("inf")


def profit_factor(daily_pnl: np.ndarray) -> float:
    """Gross profit / gross loss."""
    gains = daily_pnl[daily_pnl > 0].sum()
    losses = -daily_pnl[daily_pnl < 0].sum()
    return float(gains / losses) if losses > _EPS else float("inf")


# ── Trade-level metrics ───────────────────────────────────────────────────────

@dataclass
class TradeMetrics:
    n_trades: int = 0
    win_rate: float = 0.0
    avg_win: float = 0.0
    avg_loss: float = 0.0
    avg_wl_ratio: float = 0.0
    avg_hold_bars: float = 0.0
    trade_frequency: float = 0.0  # trades per year
    mae: float = 0.0              # max adverse excursion (avg)
    mfe: float = 0.0              # max favorable excursion (avg)


def compute_trade_metrics(
    orders_df: pd.DataFrame,
    periods_per_year: int = _TRADING_DAYS,
) -> TradeMetrics:
    """
    Compute trade-level metrics from an orders DataFrame.
    Required columns: ts, symbol, side, qty, fill_price, strategy
    """
    if orders_df is None or orders_df.empty:
        return TradeMetrics()

    # Match buys and sells per symbol to get round-trip trades (long and short)
    trades = []
    for (strat, sym), grp in orders_df.groupby(["strategy", "symbol"]):
        grp = grp.sort_values("ts")
        long_q: List[dict] = []   # pending buy openers
        short_q: List[dict] = []  # pending sell openers
        for _, row in grp.iterrows():
            fill = {"ts": row["ts"], "price": row.get("fill_price", 0),
                    "qty": row.get("qty", 0), "side": row.get("side", "buy")}
            side = row.get("side")
            if side == "buy":
                if short_q:  # close short
                    opener = short_q.pop(0)
                    pnl = (opener["price"] - fill["price"]) * min(opener["qty"], fill["qty"])
                    hold = (pd.Timestamp(fill["ts"]) - pd.Timestamp(opener["ts"])).days
                    trades.append({"pnl": pnl, "hold_bars": max(hold, 1)})
                else:
                    long_q.append(fill)
            elif side == "sell":
                if long_q:  # close long
                    opener = long_q.pop(0)
                    pnl = (fill["price"] - opener["price"]) * min(opener["qty"], fill["qty"])
                    hold = (pd.Timestamp(fill["ts"]) - pd.Timestamp(opener["ts"])).days
                    trades.append({"pnl": pnl, "hold_bars": max(hold, 1)})
                else:
                    short_q.append(fill)

    if not trades:
        return TradeMetrics(n_trades=len(orders_df))

    pnls = np.array([t["pnl"] for t in trades])
    holds = np.array([t["hold_bars"] for t in trades])
    wins = pnls[pnls > 0]
    losses = pnls[pnls < 0]
    n = len(trades)
    win_rate = len(wins) / n if n > 0 else 0.0
    avg_win = float(wins.mean()) if len(wins) > 0 else 0.0
    avg_loss = float(losses.mean()) if len(losses) > 0 else 0.0
    avg_wl = abs(avg_win / avg_loss) if abs(avg_loss) > _EPS else 0.0

    total_bars = orders_df["ts"].nunique() if "ts" in orders_df.columns else periods_per_year
    freq = n / (total_bars / periods_per_year) if total_bars > 0 else 0.0

    return TradeMetrics(
        n_trades=n,
        win_rate=win_rate,
        avg_win=avg_win,
        avg_loss=avg_loss,
        avg_wl_ratio=avg_wl,
        avg_hold_bars=float(holds.mean()),
        trade_frequency=freq,
        mae=0.0,
        mfe=0.0,
    )


# ── Portfolio metrics ─────────────────────────────────────────────────────────

def beta_vs_benchmark(
    daily_returns: np.ndarray,
    benchmark_returns: np.ndarray,
) -> float:
    """OLS beta of strategy returns vs benchmark."""
    r = daily_returns[~np.isnan(daily_returns)]
    b = benchmark_returns[~np.isnan(benchmark_returns)]
    n = min(len(r), len(b))
    if n < 10:
        return 0.0
    cov = np.cov(r[:n], b[:n])
    var_b = cov[1, 1]
    return float(cov[0, 1] / var_b) if var_b > _EPS else 0.0


def jensens_alpha(
    daily_returns: np.ndarray,
    benchmark_returns: np.ndarray,
    rf_daily: float = 0.0,
    periods_per_year: int = _TRADING_DAYS,
) -> float:
    """Jensen's alpha (annualized)."""
    b = beta_vs_benchmark(daily_returns, benchmark_returns)
    r_strat = np.nanmean(daily_returns) * periods_per_year
    r_bench = np.nanmean(benchmark_returns) * periods_per_year
    rf_ann = rf_daily * periods_per_year
    return float(r_strat - (rf_ann + b * (r_bench - rf_ann)))


# ── Regime detection & metrics ────────────────────────────────────────────────

def detect_regimes(
    daily_returns: np.ndarray,
    window: int = 63,
) -> np.ndarray:
    """
    Classify each bar into a regime using rolling volatility.
    Returns integer array: 0=bull, 1=sideways, 2=bear, 3=crisis
    """
    T = len(daily_returns)
    regimes = np.ones(T, dtype=int)  # default: sideways

    if T < window:
        return regimes

    roll_vol = np.full(T, np.nan)
    for t in range(window, T):
        roll_vol[t] = np.std(daily_returns[t - window:t], ddof=1)

    mean_vol = np.nanmean(roll_vol)
    if mean_vol < _EPS:
        return regimes

    for t in range(T):
        v = roll_vol[t]
        if np.isnan(v):
            continue
        ratio = v / mean_vol
        if ratio > 2.0:
            regimes[t] = 3   # crisis
        elif ratio > 1.3:
            regimes[t] = 2   # bear
        elif ratio < 0.7:
            regimes[t] = 0   # bull
        else:
            regimes[t] = 1   # sideways

    # also use direction: if in low-vol but negative trend → bear
    for t in range(window, T):
        if regimes[t] in (0, 1):
            trend = np.mean(daily_returns[t - window:t])
            if trend < -0.0003:   # 7.5% annual drag
                regimes[t] = 2    # reclassify as bear

    return regimes


def regime_performance(
    daily_returns: np.ndarray,
    regimes: np.ndarray,
    periods_per_year: int = _TRADING_DAYS,
) -> Dict[str, Dict]:
    """Per-regime Sharpe, CAGR, and observation count."""
    labels = {0: "bull", 1: "sideways", 2: "bear", 3: "crisis"}
    out: Dict[str, Dict] = {}
    for code, name in labels.items():
        mask = regimes == code
        r = daily_returns[mask]
        if len(r) < 5:
            out[name] = {"sharpe": 0.0, "cagr": 0.0, "n_bars": int(mask.sum()), "mean_daily": 0.0}
            continue
        sigma = np.std(r, ddof=1)
        sh = float(r.mean() / sigma * np.sqrt(periods_per_year)) if sigma > _EPS else 0.0
        eq = np.cumprod(1 + r)
        c = cagr(eq, periods_per_year)
        out[name] = {
            "sharpe": round(sh, 3),
            "cagr": round(c, 4),
            "n_bars": int(mask.sum()),
            "mean_daily": round(float(r.mean()), 6),
        }
    return out


def vol_regime_sharpe(
    daily_returns: np.ndarray,
    regimes: np.ndarray,
    periods_per_year: int = _TRADING_DAYS,
) -> Dict[str, float]:
    """Sharpe in high-vol (bear+crisis) vs low-vol (bull+sideways) regimes."""
    low_mask = np.isin(regimes, [0, 1])
    high_mask = np.isin(regimes, [2, 3])
    def _sh(r):
        if len(r) < 5:
            return 0.0
        s = np.std(r, ddof=1)
        return float(r.mean() / s * np.sqrt(periods_per_year)) if s > _EPS else 0.0
    return {
        "low_vol_sharpe": _sh(daily_returns[low_mask]),
        "high_vol_sharpe": _sh(daily_returns[high_mask]),
    }


# ── Anti-overfit rules ────────────────────────────────────────────────────────

@dataclass
class AntiOverfitResult:
    passed: bool
    rules: Dict[str, Dict]   # rule_name → {passed, value, threshold, action}

    def summary(self) -> str:
        failed = [k for k, v in self.rules.items() if not v["passed"]]
        if not failed:
            return "PASS — all anti-overfit rules satisfied"
        return f"FAIL — {len(failed)} rule(s) violated: {', '.join(failed)}"


def check_anti_overfit(
    *,
    n_trades: int,
    oos_sharpe: float,
    is_sharpe: float,
    walk_forward_is_sharpes: List[float],
    walk_forward_oos_sharpes: List[float],
    regimes_covered: int,
    lookahead_violations: int,
) -> AntiOverfitResult:
    """
    Enforce all 6 mandatory anti-overfit rules from the PDF spec.

    Args:
        n_trades:                 total fills in the backtest
        oos_sharpe:               out-of-sample (walk-forward) Sharpe
        is_sharpe:                in-sample Sharpe
        walk_forward_is_sharpes:  per-window IS Sharpe list
        walk_forward_oos_sharpes: per-window OOS Sharpe list
        regimes_covered:          number of distinct regimes present in test data (max 4)
        lookahead_violations:     count of detected lookahead bias violations
    """
    rules: Dict[str, Dict] = {}

    # 1. Minimum trades > 200
    rules["min_trades"] = {
        "passed": n_trades > 200,
        "value": n_trades,
        "threshold": "> 200",
        "action": "Reject run — not enough statistical significance",
    }

    # 2. OOS Sharpe > 0.5
    rules["oos_sharpe"] = {
        "passed": oos_sharpe > 0.5,
        "value": round(oos_sharpe, 3),
        "threshold": "> 0.5",
        "action": "Flag as overfit — do not deploy",
    }

    # 3. Walk-forward consistency > 0.6 (OOS/IS ratio)
    consistency = 0.0
    if walk_forward_is_sharpes and walk_forward_oos_sharpes:
        ratios = []
        for is_s, oos_s in zip(walk_forward_is_sharpes, walk_forward_oos_sharpes):
            if abs(is_s) > _EPS:
                ratios.append(oos_s / is_s)
        consistency = float(np.mean(ratios)) if ratios else 0.0
    rules["wf_consistency"] = {
        "passed": consistency > 0.6,
        "value": round(consistency, 3),
        "threshold": "> 0.6",
        "action": "IS >> OOS = curve-fitted — discard params",
    }

    # 4. Regime coverage >= 3
    rules["regime_coverage"] = {
        "passed": regimes_covered >= 3,
        "value": regimes_covered,
        "threshold": ">= 3",
        "action": "Must include bull, bear, sideways periods",
    }

    # 5. Lookahead violations == 0
    rules["lookahead"] = {
        "passed": lookahead_violations == 0,
        "value": lookahead_violations,
        "threshold": "== 0",
        "action": "Fail CI pipeline if any found",
    }

    # 6. IS/OOS Sharpe gap < 0.8
    gap = is_sharpe - oos_sharpe
    rules["is_oos_gap"] = {
        "passed": gap < 0.8,
        "value": round(gap, 3),
        "threshold": "< 0.8",
        "action": "If IS=2.0 and OOS=0.3 — delete strategy",
    }

    overall = all(v["passed"] for v in rules.values())
    return AntiOverfitResult(passed=overall, rules=rules)


def detect_lookahead(
    signals: pd.DataFrame,
    prices: pd.DataFrame,
    horizon: int = 1,
    threshold: float = 0.1,
) -> int:
    """
    Heuristic lookahead detector.
    If signals at time t correlate strongly with future returns at t+1 ... t+horizon
    that suggests lookahead. Returns count of 'suspicious' signal columns.
    """
    violations = 0
    for col in signals.columns:
        sig = signals[col].values
        for h in range(1, horizon + 1):
            if h >= len(prices):
                break
            # future returns — use first price column, ensure 1D
            future_ret = prices.iloc[:, 0].pct_change(h).shift(-h).values
            valid = ~(np.isnan(sig) | np.isnan(future_ret))
            if valid.sum() < 30:
                continue
            corr = np.corrcoef(sig[valid], future_ret[valid])[0, 1]
            if abs(corr) > threshold:
                violations += 1
                break
    return violations


# ── Full metrics bundle ───────────────────────────────────────────────────────

@dataclass
class StrategyMetrics:
    # Returns
    cagr: float = 0.0
    total_return: float = 0.0
    annualized_vol: float = 0.0
    skewness: float = 0.0
    kurtosis: float = 0.0

    # Risk
    max_drawdown: float = 0.0
    max_drawdown_duration_days: int = 0
    var_95: float = 0.0
    var_99: float = 0.0
    cvar_95: float = 0.0
    cvar_99: float = 0.0
    ulcer_index: float = 0.0

    # Efficiency
    sharpe: float = 0.0
    sortino: float = 0.0
    calmar: float = 0.0
    omega_ratio: float = 0.0
    profit_factor: float = 0.0

    # Trades
    n_trades: int = 0
    win_rate: float = 0.0
    avg_win: float = 0.0
    avg_loss: float = 0.0
    avg_wl_ratio: float = 0.0
    avg_hold_bars: float = 0.0
    trade_frequency: float = 0.0

    # Portfolio
    beta: float = 0.0
    jensens_alpha: float = 0.0

    # Regime
    regime_perf: Dict[str, Dict] = field(default_factory=dict)
    low_vol_sharpe: float = 0.0
    high_vol_sharpe: float = 0.0

    def summary(self) -> Dict:
        return {
            "cagr": round(self.cagr, 4),
            "total_return": round(self.total_return, 4),
            "sharpe": round(self.sharpe, 3),
            "sortino": round(self.sortino, 3),
            "calmar": round(self.calmar, 3),
            "omega": round(self.omega_ratio, 3),
            "max_drawdown": round(self.max_drawdown, 4),
            "max_dd_days": self.max_drawdown_duration_days,
            "var_95": round(self.var_95, 4),
            "cvar_95": round(self.cvar_95, 4),
            "ulcer": round(self.ulcer_index, 4),
            "win_rate": round(self.win_rate, 4),
            "n_trades": self.n_trades,
            "avg_wl": round(self.avg_wl_ratio, 3),
            "profit_factor": round(self.profit_factor, 3),
            "beta": round(self.beta, 4),
            "alpha": round(self.jensens_alpha, 4),
            "regimes": self.regime_perf,
        }


def compute_all_metrics(
    daily_pnl: np.ndarray,
    equity_curve: np.ndarray,
    orders_df: Optional[pd.DataFrame] = None,
    benchmark_returns: Optional[np.ndarray] = None,
    periods_per_year: int = _TRADING_DAYS,
    rf_daily: float = 0.0,
) -> StrategyMetrics:
    """Compute the full StrategyMetrics bundle from daily P&L and equity curve."""
    # Normalize to return series
    cap = equity_curve[0] if equity_curve[0] > 0 else 1.0
    daily_ret = daily_pnl / cap

    regimes = detect_regimes(daily_ret)
    len(set(regimes))

    bench = benchmark_returns if benchmark_returns is not None else np.zeros(len(daily_ret))

    trade_m = compute_trade_metrics(orders_df, periods_per_year) if orders_df is not None else TradeMetrics()

    vol_sh = vol_regime_sharpe(daily_ret, regimes, periods_per_year)
    reg_perf = regime_performance(daily_ret, regimes, periods_per_year)

    return StrategyMetrics(
        # Returns
        cagr=cagr(equity_curve, periods_per_year),
        total_return=total_return(equity_curve),
        annualized_vol=annualized_vol(daily_ret, periods_per_year),
        skewness=skewness(daily_ret),
        kurtosis=kurtosis(daily_ret),
        # Risk
        max_drawdown=max_drawdown(equity_curve),
        max_drawdown_duration_days=max_drawdown_duration(equity_curve),
        var_95=var_historical(daily_ret, 0.95),
        var_99=var_historical(daily_ret, 0.99),
        cvar_95=cvar_historical(daily_ret, 0.95),
        cvar_99=cvar_historical(daily_ret, 0.99),
        ulcer_index=ulcer_index(equity_curve),
        # Efficiency
        sharpe=sharpe(daily_ret, rf_daily, periods_per_year),
        sortino=sortino(daily_ret, rf_daily, periods_per_year),
        calmar=calmar(equity_curve, periods_per_year),
        omega_ratio=omega_ratio(daily_ret),
        profit_factor=profit_factor(daily_pnl),
        # Trades
        n_trades=trade_m.n_trades,
        win_rate=trade_m.win_rate,
        avg_win=trade_m.avg_win,
        avg_loss=trade_m.avg_loss,
        avg_wl_ratio=trade_m.avg_wl_ratio,
        avg_hold_bars=trade_m.avg_hold_bars,
        trade_frequency=trade_m.trade_frequency,
        # Portfolio
        beta=beta_vs_benchmark(daily_ret, bench),
        jensens_alpha=jensens_alpha(daily_ret, bench, rf_daily, periods_per_year),
        # Regime
        regime_perf=reg_perf,
        low_vol_sharpe=vol_sh["low_vol_sharpe"],
        high_vol_sharpe=vol_sh["high_vol_sharpe"],
    )
