// jobs/live monitor.ts
// Terminal live monitor for account, positions, PnL and quotes.
// ESM/NodeNext, zero external deps.

type Side = "buy" | "sell";

type Quote = {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
  mid?: number;
  ts: number;
};

type Position = {
  symbol: string;
  qty: number;       // signed
  avgPx: number;
  unrealizedPnl?: number;
};

type Account = {
  id: string;
  cash: number;
  equity: number;
  buyingPower: number;
  realizedPnl: number;
  positions: Record<string, Position>;
};

type BrokerLike = {
  getAccount: () => Promise<Account>;
  getPositions: () => Promise<Record<string, Position>>;
  getOpenOrders?: () => Promise<any[]>;
  onQuote?: (symbol: string, q: Partial<Quote>) => void; // the broker can accept quotes (optional)
  // Optional helper you might have in LiveBroker:
  refPrice?: (sym: string, side?: Side) => number | undefined;
};

// ---- (tiny) local table renderer (uses same API as libs/table.ts) ----
// If you already have libs/table.ts, feel free to replace with: 
//   import { renderTable } from "../libs/table.js";
type Align = "left" | "right" | "center";
function renderTable(
  rows: (string | number | boolean | null | undefined)[][],
  opts: { headers?: string[]; align?: Align[]; maxColWidth?: number; pad?: number; border?: boolean } = {}
): string {
  const { headers, align, maxColWidth = 32, pad = 2, border = false } = opts;
  const allRows = headers ? [headers, ...rows] : rows;
  if (!allRows.length) return "";
  const sRows = allRows.map(r => r.map(x => (x == null ? "" : String(x))));
  for (let r = 0; r < sRows.length; r++) {
    for (let c = 0; c < sRows[r].length; c++) {
      let cell = sRows[r][c];
      if (cell.length > maxColWidth) cell = cell.slice(0, maxColWidth - 1) + "…";
      sRows[r][c] = cell;
    }
  }
  const nCols = Math.max(...sRows.map(r => r.length));
  const colWidths = Array(nCols).fill(0);
  for (const r of sRows) for (let c = 0; c < nCols; c++) colWidths[c] = Math.max(colWidths[c], (r[c] ?? "").length);
  const colAlign: Align[] = []; for (let c = 0; c < nCols; c++) colAlign[c] = align?.[c] ?? "left";
  const fmt = (txt: string, w: number, a: Align) => {
    const padLen = w - txt.length;
    if (a === "right") return " ".repeat(padLen) + txt;
    if (a === "center") { const l = Math.floor(padLen / 2); return " ".repeat(l) + txt + " ".repeat(padLen - l); }
    return txt + " ".repeat(padLen);
  };
  const lines: string[] = [];
  const sep = border ? "+" + colWidths.map(w => "-".repeat(w + pad)).join("+") + "+" : "";
  if (border) lines.push(sep);
  for (let r = 0; r < sRows.length; r++) {
    const cells: string[] = [];
    for (let c = 0; c < nCols; c++) cells.push(fmt(sRows[r][c] ?? "", colWidths[c], colAlign[c]));
    lines.push(border ? "| " + cells.join(" ".repeat(pad) + "| ") + " |" : cells.join(" ".repeat(pad)));
    if (r === 0 && headers && border) lines.push(sep);
  }
  if (border) lines.push(sep);
  return lines.join("\n");
}
// ----------------------------------------------------------------------

type MonitorOptions = {
  refreshMs?: number;         // how often to refresh the screen
  symbols?: string[];         // optional watchlist filter; if omitted, show all positions
  showOrders?: boolean;       // include open orders count
  border?: boolean;           // table border
  precision?: number;         // price precision
};

class QuoteBook {
  private m = new Map<string, Quote>();
  update(q: Quote) {
    const prev = this.m.get(q.symbol);
    const mid = q.mid ?? ((isNum(q.bid) && isNum(q.ask)) ? ((q.bid! + q.ask!) / 2) : prev?.mid);
    const merged: Quote = { ...(prev || { symbol: q.symbol, ts: 0 }), ...q, mid, ts: q.ts ?? Date.now() };
    this.m.set(q.symbol, merged);
    return merged;
  }
  get(sym: string) { return this.m.get(sym); }
  lastPx(sym: string) {
    const q = this.get(sym);
    return q?.last ?? q?.mid ?? (isNum(q?.ask) && isNum(q?.bid) ? ((q!.ask! + q!.bid!) / 2) : undefined);
  }
}

const isNum = (x: any) => typeof x === "number" && Number.isFinite(x);
const fmtN = (n: number, d = 2) => isNum(n) ? n.toFixed(d) : "";
const fmtPct = (x: number, d = 2) => isNum(x) ? ((x >= 0 ? "+" : "") + (100 * x).toFixed(d) + "%") : "";
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// Minimal arg parser: --key=value flags
function parseArgs(argv: string[]) {
  const out: Record<string,string|boolean> = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      out[k] = v === undefined ? true : v;
    }
  }
  return out;
}

export async function runLiveMonitor(broker: BrokerLike, opts: MonitorOptions = {}) {
  const options: Required<MonitorOptions> = {
    refreshMs: clamp(Number(opts.refreshMs ?? 1000), 250, 60_000),
    symbols: opts.symbols ?? [],
    showOrders: !!opts.showOrders,
    border: !!opts.border,
    precision: Math.max(0, Number(opts.precision ?? 2)),
  };

  const quotes = new QuoteBook();

  // If the broker has onQuote, we wrap it so we can also update our book.
  const ingestQuote = (symbol: string, q: Partial<Quote>) => {
    const full: Quote = {
      symbol,
      bid: q.bid, ask: q.ask, last: q.last,
      mid: q.mid ?? (isNum(q.bid) && isNum(q.ask) ? ((q.bid! + q.ask!) / 2) : undefined),
      ts: (q as any).ts ?? Date.now(),
    };
    quotes.update(full);
    // forward to broker (keeps its own marks for PnL)
    broker.onQuote?.(symbol, q);
  };

  // Light clear screen between frames
  const cls = () => process.stdout.write("\x1b[2J\x1b[H");

  let running = true;
  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  while (running) {
    try {
      const [acct, posMap, openOrders] = await Promise.all([
        broker.getAccount(),
        broker.getPositions(),
        options.showOrders ? (broker.getOpenOrders?.().catch(() => [])) : Promise.resolve([]),
      ]);

      // If caller provided symbols filter, limit to it; else show all positions (non-zero first)
      const syms = options.symbols.length ? options.symbols
        : Object.keys(posMap).length ? Object.keys(posMap)
        : [];

      // Compute table rows
      const rows: (string | number)[][] = [];
      let netUPnL = 0;
      let grossVal = 0;

      for (const sym of syms) {
        const p: Position | undefined = posMap[sym];
        if (!p) continue;

        const last = broker.refPrice?.(sym, p.qty >= 0 ? "sell" : "buy") ?? quotes.lastPx(sym) ?? p.avgPx;
        const qty = p.qty;
        const avg = p.avgPx;
        const val = (last ?? 0) * qty;
        const u = (last - avg) * qty;
        netUPnL += u;
        grossVal += Math.abs(val);

        rows.push([
          sym,
          qty,
          fmtN(avg, options.precision),
          isNum(last) ? fmtN(last, options.precision) : "",
          fmtN(val, 2),
          fmtN(u, 2),
          fmtPct(avg ? (last / avg - 1) * Math.sign(qty) : 0, 2),
        ]);
      }

      // Sort: biggest |value| first
      rows.sort((a, b) => Math.abs(Number(b[4])) - Math.abs(Number(a[4])));

      // Header
      const hdr = renderTable(
        rows,
        {
          headers: ["Symbol", "Qty", "AvgPx", "Last", "Value", "uPnL", "uPnL%"],
          align: ["left", "right", "right", "right", "right", "right", "right"],
          border: options.border,
        }
      );

      // Summary line
      const ordCount = Array.isArray(openOrders) ? openOrders.length : 0;
      const summary = [
        `Acct: ${acct.id}`,
        `Cash: ${fmtN(acct.cash, 2)}`,
        `Equity: ${fmtN(acct.equity, 2)}`,
        `BP: ${fmtN(acct.buyingPower, 2)}`,
        `uPnL: ${fmtN(netUPnL, 2)}`,
        `rPnL: ${fmtN(acct.realizedPnl, 2)}`,
        options.showOrders ? `OpenOrders: ${ordCount}` : undefined,
        `Ts: ${new Date().toISOString()}`,
      ].filter(Boolean).join("   ");

      cls();
      process.stdout.write(hdr + "\n\n" + summary + "\n");

    } catch (e: any) {
      cls();
      process.stdout.write(`[monitor] error: ${e?.message || e}\n`);
    }

    await sleep(options.refreshMs);
  }

  process.stdout.write("\n[monitor] stopped.\n");

  // expose a way to feed quotes
  return { onQuote: ingestQuote };
}

// tiny sleep helper
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
