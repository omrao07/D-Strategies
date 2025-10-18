// engine/context.js
// Builds a StrategyContext object used by the strategy engine.
// ESM-compatible. Minimal and dependency-free.
//
// Shape produced:
// {
//   id: string,
//   mode: "backtest" | "paper" | "live",
//   data: { getPrices: (symbols, from, to, tf?) => Promise<any> },
//   broker?: { placeOrder: fn, fetchPositions: fn },
//   log: { info/warn/error },
//   start?: string (ISO),
//   end?: string (ISO)
// }

/** Normalize to ISO yyyy-mm-dd (or return undefined if falsy) */
export function normalizeISO(x) {
  if (!x) return undefined;
  // Accept Date/string; keep yyyy-mm-dd if already in that form
  if (typeof x === "string") {
    // If it looks like 'YYYY-MM-DD' keep as is; else try Date parse
    if (/^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
    const d = new Date(x);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return undefined;
  }
  if (x instanceof Date && !isNaN(x.getTime())) return x.toISOString().slice(0, 10);
  return undefined;
}

/**
 * Create a StrategyContext. Required: id, data.
 * @param {Object} opts
 * @param {string} opts.id
 * @param {"backtest"|"paper"|"live"} [opts.mode="backtest"]
 * @param {Object} opts.data                // DataFeed adapter
 * @param {Object} [opts.broker]           // Broker adapter (optional)
 * @param {string|Date} [opts.start]
 * @param {string|Date} [opts.end]
 * @param {Object} [opts.log=console]      // { info, warn, error }
 */
export function makeContext(opts) {
  if (!opts || !opts.id) throw new Error("makeContext: 'id' is required");
  if (!opts.data || typeof opts.data.getPrices !== "function") {
    throw new Error("makeContext: 'data.getPrices' is required");
  }
  const mode = opts.mode || "backtest";
  const start = normalizeISO(opts.start);
  const end = normalizeISO(opts.end);

  const log = opts.log || console;

  return {
    id: String(opts.id),
    mode,
    data: opts.data,
    broker: opts.broker,
    log,
    start,
    end,
  };
}

/**
 * Optional helper: create a context from simple names (demo defaults).
 * Pass in resolvers to map names → adapters. Keeps this file decoupled.
 *
 * @example
 *   const ctx = await makeContextFromNames({
 *     id: "examples.mean_reversion",
 *     dataFeed: "demo",
 *     broker: "paper",
 *     resolvers: {
 *       data: name => name === "demo" ? import("../adapters/data/demo-feed.js").then(m=>m.DemoFeed) : null,
 *       broker: name => name === "paper" ? import("../adapters/brokers/paper-broker.js").then(m=>m.PaperBroker) : null
 *     },
 *     start: "2024-01-01", end: "2024-12-31"
 *   });
 */
export async function makeContextFromNames({
  id,
  mode = "backtest",
  dataFeed,
  broker,
  resolvers = {},
  start,
  end,
  log = console,
}) {
  const data =
    (resolvers.data && (await resolvers.data(dataFeed))) ||
    (() => {
      throw new Error(`Unknown dataFeed '${dataFeed}' and no resolver provided`);
    })();

  const brk =
    (broker &&
      resolvers.broker &&
      (await resolvers.broker(broker))) ||
    undefined;

  return makeContext({ id, mode, data, broker: brk, start, end, log });
}

export default { makeContext, makeContextFromNames, normalizeISO };