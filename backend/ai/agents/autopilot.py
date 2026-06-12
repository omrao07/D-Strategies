# backend/ai/agents/autopilot.py
"""
Autopilot
---------
The central wiring layer that makes the platform run semi-automatically.

Connects:
  ┌─────────────────────────────────────────────────────────────────┐
  │  OrchestratorScheduler  →  Autopilot  →  Dispatcher            │
  │                                    ↓                           │
  │                            SwarmManager (all agents)           │
  │                                    ↓                           │
  │                            Results → Redis / Telegram          │
  └─────────────────────────────────────────────────────────────────┘

Usage:
  from backend.ai.agents.autopilot import Autopilot, AutopilotConfig

  config = AutopilotConfig(
      symbols=["NIFTY", "RELIANCE", "TCS", "HDFCBANK"],
      capital=10_000_000,
      run_mc_sim=True,
      mc_paths=20_000,
      run_greeks=False,   # only if you have options positions
      telegram_token=os.getenv("TELEGRAM_BOT_TOKEN"),
      telegram_chat_id=os.getenv("TELEGRAM_CHAT_ID"),
  )
  pilot = Autopilot(config)

  # Wire to scheduler:
  from backend.orchestration.scheduler import OrchestratorScheduler
  sched = OrchestratorScheduler(poll_seconds=5)
  sched.on_pre_open(pilot.on_pre_open)
  sched.on_post_close(pilot.on_post_close)
  sched.add_market("india", timezone="Asia/Kolkata",
                   open_time=(9, 15), close_time=(15, 30))
  sched.start(loop_fn=your_trading_loop)

  # Or run once manually:
  pilot.run_morning_analysis()
"""
from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

# ── Dispatcher ──
try:
    from .orchestration.dispatcher import Dispatcher  # type: ignore
    _HAS_DISPATCHER = True
except Exception:
    _HAS_DISPATCHER = False
    Dispatcher = None  # type: ignore

# ── Swarm ──
try:
    from .concrete.swarm_manager import SwarmManager  # type: ignore
    _HAS_SWARM = True
except Exception:
    _HAS_SWARM = False
    SwarmManager = None  # type: ignore

# ── Concrete agents ──
try:
    from .concrete.analyst_agent import AnalystAgent, AnalystRequest  # type: ignore
    from .concrete.greeks_agent import GreeksAgent  # type: ignore
    from .concrete.insight_agent import InsightAgent  # type: ignore
    from .concrete.monte_carlo_agent import (  # type: ignore
        MonteCarloAgent,
    )
    from .concrete.portfolio_agent import (  # type: ignore
        PortfolioAgent,
    )
    from .concrete.rl_execution_agent import RLExecutionAgent  # type: ignore
    _HAS_AGENTS = True
except Exception:
    _HAS_AGENTS = False

# ── Telegram ──
try:
    from backend.live_engine.telegram_alerts import TelegramAlerts  # type: ignore
    _HAS_TELEGRAM = True
except Exception:
    _HAS_TELEGRAM = False
    TelegramAlerts = None  # type: ignore

# ── Reconciler ──
try:
    from backend.oms.reconciler import Reconciler  # type: ignore
    _HAS_RECONCILER = True
except Exception:
    _HAS_RECONCILER = False

# ── Redis ──
try:
    import redis  # type: ignore
    _REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
    _REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
    _r = redis.Redis(host=_REDIS_HOST, port=_REDIS_PORT,
                     password=os.getenv("REDIS_PASSWORD") or None, decode_responses=True)
except Exception:
    _r = None


# ─────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────

@dataclass
class AutopilotConfig:
    symbols: List[str] = field(default_factory=lambda: ["NIFTY","BANKNIFTY","RELIANCE","TCS","HDFCBANK"])
    capital: float = 10_000_000.0

    # Analyst
    run_analyst: bool = True
    analyst_lookback: int = 120
    analyst_interval: str = "1d"

    # Monte Carlo
    run_mc_sim: bool = True
    mc_model: str = "gbm"           # "gbm" | "merton_jd" | "heston"
    mc_paths: int = 20_000
    mc_steps: int = 252
    mc_antithetic: bool = True

    # Portfolio construction
    run_portfolio: bool = True
    portfolio_methods: List[str] = field(default_factory=lambda: ["risk_parity","inv_vol"])
    kelly_win_rate: Optional[float] = 0.54
    kelly_odds: Optional[float] = 1.8
    kelly_fraction: float = 0.25

    # Greeks (only if option positions supplied)
    run_greeks: bool = False
    option_specs: List[Dict[str, Any]] = field(default_factory=list)

    # Insight / anomaly
    run_insight: bool = True

    # Reconciliation
    run_reconciler: bool = True
    reconciler_broker: str = "paper"

    # Scheduling
    intraday_interval_min: int = 30     # run risk checks every N minutes
    post_close_report: bool = True

    # Notifications
    telegram_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None

    # Dispatcher config
    dispatcher_workers: int = 6
    task_timeout_ms: int = 30_000


# ─────────────────────────────────────────────────────────────
# Autopilot
# ─────────────────────────────────────────────────────────────

class Autopilot:
    """
    Central AI automation hub.  Wires the scheduler's market hooks
    to the agent dispatcher and publishes results to Telegram + Redis.
    """

    def __init__(self, config: AutopilotConfig):
        self.cfg = config
        self._lock = threading.RLock()
        self._running = False
        self._intraday_thread: Optional[threading.Thread] = None

        # Build dispatcher
        if _HAS_DISPATCHER and Dispatcher is not None:
            self.dispatcher = Dispatcher(
                workers=config.dispatcher_workers,
                default_timeout_ms=config.task_timeout_ms,
            )
            self._register_agents()
        else:
            self.dispatcher = None

        # Telegram
        self.telegram: Optional[Any] = None
        if _HAS_TELEGRAM and config.telegram_token and config.telegram_chat_id:
            try:
                self.telegram = TelegramAlerts(
                    token=config.telegram_token,
                    chat_id=config.telegram_chat_id,
                )
            except Exception:
                pass

        # Reconciler
        self.reconciler = None
        if _HAS_RECONCILER and config.run_reconciler:
            try:
                self.reconciler = Reconciler(broker=config.reconciler_broker, auto_fix=False, poll_s=300)
            except Exception:
                pass

    # ─────────────── agent registration ───────────────

    def _register_agents(self) -> None:
        if not _HAS_AGENTS or self.dispatcher is None:
            return
        try:
            self.dispatcher.register("analyst",      AnalystAgent)
            self.dispatcher.register("greeks",       GreeksAgent)
            self.dispatcher.register("monte_carlo",  MonteCarloAgent)
            self.dispatcher.register("portfolio",    PortfolioAgent)
            self.dispatcher.register("insight",      InsightAgent)
            self.dispatcher.register("rl_exec",      RLExecutionAgent)
        except Exception:
            pass

        # Intent → agent bindings
        try:
            self.dispatcher.bind_intent("risk",      "analyst")
            self.dispatcher.bind_intent("price",     "analyst")
            self.dispatcher.bind_intent("greeks",    "greeks")
            self.dispatcher.bind_intent("simulate",  "monte_carlo")
            self.dispatcher.bind_intent("portfolio", "portfolio")
            self.dispatcher.bind_intent("anomaly",   "insight")
            self.dispatcher.bind_intent("execute",   "rl_exec")
        except Exception:
            pass

    # ─────────────── scheduler hooks ───────────────

    def on_pre_open(self, market_name: str, cfg: Dict[str, Any]) -> None:
        """Called by OrchestratorScheduler before market open."""
        self._notify(f"[{market_name.upper()}] 🕘 Market opening soon — running pre-market analysis...")
        self.run_morning_analysis(market_name=market_name)

    def on_post_close(self, market_name: str, cfg: Dict[str, Any]) -> None:
        """Called by OrchestratorScheduler after market close."""
        self._stop_intraday_loop()
        if self.cfg.post_close_report:
            self._notify(f"[{market_name.upper()}] 🔔 Market closed — generating EOD report...")
            self.run_eod_report(market_name=market_name)

    # ─────────────── public analysis triggers ───────────────

    def run_morning_analysis(self, market_name: str = "market") -> Dict[str, Any]:
        """Submit full morning analysis task bundle to the dispatcher."""
        results: Dict[str, Any] = {}
        cfg = self.cfg
        submitted_ids: List[str] = []

        if self.dispatcher is None:
            # fallback: run agents directly (single-threaded)
            return self._run_direct_analysis()

        # 1. Analyst: signals + risk overview
        if cfg.run_analyst:
            tid = self.dispatcher.submit({
                "agent": "analyst",
                "payload": {
                    "symbols": cfg.symbols,
                    "interval": cfg.analyst_interval,
                    "lookback": cfg.analyst_lookback,
                    "tasks": ["overview","signals","risk"],
                },
                "timeout_ms": 20_000,
            }, priority=2)
            submitted_ids.append(tid)

        # 2. Portfolio construction
        if cfg.run_portfolio:
            holdings = [{"symbol": s, "exp_vol": 0.20, "exp_return": 0.10,
                         "current_value": 0} for s in cfg.symbols]
            tid = self.dispatcher.submit({
                "agent": "portfolio",
                "payload": {
                    "holdings": holdings,
                    "total_capital": cfg.capital,
                    "methods": cfg.portfolio_methods,
                    "kelly_win_rate": cfg.kelly_win_rate,
                    "kelly_odds": cfg.kelly_odds,
                    "kelly_fraction": cfg.kelly_fraction,
                },
                "timeout_ms": 15_000,
            }, priority=3)
            submitted_ids.append(tid)

        # 3. Monte Carlo simulation
        if cfg.run_mc_sim:
            assets = [{"symbol": s, "s0": 100.0, "mu": 0.10, "sigma": 0.20,
                       "weight": 1.0/len(cfg.symbols)} for s in cfg.symbols]
            tid = self.dispatcher.submit({
                "agent": "monte_carlo",
                "payload": {
                    "assets": assets,
                    "model": cfg.mc_model,
                    "n_paths": cfg.mc_paths,
                    "n_steps": cfg.mc_steps,
                    "antithetic": cfg.mc_antithetic,
                    "var_levels": [0.95, 0.99],
                },
                "timeout_ms": cfg.task_timeout_ms,
            }, priority=4)
            submitted_ids.append(tid)

        # 4. Greeks (if option positions configured)
        if cfg.run_greeks and cfg.option_specs:
            tid = self.dispatcher.submit({
                "agent": "greeks",
                "payload": {"options": cfg.option_specs, "compute_surface": True},
                "timeout_ms": 10_000,
            }, priority=3)
            submitted_ids.append(tid)

        # 5. Insight / anomaly detection
        if cfg.run_insight:
            tid = self.dispatcher.submit({
                "agent": "insight",
                "payload": {"symbols": cfg.symbols, "mode": "anomaly"},
                "timeout_ms": 15_000,
            }, priority=5)
            submitted_ids.append(tid)

        # Collect results (non-blocking publish to Redis; blocking here for summary)
        results = self._collect_results(submitted_ids, timeout=max(cfg.task_timeout_ms/1000 + 10, 60))

        # Send morning summary to Telegram
        summary = self._format_morning_summary(results, market_name)
        self._notify(summary)
        self._publish_redis("autopilot.morning", {"market": market_name, "summary": summary,
                                                   "ts": int(time.time()*1000)})

        # Start intraday risk loop
        self._start_intraday_loop()
        return results

    def run_eod_report(self, market_name: str = "market") -> Dict[str, Any]:
        """Generate end-of-day report."""
        results: Dict[str, Any] = {}
        if self.dispatcher is None:
            return results

        # EOD: analyst + portfolio rebalance check
        tids = []
        if self.cfg.run_analyst:
            tids.append(self.dispatcher.submit({
                "agent": "analyst",
                "payload": {"symbols": self.cfg.symbols, "lookback": 252,
                            "tasks": ["overview","signals","risk"]},
                "timeout_ms": 20_000,
            }, priority=2))

        results = self._collect_results(tids, timeout=60)
        summary = f"[EOD {market_name.upper()}] Closing report generated. {len(results)} agent tasks completed."
        self._notify(summary)
        self._publish_redis("autopilot.eod", {"market": market_name, "ts": int(time.time()*1000)})
        return results

    def run_intraday_risk_check(self) -> None:
        """Periodic risk snapshot — called by intraday loop thread."""
        if self.dispatcher is None:
            return
        tid = self.dispatcher.submit({
            "agent": "analyst",
            "payload": {"symbols": self.cfg.symbols, "tasks": ["risk"],
                        "lookback": 60, "interval": "5m"},
            "timeout_ms": 15_000,
        }, priority=1)

        result = self._collect_results([tid], timeout=20)
        analyst_res = result.get(tid)
        if analyst_res:
            summary = getattr(analyst_res, "result", None)
            if summary:
                text = f"[INTRADAY RISK] {getattr(summary, 'summary', str(summary))}"
                self._publish_redis("autopilot.intraday", {"ts": int(time.time()*1000), "summary": text})

    # ─────────────── intraday loop ───────────────

    def _start_intraday_loop(self) -> None:
        with self._lock:
            if self._running:
                return
            self._running = True

        def _loop():
            interval = self.cfg.intraday_interval_min * 60
            while self._running:
                time.sleep(interval)
                if not self._running:
                    break
                try:
                    self.run_intraday_risk_check()
                except Exception:
                    pass

        self._intraday_thread = threading.Thread(target=_loop, name="autopilot-intraday", daemon=True)
        self._intraday_thread.start()

    def _stop_intraday_loop(self) -> None:
        with self._lock:
            self._running = False

    # ─────────────── direct (no dispatcher) fallback ───────────────

    def _run_direct_analysis(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        if not _HAS_AGENTS:
            return out
        try:
            agent = AnalystAgent()
            req = AnalystRequest(symbols=self.cfg.symbols, interval=self.cfg.analyst_interval,
                                  lookback=self.cfg.analyst_lookback)
            out["analyst"] = agent.act(req)
            self._notify(f"[ANALYST] {out['analyst'].summary}")
        except Exception as e:
            out["analyst_error"] = str(e)
        return out

    # ─────────────── result collection ───────────────

    def _collect_results(self, task_ids: List[str], timeout: float = 60) -> Dict[str, Any]:
        if self.dispatcher is None:
            return {}
        results: Dict[str, Any] = {}
        remaining = set(task_ids)
        deadline = time.time() + timeout
        while remaining and time.time() < deadline:
            dr = self.dispatcher.get_result(block=True, timeout=min(2.0, deadline - time.time()))
            if dr and dr.task_id in remaining:
                remaining.discard(dr.task_id)
                results[dr.task_id] = dr
        return results

    # ─────────────── formatting ───────────────

    def _format_morning_summary(self, results: Dict[str, Any], market: str) -> str:
        lines = [f"=== MORNING BRIEF | {market.upper()} ==="]
        for tid, dr in results.items():
            if not hasattr(dr, "result") or dr.result is None:
                lines.append(f"• [{getattr(dr,'agent','?')}] ❌ {getattr(dr,'error','no result')}")
                continue
            r = dr.result
            if hasattr(r, "summary"):
                lines.append(f"• [{dr.agent}] {r.summary}")
            elif isinstance(r, dict) and "summary" in r:
                lines.append(f"• [{dr.agent}] {r['summary']}")
            else:
                lines.append(f"• [{dr.agent}] ✅ completed in {dr.took_ms}ms")
        if not results:
            lines.append("No agent results yet (tasks still running or no dispatcher).")
        return "\n".join(lines)

    # ─────────────── notification helpers ───────────────

    def _notify(self, text: str) -> None:
        print(text)
        if self.telegram:
            try:
                self.telegram.send(text)
            except Exception:
                pass

    def _publish_redis(self, stream: str, payload: Dict[str, Any]) -> None:
        if _r is None:
            return
        try:
            _r.xadd(stream, {"data": json.dumps(payload, default=str)})
        except Exception:
            pass

    # ─────────────── shutdown ───────────────

    def shutdown(self) -> None:
        self._stop_intraday_loop()
        if self.dispatcher:
            try:
                self.dispatcher.shutdown(wait=True)
            except Exception:
                pass


# ─────────────────────────────────────────────────────────────
# Convenience: build_autopilot() factory + wire_to_scheduler()
# ─────────────────────────────────────────────────────────────

def build_autopilot(
    symbols: List[str],
    capital: float = 10_000_000,
    mc_paths: int = 20_000,
    telegram_token: Optional[str] = None,
    telegram_chat_id: Optional[str] = None,
    **kwargs,
) -> Autopilot:
    """One-liner factory for common configuration."""
    cfg = AutopilotConfig(
        symbols=symbols,
        capital=capital,
        mc_paths=mc_paths,
        telegram_token=telegram_token or os.getenv("TELEGRAM_BOT_TOKEN"),
        telegram_chat_id=telegram_chat_id or os.getenv("TELEGRAM_CHAT_ID"),
        **{k: v for k, v in kwargs.items() if k in AutopilotConfig.__dataclass_fields__},
    )
    return Autopilot(cfg)


def wire_to_scheduler(
    pilot: Autopilot,
    scheduler: Any,
    markets: Optional[Dict[str, Dict[str, Any]]] = None,
    loop_fn: Optional[Callable] = None,
) -> None:
    """
    Wire an Autopilot to an OrchestratorScheduler.

    markets = {
      "india": {"timezone": "Asia/Kolkata", "open": (9,15), "close": (15,30)},
      "us":    {"timezone": "America/New_York", "open": (9,30), "close": (16,0)},
    }
    """
    scheduler.on_pre_open(pilot.on_pre_open)
    scheduler.on_post_close(pilot.on_post_close)

    if markets:
        for name, m in markets.items():
            scheduler.add_market(
                name=name,
                timezone=m.get("timezone", "UTC"),
                open_time=m.get("open", (9, 0)),
                close_time=m.get("close", (17, 0)),
                pre_open_minutes=m.get("pre_open_minutes", 5),
                post_close_minutes=m.get("post_close_minutes", 5),
                cfg=m.get("cfg", {}),
            )

    if loop_fn:
        scheduler.start(loop_fn=loop_fn)


# ─────────────────────────────────────────────────────────────
# Entry point: python -m backend.ai.agents.autopilot
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":  # pragma: no cover
    import signal

    pilot = build_autopilot(
        symbols=["NIFTY","BANKNIFTY","RELIANCE","TCS","HDFCBANK"],
        capital=10_000_000,
        mc_paths=5_000,   # smaller for CLI demo
        run_greeks=False,
    )

    print("Running one-shot morning analysis (no scheduler)...")
    results = pilot.run_morning_analysis(market_name="demo")
    print(f"\nCompleted. {len(results)} task results received.")

    def _shutdown(sig, frame):
        pilot.shutdown()
        raise SystemExit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)
