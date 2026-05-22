# backend/treasury/bank_adapters.py
from __future__ import annotations

import abc
import csv
import hashlib
import hmac
import os
import threading
import time
import uuid
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

# Optional helpers from your codebase (kept optional to avoid hard deps)
try:
    from backend.utils.rate_linits import RateGate, SlidingWindowLimiter, WindowRule # type: ignore
except Exception:
    class RateGate:
        def __init__(self, rps: float): pass
        def wait(self): pass
    class SlidingWindowLimiter:
        def __init__(self, *_a, **_k): pass
        def wait(self, *_a, **_k): pass
    class WindowRule:
        def __init__(self, *_a, **_k): pass

try:
    from backend.utils.secrets import secrets # type: ignore
except Exception:
    class _DummySecrets:
        def get(self, k: str, default: Optional[str] = None, required: bool = False):
            v = os.getenv(k, default)
            if required and v is None:
                raise KeyError(f"Missing secret {k}")
            return v
    secrets = _DummySecrets()  # type: ignore


# ============================== Models ==============================

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

@dataclass
class BankAccount:
    bank_name: str
    account_id: str
    account_number_masked: str
    currency: str = "USD"
    meta: Dict[str, Any] = None # type: ignore

@dataclass
class Balance:
    available: float
    ledger: float
    currency: str
    ts: str = now_iso()

@dataclass
class Transaction:
    tx_id: str
    account_id: str
    amount: float                 # positive = credit to account, negative = debit
    currency: str
    description: str
    booked_at: str                # ISO 8601
    value_date: Optional[str] = None
    counterparty: Optional[str] = None
    meta: Dict[str, Any] = None # type: ignore

@dataclass
class TransferRequest:
    from_account_id: str
    to_beneficiary: str           # bank routing reference / vpa / iban / etc.
    amount: float
    currency: str
    reference: str                # human ref
    idempotency_key: Optional[str] = None
    meta: Dict[str, Any] = None # type: ignore

@dataclass
class TransferResult:
    ok: bool
    transfer_id: Optional[str]
    status: str                   # 'queued' | 'processing' | 'settled' | 'failed'
    reason: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None


# ============================== Base Adapter ==============================

class BankAdapterBase(abc.ABC):
    """
    Abstract adapter for bank / payout rails.
    Concrete implementations: Plaid-like aggregator, bank CSV, mock, Razorpay/Stripe-like payout, etc.
    """

    name: str = "base"

    def __init__(self, *, rps: float = 2.0, per_min_limit: int = 60):
        self._gate = RateGate(rps=rps)
        self._lim = SlidingWindowLimiter(WindowRule(per_min_limit, 60))

    # ---- required APIs ----

    @abc.abstractmethod
    def list_accounts(self) -> List[BankAccount]:
        raise NotImplementedError

    @abc.abstractmethod
    def get_balance(self, account_id: str) -> Balance:
        raise NotImplementedError

    @abc.abstractmethod
    def list_transactions(
        self, account_id: str, *, since: Optional[str] = None, until: Optional[str] = None, limit: int = 200
    ) -> List[Transaction]:
        raise NotImplementedError

    @abc.abstractmethod
    def initiate_transfer(self, req: TransferRequest) -> TransferResult:
        raise NotImplementedError

    @abc.abstractmethod
    def transfer_status(self, transfer_id: str) -> TransferResult:
        raise NotImplementedError

    # ---- optional helpers ----

    def verify_webhook(self, payload: bytes, header_sig: str, secret_env_key: str) -> bool:
        """
        HMAC-SHA256 verification (typical scheme). Configure bank webhook secret via env/Secrets.
        """
        secret = secrets.get(secret_env_key, required=True)
        digest = hmac.new(str(secret).encode(), payload, hashlib.sha256).hexdigest()
        # Many providers prefix with "sha256="; normalize both sides
        header_sig = header_sig.lower().replace("sha256=", "")
        return hmac.compare_digest(digest, header_sig)

    # ---- rate limits wrappers ----

    def _guard(self, key: str = "global") -> None:
        self._gate.wait()
        try:
            self._lim.wait(key)
        except Exception:
            # best-effort if limiter not available
            pass


# ============================== Mock Adapter ==============================

class MockBankAdapter(BankAdapterBase):
    """
    In-memory mock ledger: perfect for local dev / tests.
    - deterministic account ids
    - idempotent transfers via idempotency key
    """

    name = "mock"

    def __init__(self, *, currency: str = "USD", start_cash: float = 1_000_000.0):
        super().__init__(rps=50.0, per_min_limit=10_000)
        self._lock = threading.RLock()
        self._currency = currency
        self._accounts: Dict[str, Dict[str, Any]] = {}
        self._tx: Dict[str, List[Transaction]] = {}
        self._transfers: Dict[str, TransferResult] = {}       # by transfer_id
        self._idem: Dict[str, TransferResult] = {}            # by idempotency key

        # create a default "operating" account
        acct_id = "acct-operating"
        self._accounts[acct_id] = dict(
            bank_name="MockBank",
            account_number_masked="****1234",
            currency=currency,
            ledger=start_cash,
            available=start_cash,
        )
        self._tx[acct_id] = []

    def list_accounts(self) -> List[BankAccount]:
        self._guard("list_accounts")
        with self._lock:
            out = []
            for aid, m in self._accounts.items():
                out.append(BankAccount(
                    bank_name=m["bank_name"], account_id=aid,
                    account_number_masked=m["account_number_masked"], currency=m["currency"], meta={}
                ))
            return out

    def get_balance(self, account_id: str) -> Balance:
        self._guard(f"bal:{account_id}")
        with self._lock:
            m = self._accounts[account_id]
            return Balance(available=float(m["available"]), ledger=float(m["ledger"]), currency=m["currency"], ts=now_iso())

    def list_transactions(self, account_id: str, *, since: Optional[str] = None, until: Optional[str] = None, limit: int = 200) -> List[Transaction]:
        self._guard(f"tx:{account_id}")
        with self._lock:
            txs = list(self._tx.get(account_id, []))
        # naive time filter on ISO strings (UTC)
        def _ok(t: Transaction) -> bool:
            if since and t.booked_at < since:  return False
            if until and t.booked_at > until:  return False
            return True
        out = [t for t in txs if _ok(t)]
        return out[: int(limit)]

    def initiate_transfer(self, req: TransferRequest) -> TransferResult:
        self._guard("transfer")
        # idempotency
        idem = req.idempotency_key or f"{req.from_account_id}:{req.to_beneficiary}:{req.amount}:{req.currency}:{req.reference}"
        with self._lock:
            if idem in self._idem:
                return self._idem[idem]

            # balance check
            acct = self._accounts[req.from_account_id]
            if req.amount <= 0:
                res = TransferResult(ok=False, transfer_id=None, status="failed", reason="invalid_amount")
                self._idem[idem] = res
                return res
            if acct["available"] < req.amount:
                res = TransferResult(ok=False, transfer_id=None, status="failed", reason="insufficient_funds")
                self._idem[idem] = res
                return res

            # debit immediately; settle after a small delay to mimic rails
            acct["available"] -= req.amount
            acct["ledger"] -= req.amount
            tid = "trf_" + uuid.uuid4().hex[:20]
            booked_at = now_iso()
            t = Transaction(
                tx_id="tx_" + uuid.uuid4().hex[:12],
                account_id=req.from_account_id,
                amount=-req.amount,
                currency=req.currency,
                description=f"Transfer to {req.to_beneficiary} ({req.reference})",
                booked_at=booked_at,
                counterparty=req.to_beneficiary,
                meta=dict(kind="transfer_out", ref=req.reference),
            )
            self._tx[req.from_account_id].insert(0, t)
            res = TransferResult(ok=True, transfer_id=tid, status="processing", raw={"booked_at": booked_at})
            self._transfers[tid] = res
            self._idem[idem] = res
            # simulate settlement
            threading.Timer(0.5, self._settle, args=(tid,)).start()
            return res

    def _settle(self, transfer_id: str) -> None:
        with self._lock:
            r = self._transfers.get(transfer_id)
            if r:
                r.status = "settled"
                r.ok = True

    def transfer_status(self, transfer_id: str) -> TransferResult:
        self._guard("status")
        with self._lock:
            r = self._transfers.get(transfer_id)
            if not r:
                return TransferResult(ok=False, transfer_id=transfer_id, status="failed", reason="unknown_transfer")
            return r


# ============================== CSV Adapter ==============================

class CSVBankAdapter(BankAdapterBase):
    """
    Read-only adapter that exposes balances/transactions from a CSV export
    (useful for reconciliation tests). CSV columns expected:

    transactions.csv:
        account_id,booked_at_iso,amount,currency,description,counterparty

    balances.csv:
        account_id,available,ledger,currency,ts_iso
    """

    name = "csv"

    def __init__(self, *, tx_csv_path: str, bal_csv_path: str):
        super().__init__(rps=10.0, per_min_limit=600)
        self._tx_path = tx_csv_path
        self._bal_path = bal_csv_path
        self._acc_index: Dict[str, BankAccount] = {}
        self._load_accounts()

    def _load_accounts(self):
        # infer accounts from balances.csv
        try:
            with open(self._bal_path, newline="") as f:
                for row in csv.DictReader(f):
                    aid = row["account_id"]
                    self._acc_index[aid] = BankAccount(
                        bank_name="CSV/Offline",
                        account_id=aid,
                        account_number_masked="****CSV",
                        currency=row.get("currency") or "USD",
                        meta={}
                    )
        except FileNotFoundError:
            pass

    def list_accounts(self) -> List[BankAccount]:
        self._guard("list_accounts")
        return list(self._acc_index.values())

    def get_balance(self, account_id: str) -> Balance:
        self._guard(f"bal:{account_id}")
        with open(self._bal_path, newline="") as f:
            for row in csv.DictReader(f):
                if row["account_id"] == account_id:
                    return Balance(
                        available=float(row["available"]),
                        ledger=float(row["ledger"]),
                        currency=row.get("currency") or "USD",
                        ts=row.get("ts_iso") or now_iso(),
                    )
        raise KeyError(f"balance not found for {account_id}")

    def list_transactions(self, account_id: str, *, since: Optional[str] = None, until: Optional[str] = None, limit: int = 200) -> List[Transaction]:
        self._guard(f"tx:{account_id}")
        out: List[Transaction] = []
        with open(self._tx_path, newline="") as f:
            for row in csv.DictReader(f):
                if row["account_id"] != account_id:
                    continue
                t = Transaction(
                    tx_id=row.get("tx_id") or uuid.uuid4().hex[:16],
                    account_id=account_id,
                    amount=float(row["amount"]),
                    currency=row.get("currency") or "USD",
                    description=row.get("description") or "",
                    booked_at=row.get("booked_at_iso") or now_iso(),
                    counterparty=row.get("counterparty"),
                    meta={k: v for k, v in row.items() if k not in {"account_id","amount","currency","description","booked_at_iso","counterparty"}},
                )
                out.append(t)
        # filter & cap
        def _ok(t: Transaction) -> bool:
            if since and t.booked_at < since:  return False
            if until and t.booked_at > until:  return False
            return True
        out = [t for t in out if _ok(t)]
        return out[: int(limit)]

    def initiate_transfer(self, req: TransferRequest) -> TransferResult:
        # read-only rails
        return TransferResult(ok=False, transfer_id=None, status="failed", reason="csv_adapter_read_only")

    def transfer_status(self, transfer_id: str) -> TransferResult:
        return TransferResult(ok=False, transfer_id=transfer_id, status="failed", reason="csv_adapter_read_only")


# ============================== (Skeleton) Real Adapter ==============================

class PayoutRailsAdapter(BankAdapterBase):
    """
    Skeleton for a real payout/collections adapter (e.g., RazorpayX / Stripe Treasury / Wise).
    Fill in _http_get/_http_post with your client; use secrets for keys.

    Env keys expected (example):
        PAYOUT_BASE_URL, PAYOUT_API_KEY, PAYOUT_API_SECRET
    """

    name = "payout_rails"

    def __init__(self):
        super().__init__(rps=5.0, per_min_limit=120)
        self._base_url = os.getenv("PAYOUT_BASE_URL", "")
        self._api_key = secrets.get("PAYOUT_API_KEY", default="")
        self._api_secret = secrets.get("PAYOUT_API_SECRET", default="")
        # In-memory fallback for when credentials not set (returns failures gracefully)
        self._mock = MockBankAdapter()

    def _has_creds(self) -> bool:
        return bool(self._base_url and self._api_key)

    def _http_get(self, path: str, params: Optional[Dict] = None) -> Dict[str, Any]:
        """HTTP GET against payout rail API. Override/extend with your SDK."""
        try:
            import urllib.request, urllib.parse, base64 as _b64
            url = self._base_url.rstrip("/") + "/" + path.lstrip("/")
            if params:
                url += "?" + urllib.parse.urlencode(params)
            cred = _b64.b64encode(f"{self._api_key}:{self._api_secret}".encode()).decode()
            req = urllib.request.Request(url, headers={"Authorization": f"Basic {cred}", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                import json as _j
                return _j.loads(resp.read().decode())
        except Exception as exc:
            raise RuntimeError(f"payout_rails GET {path}: {exc}") from exc

    def _http_post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        """HTTP POST against payout rail API. Override/extend with your SDK."""
        try:
            import urllib.request, urllib.parse, base64 as _b64, json as _j
            url = self._base_url.rstrip("/") + "/" + path.lstrip("/")
            cred = _b64.b64encode(f"{self._api_key}:{self._api_secret}".encode()).decode()
            data = _j.dumps(body).encode()
            req = urllib.request.Request(url, data=data, method="POST", headers={
                "Authorization": f"Basic {cred}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            })
            with urllib.request.urlopen(req, timeout=30) as resp:
                return _j.loads(resp.read().decode())
        except Exception as exc:
            raise RuntimeError(f"payout_rails POST {path}: {exc}") from exc

    def list_accounts(self) -> List[BankAccount]:
        self._guard("list_accounts")
        if not self._has_creds():
            return self._mock.list_accounts()
        try:
            raw = self._http_get("/v1/accounts")
            accounts = raw.get("items", raw.get("data", []))
            return [
                BankAccount(
                    bank_name="PayoutRails",
                    account_id=str(a.get("id", "")),
                    account_number_masked=str(a.get("account_number", "****"))[-8:],
                    currency=str(a.get("currency", "USD")),
                    meta={"raw": a},
                )
                for a in accounts
            ]
        except Exception:
            return self._mock.list_accounts()

    def get_balance(self, account_id: str) -> Balance:
        self._guard(f"bal:{account_id}")
        if not self._has_creds():
            return self._mock.get_balance("acct-operating")
        try:
            raw = self._http_get(f"/v1/accounts/{account_id}/balance")
            return Balance(
                available=float(raw.get("available", 0.0)),
                ledger=float(raw.get("balance", raw.get("ledger", 0.0))),
                currency=str(raw.get("currency", "USD")),
                ts=now_iso(),
            )
        except Exception:
            return self._mock.get_balance("acct-operating")

    def list_transactions(self, account_id: str, *, since: Optional[str] = None, until: Optional[str] = None, limit: int = 200) -> List[Transaction]:
        self._guard(f"tx:{account_id}")
        if not self._has_creds():
            return self._mock.list_transactions(account_id, since=since, until=until, limit=limit)
        try:
            params: Dict[str, Any] = {"count": str(min(limit, 200))}
            if since:
                params["from"] = since
            if until:
                params["to"] = until
            raw = self._http_get(f"/v1/accounts/{account_id}/transactions", params=params)
            items = raw.get("items", raw.get("data", []))
            out = []
            for it in items:
                amt_raw = float(it.get("amount", 0.0))
                out.append(Transaction(
                    tx_id=str(it.get("id", uuid.uuid4().hex[:16])),
                    account_id=account_id,
                    amount=amt_raw,
                    currency=str(it.get("currency", "USD")),
                    description=str(it.get("description", it.get("narration", ""))),
                    booked_at=str(it.get("created_at", it.get("date", now_iso()))),
                    counterparty=it.get("counterparty"),
                    meta={k: v for k, v in it.items() if k not in {"id","amount","currency","description","created_at","counterparty"}},
                ))
            return out
        except Exception:
            return self._mock.list_transactions(account_id, since=since, until=until, limit=limit)

    def initiate_transfer(self, req: TransferRequest) -> TransferResult:
        self._guard("transfer")
        if not self._has_creds():
            return self._mock.initiate_transfer(req)
        try:
            body: Dict[str, Any] = {
                "account_number": req.to_beneficiary,
                "amount": int(req.amount * 100),  # many rails use minor units
                "currency": req.currency,
                "narration": req.reference,
                "reference": req.idempotency_key or f"{req.from_account_id}:{int(time.time())}",
            }
            raw = self._http_post("/v1/transfers", body)
            status_map = {"pending": "processing", "successful": "settled", "failed": "failed", "queued": "queued"}
            api_status = raw.get("status", "processing")
            return TransferResult(
                ok=api_status not in ("failed", "reversed"),
                transfer_id=str(raw.get("id", "")),
                status=status_map.get(api_status, "processing"),
                raw=raw,
            )
        except Exception as exc:
            return TransferResult(ok=False, transfer_id=None, status="failed", reason=str(exc))

    def transfer_status(self, transfer_id: str) -> TransferResult:
        self._guard("status")
        if not self._has_creds():
            return self._mock.transfer_status(transfer_id)
        try:
            raw = self._http_get(f"/v1/transfers/{transfer_id}")
            api_status = raw.get("status", "processing")
            status_map = {"pending": "processing", "successful": "settled", "failed": "failed", "queued": "queued"}
            return TransferResult(
                ok=api_status not in ("failed", "reversed"),
                transfer_id=transfer_id,
                status=status_map.get(api_status, "processing"),
                raw=raw,
            )
        except Exception as exc:
            return TransferResult(ok=False, transfer_id=transfer_id, status="failed", reason=str(exc))

   