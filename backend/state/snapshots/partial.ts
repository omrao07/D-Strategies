// snapshots/partial.ts
// Incremental (partial) portfolio snapshot generator + applier.
// Records ONLY what's changed since previous state. Zero deps, pure TS.

/* =========================
   Types
   ========================= */

export type PositionLite = {
  symbol: string;
  quantity: number;       // signed
  price: number;          // reference/mark used for value
  value?: number;         // optional; if omitted, computed as quantity*price
  sector?: string;
  assetClass?: string;
};

export type StateLite = {
  ts?: number;            // epoch ms
  asOf?: string;          // ISO string
  cash: number;           // cash balance
  positions: PositionLite[];
  totalValue?: number;    // optional (cash + sum(values)); if absent, computed
};

export type ChangeKind = "open" | "close" | "update";

export type PositionChange = {
  kind: ChangeKind;
  symbol: string;
  prevQty: number;
  newQty: number;
  qtyDelta: number;
  prevValue: number;
  newValue: number;
  valueDelta: number;
  price?: number;             // mark used on the "new" state
  sector?: string;
  assetClass?: string;
};

export type PartialSnapshotMeta = {
  ts: number;                 // when diff was generated
  asOf: string;
  baseTs?: number;            // previous state's ts (if any)
  strategy?: string;
  runId?: string;
};

export type PartialSnapshot = {
  meta: PartialSnapshotMeta;
  cashDelta: number;
  pnlDelta: number;           // (newTotal - prevTotal)
  prevTotal: number;
  newTotal: number;
  changes: PositionChange[];  // only symbols that changed
};

/* =========================
   Helpers
   ========================= */

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const abs = (x: number) => (x < 0 ? -x : x);

function coerceValue(p: PositionLite): number {
  const v = p.value ?? p.quantity * p.price;
  return Number.isFinite(v) ? v : 0;
}

function indexPositions(arr: PositionLite[]): Record<string, PositionLite> {
  const idx: Record<string, PositionLite> = {};
  for (const p of arr) idx[p.symbol] = { ...p, value: coerceValue(p) };
  return idx;
}

function computeTotals(state: StateLite): { total: number; positionsValue: number } {
  const positionsValue = sum((state.positions || []).map(coerceValue));
  return { positionsValue, total: (state.cash ?? 0) + positionsValue };
}

/* =========================
   Diff: previous -> current
   ========================= */

/**
 * Generate a partial snapshot (delta) between a previous and current state.
 * - Records changed symbols only (open/close/update).
 * - Computes cashDelta, pnlDelta (total change), prev/new totals.
 */
export function diffPartial(
  previous: StateLite | null | undefined,
  current: StateLite,
  meta?: { strategy?: string; runId?: string }
): PartialSnapshot {
  const baseTs = previous?.ts;
  const nowTs = Date.now();
  const asOf = new Date(nowTs).toISOString();

  const prevIdx = indexPositions(previous?.positions || []);
  const curIdx = indexPositions(current.positions || []);

  const prevSyms = new Set(Object.keys(prevIdx));
  const curSyms = new Set(Object.keys(curIdx));

  const allSyms = new Set<string>([...prevSyms, ...curSyms]);

  const changes: PositionChange[] = [];

  for (const sym of allSyms) {
    const prev = prevIdx[sym];
    const cur = curIdx[sym];

    const prevQty = prev ? prev.quantity : 0;
    const newQty = cur ? cur.quantity : 0;

    if (prevQty === newQty) continue; // no change in position size

    const prevValue = prev ? coerceValue(prev) : 0;
    const newValue = cur ? coerceValue(cur) : 0;

    const qtyDelta = newQty - prevQty;
    const valueDelta = newValue - prevValue;

    let kind: ChangeKind = "update";
    if (!prev && cur && newQty !== 0) kind = "open";
    if (prev && !cur && prevQty !== 0) kind = "close";
    if (prev && cur && prevQty !== newQty) kind = "update";

    changes.push({
      kind,
      symbol: sym,
      prevQty,
      newQty,
      qtyDelta,
      prevValue,
      newValue,
      valueDelta,
      price: cur?.price ?? prev?.price,
      sector: cur?.sector ?? prev?.sector,
      assetClass: cur?.assetClass ?? prev?.assetClass,
    });
  }

  const prevTotals = computeTotals({
    cash: previous?.cash ?? 0,
    positions: previous?.positions ?? [],
  });
  const newTotals = computeTotals(current);

  const cashDelta = (current.cash ?? 0) - (previous?.cash ?? 0);
  const pnlDelta = newTotals.total - prevTotals.total;

  return {
    meta: {
      ts: nowTs,
      asOf,
      baseTs,
      strategy: meta?.strategy,
      runId: meta?.runId,
    },
    cashDelta,
    pnlDelta,
    prevTotal: prevTotals.total,
    newTotal: newTotals.total,
    changes,
  };
}

/* =========================
   Apply: previous + partial -> next
   ========================= */

/**
 * Apply a partial snapshot to a prior full state to obtain a new state.
 * If a symbol "opens" it will be added; if it "closes" newQty should be 0.
 * Cash updates with cashDelta; totals are recomputed from positions & cash.
 */
export function applyPartial(previous: StateLite, partial: PartialSnapshot): StateLite {
  const idx = indexPositions(previous.positions || []);

  for (const c of partial.changes) {
    if (c.kind === "close" || c.newQty === 0) {
      delete idx[c.symbol];
      continue;
    }
    idx[c.symbol] = {
      symbol: c.symbol,
      quantity: c.newQty,
      price: c.price ?? (idx[c.symbol]?.price ?? 0),
      value: c.newValue, // keep explicit value; consumer may reprice later
      sector: idx[c.symbol]?.sector ?? undefined,
      assetClass: idx[c.symbol]?.assetClass ?? undefined,
    };
  }

  // Rebuild positions array
  const positions = Object.values(idx);
  // Update cash
  const cash = (previous.cash ?? 0) + (partial.cashDelta ?? 0);

  // Recompute totals
  const { total } = computeTotals({ cash, positions });

  return {
    ts: partial.meta.ts,
    asOf: partial.meta.asOf,
    cash,
    positions,
    totalValue: total,
  };
}

/* =========================
   Utilities
   ========================= */

/** Summarize partial snapshot into a compact string (for logs). */
export function summarizePartial(p: PartialSnapshot): string {
  const ch = p.changes
    .slice(0, 6) // avoid huge logs
    .map(c => `${c.kind.toUpperCase()} ${c.symbol} ${c.prevQty}→${c.newQty} (Δ=${c.qtyDelta >= 0 ? "+" : ""}${c.qtyDelta})`)
    .join(", ");
  const more = p.changes.length > 6 ? ` … +${p.changes.length - 6} more` : "";
  return `[partial ts=${p.meta.asOf}] cashΔ=${fmt(p.cashDelta)} pnlΔ=${fmt(p.pnlDelta)} total=${fmt(p.newTotal)} | ${ch}${more}`;
}

const fmt = (n: number) => {
  const s = Math.round(n * 100) / 100;
  return (s >= 0 ? "+" : "") + s;
};

/* =========================
   Example (run directly)
   ========================= */

// satisfy TS without @types/node
declare const process: any;

if (typeof import.meta !== "undefined" && (import.meta as any).url === `file://${process.argv?.[1]}`) {
  // quick demo
  const prev: StateLite = {
    ts: Date.now() - 60_000,
    asOf: new Date(Date.now() - 60_000).toISOString(),
    cash: 10_000,
    positions: [
      { symbol: "AAPL", quantity: 50,  price: 180 },
      { symbol: "TSLA", quantity: -20, price: 250 },
    ]
  };
  const cur: StateLite = {
    cash: 9_500, // spent 500 buying more AAPL
    positions: [
      { symbol: "AAPL", quantity: 55, price: 182 }, // +5 shares
      // TSLA closed
      { symbol: "MSFT", quantity: 10, price: 400 }, // new open
    ]
  };

  const part = diffPartial(prev, cur, { strategy: "demo", runId: "r1" });
  // eslint-disable-next-line no-console
  console.log("PARTIAL:", JSON.stringify(part, null, 2));
  // eslint-disable-next-line no-console
  console.log(summarizePartial(part));

  const next = applyPartial(prev, part);
  // eslint-disable-next-line no-console
  console.log("APPLIED → NEXT:", JSON.stringify(next, null, 2));
}