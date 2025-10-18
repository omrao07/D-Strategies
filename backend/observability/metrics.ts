// observability/metrics.ts
// Minimal, import-free metrics registry with Counters, Gauges, Histograms, and Timers.
// Features
// - In-memory registry (thread-safe enough for Node single-threaded event loop)
// - Labelled series (static label names at creation; arbitrary label values per sample)
// - Prometheus text exposition (OpenMetrics-ish text format)
// - Simple timer helper (start/stop → histogram seconds)
// - Basic percentiles from decaying reservoir (optional)
//
// Strict-TS friendly. No external deps.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Dict<T = any> = Record<string, T>;

type Num = number;
type Ts = number; // epoch ms

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricBase {
  name: string;
  help?: string;
  type: MetricType;
  labelNames?: string[];
  unit?: string; // e.g., "seconds", "bytes"
}

export interface CounterSeries { value: Num; created: Ts; }
export interface GaugeSeries   { value: Num; created: Ts; }
export interface HistSeries    {
  count: number;
  sum: number;
  buckets: number[];       // cumulative counts for bucket boundaries
  boundaries: number[];    // sorted ascending bucket upper bounds (seconds by default)
  created: Ts;
  // Optional reservoir for approximate quantiles (P2-like tiny tracker)
  p2?: P2Quantiles;
}

export type Series = CounterSeries | GaugeSeries | HistSeries;

export interface MetricRecord extends MetricBase {
  series: Map<string, Series>; // key = encoded label values
}

export interface RegistryOptions {
  defaultBuckets?: number[]; // histogram upper bounds (seconds)
  enableP2?: boolean;        // track p50/p90/p99 for histograms
}

export class MetricsRegistry {
  private metrics = new Map<string, MetricRecord>();
  private defaultBuckets: number[];
  private enableP2: boolean;

  constructor(opts: RegistryOptions = {}) {
    // Prometheus default-ish (seconds)
    this.defaultBuckets = (opts.defaultBuckets && opts.defaultBuckets.length
      ? [...opts.defaultBuckets].sort((a, b) => a - b)
      : [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]).filter(isFiniteNum);
    if (!this.defaultBuckets.length || this.defaultBuckets[this.defaultBuckets.length - 1] !== Number.POSITIVE_INFINITY) {
      this.defaultBuckets.push(Number.POSITIVE_INFINITY);
    }
    this.enableP2 = !!opts.enableP2;
  }

  // ---------- Counter ----------

  counter(name: string, help?: string, labelNames: string[] = []): Counter {
    const rec = this.ensureMetric({ name, help, type: "counter", labelNames });
    return new Counter(this, rec);
  }

  // ---------- Gauge ----------

  gauge(name: string, help?: string, labelNames: string[] = []): Gauge {
    const rec = this.ensureMetric({ name, help, type: "gauge", labelNames });
    return new Gauge(this, rec);
  }

  // ---------- Histogram ----------

  histogram(name: string, help?: string, labelNames: string[] = [], buckets?: number[], unit = "seconds"): Histogram {
    const rec = this.ensureMetric({
      name, help, type: "histogram", labelNames, unit
    }) as MetricRecord;
    // attach boundaries to metadata via a hidden symbol map
    (rec as any)._boundaries = sanitizeBuckets(buckets || this.defaultBuckets);
    return new Histogram(this, rec);
  }

  // ---------- Export ----------

  /** Prometheus text exposition format (UTF-8). */
  toPrometheus(): string {
    const lines: string[] = [];
    for (const rec of this.metrics.values()) {
      const help = rec.help ? rec.help.replace(/\n/g, " ") : undefined;
      if (help) lines.push(`# HELP ${rec.name} ${help}`);
      lines.push(`# TYPE ${rec.name} ${rec.type}`);
      if (rec.type === "histogram") {
        for (const [key, s] of rec.series.entries()) {
          const { labels, labelStr } = parseKey(key);
          const hs = s as HistSeries;
          // buckets
          let cumulative = 0;
          for (let i = 0; i < hs.boundaries.length; i++) {
            cumulative = hs.buckets[i];
            const le = hs.boundaries[i];
            lines.push(`${rec.name}_bucket${labelStrWith(labelStr, { le: fmtBoundary(le) })} ${cumulative}`);
          }
          // sum & count
          lines.push(`${rec.name}_sum${labelStr} ${num(hs.sum)}`);
          lines.push(`${rec.name}_count${labelStr} ${hs.count}`);
          // optional quantiles
          if (hs.p2) {
            const qs = [
              ["0.5", hs.p2.p(0.5)],
              ["0.9", hs.p2.p(0.9)],
              ["0.99", hs.p2.p(0.99)],
            ] as const;
            for (const [q, v] of qs) {
              lines.push(`${rec.name}_quantile${labelStrWith(labelStr, { quantile: q })} ${num(v)}`);
            }
          }
        }
      } else {
        for (const [key, s] of rec.series.entries()) {
          const { labelStr } = parseKey(key);
          const value = (s as any).value;
          lines.push(`${rec.name}${labelStr} ${num(value)}`);
        }
      }
    }
    return lines.join("\n") + "\n";
  }

  // ---------- Internals ----------

  get recordCount(): number { return this.metrics.size; }

  _getOrCreateSeries(rec: MetricRecord, labels: Dict<string>): Series {
    const key = seriesKey(rec.labelNames || [], labels);
    let s = rec.series.get(key);
    if (s) return s;

    const now = Date.now();
    if (rec.type === "counter") {
      s = { value: 0, created: now } as CounterSeries;
    } else if (rec.type === "gauge") {
      s = { value: 0, created: now } as GaugeSeries;
    } else {
      const boundaries: number[] = (rec as any)._boundaries || this.defaultBuckets;
      s = {
        count: 0,
        sum: 0,
        buckets: new Array(boundaries.length).fill(0),
        boundaries: [...boundaries],
        created: now,
        p2: this.enableP2 ? makeP2([0.5, 0.9, 0.99]) : undefined,
      } as HistSeries;
    }
    rec.series.set(key, s);
    return s!;
  }

  private ensureMetric(meta: MetricBase): MetricRecord {
    const extant = this.metrics.get(meta.name);
    if (extant) {
      // basic shape compatibility checks
      if (extant.type !== meta.type) throw new Error(`metric ${meta.name} already registered as type=${extant.type}`);
      if (JSON.stringify(extant.labelNames || []) !== JSON.stringify(meta.labelNames || [])) {
        throw new Error(`metric ${meta.name} labelNames mismatch`);
      }
      return extant;
    }
    const rec: MetricRecord = { ...meta, series: new Map() };
    this.metrics.set(meta.name, rec);
    return rec;
  }
}

// ----------------------------- Metric Facades -----------------------------

export class Counter {
  constructor(private reg: MetricsRegistry, private rec: MetricRecord) {}
  inc(labels: Dict<string> = {}, value = 1): void {
    if (value < 0) throw new Error("counter cannot be decreased");
    const s = this.reg._getOrCreateSeries(this.rec, labels) as CounterSeries;
    s.value += value;
  }
  add(labels: Dict<string>, value: number): void { this.inc(labels, value); }
}

export class Gauge {
  constructor(private reg: MetricsRegistry, private rec: MetricRecord) {}
  set(labels: Dict<string> = {}, value = 0): void {
    const s = this.reg._getOrCreateSeries(this.rec, labels) as GaugeSeries;
    s.value = value;
  }
  inc(labels: Dict<string> = {}, value = 1): void {
    const s = this.reg._getOrCreateSeries(this.rec, labels) as GaugeSeries;
    s.value += value;
  }
  dec(labels: Dict<string> = {}, value = 1): void { this.inc(labels, -value); }
}

export class Histogram {
  constructor(private reg: MetricsRegistry, private rec: MetricRecord) {}
  observe(labels: Dict<string> = {}, valueSeconds: number): void {
    const s = this.reg._getOrCreateSeries(this.rec, labels) as HistSeries;
    const v = Math.max(0, Number(valueSeconds) || 0);
    s.count += 1;
    s.sum += v;
    // bucket index
    const idx = upperBound(s.boundaries, v); // first boundary >= v
    if (idx >= 0) s.buckets[idx] += 1;
    if (s.p2) s.p2.update(v);
  }
  /** Measure a duration (ms) function with auto conversion to seconds. */
  time<T>(labels: Dict<string> = {}, fn: () => T | Promise<T>): T | Promise<T> {
    const start = Date.now();
    const done = (ok = true) => this.observe({ ...labels, ok: String(ok) }, (Date.now() - start) / 1000);
    try {
      const r = fn();
      if (isPromise(r)) {
        return (r as Promise<T>).then(x => { done(true); return x; }, e => { done(false); throw e; });
      }
      done(true);
      return r as T;
    } catch (e) {
      done(false);
      throw e;
    }
  }
  /** Manual timer: returns stop(success?) -> seconds */
  startTimer(labels: Dict<string> = {}): (ok?: boolean) => number {
    const t0 = Date.now();
    return (ok = true) => {
      const s = (Date.now() - t0) / 1000;
      this.observe({ ...labels, ok: String(!!ok) }, s);
      return s;
    };
  }
}

// ----------------------------- Small Utilities -----------------------------

function isPromise<T>(x: any): x is Promise<T> { return !!x && typeof x.then === "function"; }
function isFiniteNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }

function sanitizeBuckets(b: number[]): number[] {
  const arr = (b || []).map(Number).filter(isFiniteNum).sort((x, y) => x - y);
  if (!arr.length) arr.push(1);
  if (arr[arr.length - 1] !== Number.POSITIVE_INFINITY) arr.push(Number.POSITIVE_INFINITY);
  return arr;
}

/** returns index of first boundary >= value */
function upperBound(bounds: number[], v: number): number {
  for (let i = 0; i < bounds.length; i++) if (v <= bounds[i]) return i;
  return bounds.length - 1;
}

function num(x: any): number { const n = Number(x); return Number.isFinite(n) ? n : 0; }

function labelStrWith(base: string, extra: Dict<string>): string {
  const labels = base ? parseKeyFromStr(base) : {};
  for (const k of Object.keys(extra)) labels[k] = String(extra[k]);
  return encodeLabels(labels);
}

function fmtBoundary(le: number): string {
  if (!Number.isFinite(le)) return "+Inf";
  // avoid scientific notation to match Prometheus style
  return (Math.round(le * 1e9) / 1e9).toString();
}

// ------------- Label encoding -------------

function seriesKey(labelNames: string[], values: Dict<string>): string {
  if (!labelNames?.length) return ""; // unlabeled
  const obj: Dict<string> = {};
  for (const ln of labelNames) obj[ln] = String(values[ln] ?? "");
  return encodeLabels(obj);
}
function encodeLabels(obj: Dict<string>): string {
  const keys = Object.keys(obj).sort();
  if (!keys.length) return "";
  const parts = keys.map(k => `${k}="${escapeLabel(String(obj[k]))}"`);
  return `{${parts.join(",")}}`;
}
function parseKey(key: string): { labels: Dict<string>; labelStr: string } {
  if (!key) return { labels: {}, labelStr: "" };
  // key is already like {a="x",b="y"}; reuse
  return { labels: parseKeyFromStr(key), labelStr: key };
}
function parseKeyFromStr(s: string): Dict<string> {
  const out: Dict<string> = {};
  const m = s.match(/{(.*)}/);
  if (!m) return out;
  const inner = m[1];
  const re = /([^=]+)="((?:\\.|[^"\\])*)"/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(inner)) !== null) out[mm[1].trim()] = unescapeLabel(mm[2]);
  return out;
}
function escapeLabel(v: string): string { return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n"); }
function unescapeLabel(v: string): string { return v.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\"); }

// ----------------------------- Tiny P2 Quantiles -----------------------------
// Simple P² (Jain-Chlamtac) streaming quantile estimator for a few quantiles.
// Keeps 5 markers per quantile; good enough for p50/p90/p99 without storing samples.

type P2State = {
  q: number[];   // marker heights (5)
  n: number[];   // marker positions (5)
  np: number[];  // desired marker positions (5)
  dn: number[];  // increments
  count: number;
};
export interface P2Quantiles {
  update(x: number): void;
  p(q: number): number; // returns estimate for quantile q (0..1)
}

function makeP2(qs: number[]): P2Quantiles {
  const qsClamped = Array.from(new Set(qs.map(q => clamp(q, 1e-6, 1 - 1e-6)))).sort((a, b) => a - b);
  const states: Record<string, P2State> = {};
  for (const q of qsClamped) states[String(q)] = initP2(q);

  return {
    update(x: number) { for (const q of qsClamped) updateP2(states[String(q)], x); },
    p(q: number) { const k = String(nearest(qsClamped, q)); return estimateP2(states[k]); },
  };
}

function initP2(p: number): P2State {
  // Start uninitialized; first 5 samples bootstrap exact order stats.
  return { q: [], n: [], np: [], dn: [0, p / 2, p, (1 + p) / 2, 1], count: 0 } as any;
}
function updateP2(s: P2State, x: number) {
  if (s.count < 5) {
    s.q.push(x); s.count++;
    if (s.count === 5) {
      s.q.sort((a, b) => a - b);
      s.n = [1, 2, 3, 4, 5];
      s.np = [1, 1 + 2 * s.dn[1], 1 + 4 * s.dn[2], 1 + 6 * s.dn[3], 5];
    }
    return;
  }
  // find k such that q[k] <= x < q[k+1]
  let k = -1;
  if (x < s.q[0]) { s.q[0] = x; k = 0; }
  else if (x >= s.q[4]) { s.q[4] = x; k = 3; }
  else { for (let i = 0; i < 4; i++) if (s.q[i] <= x && x < s.q[i + 1]) { k = i; break; } }
  for (let i = k + 1; i < 5; i++) s.n[i] += 1;
  for (let i = 0; i < 5; i++) s.np[i] += s.dn[i];
  // adjust heights
  for (let i = 1; i < 4; i++) {
    const d = s.np[i] - s.n[i];
    if ((d >= 1 && s.n[i + 1] - s.n[i] > 1) || (d <= -1 && s.n[i - 1] - s.n[i] < -1)) {
      const dsign = Math.sign(d);
      const qi = s.q[i] + dsign * parabolic(s.q[i - 1], s.q[i], s.q[i + 1], s.n[i - 1], s.n[i], s.n[i + 1]);
      if (s.q[i - 1] < qi && qi < s.q[i + 1]) s.q[i] = qi;
      else s.q[i] = s.q[i] + dsign * linear(s.q[i + dsign] - s.q[i]);
      s.n[i] += dsign;
    }
  }
}
function estimateP2(s: P2State): number {
  if (s.count < 5) {
    const arr = s.q.slice().sort((a, b) => a - b);
    if (!arr.length) return 0;
    // return median-ish for small samples
    return arr[Math.floor(arr.length / 2)];
  }
  return s.q[2];
}
function parabolic(q0: number, q1: number, q2: number, n0: number, n1: number, n2: number): number {
  const a = (n1 - n0 + 1) * (q2 - q1) / (n2 - n1);
  const b = (n2 - n1 - 1) * (q1 - q0) / (n1 - n0);
  return (a + b) / (n2 - n0);
}
function linear(dx: number): number { return dx / 1; }
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }
function nearest(arr: number[], x: number): number {
  let best = arr[0], d = Math.abs(x - best);
  for (const v of arr) { const dd = Math.abs(x - v); if (dd < d) { d = dd; best = v; } }
  return best;
}

// ----------------------------- Convenience -----------------------------

/** Create a ready-to-use registry with a few common metrics. */
export function makeDefaultRegistry(opts?: RegistryOptions) {
  const reg = new MetricsRegistry(opts);
  const up = reg.gauge("process_up", "1 if process is alive");
  up.set({}, 1);

  const reqs = reg.counter("app_requests_total", "Total requests processed", ["route", "method", "code"]);
  const rt = reg.histogram("app_request_duration_seconds", "Request duration in seconds", ["route", "method", "code"], undefined, "seconds");

  return { reg, metrics: { up, reqs, rt } };
}

// Example usage:
// const { reg, metrics } = makeDefaultRegistry({ enableP2: true });
// const stop = metrics.rt.startTimer({ route: "/health", method: "GET", code: "200" });
// // ... do work ...
// stop(true);
// console.log(reg.toPrometheus());