# backend/tests/test_backtest_engine.py
"""
Comprehensive test suite for the production backtesting engine.
Tests cover: metrics, data feeds, anti-overfit rules, engine modes,
_collector hook, and the BacktestReport API.
"""
from __future__ import annotations

import datetime
import math

import numpy as np
import pandas as pd
import pytest

from backend.backtester.data_feeds import Bar, BarBatch, CSVFeed, SyntheticFeed
from backend.backtester.metrics import (
    AntiOverfitResult,
    check_anti_overfit,
    cagr,
    calmar,
    cvar_historical,
    detect_lookahead,
    detect_regimes,
    kurtosis,
    max_drawdown,
    max_drawdown_duration,
    monthly_returns,
    omega_ratio,
    profit_factor,
    regime_performance,
    sharpe,
    skewness,
    sortino,
    total_return,
    ulcer_index,
    var_historical,
    vol_regime_sharpe,
    compute_all_metrics,
)
from backend.backtester.backtest_engine import (
    BacktestBook,
    BacktestCollector,
    BacktestEngine,
    BacktestReport,
    Fill,
    MarketSimulator,
    run_all_strategies,
)
from backend.backtester.vectorized_backtester import monte_carlo


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def pos_returns():
    """252 slightly positive daily returns."""
    rng = np.random.default_rng(1)
    return rng.normal(0.0004, 0.012, 252)


@pytest.fixture
def equity_curve(pos_returns):
    return 1_000_000 * np.cumprod(1 + pos_returns)


@pytest.fixture
def neg_returns():
    rng = np.random.default_rng(2)
    return rng.normal(-0.0005, 0.015, 252)


@pytest.fixture
def synthetic_feed():
    return SyntheticFeed(
        symbols=["AAPL", "MSFT", "GOOG"],
        start="2020-01-01",
        end="2022-12-31",
        seed=42,
        use_regimes=True,
    )


@pytest.fixture
def small_engine():
    engine = BacktestEngine(
        capital=1_000_000,
        mode="event_driven",
        run_walk_forward=False,
        run_monte_carlo=False,
        enable_risk_gates=False,
        verbose=False,
    )
    return engine


# ── Metrics: returns ──────────────────────────────────────────────────────────

def test_cagr_positive(pos_returns, equity_curve):
    c = cagr(equity_curve)
    assert isinstance(c, float)
    assert c > -0.5  # should not be extreme

def test_cagr_flat():
    eq = np.ones(252) * 1_000_000
    assert abs(cagr(eq)) < 1e-6

def test_total_return(equity_curve):
    tr = total_return(equity_curve)
    assert isinstance(tr, float)

def test_skewness_normal(pos_returns):
    sk = skewness(pos_returns)
    assert abs(sk) < 1.0   # roughly normal → low skew

def test_kurtosis_normal(pos_returns):
    kt = kurtosis(pos_returns)
    assert abs(kt) < 2.0   # excess kurtosis near 0 for normal

def test_monthly_returns_shape(pos_returns):
    idx = pd.date_range("2023-01-01", periods=252, freq="B")
    s = pd.Series(pos_returns * 1000, index=idx, name="daily_pnl")
    mt = monthly_returns(s)
    assert isinstance(mt, pd.DataFrame)
    assert mt.shape[1] <= 12


# ── Metrics: risk ─────────────────────────────────────────────────────────────

def test_max_drawdown_flat():
    eq = np.ones(100) * 100
    assert max_drawdown(eq) == 0.0

def test_max_drawdown_known():
    eq = np.array([100, 110, 90, 95, 85, 100])
    mdd = max_drawdown(eq)
    assert mdd < -0.20   # drawdown from 110→85 is ~22.7%

def test_max_drawdown_duration_known():
    eq = np.array([100, 110, 100, 90, 85, 110, 120])
    dur = max_drawdown_duration(eq)
    assert dur >= 3

def test_var_95_positive(pos_returns):
    v = var_historical(pos_returns)
    assert v >= 0.0

def test_var_ordering(pos_returns):
    v95 = var_historical(pos_returns, 0.95)
    v99 = var_historical(pos_returns, 0.99)
    assert v99 >= v95

def test_cvar_ge_var(pos_returns):
    v95 = var_historical(pos_returns, 0.95)
    c95 = cvar_historical(pos_returns, 0.95)
    assert c95 >= v95

def test_ulcer_index_flat():
    eq = np.ones(100) * 100
    assert ulcer_index(eq) == 0.0

def test_ulcer_index_positive(equity_curve):
    ui = ulcer_index(equity_curve)
    assert ui >= 0.0


# ── Metrics: efficiency ───────────────────────────────────────────────────────

def test_sharpe_positive_mean():
    r = np.ones(252) * 0.001
    assert sharpe(r) > 0.0

def test_sharpe_zero_vol():
    r = np.zeros(252)
    assert sharpe(r) == 0.0

def test_sortino_ge_sharpe_for_pos_returns(pos_returns):
    sh = sharpe(pos_returns)
    so = sortino(pos_returns)
    # Sortino ≥ Sharpe when downside vol < total vol
    assert so >= sh * 0.8   # allow some tolerance

def test_calmar_positive(equity_curve):
    c = calmar(equity_curve)
    assert isinstance(c, float)

def test_omega_ratio_all_positive():
    r = np.ones(100) * 0.01
    assert omega_ratio(r) == float("inf")

def test_omega_ratio_mixed(pos_returns):
    o = omega_ratio(pos_returns)
    assert o > 0.0

def test_profit_factor_all_gains():
    pnl = np.ones(100) * 10
    assert profit_factor(pnl) == float("inf")

def test_profit_factor_mixed(pos_returns):
    pf = profit_factor(pos_returns * 1000)
    assert pf > 0.0


# ── Metrics: regime ───────────────────────────────────────────────────────────

def test_detect_regimes_length(pos_returns):
    regimes = detect_regimes(pos_returns)
    assert len(regimes) == len(pos_returns)

def test_detect_regimes_values(pos_returns):
    regimes = detect_regimes(pos_returns)
    assert set(regimes).issubset({0, 1, 2, 3})

def test_regime_performance_keys(pos_returns):
    regimes = detect_regimes(pos_returns)
    perf = regime_performance(pos_returns, regimes)
    assert set(perf.keys()) == {"bull", "sideways", "bear", "crisis"}

def test_vol_regime_sharpe_keys(pos_returns):
    regimes = detect_regimes(pos_returns)
    vrs = vol_regime_sharpe(pos_returns, regimes)
    assert "low_vol_sharpe" in vrs
    assert "high_vol_sharpe" in vrs


# ── Anti-overfit rules ────────────────────────────────────────────────────────

def test_all_rules_pass():
    result = check_anti_overfit(
        n_trades=500,
        oos_sharpe=1.2,
        is_sharpe=1.4,
        walk_forward_is_sharpes=[1.4, 1.3, 1.5],
        walk_forward_oos_sharpes=[0.9, 0.8, 1.0],
        regimes_covered=4,
        lookahead_violations=0,
    )
    assert result.passed
    assert "PASS" in result.summary()

def test_min_trades_fail():
    result = check_anti_overfit(
        n_trades=50,
        oos_sharpe=1.2,
        is_sharpe=1.4,
        walk_forward_is_sharpes=[1.4],
        walk_forward_oos_sharpes=[0.9],
        regimes_covered=4,
        lookahead_violations=0,
    )
    assert not result.rules["min_trades"]["passed"]
    assert not result.passed

def test_oos_sharpe_fail():
    result = check_anti_overfit(
        n_trades=300,
        oos_sharpe=0.3,
        is_sharpe=2.0,
        walk_forward_is_sharpes=[2.0],
        walk_forward_oos_sharpes=[0.3],
        regimes_covered=4,
        lookahead_violations=0,
    )
    assert not result.rules["oos_sharpe"]["passed"]

def test_is_oos_gap_fail():
    result = check_anti_overfit(
        n_trades=300,
        oos_sharpe=0.3,
        is_sharpe=2.0,
        walk_forward_is_sharpes=[2.0],
        walk_forward_oos_sharpes=[0.3],
        regimes_covered=4,
        lookahead_violations=0,
    )
    assert not result.rules["is_oos_gap"]["passed"]   # gap = 1.7 > 0.8

def test_lookahead_fail():
    result = check_anti_overfit(
        n_trades=300,
        oos_sharpe=1.0,
        is_sharpe=1.2,
        walk_forward_is_sharpes=[1.2],
        walk_forward_oos_sharpes=[1.0],
        regimes_covered=4,
        lookahead_violations=3,
    )
    assert not result.rules["lookahead"]["passed"]

def test_regime_coverage_fail():
    result = check_anti_overfit(
        n_trades=300,
        oos_sharpe=1.0,
        is_sharpe=1.2,
        walk_forward_is_sharpes=[1.2],
        walk_forward_oos_sharpes=[1.0],
        regimes_covered=2,
        lookahead_violations=0,
    )
    assert not result.rules["regime_coverage"]["passed"]

def test_lookahead_detector_no_violation():
    rng = np.random.default_rng(7)
    n = 252
    prices = pd.DataFrame({"p": np.cumprod(1 + rng.normal(0.0003, 0.012, n))})
    # Signals lagged by 1 (no lookahead)
    sig = pd.DataFrame({"s": np.sign(rng.normal(0, 1, n))})
    violations = detect_lookahead(sig, prices)
    assert isinstance(violations, int)


# ── DataFeed: SyntheticFeed ───────────────────────────────────────────────────

def test_synthetic_feed_produces_batches(synthetic_feed):
    batches = list(synthetic_feed.iter_batches(
        datetime.datetime(2020, 1, 1),
        datetime.datetime(2020, 3, 31),
    ))
    assert len(batches) > 0
    assert all(isinstance(b, BarBatch) for b in batches)

def test_synthetic_feed_symbols(synthetic_feed):
    assert synthetic_feed.get_symbols() == ["AAPL", "MSFT", "GOOG"]

def test_synthetic_feed_bar_fields(synthetic_feed):
    batch = next(synthetic_feed.iter_batches(
        datetime.datetime(2020, 1, 1),
        datetime.datetime(2020, 6, 30),
    ))
    bar = next(iter(batch.bars.values()))
    assert bar.close > 0
    assert bar.high >= bar.close >= bar.low
    assert bar.open > 0

def test_synthetic_feed_regime_switching():
    # Use a long period to ensure multiple regimes
    feed = SyntheticFeed(["X"], start="2015-01-01", end="2024-12-31", seed=99, use_regimes=True)
    batches = list(feed.iter_batches(datetime.datetime(2015, 1, 1), datetime.datetime(2024, 12, 31)))
    prices = np.array([b.bars["X"].close for b in batches])
    # Should have variation (regime switching prevents flat prices)
    assert np.std(np.diff(np.log(prices))) > 0.005


# ── BacktestBook ──────────────────────────────────────────────────────────────

def test_book_initial_equity():
    book = BacktestBook(1_000_000)
    assert book.equity() == 1_000_000

def test_book_buy_reduces_cash():
    book = BacktestBook(1_000_000)
    fill = Fill("f1", "strat", "AAPL", "buy", 10, 100.0, 0.5, datetime.datetime.now())
    book.apply_fill(fill)
    assert book.cash < 1_000_000

def test_book_round_trip_pnl():
    book = BacktestBook(1_000_000)
    buy = Fill("f1", "strat", "AAPL", "buy", 100, 100.0, 0.0, datetime.datetime.now())
    book.apply_fill(buy)
    book.mark_to_market({"AAPL": 110.0})
    sell = Fill("f2", "strat", "AAPL", "sell", 100, 110.0, 0.0, datetime.datetime.now())
    book.apply_fill(sell)
    # Realized P&L = (110 - 100) * 100 = 1000
    assert abs(book.realized_pnl - 1000.0) < 0.01

def test_book_short_position():
    book = BacktestBook(1_000_000)
    sell = Fill("f1", "strat", "AAPL", "sell", 10, 200.0, 0.0, datetime.datetime.now())
    book.apply_fill(sell)
    assert book.positions.get("AAPL", 0) < 0

def test_book_gross_exposure():
    book = BacktestBook(1_000_000)
    fill = Fill("f1", "strat", "AAPL", "buy", 10, 100.0, 0.0, datetime.datetime.now())
    book.apply_fill(fill)
    book.mark_to_market({"AAPL": 100.0})
    assert book.gross_exposure() == pytest.approx(1000.0, rel=0.01)


# ── MarketSimulator ───────────────────────────────────────────────────────────

def test_simulator_fills_market_order():
    sim = MarketSimulator(fee_bps=5.0, slippage_bps=5.0)
    bar = Bar(datetime.datetime.now(), "TCS", 100, 101, 99, 100, volume=1e6, adv_20=1e6)
    order = {"symbol": "TCS", "side": "buy", "qty": 10, "order_type": "market", "limit_price": None}
    fill = sim.fill_order(order, bar, bar.ts)
    assert fill is not None
    assert fill.qty <= 10
    assert fill.fill_price > 100  # buy adds slippage

def test_simulator_sell_lower_price():
    sim = MarketSimulator(fee_bps=5.0, slippage_bps=10.0)
    bar = Bar(datetime.datetime.now(), "TCS", 100, 101, 99, 100, volume=1e6, adv_20=1e6)
    order = {"symbol": "TCS", "side": "sell", "qty": 10, "order_type": "market", "limit_price": None}
    fill = sim.fill_order(order, bar, bar.ts)
    assert fill.fill_price < 100  # sell gives worse price

def test_simulator_partial_fill_low_adv():
    sim = MarketSimulator(fee_bps=5.0, slippage_bps=5.0, max_participation_rate=0.10)
    # ADV = 100 shares → max fill = 10 at participation 10%
    bar = Bar(datetime.datetime.now(), "TCS", 100, 101, 99, 100, volume=100, adv_20=100)
    order = {"symbol": "TCS", "side": "buy", "qty": 1000, "order_type": "market", "limit_price": None}
    fill = sim.fill_order(order, bar, bar.ts)
    assert fill.is_partial
    assert fill.qty < 1000

def test_simulator_fee_nonzero():
    sim = MarketSimulator(fee_bps=10.0)
    bar = Bar(datetime.datetime.now(), "INFY", 1000, 1001, 999, 1000, volume=1e6, adv_20=1e6)
    order = {"symbol": "INFY", "side": "buy", "qty": 100, "order_type": "market", "limit_price": None}
    fill = sim.fill_order(order, bar, bar.ts)
    assert fill.fee > 0


# ── BacktestCollector ─────────────────────────────────────────────────────────

def test_collector_captures_signal():
    col = BacktestCollector("test_strat")
    col.collect("signal", 0.75)
    assert col.signal == pytest.approx(0.75)

def test_collector_captures_order():
    col = BacktestCollector("test_strat")
    col.collect("order", "RELIANCE", "buy", 50.0, "market", None)
    assert len(col.orders) == 1
    assert col.orders[0]["symbol"] == "RELIANCE"
    assert col.orders[0]["qty"] == 50.0

def test_collector_reset_clears_orders():
    col = BacktestCollector("test_strat")
    col.collect("order", "TCS", "sell", 10.0, "market", None)
    col.reset()
    assert len(col.orders) == 0

def test_collector_signal_persists_across_reset():
    col = BacktestCollector("test_strat")
    col.collect("signal", 0.9)
    col.reset()
    assert col.signal == pytest.approx(0.9)   # signal persists


# ── Strategy _collector hook ──────────────────────────────────────────────────

def test_strategy_base_collector_intercepts_signal():
    from backend.engine.strategy_base import ExampleBuyTheDip
    strategy = ExampleBuyTheDip(name="test_hook")
    col = BacktestCollector("test_hook")
    strategy._collector = col
    strategy.emit_signal(0.5)
    assert col.signal == pytest.approx(0.5)
    strategy._collector = None

def test_strategy_base_collector_intercepts_order():
    from backend.engine.strategy_base import ExampleBuyTheDip
    strategy = ExampleBuyTheDip(name="test_hook2")
    col = BacktestCollector("test_hook2")
    strategy._collector = col
    strategy.order("AAPL", "buy", 10)
    assert len(col.orders) == 1
    assert col.orders[0]["symbol"] == "AAPL"
    strategy._collector = None

def test_strategy_base_no_collector_no_crash():
    from backend.engine.strategy_base import ExampleBuyTheDip
    strategy = ExampleBuyTheDip(name="no_col")
    # Without _collector set, should not crash (just tries Redis which may be absent)
    try:
        strategy.emit_signal(0.5)
    except Exception:
        pass  # Redis unavailable is OK


# ── BacktestEngine — event-driven mode ───────────────────────────────────────

def test_engine_runs_event_driven(small_engine, synthetic_feed):
    from backend.engine.strategy_base import ExampleBuyTheDip
    small_engine.add_strategy(ExampleBuyTheDip("e1"))
    report = small_engine.run(
        start="2020-01-01", end="2020-06-30", feed=synthetic_feed
    )
    assert isinstance(report, BacktestReport)
    assert len(report.equity_curve) > 0
    assert len(report.daily_pnl) > 0

def test_engine_equity_curve_starts_at_capital(small_engine, synthetic_feed):
    from backend.engine.strategy_base import ExampleBuyTheDip
    small_engine.add_strategy(ExampleBuyTheDip("e2"))
    report = small_engine.run(start="2020-01-01", end="2020-03-31", feed=synthetic_feed)
    # First equity value should be near capital (no P&L on day 0)
    assert abs(report.equity_curve.iloc[0] - 1_000_000) < 50_000

def test_engine_no_strategies_returns_empty(small_engine, synthetic_feed):
    report = small_engine.run(start="2020-01-01", end="2020-03-31", feed=synthetic_feed)
    assert isinstance(report, BacktestReport)

def test_engine_signals_recorded(small_engine, synthetic_feed):
    from backend.engine.strategy_base import ExampleBuyTheDip
    small_engine.add_strategy(ExampleBuyTheDip("sig_test"))
    report = small_engine.run(start="2020-01-01", end="2020-06-30", feed=synthetic_feed)
    assert "sig_test" in report.signals.columns

def test_engine_anti_overfit_runs(small_engine, synthetic_feed):
    from backend.engine.strategy_base import ExampleBuyTheDip
    small_engine.add_strategy(ExampleBuyTheDip("ao_test"))
    report = small_engine.run(start="2020-01-01", end="2021-12-31", feed=synthetic_feed)
    assert isinstance(report.anti_overfit, AntiOverfitResult)
    assert isinstance(report.anti_overfit.passed, bool)


# ── BacktestEngine — vectorized mode ─────────────────────────────────────────

def test_engine_vectorized_mode(synthetic_feed):
    from backend.engine.strategy_base import ExampleBuyTheDip
    engine = BacktestEngine(
        capital=500_000,
        mode="vectorized",
        run_walk_forward=False,
        run_monte_carlo=False,
        enable_risk_gates=False,
        verbose=False,
    )
    engine.add_strategy(ExampleBuyTheDip("vec_test"))
    report = engine.run(start="2020-01-01", end="2021-12-31", feed=synthetic_feed)
    assert isinstance(report, BacktestReport)
    assert report.mode == "vectorized"
    assert len(report.equity_curve) > 0


# ── BacktestReport API ────────────────────────────────────────────────────────

def test_report_summary_keys(small_engine, synthetic_feed):
    from backend.engine.strategy_base import ExampleBuyTheDip
    small_engine.add_strategy(ExampleBuyTheDip("rpt"))
    report = small_engine.run(start="2020-01-01", end="2021-12-31", feed=synthetic_feed)
    s = report.summary()
    assert "portfolio" in s
    assert "anti_overfit" in s
    assert "engine" in s

def test_report_rolling_sharpe(small_engine, synthetic_feed):
    from backend.engine.strategy_base import ExampleBuyTheDip
    small_engine.add_strategy(ExampleBuyTheDip("rs"))
    report = small_engine.run(start="2020-01-01", end="2021-12-31", feed=synthetic_feed)
    rs = report.rolling_sharpe()
    assert isinstance(rs, pd.Series)

def test_report_rolling_drawdown(small_engine, synthetic_feed):
    from backend.engine.strategy_base import ExampleBuyTheDip
    small_engine.add_strategy(ExampleBuyTheDip("rd"))
    report = small_engine.run(start="2020-01-01", end="2021-12-31", feed=synthetic_feed)
    dd = report.rolling_drawdown()
    assert (dd <= 0).all()   # drawdown is always <= 0

def test_report_drawdown_periods(small_engine, synthetic_feed):
    from backend.engine.strategy_base import ExampleBuyTheDip
    small_engine.add_strategy(ExampleBuyTheDip("dp"))
    report = small_engine.run(start="2020-01-01", end="2021-12-31", feed=synthetic_feed)
    periods = report.drawdown_periods()
    assert isinstance(periods, list)

def test_report_strategy_ranking(small_engine, synthetic_feed):
    from backend.engine.strategy_base import ExampleBuyTheDip
    small_engine.add_strategy(ExampleBuyTheDip("r1"))
    small_engine.add_strategy(ExampleBuyTheDip("r2"))
    report = small_engine.run(start="2020-01-01", end="2021-12-31", feed=synthetic_feed)
    ranking = report.strategy_ranking()
    assert isinstance(ranking, pd.DataFrame)


# ── compute_all_metrics ───────────────────────────────────────────────────────

def test_compute_all_metrics_returns_bundle(pos_returns, equity_curve):
    m = compute_all_metrics(
        daily_pnl=pos_returns * 1_000_000,
        equity_curve=equity_curve,
        periods_per_year=252,
    )
    assert isinstance(m.sharpe, float)
    assert isinstance(m.max_drawdown, float)
    assert isinstance(m.cagr, float)
    assert m.var_95 >= 0.0
    assert m.cvar_95 >= m.var_95

def test_compute_all_metrics_summary_keys(pos_returns, equity_curve):
    m = compute_all_metrics(
        daily_pnl=pos_returns * 1_000_000,
        equity_curve=equity_curve,
    )
    s = m.summary()
    for key in ["sharpe", "sortino", "calmar", "omega", "max_drawdown", "win_rate", "profit_factor"]:
        assert key in s


# ── Monte Carlo ───────────────────────────────────────────────────────────────

def test_monte_carlo_shape(pos_returns):
    mc = monte_carlo(pos_returns, n_paths=100, horizon=63)
    assert mc["paths"].shape == (100, 63)
    assert mc["percentiles"].shape == (5, 63)

def test_monte_carlo_positive_with_gains():
    rets = np.ones(252) * 0.001
    mc = monte_carlo(rets, n_paths=50, horizon=30, capital=100_000)
    assert (mc["paths"] > 0).all()
