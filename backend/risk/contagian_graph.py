# backend/risk/contagian_graph.py
"""
Interbank contagion propagation engine.

Classes: ContagionGraph, Bank, Exposure, ShockParams
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set


@dataclass
class Bank:
    id: str
    equity: float
    liquid_assets: float
    illiquid_assets: float
    liabilities: float
    defaulted: bool = False


@dataclass
class Exposure:
    lender: str
    borrower: str
    amount: float
    recovery_rate: float = 0.4


@dataclass
class ShockParams:
    recovery_rate: float = 0.4
    rounds: int = 10


class ContagionGraph:
    """
    Interbank contagion graph.

    add_bank(id, equity, liquid_assets, illiquid_assets, liabilities)
    add_exposure(lender, borrower, amount, recovery_rate=0.4)
    set_default(bank_id, flag=True)
    step(recovery_rate=None) -> bool    # True if anything was propagated
    run(max_rounds=10, recovery_rate=None) -> list[dict]
    banks: dict[str, Bank]
    """

    def __init__(self) -> None:
        self.banks: Dict[str, Bank] = {}
        self.exposures: List[Exposure] = []
        self._processed: Set[str] = set()

    def add_bank(
        self,
        id: str,
        equity: float,
        liquid_assets: float,
        illiquid_assets: float,
        liabilities: float,
        **kw: Any,
    ) -> Bank:
        b = Bank(
            id=id,
            equity=float(equity),
            liquid_assets=float(liquid_assets),
            illiquid_assets=float(illiquid_assets),
            liabilities=float(liabilities),
        )
        self.banks[id] = b
        return b

    def add_exposure(
        self,
        lender: str,
        borrower: str,
        amount: float,
        recovery_rate: float = 0.4,
        **kw: Any,
    ) -> Exposure:
        e = Exposure(lender=lender, borrower=borrower, amount=float(amount), recovery_rate=float(recovery_rate))
        self.exposures.append(e)
        return e

    def set_default(self, bank_id: str, flag: bool = True) -> None:
        if bank_id in self.banks:
            self.banks[bank_id].defaulted = bool(flag)
            if not flag:
                self._processed.discard(bank_id)

    def get_bank(self, bank_id: str) -> Bank:
        return self.banks[bank_id]

    def step(self, recovery_rate: Optional[float] = None) -> bool:
        """
        One propagation round.  For each bank that has defaulted but whose
        losses haven't yet been applied, reduce every lender's equity by
        (1 - recovery_rate) * exposure.amount.  Returns True if any
        banks were processed.
        """
        to_process = [
            bid for bid, b in self.banks.items()
            if b.defaulted and bid not in self._processed
        ]
        if not to_process:
            return False

        newly_defaulted: List[str] = []
        for defaulted_id in to_process:
            self._processed.add(defaulted_id)
            for exp in self.exposures:
                if exp.borrower != defaulted_id:
                    continue
                lender = self.banks.get(exp.lender)
                if lender is None or lender.defaulted:
                    continue
                rr = recovery_rate if recovery_rate is not None else exp.recovery_rate
                loss = (1.0 - rr) * exp.amount
                lender.equity -= loss
                if lender.equity <= 0:
                    lender.equity = 0.0
                    if not lender.defaulted:
                        lender.defaulted = True
                        newly_defaulted.append(lender.id)

        return True

    def run(self, max_rounds: int = 10, recovery_rate: Optional[float] = None) -> List[Dict[str, Any]]:
        frames: List[Dict[str, Any]] = []
        for _ in range(max_rounds):
            changed = self.step(recovery_rate)
            frame = {
                bid: {"equity": b.equity, "defaulted": b.defaulted}
                for bid, b in self.banks.items()
            }
            frames.append(frame)
            if not changed:
                break
        return frames
