// backtester/benchmark.ts
// Minimal, dependency-free micro-benchmark runner for your backtest primitives.
// - Define named tasks (sync or async)
// - Warmup, repetitions, optional concurrency
// - Collects latency stats (mean/median/p95/p99), ops/sec, error count
// - Optional memory sampling (RSS/Heap)
// - CSV + pretty table output

export type BenchTask = {
  /** Unique name of the task */
  name: string;
  /** The function to benchmark; may be sync or async */
  run: () => void | Promise<void>;
  /** Optional setup/teardown executed once per benchmark (not timed) */
  setup?: () => void | Promise<void>;
  teardown?: () => void | Promise<void>;
};

export type BenchOptions = {
  /** # warmup iterations (not measured). Default 5 */
  warmup?: number;
  /** # measured iterations (per task). Default 50 */
  iterations?: number;
  /** Max tasks run in parallel (1 = sequential). Default 1 */
  concurrency?: number;
  /** If true, sample memory before/after. Default true (Node only) */
  memory?: boolean;
  /** Optional per-iteration hook (taskName, i, ms) */
  onTick?: (e: { task: string; i: number; ms: number }) => void;
  /** Optional per-task hook with final stats */
  onTaskDone?: (r: BenchResult) => void;
  /** Abort signal to cancel the whole run */
  signal?: AbortSignal;
};

export type BenchStats = {
  n: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  stdev: number;
  opsPerSec: number; // n / sum(ms) * 1000
  totalMs: number;
  errors: number;
};

export type MemorySample = {
  rssMB?: number;
  heapTotalMB?: number;
  heapUsedMB?: number;
  externalMB?: number;
};

export type BenchResult = {
  name: string;
  stats: BenchStats;
  beforeMem?: MemorySample;
  afterMem?: MemorySample;
};

export type BenchReport = {
  options: Required<Omit<BenchOptions, "onTick" | "onTaskDone" | "signal">>;
  results: BenchResult[];
  /** CSV view (one row per task) */
  toCSV(): string;
  /** Pretty-print table to console (monospace) */
  print(): void;
};

/* --------------------------------- Runner -------------------------------- */

export async function runBenchmark(
  tasks: BenchTask[],
  opts: BenchOptions = {}
): Promise<BenchReport> {
  const options: BenchReport["options"] = {
    warmup: opts.warmup ?? 5,
    iterations: opts.iterations ?? 50,
    concurrency: Math.max(1, opts.concurrency ?? 1),
    memory: opts.memory ?? true,
  };

  // Run each task respecting concurrency of tasks themselves (not per-iteration)
  const queue = [...tasks];
  const results: BenchResult[] = [];
  let running: Promise<void>[] = [];

  const launch = async (t: BenchTask) => {
    const r = await runOne(t, options, opts);
    results.push(r);
  };

  while (queue.length || running.length) {
    while (queue.length && running.length < options.concurrency) {
      const t = queue.shift()!;
      running.push(launch(t));
    }
    // wait for one to finish
    await Promise.race(running).catch(() => {});
    // prune finished
    running = running.filter((p) => p && (p as any).isPending !== false); // best effort
    // The above may not work across engines; safer approach:
    running = running.filter((p) => (p as any).__done !== true);
  }

  // Results might be out of order when concurrency > 1; keep input order
  const ordered = tasks.map((t) => results.find((r) => r.name === t.name)!).filter(Boolean);

  return {
    options,
    results: ordered,
    toCSV() {
      const head = [
        "task",
        "n",
        "mean_ms",
        "median_ms",
        "p95_ms",
        "p99_ms",
        "min_ms",
        "max_ms",
        "stdev_ms",
        "ops_per_sec",
        "total_ms",
        "errors",
        "rss_MB",
        "heap_used_MB",
      ].join(",");
      const rows = ordered.map((r) => {
        const m = r.afterMem ?? {};
        const cols = [
          csv(r.name),
          r.stats.n,
          fix(r.stats.mean),
          fix(r.stats.median),
          fix(r.stats.p95),
          fix(r.stats.p99),
          fix(r.stats.min),
          fix(r.stats.max),
          fix(r.stats.stdev),
          fix(r.stats.opsPerSec),
          fix(r.stats.totalMs),
          r.stats.errors,
          m.rssMB ?? "",
          m.heapUsedMB ?? "",
        ];
        return cols.join(",");
      });
      return [head, ...rows].join("\n");
    },
    print() {
      const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length));
      const line = (w: number) => "-".repeat(w);
      const cols = [
        ["Task", 22],
        ["n", 6],
        ["mean", 10],
        ["p95", 10],
        ["p99", 10],
        ["min", 8],
        ["max", 10],
        ["ops/s", 10],
        ["err", 5],
      ];
      const header =
       
      console.log("");
      console.log(`Benchmark results (iterations: ${options.iterations}, warmup: ${options.warmup}, concurrency: ${options.concurrency})`);
      console.log("");
      console.log(header);
      for (const r of ordered) {
        const s = r.stats;
        const row = [
          pad(r.name.slice(0, 22), 22),
          pad(String(s.n), 6),
          pad(fix(s.mean), 10),
          pad(fix(s.p95), 10),
          pad(fix(s.p99), 10),
          pad(fix(s.min), 8),
          pad(fix(s.max), 10),
          pad(fix(s.opsPerSec), 10),
          pad(String(s.errors), 5),
        ].join(" ");
        console.log(row);
      }
      console.log("");
    },
  };
}

/* ------------------------------- One Task -------------------------------- */

async function runOne(
  task: BenchTask,
  options: BenchReport["options"],
  hooks: Pick<BenchOptions, "onTick" | "onTaskDone" | "signal">
): Promise<BenchResult> {
  const { warmup, iterations, memory } = options;

  if (hooks.signal?.aborted) throw abortErr();

  // optional setup
  if (task.setup) await task.setup();

  // warmup (not measured)
  for (let i = 0; i < warmup; i++) {
    if (hooks.signal?.aborted) throw abortErr();
    await maybeAsync(task.run);
  }

  const times: number[] = [];
  let errors = 0;

  const before = memory ? takeMemory() : undefined;

  for (let i = 0; i < iterations; i++) {
    if (hooks.signal?.aborted) throw abortErr();

    const t0 = now();
    try {
      await maybeAsync(task.run);
    } catch {
      errors++;
    }
    const dt = now() - t0;
    times.push(dt);
    hooks.onTick?.({ task: task.name, i, ms: dt });
  }

  const after = memory ? takeMemory() : undefined;

  // optional teardown
  if (task.teardown) await task.teardown();

  const stats = toStats(times, errors);
  const result: BenchResult = { name: task.name, stats, beforeMem: before, afterMem: after };
  hooks.onTaskDone?.(result);
  // flag for concurrency pruning (best-effort)
  (Promise.resolve() as any).__done = true;
  return result;
}

/* --------------------------------- Stats --------------------------------- */

function toStats(times: number[], errors: number): BenchStats {
  const n = times.length;
  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((s, x) => s + x, 0);
  const mean = sum / Math.max(1, n);
  const median = quantile(sorted, 0.5);
  const p95 = quantile(sorted, 0.95);
  const p99 = quantile(sorted, 0.99);
  const min = sorted[0] ?? 0;
  const max = sorted[n - 1] ?? 0;
  const stdev = stdDev(sorted, mean);
  const totalMs = sum;
  const opsPerSec = totalMs > 0 ? (n / totalMs) * 1000 : 0;
  return { n, mean, median, p95, p99, min, max, stdev, opsPerSec, totalMs, errors };
}

function quantile(sortedAsc: number[], q: number) {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const i = Math.floor(pos);
  const frac = pos - i;
  const a = sortedAsc[i];
  const b = sortedAsc[i + 1] ?? a;
  return a + (b - a) * frac;
}
function stdDev(sortedAsc: number[], mean: number) {
  if (sortedAsc.length <= 1) return 0;
  let s2 = 0;
  for (const x of sortedAsc) s2 += (x - mean) ** 2;
  return Math.sqrt(s2 / (sortedAsc.length - 1));
}

/* --------------------------------- Utils --------------------------------- */

function now(): number {
  // high-res timer if available
  if (typeof performance !== "undefined" && performance.now) return performance.now();
  // Node fallback
  if (typeof process !== "undefined" && (process as any).hrtime) {
    const [s, ns] = (process as any).hrtime();
    return s * 1000 + ns / 1e6;
  }
  return Date.now();
}

async function maybeAsync(fn: () => void | Promise<void>) {
  const r = fn();
  if (r && typeof (r as Promise<void>).then === "function") {
    await r;
  }
}

function takeMemory(): MemorySample | undefined {
  if (typeof process === "undefined" || !process.memoryUsage) return undefined;
  const m = process.memoryUsage();
  const mb = (b: number) => Math.round((b / (1024 * 1024)) * 100) / 100;
  return {
    rssMB: mb(m.rss),
    heapTotalMB: mb(m.heapTotal),
    heapUsedMB: mb(m.heapUsed),
    externalMB: m.external ? mb(m.external) : undefined,
  };
}

function csv(s: string) {
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function fix(n: number, d = 3) {
  if (!Number.isFinite(n)) return "";
  const x = Math.abs(n);
  const dp = d ?? (x >= 100 ? 1 : x >= 10 ? 2 : 3);
  return Number(n.toFixed(dp)).toString();
}
function abortErr() {
  return new DOMException("Aborted", "AbortError");
}

/* -------------------------------- Examples --------------------------------
import { runBenchmark } from "./benchmark";

const fib = (n: number): number => (n <= 1 ? n : fib(n - 1) + fib(n - 2));

const tasks = [
  { name: "sync loop", run: () => { for (let i=0;i<1e5;i++); } },
  { name: "promise microtask", run: async () => { await Promise.resolve(); } },
  { name: "fib(20)", run: () => { fib(20); } },
];

const report = await runBenchmark(tasks, { iterations: 100, warmup: 10 });
report.print();
console.log(report.toCSV());
----------------------------------------------------------------------------- */
