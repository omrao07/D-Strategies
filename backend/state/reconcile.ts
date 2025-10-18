// state/reconcile.ts
// Reconcile live portfolio state with target state (backtester vs. broker or sim).
// Goal: detect differences, suggest trades to bring actual state in line with target.
//
// Usage example (pseudo):
//   const diff = reconcileStates(live, target);
//   console.log(diff.trades);

export type Position = {
  symbol: string;     // unique id (ticker or option symbol)
  qty: number;        // signed: + long, - short
  price?: number;     // last known price
  multiplier?: number;// contract multiplier
};

export type Portfolio = {
  cash?: number;
  positions: Record<string, Position>;
};

export type Trade = {
  symbol: string;
  qty: number;        // delta to trade: + buy, - sell
  note?: string;
};

export type ReconcileResult = {
  trades: Trade[];
  missingInLive: Position[];
  missingInTarget: Position[];
  cashDiff?: number;
};

/**
 * Reconcile two states: live vs target
 * @param live current broker/backtester portfolio
 * @param target desired/target portfolio
 */
export function reconcileStates(live: Portfolio, target: Portfolio): ReconcileResult {
  const trades: Trade[] = [];
  const missingInLive: Position[] = [];
  const missingInTarget: Position[] = [];

  // Compare positions
  const allSymbols = new Set<string>([
    ...Object.keys(live.positions),
    ...Object.keys(target.positions),
  ]);

  for (const sym of allSymbols) {
    const l = live.positions[sym];
    const t = target.positions[sym];
    if (l && t) {
      const diff = t.qty - l.qty;
      if (diff !== 0) {
        trades.push({ symbol: sym, qty: diff, note: `adjust from ${l.qty} → ${t.qty}` });
      }
    } else if (!l && t) {
      missingInLive.push(t);
      trades.push({ symbol: sym, qty: t.qty, note: "open new position" });
    } else if (l && !t) {
      missingInTarget.push(l);
      trades.push({ symbol: sym, qty: -l.qty, note: "close position" });
    }
  }

  // Cash difference
  const cashDiff = (target.cash ?? 0) - (live.cash ?? 0);

  return { trades, missingInLive, missingInTarget, cashDiff };
}

/** Pretty print reconciliation result */
export function summarizeReconcile(r: ReconcileResult): string {
  const lines: string[] = [];
  if (r.trades.length) {
    lines.push("Trades:");
    for (const t of r.trades) {
      lines.push(` - ${t.symbol}: ${t.qty > 0 ? "BUY" : "SELL"} ${Math.abs(t.qty)} (${t.note})`);
    }
  } else {
    lines.push("No position adjustments required.");
  }
  if (r.cashDiff && Math.abs(r.cashDiff) > 1e-6) {
    lines.push(`Cash adjustment required: ${r.cashDiff >= 0 ? "+" : ""}${r.cashDiff.toFixed(2)}`);
  }
  return lines.join("\n");
}

/* ===== Demo =====
const live: Portfolio = {
  cash: 10000,
  positions: {
    "AAPL": { symbol: "AAPL", qty: 50 },
    "MSFT": { symbol: "MSFT", qty: -10 }
  }
};

const target: Portfolio = {
  cash: 9500,
  positions: {
    "AAPL": { symbol: "AAPL", qty: 100 },
    "GOOG": { symbol: "GOOG", qty: 20 }
  }
};

const result = reconcileStates(live, target);
console.log(summarizeReconcile(result));
*/