// scripts/run-commodities.mjs
// Minimal HTTP runner exposing commodities endpoints (zero deps, Node core only).
// Endpoints:
//   GET  /live                      -> { live: boolean }
//   GET  /ready                     -> { ready: boolean }
//   GET  /health                    -> minimal JSON
//   GET  /metrics                   -> Prometheus text
//   GET  /commodities/chains        -> demo futures chains (JSON)
//   GET  /commodities/curves        -> demo forward curves (JSON)
//   POST /commodities/margin        -> body: {symbol, qty, px, vol, days} -> margin calc (JSON)
//
// Usage:
//   node scripts/run-commodities.mjs --host 127.0.0.1 --port 8788 --name commodities --env dev
//   SERVE_TOKEN=secret node scripts/run-commodities.mjs --token $SERVE_TOKEN
//
// Notes:
// - This runner is self-contained. If you have real modules (e.g. commodities/chains.ts),
//   you can replace the demo data providers in `loadChains()` / `loadCurves()` / `calcMargin()`.

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ------------------- CLI / Config -------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const APP_NAME = args.name || "commodities";
const ENV = args.env || process.env.NODE_ENV || "dev";
const HOST = args.host || "127.0.0.1";
const PORT = toInt(args.port, 8788);
const TOKEN = args.token || process.env.SERVE_TOKEN || ""; // optional bearer

// ------------------- Demo Data Providers -------------------

function loadChains() {
  // Simple synthetic futures chain (month codes) with prices
  const today = new Date();
  const sym = (root, m, y) => `${root}${monthCode(m)}${String(y).slice(-2)}`;
  const mk = (root, months, startPx) =>
    months.map((offset, i) => {
      const d = addMonths(today, offset);
      return {
        symbol: sym(root, d.getUTCMonth() + 1, d.getUTCFullYear()),
        root,
        expiry: d.toISOString().slice(0, 10),
        px: round(startPx * (1 + 0.002 * i)), // gentle contango
      };
    });

  return {
    WTI: mk("CL", [1, 2, 3, 6, 9, 12], 80),
    Brent: mk("BRN", [1, 2, 3, 6, 9, 12], 84),
    Gold: mk("GC", [1, 2, 3, 6, 12], 2300),
    NatGas: mk("NG", [1, 2, 3, 6, 9, 12], 2.8),
  };
}

function loadCurves() {
  // Turn chains into simple time→price curves (tenors in months)
  const chains = loadChains();
  const toCurve = (arr) =>
    arr.map((c, i) => ({
      tenorMonths: monthsBetweenUtc(new Date(), new Date(c.expiry)),
      px: c.px,
      contract: c.symbol,
    }));
  return Object.fromEntries(Object.entries(chains).map(([k, v]) => [k, toCurve(v)]));
}

// Simple SPAN-ish placeholder: base margin by volatility, days to expiry, and notional.
// DO NOT use for real risk. This is a demo calculator.
function calcMargin({ symbol, qty, px, vol = 0.3, days = 30 }) {
  const absQty = Math.abs(Number(qty) || 0);
  const price = Number(px) || 0;
  // notional estimate per contract (very rough multipliers)
  const mult = symbol?.startsWith("CL") || symbol?.startsWith("BRN") ? 1000
             : symbol?.startsWith("NG") ? 10000
             : symbol?.startsWith("GC") ? 100
             : 1;
  const notional = absQty * price * mult;

  const t = Math.max(1, days) / 365;
  const stress = vol * Math.sqrt(t);
  // base margin  (10% min, scaled by stress; cap at 30%)
  const basePct = clamp(0.10 + 0.8 * stress, 0.10, 0.30);
  const margin = notional * basePct;
  return {
    symbol,
    qty: Number(qty),
    px: price,
    vol,
    days,
    multiplier: mult,
    notional: round(notional),
    marginPct: round(basePct * 100),
    margin: round(margin),
  };
}

// ------------------- State & Metrics -------------------

const state = {
  startMs: Date.now(),
  ready: true, // no heavy init for the demo
  stopping: false,
};

const metrics = {
  up: 1,
  requests: 0,
  reqDurMs: { sum: 0, count: 0 },
};

// ------------------- HTTP Server -------------------

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  metrics.requests++;

  // auth (optional)
  if (TOKEN) {
    const ok = timingSafeEqual(String(req.headers?.authorization || ""), `Bearer ${TOKEN}`);
    if (!ok) { res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("unauthorized"); record(t0); return; }
  }

  // Only accept a few routes
  const url = (req.url || "/").split("?")[0];
  if (req.method === "GET" && url === "/live") {
    return json(res, 200, { live: !state.stopping }, t0);
  }
  if (req.method === "GET" && url === "/ready") {
    const ready = state.ready && !state.stopping;
    return json(res, ready ? 200 : 503, { ready }, t0);
  }
  if (req.method === "GET" && (url === "/health" || url === "/")) {
    const live = !state.stopping, ready = state.ready && live;
    return json(res, ready ? 200 : 503, {
      service: APP_NAME, env: ENV, now: new Date().toISOString(),
      uptimeSec: Math.floor((Date.now() - state.startMs) / 1000),
      live, ready, summary: summarize(live, ready),
    }, t0);
  }
  if (req.method === "GET" && url === "/metrics") {
    const text = renderMetrics();
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
    record(t0);
    return;
  }
  if (req.method === "GET" && url === "/commodities/chains") {
    return json(res, 200, loadChains(), t0);
  }
  if (req.method === "GET" && url === "/commodities/curves") {
    return json(res, 200, loadCurves(), t0);
  }
  if (req.method === "POST" && url === "/commodities/margin") {
    try {
      const body = await readJson(req, 1_000_000);
      const r = calcMargin(body || {});
      return json(res, 200, r, t0);
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e?.message || e) }, t0);
    }
  }

  res.writeHead(404).end("not found");
  record(t0);
});

// ------------------- Lifecycle -------------------

main().catch((e) => { console.error("[fatal]", e?.stack || e); process.exit(1); });

async function main() {
  await new Promise((r) => server.listen(PORT, HOST, r));
  log(`commodities runner listening on http://${HOST}:${PORT}`);
  trapSignals();
}

function trapSignals() {
  const bye = (sig) => {
    log(`signal ${sig} — shutting down`);
    state.stopping = true;
    server.close(() => { log("server closed"); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

// ------------------- Helpers -------------------

function readJson(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(new Error("payload too large")); try { req.destroy(); } catch {} }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

function renderMetrics() {
  const lines = [];
  lines.push(`# HELP process_up 1 if process is up`);
  lines.push(`# TYPE process_up gauge`);
  lines.push(`process_up 1`);
  lines.push(`# HELP app_requests_total Total HTTP requests`);
  lines.push(`# TYPE app_requests_total counter`);
  lines.push(`app_requests_total{service="${APP_NAME}",env="${ENV}"} ${metrics.requests}`);
  lines.push(`# HELP app_request_duration_ms request duration (ms) sum and count`);
  lines.push(`# TYPE app_request_duration_ms summary`);
  lines.push(`app_request_duration_ms_sum{service="${APP_NAME}",env="${ENV}"} ${fix(metrics.reqDurMs.sum)}`);
  lines.push(`app_request_duration_ms_count{service="${APP_NAME}",env="${ENV}"} ${metrics.reqDurMs.count}`);
  return lines.join("\n") + "\n";
}

function record(t0) {
  const d = Date.now() - t0;
  metrics.reqDurMs.sum += d;
  metrics.reqDurMs.count += 1;
}

function json(res, code, obj, t0) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
  record(t0);
}

function summarize(live, ready) {
  const out = [];
  if (!live) out.push("stopping");
  if (!ready) out.push("warming");
  if (!out.length) out.push(`${APP_NAME} healthy`);
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, v] = a.includes("=") ? a.slice(2).split("=") : [a.slice(2), argv[i + 1]?.startsWith("--") ? "true" : argv[++i]];
    out[k] = v ?? "true";
  }
  return out;
}

function toInt(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : d; }
function round(n) { return Math.round(Number(n) * 100) / 100; }
function monthCode(m) { return "FGHJKMNQUVXZ"[((m - 1) % 12 + 12) % 12]; }
function addMonths(d, n) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 15)); return x; }
function monthsBetweenUtc(a, b) { return Math.max(0, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())); }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function fix(n) { const x = Number(n); return Number.isFinite(x) ? (Math.round(x * 1000) / 1000) : 0; }
function log(...a) { console.log(new Date().toISOString(), "-", ...a); }
function timingSafeEqual(a, b) {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  const len = Math.max(A.length, B.length); let diff = A.length ^ B.length;
  for (let i = 0; i < len; i++) diff |= (A[i % A.length] ^ B[i % B.length]); return diff === 0;
}