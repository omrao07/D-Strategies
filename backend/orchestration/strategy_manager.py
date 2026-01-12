#!/usr/bin/env python3
from __future__ import annotations

import importlib
import json
import logging
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import pandas as pd

from orchestration.modes import ModeController, RunMode, ControlMode, RiskLimits
from orchestration.ts_utils import ensure_dir, utc_now_ts, sleep_secs

# --------------------------------------------------------------------------------------
# Paths & logging
# --------------------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[1]

REGISTRY_DIR = REPO_ROOT / "strategies" / "registry"
CONFIGS_DIR  = REPO_ROOT / "strategies" / "configs"
RUNTIME_DIR  = REPO_ROOT / "runtime"
STATE_DIR    = RUNTIME_DIR / "state"
LOG_DIR      = RUNTIME_DIR / "logs"
CACHE_DIR    = REPO_ROOT / "data" / "cache"

ensure_dir(STATE_DIR)
ensure_dir(LOG_DIR)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_DIR / "strategy_manager.log", mode="a")
    ],
)

log = logging.getLogger("strategy_manager")

# --------------------------------------------------------------------------------------
# Data models
# --------------------------------------------------------------------------------------

@dataclass
class StrategySpec:
    id: str
    name: str
    family: str
    engine: str
    yaml: str
    control_mode: str = "SEMI_AUTO"
    run_mode: str = "PAPER"
    tags: List[str] = field(default_factory=list)
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class StrategyState:
    last_ts: int = 0
    health: str = "INIT"
    errors: int = 0
    trades_sent_today: float = 0.0
    positions: Dict[str, float] = field(default_factory=dict)
    nav: float = 1_000_000.0
    pnl_day: float = 0.0
    pnl_cum: float = 0.0


@dataclass
class StrategyHandle:
    spec: StrategySpec
    adapter: Any
    controller: ModeController
    state: StrategyState = field(default_factory=StrategyState)
    yaml_path: Path = Path()
    on_fills: Optional[Callable[[pd.DataFrame], None]] = None
    on_signals: Optional[Callable[[Dict[str, Any]], None]] = None
    on_error: Optional[Callable[[Exception], None]] = None

# --------------------------------------------------------------------------------------
# Registry helpers
# --------------------------------------------------------------------------------------

def _read_registry() -> pd.DataFrame:
    csv_path = REGISTRY_DIR / "all_strategies_master_fullnames.csv"
    jsonl_path = REGISTRY_DIR / "all_strategies_master_fullnames.jsonl"

    if jsonl_path.exists():
        rows = [json.loads(l) for l in jsonl_path.read_text().splitlines() if l.strip()]
        df = pd.DataFrame(rows)
        if not df.empty:
            return df

    if csv_path.exists():
        return pd.read_csv(csv_path)

    raise FileNotFoundError("Strategy registry file not found")


def _safe_yaml(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    import yaml
    with path.open("r") as f:
        return yaml.safe_load(f) or {}


def _import_obj(path: str):
    if ":" in path:
        mod, name = path.split(":", 1)
        return getattr(importlib.import_module(mod), name)
    mod = importlib.import_module(path)
    return getattr(mod, "Adapter")

# --------------------------------------------------------------------------------------
# Orchestrator
# --------------------------------------------------------------------------------------

class Orchestrator:
    """
    Full strategy orchestration engine.
    """

    def __init__(self, run_mode: RunMode = RunMode.PAPER):
        self.run_mode = run_mode
        self._handles: Dict[str, StrategyHandle] = {}
        ensure_dir(STATE_DIR)

    # ---------------- Registry loading ----------------

    def load_from_registry(
        self,
        family: Optional[str] = None,
        ids: Optional[List[str]] = None,
        tags: Optional[List[str]] = None,
        limit: Optional[int] = None,
        default_limits: Optional[RiskLimits] = None,
    ) -> List[str]:

        df = _read_registry()

        if ids:
            df = df[df["id"].isin(ids)]

        if family:
            df = df[df["family"].str.lower() == family.lower()]

        if tags:
            tagset = {t.lower() for t in tags}
            def has_tags(x):
                if not isinstance(x, str):
                    return False
                toks = {t.strip().lower() for t in x.split("|")}
                return bool(tagset & toks)
            df = df[df["tags"].apply(has_tags)]

        if limit:
            df = df.iloc[:limit]

        created: List[str] = []

        for _, r in df.iterrows():
            spec = StrategySpec(
                id=str(r["id"]),
                name=str(r.get("name", r["id"])),
                family=str(r.get("family", "unknown")),
                engine=str(r.get("engine")),
                yaml=str(r.get("yaml", "")),
                control_mode=str(r.get("control_mode", "SEMI_AUTO")).upper(),
                run_mode=str(r.get("run_mode", self.run_mode.name)).upper(),
                tags=[t.strip() for t in str(r.get("tags", "")).split("|") if t.strip()],
            )

            self._handles[spec.id] = self._build_handle(spec, default_limits)
            created.append(spec.id)

        log.info(f"Loaded {len(created)} strategies: {created}")
        return created

    def _build_handle(self, spec: StrategySpec, default_limits: Optional[RiskLimits]) -> StrategyHandle:
        yaml_path = (CONFIGS_DIR / spec.yaml) if spec.yaml else (CONFIGS_DIR / f"{spec.id}.yaml")
        cfg_yaml = _safe_yaml(yaml_path)

        Adapter = _import_obj(spec.engine)
        adapter = Adapter(**cfg_yaml.get("adapter_kwargs", {}))

        limits = default_limits or RiskLimits()

        controller = ModeController(
            run_mode=RunMode[spec.run_mode],
            control_mode=ControlMode[spec.control_mode],
            limits=limits,
            get_position=lambda name, sid=spec.id: self.get_position(sid, name),
            get_traded_today=lambda sid=spec.id: self.get_traded_today(sid),
            logger=lambda msg, sid=spec.id: log.info(f"[{sid}] {msg}")
        )

        return StrategyHandle(
            spec=spec,
            adapter=adapter,
            controller=controller,
            yaml_path=yaml_path
        )

    # ---------------- State helpers ----------------

    def get_position(self, sid: str, base: str) -> float:
        return float(self._handles[sid].state.positions.get(base, 0.0))

    def get_traded_today(self, sid: str) -> float:
        return float(self._handles[sid].state.trades_sent_today)

    # ---------------- Lifecycle ----------------

    def warmup_all(self) -> None:
        for sid, h in self._handles.items():
            try:
                h.adapter.warmup()
                h.state.health = "WARMED"
                log.info(f"[{sid}] warmed")
            except Exception as e:
                h.state.health = "ERROR"
                h.state.errors += 1
                log.exception(f"[{sid}] warmup failed: {e}")
                if h.on_error:
                    h.on_error(e)

    def tick_once(self, sid: str, router_send: Optional[Callable[[pd.DataFrame], pd.DataFrame]] = None) -> Dict[str, Any]:
        h = self._handles[sid]
        now = int(time.time())

        # MTM
        try:
            mtm = h.adapter.mark_to_market(h.state, now)
            inc = float(mtm.get("pnl_usd", 0.0))
            h.state.pnl_day += inc
            h.state.pnl_cum += inc
            h.state.last_ts = now
        except Exception as e:
            h.state.health = "ERROR"
            h.state.errors += 1
            log.exception(f"[{sid}] mark_to_market failed: {e}")
            return {"error": str(e)}

        # Signals
        try:
            sigs = h.adapter.generate_signals(now) or {}
        except Exception as e:
            h.state.health = "ERROR"
            h.state.errors += 1
            log.exception(f"[{sid}] generate_signals failed: {e}")
            return {"error": str(e)}

        # Trades
        try:
            proposed = h.adapter.propose_trades(h.state, now)
            if proposed is None or len(proposed) == 0:
                return {"signals": sigs, "pnl_inc$": inc, "routed": 0}

            gated = h.controller.process_orders(proposed)
            approved = gated["approved"]
            queued = gated["queued"]
            rejected = gated["rejected"]

        except Exception as e:
            h.state.health = "ERROR"
            h.state.errors += 1
            log.exception(f"[{sid}] trade processing failed: {e}")
            return {"error": str(e)}

        fills_df = pd.DataFrame()

        if not approved.empty:
            if router_send:
                fills_df = router_send(approved)
            else:
                rows = []
                for _, r in approved.iterrows():
                    rows.append({
                        "ticker": str(r["ticker"]),
                        "side": str(r["side"]),
                        "filled_usd": float(r["trade_notional"]),
                        "status": "FILLED",
                        "avg_price_bps": float(r.get("px_hint_bps", 0.0)),
                        "ts": now
                    })
                fills_df = pd.DataFrame(rows)

        if not fills_df.empty:
            for _, f in fills_df.iterrows():
                signed = float(f["filled_usd"]) if "BUY" in str(f["side"]).upper() else -float(f["filled_usd"])
                base = base_symbol(str(f["ticker"]))
                h.state.positions[base] = h.state.positions.get(base, 0.0) + signed
                h.state.trades_sent_today += abs(float(f["filled_usd"]))

            if hasattr(h.adapter, "apply_fills"):
                try:
                    h.adapter.apply_fills(fills_df)
                except Exception:
                    pass

        h.state.health = "RUNNING"

        return {
            "signals": sigs,
            "approved_n": len(approved),
            "queued_n": len(queued),
            "rejected_n": len(rejected),
            "fills_n": len(fills_df),
            "pnl_inc$": inc,
            "positions": dict(h.state.positions),
        }

    def tick_all(self, router_send: Optional[Callable[[pd.DataFrame], pd.DataFrame]] = None) -> Dict[str, Dict[str, Any]]:
        return {sid: self.tick_once(sid, router_send) for sid in self._handles.keys()}

    # ---------------- Persistence ----------------

    def save_snapshot(self, path: Optional[Path] = None) -> Path:
        path = path or (STATE_DIR / "strategy_manager_snapshot.json")

        blob = {
            sid: {
                "spec": asdict(h.spec),
                "state": asdict(h.state),
                "control": h.controller.describe(),
            }
            for sid, h in self._handles.items()
        }

        path.write_text(json.dumps(blob, indent=2))
        return path

    def load_snapshot(self, path: Optional[Path] = None) -> None:
        path = path or (STATE_DIR / "strategy_manager_snapshot.json")
        if not path.exists():
            return

        data = json.loads(path.read_text())
        for sid, d in data.items():
            if sid in self._handles:
                self._handles[sid].state = StrategyState(**d.get("state", {}))

    # ---------------- Hooks ----------------

    def set_hooks(
        self,
        sid: str,
        *,
        on_fills: Optional[Callable[[pd.DataFrame], None]] = None,
        on_signals: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:

        h = self._handles[sid]
        if on_fills: h.on_fills = on_fills
        if on_signals: h.on_signals = on_signals
        if on_error: h.on_error = on_error

    def handles(self) -> Dict[str, StrategyHandle]:
        return self._handles

# --------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------

def base_symbol(ticker: str) -> str:
    parts = str(ticker).split("_")
    return "_".join(parts[:2]) if len(parts) >= 2 else parts[0]

# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------

if __name__ == "__main__":
    mgr = Orchestrator(run_mode=RunMode.PAPER)
    mgr.load_from_registry(limit=3, default_limits=RiskLimits(
        max_gross_usd=25_000_000,
        max_name_usd=5_000_000,
        max_daily_turnover_usd=10_000_000,
        allow_short=True
    ))
    mgr.warmup_all()
    print(json.dumps(mgr.tick_all(), indent=2))