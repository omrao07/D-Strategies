// observability/slo.ts
// Lightweight, import-free SLO/SLI tracking utilities.
// - Rolling window counters (minute buckets by default)
// - Availability & latency SLIs (plus a generic ratio SLI)
// - Error budget math: remaining/consumed/forecast
// - Multi-window burn-rate alerts (e.g., 5m/1h, 30m/6h)
// - Text summary + JSON snapshot
//
// Usage:
//   const slo = new SLO({
//     name: "api-availability",
//     target: 0.995,          // 99.5%
//     kind: "availability",
//     windowDays: 30,
//     bucketMs: 60_000,       // minute buckets
//     alerts: [               // classic multi-window policy
//       { shortMinutes: 5, longMinutes: 60, burnLimit: 14.4 },  // fast burn
//       { shortMinutes: 30, longMinutes: 360, burnLimit: 6   }, // slow burn
//     ],
//   });
//
//   // Record events (true=good, false=bad)
//   slo.record({ ok: true });                         // availability SLI
//   slo.record({ ok: false, reason: "5xx" });
//
//   // Latency SLI: good if ok && latency<=thresholdMs
//   const latencySlo = new SLO({
//     name: "api-latency-200ms",
//     target: 0.99,
//     kind: "latency",
//     windowDays: 28,
//     thresholdMs: 200,
//   });
//   latencySlo.record({ ok: true, latencyMs: 123 });  // counted as good
//
//   console.log(slo.summary());           // human-readable
//   console.log(JSON.stringify(slo.snapshot(), null, 2)); // machine-readable

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Dict<T = any> = Record<string, T>;

export type SLIKind = "availability" | "latency" | "custom_ratio";

export interface SLOAlertPolicy {
  /** Short window in minutes (e.g., 5) */
  shortMinutes: number;
  /** Long window in minutes (e.g., 60) */
  longMinutes: number;
  /**
   * Burn limit: alert if (errRateShort / allowedErrRate) / (errRateLong / allowedErrRate) >= burnLimit
   * i.e., shortTermBurn / longTermBurn >= burnLimit  (typical values: 6, 14.4)
   */
  burnLimit: number;
  name?: string;
}

export interface SLOConfig {
  name: string;
  target: number;        // 0..1 (e.g., 0.995)
  kind: SLIKind;
  windowDays: number;    // rolling window size in days
  bucketMs?: number;     // default 60_000 (per minute)
  thresholdMs?: number;  // for latency kind
  alerts?: SLOAlertPolicy[];
  meta?: Dict;
}

export interface RecordInput {
  ok: boolean;
  /** Optional latency for latency SLI (ms). If omitted, treated as +Inf (bad if threshold defined). */
  latencyMs?: number;
  /** Optional classification */
  reason?: string;
  /** Optional timestamp override (ms since epoch) */
  atMs?: number;
}

export interface SLOSnapshot {
  name: string;
  kind: SLIKind;
  asOf: string;
  windowStart: string;
  target: number;
  allowedErrorRate: number; // (1 - target)
  totals: {
    good: number;
    bad: number;
    total: number;
  };
  sli: {
    value: number; // good/total in window
    errorRate: number; // bad/total
  };
  budget: {
    allowedErrors: number;  // total * (1-target)
    spentErrors: number;    // bad
    remainingErrors: number;// allowed - spent (can go <0)
    remainingPct: number;   // remainingErrors/allowedErrors (0..1, may be <0)
  };
  burn: {
    // Overall burn = (bad/total) / (1 - target)
    overall: number; // 1.0 means on track, >1.0 overspending
    short?: number;  // from first alert policy
    long?: number;   // from first alert policy
  };
  alerts: Array<{ policy: string; shortBurn: number; longBurn: number; ratio: number }>;
  meta?: Dict;
}

/////////////////////////////
// Rolling counters (ring)
/////////////////////////////

type Bucket = {
  t: number;  // bucket timestamp (bucket start ms)
  good: number;
  bad: number;
};

class Rolling {
  private buckets: Bucket[];
  private bucketMs: number;
  private capacity: number; // number of buckets
  private zero: Bucket = { t: 0, good: 0, bad: 0 };

  constructor(windowMs: number, bucketMs: number) {
    this.bucketMs = Math.max(1_000, Math.floor(bucketMs || 60_000));
    this.capacity = Math.max(2, Math.ceil(windowMs / this.bucketMs) + 2);
    this.buckets = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.buckets[i] = { t: 0, good: 0, bad: 0 };
  }

  private idx(ts: number): number {
    const slot = Math.floor(ts / this.bucketMs) % this.capacity;
    return slot < 0 ? (slot + this.capacity) % this.capacity : slot;
  }

  /** Add counts to the bucket corresponding to ts. */
  add(ts: number, good: number, bad: number) {
    const i = this.idx(ts);
    const bucketStart = Math.floor(ts / this.bucketMs) * this.bucketMs;
    const b = this.buckets[i];
    if (b.t !== bucketStart) {
      b.t = bucketStart;
      b.good = 0;
      b.bad = 0;
    }
    b.good += good;
    b.bad += bad;
  }

  /** Sum counts over the last `rangeMs` ending at `now`. */
  sum(now: number, rangeMs: number): { good: number; bad: number; total: number; start: number } {
    const earliest = now - rangeMs;
    let good = 0, bad = 0;
    for (const b of this.buckets) {
      if (b.t >= earliest && b.t <= now && (b.good || b.bad)) {
        good += b.good;
        bad += b.bad;
      }
    }
    return { good, bad, total: good + bad, start: Math.max(0, Math.floor(earliest / this.bucketMs) * this.bucketMs) };
  }

  /** Reset all buckets. */
  clear() { for (const b of this.buckets) { b.t = 0; b.good = 0; b.bad = 0; } }
}

/////////////////////////////
// SLO
/////////////////////////////

export class SLO {
  readonly name: string;
  readonly kind: SLIKind;
  readonly target: number;         // 0..1
  readonly windowDays: number;
  readonly bucketMs: number;
  readonly thresholdMs?: number;
  readonly meta?: Dict;
  private roll: Rolling;
  private alerts: SLOAlertPolicy[];

  constructor(cfg: SLOConfig) {
    this.name = cfg.name;
    this.kind = cfg.kind;
    this.target = clamp01(cfg.target);
    this.windowDays = Math.max(1, Math.floor(cfg.windowDays));
    this.bucketMs = Math.max(1_000, Math.floor(cfg.bucketMs ?? 60_000));
    this.thresholdMs = cfg.thresholdMs;
    this.meta = cfg.meta;
    this.alerts = (cfg.alerts || []).map(n => ({
      shortMinutes: Math.max(1, Math.floor(n.shortMinutes)),
      longMinutes: Math.max(1, Math.floor(n.longMinutes)),
      burnLimit: Math.max(0, Number(n.burnLimit) || 0),
      name: n.name || `${n.shortMinutes}m/${n.longMinutes}m`,
    }));
    const windowMs = this.windowDays * 24 * 60 * 60_000;
    this.roll = new Rolling(windowMs, this.bucketMs);
  }

  /** Record an observation for the SLI. */
  record(ev: RecordInput): void {
    const ts = toNow(ev.atMs);
    let good = 0, bad = 0;

    if (this.kind === "availability" || this.kind === "custom_ratio") {
      good = ev.ok ? 1 : 0;
      bad = ev.ok ? 0 : 1;
    } else if (this.kind === "latency") {
      const thr = this.thresholdMs ?? Number.POSITIVE_INFINITY;
      const lat = Number.isFinite(ev.latencyMs as number) ? (ev.latencyMs as number) : Number.POSITIVE_INFINITY;
      const ok = !!ev.ok && lat <= thr;
      good = ok ? 1 : 0;
      bad = ok ? 0 : 1;
    } else {
      // default to availability semantics
      good = ev.ok ? 1 : 0;
      bad = ev.ok ? 0 : 1;
    }

    this.roll.add(ts, good, bad);
  }

  /** Returns a machine-readable snapshot for the full window (as of now). */
  snapshot(nowMs?: number): SLOSnapshot {
    const now = toNow(nowMs);
    const windowMs = this.windowDays * 24 * 60 * 60_000;
    const allowedErr = Math.max(1e-12, 1 - this.target); // avoid div-by-zero
    const sums = this.roll.sum(now, windowMs);
    const good = sums.good;
    const bad = sums.bad;
    const total = Math.max(0, good + bad);
    const value = total > 0 ? good / total : 1;
    const errorRate = total > 0 ? bad / total : 0;

    const allowedErrors = total * allowedErr;
    const spentErrors = bad;
    const remainingErrors = allowedErrors - spentErrors;
    const remainingPct = allowedErrors > 0 ? remainingErrors / allowedErrors : 1;

    const overallBurn = allowedErr > 0 ? (errorRate / allowedErr) : 0;

    // Compute burns for first policy (convenience fields)
    let shortBurn: number | undefined;
    let longBurn: number | undefined;

    const alerts: SLOSnapshot["alerts"] = [];
    for (const p of this.alerts) {
      const s = this.roll.sum(now, p.shortMinutes * 60_000);
      const l = this.roll.sum(now, p.longMinutes * 60_000);
      const errS = s.total > 0 ? s.bad / s.total : 0;
      const errL = l.total > 0 ? l.bad / l.total : 0;
      const bS = allowedErr > 0 ? errS / allowedErr : 0;
      const bL = allowedErr > 0 ? errL / allowedErr : 0;
      const ratio = bL > 0 ? bS / bL : (bS > 0 ? Number.POSITIVE_INFINITY : 0);

      if (shortBurn == null) shortBurn = bS;
      if (longBurn == null) longBurn = bL;

      if (ratio >= p.burnLimit && p.burnLimit > 0) {
        alerts.push({ policy: p.name || `${p.shortMinutes}m/${p.longMinutes}m`, shortBurn: bS, longBurn: bL, ratio });
      }
    }

    return {
      name: this.name,
      kind: this.kind,
      asOf: new Date(now).toISOString(),
      windowStart: new Date(sums.start).toISOString(),
      target: this.target,
      allowedErrorRate: allowedErr,
      totals: { good, bad, total },
      sli: { value, errorRate },
      budget: {
        allowedErrors,
        spentErrors,
        remainingErrors,
        remainingPct,
      },
      burn: { overall: overallBurn, short: shortBurn, long: longBurn },
      alerts,
      meta: this.meta,
    };
  }

  /** Human-readable one-liner summary. */
  summary(nowMs?: number): string {
    const s = this.snapshot(nowMs);
    const pct = (s.sli.value * 100).toFixed(3);
    const tgt = (s.target * 100).toFixed(3);
    const rem = (Math.max(0, s.budget.remainingPct) * 100).toFixed(1);
    const burn = s.burn.overall.toFixed(2);
    const alertStr = s.alerts.length ? ` ALERTS=${s.alerts.map(a => `${a.policy}@${a.ratio.toFixed(2)}`).join(",")}` : "";
    return `${s.name} sli=${pct}% target=${tgt}% err_budget_remaining=${rem}% burn=${burn}${alertStr}`;
  }

  /** Reset all internal buckets (useful for tests). */
  reset(): void { this.roll.clear(); }
}

/////////////////////////////
// Registry (manage many)
/////////////////////////////

export class SLORegistry {
  private map = new Map<string, SLO>();
  add(slo: SLO): this { if (this.map.has(slo.name)) throw new Error(`SLO exists: ${slo.name}`); this.map.set(slo.name, slo); return this; }
  get(name: string): SLO | undefined { return this.map.get(name); }
  all(): SLO[] { return Array.from(this.map.values()); }
  /** Text block (Prometheus-ish) with multiple SLOs summarized. */
  summarize(): string { return this.all().map(s => s.summary()).join("\n") + (this.map.size ? "\n" : ""); }
  /** NDJSON lines (one per SLO snapshot). */
  ndjson(nowMs?: number): string {
    const ts = toNow(nowMs);
    return this.all().map(s => JSON.stringify(s.snapshot(ts))).join("\n") + (this.map.size ? "\n" : "");
  }
}

/////////////////////////////
// Helpers
/////////////////////////////

function clamp01(x: number): number { const n = Number(x); return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)); }
function toNow(n?: number): number { const t = Number(n); return Number.isFinite(t) ? Math.floor(t) : Date.now(); }

/////////////////////////////
// Minimal example (commented)
/*
const slo = new SLO({
  name: "availability-99_9",
  target: 0.999,
  kind: "availability",
  windowDays: 30,
  alerts: [
    { shortMinutes: 5, longMinutes: 60, burnLimit: 14.4, name: "fast-burn" },
    { shortMinutes: 30, longMinutes: 360, burnLimit: 6,   name: "slow-burn" },
  ]
});

for (let i = 0; i < 1000; i++) slo.record({ ok: true });
for (let i = 0; i < 2; i++) slo.record({ ok: false, reason: "5xx" });

console.log(slo.summary());
console.log(JSON.stringify(slo.snapshot(), null, 2));
*/