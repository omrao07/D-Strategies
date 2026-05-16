# backend/risk/policy_engine.py
"""
Rule-based policy engine for pre-trade order checks.

Evaluates a priority-ordered list of rules against an incoming order and
context dict, returning an action ("allow", "modify", "block") plus any
modifications to the order, block reasons, and alerts.

Rule evaluation order:
  1. Rules are sorted by priority descending (highest first).
  2. Admin override (any rule with then.override=True) is detected in a
     pre-pass; it suppresses non-kill-switch blocks.
  3. Modifier rules (max_notional, cap_price_pct, rate_limit) are applied
     regardless of whether an "allow" has already been decided.
  4. Once a session-allow fires, subsequent "block" action rules are skipped
     (but modifier rules still run).
  5. kill-switch cannot be bypassed by any override.
"""
from __future__ import annotations

import time
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


class PolicyEngine:

    def __init__(self):
        self._rules: List[Dict] = []
        self._rate_buckets: Dict[str, List[float]] = {}
        self._audit: List[Dict] = []
        self._state_extras: Dict[str, Any] = {}

    # ------------------------------------------------------------------
    # Policy management
    # ------------------------------------------------------------------

    def load_policies(self, policies: Dict) -> None:
        raw = policies.get("rules", policies) if isinstance(policies, dict) else policies
        self._rules = sorted(raw, key=lambda r: -r.get("priority", 0))
        self._rate_buckets = {}
        self._audit = []

    def reload(self, policies: Optional[Dict] = None) -> None:
        if policies is not None:
            self.load_policies(policies)

    # ------------------------------------------------------------------
    # Core evaluation
    # ------------------------------------------------------------------

    def evaluate(self, order: Dict, context: Optional[Dict] = None, dry_run: bool = False) -> Dict:
        ctx = context or {}
        orig_order = dict(order)
        order_out = dict(order)
        reasons: List[str] = []
        alerts: List[str] = []

        # Pre-pass: is admin override applicable?
        is_admin_override = any(
            rule.get("then", {}).get("override") and
            self._matches(rule.get("when", {}), orig_order, ctx)
            for rule in self._rules
        )

        resolved = False  # True once an "allow" action rule fires

        for rule in self._rules:
            when = rule.get("when", {})
            then = rule.get("then", {})
            rule_id = rule.get("id", "")

            if not self._matches(when, orig_order, ctx):
                continue

            rule_action = then.get("action")

            # Override rules are pre-pass only
            if then.get("override"):
                continue

            # ── Block ──────────────────────────────────────────────────
            if rule_action == "block" and not resolved:
                is_hard_stop = (rule_id == "kill-switch")
                if is_hard_stop or not is_admin_override:
                    reasons.append(then.get("reason", rule_id))
                    self._record(orig_order, "block", dry_run)
                    return {"action": "block", "order": order_out,
                            "reasons": reasons, "alerts": alerts}
                # Admin override suppresses this block

            # ── Allow ──────────────────────────────────────────────────
            elif rule_action == "allow":
                if not resolved:
                    resolved = True
                if then.get("alert"):
                    alerts.append(then["alert"])

            # ── Modifiers (run regardless of resolved) ─────────────────

            # Cap price within ref_price ± pct
            if then.get("cap_price_pct"):
                ref = float(ctx.get("ref_price", 0))
                if ref > 0 and not resolved:
                    cap = float(then["cap_price_pct"])
                    price = float(order_out.get("price", 0) or 0)
                    new_price = max(ref * (1 - cap), min(ref * (1 + cap), price))
                    if new_price != price:
                        order_out["price"] = new_price
                        if then.get("alert") and then.get("alert") not in alerts:
                            alerts.append(then["alert"])

            # Clamp notional
            if then.get("max_notional") and not resolved:
                max_n = float(then["max_notional"])
                price = float(order_out.get("price", 0) or 0)
                qty = float(orig_order.get("qty", 0) or 0)
                if price > 0 and qty * price > max_n:
                    order_out["qty"] = max_n / price

            # Rate limit
            if then.get("rate_limit"):
                rl = then["rate_limit"]
                n, per_s = int(rl["n"]), float(rl["per_s"])
                rate_key = str(ctx.get("user", "default"))
                now_ts = time.time()
                bucket = [t for t in self._rate_buckets.get(rate_key, [])
                          if now_ts - t < per_s]
                if len(bucket) >= n:
                    self._record(orig_order, "block", dry_run)
                    return {"action": "block", "order": order_out,
                            "reasons": ["rate_limit_exceeded"], "alerts": alerts}
                if not dry_run:
                    bucket.append(now_ts)
                self._rate_buckets[rate_key] = bucket

        # Determine final action
        modified = order_out != orig_order
        if dry_run:
            action = "allow"  # dry-run gives allow/block verdict, not modification detail
        else:
            action = "modify" if modified else "allow"
        self._record(orig_order, action, dry_run)
        return {"action": action, "order": order_out, "reasons": reasons, "alerts": alerts}

    # ------------------------------------------------------------------
    # State / audit
    # ------------------------------------------------------------------

    def get_state(self) -> Dict:
        return {"rate_buckets": deepcopy(self._rate_buckets), **self._state_extras}

    def set_state(self, state: Dict) -> None:
        self._state_extras = {k: v for k, v in state.items() if k != "rate_buckets"}
        self._rate_buckets = deepcopy(state.get("rate_buckets", {}))

    def get_audit(self, since_ts: Optional[int] = None) -> List[Dict]:
        if since_ts is None:
            return list(self._audit)
        return [e for e in self._audit if e.get("ts", 0) >= since_ts]

    def clear(self) -> None:
        self._rate_buckets = {}
        self._audit = []

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _record(self, order: Dict, action: str, dry_run: bool) -> None:
        if not dry_run:
            self._audit.append({
                "ts": int(time.time() * 1000),
                "order": dict(order),
                "action": action,
            })

    def _matches(self, when: Dict, order: Dict, ctx: Dict) -> bool:
        """Return True if every condition in `when` is satisfied."""
        if not when:
            return True

        for k, v in when.items():
            # ── env checks ─────────────────────────────────────────────
            if k == "env.kill":
                if ctx.get("env", {}).get("kill") != v:
                    return False

            # ── order field checks ─────────────────────────────────────
            elif k == "order.type":
                if order.get("type") != v:
                    return False

            elif k == "order.symbol.in":
                if order.get("symbol") not in v:
                    return False

            elif k == "order.qty_gte":
                try:
                    if float(order.get("qty", 0)) < float(v):
                        return False
                except (TypeError, ValueError):
                    return False

            # ── ctx field checks ───────────────────────────────────────
            elif k.endswith(".exists"):
                field = k[:-7]  # strip ".exists"
                if field.startswith("ctx."):
                    key = field[4:]
                    if key not in ctx:
                        return False

            elif k == "ctx.leverage_gt":
                try:
                    if float(ctx.get("leverage", 0)) <= float(v):
                        return False
                except (TypeError, ValueError):
                    return False

            elif k == "ctx.exposure_symbol_gt":
                sym_field = v.get("field", "").replace("order.", "")
                limit = float(v.get("limit", 0))
                symbol = order.get(sym_field, "")
                if ctx.get("exposures", {}).get(symbol, 0) <= limit:
                    return False

            elif k == "ctx.rate_key":
                # "user" means: rate-key is ctx["user"] — condition matches if user present
                if v == "user" and "user" not in ctx:
                    return False

            elif k == "ctx.role.in":
                vals = v if isinstance(v, list) else [v]
                if ctx.get("role") not in vals:
                    return False

            # ── time checks ────────────────────────────────────────────
            elif k == "time.between_utc":
                now_ms = ctx.get("now_utc", 0)
                if not now_ms:
                    return False
                try:
                    now_dt = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)
                    now_mins = now_dt.hour * 60 + now_dt.minute
                    sh, sm = map(int, str(v[0]).split(":"))
                    eh, em = map(int, str(v[1]).split(":"))
                    if not (sh * 60 + sm <= now_mins <= eh * 60 + em):
                        return False
                except Exception:
                    return False

        return True
