// jobs/snapshots.ts
// Robust broker snapshots (account/positions/open orders) → JSON/CSV + equity ledger.
// No external deps. ESM/NodeNext safe. Compiles without @types/node.

import * as fs from "fs";
import * as path from "path";

/* ---------------- Types (minimal, runtime-agnostic) ---------------- */

type Side = "buy" | "sell";

type Position = {
  symbol: string;
  qty: number;            // signed
  avgPx: number;
  unrealizedPnl?: number; // optional (we recompute anyway)
};

type Account = {
  id: string;
  cash: number;
  equity: number;         // may be recomputed if missing
  buyingPower: number;
  realizedPnl: number;
  positions: Record<string, Position>;
};

type Order = {
  id: string;
  symbol: string;
  side: Side;
  type: "market" | "limit";
  qty: number;
  limit?: number;
  tif?: "GTC" | "IOC" | "FOK";
  status: "new" | "working" | "partiallyFilled" | "filled" | "canceled" | "rejected";
  filled?: number;
  avgPx?: number;
  reason?: string;
  ts?: number;
};

type BrokerLike = {
  getAccount?: () => Promise<Account>;
  getPositions?: () => Promise<Record<string, Position>>;
  getOpenOrders?: () => Promise<Order[]>;
  /** Optional: fair mark for PnL (mid/last/bid/ask). */
  refPrice?: (sym: string, side?: Side) => number | undefined;
};

export type SnapshotOptions = {
  outDir?: string;            // default "reports/snapshots"
  prefix?: string;            // default "snap"
  json?: boolean;             // write JSON (default true)
  csv?: boolean;              // write CSVs (default true)
  ledger?: boolean;           // append ledger (default true)
  rotation?: number;          // keep last N per kind (default 30)
  includeOrders?: boolean;    // default true
  includePositions?: boolean; // default true
  includeAccount?: boolean;   // default true
};

/* ---------------- Small utilities (no Node typings required) ---------------- */

const isFiniteNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

const safeMkDir = (dir: string) => {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
};

const stampISO = () => new Date().toISOString().replace(/[:.]/g, "-");

const csvEsc = (s: unknown) => {
  const t = String(s ?? "");
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

const writeCSV = (file: string, rows: (string | number)[][], headers?: string[]) => {
  try {
    const lines: string[] = [];
    if (headers?.length) lines.push(headers.map(csvEsc).join(","));
    for (const r of rows) lines.push(r.map(csvEsc).join(","));
    fs.writeFileSync(file, lines.join("\n"), "utf8");
  } catch {}
};

const appendCSV = (file: string, rows: (string | number)[][]) => {
  try {
    const chunk = rows.map(r => r.map(csvEsc).join(",")).join("\n") + "\n";
    fs.appendFileSync(file, chunk, "utf8");
  } catch {}
};

const writeJSON = (file: string, obj: unknown) => {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8"); } catch {}
};

/** Rotate files whose names contain `needle`, keeping `keep` newest by mtime. */
const rotate = (dir: string, needle: string, keep: number) => {
  try {
    const all = fs.readdirSync(dir)
      .filter((f) => f.includes(needle))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .map((x) => x.f);
    for (const f of all.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  } catch {}
};

/* ---------------- Core snapshot runner ---------------- */

export async function runSnapshots(broker: BrokerLike, opts: SnapshotOptions = {}) {
  const {
    outDir = path.join("reports", "snapshots"),
    prefix = "snap",
    json = true,
    csv = true,
    ledger = true,
    rotation = 30,
    includeOrders = true,
    includePositions = true,
    includeAccount = true,
  } = opts;

  safeMkDir(outDir);
  const stamp = stampISO();
  const isoNow = new Date().toISOString();

  // --- Pull state (each guarded) ---
  const acct = includeAccount && broker.getAccount ? await broker.getAccount().catch(() => undefined) : undefined;
  const posMap = includePositions && broker.getPositions ? await broker.getPositions().catch(() => ({})) : {};
  const orders = includeOrders && broker.getOpenOrders ? await broker.getOpenOrders().catch(() => []) : [];

  // --- Compute summary (robust to missing marks/equity) ---
  const positions = posMap || {};
  const posArr = Object.values(positions);
  let gross = 0, net = 0, upnl = 0, names = 0;

 

  const equityComputed = isFiniteNum(acct?.cash) ? (acct!.cash + upnl) : undefined;

  const summary = {
    ts: isoNow,
    accountId: acct?.id ?? "unknown",
    cash: acct?.cash ?? null,
    equity: isFiniteNum(acct?.equity) ? acct!.equity : (equityComputed ?? null),
    buyingPower: acct?.buyingPower ?? null,
    realizedPnl: acct?.realizedPnl ?? null,
    grossValue: gross,
    netValue: net,
    unrealizedPnl: upnl,
    names,
    ordersOpen: Array.isArray(orders) ? orders.length : 0,
  };

  const snapshot = {
    meta: { version: 1, prefix, stamp },
    summary,
    account: acct ?? null,
    positions,
    orders: Array.isArray(orders) ? orders : [],
  };

  // --- Write artifacts ---
  if (json) {
    const file = path.join(outDir, `${prefix}.${stamp}.json`);
    writeJSON(file, snapshot);
    rotate(outDir, `${prefix}.`, rotation);
  }

  if (csv) {
   

    // orders
    if (Array.isArray(orders) && orders.length) {
      const rows = orders.map((o) => [
        isoNow, o.id, o.symbol, o.side, o.type, o.qty,
        o.limit ?? "", o.tif ?? "", o.status, o.filled ?? 0, o.avgPx ?? "", o.reason ?? "", o.ts ?? ""
      ]);
      const f = path.join(outDir, `${prefix}.orders.${stamp}.csv`);
      writeCSV(f, rows, ["ts","id","symbol","side","type","qty","limit","tif","status","filled","avgPx","reason","ordTs"]);
      rotate(outDir, `${prefix}.orders.`, rotation);
    }

    // account
    if (acct) {
      const row = [[
        isoNow, acct.id, acct.cash,
        isFiniteNum(acct.equity) ? acct.equity : (equityComputed ?? ""),
        acct.buyingPower, acct.realizedPnl,
        gross, net, upnl, summary.ordersOpen, names
      ]];
      const f = path.join(outDir, `${prefix}.account.${stamp}.csv`);
      writeCSV(f, row, ["ts","accountId","cash","equity","buyingPower","realizedPnl","grossValue","netValue","unrealizedPnl","ordersOpen","names"]);
      rotate(outDir, `${prefix}.account.`, rotation);
    }
  }

  // ledger (append-only; created if missing)
  if (ledger) {
    const f = path.join(outDir, `${prefix}.ledger.csv`);
    if (!fs.existsSync(f)) {
      writeCSV(f, [], ["ts","equity","cash","grossValue","netValue","unrealizedPnl","realizedPnl","names"]);
    }
    appendCSV(f, [[
      isoNow,
      isFiniteNum(summary.equity) ? summary.equity! : "",
      isFiniteNum(summary.cash) ? summary.cash! : "",
      summary.grossValue, summary.netValue, summary.unrealizedPnl,
      isFiniteNum(summary.realizedPnl) ? summary.realizedPnl! : "",
      summary.names
    ]]);
  }

  return snapshot;
}

/* ---------------- Tiny CLI (optional) ----------------
   Works even without @types/node. If you don't need a CLI,
   you can delete everything below this line safely.       */

type AnyDict = Record<string, string | number | boolean>;

function parseArgs(argv: string[]): AnyDict {
  const out: AnyDict = {};
  (argv || []).slice(2).forEach((a) => {
    if (!a.startsWith("--")) return;
    const [k, v] = a.slice(2).split("=");
    if (v === undefined) out[k] = true;
    else if (!isNaN(Number(v))) out[k] = Number(v);
    else out[k] = v;
  });
  return out;
}

// Declare process to satisfy TS when @types/node is not installed
declare const process: any;

if (typeof import.meta !== "undefined" && (import.meta as any).url === `file://${process.argv?.[1]}`) {
  (async () => {
    const args = parseArgs(process.argv || []);
    const outDir = (args.outDir as string) || "reports/snapshots";
    const prefix = (args.prefix as string) || "snap";
    const rotation = (args.rotation as number) ?? 30;
    const json = args.json !== false;
    const csv = args.csv !== false;
    const ledger = args.ledger !== false;

    // Minimal inline PaperBroker fallback if your adapters aren’t available.
    // Replace this with your real import if you prefer.
    const PaperBroker = () => {
      let cash = 1_000_000;
      const positions: Record<string, Position> = {};
      return {
        onQuote: (_s: string, _q: any) => {},
        refPrice: (_s: string) => undefined,
        async getAccount() {
          return { id: "paper", cash, equity: cash, buyingPower: cash, realizedPnl: 0, positions };
        },
        async getPositions() { return positions; },
        async getOpenOrders() { return []; },
      } as BrokerLike;
    };

    let broker: BrokerLike = PaperBroker();

    // If you want to auto-wire your live broker here, uncomment & adjust paths:
    // try {
    //   if (process?.env?.BROKER_BASE_URL) {
    //     const { LiveBroker }: any = await import("../engine/brokers/live-broker.js");
    //     broker = LiveBroker({
    //       baseUrl: process.env.BROKER_BASE_URL!,
    //       endpoints: {
    //         placeOrder: "/orders",
    //         amendOrder: "/orders/:id",
    //         cancelOrder: "/orders/:id",
    //         getOrder: "/orders/:id",
    //         listOpenOrders: "/orders?status=open",
    //         account: "/account",
    //         positions: "/positions",
    //       },
    //       sign: async ({ headers }: any) => ({ headers: { ...headers, Authorization: `Bearer ${process.env.BROKER_TOKEN ?? ""}` } }),
    //     });
    //   }
    // } catch {}

    const snap = await runSnapshots(broker, { outDir, prefix, rotation, json, csv, ledger });
    // eslint-disable-next-line no-console
    console.log(`[snapshots] wrote @ ${snap.meta.stamp} → ${outDir}`);
  })().catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[snapshots] error:", (e as any)?.message || e);
    // @ts-ignore
    if (typeof process !== "undefined" && process?.exit) process.exit(1);
  });
}