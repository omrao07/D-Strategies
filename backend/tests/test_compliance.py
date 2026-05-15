# test_compliance.py
# Pytest test suite for backend/compliance/sebi_otr.py
#
# Tests:
#   - OTR ratio calculation (orders / trades)
#   - _breach_slab() returns the HIGHEST crossed threshold
#   - Throttle gating (evaluate returns alerts when OTR breaches)
#   - Reset resets counters
#
# Run:
#   pytest -q backend/tests/test_compliance.py

from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from backend.compliance.sebi_otr import (
    OtrConfig,
    OtrMonitor,
    RollingCounters,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_NOW_MS = int(time.time() * 1000)


def _make_cfg(**kwargs) -> OtrConfig:
    """Return a minimal OtrConfig for testing."""
    defaults = dict(
        windows_ms=[60_000],          # single 1-minute window
        group_by=["member_id"],       # simplest possible key
        otr_formula="orders/trades",
        count_modify_as_order=True,
        count_cancel_as_order=True,
        alert_thresholds=[10.0, 50.0, 100.0],
        min_trades_for_valid_otr=1,
        emit_insights=False,
        persist_to_redis=False,
        csv_out_dir="/tmp/test_otr_csv",
        csv_prefix="otr_test",
        topic_orders=["oms.child"],
        topic_trades=["oms.fill"],
    )
    defaults.update(kwargs)
    return OtrConfig(**defaults)


def _order_msg(member_id: str = "BRK1", typ: str = "new", ts_ms: int = _NOW_MS) -> dict:
    return {"ts_ms": ts_ms, "member_id": member_id, "typ": typ}


def _trade_msg(member_id: str = "BRK1", price: float = 100.0, qty: float = 10.0, ts_ms: int = _NOW_MS) -> dict:
    return {"ts_ms": ts_ms, "member_id": member_id, "price": price, "qty": qty}


# ---------------------------------------------------------------------------
# 1. OTR ratio calculation
# ---------------------------------------------------------------------------

@patch("backend.compliance.sebi_otr.publish_stream", None)
class TestOtrRatioCalculation:
    """OTR = orders / trades within the rolling window."""

    def test_basic_otr_ten_orders_one_trade(self):
        cfg = _make_cfg()
        mon = OtrMonitor(cfg)
        for _ in range(10):
            mon.on_order(_order_msg())
        mon.on_trade(_trade_msg())

        # Retrieve via public evaluate; check alert OTR value
        alerts = mon.evaluate()
        assert len(alerts) >= 1
        otr_val = alerts[0]["otr"]
        assert otr_val == pytest.approx(10.0, rel=1e-3)

    def test_otr_formula_orders_over_trades(self):
        """Direct RollingCounters.snapshot() check."""
        rc = RollingCounters(window_ms=60_000)
        for _ in range(5):
            rc.ingest_order(_NOW_MS, "new")
        rc.ingest_trade(_NOW_MS, qty=10.0, px=100.0)
        rc.ingest_trade(_NOW_MS, qty=10.0, px=100.0)

        cfg = _make_cfg()
        snap = rc.snapshot(cfg, _NOW_MS)
        # 5 orders, 2 trades → OTR = 5/2 = 2.5
        assert snap["otr"] == pytest.approx(2.5, rel=1e-3)
        assert snap["orders"] == 5
        assert snap["trades"] == 2

    def test_otr_zero_trades_gives_infinity(self):
        """OTR with orders but no trades = inf."""
        rc = RollingCounters(window_ms=60_000)
        rc.ingest_order(_NOW_MS, "new")
        cfg = _make_cfg()
        snap = rc.snapshot(cfg, _NOW_MS)
        assert snap["otr"] == float("inf")

    def test_otr_zero_orders_zero_trades(self):
        """Empty window → OTR = 0.0."""
        rc = RollingCounters(window_ms=60_000)
        cfg = _make_cfg()
        snap = rc.snapshot(cfg, _NOW_MS)
        assert snap["otr"] == pytest.approx(0.0)

    def test_trade_notional_accumulates(self):
        rc = RollingCounters(window_ms=60_000)
        rc.ingest_trade(_NOW_MS, qty=10.0, px=200.0)
        rc.ingest_trade(_NOW_MS, qty=5.0, px=100.0)
        cfg = _make_cfg()
        snap = rc.snapshot(cfg, _NOW_MS)
        assert snap["trade_qty"] == pytest.approx(15.0)
        assert snap["trade_notional"] == pytest.approx(10 * 200 + 5 * 100)


# ---------------------------------------------------------------------------
# 2. _breach_slab returns the HIGHEST crossed threshold
# ---------------------------------------------------------------------------

class TestBreachSlab:
    """_breach_slab(ratio) must return the HIGHEST threshold crossed, not lowest."""

    def setup_method(self):
        self.cfg = _make_cfg(alert_thresholds=[10.0, 50.0, 100.0])
        self.mon = OtrMonitor(self.cfg)

    def test_below_all_thresholds_returns_none(self):
        assert self.mon._breach_slab(5.0) is None

    def test_exactly_at_first_threshold(self):
        # 10.0 >= 10.0 but < 50.0 → should return 10.0
        result = self.mon._breach_slab(10.0)
        assert result == 10.0

    def test_between_first_and_second_threshold(self):
        # 30.0 >= 10.0, < 50.0 → highest crossed is 10.0
        result = self.mon._breach_slab(30.0)
        assert result == 10.0

    def test_exactly_at_second_threshold_returns_second(self):
        # 50.0 >= 10.0 and >= 50.0, < 100.0 → highest crossed is 50.0
        result = self.mon._breach_slab(50.0)
        assert result == 50.0

    def test_above_all_thresholds_returns_highest(self):
        # 150.0 crosses all three; must return 100.0 (highest), NOT 10.0 (lowest)
        result = self.mon._breach_slab(150.0)
        assert result == 100.0

    def test_exactly_at_highest_threshold(self):
        result = self.mon._breach_slab(100.0)
        assert result == 100.0

    def test_just_above_highest_threshold(self):
        result = self.mon._breach_slab(500.0)
        assert result == 100.0

    def test_custom_single_threshold(self):
        cfg = _make_cfg(alert_thresholds=[25.0])
        mon = OtrMonitor(cfg)
        assert mon._breach_slab(24.9) is None
        assert mon._breach_slab(25.0) == 25.0
        assert mon._breach_slab(999.0) == 25.0


# ---------------------------------------------------------------------------
# 3. Throttle gating — evaluate() generates alerts when OTR breaches
# ---------------------------------------------------------------------------

@patch("backend.compliance.sebi_otr.publish_stream", None)
class TestThrottleGating:
    """evaluate() should return alert dicts when OTR exceeds any threshold."""

    def test_no_alert_below_threshold(self):
        cfg = _make_cfg(alert_thresholds=[50.0])
        mon = OtrMonitor(cfg)
        # 5 orders, 1 trade → OTR = 5 (below 50)
        for _ in range(5):
            mon.on_order(_order_msg())
        mon.on_trade(_trade_msg())
        alerts = mon.evaluate()
        assert alerts == []

    def test_alert_triggered_above_threshold(self):
        cfg = _make_cfg(alert_thresholds=[5.0])
        mon = OtrMonitor(cfg)
        for _ in range(10):
            mon.on_order(_order_msg())
        mon.on_trade(_trade_msg())
        alerts = mon.evaluate()
        assert len(alerts) >= 1
        alert = alerts[0]
        assert alert["slab"] == 5.0
        assert alert["otr"] == pytest.approx(10.0, rel=1e-3)

    def test_alert_contains_expected_fields(self):
        cfg = _make_cfg(alert_thresholds=[1.0])
        mon = OtrMonitor(cfg)
        mon.on_order(_order_msg())
        mon.on_trade(_trade_msg())
        # OTR = 1, threshold = 1 → alert
        alerts = mon.evaluate()
        assert len(alerts) >= 1
        alert = alerts[0]
        for field in ("ts_ms", "window_ms", "bucket", "orders", "trades", "otr", "slab"):
            assert field in alert, f"Missing field: {field}"

    def test_alert_slab_is_highest_crossed(self):
        """When OTR=200, thresholds=[10,50,100] → slab in alert must be 100."""
        cfg = _make_cfg(alert_thresholds=[10.0, 50.0, 100.0])
        mon = OtrMonitor(cfg)
        for _ in range(200):
            mon.on_order(_order_msg())
        mon.on_trade(_trade_msg())
        alerts = mon.evaluate()
        assert len(alerts) >= 1
        assert alerts[0]["slab"] == 100.0

    def test_no_alert_when_insufficient_trades(self):
        """min_trades_for_valid_otr=2; only 1 trade → no alert even if OTR very high."""
        cfg = _make_cfg(alert_thresholds=[1.0], min_trades_for_valid_otr=2)
        mon = OtrMonitor(cfg)
        for _ in range(100):
            mon.on_order(_order_msg())
        mon.on_trade(_trade_msg())  # only 1 trade, below min
        alerts = mon.evaluate()
        assert alerts == []

    def test_publish_stream_not_called_when_unavailable(self):
        """evaluate() must not crash when publish_stream is None."""
        cfg = _make_cfg(alert_thresholds=[1.0], emit_insights=True)
        mon = OtrMonitor(cfg)
        mon.on_order(_order_msg())
        mon.on_trade(_trade_msg())
        # Should not raise even though bus is unavailable
        alerts = mon.evaluate()
        assert isinstance(alerts, list)


# ---------------------------------------------------------------------------
# 4. Reset — clearing counters
# ---------------------------------------------------------------------------

class TestReset:
    """After resetting a RollingCounters, all counts should be zero."""

    def test_manual_counter_reset(self):
        rc = RollingCounters(window_ms=60_000)
        for _ in range(10):
            rc.ingest_order(_NOW_MS, "new")
        rc.ingest_trade(_NOW_MS, qty=5.0, px=100.0)

        # Manually reset — mirrors what a session-reset would do
        rc.orders = 0
        rc.trades = 0
        rc.trade_qty = 0.0
        rc.trade_notional = 0.0
        rc.events.clear()

        cfg = _make_cfg()
        snap = rc.snapshot(cfg, _NOW_MS)
        assert snap["orders"] == 0
        assert snap["trades"] == 0
        assert snap["otr"] == pytest.approx(0.0)

    def test_otr_monitor_fresh_instance_has_empty_state(self):
        cfg = _make_cfg()
        mon = OtrMonitor(cfg)
        # evaluate with no ingested data → no alerts (no min trades)
        alerts = mon.evaluate()
        assert alerts == []

    def test_eviction_resets_rolling_window(self):
        """Events older than window_ms should be evicted and not affect OTR."""
        rc = RollingCounters(window_ms=1_000)  # 1-second window

        old_ts = _NOW_MS - 5_000  # 5 seconds ago (outside window)
        for _ in range(50):
            rc.ingest_order(old_ts, "new")
        rc.ingest_trade(old_ts, qty=1.0, px=100.0)

        # Snapshot at current time — old events evicted
        cfg = _make_cfg()
        snap = rc.snapshot(cfg, _NOW_MS)
        assert snap["orders"] == 0
        assert snap["trades"] == 0
