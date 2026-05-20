# backend/tests/integration/test_tick_risk_oms_pipeline.py
"""
Integration test: tick → risk_manager → execution_engine pipeline.

Uses unittest.mock to patch Redis so no real Redis connection is needed.
Tests the full decision path:
  1. Last-price tick arrives in Redis hash
  2. order passes through check_order() in risk_manager
  3. Accepted order flows to execution_engine._process_order()
  4. Fill is published; position and PnL updated
"""
from __future__ import annotations

import json
import time
import unittest
from typing import Dict, Any
from unittest.mock import MagicMock, patch, call


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _make_order(
    strategy: str = "test_strat",
    symbol: str = "AAPL",
    side: str = "buy",
    qty: float = 10.0,
    price: float = 150.0,
) -> Dict[str, Any]:
    return {
        "strategy": strategy,
        "symbol": symbol,
        "side": side,
        "qty": qty,
        "price": price,
    }


# ─── Risk Manager unit tests ──────────────────────────────────────────────────

class TestRiskManagerCheckOrder(unittest.TestCase):

    def _make_redis_mock(
        self,
        *,
        gross_usd: float = 0.0,
        used_by_strategy: float = 0.0,
        used_by_symbol: float = 0.0,
        orders_in_window: int = 0,
        kill_all: str = "0",
    ):
        """Return a fake Redis client with configurable state."""
        mock = MagicMock()
        mock.get.return_value = None  # default: no kill switches, no PnL
        mock.hget.return_value = None

        def mock_get(key):
            if key == "portfolio:gross_usd":
                return json.dumps({"usd": gross_usd})
            if key == "risk:kill_all":
                return kill_all
            return None

        def mock_hget(hash_key, field):
            if hash_key == "risk:used_by_strategy":
                return str(used_by_strategy)
            if hash_key == "risk:used_by_symbol":
                return str(used_by_symbol)
            return None

        mock.get.side_effect = mock_get
        mock.hget.side_effect = mock_hget
        mock.zremrangebyscore.return_value = None
        mock.zcard.return_value = orders_in_window
        return mock

    def test_valid_order_accepted(self):
        """A well-formed order with headroom in all caps passes."""
        from backend.engine import risk_manager as rm

        fake_r = self._make_redis_mock()
        with patch.object(rm, "r", fake_r), \
             patch("backend.engine.risk_manager.HAS_POLICY", False), \
             patch("backend.engine.risk_manager.HAS_REGIME_RISK", False), \
             patch("backend.engine.risk_manager.HAS_LEDGER", False), \
             patch("backend.engine.risk_manager.publish_pubsub"):
            ok, reason = rm.check_order(_make_order())
        self.assertTrue(ok, f"Expected ok=True, got reason={reason}")
        self.assertIsNone(reason)

    def test_malformed_order_rejected(self):
        """Missing strategy → rejected as malformed."""
        from backend.engine import risk_manager as rm

        fake_r = self._make_redis_mock()
        order = _make_order()
        del order["strategy"]
        with patch.object(rm, "r", fake_r), \
             patch("backend.engine.risk_manager.HAS_POLICY", False), \
             patch("backend.engine.risk_manager.HAS_REGIME_RISK", False), \
             patch("backend.engine.risk_manager.HAS_LEDGER", False):
            ok, reason = rm.check_order(order)
        self.assertFalse(ok)
        self.assertEqual(reason, "malformed")

    def test_kill_switch_blocks_all(self):
        """Global kill switch blocks any order."""
        from backend.engine import risk_manager as rm

        fake_r = self._make_redis_mock(kill_all="1")
        with patch.object(rm, "r", fake_r), \
             patch("backend.engine.risk_manager.HAS_POLICY", False), \
             patch("backend.engine.risk_manager.HAS_REGIME_RISK", False), \
             patch("backend.engine.risk_manager.HAS_LEDGER", False):
            ok, reason = rm.check_order(_make_order())
        self.assertFalse(ok)
        self.assertEqual(reason, "kill_all")

    def test_global_cap_blocks_order(self):
        """Order that would breach global gross cap is rejected."""
        from backend.engine import risk_manager as rm

        # gross already at RISK_MAX_GROSS_USD, any order rejected
        fake_r = self._make_redis_mock(gross_usd=rm.RISK_MAX_GROSS_USD)
        with patch.object(rm, "r", fake_r), \
             patch("backend.engine.risk_manager.HAS_POLICY", False), \
             patch("backend.engine.risk_manager.HAS_REGIME_RISK", False), \
             patch("backend.engine.risk_manager.HAS_LEDGER", False):
            ok, reason = rm.check_order(_make_order())
        self.assertFalse(ok)
        self.assertEqual(reason, "global_cap")

    def test_rate_limit_blocks_order(self):
        """Too many orders in the minute window → rate_limited."""
        from backend.engine import risk_manager as rm

        fake_r = self._make_redis_mock(orders_in_window=rm.RISK_MAX_ORDERS_PER_MIN)
        with patch.object(rm, "r", fake_r), \
             patch("backend.engine.risk_manager.HAS_POLICY", False), \
             patch("backend.engine.risk_manager.HAS_REGIME_RISK", False), \
             patch("backend.engine.risk_manager.HAS_LEDGER", False):
            ok, reason = rm.check_order(_make_order())
        self.assertFalse(ok)
        self.assertEqual(reason, "rate_limited")

    def test_strategy_cap_enforced(self):
        """Strategy that is already at its cap cannot add more notional."""
        from backend.engine import risk_manager as rm

        used = rm.RISK_MAX_POS_PER_STRAT_USD  # already at cap
        fake_r = self._make_redis_mock(used_by_strategy=used)
        with patch.object(rm, "r", fake_r), \
             patch("backend.engine.risk_manager.HAS_POLICY", False), \
             patch("backend.engine.risk_manager.HAS_REGIME_RISK", False), \
             patch("backend.engine.risk_manager.HAS_LEDGER", False):
            ok, reason = rm.check_order(_make_order())
        self.assertFalse(ok)
        self.assertEqual(reason, "strategy_cap")


# ─── Execution Engine unit tests ──────────────────────────────────────────────

class TestExecutionEngineProcessOrder(unittest.TestCase):

    def _make_exec_redis(self, last_price: float = 150.0):
        mock = MagicMock()

        def _hget(hash_key, field):
            if hash_key == "last_price":
                return str(last_price) if last_price is not None else None
            # risk:used_by_strategy and allocator:notional → 0 / None so caps aren't hit
            return None

        mock.hget.side_effect = _hget
        mock.hset.return_value = None
        mock.hincrbyfloat.return_value = 0.0
        mock.hgetall.return_value = {}
        mock.get.return_value = "0"
        mock.set.return_value = None
        return mock

    def test_fill_published_on_valid_order(self):
        """A valid order triggers a fill event and updates positions."""
        from backend.engine import execution_engine as ee

        fake_r = self._make_exec_redis(last_price=150.0)
        order = _make_order(qty=5.0)

        published_fills = []
        published_pubsub = []

        with patch.object(ee, "r", fake_r), \
             patch("backend.engine.execution_engine.kv_get", return_value="0"), \
             patch("backend.engine.execution_engine.kv_set"), \
             patch("backend.engine.execution_engine.hgetall", return_value={}), \
             patch("backend.engine.execution_engine.hset"), \
             patch("backend.engine.execution_engine.publish_stream",
                   side_effect=lambda *a, **kw: published_fills.append(a)), \
             patch("backend.engine.execution_engine.publish_pubsub",
                   side_effect=lambda *a, **kw: published_pubsub.append(a)):
            ee._process_order(order)

        # A fill should have been published to the stream
        self.assertEqual(len(published_fills), 1, "Expected one stream publish (fill)")
        fill_payload = published_fills[0][1]
        self.assertEqual(fill_payload["symbol"], "AAPL")
        self.assertAlmostEqual(fill_payload["qty"], 5.0)
        self.assertAlmostEqual(fill_payload["price"], 150.0, places=1)

    def test_no_price_causes_reject(self):
        """Order with no last_price results in a reject pubsub event, no fill."""
        from backend.engine import execution_engine as ee

        fake_r = self._make_exec_redis(last_price=None)
        fake_r.hget.return_value = None

        published_pubsub = []
        with patch.object(ee, "r", fake_r), \
             patch("backend.engine.execution_engine.kv_get", return_value="0"), \
             patch("backend.engine.execution_engine.kv_set"), \
             patch("backend.engine.execution_engine.hgetall", return_value={}), \
             patch("backend.engine.execution_engine.hset"), \
             patch("backend.engine.execution_engine.publish_stream") as mock_stream, \
             patch("backend.engine.execution_engine.publish_pubsub",
                   side_effect=lambda *a, **kw: published_pubsub.append(a)):
            ee._process_order(_make_order())

        mock_stream.assert_not_called()
        self.assertTrue(
            any("no_market_price" in str(p) for p in published_pubsub),
            "Expected no_market_price reject event"
        )


# ─── Pipeline smoke test ──────────────────────────────────────────────────────

class TestTickRiskOMSPipeline(unittest.TestCase):
    """End-to-end smoke: order passes risk → execution fills it → PnL updated."""

    def test_full_pipeline_smoke(self):
        """Risk accepts → execution fills → fill event published."""
        from backend.engine import risk_manager as rm
        from backend.engine import execution_engine as ee

        order = _make_order(strategy="smoke_strat", symbol="MSFT", qty=2.0, price=300.0)

        # Step 1: risk check
        mock_r_risk = MagicMock()
        mock_r_risk.get.return_value = None
        mock_r_risk.hget.return_value = None
        mock_r_risk.zremrangebyscore.return_value = None
        mock_r_risk.zcard.return_value = 0

        with patch.object(rm, "r", mock_r_risk), \
             patch("backend.engine.risk_manager.HAS_POLICY", False), \
             patch("backend.engine.risk_manager.HAS_REGIME_RISK", False), \
             patch("backend.engine.risk_manager.HAS_LEDGER", False), \
             patch("backend.engine.risk_manager.publish_pubsub"):
            ok, reason = rm.check_order(order)

        self.assertTrue(ok, f"Risk rejected order unexpectedly: {reason}")

        # Step 2: execution
        mock_r_exec = MagicMock()

        def _exec_hget(hash_key, field):
            if hash_key == "last_price":
                return "300.0"
            return None

        mock_r_exec.hget.side_effect = _exec_hget
        mock_r_exec.hset.return_value = None
        mock_r_exec.hgetall.return_value = {}
        mock_r_exec.get.return_value = "0"

        fills = []
        with patch.object(ee, "r", mock_r_exec), \
             patch("backend.engine.execution_engine.kv_get", return_value="0"), \
             patch("backend.engine.execution_engine.kv_set"), \
             patch("backend.engine.execution_engine.hgetall", return_value={}), \
             patch("backend.engine.execution_engine.hset"), \
             patch("backend.engine.execution_engine.publish_stream",
                   side_effect=lambda s, fill: fills.append(fill)), \
             patch("backend.engine.execution_engine.publish_pubsub"):
            ee._process_order(order)

        self.assertEqual(len(fills), 1, "Expected exactly one fill")
        fill = fills[0]
        self.assertEqual(fill["strategy"], "smoke_strat")
        self.assertEqual(fill["symbol"], "MSFT")
        self.assertEqual(fill["side"], "buy")
        self.assertAlmostEqual(fill["qty"], 2.0)


if __name__ == "__main__":
    unittest.main()
