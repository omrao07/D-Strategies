// observability/metrics.ts
// Simple in-process metrics collection: counters, gauges, histograms.
// ESM/NodeNext friendly, no deps.

import * as fs from "fs";

/* =========================
   Types
   ========================= */

export type MetricType = "counter" | "gauge" | "histogram";

export type Counter = { type: "counter"; value: number };
export type Gauge = { type: "gauge"; value: number };
export type Histogram = {
  type: "histogram";
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
};

export type Metric = Counter | Gauge | Histogram;

/* =========================
   Metrics Registry
   ========================= */

export class MetricsRegistry {
  private metrics: Record<string, Metric> = {};

  /* ---- Counter ---- */
  inc(name: string, delta = 1) {
    let m = this.metrics[name];
    if (!m) {
      m = { type: "counter", value: 0 } as Counter;
      this.metrics[name] = m;
    }
    if (m.type !== "counter") throw new Error(`${name} not a counter`);
    m.value += delta;
  }

  /* ---- Gauge ---- */
  set(name: string, value: number) {
    let m = this.metrics[name];
    if (!m) {
      m = { type: "gauge", value: 0 } as Gauge;
      this.metrics[name] = m;
    }
    if (m.type !== "gauge") throw new Error(`${name} not a gauge`);
    m.value = value;
  }

  add(name: string, delta: number) {
    let m = this.metrics[name];
    if (!m) {
      m = { type: "gauge", value: 0 } as Gauge;
      this.metrics[name] = m;
    }
    if (m.type !== "gauge") throw new Error(`${name} not a gauge`);
    m.value += delta;
  }

  /* ---- Histogram ---- */
  observe(name: string, value: number, buckets: number[] = [0.1, 0.5, 1, 5, 10]) {
    let m = this.metrics[name];
    if (!m) {
      m = { type: "histogram", buckets, counts: new Array(buckets.length + 1).fill(0), sum: 0, count: 0 } as Histogram;
      this.metrics[name] = m;
    }
    if (m.type !== "histogram") throw new Error(`${name} not a histogram`);
    m.sum += value;
    m.count++;
    let idx = m.buckets.findIndex(b => value <= b);
    if (idx === -1) idx = m.counts.length - 1;
    m.counts[idx]++;
  }

  /* ---- Export ---- */
  toJSON() {
    return this.metrics;
  }

  toPrometheus(): string {
    const lines: string[] = [];
    for (const [name, m] of Object.entries(this.metrics)) {
      switch (m.type) {
        case "counter":
          lines.push(`# TYPE ${name} counter`);
          lines.push(`${name} ${m.value}`);
          break;
        case "gauge":
          lines.push(`# TYPE ${name} gauge`);
          lines.push(`${name} ${m.value}`);
          break;
        case "histogram":
          lines.push(`# TYPE ${name} histogram`);
          let cumulative = 0;
          m.buckets.forEach((b, i) => {
            cumulative += m.counts[i];
            lines.push(`${name}_bucket{le="${b}"} ${cumulative}`);
          });
          cumulative += m.counts[m.counts.length - 1];
          lines.push(`${name}_bucket{le="+Inf"} ${cumulative}`);
          lines.push(`${name}_sum ${m.sum}`);
          lines.push(`${name}_count ${m.count}`);
          break;
      }
    }
    return lines.join("\n");
  }

  writeJSON(filePath: string) {
    fs.writeFileSync(filePath, JSON.stringify(this.metrics, null, 2), "utf8");
  }
}

/* =========================
   Default global registry
   ========================= */

export const metrics = new MetricsRegistry();

export default metrics;