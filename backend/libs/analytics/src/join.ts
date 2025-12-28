/* =========================================================
   Time Series Join Utilities
   Strict-safe, self-contained, no imports
   ========================================================= */

/* ===================== Types ===================== */

export type TimePoint<T = number> = {
  t: number;     // timestamp (ms or any monotonic number)
  v: T;
};

export type JoinType = "inner" | "left" | "right" | "outer";

/* ===================== Core Join ===================== */

export function joinSeries<A, B>(
  a: TimePoint<A>[],
  b: TimePoint<B>[],
  type: JoinType = "inner"
): Array<{ t: number; a?: A; b?: B }> {
  const out: Array<{ t: number; a?: A; b?: B }> = [];

  let i = 0;
  let j = 0;

  while (i < a.length || j < b.length) {
    const ta = i < a.length ? a[i]!.t : Infinity;
    const tb = j < b.length ? b[j]!.t : Infinity;

    if (ta === tb) {
      out.push({ t: ta, a: a[i]!.v, b: b[j]!.v });
      i++;
      j++;
    } else if (ta < tb) {
      if (type === "left" || type === "outer") {
        out.push({ t: ta, a: a[i]!.v });
      }
      i++;
    } else {
      if (type === "right" || type === "outer") {
        out.push({ t: tb, b: b[j]!.v });
      }
      j++;
    }
  }

  return type === "inner"
    ? out.filter(x => x.a !== undefined && x.b !== undefined)
    : out;
}

/* ===================== Numeric Helpers ===================== */

export function joinNumeric(
  a: TimePoint<number>[],
  b: TimePoint<number>[],
  type: JoinType = "inner"
): Array<{ t: number; a?: number; b?: number }> {
  return joinSeries(a, b, type);
}

/* ===================== Forward Fill ===================== */

export function forwardFill<T>(
  x: Array<{ t: number; v?: T }>
): Array<{ t: number; v: T | undefined }> {
  const out: Array<{ t: number; v: T | undefined }> = [];
  let last: T | undefined = undefined;

  for (let i = 0; i < x.length; i++) {
    const cur = x[i]!;
    if (cur.v !== undefined) last = cur.v;
    out.push({ t: cur.t, v: last });
  }

  return out;
}

/* ===================== Align Many Series ===================== */

export function alignSeries(
  series: TimePoint<number>[][],
  type: JoinType = "inner"
): { t: number; values: (number | undefined)[] }[] {
  if (series.length === 0) return [];

  let acc: Array<{ t: number; values: (number | undefined)[] }> =
    series[0]!.map(p => ({ t: p.t, values: [p.v] }));

  for (let k = 1; k < series.length; k++) {
    const next = series[k]!;
    const joined = joinSeries(
      acc.map(x => ({ t: x.t, v: x.values })),
      next,
      type
    );

    acc = joined.map(row => ({
      t: row.t,
      values: [
        ...(row.a ?? []),
        row.b
      ]
    }));
  }

  return acc;
}

/* ===================== Index Utilities ===================== */

export function indexByTime<T>(
  x: TimePoint<T>[]
): Map<number, T> {
  const m = new Map<number, T>();
  for (let i = 0; i < x.length; i++) {
    const p = x[i]!;
    m.set(p.t, p.v);
  }
  return m;
}

/* ===================== Sanity Checks ===================== */

export function isSorted(x: TimePoint[]): boolean {
  for (let i = 1; i < x.length; i++) {
    if (x[i]!.t < x[i - 1]!.t) return false;
  }
  return true;
}