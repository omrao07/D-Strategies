// observability/budgets.ts
// Lightweight budgets & usage telemetry (no deps).

/* ------------------------------- Types ---------------------------------- */

export type BudgetKind = "count" | "cost" | "duration";

export type Window =
  | { type: "fixed"; ms: number; align?: "utc-hour" | "utc-day" }
  | { type: "rolling"; ms: number }
  | { type: "bucket"; capacity: number; refillPerMs: number }; // token bucket

export type Threshold = {
  /** fraction 0..1 at which to trigger (e.g., 0.8 = 80%) */
  ratio: number;
  /** fire only once per window (default true) */
  once?: boolean;
  /** optional human tag */
  tag?: string;
};

export type BudgetSpec = {
  id: string;
  kind: BudgetKind;
  /** total allowance for the window (units depend on kind) */
  limit: number;
  window: Window;
  /** optional soft/hard thresholds in ascending order */
  thresholds?: Threshold[];
  /** if true, calls to `spend()` that exceed remaining will be rejected */
  hardEnforce?: boolean;
};

export type SpendEvent = {
  id: string;
  kind: BudgetKind;
  at: number;           // ms epoch
  amount: number;       // units (1=count, $=cost, ms=duration)
  ok: boolean;          // accepted by budget
  reason?: "limit" | "bucket-empty" | "other";
  used: number;         // total used after this event
  remaining: number;
  windowStart: number;
  windowEnd: number;
  thresholdFired?: string; // tag of threshold that fired (if any)
};

export type OnEvent = (e: SpendEvent) => void;

/* ------------------------------ Utilities ------------------------------- */

const now = () => Date.now();

function alignTime(t: number, ms: number, align?: "utc-hour" | "utc-day") {
  if (!align) return Math.floor(t / ms) * ms;
  const d = new Date(t);
  if (align === "utc-hour") {
    d.setUTCMinutes(0, 0, 0);
    return d.getTime();
  }
  // utc-day
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

/* ----------------------------- Budget state ----------------------------- */

export class Budget {
  readonly id: string;
  readonly kind: BudgetKind;
  readonly limit: number;
  readonly window: Window;
  readonly hardEnforce: boolean;
  private thresholds: Required<Threshold>[];

  private t0 = 0;          // window start
  private t1 = 0;          // window end
  private used = 0;        // sum in current window
  private fired = new Set<string>(); // thresholds fired in window

  // token bucket state (only used when window.type === "bucket")
  private bucketLevel = 0;
  private bucketUpdatedAt = 0;

  // telemetry helpers
  private emaBurn = 0;     // units/ms EMA
  private emaAlpha = 0.2;
  private lastSpendAt = 0;
  private onEvent?: OnEvent;

  constructor(spec: BudgetSpec, onEvent?: OnEvent) {
    this.id = spec.id;
    this.kind = spec.kind;
    this.limit = spec.limit;
    this.window = spec.window;
    this.hardEnforce = !!spec.hardEnforce;
    this.onEvent = onEvent;

    const th = (spec.thresholds ?? []).slice().sort((a, b) => a.ratio - b.ratio);
    this.thresholds = th.map((x, i) => ({
      ratio: clamp01(x.ratio),
      once: x.once ?? true,
      tag: x.tag ?? `t${Math.round((x.ratio ?? 0) * 100)}`,
    }));

    const t = now();
    this.resetWindow(t);
  }

  /* ------------------------------- Public -------------------------------- */

  /** Try to spend `amount` units. Returns event with acceptance status. */
  spend(amount: number, at = now()): SpendEvent {
    amount = Math.max(0, amount);

    // advance window/bucket
    this.roll(at);

    // enforce if requested
    let ok = true;
    let reason: SpendEvent["reason"] | undefined;

    if (this.window.type === "bucket") {
      if (this.bucketLevel < amount) {
        ok = false;
        reason = "bucket-empty";
      } else {
        this.bucketLevel -= amount;
      }
    } else {
      // fixed/rolling limit
      const remain = Math.max(0, this.limit - this.used);
      if (this.hardEnforce && amount > remain) {
        ok = false;
        reason = "limit";
      }
      if (ok) this.used += amount;
    }

    // telemetry
    const dt = this.lastSpendAt ? Math.max(1, at - this.lastSpendAt) : 0;
    if (dt && amount > 0) this.emaBurn = this.emaAlpha * (amount / dt) + (1 - this.emaAlpha) * this.emaBurn;
    this.lastSpendAt = at;

    // threshold detection (after apply so `used` is current)
    let fired: string | undefined;
    if (this.window.type !== "bucket") {
      const ratio = this.used / this.limit;
      for (const th of this.thresholds) {
        if (ratio >= th.ratio && (!th.once || !this.fired.has(th.tag))) {
          fired = th.tag;
          if (th.once) this.fired.add(th.tag);
          break; // only first in order
        }
      }
    }

    const ev: SpendEvent = {
      id: this.id,
      kind: this.kind,
      at,
      amount,
      ok,
      reason,
      used: this.window.type === "bucket" ? this.limit - this.bucketLevel : this.used,
      remaining:
        this.window.type === "bucket" ? this.bucketLevel : Math.max(0, this.limit - this.used),
      windowStart: this.t0,
      windowEnd: this.t1,
      thresholdFired: fired,
    };

    this.onEvent?.(ev);
    return ev;
  }

  /** Force set usage to a specific value (admin override). */
  setUsed(units: number, at = now()) {
    this.roll(at);
    if (this.window.type === "bucket") {
      this.bucketLevel = Math.max(0, Math.min(this.window.capacity, this.window.capacity - units));
    } else {
      this.used = Math.max(0, Math.min(this.limit, units));
    }
  }

  /** Get current snapshot. */
  snapshot(at = now()) {
    this.roll(at);
    const used = this.window.type === "bucket" ? this.limit - this.bucketLevel : this.used;
    const remaining =
      this.window.type === "bucket" ? this.bucketLevel : Math.max(0, this.limit - this.used);
    const pct = this.limit > 0 ? used / this.limit : 0;
    const msLeft = Math.max(0, this.t1 - at);
    const burnRate = this.emaBurn; // units/ms
    const projectedOver =
      burnRate > 0 ? Math.max(0, used + burnRate * msLeft - this.limit) : 0;

    return {
      id: this.id,
      kind: this.kind,
      window: this.window,
      windowStart: this.t0,
      windowEnd: this.t1,
      limit: this.limit,
      used,
      remaining,
      pct,
      msLeft,
      emaBurnPerSec: burnRate * 1000,
      projectedOver,
      thresholdsFired: Array.from(this.fired),
    };
  }

  /** Export minimal metrics row (good for logging/CSV). */
  toRow(at = now()) {
    const s = this.snapshot(at);
    return {
      id: s.id,
      kind: s.kind,
      start: s.windowStart,
      end: s.windowEnd,
      limit: s.limit,
      used: s.used,
      remaining: s.remaining,
      pct: +s.pct.toFixed(4),
      msLeft: s.msLeft,
      burnPerSec: +s.emaBurnPerSec.toFixed(6),
      projectedOver: +s.projectedOver.toFixed(4),
    };
  }

  /* --------------------------------- Core -------------------------------- */

  private roll(at: number) {
    if (this.window.type === "bucket") {
      // token bucket: refill continuously
      if (this.bucketUpdatedAt === 0) {
        this.bucketLevel = this.window.capacity;
        this.bucketUpdatedAt = at;
      } else if (at > this.bucketUpdatedAt) {
        const dt = at - this.bucketUpdatedAt;
        this.bucketLevel = Math.min(
          this.window.capacity,
          this.bucketLevel + dt * this.window.refillPerMs
        );
        this.bucketUpdatedAt = at;
      }
      // fixed window times for snapshot uniformity
      this.t0 = at;
      this.t1 = at + 1; // dummy
      return;
    }

    // fixed/rolling windows
    if (this.window.type === "fixed") {
      const wms = this.window.ms;
      const start = alignTime(at, wms, this.window.align);
      const end = start + wms;
      if (start !== this.t0 || end !== this.t1) {
        this.t0 = start; this.t1 = end;
        this.used = 0;
        this.fired.clear();
      }
    } else {
      // rolling window
      const wms = this.window.ms;
      // For space efficiency we don't store the whole history; we reset when crossing the window.
      // Callers should pass the full 'amount' each time; if you need exact rolling sums over many events,
      // use RollingBudget below.
      if (at - this.t0 > wms) {
        this.t0 = at - wms;
        this.t1 = at + 1;
        this.used = 0;
        this.fired.clear();
      } else {
        this.t1 = at + 1;
      }
    }
  }

  private resetWindow(at: number) {
    if (this.window.type === "bucket") {
      this.bucketLevel = this.window.capacity;
      this.bucketUpdatedAt = at;
      this.t0 = at; this.t1 = at + 1;
    } else if (this.window.type === "fixed") {
      const start = alignTime(at, this.window.ms, this.window.align);
      this.t0 = start;
      this.t1 = start + this.window.ms;
      this.used = 0;
      this.fired.clear();
    } else {
      this.t0 = at - this.window.ms;
      this.t1 = at + 1;
      this.used = 0;
      this.fired.clear();
    }
  }
}

/* ---------------------------- Rolling budget ---------------------------- */
/** Exact rolling-sum budget using a ring buffer of events (more memory). */
export class RollingBudget extends Budget {
  private buf: Array<{ t: number; a: number }> = [];
  private head = 0;
  private size = 0;
  private cap: number;

  constructor(spec: BudgetSpec & { window: Extract<Window, { type: "rolling" }> }, onEvent?: OnEvent) {
    super(spec, onEvent);
    // Rough capacity heuristic: allow ~120 events per second of window.
    this.cap = Math.max(256, Math.ceil((spec.window.ms / 1000) * 120));
    this.buf = new Array(this.cap);
  }

  override spend(amount: number, at = now()): SpendEvent {
    // purge old
    const w = (this as any).window as Extract<Window, { type: "rolling" }>;
    while (this.size) {
      const i = (this.head - this.size + this.cap) % this.cap;
      if (at - this.buf[i].t <= w.ms) break;
      (this as any).setUsed((this as any).snapshot(at).used - this.buf[i].a, at);
      this.size--;
    }

    // record new
    if (this.size < this.cap) {
      this.buf[this.head] = { t: at, a: amount };
      this.head = (this.head + 1) % this.cap;
      this.size++;
    }

    return super.spend(amount, at);
  }
}

/* ---------------------------- Multi-budget set -------------------------- */

export class BudgetSet {
  private map = new Map<string, Budget>();
  private onEvent?: OnEvent;

  constructor(budgets: BudgetSpec[] = [], onEvent?: OnEvent) {
    this.onEvent = onEvent;
    for (const b of budgets) this.add(b);
  }

  add(spec: BudgetSpec) {
    const ctor =
      spec.window.type === "rolling" ? RollingBudget : Budget;
    const b = new ctor(spec, this.onEvent);
    this.map.set(spec.id, b);
    return b;
  }

  get(id: string) {
    const b = this.map.get(id);
    if (!b) throw new Error(`Unknown budget: ${id}`);
    return b;
  }

  /** Spend across multiple budgets atomically; if any would fail with hardEnforce, none are applied. */
  spendAtomic(requests: Array<{ id: string; amount: number }>, at = now()) {
    // simulate
    const previews: Array<{ b: Budget; ev: SpendEvent }> = [];
    for (const r of requests) {
      const b = this.get(r.id);
      const snap = b.snapshot(at);
      // rough preview: rely on remaining
      const willFail = (b as any).window.type === "bucket"
        ? r.amount > snap.remaining
        : b["hardEnforce"] && r.amount > snap.remaining;
      if (willFail) return { ok: false, results: [] as SpendEvent[] };
      previews.push({ b, ev: b.spend(0, at) }); // no-op to sync windows
    }
    // apply
    const results = requests.map(({ id, amount }) => this.get(id).spend(amount, at));
    const ok = results.every((r) => r.ok);
    return { ok, results };
  }

  snapshots(at = now()) {
    return Array.from(this.map.values()).map((b) => b.snapshot(at));
  }

  rows(at = now()) {
    return this.snapshots(at).map((s) => ({
      id: s.id, kind: s.kind, start: s.windowStart, end: s.windowEnd,
      limit: s.limit, used: s.used, remaining: s.remaining, pct: +s.pct.toFixed(4),
    }));
  }
}

/* --------------------------------- Helpers ------------------------------- */
/** Convenience constructors */
export const windows = {
  fixedHour: (hours = 1, align: "utc-hour" | "utc-day" = "utc-hour"): Window =>
    ({ type: "fixed", ms: hours * 3600_000, align }),
  fixedDay: (days = 1): Window => ({ type: "fixed", ms: days * 86_400_000, align: "utc-day" }),
  rolling: (ms: number): Window => ({ type: "rolling", ms }),
  bucket: (capacity: number, perSec: number): Window =>
    ({ type: "bucket", capacity, refillPerMs: perSec / 1000 }),
};

/* --------------------------------- Example --------------------------------
const budgets = new BudgetSet(
  [
    { id: "api-calls", kind: "count", limit: 10000, window: windows.fixedDay(1),
      thresholds: [{ ratio: 0.8, tag: "warn" }, { ratio: 1.0, tag: "hard" }], hardEnforce: true },
    { id: "openai-cost", kind: "cost", limit: 50, window: windows.fixedDay(1),
      thresholds: [{ ratio: 0.9, tag: "near" }] },
    { id: "ingest-rps", kind: "count", limit: 100, window: windows.bucket(100, 50) }, // burst 100, refill 50/s
  ],
  (e) => {
    if (e.thresholdFired) console.warn(`[${e.id}] threshold ${e.thresholdFired} at ${(e.used / (e.used + e.remaining))*100|0}%`);
    if (!e.ok) console.error(`[${e.id}] rejected spend ${e.amount}: ${e.reason}`);
  }
);

// Spend:
budgets.get("api-calls").spend(1);         // count
budgets.get("openai-cost").spend(0.0123);  // $
budgets.get("ingest-rps").spend(1);        // token bucket
---------------------------------------------------------------------------- */
