# backend/accounting/ledger.py
"""
Double-entry accounting ledger.

Every journal posted produces zero-sum lines so that sum(balances.values()) == 0
at all times. Entry types:
  cash   → DR CASH:USD / CR EQUITY:CAPITAL
  trade  → buy:  DR POS:{sym} / CR CASH:USD
           sell: DR CASH:USD / CR POS:{sym} / CR PNL:REALIZED:{sym}
  m2m    → zero lines (memo)
  fee    → DR EXP:FEES / CR CASH:USD  (amount is the cash delta, negative = charge)
"""
from __future__ import annotations

import json
import time
from copy import deepcopy
from typing import Any, Dict, List, Optional, Tuple


class Ledger:

    def __init__(self):
        self._journals: Dict[str, Dict] = {}
        self._next_seq: int = 1

    # ------------------------------------------------------------------
    # Write API
    # ------------------------------------------------------------------

    def post(self, entry: Dict) -> str:
        seq = self._next_seq
        self._next_seq += 1
        journal_id = f"J{seq:08d}"
        lines = self._make_lines(entry)
        self._journals[journal_id] = {
            "id": journal_id,
            "seq": seq,
            "ts": int(entry.get("ts", int(time.time() * 1000))),
            "entry": deepcopy(entry),
            "lines": lines,
            "voided": False,
        }
        return journal_id

    def batch_post(self, entries: List[Dict]) -> List[str]:
        return [self.post(e) for e in entries]

    def void(self, journal_id: str, reason: str = "") -> Optional[str]:
        j = self._journals.get(journal_id)
        if j is None:
            return None
        j["voided"] = True
        j["void_reason"] = reason
        return journal_id

    # ------------------------------------------------------------------
    # Read API
    # ------------------------------------------------------------------

    def find(self, journal_id: str) -> Optional[Dict]:
        j = self._journals.get(journal_id)
        return deepcopy(j) if j else None

    def balances(self, as_of: Optional[int] = None) -> Dict[str, float]:
        result: Dict[str, float] = {}
        for j in self._journals.values():
            if j["voided"]:
                continue
            if as_of is not None and j["ts"] > as_of:
                continue
            for line in j["lines"]:
                acct = line["account"]
                result[acct] = result.get(acct, 0.0) + line["amount"]
        return result

    def position(self, symbol: str, as_of: Optional[int] = None) -> Dict:
        qty, cost = self._position_raw(symbol, as_of)
        avg = cost / qty if qty > 0 else 0.0
        return {"qty": qty, "avg_cost": avg, "symbol": symbol}

    def positions(self, as_of: Optional[int] = None) -> Dict[str, Dict]:
        symbols = {
            j["entry"]["symbol"]
            for j in self._journals.values()
            if not j["voided"]
            and (as_of is None or j["ts"] <= as_of)
            and j["entry"].get("type") == "trade"
            and j["entry"].get("symbol")
        }
        result = {}
        for sym in symbols:
            p = self.position(sym, as_of=as_of)
            if p["qty"] > 0:
                result[sym] = p
        return result

    def pnl(
        self,
        start: int,
        end: int,
        realized: bool = True,
        unrealized: bool = True,
    ) -> Dict[str, float]:
        realized_total = 0.0
        if realized:
            for j in self._journals.values():
                if j["voided"] or not (start <= j["ts"] <= end):
                    continue
                for line in j["lines"]:
                    if line["account"].startswith("PNL:REALIZED:"):
                        realized_total += -line["amount"]
        return {"realized": realized_total, "unrealized": 0.0, "total": realized_total}

    def cashflows(self, start: int, end: int) -> Dict:
        flows = []
        for j in sorted(self._journals.values(), key=lambda x: x["ts"]):
            if j["voided"] or not (start <= j["ts"] <= end):
                continue
            entry = j["entry"]
            if entry.get("type") == "cash":
                flows.append({
                    "ts": j["ts"],
                    "amount": float(entry.get("amount", 0)),
                    "desc": entry.get("desc", ""),
                    "account": "CASH:USD",
                })
        total = sum(f["amount"] for f in flows)
        return {"flows": flows, "total": total, "cash": total}

    def reconcile(self, broker_stmt: Dict) -> Dict:
        as_of = broker_stmt.get("as_of")
        broker_cash = broker_stmt.get("cash", {})
        broker_positions = broker_stmt.get("positions", {})

        bal = self.balances(as_of=as_of)
        diff: Dict = {}

        for currency, amount in broker_cash.items():
            ledger_val = bal.get(f"CASH:{currency}", 0.0)
            d = float(amount) - ledger_val
            if abs(d) > 0.01:
                diff[f"CASH:{currency}"] = {"broker": amount, "ledger": ledger_val, "diff": d}

        for sym, info in broker_positions.items():
            pos = self.position(sym, as_of=as_of)
            broker_qty = float(info.get("qty", 0))
            d = broker_qty - pos["qty"]
            if abs(d) > 0.01:
                diff[sym] = {"broker_qty": broker_qty, "ledger_qty": pos["qty"], "diff": d}

        status = "ok" if not diff else "mismatch"
        return {"diff": diff, "status": status, "actions": [] if not diff else ["investigate"]}

    def snapshot(self, as_of: Optional[int] = None) -> Dict:
        journals = {
            jid: deepcopy(j)
            for jid, j in self._journals.items()
            if as_of is None or j["ts"] <= as_of
        }
        return {"journals": journals, "next_seq": self._next_seq}

    def restore(self, blob: Any) -> None:
        if isinstance(blob, (bytes, bytearray)):
            blob = json.loads(blob.decode())
        self._journals = {jid: deepcopy(j) for jid, j in blob.get("journals", {}).items()}
        self._next_seq = int(blob.get("next_seq", len(self._journals) + 1))

    def export_json(self) -> Dict:
        return {"journals": list(self._journals.values()), "next_seq": self._next_seq}

    def import_json(self, blob: Any = None, **kw) -> None:
        if blob is None:
            blob = kw.get("blob")
        if isinstance(blob, str):
            blob = json.loads(blob)
        self._journals = {}
        for j in blob.get("journals", []):
            self._journals[j["id"]] = deepcopy(j)
        self._next_seq = int(blob.get("next_seq", len(self._journals) + 1))

    def lock(self, as_of: Optional[int] = None) -> bool:
        return True

    def reset(self) -> None:
        self.clear()

    def clear(self) -> None:
        self._journals.clear()
        self._next_seq = 1

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _sorted_journals(self, as_of: Optional[int] = None) -> List[Dict]:
        result = [
            j for j in self._journals.values()
            if not j["voided"] and (as_of is None or j["ts"] <= as_of)
        ]
        return sorted(result, key=lambda j: (j["ts"], j["seq"]))

    def _position_raw(self, symbol: str, as_of: Optional[int] = None) -> Tuple[float, float]:
        """Return (qty, cost_basis) for symbol up to as_of using weighted-average cost."""
        total_qty = 0.0
        total_cost = 0.0
        for j in self._sorted_journals(as_of):
            entry = j["entry"]
            if entry.get("type") != "trade" or entry.get("symbol") != symbol:
                continue
            qty = float(entry.get("qty", 0))
            if entry.get("side", "buy") == "buy":
                cost = next(
                    (line["amount"] for line in j["lines"]
                     if line["account"] == f"POS:{symbol}"),
                    qty * float(entry.get("price", 0)) + float(entry.get("fees", 0)),
                )
                total_qty += qty
                total_cost += cost
            else:
                if total_qty > 0:
                    avg = total_cost / total_qty
                    total_qty -= qty
                    total_cost -= qty * avg
        return total_qty, total_cost

    def _make_lines(self, entry: Dict) -> List[Dict]:
        """Build zero-sum double-entry lines for a single entry."""
        typ = entry.get("type", "")

        if typ == "cash":
            amount = float(entry.get("amount", 0))
            return [
                {"account": "CASH:USD", "amount": amount},
                {"account": "EQUITY:CAPITAL", "amount": -amount},
            ]

        if typ == "trade":
            symbol = str(entry.get("symbol", "UNKNOWN"))
            qty = float(entry.get("qty", 0))
            price = float(entry.get("price", 0))
            fees = float(entry.get("fees", 0))

            if entry.get("side", "buy") == "buy":
                cost = qty * price + fees
                return [
                    {"account": f"POS:{symbol}", "amount": cost},
                    {"account": "CASH:USD", "amount": -cost},
                ]
            else:
                proceeds = qty * price - fees
                curr_qty, curr_cost = self._position_raw(symbol)
                avg_cost = curr_cost / curr_qty if curr_qty > 0 else price
                cost_basis = qty * avg_cost
                realized_pnl = proceeds - cost_basis
                return [
                    {"account": "CASH:USD", "amount": proceeds},
                    {"account": f"POS:{symbol}", "amount": -cost_basis},
                    {"account": f"PNL:REALIZED:{symbol}", "amount": -realized_pnl},
                ]

        if typ == "m2m":
            return []

        if typ == "fee":
            amount = float(entry.get("amount", 0))
            return [
                {"account": "CASH:USD", "amount": amount},
                {"account": "EXP:FEES", "amount": -amount},
            ]

        return []
