# backend/finance/bank_adapters.py
from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Protocol, Tuple, runtime_checkable

# ---------- optional Redis (graceful fallback) ----------
HAVE_REDIS = True
try:
    from redis import Redis  # type: ignore
except Exception:
    HAVE_REDIS = False
    Redis = None  # type: ignore

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
STREAM_TREASURY = os.getenv("TREASURY_EVENTS_STREAM", "treasury.events")  # for UI

def _now_ms() -> int: return int(time.time() * 1000)
def _gen_id(prefix="txn") -> str: return f"{prefix}_{uuid.uuid4().hex[:16]}"

# ---------- Models ----------
@dataclass
class Balance:
    currency: str
    available: float
    current: float
    account_id: str
    ts_ms: int = field(default_factory=_now_ms)

@dataclass
class TransferRequest:
    idempotency_key: str
    amount: float
    currency: str
    from_account: str
    to_account: str
    rail: str              # "ACH" | "SWIFT" | "SEPA" | "NEFT" | "RTGS" | "UPI" | "WALLET" | "INTERNAL"
    desc: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class TransferStatus:
    transfer_id: str
    state: str             # "created"|"queued"|"processing"|"completed"|"failed"|"canceled"
    amount: float
    currency: str
    rail: str
    fees: float = 0.0
    fx_rate: Optional[float] = None
    error: Optional[str] = None
    created_ms: int = field(default_factory=_now_ms)
    updated_ms: int = field(default_factory=_now_ms)
    raw: Dict[str, Any] = field(default_factory=dict)

@dataclass
class StatementLine:
    ts_ms: int
    amount: float
    currency: str
    type: str               # "credit"|"debit"
    description: str
    balance_after: Optional[float] = None
    counterparty: Optional[str] = None
    ref: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict)

# ---------- Adapter Protocol ----------
@runtime_checkable
class BankAdapter(Protocol):
    name: str
    sandbox: bool

    def get_balances(self) -> List[Balance]: ...
    def get_statements(self, account_id: str, since_ms: int, until_ms: int) -> List[StatementLine]: ...
    def create_transfer(self, req: TransferRequest) -> TransferStatus: ...
    def get_transfer(self, transfer_id: str) -> TransferStatus: ...
    def quote_fx(self, pair: str, side: str, notional: float) -> Tuple[float, float]: # type: ignore
        """Return (rate, est_fee). pair like 'USD/INR'. side 'buy'/'sell' vs base."""
    def verify_webhook(self, body: bytes, headers: Dict[str, str]) -> bool: ...

# ---------- tiny backend for events / KV ----------
class _Backend:
    def __init__(self, redis_url: Optional[str] = None):
        self.r = None
        if HAVE_REDIS:
            try:
                self.r = Redis.from_url(redis_url or REDIS_URL, decode_responses=True)  # type: ignore
                self.r.ping()
            except Exception:
                self.r = None

    def kv_get(self, key: str) -> Optional[str]:
        if self.r:
            try: return self.r.get(key)  # type: ignore
            except Exception: pass
        return None

    def kv_set(self, key: str, val: str, ttl: int = 0) -> None:
        if self.r:
            try:
                if ttl > 0: self.r.setex(key, ttl, val)  # type: ignore
                else: self.r.set(key, val)  # type: ignore
                return
            except Exception:
                pass

    def emit(self, typ: str, obj: Dict[str, Any]) -> None:
        if self.r:
            try:
                self.r.xadd(STREAM_TREASURY, {"json": json.dumps({"type": typ, **obj})},
                            maxlen=50_000, approximate=True)  # type: ignore
            except Exception:
                pass

_backend = _Backend()

# =========================================================
# MOCK / SANDBOX ADAPTERS (run today without bank creds)
# =========================================================
class MockBank(BankAdapter):
    """
    In-memory bank: great for local dev & tests.
    - Supports INTERNAL, WALLET, UPI (instant), ACH/SEPA (T+1), SWIFT/NEFT/RTGS (same-day-ish).
    - Has a toy FX book with a stable spread.
    """
    name = "mockbank"
    sandbox = True

    def __init__(self):
        self._balances: Dict[str, Balance] = {
            "CASH_USD": Balance("USD", available=1_000_000.0, current=1_000_000.0, account_id="CASH_USD"),
            "CASH_INR": Balance("INR", available=50_000_000.0, current=50_000_000.0, account_id="CASH_INR"),
        }
        self._tx: Dict[str, TransferStatus] = {}
        self._statements: Dict[str, List[StatementLine]] = {k: [] for k in self._balances}

    # ---- accounts ----
    def get_balances(self) -> List[Balance]:
        return list(self._balances.values())

    def get_statements(self, account_id: str, since_ms: int, until_ms: int) -> List[StatementLine]:
        arr = self._statements.get(account_id, [])
        return [s for s in arr if since_ms <= s.ts_ms <= until_ms]

    # ---- payments ----
    def create_transfer(self, req: TransferRequest) -> TransferStatus:
        # idempotency
        idem_key = f"treasury:idemp:{self.name}:{req.idempotency_key}"
        seen = _backend.kv_get(idem_key)
        if seen:
            return self._tx[seen]

        tid = _gen_id("trf")
        fees = self._fee_for(req.rail, req.amount, req.currency)
        ok, err = self._debit(req.from_account, req.amount, req.currency, f"Transfer to {req.to_account} ({req.rail})")
        state = "queued" if ok else "failed"
        status = TransferStatus(
            transfer_id=tid, state=state, amount=req.amount, currency=req.currency,
            rail=req.rail, fees=fees, raw={"meta": req.metadata, "to": req.to_account}
        )
        self._tx[tid] = status
        _backend.kv_set(idem_key, tid, ttl=86_400)
        _backend.emit("transfer.created", {"adapter": self.name, **asdict(status)})

        if ok:
            # simulate settlement
            settle_ms = 5_000 if req.rail in ("UPI", "WALLET", "INTERNAL") else 30_000
            self._schedule(lambda: self._complete(tid, req), delay_ms=settle_ms)
        return status

    def get_transfer(self, transfer_id: str) -> TransferStatus:
        st = self._tx.get(transfer_id)
        if not st:
            raise KeyError(f"unknown transfer {transfer_id}")
        return st

    # ---- FX ----
    def quote_fx(self, pair: str, side: str, notional: float) -> Tuple[float, float]:
        base, quote = pair.upper().split("/")
        mid = self._fx_mid(base, quote)
        spread = 0.002 if notional < 1_000_000 else 0.001
        rate = mid * (1 + spread/2) if side.lower()=="buy" else mid * (1 - spread/2)
        fee  = max(1.0, 0.0002 * notional)  # 2 bps, min $1
        return (round(rate, 6), round(fee, 2))

    # ---- webhook (none for mock) ----
    def verify_webhook(self, body: bytes, headers: Dict[str, str]) -> bool:
        return True

    # ---- internals ----
    def _fee_for(self, rail: str, amt: float, ccy: str) -> float:
        rail = rail.upper()
        if rail in ("UPI","INTERNAL","WALLET"): return 0.0
        if rail in ("ACH","SEPA"): return 0.5
        if rail in ("NEFT","RTGS"): return 2.0
        if rail == "SWIFT": return 15.0
        return 1.0

    def _debit(self, acct: str, amt: float, ccy: str, desc: str) -> Tuple[bool, Optional[str]]:
        b = self._balances.get(acct)
        if not b or b.currency != ccy:
            return False, "account_not_found_or_ccy_mismatch"
        if b.available < amt:
            return False, "insufficient_funds"
        b.available -= amt; b.current -= amt
        self._statements[acct].append(StatementLine(ts_ms=_now_ms(), amount=-amt, currency=ccy, type="debit",
                                                    description=desc, balance_after=b.current))
        return True, None

    def _credit(self, acct: str, amt: float, ccy: str, desc: str):
        b = self._balances.setdefault(acct, Balance(ccy, 0.0, 0.0, acct))
        b.available += amt; b.current += amt
        self._statements[acct] = self._statements.get(acct, [])
        self._statements[acct].append(StatementLine(ts_ms=_now_ms(), amount=+amt, currency=ccy, type="credit",
                                                    description=desc, balance_after=b.current))

    def _complete(self, tid: str, req: TransferRequest):
        st = self._tx[tid]
        st.state = "completed"; st.updated_ms = _now_ms()
        # internal counterpart credit
        self._credit(req.to_account, req.amount - st.fees, req.currency, f"Transfer from {req.from_account} ({req.rail})")
        _backend.emit("transfer.completed", {"adapter": self.name, **asdict(st)})

    def _schedule(self, fn, delay_ms: int):
        import threading
        t = threading.Timer(delay_ms/1000.0, fn)
        t.daemon = True
        t.start()

    def _fx_mid(self, base: str, quote: str) -> float:
        # toy rates
        table = {
            ("USD","INR"): 83.25,
            ("INR","USD"): 1/83.25,
            ("USD","EUR"): 0.92,
            ("EUR","USD"): 1/0.92,
        }
        return table.get((base,quote), 1.0)

# ---------------------------------------------------------
class SandboxUPI(BankAdapter):
    """
    Emulates UPI-like push payments + webhooks (HMAC signed).
    Env:
      UPI_WEBHOOK_SECRET = "hexsecret"
    """
    name = "sandbox_upi"
    sandbox = True

    def __init__(self):
        self._bal = Balance("INR", 5_000_000.0, 5_000_000.0, account_id="UPI_WALLET")
        self._tx: Dict[str, TransferStatus] = {}

    def get_balances(self) -> List[Balance]:
        return [self._bal]

    def get_statements(self, account_id: str, since_ms: int, until_ms: int) -> List[StatementLine]:
        return []

    def create_transfer(self, req: TransferRequest) -> TransferStatus:
        tid = _gen_id("upi")
        st = TransferStatus(transfer_id=tid, state="completed", amount=req.amount, currency=req.currency, rail="UPI")
        self._tx[tid] = st
        _backend.emit("upi.transfer", {"adapter": self.name, **asdict(st)})
        return st

    def get_transfer(self, transfer_id: str) -> TransferStatus:
        return self._tx[transfer_id]

    def quote_fx(self, pair: str, side: str, notional: float) -> Tuple[float, float]:
        return (1.0, 0.0)

    def verify_webhook(self, body: bytes, headers: Dict[str, str]) -> bool:
        secret = os.getenv("UPI_WEBHOOK_SECRET", "")
        sig = headers.get("x-upi-signature", "")
        mac = hmac.new(bytes.fromhex(secret) if secret else b"", body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(mac, sig)

# =========================================================
# REAL-WORLD STUBS (fill with actual SDK/API later)
# =========================================================
# --- Optional Plaid SDK ---
try:
    import datetime as _plaid_dt

    import plaid  # type: ignore # pip install plaid-python
    from plaid.api import plaid_api as _plaid_api  # type: ignore
    from plaid.model.accounts_balance_get_request import (
        AccountsBalanceGetRequest as _PlaidBalReq,  # type: ignore
    )
    from plaid.model.transactions_get_request import (
        TransactionsGetRequest as _PlaidTxnReq,  # type: ignore
    )
    from plaid.model.transactions_get_request_options import (
        TransactionsGetRequestOptions as _PlaidTxnOpts,  # type: ignore
    )
    _HAVE_PLAID = True
except Exception:
    _HAVE_PLAID = False


class PlaidBalanceOnly(BankAdapter):
    """
    Read-only adapter using Plaid API (balances + transactions).
    Set env vars: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ACCESS_TOKEN, PLAID_ENV (sandbox|development|production)
    Falls back to empty lists if credentials not set.
    """
    name = "plaid"
    sandbox = True

    def __init__(self):
        self._client_id = os.getenv("PLAID_CLIENT_ID", "")
        self._secret = os.getenv("PLAID_SECRET", "")
        self._access_token = os.getenv("PLAID_ACCESS_TOKEN", "")
        self._env = os.getenv("PLAID_ENV", "sandbox")
        self.sandbox = self._env != "production"
        self._client = None
        if _HAVE_PLAID and self._client_id and self._secret:
            env_map = {
                "sandbox": plaid.Environment.Sandbox,
                "development": plaid.Environment.Development,
                "production": plaid.Environment.Production,
            }
            cfg = plaid.Configuration(
                host=env_map.get(self._env, plaid.Environment.Sandbox),
                api_key={"clientId": self._client_id, "secret": self._secret},
            )
            self._client = _plaid_api.PlaidApi(plaid.ApiClient(cfg))

    def get_balances(self) -> List[Balance]:
        if not self._client or not self._access_token:
            return []
        try:
            resp = self._client.accounts_balance_get(_PlaidBalReq(access_token=self._access_token))
            out = []
            for acct in resp.accounts:
                balances = acct.balances
                out.append(Balance(
                    currency=balances.iso_currency_code or "USD",
                    available=float(balances.available or 0.0),
                    current=float(balances.current or 0.0),
                    account_id=acct.account_id,
                ))
            return out
        except Exception:
            return []

    def get_statements(self, account_id: str, since_ms: int, until_ms: int) -> List[StatementLine]:
        if not self._client or not self._access_token:
            return []
        try:
            start = _plaid_dt.date.fromtimestamp(since_ms / 1000)
            end = _plaid_dt.date.fromtimestamp(until_ms / 1000)
            opts = _PlaidTxnOpts(account_ids=[account_id]) if account_id else _PlaidTxnOpts()
            resp = self._client.transactions_get(
                _PlaidTxnReq(access_token=self._access_token, start_date=start, end_date=end, options=opts)
            )
            out = []
            for txn in resp.transactions:
                ts = int(_plaid_dt.datetime.combine(txn.date, _plaid_dt.time()).timestamp() * 1000)
                amount = float(txn.amount or 0.0)
                out.append(StatementLine(
                    ts_ms=ts,
                    amount=abs(amount),
                    currency=txn.iso_currency_code or "USD",
                    type="debit" if amount > 0 else "credit",
                    description=txn.name or "",
                    counterparty=txn.merchant_name,
                    ref=txn.transaction_id,
                    raw={"category": txn.category},
                ))
            return out
        except Exception:
            return []

    def create_transfer(self, req: TransferRequest) -> TransferStatus:
        raise NotImplementedError("Plaid is read-only; use a payment rail adapter for transfers")

    def get_transfer(self, transfer_id: str) -> TransferStatus:
        raise NotImplementedError("Plaid does not support transfer status queries in read-only mode")

    def quote_fx(self, pair: str, side: str, notional: float) -> Tuple[float, float]:
        return (math.nan, math.nan)

    def verify_webhook(self, body: bytes, headers: Dict[str, str]) -> bool:
        return True

class PrimeBrokerStub(BankAdapter):
    """
    Example prime-broker/clearing stub (think: IBKR, GS PB, etc.) for treasury moves.
    Implement using the broker's wire/transfer endpoints.
    """
    name = "prime_pb"
    sandbox = True

    def get_balances(self) -> List[Balance]: return []
    def get_statements(self, account_id: str, since_ms: int, until_ms: int) -> List[StatementLine]: return []
    def create_transfer(self, req: TransferRequest) -> TransferStatus:
        # TODO: implement PB wire request
        raise NotImplementedError
    def get_transfer(self, transfer_id: str) -> TransferStatus:
        raise NotImplementedError
    def quote_fx(self, pair: str, side: str, notional: float) -> Tuple[float, float]:
        # PB usually quotes RFQ; leave blank
        return (math.nan, math.nan)
    def verify_webhook(self, body: bytes, headers: Dict[str, str]) -> bool: return True

# =========================================================
# Factory / Router
# =========================================================
class BankRouter:
    """
    Manages multiple adapters, routes by name or policy.
    """
    def __init__(self):
        self.adapters: Dict[str, BankAdapter] = {}
        # register built-ins
        self.register(MockBank())
        self.register(SandboxUPI())
        self.register(PlaidBalanceOnly())
        self.register(PrimeBrokerStub())

    def register(self, adapter: BankAdapter) -> None:
        self.adapters[adapter.name] = adapter

    def get(self, name: str) -> BankAdapter:
        if name not in self.adapters:
            raise KeyError(f"unknown bank adapter '{name}'")
        return self.adapters[name]

    # convenience wrappers
    def balances(self) -> Dict[str, List[Balance]]:
        return {name: a.get_balances() for name, a in self.adapters.items()}

    def fx_quote_best(self, pair: str, side: str, notional: float) -> Tuple[str, float, float]:
        best_name, best_rate, best_fee = None, None, None
        for name, a in self.adapters.items():
            try:
                rate, fee = a.quote_fx(pair, side, notional)
                if rate != rate:   # NaN guard
                    continue
                if best_rate is None or (side.lower()=="buy" and rate < best_rate) or (side.lower()=="sell" and rate > best_rate):
                    best_name, best_rate, best_fee = name, rate, fee
            except Exception:
                continue
        if best_name is None:
            raise RuntimeError("no FX quote available")
        return best_name, best_rate, best_fee # type: ignore

# =========================================================
# CLI (handy for ops)
# =========================================================
def _cli():
    import argparse
    ap = argparse.ArgumentParser("bank_adapters")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("balances")
    fx = sub.add_parser("fx")
    fx.add_argument("--pair", required=True)      # e.g., USD/INR
    fx.add_argument("--side", default="buy")
    fx.add_argument("--notional", type=float, default=100000)

    tr = sub.add_parser("transfer")
    tr.add_argument("--adapter", default="mockbank")
    tr.add_argument("--from", dest="from_acct", required=True)
    tr.add_argument("--to", dest="to_acct", required=True)
    tr.add_argument("--amt", type=float, required=True)
    tr.add_argument("--ccy", default="USD")
    tr.add_argument("--rail", default="INTERNAL")
    tr.add_argument("--idem", default=None)

    args = ap.parse_args()
    r = BankRouter()

    if args.cmd == "balances":
        out = {name: [asdict(b) for b in bals] for name, bals in r.balances().items()}
        print(json.dumps(out, indent=2))

    elif args.cmd == "fx":
        name, rate, fee = r.fx_quote_best(args.pair, args.side, args.notional)
        print(json.dumps({"best_adapter": name, "rate": rate, "fee": fee}, indent=2))

    elif args.cmd == "transfer":
        ad = r.get(args.adapter)
        req = TransferRequest(
            idempotency_key=args.idem or _gen_id("idem"),
            amount=args.amt,
            currency=args.ccy,
            from_account=args.from_acct,
            to_account=args.to_acct,
            rail=args.rail.upper(),
            desc=f"CLI transfer via {ad.name}",
        )
        st = ad.create_transfer(req)
        print(json.dumps(asdict(st), indent=2))

if __name__ == "__main__":
    _cli()